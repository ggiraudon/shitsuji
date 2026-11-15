import { CompiledQuery } from 'kysely';
import PgBoss from 'pg-boss';
import { serializeError } from '../../domain/errors.js';
import type { EnqueueOptions, JobHandler, JobQueue } from '../../ports/JobQueue.js';
import type { Logger } from '../../ports/Logger.js';
import type { Transaction } from '../../ports/Repositories.js';
import { kyselyOf } from '../postgres/PostgresRepositories.js';

/**
 * Durable jobs in Postgres with pg-boss (its tables live in the `pgboss` schema). Enqueue with a
 * Transaction from PostgresRepositories to insert the job in that same transaction.
 */
export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  /** Queue name -> whether its jobs use singletonKey. */
  private readonly queues = new Map<string, boolean>();

  constructor(
    connectionString: string,
    private readonly log: Logger,
  ) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss' });
    this.boss.on('error', (error) =>
      this.log.error('Job queue error', { error: serializeError(error) }),
    );
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  async enqueue<T extends object>(
    name: string,
    data: T,
    options: EnqueueOptions = {},
    tx?: Transaction,
  ): Promise<string | null> {
    await this.ensureQueue(name, options.singletonKey !== undefined);
    const db = tx ? kyselyOf(tx) : undefined;
    return this.boss.send(name, data, {
      startAfter: options.startAfter,
      singletonKey: options.singletonKey,
      retryLimit: options.retryLimit ?? 2,
      retryBackoff: true,
      ...(db && {
        db: {
          executeSql: async (text: string, values: unknown[]) => {
            const result = await db.executeQuery(CompiledQuery.raw(text, values));
            return { rows: result.rows as unknown[] };
          },
        },
      }),
    });
  }

  async work<T>(
    name: string,
    handler: JobHandler<T>,
    options: { concurrency?: number; keyed?: boolean } = {},
  ): Promise<void> {
    await this.ensureQueue(name, options.keyed);
    // pg-boss 10 runs one batch per worker; several workers give concurrency.
    for (let i = 0; i < (options.concurrency ?? 1); i++) {
      await this.boss.work<T>(name, { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) await handler({ id: job.id, name: job.name, data: job.data });
      });
    }
  }

  /**
   * pg-boss 10 only enforces singletonKey on a queue with a uniqueness policy, so a keyed queue is
   * created as 'stately' (one queued and one active job per key). `keyed` is unknown for work().
   */
  private async ensureQueue(name: string, keyed?: boolean): Promise<void> {
    const known = this.queues.get(name);
    if (known !== undefined) {
      if (keyed !== undefined && keyed !== known) {
        throw new Error(`Jobs "${name}" must ${known ? 'always' : 'never'} use a singletonKey`);
      }
      return;
    }
    const existing = await this.boss.getQueue(name);
    if (existing) {
      this.queues.set(name, existing.policy === 'stately');
      return this.ensureQueue(name, keyed);
    }
    if (keyed === undefined) {
      await this.boss.createQueue(name); // created by work() before any enqueue: unkeyed
      this.queues.set(name, false);
      return;
    }
    await this.boss.createQueue(name, { name, policy: keyed ? 'stately' : 'standard' });
    this.queues.set(name, keyed);
  }
}
