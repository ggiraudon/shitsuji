import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { InProcessEventBus } from '../../src/adapters/events/InProcessEventBus.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import {
  ChannelGateway,
  type ChannelRuntime,
} from '../../src/application/channels/ChannelGateway.js';
import { ChannelRegistry } from '../../src/application/channels/ChannelRegistry.js';
import { PairingService } from '../../src/application/channels/PairingService.js';
import { ApprovalService } from '../../src/application/trust/ApprovalService.js';
import type { Submitted } from '../../src/application/runtime/MessageIntake.js';
import {
  asId,
  newId,
  type ApprovalId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../src/domain/model/ids.js';
import { Approval } from '../../src/domain/model/Approval.js';
import { Session } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import type {
  InboundAttachment,
  InboundMessage,
  OutboundIntent,
} from '../../src/ports/ChannelAdapter.js';
import { TestChannel } from '../helpers.js';

const OWNER = asId<OwnerId>('owner');

async function setup(
  options: {
    requiresPairing?: boolean;
    stopResult?: boolean;
    newSession?: SessionId;
    readTypedApproval?: (
      text: string,
      approval: Approval,
    ) => Promise<'approve' | 'decline' | 'unclear'>;
  } = {},
) {
  const repos = new InMemoryRepositories();
  await repos.owners.upsert({
    id: OWNER,
    displayName: 'Jeanne',
    timezone: 'UTC',
    locale: 'en',
  });
  const clock = new ManualClock('2026-03-01T10:00:00.000Z');
  const thread = await repos.threads.getOrCreateForOwner(OWNER, clock.now());
  const session = new Session(newId<SessionId>(), thread.id, 'chat', clock.now());
  await repos.sessions.insert(session);

  let issued = 0;
  const pairing = new PairingService(clock, { code: () => `CODE${++issued}234` });
  const channels = new ChannelRegistry();
  const channel = new TestChannel(options.requiresPairing ?? true);
  channels.add(channel);

  const submitted: { text: string; opts: Record<string, unknown> }[] = [];
  const calls = { started: 0, stopped: [] as string[] };
  const agent: ChannelRuntime = {
    submit: async (text, opts): Promise<Submitted> => {
      submitted.push({ text, opts: opts as Record<string, unknown> });
      return { sessionId: session.id, turnId: asId<TurnId>('turn-1'), steered: false };
    },
    startSession: async () => {
      calls.started++;
      return options.newSession ?? session.id;
    },
    stopSession: async (sessionId) => {
      calls.stopped.push(sessionId);
      return options.stopResult ?? true;
    },
  };
  const replies: { channel: string; chatId: string; text: string; intent: OutboundIntent }[] = [];
  const approvals = new ApprovalService({
    approvals: repos.approvals,
    events: new InProcessEventBus(new MemoryLogger(), clock),
    clock,
    log: new MemoryLogger(),
  });
  const gateway = new ChannelGateway({
    agent,
    bindings: repos.bindings,
    pairing,
    channels,
    repos,
    ownerId: OWNER,
    clock,
    log: new MemoryLogger(),
    version: '0.1.0',
    approvals,
    ...(options.readTypedApproval && { readTypedApproval: options.readTypedApproval }),
    reply: async (channelId, chatId, text, intent) => {
      replies.push({ channel: channelId, chatId, text, intent });
    },
  });
  const receive = (text: string, chatId = 'chat-1', attachments?: InboundAttachment[]) =>
    gateway.receive({
      channel: 'test',
      chatId,
      text,
      receivedAt: clock.now(),
      ...(attachments && { attachments }),
    } satisfies InboundMessage);
  return {
    gateway,
    channel,
    receive,
    submitted,
    replies,
    pairing,
    repos,
    session,
    clock,
    calls,
    approvals,
  };
}

describe('ChannelGateway: pairing (S31)', () => {
  it('starts no turn for an unpaired chat and says nothing (F06 criterion 2)', async () => {
    const { receive, submitted, replies } = await setup({ requiresPairing: true });

    expect(await receive('Hello')).toEqual({ kind: 'ignored', reason: 'unpaired' });

    expect(submitted).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it('pairs a chat with /start <code>, then runs its messages', async () => {
    const { receive, submitted, replies, pairing, repos, session } = await setup();
    const { code } = pairing.issue(OWNER);

    expect(await receive(`/start ${code}`)).toEqual({ kind: 'replied', reason: 'paired' });
    expect(replies[0]!.text).toMatch(/^Paired/);
    expect(await repos.bindings.get('test', 'chat-1')).toMatchObject({
      verifiedAt: expect.any(Date),
    });

    const result = await receive('Good evening');

    expect(result).toEqual({
      kind: 'turn',
      sessionId: session.id,
      turnId: 'turn-1',
      steered: false,
    });
    expect(submitted[0]).toEqual({
      text: 'Good evening',
      opts: { channel: 'test', replyChannel: 'test:chat-1' },
    });
  });

  it('refuses a wrong or reused code and stays unpaired', async () => {
    const { receive, submitted, replies, pairing } = await setup();
    const { code } = pairing.issue(OWNER);

    expect(await receive('/start WRONG234', 'chat-2')).toMatchObject({ kind: 'replied' });
    expect(replies[0]!.text).toMatch(/not valid or has expired/);
    await receive(`/start ${code}`, 'chat-1');
    await receive(`/start ${code}`, 'chat-3'); // already used
    expect(replies.at(-1)!.text).toMatch(/not valid or has expired/);
    await receive('Hello', 'chat-2');
    expect(submitted).toHaveLength(0);
  });

  it('asks for a code when /start has none', async () => {
    const { receive, replies } = await setup();
    expect(await receive('/start')).toMatchObject({ kind: 'replied' });
    expect(replies[0]!.text).toMatch(/Send \/start <code>/);
  });

  it('runs messages on a channel that needs no pairing', async () => {
    const { receive, submitted } = await setup({ requiresPairing: false });

    expect(await receive('Hello')).toMatchObject({ kind: 'turn' });
    expect(submitted[0]).toMatchObject({ text: 'Hello' });
  });

  it('uses the session a binding points at after /new', async () => {
    const { receive, submitted, repos, session, clock } = await setup();
    const other = new Session(newId<SessionId>(), session.threadId, 'chat', clock.now());
    await repos.sessions.insert(other);
    await repos.bindings.upsert({
      channel: 'test',
      externalChatId: 'chat-1',
      ownerId: OWNER,
      verifiedAt: clock.now(),
      sessionId: other.id,
    });

    await receive('Hello');

    expect(submitted[0]!.opts.sessionId).toBe(other.id);
  });
});

describe('ChannelGateway: commands (S31)', () => {
  const pair = async (ctx: Awaited<ReturnType<typeof setup>>) => {
    await ctx.receive(`/start ${ctx.pairing.issue(OWNER).code}`);
  };

  it('/stop stops the session the chat talks to', async () => {
    const ctx = await setup();
    await pair(ctx);

    expect(await ctx.receive('/stop')).toEqual({ kind: 'replied', reason: 'command' });

    expect(ctx.calls.stopped).toEqual([ctx.session.id]);
    expect(ctx.replies.at(-1)).toMatchObject({ text: 'Stopped.', intent: 'final' });
  });

  it('says when there is nothing to stop', async () => {
    const ctx = await setup({ stopResult: false });
    await pair(ctx);

    await ctx.receive('/stop');

    expect(ctx.replies.at(-1)!.text).toBe('Nothing is running.');
  });

  it('/status reports a running turn and the session', async () => {
    const ctx = await setup();
    await pair(ctx);
    const turn = Turn.create({
      id: newId<TurnId>(),
      sessionId: ctx.session.id,
      source: 'user',
      createdAt: ctx.clock.now(),
    });
    turn.start(ctx.clock.now());
    await ctx.repos.turns.insert(turn);

    await ctx.receive('/status');

    expect(ctx.replies.at(-1)!.text).toMatch(/working on a turn/);
    expect(ctx.replies.at(-1)!.text).toContain(ctx.session.id.slice(0, 8));
  });

  it('/status says idle when no turn is running', async () => {
    const ctx = await setup();
    await pair(ctx);

    await ctx.receive('/status');

    expect(ctx.replies.at(-1)!.text).toMatch(/idle/);
  });

  it('/new asks to confirm, and /new confirm starts a session for the chat', async () => {
    const fresh = newId<SessionId>();
    const ctx = await setup({ newSession: fresh });
    await pair(ctx);

    await ctx.receive('/new');
    expect(ctx.replies.at(-1)!.text).toMatch(/Reply \/new confirm/);
    expect(ctx.calls.started).toBe(0);

    await ctx.repos.sessions.insert(
      new Session(fresh, ctx.session.threadId, 'chat', ctx.clock.now()),
    );
    expect(await ctx.receive('/new confirm')).toEqual({ kind: 'replied', reason: 'command' });

    expect(ctx.calls.started).toBe(1);
    expect(ctx.replies.at(-1)!.text).toBe('A new conversation has started.');
    expect(await ctx.repos.bindings.get('test', 'chat-1')).toMatchObject({
      sessionId: fresh,
      verifiedAt: expect.any(Date),
    });

    await ctx.receive('Hello');
    expect(ctx.submitted.at(-1)!.opts.sessionId).toBe(fresh);
  });
});

describe('ChannelGateway: attachments (S33)', () => {
  it('tells the turn where the owner files are', async () => {
    const { receive, submitted } = await setup({ requiresPairing: false });

    await receive('Please read this', 'chat-1', [
      {
        name: 'report.pdf',
        path: '/data/handoff/report.pdf',
        mediaType: 'application/pdf',
        size: 3,
      },
    ]);

    expect(submitted[0]!.text).toContain('Please read this');
    expect(submitted[0]!.text).toContain('/data/handoff/report.pdf');
    expect(submitted[0]!.text).toContain('application/pdf');
    expect(submitted[0]!.opts.replyChannel).toBe('test:chat-1');
  });

  it('starts a turn for a file sent without text', async () => {
    const { receive, submitted } = await setup({ requiresPairing: false });

    await receive('', 'chat-1', [
      { name: 'photo.jpg', path: '/data/handoff/photo.jpg', mediaType: 'image/jpeg' },
    ]);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.text).toContain('/data/handoff/photo.jpg');
  });
});

describe('ChannelGateway: which chats may store files (#44)', () => {
  it('refuses an unpaired chat and accepts it once paired', async () => {
    const { gateway, receive, pairing } = await setup({ requiresPairing: true });
    const chat = { channel: 'test' as const, chatId: 'chat-1' };

    expect(await gateway.accepts(chat)).toBe(false);

    const { code } = pairing.issue(OWNER);
    await receive(`/start ${code}`);

    expect(await gateway.accepts(chat)).toBe(true);
  });

  it('accepts every chat on a channel that needs no pairing', async () => {
    const { gateway } = await setup({ requiresPairing: false });

    expect(await gateway.accepts({ channel: 'test', chatId: 'anyone' })).toBe(true);
  });
});

describe('ChannelGateway: approval buttons (S37)', () => {
  const pending = async (repos: InMemoryRepositories, sessionId: SessionId, id = 'approval-1') => {
    const approval = Approval.request({
      id: asId<ApprovalId>(id),
      ownerId: OWNER,
      turnId: asId<TurnId>('turn-1'),
      sessionId,
      tool: 'test.notify',
      effect: 'external',
      target: 'core',
      actionHash: 'a'.repeat(64),
      arguments: { text: 'Hello' },
      summary: 'test.notify (external)',
      createdAt: new Date('2026-03-01T10:00:00Z'),
    });
    await repos.approvals.insert(approval);
    return approval;
  };

  const press = (gateway: ChannelGateway, data: string, chatId = 'chat-1') =>
    gateway.receive({
      channel: 'test',
      chatId,
      text: '',
      receivedAt: new Date('2026-03-01T10:00:00Z'),
      callback: { id: 'cb-1', data, messageId: '55' },
    });

  it('approves with y:<id> and declines with n:<id>, once', async () => {
    const { gateway, repos, session } = await setup({ requiresPairing: false });
    await pending(repos, session.id, 'approval-y');
    await pending(repos, session.id, 'approval-n');

    expect(await press(gateway, 'y:approval-y')).toEqual({ kind: 'replied', reason: 'approved' });
    // Pressing again is harmless: the card reports the state that won.
    expect(await press(gateway, 'y:approval-y')).toEqual({
      kind: 'replied',
      reason: 'approved',
    });
    expect(await press(gateway, 'n:approval-n')).toEqual({ kind: 'replied', reason: 'declined' });

    expect((await repos.approvals.get(asId<ApprovalId>('approval-y')))!.status).toBe('approved');
    expect((await repos.approvals.get(asId<ApprovalId>('approval-n')))!.status).toBe('declined');
  });

  it('ignores malformed data and an unknown id', async () => {
    const { gateway } = await setup({ requiresPairing: false });

    expect(await press(gateway, 'open-everything')).toEqual({
      kind: 'ignored',
      reason: 'unknown callback',
    });
    expect(await press(gateway, 'y:missing')).toEqual({
      kind: 'ignored',
      reason: 'approval not found',
    });
  });

  it('ignores a button press from an unpaired chat', async () => {
    const { gateway, repos, session } = await setup({ requiresPairing: true });
    await pending(repos, session.id, 'approval-p');

    expect(await press(gateway, 'y:approval-p')).toEqual({ kind: 'ignored', reason: 'unpaired' });
    expect((await repos.approvals.get(asId<ApprovalId>('approval-p')))!.status).toBe('pending');
  });
});

describe('ChannelGateway: typed approval answers (S37)', () => {
  const seedCard = async (repos: InMemoryRepositories, sessionId: SessionId, id = 'approval-t') => {
    const approval = Approval.request({
      id: asId<ApprovalId>(id),
      ownerId: OWNER,
      turnId: asId<TurnId>('turn-1'),
      sessionId,
      tool: 'test.notify',
      effect: 'external',
      target: 'core',
      actionHash: 'a'.repeat(64),
      arguments: {},
      summary: 'test.notify (external)',
      createdAt: new Date('2026-03-01T10:00:00Z'),
    });
    await repos.approvals.insert(approval);
    return approval;
  };

  it('treats an unconditional typed yes as an approval', async () => {
    const { receive, repos, session, replies } = await setup({
      requiresPairing: false,
      readTypedApproval: async () => 'approve',
    });
    const card = await seedCard(repos, session.id);

    expect(await receive('Yes, go ahead.')).toEqual({ kind: 'replied', reason: 'approved' });
    expect((await repos.approvals.get(card.id))!.status).toBe('approved');
    expect(replies.at(-1)!.text).toBe('Approved.');
  });

  it('does not approve "yes, but to Bob": it becomes an ordinary message', async () => {
    const { receive, repos, session, submitted } = await setup({
      requiresPairing: false,
      readTypedApproval: async () => 'unclear',
    });
    const card = await seedCard(repos, session.id);

    const result = await receive('Yes, but send it to Bob instead.');

    expect(result.kind).toBe('turn');
    expect(submitted[0]!.text).toBe('Yes, but send it to Bob instead.');
    expect((await repos.approvals.get(card.id))!.status).toBe('pending');
  });

  it('leaves commands and ordinary messages alone when no card is open', async () => {
    const { receive, submitted } = await setup({
      requiresPairing: false,
      readTypedApproval: async () => 'approve',
    });

    expect((await receive('Good evening')).kind).toBe('turn');
    expect(submitted).toHaveLength(1);
  });
});
