import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { TAIL_MARKER, ContextBuilder } from '../../src/application/context/ContextBuilder.js';
import { ClockInjectable } from '../../src/application/context/ClockInjectable.js';
import { OwnerProfileInjectable } from '../../src/application/context/OwnerProfileInjectable.js';
import { Session, type SessionKind } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import {
  asId,
  newId,
  type OwnerId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from '../../src/domain/model/ids.js';
import type { ContentPart, Message, MessageRole } from '../../src/domain/model/Message.js';
import {
  BaseContextInjectable,
  type ContextInjectable,
  type InjectionCondition,
  type InjectionPlacement,
} from '../../src/ports/ContextInjectable.js';

const OWNER = asId<OwnerId>('owner');

class Note extends BaseContextInjectable {
  readonly name: string;
  readonly description = '';
  constructor(
    readonly id: string,
    placement: InjectionPlacement,
    order: number,
    private readonly text: string | null,
    condition: InjectionCondition = { type: 'always' },
  ) {
    super();
    this.name = id;
    this.placement = placement;
    this.order = order;
    this.condition = condition;
  }
  render(): string | null {
    return this.text;
  }
}

async function fixture(
  injectables: ContextInjectable[],
  options: {
    kind?: SessionKind;
    historyLimit?: number;
    imageHistoryLimit?: number;
    imageMaxBytes?: number;
    visionAvailable?: boolean;
    images?: { read(ref: string): Promise<Uint8Array> };
  } = {},
) {
  const repos = new InMemoryRepositories();
  const log = new MemoryLogger();
  const clock = new ManualClock('2026-11-15T09:00:00.000Z');
  await repos.owners.upsert({
    id: OWNER,
    displayName: 'Jeanne',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
  });
  const thread = await repos.threads.getOrCreateForOwner(OWNER, clock.now());
  const session = new Session(newId<SessionId>(), thread.id, options.kind ?? 'chat', clock.now());
  await repos.sessions.insert(session);
  const turn = Turn.create({
    id: newId<TurnId>(),
    sessionId: session.id,
    source: 'user',
    createdAt: clock.now(),
  });

  const append = async (role: MessageRole, parts: ContentPart[], turnId: TurnId = turn.id) => {
    const message: Message = {
      id: newId(),
      threadId: thread.id,
      sessionId: session.id,
      turnId,
      role,
      author: role === 'user' ? 'owner' : role === 'assistant' ? 'assistant' : 'system',
      parts,
      withdrawn: false,
      createdAt: clock.now(),
    };
    await repos.messages.append(message);
    return message;
  };

  const builder = new ContextBuilder({
    injectables: () => injectables,
    repos,
    ownerId: OWNER,
    log,
    historyLimit: options.historyLimit,
    ...(options.imageHistoryLimit !== undefined && {
      imageHistoryLimit: options.imageHistoryLimit,
    }),
    ...(options.imageMaxBytes !== undefined && { imageMaxBytes: options.imageMaxBytes }),
    ...(options.visionAvailable !== undefined && { visionAvailable: options.visionAvailable }),
    ...(options.images && { images: options.images }),
  });
  return { builder, repos, session, turn, append, log, clock };
}

const text = (value: string): ContentPart[] => [{ type: 'text', text: value }];

describe('ContextBuilder: placement and order (S23)', () => {
  it('lays out headers in order, context notes at the start, and the tail on the newest message', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('tail-2', 'tail', 2, 'TAIL TWO'),
      new Note('header-2', 'header', 2, 'HEADER TWO'),
      new Note('context-1', 'context', 1, 'CONTEXT ONE'),
      new Note('header--1', 'header', -1, 'HEADER FIRST'),
      new Note('tail-1', 'tail', 1, 'TAIL ONE'),
      new Note('context-0', 'context', 0, 'CONTEXT ZERO'),
      new Note('header-0', 'header', 0, 'HEADER MIDDLE'),
    ]);
    await append('user', text('Good evening.'));

    const built = await builder.build(session, turn);

    expect(built.header.map((n) => n.id)).toEqual(['header--1', 'header-0', 'header-2']);
    expect(built.system).toBe('HEADER FIRST\n\nHEADER MIDDLE\n\nHEADER TWO');
    expect(built.context.map((n) => n.id)).toEqual(['context-0', 'context-1']);
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(built.messages[0]!.parts).toEqual([{ type: 'text', text: 'CONTEXT ZERO' }]);
    expect(built.messages[1]!.parts).toEqual([{ type: 'text', text: 'CONTEXT ONE' }]);
    // The tail joined, on the owner's message: this call carries it, the transcript does not. It says
    // where it comes from, so the model does not read it as the owner's words (#66).
    expect(built.tail).toBe(`${TAIL_MARKER}\nTAIL ONE\n\nTAIL TWO`);
    expect(built.messages.at(-1)!.parts).toEqual([
      { type: 'text', text: 'Good evening.' },
      { type: 'text', text: `${TAIL_MARKER}\nTAIL ONE\n\nTAIL TWO` },
    ]);
  });

  it('keeps the tail on the opening request, unchanged, for every step of a turn', async () => {
    let now = 'It is 09:00.';
    const clockNote = new (class extends Note {
      override render() {
        return now;
      }
    })('clock', 'tail', 2, '');
    const { builder, session, turn, append } = await fixture([clockNote]);
    await append('user', text('What is the time?'));
    const first = await builder.build(session, turn);

    await append('assistant', [
      { type: 'tool_call', call: { id: asId<ToolCallId>('c1'), name: 'x', arguments: {} } },
    ]);
    await append('tool', text('tool output'));
    now = 'It is 09:01.';
    const second = await builder.build(session, turn);

    // The second step's request starts with exactly the first one: the provider's cache still matches.
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.messages[0]!.parts.at(-1)).toEqual({
      type: 'text',
      text: `${TAIL_MARKER}\nIt is 09:00.`,
    });

    // The next turn renders it afresh, on its own opening request.
    const next = Turn.create({
      id: newId<TurnId>(),
      sessionId: session.id,
      source: 'user',
      createdAt: new Date(),
    });
    await append('assistant', text('Nine.'));
    await append('user', text('And now?'), next.id);
    const third = await builder.build(session, next);
    expect(third.messages.at(-1)!.parts.at(-1)).toEqual({
      type: 'text',
      text: `${TAIL_MARKER}\nIt is 09:01.`,
    });
    expect(third.messages[0]!.parts).toEqual(text('What is the time?'));
  });

  it('adds the tail as a note at the end when the turn has no owner message', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('clock', 'tail', 2, 'It is 09:00.'),
    ]);
    await append('user', text('An earlier request.'), newId<TurnId>());
    await append('assistant', [
      { type: 'tool_call', call: { id: asId<ToolCallId>('c1'), name: 'x', arguments: {} } },
    ]);
    await append('tool', text('tool output'));

    const built = await builder.build(session, turn);

    expect(built.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(built.messages.at(-1)!.parts).toEqual([
      { type: 'text', text: `${TAIL_MARKER}\nIt is 09:00.` },
    ]);
  });

  it('renders a once injectable only in its first call of a session', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('welcome', 'header', 0, 'WELCOME', { type: 'once' }),
    ]);
    await append('user', text('hello'));

    const first = await builder.build(session, turn);
    const second = await builder.build(session, turn);

    expect(first.system).toBe('WELCOME');
    expect(second.system).toBeUndefined();
  });

  it('puts the owner profile in the header and the clock in the tail, never the header', async () => {
    const injectables: ContextInjectable[] = [];
    const { builder, session, turn, append, clock } = await fixture(injectables);
    injectables.push(new OwnerProfileInjectable(), new ClockInjectable(clock));
    await append('user', text('What time is it?'));

    const built = await builder.build(session, turn);

    expect(built.header.map((n) => n.id)).toEqual(['owner-profile']);
    expect(built.system).toContain('Jeanne');
    expect(built.system).toContain('Europe/Paris');
    expect(built.system).not.toContain('Current local date and time');
    expect(built.tail).toContain('10:00'); // 09:00 UTC in Paris
    expect(built.messages.at(-1)!.parts).toContainEqual({
      type: 'text',
      text: built.tail,
    });
  });

  it('selects injectables by session kind', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('chat-only', 'header', 0, 'CHAT', { type: 'session_kind', kinds: ['chat'] }),
      new Note('task-only', 'header', 1, 'TASK', { type: 'session_kind', kinds: ['task'] }),
    ]);
    await append('user', text('hello'));

    const built = await builder.build(session, turn);

    expect(built.header.map((n) => n.id)).toEqual(['chat-only']);
  });

  it('never drops the open request when the history is longer than the window', async () => {
    const { builder, session, turn, append } = await fixture([], { historyLimit: 3 });
    for (let i = 0; i < 6; i++) {
      await append('assistant', text(`answer ${i}`), newId<TurnId>());
      await append('user', text(`follow-up ${i}`), newId<TurnId>());
    }
    // The open request, then a long tool loop in the same turn: the last three messages alone
    // would not include it.
    await append('user', text('the open request'));
    for (let i = 0; i < 4; i++) {
      await append('assistant', text(`working ${i}`));
    }

    const built = await builder.build(session, turn);

    expect(built.sources[0]!.parts).toEqual([{ type: 'text', text: 'the open request' }]);
    expect(built.messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'working 3' }]);
  });
});

