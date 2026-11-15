import type { Transaction } from './Repositories.js';

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

export interface Job<T> {
  id: string;
  name: string;
  data: T;
}

export type JobHandler<T> = (job: Job<T>) => Promise<void>;

/**
 * Durable background work. Enqueue with a Transaction to queue the job only if the surrounding writes
 * commit (e.g. store a turn and wake its worker atomically).
 */
export interface JobQueue {
  start(): Promise<void>;
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
