import { z } from 'zod';
import { Secret } from '../../domain/Secret.js';
import { LOG_LEVELS, type LogLevel } from '../../ports/Logger.js';

import { CAPABILITIES, MODEL_PURPOSES } from '../../application/models/ModelCatalog.js';

export { MODEL_PURPOSES };

const secret = z
  .string()
  .min(1)
  .transform((raw) => new Secret(raw));

/** "provider/model", e.g. "deepseek/deepseek-flash". The model part may itself contain slashes. */
const modelRef = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/.+$/, 'must look like "provider/model", e.g. "deepseek/deepseek-chat"');

const providerSchema = z
  .object({
    /** 'plugin': registered by a plugin under this id; the core only checks that one did. */
    kind: z.enum(['openai-compatible', 'anthropic', 'plugin']),
    baseUrl: z.string().url().optional(),
    apiKey: secret.optional(),
    headers: z.record(z.string()).default({}),
    /** Endpoint differences (tool-call style, system role…); validated by the adapter in F03. */
    quirks: z.record(z.unknown()).default({}),
  })
  .strict();

const purposeMap = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object(
      Object.fromEntries(MODEL_PURPOSES.map((p) => [p, value.optional()])) as {
        [K in (typeof MODEL_PURPOSES)[number]]: z.ZodOptional<T>;
      },
    )
    .strict();