/** A note whose text changes on every render, like a clock that ended up in the header. */
class VolatileNote extends BaseContextInjectable {
  readonly id = 'volatile';
  readonly name = 'Volatile';
  readonly description = '';
  constructor(placement: InjectionPlacement) {
    super();
    this.placement = placement;
  }
  private count = 0;
  render(): string {
    return `CHANGED ${++this.count}`;
  }
}

describe('ContextBuilder: header stability check (S23)', () => {
  it('warns once when a header injectable changes on every call', async () => {
    const { builder, session, turn, append, log } = await fixture([new VolatileNote('header')]);
    await append('user', text('hello'));

    await builder.build(session, turn);
    await builder.build(session, turn);
    await builder.build(session, turn);
    await builder.build(session, turn);

    const warnings = log.records.filter((r) => r.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/header injectable changes/);
    expect(warnings[0]!.context.injectable).toBe('volatile');
  });

  it('stays quiet for a stable header and a volatile tail', async () => {
    const { builder, session, turn, append, log } = await fixture([
      new Note('identity', 'header', -1, 'You are Shitsuji.'),
      new VolatileNote('tail'),
    ]);
    await append('user', text('hello'));

    for (let i = 0; i < 4; i++) await builder.build(session, turn);

    expect(log.records.filter((r) => r.level === 'warn')).toEqual([]);
  });

  it('accepts a header that changes once', async () => {
    class ChangesOnce extends BaseContextInjectable {
      readonly id = 'once-only';
      readonly name = 'Once';
      readonly description = '';
      private calls = 0;
      render(): string {
        return ++this.calls === 1 ? 'FIRST' : 'SECOND';
      }
    }
    const { builder, session, turn, append, log } = await fixture([new ChangesOnce()]);
    await append('user', text('hello'));

    await builder.build(session, turn);
    await builder.build(session, turn);
    await builder.build(session, turn);

    expect(log.records.filter((r) => r.level === 'warn')).toEqual([]);
  });
});

