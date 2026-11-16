import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HandoffStore, safeName } from '../../../src/adapters/files/HandoffStore.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = path.join(os.tmpdir(), `shitsuji-handoff-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('HandoffStore (S33)', () => {
  it('stores a file with a safe name in the handoff folder', async () => {
    const dir = tempDir();
    const store = new HandoffStore(dir);

    const saved = await store.save('../../private/report.pdf', new Uint8Array([1, 2, 3]));

    expect(saved.name).toBe('report.pdf');
    expect(saved.path).toBe(path.join(dir, 'report.pdf'));
    expect(saved.size).toBe(3);
    expect(await fs.readFile(saved.path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('never overwrites: a second file gets a suffix', async () => {
    const store = new HandoffStore(tempDir());

    const first = await store.save('photo.jpg', new Uint8Array([1]));
    const second = await store.save('photo.jpg', new Uint8Array([2]));

    expect(first.name).toBe('photo.jpg');
    expect(second.name).toBe('photo-1.jpg');
    expect(second.path).not.toBe(first.path);
  });

  it('makes odd names safe and keeps an empty name usable', async () => {
    expect(safeName('a<b>c:d.pdf')).toBe('a_b_c_d.pdf');
    expect(safeName('...hidden')).toBe('hidden');
    expect(safeName('')).toBe('file');
    expect(safeName('..')).toBe('file');
  });
});