export const shitsujiConfigSchema = z
  .object({
    owner: z
      .object({
        name: z.string().min(1).default('Owner'),
        timezone: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
        locale: z.string().min(2).default('en'),
      })
      .strict()
      .default({}),
    logging: z
      .object({
        level: z.enum(LOG_LEVELS as [LogLevel, ...LogLevel[]]).default('info'),
        format: z.enum(['pretty', 'json']).default('pretty'),
      })
      .strict()
      .default({}),
    paths: z
      .object({
        dataDir: z.string().min(1).default('~/.shitsuji/data'),
      })
      .strict()
      .default({}),
    database: z
      .object({
        url: secret.optional(),
      })
      .strict()
      .default({}),
    models: z
      .object({
        providers: z.record(z.string().regex(/^[A-Za-z0-9_.-]+$/), providerSchema).default({}),
        purposes: purposeMap(modelRef).default({}),
        fallbacks: purposeMap(z.array(modelRef)).default({}),
        /** What we know about each model. Unknown fields stay unknown; prices are never guessed. */
        catalog: z
          .record(
            modelRef,
            z
              .object({
                contextWindow: z.number().int().positive().optional(),
                maxOutput: z.number().int().positive().optional(),
                capabilities: z.array(z.enum(CAPABILITIES)).optional(),
                price: z
                  .object({
                    currency: z
                      .string()
                      .regex(/^[A-Z]{3}$/)
                      .default('USD'),
                    inputPerMTok: z.number().nonnegative(),
                    outputPerMTok: z.number().nonnegative(),
                    cachedInputPerMTok: z.number().nonnegative().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .default({}),
        retry: z
          .object({ maxAttempts: z.number().int().min(1).max(10).default(3) })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /** Spending limits (F22, S27). Amounts are in `currency`; the period is the calendar month, UTC. */
    budget: z
      .object({
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/, 'must be a three-letter currency code such as USD')
          .default('USD'),
        /** Past the monthly limit only your own messages run; background turns are refused. */
        monthlyLimit: z.number().nonnegative().default(30),
        /** What background work (no owner message) may spend per month. */
        backgroundAllowance: z.number().nonnegative().default(5),
        /** A session pauses to ask when it has spent this much since your last message (S28). */
        checkIn: z.number().nonnegative().default(1),
      })
      .strict()
      .default({}),
    /**
     * Standing rules for trust (F11, #58). A rule vetoes or forces a question for the tools it matches,
     * before the judge; `payment` still always asks (P6). `detail` is the owner's words, shown in the
     * receipt.
     */
    trust: z
      .object({
        rules: z
          .array(
            z
              .object({
                /** Tool name or glob (`*` any run, `?` one). */
                tool: z.string().min(1).max(200),
                verdict: z.enum(['allow', 'ask', 'deny']),
                target: z.enum(['core', 'workspace', 'desktop', 'mcp']).optional(),
                detail: z.string().min(1).max(200).optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({}),
    /** How the TUI finds core (S25). The key defaults to <dataDir>/owner.key on this machine. */
    tui: z
      .object({
        apiUrl: z.string().url().optional(),
        ownerKey: secret.optional(),
      })
      .strict()
      .default({}),
    /** How each model call's context is built (F04, S23). */
    context: z
      .object({
        /**
         * Warn when a header injectable changes on every call. Defaults to on, except when NODE_ENV is
         * production (decided in loadConfig).
         */
        stabilityCheck: z.boolean().optional(),
        /** How many of the newest images stay pixels; older ones become placeholders (S52). */
        imageHistoryLimit: z.number().int().min(0).default(3),
      })
      .strict()
      .default({}),
    /** The HTTP API that the TUI (and later the web UI) uses (S24). */
    api: z
      .object({
        enabled: z.boolean().default(true),
        /** The interface core binds inside its container/process; 127.0.0.1 by default. */
        listen: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(0).max(65535).default(3001),
        /** The host address Docker publishes: what the owner actually reaches (Y2). */
        publishedHost: z.string().min(1).optional(),
        /** The host port Docker publishes; defaults to `port`. */
        publishedPort: z.number().int().min(1).max(65535).optional(),
        /** Absolute link base for the viewer and other links core sends; overrides the defaults. */
        publicUrl: z.string().url().optional(),
        /** Optional TLS for the API and the viewer; both files must be set (Y2). */
        tls: z
          .object({
            cert: z.string().min(1),
            key: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    channels: z
      .object({
        webhook: z
          .object({
            enabled: z.boolean().default(true),
            /** 127.0.0.1 keeps it on this machine; Compose sets 0.0.0.0 inside the container (#34). */
            host: z.string().min(1).default('127.0.0.1'),
            port: z.number().int().min(1).max(65535).default(3000),
            path: z.string().startsWith('/').default('/webhook'),
          })
          .strict()
          .default({}),
        /** Telegram through grammY with long polling (T1). Pair the chat with /pair first. */
        telegram: z
          .object({
            enabled: z.boolean().default(false),
            /** The bot token from @BotFather; required when enabled. */
            token: secret.optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    tools: z
      .object({
        /** The folder the file and exec tools may use (decision Q1). Default: <dataDir>/workspace. */
        workspaceDir: z.string().min(1).optional(),
        exec: z
          .object({
            enabled: z.boolean().default(true),
            /** Ten minutes: long enough for a build or an install. */
            defaultTimeoutSeconds: z.number().int().positive().default(600),
            /** An hour; a driver may cap this further with its `maxTimeoutMs`. */
            maxTimeoutSeconds: z.number().int().positive().default(3_600),
            /** 1 MiB: over it the model sees head and tail, and the full log goes to the session folder. */
            maxOutputBytes: z.number().int().positive().default(1_048_576),
          })
          .strict()
          .default({}),
        web: z
          .object({
            /** A SearXNG instance with its JSON API enabled (decision Q2). Unset: no web.search. */
            searxngUrl: z.string().url().optional(),
            fetch: z
              .object({ enabled: z.boolean().default(true) })
              .strict()
              .default({}),
          })
          .strict()
          .default({}),
        /** Where `test.notify` posts (a local mock service, F11/S36). Unset: no test tool. */
        notifyUrl: z.string().url().optional(),
      })
      .strict()
      .default({}),
    /**
     * Where commands and files run (F08, decisions W1–W6, X3). `host` is today's behaviour: the core
     * process itself. A driver that cannot start leaves no sandbox tools rather than falling back.
     */
    sandbox: z
      .object({
        driver: z.enum(['host', 'opensandbox', 'shitsuji']).default('host'),
        /** The sandboxd service the `shitsuji` driver calls (S48); compose points this at its relay. */
        url: z.string().url().default('http://127.0.0.1:4555'),
        /**
         * Where core keeps the token it generates for sandboxd (S48). Compose mounts the same file
         * read-only at `/run/sandbox/token`; nothing in a command can read it.
         */
        tokenFile: z.string().optional(),
        /**
         * What the egress-proxy may let out (X7). Core writes them to `egress.file` at startup, so
         * the proxy follows this file instead of the owner hand-editing `.env`.
         */
        egress: z
          .object({
            allow: z.array(z.string().min(1)).default([]),
            deny: z.array(z.string().min(1)).default([]),
            /** Where core writes the rules the proxy reads; defaults to `<dataDir>/sandbox.egress.json`. */
            file: z.string().optional(),
          })
          .strict()
          .default({}),
        /** What the egress check tries from inside the sandbox (F08, S42; X2). */
        probes: z
          .object({
            /** Addresses on your LAN; `host` or `host:port`, port 80 when it is not given. */
            lan: z.array(z.string().min(1)).default(['192.168.1.1']),
            /** Refuse a driver that makes no isolation claim yet can reach something. */
            requireIsolation: z.boolean().default(false),
            timeoutMs: z.number().int().positive().default(1_000),
            /** Off for tests and offline runs, so no probe opens a socket. */
            enabled: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    plugins: z
      .object({
        directory: z.string().optional(),
        /** Each plugin's own settings, keyed by plugin id; passed to it as ctx.config. */
        settings: z.record(z.record(z.unknown())).default({}),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const providers = config.models.providers;
    for (const [id, provider] of Object.entries(providers)) {
      if (provider.kind === 'anthropic' && !provider.apiKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', 'providers', id, 'apiKey'],
          message: 'is required for an anthropic provider',
        });
      }
    }
    const refs: [string[], string][] = [];
    for (const [purpose, ref] of Object.entries(config.models.purposes)) {
      if (ref) refs.push([['models', 'purposes', purpose], ref]);
    }
    for (const [purpose, list] of Object.entries(config.models.fallbacks)) {
      list?.forEach((ref, i) => refs.push([['models', 'fallbacks', purpose, String(i)], ref]));
    }
    for (const [path, ref] of refs) {
      const providerId = ref.split('/')[0]!;
      if (!(providerId in providers)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `refers to provider "${providerId}", which is not in models.providers`,
        });
      }
    }
  });

export type ShitsujiConfig = z.infer<typeof shitsujiConfigSchema>;
export type ProviderConfig = ShitsujiConfig['models']['providers'][string];
export type { ModelPurpose } from '../../application/models/ModelCatalog.js';
