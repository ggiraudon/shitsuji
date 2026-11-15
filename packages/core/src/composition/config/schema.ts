import { z } from 'zod';
import { Secret } from '../../domain/Secret.js';
import { LOG_LEVELS, type LogLevel } from '../../ports/Logger.js';

export const MODEL_PURPOSES = [
  'chat',
  'task',
  'helper',
  'classify',
  'summarize',
  'vision',
  'embed',
  'trust',
] as const;

const secret = z
  .string()
  .min(1)
  .transform((raw) => new Secret(raw));

/** "provider/model", e.g. "deepseek/deepseek-v4.1-flash". The model part may itself contain slashes. */
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
      })
      .strict()
      .default({}),
    channels: z
      .object({
        cli: z
          .object({ enabled: z.boolean().default(true) })
          .strict()
          .default({}),
        webhook: z
          .object({
            enabled: z.boolean().default(true),
            port: z.number().int().min(1).max(65535).default(3000),
            path: z.string().startsWith('/').default('/webhook'),
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
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];
