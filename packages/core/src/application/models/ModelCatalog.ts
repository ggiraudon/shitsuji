import type { Money } from '../../domain/model/Money.js';
import type { TokenUsage } from '../../ports/ModelProvider.js';

/** The routing purposes as a value list, for config validation; keep it in step with `ModelPurpose`. */
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
/** What a model call is for; callers ask for a purpose, never a model (F03). */
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

/** The capabilities a model may advertise, for routing and for the vision gate (S52). */
export const CAPABILITIES = [
  'tools',
  'vision',
  'reasoning',
  'json_mode',
  'embeddings',
  'audio',
] as const;
/** One capability of `CAPABILITIES`; an unknown capability is never assumed. */
export type Capability = (typeof CAPABILITIES)[number];

/** What one model costs, per million tokens, in one currency. */
export interface ModelPrice {
  /** Price of uncached input. */
  inputPerMTok: Money;
  /** Price of generated output. */
  outputPerMTok: Money;
  /** Price for input served from the prompt cache; defaults to the input price. */
  cachedInputPerMTok?: Money;
}

/** What we know about one model. Anything missing is unknown, not assumed. */
export interface ModelInfo {
  /** "provider/model". */
  ref: string;
  /** The prompt window, in tokens; drives compaction when known. */
  contextWindow?: number;
  /** The most output tokens a request may ask for. */
  maxOutput?: number;
  /** Undefined when nobody has said; then capability checks are skipped (with a warning). */
  capabilities?: ReadonlySet<Capability>;
  /** The price table used for the usage rows; absent means cost is unknown. */
  price?: ModelPrice;
}

/** Models known from the configuration (models.catalog). */
export class ModelCatalog {
  /** The known models by ref, as built; the catalogue is immutable after construction. */
  private readonly byRef: ReadonlyMap<string, ModelInfo>;

  constructor(
    /** What the config declared; a ref repeated later in the list wins. */
    models: readonly ModelInfo[] = [],
  ) {
    this.byRef = new Map(models.map((m) => [m.ref, m]));
  }

  /** What is known about a ref, or undefined when it is not in the catalogue. */
  get(ref: string): ModelInfo | undefined {
    return this.byRef.get(ref);
  }

  /**
   * The cost of one call, or undefined if the model has no price. Cached input is charged at the
   * cached price; the rest of the input at the normal price.
   */
  cost(ref: string, usage: TokenUsage): Money | undefined {
    const price = this.byRef.get(ref)?.price;
    if (!price) return undefined;
    const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
    const fresh = usage.inputTokens - cached;
    return price.inputPerMTok
      .times(fresh / 1_000_000)
      .plus((price.cachedInputPerMTok ?? price.inputPerMTok).times(cached / 1_000_000))
      .plus(price.outputPerMTok.times(usage.outputTokens / 1_000_000));
  }
}
