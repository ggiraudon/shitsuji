import { serializeError } from '../../domain/errors.js';
import type { SessionId } from '../../domain/model/ids.js';
import type { Clock } from '../../ports/Clock.js';
import type { JobQueue } from '../../ports/JobQueue.js';
import type { Logger } from '../../ports/Logger.js';
import type { Repositories } from '../../ports/Repositories.js';
import { DRAIN_JOB, type MessageIntake } from './MessageIntake.js';
import type { TurnRunner } from './TurnRunner.js';

/**
 * Handles `session.drain`: starts the oldest queued turn of a session that has no running turn. One
 * turn at a time per session, sessions in parallel. The start is a compare-and-set, so two workers
 * (or two processes) can never both run a turn. The turn runs detached from the job, so a long turn
 * never hits the job's expiry; a crash mid-turn is handled by StartupRecovery.
 */
export class TurnScheduler {
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: {
      repos: Repositories;
      jobs: JobQueue;
      runner: TurnRunner;
      intake: MessageIntake;
      clock: Clock;
      log: Logger;
      concurrency?: number;
    },
  ) {}

  /** Registers the worker and wakes every session that still has queued turns (after a restart). */
  async start(): Promise<void> {
    const { jobs, repos } = this.deps;
    await jobs.work<{ sessionId: SessionId }>(DRAIN_JOB, (job) => this.drain(job.data.sessionId), {
      concurrency: this.deps.concurrency ?? 4,
      keyed: true,
    });
    const sessions = new Set((await repos.turns.listByStatus('queued')).map((t) => t.sessionId));
    for (const sessionId of sessions) {
      await jobs.enqueue(DRAIN_JOB, { sessionId }, { singletonKey: sessionId });
    }
  }

  /** Resolves when no turn started by this scheduler is still running (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active]);
  }

  private async drain(sessionId: SessionId): Promise<void> {
    const { repos, clock, runner } = this.deps;
    const turns = await repos.turns.listBySession(sessionId);
    if (turns.some((t) => t.status === 'running')) return; // it drains again when it ends
    const now = clock.now().getTime();
    const next = turns.find(
      (t) => t.status === 'queued' && (t.toProps().startAfter?.getTime() ?? 0) <= now,
    );
    if (!next) return;
    next.start(clock.now());
    if (!(await repos.turns.update(next, 'queued'))) return; // someone else started it
    const run = runner
      .run(next)
      .catch((error: unknown) =>
        this.deps.log.error('Turn runner crashed', {
          turnId: next.id,
          error: serializeError(error),
        }),
      )
      .then(() => this.afterTurn(sessionId));
    this.active.add(run);
    void run.finally(() => this.active.delete(run));
  }

  private async afterTurn(sessionId: SessionId): Promise<void> {
    try {
      await this.deps.intake.requeueIfUnanswered(sessionId);
      const queued = (await this.deps.repos.turns.listBySession(sessionId)).some(
        (t) => t.status === 'queued',
      );
      if (queued) {
        await this.deps.jobs.enqueue(DRAIN_JOB, { sessionId }, { singletonKey: sessionId });
      }
    } catch (error) {
      this.deps.log.error('Could not schedule the next turn', {
        sessionId,
        error: serializeError(error),
      });
    }
  }
}