describe('ContextBuilder: tool call ordering (#64)', () => {
  const call = (id: string): ContentPart => ({
    type: 'tool_call',
    call: { id: asId<ToolCallId>(id), name: 'test.notify', arguments: {} },
  });
  const result = (id: string, content = 'sent'): ContentPart => ({
    type: 'tool_result',
    toolCallId: asId<ToolCallId>(id),
    content,
    isError: false,
  });

  it('puts a tool result right after its call when the owner steered a message in between', async () => {
    const { builder, session, turn, append } = await fixture([]);
    await append('user', text('Notify the team.'));
    await append('assistant', [call('c1')]);
    await append('user', text('yes'));
    await append('tool', [result('c1')]);

    const built = await builder.build(session, turn);

    expect(built.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(built.messages[2]!.parts).toEqual([
      { type: 'tool_result', toolCallId: 'c1', content: 'sent', isError: false },
    ]);
    expect(built.messages[3]!.parts).toEqual([{ type: 'text', text: 'yes' }]);
  });

  it('keeps every result of two calls together when a message arrives between them', async () => {
    const { builder, session, turn, append } = await fixture([]);
    await append('user', text('Do both.'));
    await append('assistant', [call('c1'), call('c2')]);
    await append('tool', [result('c1', 'one')]);
    await append('user', text('still there?'));
    await append('tool', [result('c2', 'two')]);

    const built = await builder.build(session, turn);

    expect(built.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
    ]);
    const results = built.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.parts)
      .map((p) => (p.type === 'tool_result' ? p.toolCallId : undefined));
    expect(results).toEqual(['c1', 'c2']);
    expect(built.messages[4]!.parts).toEqual([{ type: 'text', text: 'still there?' }]);
  });

  it('synthesises a missing result so a crashed tool call still leaves a valid history', async () => {
    const { builder, session, turn, append } = await fixture([]);
    await append('user', text('Run it.'));
    await append('assistant', [call('c1')]);

    const built = await builder.build(session, turn);

    expect(built.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(built.messages[2]!.parts[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'c1',
      isError: true,
    });
    expect((built.messages[2]!.parts[0] as { content: string }).content).toMatch(/did not finish/);
  });

  it('drops an orphan tool result with no call before it', async () => {
    const { builder, session, turn, append } = await fixture([]);
    await append('user', text('Hello.'));
    await append('tool', [result('missing')]);

    const built = await builder.build(session, turn);

    expect(built.messages.map((m) => m.role)).toEqual(['user']);
  });
});

