import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { Agent } from '../../src/application/Agent.js';
import { Compactor } from '../../src/application/context/Compactor.js';
import { ContextBuilder } from '../../src/application/context/ContextBuilder.js';
import { CompactionSummaryInjectable } from '../../src/application/context/CompactionSummaryInjectable.js';
import { ModelCatalog } from '../../src/application/models/ModelCatalog.js';
import { ModelRouter } from '../../src/application/models/ModelRouter.js';
import { defaultMiddlewares } from '../../src/application/tools/middlewares.js';
import { ToolCatalog } from '../../src/application/tools/ToolCatalog.js';
import { ToolPipeline } from '../../src/application/tools/ToolPipeline.js';
import {
  asId,
  newId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../src/domain/model/ids.js';
import type { Message } from '../../src/domain/model/Message.js';
import { Session } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../src/ports/ModelProvider.js';
import { ScriptedProvider, testServices } from '../helpers.js';
const OWNER = asId<OwnerId>('owner');
const clock = new ManualClock('2026-11-15T09:00:00.000Z');
const LOG = new MemoryLogger();

async function seed() {
  const repos = new InMemoryRepositories();
  await repos.owners.upsert({
    id: OWNER,
    displayName: 'Jeanne',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
  });
  const thread = await repos.threads.getOrCreateForOwner(OWNER, clock.now());
  const session = new Session(newId<SessionId>(), thread.id, 'chat', clock.now());
  await repos.sessions.insert(session);
  return { repos, thread, session };
}

async function append(
  repos: InMemoryRepositories,
  session: Session,
  role: 'user' | 'assistant',
  text: string,
  turnId: TurnId,
) {
  const message: Message = {
    id: newId(),
    threadId: session.threadId,
    sessionId: session.id,
    turnId,
    role,
    author: role === 'user' ? 'owner' : 'assistant',
    parts: [{ type: 'text', text }],
    withdrawn: false,
    createdAt: clock.now(),
  };
  await repos.messages.append(message);
  return message;
}

describe('Compactor (S23)', () => {
  it('summarises only what came before the open request and advances the watermark', async () => {
    const { repos, session } = await seed();
    const oldTurn = newId<TurnId>();
    const openTurn = newId<TurnId>();
    await append(repos, session, 'user', 'An old request. '.repeat(20), oldTurn);
    await append(repos, session, 'assistant', 'An old answer.', oldTurn);
    await append(repos, session, 'user', 'The open request, which must survive.', openTurn);

    const model = new ScriptedProvider([{ content: 'SUMMARY TEXT' }]);
    const compactor = new Compactor({
      models: new ModelRouter(
        new Map([[model.id, model]]),
        { purposes: { chat: 'scripted/m' }, fallbacks: {} },
        new ModelCatalog(),
        LOG,
      ),
      sessions: repos.sessions,
      clock,
      log: LOG,
    });
    const transcript = await repos.messages.listBySession(session.id);
    const turn = Turn.create({
      id: openTurn,
      sessionId: session.id,
      source: 'user',
      createdAt: clock.now(),
    });

    const result = await compactor.compactIfNeeded(session, turn, transcript, 30);

    expect(result).toEqual({ summary: 'SUMMARY TEXT', count: 2 });
    const prompt = (model.requests[0]!.messages[0]!.parts[0] as { text: string }).text;
    expect(prompt).toContain('An old request.');
    expect(prompt).toContain('An old answer.');
    expect(prompt).not.toContain('The open request');
    expect((await repos.sessions.get(session.id))!.summary).toBe('SUMMARY TEXT');
    expect((await repos.sessions.get(session.id))!.summaryCount).toBe(2);
    // The transcript itself is untouched.
    expect(await repos.messages.listBySession(session.id)).toHaveLength(3);
  });

  it('only summarises messages the existing summary does not already cover', async () => {
    const { repos, session } = await seed();
    const oldTurn = newId<TurnId>();
    const openTurn = newId<TurnId>();
    await append(repos, session, 'user', 'Already covered.', oldTurn);
    await append(repos, session, 'assistant', 'Also covered.', oldTurn);
    await append(repos, session, 'user', 'Newly old message. '.repeat(20), oldTurn);
    await append(repos, session, 'assistant', 'Newly old answer.', oldTurn);
    await append(repos, session, 'user', 'The open request.', openTurn);
    await repos.sessions.setSummary(session.id, 'The earlier summary.', 2);

    const model = new ScriptedProvider([{ content: 'UPDATED SUMMARY' }]);
    const compactor = new Compactor({
      models: new ModelRouter(
        new Map([[model.id, model]]),
        { purposes: { chat: 'scripted/m' }, fallbacks: {} },
        new ModelCatalog(),
        LOG,
      ),
      sessions: repos.sessions,
      clock,
      log: LOG,
    });
    const transcript = await repos.messages.listBySession(session.id);
    const stored = (await repos.sessions.get(session.id))!;
    const turn = Turn.create({
      id: openTurn,
      sessionId: session.id,
      source: 'user',
      createdAt: clock.now(),
    });

    const result = await compactor.compactIfNeeded(stored, turn, transcript, 30);

    expect(result).toEqual({ summary: 'UPDATED SUMMARY', count: 4 });
    const prompt = (model.requests[0]!.messages[0]!.parts[0] as { text: string }).text;
    expect(prompt).toContain('The earlier summary.');
    expect(prompt).toContain('Newly old message.');
    expect(prompt).not.toContain('Already covered.');
    expect(prompt).not.toContain('The open request.');
  });

  it('lets Stop through instead of swallowing the summarize request', async () => {
    const { repos, session } = await seed();
    const openTurn = newId<TurnId>();
    await append(repos, session, 'user', 'An old request. '.repeat(20), newId<TurnId>());
    await append(repos, session, 'user', 'The open request.', openTurn);

    const provider = new HangingProvider();
    const compactor = new Compactor({
      models: new ModelRouter(
        new Map([[provider.id, provider]]),
        { purposes: { chat: 'hang/m' }, fallbacks: {} },
        new ModelCatalog(),
        LOG,
      ),
      sessions: repos.sessions,
      clock,
      log: LOG,
    });
    const transcript = await repos.messages.listBySession(session.id);
    const turn = Turn.create({
      id: openTurn,
      sessionId: session.id,
      source: 'user',
      createdAt: clock.now(),
    });

    const controller = new AbortController();
    const pending = compactor.compactIfNeeded(session, turn, transcript, 30, controller.signal);
    controller.abort(new Error('stopped by owner'));

    await expect(pending).rejects.toThrow('stopped by owner');
    expect((await repos.sessions.get(session.id))!.summary).toBeUndefined();
  });

  it('does nothing while the transcript fits the window', async () => {
    const { repos, session } = await seed();
    const turn = Turn.create({
      id: newId<TurnId>(),
      sessionId: session.id,
      source: 'user',
      createdAt: clock.now(),
    });
    await append(repos, session, 'user', 'Short.', turn.id);
    const transcript = await repos.messages.listBySession(session.id);
    const model = new ScriptedProvider([]);
    const compactor = new Compactor({
      models: new ModelRouter(
        new Map([[model.id, model]]),
        { purposes: { chat: 'scripted/m' }, fallbacks: {} },
        new ModelCatalog(),
        LOG,
      ),
      sessions: repos.sessions,
      clock,
      log: LOG,
    });

    expect(await compactor.compactIfNeeded(session, turn, transcript, 10_000)).toBeUndefined();
    expect(model.requests).toHaveLength(0);
  });
});

describe('ContextBuilder: the compaction summary replaces older messages (S23)', () => {
  it('puts the summary at the start of the history and leaves covered messages out', async () => {
    const { repos, session } = await seed();
    const turn = Turn.create({
      id: newId<TurnId>(),
      sessionId: session.id,
      source: 'user',
      createdAt: clock.now(),
    });
    const oldTurn = newId<TurnId>();
    await append(repos, session, 'user', 'Covered question.', oldTurn);
    await append(repos, session, 'assistant', 'Covered answer.', oldTurn);
    await append(repos, session, 'user', 'The open request.', turn.id);
    await repos.sessions.setSummary(session.id, 'They talked about something old.', 2);

    const saved = (await repos.sessions.get(session.id))!;
    const builder = new ContextBuilder({
      injectables: () => [new CompactionSummaryInjectable()],
      repos,
      ownerId: OWNER,
      log: LOG,
    });
    const built = await builder.build(saved, turn);

    expect(built.messages[0]!.role).toBe('system');
    expect(built.messages[0]!.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('They talked about something old.'),
    });
    expect(JSON.stringify(built.messages)).not.toContain('Covered question.');
    expect(JSON.stringify(built.messages)).not.toContain('Covered answer.');
    expect(JSON.stringify(built.messages)).toContain('The open request.');
  });
});

