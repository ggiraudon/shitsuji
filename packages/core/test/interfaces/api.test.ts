import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { NodeTextFile } from '../../src/adapters/files/NodeTextFile.js';
import { PairingService } from '../../src/application/channels/PairingService.js';
import { MathEvaluateTool } from '../../src/adapters/tools/MathEvaluateTool.js';
import { SoulService } from '../../src/application/soul/SoulService.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ApprovalService } from '../../src/application/trust/ApprovalService.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import {
  asId,
  type ApprovalId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../src/domain/model/ids.js';
import { Approval } from '../../src/domain/model/Approval.js';
import type { InboundMessage, InboundResult } from '../../src/ports/ChannelAdapter.js';
import type { Tool } from '../../src/ports/Tool.js';
import { createApi } from '../../src/interfaces/http/createApi.js';
import {
  routerFor,
  ScriptedProvider,
  testServices,
  until,
  type ScriptedReply,
} from '../helpers.js';

async function setup(
  options: {
    dataDir?: string;
    replies?: ScriptedReply[];
    tools?: Tool[];
    receive?: (message: InboundMessage) => Promise<InboundResult>;
  } = {},
) {
  const services = testServices();
  const repos = new InMemoryRepositories();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const tools = new ToolCatalog(options.tools ?? []);
  const ownerId = asId<OwnerId>('owner');
  await repos.owners.upsert({
    id: ownerId,
    displayName: 'Jeanne',
    timezone: 'UTC',
    locale: 'en',
  });
  const soul = new SoulService({
    store: repos.soul,
    uow: repos.uow,
    ownerId,
    clock: services.clock,
    log: services.log,
    ...(options.dataDir && { file: new NodeTextFile(path.join(options.dataDir, 'SOUL.md')) }),
  });
  await soul.start();
  const pairing = new PairingService(services.clock, { code: () => 'TEST2345' });
  const agent = new Agent({
    name: 'Test',
    ownerId,
    models: routerFor(new ScriptedProvider(options.replies ?? [{ content: 'Hi there.' }])),
    tools,
    pipeline: new ToolPipeline(
      tools,
      defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
    ),
    repos,
    jobs,
    soul,
    ...services,
  });
  await jobs.start();
  await agent.start();
  const approvals = new ApprovalService({
    approvals: repos.approvals,
    events: services.events,
    clock: services.clock,
    log: services.log,
  });
  const app = createApi({
    agent,
    repos,
    ...services,
    ownerId,
    soul,
    pairing,
    approvals,
    ...(options.receive && { receive: options.receive }),
    verifyKey: (k) => k === 'secret',
  });
  return { app, agent, soul, repos, approvals };
}
const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' };

describe('HTTP API', () => {
  it('answers health without a key and refuses everything else without the right key', async () => {
    const { app } = await setup();
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/turns/x')).status).toBe(401);
    expect(
      (await app.request('/api/turns/x', { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
  });

  it('accepts a message, runs the turn, and returns the history', async () => {
    const { app, agent } = await setup();
    const res = await app.request('/api/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: 'Hello' }),
    });
    expect(res.status).toBe(202);
    const { turnId } = (await res.json()) as { turnId: string };
    const status = async () =>
      (
        (await (await app.request(`/api/turns/${turnId}`, { headers: auth })).json()) as {
          status: string;
        }
      ).status;
    for (let i = 0; i < 100 && (await status()) !== 'succeeded'; i++)
      await new Promise((r) => setTimeout(r, 10));
    await agent.idle();
    expect(await status()).toBe('succeeded');
    const history = (await (
      await app.request('/api/sessions/main/messages', { headers: auth })
    ).json()) as {
      messages: { author: string; text: string }[];
    };
    expect(history.messages.map((m) => `${m.author}:${m.text}`)).toEqual([
      'owner:Hello',
      'assistant:Hi there.',
    ]);
  });

  it('rejects an invalid body', async () => {
    const { app } = await setup();
    const res = await app.request('/api/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('shows the SOUL and turns an edit of SOUL.md into a revision once confirmed', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shitsuji-api-soul-'));
    try {
      const { app } = await setup({ dataDir });
      const initial = (await (await app.request('/api/soul', { headers: auth })).json()) as {
        revision: number;
        body: string;
        pending?: unknown;
      };
      expect(initial.revision).toBe(1);
      expect(initial.body).toContain('Shitsuji');
      expect(initial.pending).toBeUndefined();

      await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'New standing instructions.\n', 'utf8');
      const edited = (await (await app.request('/api/soul', { headers: auth })).json()) as {
        pending?: { proposed: string; hash: string };
      };
      expect(edited.pending?.proposed).toBe('New standing instructions.');
      const confirm = (hash?: string) =>
        app.request('/api/soul/confirm', {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(hash ? { hash } : {}),
        });

      // Without the reviewed hash, nothing is applied.
      expect((await confirm()).status).toBe(400);
      // Edited again after the review: a conflict, and the newer text is not applied.
      await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'Unreviewed text.\n', 'utf8');
      expect((await confirm(edited.pending!.hash)).status).toBe(409);
      // Back to the reviewed text, saved with Windows line endings: still the same edit.
      await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'New standing instructions.\r\n', 'utf8');

      const confirmed = await confirm(edited.pending!.hash);
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toEqual({ revision: 2 });

      // Nothing left to apply: a conflict, not a server error.
      const again = await confirm(edited.pending!.hash);
      expect(again.status).toBe(409);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('lists tool receipts with their effect, target, outcome and what allowed them (S29)', async () => {
    const { app, agent } = await setup({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'math.evaluate', arguments: { expression: '1+1' } }] },
        { content: 'It is 2.' },
      ],
      tools: [new MathEvaluateTool()],
    });
    const posted = await app.request('/api/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: 'What is 1+1?' }),
    });
    const { turnId, sessionId } = (await posted.json()) as {
      turnId: string;
      sessionId: string;
    };
    const status = async () =>
      (
        (await (await app.request(`/api/turns/${turnId}`, { headers: auth })).json()) as {
          status: string;
        }
      ).status;
    await until(async () => (await status()) === 'succeeded');
    await agent.idle();

    const res = await app.request('/api/activity', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      since: string;
      receipts: {
        turnId: string;
        sessionId?: string;
        tool: string;
        effect?: string;
        target?: string;
        outcome: string;
        durationMs?: number;
        allowedBy?: { kind: string; detail?: string };
      }[];
    };
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({
      turnId,
      sessionId,
      tool: 'math.evaluate',
      effect: 'compute',
      target: 'core',
      outcome: 'ok',
      allowedBy: { kind: 'policy', detail: 'compute actions need no approval' },
    });
    expect(body.receipts[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('hands API messages to the shared inbound sink as InboundMessage (S30)', async () => {
    const seen: InboundMessage[] = [];
    const { app } = await setup({
      receive: async (message) => {
        seen.push(message);
        return {
          kind: 'turn',
          sessionId: asId<SessionId>('s1'),
          turnId: asId<TurnId>('t1'),
          steered: false,
        };
      },
    });

    const res = await app.request('/api/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ content: 'Hello' }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sessionId: 's1', turnId: 't1', steered: false });
    expect(seen[0]).toMatchObject({ channel: 'api', chatId: 'main', text: 'Hello' });
  });

  it('issues a pairing code over the API (S31)', async () => {
    const { app } = await setup();
    expect((await app.request('/api/pair', { method: 'POST' })).status).toBe(401);

    const res = await app.request('/api/pair', { method: 'POST', headers: auth });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 'TEST2345',
      expiresAt: expect.any(String),
    });
  });

  it('rejects a bad since on the activity and usage routes', async () => {
    const { app } = await setup();
    expect((await app.request('/api/activity?since=nope', { headers: auth })).status).toBe(400);
    expect((await app.request('/api/usage?since=nope', { headers: auth })).status).toBe(400);
    expect((await app.request('/api/activity')).status).toBe(401);
  });
});

it('lists open approvals and answers one, twice at most (S36)', async () => {
  const { app, repos } = await setup();
  const approval = Approval.request({
    id: asId<ApprovalId>('approval-1'),
    ownerId: asId<OwnerId>('owner'),
    turnId: asId<TurnId>('turn-1'),
    sessionId: asId<SessionId>('session-1'),
    tool: 'test.notify',
    effect: 'external',
    target: 'core',
    actionHash: 'a'.repeat(64),
    arguments: { text: 'Hello' },
    summary: 'test.notify (external) {"text":"Hello"}',
    reason: 'the owner must approve it',
    createdAt: new Date('2026-11-17T10:00:00Z'),
  });
  await repos.approvals.insert(approval);
  const declined = Approval.request({
    ...approval.toProps(),
    id: asId<ApprovalId>('approval-2'),
  });
  declined.decline(new Date('2026-11-17T10:00:01Z'));
  await repos.approvals.insert(declined);

  const listed = await app.request('/api/approvals', { headers: auth });
  expect(listed.status).toBe(200);
  const { approvals } = (await listed.json()) as { approvals: { id: string; status: string }[] };
  expect(approvals.map((a) => a.id).sort()).toEqual(['approval-1']);

  const body = JSON.stringify({ decision: 'approve' });
  const first = await app.request('/api/approvals/approval-1', {
    method: 'POST',
    headers: auth,
    body,
  });
  expect(first.status).toBe(200);
  expect(((await first.json()) as { approval: { status: string } }).approval.status).toBe(
    'approved',
  );

  const second = await app.request('/api/approvals/approval-1', {
    method: 'POST',
    headers: auth,
    body,
  });
  expect(((await second.json()) as { approval: { status: string } }).approval.status).toBe(
    'approved',
  );

  expect(
    (
      await app.request('/api/approvals/missing', {
        method: 'POST',
        headers: auth,
        body,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request('/api/approvals/approval-1', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ decision: 'maybe' }),
      })
    ).status,
  ).toBe(400);
});
