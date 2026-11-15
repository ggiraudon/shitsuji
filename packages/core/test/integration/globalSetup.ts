import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

let container: StartedPostgreSqlContainer | undefined;

/** Starts one Postgres (same image as compose.yaml) for the whole integration run. */
export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
    .withDatabase('shitsuji')
    .withUsername('shitsuji')
    .withPassword('shitsuji')
    .start();
  project.provide('postgresUrl', container.getConnectionUri());
}

export async function teardown() {
  await container?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}
