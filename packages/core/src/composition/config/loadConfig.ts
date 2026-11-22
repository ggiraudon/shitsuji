import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../../domain/errors.js';
import { shitsujiConfigSchema, type ShitsujiConfig } from './schema.js';

/** The environment a load reads: the process environment, or a test's stand-in. */
export type Env = Record<string, string | undefined>;

/** What `loadConfig` may be given; every field has a production default. */
export interface LoadConfigOptions {
  /** Environment variables. Defaults to process.env. This module is the only reader of process.env. */
  env?: Env;
  /** Explicit config file. Otherwise SHITSUJI_CONFIG, then ./shitsuji.config.yaml if it exists. */
  file?: string;
  /** The folder a relative `file` resolves against; the process cwd by default. */
  cwd?: string;
  /** The home folder `~` expands to; the OS home by default. */
  homeDir?: string;
}

/** The configuration and where it came from, for the startup log. */
export interface LoadedConfig {
  /** The validated configuration. */
  config: ShitsujiConfig;
  /** The file that was read, if any. */
  source?: string;
}

/** Environment variables that override a config value directly, without editing the file. */
const ENV_OVERRIDES: { vars: string[]; path: string[]; parse?: (v: string) => unknown }[] = [
  { vars: ['SHITSUJI_LOG_LEVEL', 'LOG_LEVEL'], path: ['logging', 'level'] },
  { vars: ['SHITSUJI_LOG_FORMAT'], path: ['logging', 'format'] },
  { vars: ['SHITSUJI_DATA_DIR', 'DATA_DIR'], path: ['paths', 'dataDir'] },
  { vars: ['DATABASE_URL'], path: ['database', 'url'] },
  { vars: ['SHITSUJI_WEBHOOK_HOST'], path: ['channels', 'webhook', 'host'] },
  { vars: ['SHITSUJI_WEBHOOK_PORT'], path: ['channels', 'webhook', 'port'], parse: Number },
  {
    vars: ['SHITSUJI_TELEGRAM_ENABLED'],
    path: ['channels', 'telegram', 'enabled'],
    parse: parseBool,
  },
  { vars: ['SHITSUJI_TELEGRAM_TOKEN'], path: ['channels', 'telegram', 'token'] },
  { vars: ['SHITSUJI_API_BIND', 'SHITSUJI_API_HOST'], path: ['api', 'listen'] },
  { vars: ['SHITSUJI_API_PORT'], path: ['api', 'port'], parse: Number },
  { vars: ['SHITSUJI_API_PUBLISHED'], path: ['api', 'publishedHost'] },
  { vars: ['SHITSUJI_API_PUBLISHED_PORT'], path: ['api', 'publishedPort'], parse: Number },
  { vars: ['SHITSUJI_PUBLIC_URL'], path: ['api', 'publicUrl'] },
  { vars: ['SHITSUJI_API_TLS_CERT'], path: ['api', 'tls', 'cert'] },
  { vars: ['SHITSUJI_API_TLS_KEY'], path: ['api', 'tls', 'key'] },
  { vars: ['SHITSUJI_SEARXNG_URL'], path: ['tools', 'web', 'searxngUrl'] },
  { vars: ['SHITSUJI_API_ENABLED'], path: ['api', 'enabled'], parse: parseBool },
  { vars: ['SHITSUJI_API_URL'], path: ['tui', 'apiUrl'] },
  { vars: ['SHITSUJI_SANDBOX_DRIVER'], path: ['sandbox', 'driver'] },
  { vars: ['SHITSUJI_SANDBOX_URL'], path: ['sandbox', 'url'] },
  { vars: ['SHITSUJI_SANDBOX_TOKEN_FILE'], path: ['sandbox', 'tokenFile'] },
  {
    vars: ['SHITSUJI_SANDBOX_EGRESS_ALLOW'],
    path: ['sandbox', 'egress', 'allow'],
    parse: parseList,
  },
  {
    vars: ['SHITSUJI_SANDBOX_EGRESS_DENY'],
    path: ['sandbox', 'egress', 'deny'],
    parse: parseList,
  },
  {
    vars: ['SHITSUJI_SANDBOX_PROBES_REQUIRE_ISOLATION'],
    path: ['sandbox', 'probes', 'requireIsolation'],
    parse: parseBool,
  },
  { vars: ['SHITSUJI_OWNER_KEY'], path: ['tui', 'ownerKey'] },
  {
    vars: ['SHITSUJI_STABILITY_CHECK'],
    path: ['context', 'stabilityCheck'],
    parse: parseBool,
  },
];

