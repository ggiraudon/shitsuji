import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { NullLogger } from '../../src/adapters/logging/loggers.js';
import { PostgresDatabase } from '../../src/adapters/postgres/PostgresDatabase.js';

const opened: PostgresDatabase[] = [];

/** A fresh, migrated database for one test, on the shared Postgres container of this run. */
export async function freshDatabase(): Promise<{ database: PostgresDatabase; url: string }> {
  const admin = inject('postgresUrl');
  const name = `t_${randomUUID().replace(/-/g, '')}`;
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();
  const url = admin.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  const database = PostgresDatabase.connect({ url, log: new NullLogger() });
  await database.migrate();
  opened.push(database);
  return { database, url };
}

export async function closeAll(): Promise<void> {
  await Promise.all(opened.splice(0).map((d) => d.close()));
}
