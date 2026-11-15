import { randomUUID } from 'node:crypto';
import { serializeError } from '../../domain/errors.js';
import type { Clock } from '../../ports/Clock.js';
import type { EnqueueOptions, Job, JobHandler, JobQueue } from '../../ports/JobQueue.js';
import type { Logger } from '../../ports/Logger.js';

interface Pending {
  job: Job<unknown>;
  runAt: number;
  attemptsLeft: number;
  singletonKey?: string;
}

/**
 * Runs jobs in this process, for tests and for running without a database. Not durable, and it does
 * not join transactions: a job enqueued inside a unit of work runs even if the work rolls back.
 */
export class InMemoryJobQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler<unknown>>();
  private readonly pending: Pending[] = [];
  private running = false;
  private active = 0;
  private timer: NodeJS.Timeout | undefined;
  private idle: (() => void)[] = [];

  constructor(
    private readonly log: Logger,
    private readonly clock: Clock,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async enqueue<T extends object>(
    name: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    if (options.singletonKey && this.pending.some((p) => p.singletonKey === options.singletonKey)) {
      return null;
    }
    const job: Job<unknown> = { id: randomUUID(), name, data: structuredClone(data) };
    this.pending.push({
      job,
      runAt: options.startAfter?.getTime() ?? 0,
      attemptsLeft: (options.retryLimit ?? 2) + 1,
      singletonKey: options.singletonKey,
    });
    this.schedule();
    return job.id;
  }

  async work<T>(name: string, handler: JobHandler<T>): Promise<void> {
    if (this.handlers.has(name)) throw new Error(`A worker for "${name}" is already registered`);
    this.handlers.set(name, handler as JobHandler<unknown>);
    this.schedule();
  }

  /** Resolves when nothing runnable is left (for tests). Jobs scheduled later are not waited for. */
  async drain(): Promise<void> {
    if (!this.hasRunnable() && this.active === 0) return;
    await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  private hasRunnable(): boolean {
    const now = this.clock.now().getTime();
    return this.pending.some((p) => p.runAt <= now && this.handlers.has(p.job.name));
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
  }

  private async tick(): Promise<void> {
    const now = this.clock.now().getTime();
    const index = this.pending.findIndex((p) => p.runAt <= now && this.handlers.has(p.job.name));
    if (index === -1) {
      if (this.active === 0) this.idle.splice(0).forEach((resolve) => resolve());
      return;
    }
    const [item] = this.pending.splice(index, 1);
    this.active++;
    try {
      await this.handlers.get(item!.job.name)!(item!.job);
    } catch (error) {
      item!.attemptsLeft--;
      this.log.error('Job failed', {
        job: item!.job.name,
        id: item!.job.id,
        attemptsLeft: item!.attemptsLeft,
        error: serializeError(error),
      });
      if (item!.attemptsLeft > 0) this.pending.push(item!);
    } finally {
      this.active--;
    }
    this.schedule();
  }
}
