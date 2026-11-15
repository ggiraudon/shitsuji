import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { NodeTextFile } from '../../src/adapters/files/NodeTextFile.js';
import { SoulService } from '../../src/application/soul/SoulService.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import {
  DEFAULT_SOUL,
  SOUL_MAX_BYTES,
  SoulEditChanged,
  SoulEmpty,
  SoulNoPendingEdit,
  SoulTooLarge,
} from '../../src/domain/model/Soul.js';

const OWNER = asId<OwnerId>('owner');
const dirs: string[] = [];

async function setup() {
  const repos = new InMemoryRepositories();
  await repos.owners.upsert({ id: OWNER, displayName: 'Jeanne', timezone: 'UTC', locale: 'en' });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shitsuji-soul-'));
  dirs.push(dataDir);
  const clock = new ManualClock('2026-11-15T09:00:00.000Z');
  const soul = new SoulService({
    store: repos.soul,
    uow: repos.uow,
    ownerId: OWNER,
    clock,
    log: new MemoryLogger(),
    file: new NodeTextFile(path.join(dataDir, 'SOUL.md')),
  });
  return { repos, soul, dataDir, clock };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('SoulService (S23)', () => {
  it('seeds revision 1 from the default and writes SOUL.md', async () => {
    const { soul, dataDir } = await setup();
    const revision = await soul.start();

    expect(revision.revision).toBe(1);
    expect(revision.source).toBe('initial');
    expect(revision.body).toBe(DEFAULT_SOUL);
    expect(await fs.readFile(path.join(dataDir, 'SOUL.md'), 'utf8')).toBe(`${DEFAULT_SOUL}\n`);
    expect(await soul.current()).toEqual({ revision: 1, body: DEFAULT_SOUL });
  });

  it('publishes an edit as a new revision and uses it from the next read', async () => {
    const { soul } = await setup();
    await soul.start();

    const revision = await soul.edit('Be brief, and never invent a fact.');

    expect(revision.revision).toBe(2);
    expect(revision.source).toBe('owner');
    expect(await soul.current()).toEqual({
      revision: 2,
      body: 'Be brief, and never invent a fact.',
    });
    expect((await soul.revisions()).map((r) => r.revision)).toEqual([1, 2]);
  });

  it('turns an edit of SOUL.md into a revision once confirmed', async () => {
    const { soul, dataDir } = await setup();
    await soul.start();

    expect(await soul.pendingEdit()).toBeUndefined();
    await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'New standing instructions.\n', 'utf8');

    const pending = await soul.pendingEdit();
    expect(pending).toEqual({
      path: path.join(dataDir, 'SOUL.md'),
      current: DEFAULT_SOUL,
      proposed: 'New standing instructions.',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await soul.current()).toEqual({ revision: 1, body: DEFAULT_SOUL }); // not yet

    const revision = await soul.confirmEdit();
    expect(revision).toMatchObject({ revision: 2, source: 'owner' });
    expect(revision.body).toBe('New standing instructions.');
    expect(await soul.pendingEdit()).toBeUndefined();
    expect(await fs.readFile(path.join(dataDir, 'SOUL.md'), 'utf8')).toBe(
      'New standing instructions.\n',
    );
  });

  it('refuses to confirm an unchanged file', async () => {
    const { soul } = await setup();
    await soul.start();
    await expect(soul.confirmEdit()).rejects.toBeInstanceOf(SoulNoPendingEdit);
  });

  it('adds a fragment for one session kind only', async () => {
    const { soul } = await setup();
    await soul.start();
    await soul.publish(
      [
        { id: 'base', kind: 'base', body: 'Shared rules.', position: 0 },
        { id: 'task', kind: 'session', sessionKind: 'task', body: 'Be terse.', position: 1 },
      ],
      'owner',
    );

    expect((await soul.current('task')).body).toBe('Shared rules.\n\nBe terse.');
    expect((await soul.current('chat')).body).toBe('Shared rules.');
  });

  it('keeps session-kind fragments when an edit of SOUL.md is confirmed', async () => {
    const { soul, dataDir } = await setup();
    await soul.start();
    await soul.publish(
      [
        { id: 'base', kind: 'base', body: 'Shared rules.', position: 0 },
        { id: 'trait', kind: 'trait', body: 'Likes puns.', position: 1 },
        { id: 'task', kind: 'session', sessionKind: 'task', body: 'Be terse.', position: 2 },
      ],
      'owner',
    );
    await soul.export();
    // The export holds the shared text only: base and trait, assembled.
    expect(await fs.readFile(path.join(dataDir, 'SOUL.md'), 'utf8')).toBe(
      'Shared rules.\n\nLikes puns.\n',
    );

    await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'Shared rules, edited.\n', 'utf8');
    await soul.confirmEdit();

    expect((await soul.current('chat')).body).toBe('Shared rules, edited.');
    expect((await soul.current('task')).body).toBe('Shared rules, edited.\n\nBe terse.');
  });

  it('refuses to confirm when SOUL.md changed after the review', async () => {
    const { soul, dataDir } = await setup();
    await soul.start();
    await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'Reviewed.\n', 'utf8');
    const reviewed = (await soul.pendingEdit())!.hash;
    await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'Changed after the review.\n', 'utf8');

    await expect(soul.confirmEdit(reviewed)).rejects.toBeInstanceOf(SoulEditChanged);
    expect((await soul.revisions()).map((r) => r.revision)).toEqual([1]);
  });

  it('refuses a session-kind fragment that makes its assembly too large', async () => {
    const { soul } = await setup();
    await soul.start();
    const big = 'x'.repeat(SOUL_MAX_BYTES);
    await expect(
      soul.publish(
        [
          { id: 'base', kind: 'base', body: 'Shared.', position: 0 },
          { id: 'task', kind: 'session', sessionKind: 'task', body: big, position: 1 },
        ],
        'owner',
      ),
    ).rejects.toBeInstanceOf(SoulTooLarge);
  });

  it('refuses a SOUL over the size cap without writing anything', async () => {
    const { soul } = await setup();
    await soul.start();

    const huge = 'x'.repeat(SOUL_MAX_BYTES + 1);
    await expect(soul.edit(huge)).rejects.toBeInstanceOf(SoulTooLarge);
    expect((await soul.revisions()).map((r) => r.revision)).toEqual([1]);
    expect(await soul.current()).toEqual({ revision: 1, body: DEFAULT_SOUL });
  });

  it('refuses an empty edit', async () => {
    const { soul } = await setup();
    await soul.start();
    await expect(soul.edit('   \n ')).rejects.toBeInstanceOf(SoulEmpty);
    expect((await soul.revisions()).map((r) => r.revision)).toEqual([1]);
  });

  it('views the current revision and any pending edit together', async () => {
    const { soul, dataDir } = await setup();
    await soul.start();
    expect((await soul.view()).pending).toBeUndefined();

    await fs.writeFile(path.join(dataDir, 'SOUL.md'), 'Changed.\n', 'utf8');
    const view = await soul.view();
    expect(view.revision.revision).toBe(1);
    expect(view.pending?.proposed).toBe('Changed.');
  });
});
