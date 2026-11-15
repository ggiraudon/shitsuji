import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/composition/config/loadConfig.js';
import { ConfigError } from '../../src/domain/errors.js';
import { Secret } from '../../src/domain/Secret.js';

let dir: string;
const home = path.join(os.tmpdir(), 'fake-home');
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shitsuji-config-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeConfig = (yaml: string) => {
  const file = path.join(dir, 'shitsuji.config.yaml');
  fs.writeFileSync(file, yaml);
  return file;
};
const load = (env: Record<string, string> = {}) => loadConfig({ env, cwd: dir, homeDir: home });
const errorOf = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
};

describe('loadConfig defaults', () => {
  it('works with no file and no environment', () => {
    const { config, source } = load();
    expect(source).toBeUndefined();
    expect(config.logging).toEqual({ level: 'info', format: 'pretty' });
    expect(config.paths.dataDir).toBe(path.join(home, '.shitsuji/data'));
    expect(config.channels.webhook).toEqual({ enabled: true, port: 3000, path: '/webhook' });
    expect(config.models.providers).toEqual({});
  });

  it('builds providers from API keys when the file has no models section, DeepSeek first', () => {
    const { config } = load({ DEEPSEEK_API_KEY: 'ds-key', ANTHROPIC_API_KEY: 'an-key' });
    expect(Object.keys(config.models.providers)).toEqual(['deepseek', 'anthropic']);
    expect(config.models.providers.deepseek).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(config.models.providers.deepseek!.apiKey!.reveal()).toBe('ds-key');
    expect(config.models.purposes.chat).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('keeps the old OpenAI fallback when it is the only key', () => {
    const { config } = load({ OPENAI_API_KEY: 'sk' });
    expect(config.models.purposes.chat).toBe('openai/gpt-4o-mini');
  });
});

describe('loadConfig from a file', () => {
  it('reads values, interpolates ${VAR} and ${VAR:-default}, and drops unset optional values', () => {
    writeConfig(`
owner: { name: Guillaume, timezone: Europe/Paris }
models:
  providers:
    deepseek: { kind: openai-compatible, baseUrl: "\${DS_URL:-https://api.deepseek.com/v1}", apiKey: "\${DEEPSEEK_API_KEY}" }
    local: { kind: openai-compatible, baseUrl: "http://\${OLLAMA_HOST:-ollama}:11434/v1", apiKey: "\${OLLAMA_KEY}" }
  purposes:
    chat: deepseek/deepseek-v4.1-flash
    classify: local/qwen3:4b
`);
    const { config, source } = load({ DEEPSEEK_API_KEY: 'k1' });
    expect(source).toBe(path.join(dir, 'shitsuji.config.yaml'));
    expect(config.owner).toMatchObject({ name: 'Guillaume', timezone: 'Europe/Paris' });
    expect(config.models.providers.deepseek!.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(config.models.providers.deepseek!.apiKey!.reveal()).toBe('k1');
    expect(config.models.providers.local!.baseUrl).toBe('http://ollama:11434/v1');
    expect(config.models.providers.local!.apiKey).toBeUndefined();
    expect(config.models.purposes.classify).toBe('local/qwen3:4b');
  });

  it('fails clearly when a variable inside a longer string is not set', () => {
    writeConfig(
      `models: { providers: { x: { kind: openai-compatible, baseUrl: "http://\${HOST}/v1" } } }`,
    );
    expect(errorOf(() => load()).message).toMatch(
      /models\.providers\.x\.baseUrl uses \$\{HOST\}, which is not set/,
    );
  });

  it('uses SHITSUJI_CONFIG to find the file', () => {
    const file = path.join(dir, 'other.yaml');
    fs.writeFileSync(file, 'logging: { level: debug }');
    expect(load({ SHITSUJI_CONFIG: file }).config.logging.level).toBe('debug');
  });

  it('fails when an explicit file does not exist', () => {
    expect(errorOf(() => load({ SHITSUJI_CONFIG: 'missing.yaml' })).message).toMatch(
      /Config file not found/,
    );
  });
});

describe('environment overrides', () => {
  it('override file values', () => {
    writeConfig('logging: { level: warn }\nchannels: { webhook: { port: 4000 } }');
    const { config } = load({
      LOG_LEVEL: 'debug',
      SHITSUJI_DATA_DIR: '/srv/shitsuji',
      SHITSUJI_WEBHOOK_PORT: '8080',
      DATABASE_URL: 'postgres://u:p@db/shitsuji',
    });
    expect(config.logging.level).toBe('debug');
    expect(config.paths.dataDir).toBe('/srv/shitsuji');
    expect(config.channels.webhook.port).toBe(8080);
    expect(config.database.url!.reveal()).toBe('postgres://u:p@db/shitsuji');
  });
});

describe('invalid configuration', () => {
  it('lists every shape problem by path', () => {
    writeConfig(`
logging: { level: loud }
channels: { webhook: { port: 70000 } }
models:
  providers: { x: { kind: openai-compatible } }
  purposes: { task: no-slash }
`);
    const error = errorOf(() => load());
    expect(error.code).toBe('config_invalid');
    expect(error.details.problems).toHaveLength(3);
    expect(error.message).toContain('logging.level');
    expect(error.message).toContain('channels.webhook.port');
    expect(error.message).toContain('models.purposes.task must look like "provider/model"');
  });

  // Cross-field checks run once the shape is valid (zod skips refinements on invalid data).
  it('lists every cross-field problem by path', () => {
    writeConfig(`
models:
  providers:
    claude: { kind: anthropic }
  purposes:
    chat: missing/model
  fallbacks:
    chat: [claude/claude-x, gone/model]
`);
    const error = errorOf(() => load());
    expect(error.message).toContain('models.providers.claude.apiKey is required');
    expect(error.message).toContain('models.purposes.chat refers to provider "missing"');
    expect(error.message).toContain('models.fallbacks.chat.1 refers to provider "gone"');
  });

  it('rejects unknown keys, so typos do not pass silently', () => {
    writeConfig('loging: { level: debug }');
    expect(errorOf(() => load()).message).toMatch(/Unrecognized key.*loging/);
  });

  it('rejects a file that is not a mapping, and unparsable YAML', () => {
    writeConfig('- a\n- b');
    expect(errorOf(() => load()).message).toMatch(/mapping at the top level/);
    writeConfig('a: [unclosed');
    expect(errorOf(() => load()).message).toMatch(/Cannot read config file/);
  });
});

describe('Secret', () => {
  it('never shows its value except through reveal()', () => {
    const { config } = load({ DEEPSEEK_API_KEY: 'super-secret-value' });
    const key = config.models.providers.deepseek!.apiKey!;
    expect(key).toBeInstanceOf(Secret);
    for (const shown of [
      String(key),
      `${key}`,
      JSON.stringify(config),
      inspect(config, { depth: 10 }),
      'key: ' + key,
    ]) {
      expect(shown).not.toContain('super-secret-value');
    }
    expect(JSON.stringify({ key })).toBe('{"key":"[secret]"}');
    expect(key.reveal()).toBe('super-secret-value');
  });
});
