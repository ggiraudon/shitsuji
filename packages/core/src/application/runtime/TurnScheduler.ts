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
 * turn at a time per session, sessions in parallel. The start is a compare-and-set (`update(next,
 * 'queued')`), so two workers (or two processes) can never both run a turn. The turn runs detached
 * from the job, so a long turn never hits the job's expiry; a crash mid-turn is handled by
 * `StartupRecovery`, not by a job retry.
 *
 * `Agent.start()` registers the worker and wakes every session that has queued turns; each turn's
 * completion funnels back into `afterTurn`, which enqueues the next drain if one is still queued.
 *
 * ```mermaid
 * flowchart TD
 *   wake([session.drain]) --> list[list the session's turns]
 *   list --> running{a turn is running?}
 *   running -- yes --> stop([return; that turn drains again when it ends])
 *   running -- no --> next[oldest queued with startAfter <= now]
 *   next --> none{none?}
 *   none -- yes --> stop
 *   none -- no --> start[Turn.start; update from queued]
 *   start --> lost{lost the compare-and-set?}
 *   lost -- yes --> stop
 *   lost -- no --> run[TurnRunner.run detached]
 *   run --> after[requeue unanswered; enqueue a drain if still queued]
 * ```
 */
export class TurnScheduler {
  /** Detached runs started by this scheduler; `idle()` waits on them. */
  private readonly active = new Set<Promise<unknown>>();

  /**
   * Stores the dependencies. It does not register the worker or enqueue anything; `start()` does
   * that once the job queue is running.
   */
  constructor(
    /** Everything the scheduler needs; see the comments on each field. */
    private readonly deps: {
      /** Turn and session storage; the drain reads turns and the start is a compare-and-set. */
      repos: Repositories;
      /** The durable queue: the worker registration, the wake-ups and the after-turn enqueue. */
      jobs: JobQueue;
      /** The step loop for a turn that this scheduler has moved to `running`. */
      runner: TurnRunner;
      /** Requeues an owner message that arrived just as a turn was finishing. */
      intake: MessageIntake;
      /** Injected clock for the `startAfter` comparison and the turn's start time. */
      clock: Clock;
      /** Structured logger for a crashed run and a failed after-turn step. */
      log: Logger;
      /** How many sessions may drain in parallel (default 4); keyed by session. */
      concurrency?: number;
    },
  ) {}

  /**
   * Registers the worker (keyed, four sessions by default) and wakes every session that still has
   * queued turns after a restart. Called by `Agent.start()` after the job queue started; awaits the
   * registration and every enqueue in sequence. A duplicate enqueue is harmless because the jobs
   * use `singletonKey: sessionId`.
   */
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

  /**
   * Resolves when no turn started by this scheduler is still running (for shutdown and tests).
   * It awaits the current set with `allSettled` and loops in case more runs were added; it never
   * rejects because a turn failed (the runner turns failures into results). Turns started by other
   * processes are not visible here.
   */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active]);
  }

  /**
   * The job handler. It lists the session's turns in creation order and returns if any is
   * `running` (that turn's `afterTurn` will wake it again). Otherwise it takes the oldest `queued`
   * turn whose `startAfter` has passed, moves it to `running` and saves it with compare-and-set;
   * losing that race means another worker won, so this one returns. On success it starts
   * `TurnRunner.run` and **does not await it**: the job finishes after the start, the run joins the
   * `active` set, and `afterTurn` runs when it settles. A crash inside the runner is caught and
   * logged; a crash of the process is left to `StartupRecovery`.
   */
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

  /**
   * Runs after every detached turn, whatever its outcome: `MessageIntake.requeueIfUnanswered`
   * catches an owner message that arrived just as the turn was finishing, then one more drain is
   * enqueued when a queued turn remains. Errors are logged and swallowed so the detached promise
   * never rejects; a failure here could leave a queued turn waiting for the next external event.
   */
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
