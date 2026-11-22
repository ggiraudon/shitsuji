import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import {
  AGENT_TAKEOVER_PREFIX,
  DesktopControlService,
  OWNER_TAKEOVER_PREFIX,
  type ControlSandbox,
} from '../../src/application/desktop/DesktopControlService.js';
import { asId, newId, type OwnerId } from '../../src/domain/model/ids.js';
import { textOf } from '../../src/domain/model/Message.js';
import { Session } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import type { DesktopControlMode } from '../../src/ports/DesktopControl.js';
import { testServices } from '../helpers.js';

const OWNER = asId<OwnerId>('owner');

async function setup(options: { timeoutMs?: number; vision?: boolean } = {}) {
  const repos = new InMemoryRepositories();
  await repos.owners.upsert({ id: OWNER, displayName: 'Sam', timezone: 'UTC', locale: 'en' });
  const thread = await repos.threads.getOrCreateForOwner(OWNER, new Date());
  const session = new Session(newId(), thread.id, 'chat', new Date());
  await repos.sessions.insert(session);
  const turn = Turn.create({
    id: newId(),
    sessionId: session.id,
    source: 'user',
    createdAt: new Date(),
    replyChannel: 'tui',
  });
  turn.start(new Date());
  await repos.turns.insert(turn);

  const services = testServices();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const enqueue = vi.spyOn(jobs, 'enqueue');
  let mode: DesktopControlMode = 'agent';
  const listeners = new Set<(mode: DesktopControlMode) => void>();
  const sandbox: ControlSandbox = {
    get desktopMode() {
      return mode;
    },
    enterOwnerControl() {
      mode = 'owner';
      for (const listener of listeners) listener(mode);
    },
    leaveOwnerControl() {
      mode = 'agent';
      for (const listener of listeners) listener(mode);
    },
    fullViewerCredentials: async () => ({ fullControlPassword: 'full-pass' }),
    captureScreenshot: async () => ({
      mediaType: 'image/png',
      ref: 'sessions/s/images/take-control.png',
      name: 'take-control.png',
    }),
    onDesktopModeChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const service = new DesktopControlService({
    sandbox,
    repos,
    jobs,
    events: services.events,
    clock: services.clock,
    log: services.log,
    viewerUrl: 'http://127.0.0.1:3001/desktop',
    vision: options.vision ?? true,
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
  await service.start();
  return { service, sandbox, repos, session, turn, jobs, enqueue, mode: () => mode, services };
}

const after: DesktopControlService[] = [];
afterEach(() => {
  for (const service of after.splice(0)) service.stop();
});

describe('desktop control (S55)', () => {
  it('enters owner mode, refuses the full password in agent mode, and gives it in owner mode', async () => {
    const { service } = await setup();
    after.push(service);
    await expect(service.fullCredentials()).rejects.toThrow(/does not have control/);

    const taken = await service.take();
    expect(taken.mode).toBe('owner');
    expect(service.status()).toMatchObject({ mode: 'owner', requestedBy: 'owner' });
    await expect(service.fullCredentials()).resolves.toEqual({
      fullControlPassword: 'full-pass',
    });
  });

  it('pauses running turns on Take control and resumes one with a note and a screenshot', async () => {
    const { service, repos, session, turn, enqueue } = await setup();
    after.push(service);
    await service.take();

    const paused = await repos.turns.get(turn.id);
    expect(paused?.status).toBe('waiting');
    const question = (await repos.messages.listBySession(session.id))
      .filter((message) => message.turnId === turn.id)
      .map(textOf)
      .join('\n');
    expect(question).toContain(OWNER_TAKEOVER_PREFIX);

    await service.giveBack();

    const turns = await repos.turns.listBySession(session.id);
    expect(turns.find((entry) => entry.id === turn.id)!.status).toBe('succeeded');
    const resume = turns.find((entry) => entry.source === 'resume')!;
    expect(resume.status).toBe('queued');
    expect(resume.source).toBe('resume');
    const note = (await repos.messages.listBySession(session.id)).find(
      (message) => message.turnId === resume.id && message.role === 'system',
    );
    expect(note).toBeDefined();
    expect(textOf(note!)).toContain('The owner gave the desktop back');
    expect(note!.parts.some((part) => part.type === 'image')).toBe(true);
    expect(enqueue).toHaveBeenCalled();
  });

  it('never resumes twice: a second Give back creates no second turn', async () => {
    const { service, repos, session } = await setup();
    after.push(service);
    await service.take();
    await service.giveBack();
    const afterFirst = (await repos.turns.listBySession(session.id)).length;
    await service.giveBack();
    expect((await repos.turns.listBySession(session.id)).length).toBe(afterFirst);
  });

  it('resumes after the timeout with a note instead of leaving the desktop in owner mode', async () => {
    const { service, repos, session, turn, mode } = await setup({ timeoutMs: 30 });
    after.push(service);
    await service.take();
    expect(mode()).toBe('owner');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(mode()).toBe('agent');
    const turns = await repos.turns.listBySession(session.id);
    expect(turns.find((entry) => entry.id === turn.id)!.status).toBe('succeeded');
    const resume = turns.find((entry) => entry.source === 'resume')!;
    expect(resume.source).toBe('resume');
    const note = (await repos.messages.listBySession(session.id)).find(
      (message) => message.turnId === resume.id && message.role === 'system',
    );
    expect(textOf(note!)).toContain('did not give the desktop back in time');
  });

  it('labels an agent request as the agent’s words and includes the viewer link', async () => {
    const { service, session, turn } = await setup();
    after.push(service);
    const answer = await service.requestByAgent({
      sessionId: session.id,
      turnId: turn.id,
      reason: 'It asks for a CAPTCHA.',
    });
    expect(answer.ok).toBe(true);
    expect(answer.question).toContain(AGENT_TAKEOVER_PREFIX);
    expect(answer.question).toContain('its words, not verified');
    expect(answer.question).toContain('It asks for a CAPTCHA.');
    expect(answer.question).toContain('http://127.0.0.1:3001/desktop');
    expect(service.status().requestedBy).toBe('agent');
  });

  it('refuses a second takeover request while the owner has control', async () => {
    const { service, session, turn } = await setup();
    after.push(service);
    await service.take();
    await expect(
      service.requestByAgent({ sessionId: session.id, turnId: turn.id, reason: 'again' }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('resumes a takeover turn left by a restart and returns to agent mode', async () => {
    const { repos, session, turn } = await setup();
    // Rewind the running turn to the state a previous process left it in.
    const waiting = (await repos.turns.get(turn.id))!;
    waiting.wait(new Date());
    await repos.turns.update(waiting, 'running');
    await repos.messages.append({
      id: newId(),
      threadId: session.threadId,
      sessionId: session.id,
      turnId: turn.id,
      role: 'assistant',
      author: 'assistant',
      parts: [{ type: 'text', text: `${AGENT_TAKEOVER_PREFIX}\n\nReason` }],
      withdrawn: false,
      createdAt: new Date(),
    });

    // A new process: the service starts in agent mode and sees a waiting owner request.
    const services = testServices();
    const jobs = new InMemoryJobQueue(services.log, services.clock);
    let mode: DesktopControlMode = 'agent';
    const sandbox: ControlSandbox = {
      get desktopMode() {
        return mode;
      },
      enterOwnerControl() {
        mode = 'owner';
      },
      leaveOwnerControl() {
        mode = 'agent';
      },
      fullViewerCredentials: async () => ({ fullControlPassword: 'full-pass' }),
      captureScreenshot: async () => undefined,
      onDesktopModeChange: () => () => undefined,
    };
    const restarted = new DesktopControlService({
      sandbox,
      repos,
      jobs,
      events: services.events,
      clock: services.clock,
      log: services.log,
      vision: false,
    });
    after.push(restarted);
    await restarted.start();

    expect((await repos.turns.get(turn.id))!.status).toBe('succeeded');
    const turns = await repos.turns.listBySession(session.id);
    const resume = turns.find((entry) => entry.source === 'resume')!;
    expect(resume).toBeDefined();
    const note = (await repos.messages.listBySession(session.id)).find(
      (message) => message.turnId === resume.id && message.role === 'system',
    );
    expect(textOf(note!)).toContain('Core restarted');
  });
});