describe('compaction end to end (F04 criterion 5)', () => {
  it('a long conversation compacts without losing the open request', async () => {
    const services = testServices();
    const repos = new InMemoryRepositories();
    await repos.owners.upsert({
      id: OWNER,
      displayName: 'Jeanne',
      timezone: 'Europe/Paris',
      locale: 'fr-FR',
    });
    // One chat reply, then the summary, then the reply to the open request.
    const provider = new ScriptedProvider([
      { content: 'First reply.' },
      { content: 'SUMMARY TEXT' },
      { content: 'Final reply.' },
    ]);
    const models = new ModelRouter(
      new Map([[provider.id, provider]]),
      { purposes: { chat: 'scripted/m' }, fallbacks: {} },
      new ModelCatalog([{ ref: 'scripted/m', contextWindow: 30 }]),
      services.log,
    );
    const tools = new ToolCatalog();
    const jobs = new InMemoryJobQueue(services.log, services.clock);
    const agent = new Agent({
      name: 'Test',
      ownerId: OWNER,
      models,
      tools,
      pipeline: new ToolPipeline(
        tools,
        defaultMiddlewares({ turnEvents: repos.turnEvents, clock: services.clock }),
      ),
      repos,
      jobs,
      ...services,
    });
    await jobs.start();
    await agent.start();

    await agent.send(`An old request. ${'words '.repeat(40)}`);
    const open = await agent.send('The open request, which must survive.');
    expect(open.reply).toBe('Final reply.');

    // The summarize call saw the old exchange, never the open request.
    const summarisePrompt = (provider.requests[1]!.messages[0]!.parts[0] as { text: string }).text;
    expect(summarisePrompt).toContain('An old request.');
    expect(summarisePrompt).not.toContain('The open request, which must survive.');

    // The answering call has the summary first, no covered messages, and the open request last.
    const request = provider.requests[2]!;
    expect(JSON.stringify(request.messages[0])).toContain('SUMMARY TEXT');
    expect(JSON.stringify(request.messages)).not.toContain('An old request.');
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')!;
    expect(JSON.stringify(lastUser)).toContain('The open request, which must survive.');

    const session = (await repos.sessions.get(open.sessionId))!;
    expect(session.summary).toBe('SUMMARY TEXT');
    expect(session.summaryCount).toBe(2);
    expect(await repos.messages.listBySession(open.sessionId)).toHaveLength(4);
  });
});

/** A model that never answers until it is aborted, for the Stop path. */
class HangingProvider implements ModelProvider {
  readonly id = 'hang';
  async *stream(_request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    yield { type: 'done', finishReason: 'other' }; // unreachable unless nothing aborts
  }
  async listModels() {
    return [];
  }
}
