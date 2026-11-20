import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EgressRulesFile } from '../../../src/adapters/sandbox/EgressRulesFile.js';
import { SandboxTokenFile } from '../../../src/adapters/sandbox/shitsuji/SandboxTokenFile.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-sandbox-files-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the token core shares with sandboxd (F08, S48)', () => {
  it('generates 32 random bytes once and keeps the same token afterwards', () => {
    const file = path.join(dir, 'sandbox.token');

    const first = new SandboxTokenFile(file).readOrCreate().reveal();
    const second = new SandboxTokenFile(file).readOrCreate().reveal();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it('fills an empty file (a fresh volume seeds one) and keeps its inode', () => {
    const file = path.join(dir, 'sandbox.token');
    fs.writeFileSync(file, '');

    const token = new SandboxTokenFile(file).readOrCreate().reveal();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(file).size).toBe(64);
  });
});

describe('the egress rules file (F08, S48)', () => {
  it('writes the allow and deny lists where the proxy reads them', () => {
    const file = path.join(dir, 'sandbox.egress.json');

    new EgressRulesFile(file).write({
      allow: ['example.com', '*.example.org'],
      deny: ['bad.test'],
    });

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      allow: ['example.com', '*.example.org'],
      deny: ['bad.test'],
      ready: true,
    });
  });
});
