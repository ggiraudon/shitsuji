import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Kysely,
  Migrator,
  PostgresDialect,
  sql,
  type Migration,
  type MigrationProvider,
} from 'kysely';
import pg from 'pg';
import type { Logger } from '../../ports/Logger.js';
import type { Database } from './schema.js';

/** packages/core/migrations, found from both src/ (tests, tsx) and dist/ (built). */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);

/** Runs every `NNNN_name.sql` file in order, each in its own transaction. Forward-only. */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(
    /** The folder holding the `.sql` files; `MIGRATIONS_DIR` by default. */
    private readonly dir: string = MIGRATIONS_DIR,
  ) {}

  /**
   * The migrations Kysely runs, keyed by file name without `.sql`. A file has only an `up`: the
   * migrations are forward-only, so Kysely is never asked to roll one back.
   */
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const text = fs.readFileSync(path.join(this.dir, file), 'utf8');
      migrations[file.replace(/\.sql$/, '')] = {
        up: async (db) => {
          await sql.raw(text).execute(db);
        },
      };
    }
    return migrations;
  }
}

/** How to open the database: the connection string, a logger, and the pool size. */
export interface PostgresOptions {
  /** The `postgres://` URL; only the composition root reads it from config. */
  url: string;
  /** Structured logger for pool errors and applied migrations. */
  log: Logger;
  /** Pool size. */
  max?: number;
}

/** Owns the connection pool and the Kysely instance. */
export class PostgresDatabase {
  private constructor(
    /** The typed query builder over the migrated schema. */
    readonly db: Kysely<Database>,
    /** The logger shared with the pool. */
    private readonly log: Logger,
  ) {}

  /** Opens the pool and wraps it in Kysely; no query runs until `migrate` or a repository call. */
  static connect(options: PostgresOptions): PostgresDatabase {
    const pool = new pg.Pool({ connectionString: options.url, max: options.max ?? 10 });
    pool.on('error', (error) =>
      options.log.error('Postgres pool error', {
        error: { name: error.name, message: error.message },
      }),
    );
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return new PostgresDatabase(db, options.log);
  }

  /** Applies pending migrations. Throws, naming the migration, if one fails. */
  async migrate(dir?: string): Promise<string[]> {
    const migrator = new Migrator({
      db: this.db,
      provider: new SqlFileMigrationProvider(dir),
      migrationTableName: 'schema_migrations',
      migrationLockTableName: 'schema_migrations_lock',
    });
    const { error, results = [] } = await migrator.migrateToLatest();
    const applied = results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
    const failed = results.find((r) => r.status === 'Error');
    if (error || failed) {
      throw new Error(
        `${failed ? `Database migration ${failed.migrationName}` : 'Database migration'} failed: ${(error as Error)?.message ?? error}`,
        { cause: error },
      );
    }
    if (applied.length) this.log.info('Database migrated', { applied });
    return applied;
  }

  /** Destroys the pool; the process calls it once on shutdown. */
  async close(): Promise<void> {
    await this.db.destroy();
  }
}
