import { ProviderError, ShitsujiError } from '../../domain/errors.js';
import type { Logger } from '../../ports/Logger.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent } from '../../ports/ModelProvider.js';
import { complete, type ModelResponse } from '../modelCalls.js';
import type { Capability, ModelCatalog, ModelInfo, ModelPurpose } from './ModelCatalog.js';

/** The models section of the configuration, as the router needs it. */
export interface ModelRoutingConfig {
  purposes: Partial<Record<ModelPurpose, string>>;
  fallbacks: Partial<Record<ModelPurpose, readonly string[]>>;
}

/** A chosen model: the provider to call, the model name to send, and what we know about it. */
export interface ModelBinding {
  purpose: ModelPurpose;
  ref: string;
  provider: ModelProvider;
  model: string;
  info?: ModelInfo;
}

export class NoModelAvailable extends ShitsujiError {
  override readonly name = 'NoModelAvailable';
  constructor(purpose: ModelPurpose, reason: string) {
    super('no_model', `No model for "${purpose}": ${reason}`, { purpose });
  }
}

/**
 * Strategy: callers ask for a purpose (and capabilities), never a model. Unconfigured purposes use the
 * chat model. Fallbacks are tried in order when a model lacks a needed capability or its provider
 * fails before producing output. Switching a purpose's model is a configuration change only.
 */
export class ModelRouter {
  private readonly warned = new Set<string>();

  constructor(
    private readonly providers: ReadonlyMap<string, ModelProvider>,
    private readonly config: ModelRoutingConfig,
    private readonly catalog: ModelCatalog,
    private readonly log: Logger,
  ) {}

  /** The first suitable model for a purpose. */
  select(purpose: ModelPurpose, needs: readonly Capability[] = []): ModelBinding {
    const [first] = this.candidates(purpose, needs);
    if (!first) throw this.none(purpose, needs);
    return first;
  }

  /**
   * Whether the model bound to a purpose declares a capability. An unbound purpose follows
   * `purposes.chat`, exactly as `candidates()` does. Missing capabilities count as no vision:
   * images are only sent to a model that explicitly says it can see them (S52).
   */
  supports(purpose: ModelPurpose, capability: Capability): boolean {
    const ref = this.config.purposes[purpose] ?? this.config.purposes.chat;
    if (!ref) return false;
    return this.catalog.get(ref)?.capabilities?.has(capability) ?? false;
  }

  /**
   * Whether any candidate for a purpose (the primary or one of its fallbacks) declares a capability.
   * This is the check for "can the chat purpose ever see an image", without the unknown-capability
   * warning `candidates()` emits while routing.
   */
  anySupports(purpose: ModelPurpose, capability: Capability): boolean {
    return this.refsFor(purpose).some(
      (ref) => this.catalog.get(ref)?.capabilities?.has(capability) ?? false,
    );
  }

  /** Every suitable model for a purpose, primary first, then its fallbacks. */
  candidates(purpose: ModelPurpose, needs: readonly Capability[] = []): ModelBinding[] {
    return this.refsFor(purpose)
      .map((ref) => this.bind(purpose, ref))
      .filter((b) => this.has(b, needs));
  }

  /** The primary ref for a purpose then its fallbacks; an unbound purpose follows chat. */
  private refsFor(purpose: ModelPurpose): string[] {
    const primary = this.config.purposes[purpose] ?? this.config.purposes.chat;
    const fallbacks = this.config.purposes[purpose]
      ? (this.config.fallbacks[purpose] ?? [])
      : (this.config.fallbacks.chat ?? []);
    return [...new Set([primary, ...fallbacks].filter((r): r is string => !!r))];
  }

  /**
   * Runs a request on the purpose's model, moving to the next candidate when a provider fails before
   * any output (after its own retries). Returns the response and which model answered.
   */
  async complete(
    purpose: ModelPurpose,
    request: Omit<ModelRequest, 'model'>,
    options: {
      needs?: readonly Capability[];
      signal?: AbortSignal;
      onEvent?: (event: ModelStreamEvent) => void;
    } = {},
  ): Promise<{ response: ModelResponse; binding: ModelBinding }> {
    const needs = [
      ...(options.needs ?? []),
      ...(request.tools?.length ? (['tools'] as const) : []),
    ];
    const candidates = this.candidates(purpose, needs);
    if (!candidates.length) throw this.none(purpose, needs);
    let lastError: unknown;
    for (const binding of candidates) {
      try {
        const response = await complete(
          binding.provider,
          { ...request, model: binding.model, metadata: { ...request.metadata, purpose } },
          options.signal,
          options.onEvent,
        );
        return { response, binding };
      } catch (error) {
        lastError = error;
        // Only provider failures move on; a bug or an abort is not a reason to try another model.
        if (!(error instanceof ProviderError) || options.signal?.aborted) throw error;
        if (binding !== candidates.at(-1)) {
          this.log.warn('Model failed, trying the fallback', {
            purpose,
            model: binding.ref,
            error: error.message,
          });
        }
      }
    }
    throw lastError;
  }

  private bind(purpose: ModelPurpose, ref: string): ModelBinding {
    const slash = ref.indexOf('/');
    const providerId = ref.slice(0, slash);
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new NoModelAvailable(
        purpose,
        `${ref} uses provider "${providerId}", which is not registered`,
      );
    }
    return { purpose, ref, provider, model: ref.slice(slash + 1), info: this.catalog.get(ref) };
  }

  private has(binding: ModelBinding, needs: readonly Capability[]): boolean {
    if (!needs.length) return true;
    const caps = binding.info?.capabilities;
    if (!caps) {
      if (!this.warned.has(binding.ref)) {
        this.warned.add(binding.ref);
        this.log.warn('Model capabilities unknown; add it to models.catalog', {
          model: binding.ref,
        });
      }
      // Absence is not permission for vision: an image sent to a model that cannot see it is a
      // failed call, so only the other needs keep the old permissive default (S52).
      return !needs.includes('vision');
    }
    return needs.every((n) => caps.has(n));
  }

  private none(purpose: ModelPurpose, needs: readonly Capability[]): NoModelAvailable {
    return new NoModelAvailable(
      purpose,
      needs.length
        ? `no configured model has ${needs.join(' + ')}`
        : 'set models.purposes.chat (or this purpose) in the configuration',
    );
  }
}
