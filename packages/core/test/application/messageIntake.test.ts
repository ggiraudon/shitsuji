import { describe, expect, it } from 'vitest';
import { InMemoryJobQueue } from '../../src/adapters/jobs/InMemoryJobQueue.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { MessageIntake } from '../../src/application/runtime/MessageIntake.js';
import { textOf } from '../../src/domain/model/Message.js';
import { Turn } from '../../src/domain/model/Turn.js';
import { asId, type OwnerId, type TurnId } from '../../src/domain/model/ids.js';
import { testServices } from '../helpers.js';

const OWNER = asId<OwnerId>('owner');

function setup() {
  const services = testServices();
  const repos = new InMemoryRepositories();
  const jobs = new InMemoryJobQueue(services.log, services.clock);
  const intake = new MessageIntake({ ownerId: OWNER, repos, jobs, agentName: 'Test', ...services });
  return { intake, repos, services, jobs };
}

describe('MessageIntake: waiting turns (#30)', () => {
  it('ends the waiting turn when the owner answers, and starts a resume turn', async () => {
    const { intake, repos, services } = setup();
    const first = await intake.submit('Ask me later');

    const waiting = (await repos.turns.get(first.turnId))!;
    waiting.start(services.clock.now());
    waiting.wait(services.clock.now());
    expect(await repos.turns.update(waiting, 'queued')).toBe(true);

    const second = await intake.submit('Here is the answer');

    expect(second.turnId).not.toBe(first.turnId);
    expect(second.steered).toBe(false);
    expect((await repos.turns.get(first.turnId))!.status).toBe('succeeded');
    const resumed = (await repos.turns.get(second.turnId))!;
    expect(resumed.source).toBe('resume');
    expect(resumed.status).toBe('queued');

    const messages = await repos.messages.listBySession(second.sessionId);
    const answer = messages.find((m) => m.author === 'owner' && textOf(m) === 'Here is the answer');
    expect(answer?.turnId).toBe(second.turnId);
  });

  it('does not touch a waiting turn when a newer turn is already queued', async () => {
    const { intake, repos, services } = setup();
    const first = await intake.submit('First');
    const waiting = (await repos.turns.get(first.turnId))!;
    waiting.start(services.clock.now());
    waiting.wait(services.clock.now());
    await repos.turns.update(waiting, 'queued');
    // A newer queued turn takes the answer; the older waiting turn is left for its own cleanup.
    const newer = Turn.create({
      id: asId<TurnId>('newer-turn'),
      sessionId: first.sessionId,
      source: 'user',
      createdAt: services.clock.now(),
    });
    await repos.turns.insert(newer);

    const third = await intake.submit('Third');

    expect(third.turnId).toBe(newer.id);
    expect((await repos.turns.get(first.turnId))!.status).toBe('waiting');
  });
});
