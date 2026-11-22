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
    /** The API root for an HTTP provider, e.g. `https://api.deepseek.com/v1`. */
    baseUrl: z.string().url().optional(),
    /** The provider's key; wrapped in `Secret` so it never prints in a log or an error. */
    apiKey: secret.optional(),
    /** Extra request headers, e.g. an OpenRouter referer. */
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

/** The one configuration file (or its environment equivalent), validated before anything is built. */
export const shitsujiConfigSchema = z
  .object({
    /** Who the assistant serves: the name, timezone and language it uses. */
    owner: z
      .object({
        /** The name the assistant uses when it speaks about you. */
        name: z.string().min(1).default('Owner'),
        /** IANA zone, e.g. `Europe/Paris`; drives "today" and the clock injectable. */
        timezone: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
        /** BCP 47 tag, e.g. `fr-FR`; the assistant's default reply language. */
        locale: z.string().min(2).default('en'),
      })
      .strict()
      .default({}),
    /** How much is logged and in what shape; the level is the threshold. */
    logging: z
      .object({
        /** Lines below this level are dropped (debug, info, warn, error). */
        level: z.enum(LOG_LEVELS as [LogLevel, ...LogLevel[]]).default('info'),
        /** One line per record for containers, or a readable line for a terminal. */
        format: z.enum(['pretty', 'json']).default('pretty'),
      })
      .strict()
      .default({}),
    /** Where the writable data lives; one folder holds the database file, workspace and exports. */
    paths: z
      .object({
        /** Where the database, workspace, handoff folder and SOUL export live. */
        dataDir: z.string().min(1).default('~/.shitsuji/data'),
      })
      .strict()
      .default({}),
    /** The durable store; without a URL everything is in memory and a restart loses it. */
    database: z
      .object({
        /** The Postgres URL; unset uses the in-memory repositories (no durability). */
        url: secret.optional(),
      })
      .strict()
      .default({}),
    /** Providers, the model per purpose, fallbacks and what we know about each model (F03). */
    models: z
      .object({
        /** The providers this process may call, by the id a model ref starts with. */
        providers: z.record(z.string().regex(/^[A-Za-z0-9_.-]+$/), providerSchema).default({}),
        /** The model ref each purpose uses; an unset purpose follows `chat`. */
        purposes: purposeMap(modelRef).default({}),
        /** Ordered fallbacks per purpose, tried when the primary cannot serve a call. */
        fallbacks: purposeMap(z.array(modelRef)).default({}),
        /** What we know about each model. Unknown fields stay unknown; prices are never guessed. */
        catalog: z
          .record(
            modelRef,
            z
              .object({
                /** The prompt window in tokens; drives compaction when known. */
                contextWindow: z.number().int().positive().optional(),
                /** The most output tokens a request may ask for. */
                maxOutput: z.number().int().positive().optional(),
                /** What the model can do; unknown capabilities count as none for vision. */
                capabilities: z.array(z.enum(CAPABILITIES)).optional(),
                /** The price table, when the model has one; without it cost is unknown. */
                price: z
                  .object({
                    /** ISO 4217 code, e.g. `USD`. */
                    currency: z
                      .string()
                      .regex(/^[A-Z]{3}$/)
                      .default('USD'),
                    /** Price per million uncached input tokens. */
                    inputPerMTok: z.number().nonnegative(),
                    /** Price per million generated output tokens. */
                    outputPerMTok: z.number().nonnegative(),
                    /** Price per million cached input tokens; defaults to the input price. */
                    cachedInputPerMTok: z.number().nonnegative().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .default({}),
        /** How many times a model request is tried before the call fails (retries only before output). */
        retry: z
          .object({
            /** Total attempts, including the first; a retry happens only before any output. */
            maxAttempts: z.number().int().min(1).max(10).default(3),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /** Spending limits (F22, S27). Amounts are in `currency`; the period is the calendar month, UTC. */
    budget: z
      .object({
        /** The currency of the limits and the ledger; a price in another currency is unusable. */
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
        /** The standing rules; the strongest match decides for a call (deny > ask > allow). */
        rules: z
          .array(
            z
              .object({
                /** Tool name or glob (`*` any run, `?` one). */
                tool: z.string().min(1).max(200),
                /** What the rule does with a matching call: run it, ask first, or refuse it. */
                verdict: z.enum(['allow', 'ask', 'deny']),
                /** Only this target, when set; any target otherwise. */
                target: z.enum(['core', 'workspace', 'desktop', 'mcp']).optional(),
                /** The owner's words, shown in the receipt; kept short. */
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
        /** The API URL the TUI connects to; defaults to the local API. */
        apiUrl: z.string().url().optional(),
        /** The owner key the TUI presents; defaults to `<dataDir>/owner.key`. */
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
        /** Raw bytes allowed per image; bigger files become a placeholder (default 5 MiB, S52). */
        imageMaxBytes: z
          .number()
          .int()
          .min(1)
          .default(5 * 1024 * 1024),
      })
      .strict()
      .default({}),
    /** The HTTP API that the TUI (and later the web UI) uses (S24). */
    api: z
      .object({
        /** Off for a TUI-only or CLI-only run: no HTTP API, no viewer. */
        enabled: z.boolean().default(true),
        /** The interface core binds inside its container/process; 127.0.0.1 by default. */
        listen: z.string().min(1).default('127.0.0.1'),
        /** The port the API listens on inside core. */
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
            /** Path to the certificate chain, PEM. */
            cert: z.string().min(1),
            /** Path to the private key, PEM. */
            key: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    /** The transport-facing chat apps (F06): which are on, and how they reach this machine. */
    channels: z
      .object({
        /** The local webhook channel: an HTTP POST becomes a message and its reply. */
        webhook: z
          .object({
            /** The local HTTP endpoint: off when the owner uses only the TUI or Telegram. */
            enabled: z.boolean().default(true),
            /** 127.0.0.1 keeps it on this machine; Compose sets 0.0.0.0 inside the container (#34). */
            host: z.string().min(1).default('127.0.0.1'),
            /** The port the webhook listens on. */
            port: z.number().int().min(1).max(65535).default(3000),
            /** The path a POST answers on. */
            path: z.string().startsWith('/').default('/webhook'),
          })
          .strict()
          .default({}),
        /** Telegram through grammY with long polling (T1). Pair the chat with /pair first. */
        telegram: z
          .object({
            /** Off until a token is configured. */
            enabled: z.boolean().default(false),
            /** The bot token from @BotFather; required when enabled. */
            token: secret.optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /** Which tools the model gets, and the limits they run under (F05, F08). */
    tools: z
      .object({
        /** The folder the file and exec tools may use (decision Q1). Default: <dataDir>/workspace. */
        workspaceDir: z.string().min(1).optional(),
        /** The command tool's limits: whether it exists, and its time and output caps. */
        exec: z
          .object({
            /** Off gives the model no `workspace.exec`, even on a driver that can run programs. */
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
        /** The web tools: search through SearXNG, and page fetching. */
        web: z
          .object({
            /** A SearXNG instance with its JSON API enabled (decision Q2). Unset: no web.search. */
            searxngUrl: z.string().url().optional(),
            /** Whether the model may fetch pages; the fetched text is always wrapped as untrusted. */
            fetch: z
              .object({
                /** Off gives the model no `web.fetch`; `web.search` stays if SearXNG is set. */
                enabled: z.boolean().default(true),
              })
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
        /** `host` runs tools in core's process; `shitsuji` uses the Compose sandbox (X3). */
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
            /** Hosts or ranges the sandbox may reach; empty means the open public default. */
            allow: z.array(z.string().min(1)).default([]),
            /** Hosts or ranges refused before the allow list is considered. */
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
            /** How long each probe waits before treating an address as unreachable. */
            timeoutMs: z.number().int().positive().default(1_000),
            /** Off for tests and offline runs, so no probe opens a socket. */
            enabled: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    /** Which plugins to load and their per-plugin settings (F20). */
    plugins: z
      .object({
        /** A folder of plugin modules to load at start; unset loads only the built-ins. */
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

/** The validated configuration: the shape every part of core receives from the composition root. */
export type ShitsujiConfig = z.infer<typeof shitsujiConfigSchema>;
/** One configured model provider, as it appears under `models.providers`. */
export type ProviderConfig = ShitsujiConfig['models']['providers'][string];
export type { ModelPurpose } from '../../application/models/ModelCatalog.js';
