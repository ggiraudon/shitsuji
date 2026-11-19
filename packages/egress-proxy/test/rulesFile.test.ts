import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeRules, readRulesFile } from '../src/rulesFile.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-rules-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the rules file core writes (F08, S48)', () => {
  it('reads allow and deny, defaulting missing lists to empty', () => {
    const file = path.join(dir, 'rules.json');
    fs.writeFileSync(file, JSON.stringify({ allow: ['example.com'], deny: ['*.bad.test'] }));

    expect(readRulesFile(file)).toEqual({ allow: ['example.com'], deny: ['*.bad.test'] });
  });

  it('returns undefined when the file does not exist yet', () => {
    expect(readRulesFile(path.join(dir, 'missing.json'))).toBeUndefined();
  });

  it('refuses unknown keys rather than quietly widening the policy', () => {
    const file = path.join(dir, 'rules.json');
    fs.writeFileSync(file, JSON.stringify({ allow: [], deny: [], typo: true }));

    expect(() => readRulesFile(file)).toThrow();
  });

  it('merges the env and file lists without duplicates', () => {
    expect(
      mergeRules(
        { allow: ['example.com', 'env.test'], deny: ['bad.test'] },
        { allow: ['example.com', 'file.test'], deny: ['bad.test', 'worse.test'] },
      ),
    ).toEqual({
      allow: ['example.com', 'env.test', 'file.test'],
      deny: ['bad.test', 'worse.test'],
    });
  });
});