/**
 * Reads, interpolates and validates the configuration. Throws ConfigError with every problem listed
 * by its path, so a bad config fails at startup with a clear message.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();

  const source = findConfigFile(options.file ?? env.SHITSUJI_CONFIG, cwd);
  let raw: Record<string, unknown> = {};
  if (source) {
    raw = readYaml(source);
  }
  raw = interpolate(raw, env, []) as Record<string, unknown>;
  if (!hasModels(raw)) raw = { ...raw, models: modelsFromEnv(env) };
  for (const override of ENV_OVERRIDES) {
    const name = override.vars.find((v) => env[v] !== undefined && env[v] !== '');
    if (name) setPath(raw, override.path, (override.parse ?? String)(env[name]!));
  }

  const parsed = shitsujiConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`);
    throw new ConfigError(
      `Invalid configuration${source ? ` in ${source}` : ''}:\n  - ${problems.join('\n  - ')}`,
      { source, problems },
    );
  }
  const config = parsed.data;
  config.context.stabilityCheck ??= env.NODE_ENV !== 'production';
  expandConfigPaths(config, homeDir);
  return { config, source };
}

/**
 * Expands `~` in the paths the process may write. `loadConfig` calls this with its `homeDir`;
 * `createShitsuji` calls it too, because a config parsed directly with `shitsujiConfigSchema` (a
 * test, a plugin, an embedding) still carries the schema's `~/.shitsuji/data` default. Without the
 * second call, the egress-rules write would create a literal `~` folder under the cwd.
 */
export function expandConfigPaths(config: ShitsujiConfig, homeDir: string = os.homedir()): void {
  config.paths.dataDir = expandHome(config.paths.dataDir, homeDir);
  config.tools.workspaceDir = expandHome(
    config.tools.workspaceDir ?? path.join(config.paths.dataDir, 'workspace'),
    homeDir,
  );
  if (config.plugins.directory) {
    config.plugins.directory = expandHome(config.plugins.directory, homeDir);
  }
  if (config.api.tls) {
    config.api.tls.cert = expandHome(config.api.tls.cert, homeDir);
    config.api.tls.key = expandHome(config.api.tls.key, homeDir);
  }
}

function findConfigFile(explicit: string | undefined, cwd: string): string | undefined {
  if (explicit) {
    const file = path.resolve(cwd, explicit);
    if (!fs.existsSync(file)) throw new ConfigError(`Config file not found: ${file}`, { file });
    return file;
  }
  const fallback = path.join(cwd, 'shitsuji.config.yaml');
  return fs.existsSync(fallback) ? fallback : undefined;
}

function readYaml(file: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `Cannot read config file ${file}: ${(error as Error).message}`,
      { file },
      {
        cause: error,
      },
    );
  }
  if (data == null) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError(`Config file ${file} must contain a mapping at the top level`, { file });
  }
  return data as Record<string, unknown>;
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces ${VAR} and ${VAR:-default} in string values. A value that is exactly one unset ${VAR}
 * (with no default) is removed, so optional keys such as apiKey stay unset rather than empty.
 */
function interpolate(value: unknown, env: Env, at: string[]): unknown {
  if (typeof value === 'string') {
    const whole = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (whole && (env[whole[1]!] === undefined || env[whole[1]!] === '')) return undefined;
    return value.replace(VAR, (_m, name: string, fallback?: string) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${at.join('.')} uses \${${name}}, which is not set`, {
        variable: name,
      });
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, [...at, String(i)]));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = interpolate(v, env, [...at, k]);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

function hasModels(raw: Record<string, unknown>): boolean {
  const models = raw.models as Record<string, unknown> | undefined;
  return !!models && Object.keys((models.providers as object | undefined) ?? {}).length > 0;
}

/**
 * Without a models section, providers come from whichever API keys are set, so a bare .env works.
 * DeepSeek first (the decided default, 05-open-questions M1), then OpenAI, then Anthropic.
 */
function modelsFromEnv(env: Env): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  let chat: string | undefined;
  const add = (id: string, key: string | undefined, entry: object, model: string) => {
    if (!key) return;
    providers[id] = { ...entry, apiKey: key };
    chat ??= `${id}/${model}`;
  };
  add(
    'deepseek',
    env.DEEPSEEK_API_KEY,
    { kind: 'openai-compatible', baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1' },
    'deepseek-flash',
  );
  add(
    'openai',
    env.OPENAI_API_KEY,
    { kind: 'openai-compatible', ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}) },
    'gpt-4o-mini',
  );
  add('anthropic', env.ANTHROPIC_API_KEY, { kind: 'anthropic' }, 'claude-3-5-sonnet-20241022');
  return chat ? { providers, purposes: { chat, task: chat } } : {};
}

/** "true"/"false" (also 1/0, yes/no); anything else is left as text so the schema reports it. */
function parseBool(v: string): unknown {
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return v;
}

/** A comma- or whitespace-separated list (`SANDBOX_EGRESS_ALLOW=example.com,*.example.org`). */
function parseList(v: string): string[] {
  return v
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function setPath(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}

function expandHome(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir, p.slice(2));
  return p;
}