describe('ContextBuilder: the tail says where it comes from (#66)', () => {
  it('marks the tail as Shitsuji context, apart from the owner text', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('clock', 'tail', 2, 'Current local date and time for your owner: 2:43 PM (UTC).'),
    ]);
    await append('user', text('typed yes'));

    const built = await builder.build(session, turn);

    const owner = built.messages.at(-1)!;
    expect(owner.parts[0]).toEqual({ type: 'text', text: 'typed yes' });
    expect(owner.parts[1]).toEqual({
      type: 'text',
      text: "[Context from Shitsuji, not the owner's words]\nCurrent local date and time for your owner: 2:43 PM (UTC).",
    });
  });
});

describe('ContextBuilder: images (S52)', () => {
  const bytesOf = (ref: string) => new TextEncoder().encode(ref);
  const base64Of = (ref: string) => Buffer.from(ref).toString('base64');
  const imagePart = (ref: string): ContentPart => ({
    type: 'image',
    mediaType: 'image/png',
    ref,
    name: ref.split('/').pop(),
  });

  it('loads stored refs and keeps the newest three as pixels, deterministically', async () => {
    const refs = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'].map(
      (name) => `sessions/s1/images/${name}`,
    );
    const reads: string[] = [];
    const { builder, session, turn, append } = await fixture([], {
      visionAvailable: true,
      images: {
        read: async (ref) => {
          reads.push(ref);
          return bytesOf(ref);
        },
      },
    });
    for (const ref of refs) await append('user', [imagePart(ref)]);

    const first = await builder.build(session, turn);
    reads.length = 0;
    const second = await builder.build(session, turn);

    expect(JSON.stringify(first.messages)).toBe(JSON.stringify(second.messages));
    expect(reads).toEqual(refs.slice(-3));
    const images = first.messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === 'image' ? [p] : [])),
    );
    expect(images).toHaveLength(3);
    expect(images.map((p) => p.data)).toEqual(refs.slice(-3).map(base64Of));
    const placeholders = first.messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])),
    );
    expect(placeholders).toContain('[image: a.png, sent earlier]');
    expect(placeholders).toContain('[image: b.png, sent earlier]');
  });

  it('loads a tool result image, then prunes it to one placeholder when it is old', async () => {
    const ref = 'sessions/s1/images/chart.png';
    const call = {
      type: 'tool_call' as const,
      call: { id: asId<ToolCallId>('t1'), name: 'chart', arguments: {} },
    };
    const toolResult: ContentPart = {
      type: 'tool_result',
      toolCallId: asId<ToolCallId>('t1'),
      content: 'Chart saved.',
      isError: false,
      images: [{ mediaType: 'image/png', ref, name: 'chart.png' }],
    };
    const { builder, session, turn, append, repos } = await fixture([], {
      visionAvailable: true,
      images: { read: async (value) => bytesOf(value) },
    });
    await append('assistant', [call]);
    await append('tool', [toolResult]);
    const loaded = await builder.build(session, turn);
    const part = loaded.messages[1]!.parts[0] as Extract<ContentPart, { type: 'tool_result' }>;
    expect(part.images?.[0]).toMatchObject({ mediaType: 'image/png', data: base64Of(ref) });

    const prunedBuilder = new ContextBuilder({
      injectables: () => [],
      repos,
      ownerId: OWNER,
      log: new MemoryLogger(),
      images: { read: async (value) => bytesOf(value) },
      visionAvailable: true,
      imageHistoryLimit: 0,
    });
    const pruned = await prunedBuilder.build(session, turn);
    const prunedPart = pruned.messages[1]!.parts[0] as Extract<
      ContentPart,
      { type: 'tool_result' }
    >;
    expect(prunedPart.images).toBeUndefined();
    expect(prunedPart.content).toContain('[image: chart.png, sent earlier]');
  });

  it('does not read or send pixels when the chat model cannot see (S52)', async () => {
    const ref = 'sessions/s1/images/a.png';
    let reads = 0;
    const { builder, session, turn, append } = await fixture([], {
      visionAvailable: false,
      images: {
        read: async () => {
          reads += 1;
          return bytesOf(ref);
        },
      },
    });
    await append('user', [imagePart(ref)]);
    await append('assistant', [
      {
        type: 'tool_call',
        call: { id: asId<ToolCallId>('t1'), name: 'chart', arguments: {} },
      },
    ]);
    await append('tool', [
      {
        type: 'tool_result',
        toolCallId: asId<ToolCallId>('t1'),
        content: 'Chart saved.',
        isError: false,
        images: [{ mediaType: 'image/png', ref, name: 'chart.png' }],
      },
    ]);

    const built = await builder.build(session, turn);

    expect(reads).toBe(0);
    expect(
      built.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'image' ? [p] : []))),
    ).toHaveLength(0);
    const text = built.messages
      .flatMap((m) =>
        m.parts.flatMap((p) =>
          p.type === 'text' ? [p.text] : p.type === 'tool_result' ? [p.content] : [],
        ),
      )
      .join('\n');
    expect(text).toContain('[image: a.png, cannot be viewed with the current model]');
    expect(text).toContain('[image: chart.png, cannot be viewed with the current model]');
  });

  it('turns an oversized image into a placeholder and warns once (S52)', async () => {
    const ref = 'sessions/s1/images/big.png';
    const oversized = 1.5 * 1024 * 1024;
    const { builder, session, turn, append, log } = await fixture([], {
      visionAvailable: true,
      imageMaxBytes: 1024 * 1024,
      images: { read: async () => new Uint8Array(oversized) },
    });
    await append('user', [imagePart(ref)]);

    const first = await builder.build(session, turn);
    const second = await builder.build(session, turn);

    const text = first.messages
      .flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])))
      .join('\n');
    expect(text).toContain('[image: big.png, too large to show (1.5 MB)]');
    expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
    expect(
      log.records.filter((record) => record.message === 'Image is too large for the context'),
    ).toHaveLength(1);
  });
});
