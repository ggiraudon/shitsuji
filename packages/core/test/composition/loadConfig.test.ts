import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandConfigPaths, loadConfig } from '../../src/composition/config/loadConfig.js';
import { shitsujiConfigSchema } from '../../src/composition/config/schema.js';
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
    expect(config.channels.webhook).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 3000,
      path: '/webhook',
    });
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.channels.telegram.token).toBeUndefined();
    expect(config.models.providers).toEqual({});
    expect(config.budget).toEqual({
      currency: 'USD',
      monthlyLimit: 30,
      backgroundAllowance: 5,
      checkIn: 1,
    });
  });

  it('builds providers from API keys when the file has no models section, DeepSeek first', () => {
    const { config } = load({ DEEPSEEK_API_KEY: 'ds-key', ANTHROPIC_API_KEY: 'an-key' });
    expect(Object.keys(config.models.providers)).toEqual(['deepseek', 'anthropic']);
    expect(config.models.providers.deepseek).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(config.models.providers.deepseek!.apiKey!.reveal()).toBe('ds-key');
    expect(config.models.purposes.chat).toBe('deepseek/deepseek-flash');
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
    chat: deepseek/deepseek-flash
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

  it('reads the spending limits, with dollars by default', () => {
    writeConfig(
      'budget: { currency: EUR, monthlyLimit: 12.5, backgroundAllowance: 2, checkIn: 0.5 }',
    );
    expect(load().config.budget).toEqual({
      currency: 'EUR',
      monthlyLimit: 12.5,
      backgroundAllowance: 2,
      checkIn: 0.5,
    });
    writeConfig('budget: { monthlyLimit: -1 }');
    expect(errorOf(() => load()).message).toMatch(/budget\.monthlyLimit/);
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

describe('resolving paths a direct schema parse leaves', () => {
  it('expands ~ in dataDir and the default workspaceDir (the literal ~ folder bug)', () => {
    const parsed = shitsujiConfigSchema.parse({
      models: { providers: { fake: { kind: 'plugin' } }, purposes: { chat: 'fake/m' } },
    });
    expect(parsed.paths.dataDir).toBe('~/.shitsuji/data');

    expandConfigPaths(parsed, '/home/sam');

    expect(parsed.paths.dataDir).toBe(path.join('/home/sam', '.shitsuji/data'));
    expect(parsed.tools.workspaceDir).toBe(path.join('/home/sam', '.shitsuji/data', 'workspace'));
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

  it('turns the API off from the environment, and rejects a non-boolean', () => {
    expect(load({ SHITSUJI_API_ENABLED: 'false' }).config.api.enabled).toBe(false);
    expect(load({ SHITSUJI_API_ENABLED: 'yes' }).config.api.enabled).toBe(true);
    expect(() => load({ SHITSUJI_API_ENABLED: 'maybe' })).toThrow(/api\.enabled/);
  });

  it('reads the sandbox driver, its URL and the egress lists from the environment (S48)', () => {
    const { config } = load({
      SHITSUJI_SANDBOX_DRIVER: 'shitsuji',
      SHITSUJI_SANDBOX_URL: 'http://sandboxd-gateway:4555',
      SHITSUJI_SANDBOX_EGRESS_ALLOW: 'example.com, *.example.org',
      SHITSUJI_SANDBOX_EGRESS_DENY: 'bad.test  worse.test',
    });

    expect(config.sandbox.driver).toBe('shitsuji');
    expect(config.sandbox.url).toBe('http://sandboxd-gateway:4555');
    expect(config.sandbox.egress.allow).toEqual(['example.com', '*.example.org']);
    expect(config.sandbox.egress.deny).toEqual(['bad.test', 'worse.test']);
  });

  it('can require isolation from the environment, as Compose does (S49)', () => {
    expect(
      load({ SHITSUJI_SANDBOX_PROBES_REQUIRE_ISOLATION: 'true' }).config.sandbox.probes
        .requireIsolation,
    ).toBe(true);
    expect(
      load({ SHITSUJI_SANDBOX_PROBES_REQUIRE_ISOLATION: 'false' }).config.sandbox.probes
        .requireIsolation,
    ).toBe(false);
    expect(() => load({ SHITSUJI_SANDBOX_PROBES_REQUIRE_ISOLATION: 'maybe' })).toThrow(
      /requireIsolation/,
    );
  });

  it('reads Telegram from the environment, keeping the token secret (S32)', () => {
    const { config } = load({
      SHITSUJI_TELEGRAM_ENABLED: 'true',
      SHITSUJI_TELEGRAM_TOKEN: '123456:abc',
    });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(String(config.channels.telegram.token)).toBe('[secret]');
    expect(config.channels.telegram.token!.reveal()).toBe('123456:abc');
  });

  it('turns the header stability check off in production unless told otherwise', () => {
    expect(load({}).config.context.stabilityCheck).toBe(true);
    expect(load({ NODE_ENV: 'production' }).config.context.stabilityCheck).toBe(false);
    expect(
      load({ NODE_ENV: 'production', SHITSUJI_STABILITY_CHECK: 'true' }).config.context
        .stabilityCheck,
    ).toBe(true);
  });

  it('reads the TUI connection from the environment, keeping the key secret', () => {
    const { config } = load({
      SHITSUJI_API_URL: 'http://127.0.0.1:3001',
      SHITSUJI_OWNER_KEY: 'shk_x',
    });
    expect(config.tui.apiUrl).toBe('http://127.0.0.1:3001');
    expect(String(config.tui.ownerKey)).toBe('[secret]');
    expect(config.tui.ownerKey!.reveal()).toBe('shk_x');
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

describe('trust.rules (#58)', () => {
  it('keeps only the rules the config lists; the shipped ones come from the engine (X4)', () => {
    const { config } = load();

    // `trust.rules` is the owner's list; composition adds the shipped rules, so an owner's own list
    // does not lose them.
    expect(config.trust.rules).toEqual([]);
  });

  it('reads rules and validates their verdict, tool and target', () => {
    writeConfig(
      [
        'trust:',
        '  rules:',
        '    - { tool: test.notify, verdict: ask, detail: always ask before notifying }',
        "    - { tool: 'web.*', verdict: allow, target: core }",
      ].join('\n'),
    );
    const { config } = load();
    expect(config.trust.rules).toEqual([
      { tool: 'test.notify', verdict: 'ask', detail: 'always ask before notifying' },
      { tool: 'web.*', verdict: 'allow', target: 'core' },
    ]);

    writeConfig('trust:\n  rules:\n    - { tool: x, verdict: maybe }\n');
    expect(errorOf(() => load()).message).toMatch(/verdict/);

    writeConfig('trust:\n  rules:\n    - { tool: "", verdict: ask }\n');
    expect(errorOf(() => load()).message).toMatch(/tool/);

    writeConfig('trust:\n  rules:\n    - { tool: x, verdict: ask, target: cloud }\n');
    expect(errorOf(() => load()).message).toMatch(/target/);
  });
});
