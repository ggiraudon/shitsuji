import type { Transaction } from './Repositories.js';

/** How to enqueue one job. All fields are optional; the queue's defaults apply otherwise. */
export interface EnqueueOptions {
  /** Do not run before this time. */
  startAfter?: Date;
  /**
   * At most one queued and one running job with this key; a duplicate enqueue returns null. A job
   * name is used either always with a key or never (mixing them is an error).
   */
  singletonKey?: string;
  /** Retries after a failed run (handlers must be idempotent). Default 2. */
  retryLimit?: number;
}

/** One stored job as the handler receives it: its queue name and the data it was enqueued with. */
export interface Job<T> {
  id: string;
  name: string;
  data: T;
}

/** Runs one job. Rejecting marks the run failed, which is what triggers the retry limit. */
export type JobHandler<T> = (job: Job<T>) => Promise<void>;

/**
 * Durable background work. Enqueue with a Transaction to queue the job only if the surrounding writes
 * commit (e.g. store a turn and wake its worker atomically).
 *
 * A handler may run more than once (a retry after a crash), so it must be idempotent: `session.drain`
 * is, because the start of a turn is a compare-and-set.
 */
export interface JobQueue {
  /** Opens the connection and starts polling. `Shitsuji.start` calls it before the agent registers. */
  start(): Promise<void>;
  /** Stops polling and waits briefly for running jobs; leftover work is picked up on the next start. */
  stop(): Promise<void>;
  /** Returns the job id, or null when a job with the same singletonKey is already queued. */
  enqueue<T extends object>(
    name: string,
    data: T,
    options?: EnqueueOptions,
    tx?: Transaction,
  ): Promise<string | null>;
  /** `keyed`: this queue's jobs always use singletonKey (must match how they are enqueued). */
  work<T>(
    name: string,
    handler: JobHandler<T>,
    options?: { concurrency?: number; keyed?: boolean },
  ): Promise<void>;
}
