import { ProviderError, serializeError } from '../../domain/errors.js';
import type { OwnerId, SessionId, TurnId } from '../../domain/model/ids.js';
import type { Clock } from '../../ports/Clock.js';
import type { Logger } from '../../ports/Logger.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  TokenUsage,
} from '../../ports/ModelProvider.js';
import type { UsageRepository } from '../../ports/Repositories.js';
import type { ModelCatalog } from './ModelCatalog.js';

/** Base for decorators: forwards everything to the wrapped provider. */
abstract class ModelProviderDecorator implements ModelProvider {
  constructor(
    /** The provider a decorator wraps; the chain ends at a real adapter. */
    protected readonly inner: ModelProvider,
  ) {}
  /** The wrapped provider's id, so a decorated provider is still addressed the same way. */
  get id(): string {
    return this.inner.id;
  }
  /** Lists models through the wrapped provider; decorators do not filter the list. */
  listModels(signal?: AbortSignal): Promise<string[]> {
    return this.inner.listModels(signal);
  }
  /** Decorators change the stream, so each one implements it. */
  abstract stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

/** How the retry decorator behaves: attempts, backoff, and the logger and sleep it uses. */
export interface RetryOptions {
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** First wait in ms; doubles each time. A Retry-After from the provider wins if longer. */
  baseDelayMs?: number;
  /** The longest wait between attempts; a provider hint beyond it is clipped to it. */
  maxDelayMs?: number;
  /** Structured logger, for every retry. */
  log: Logger;
  /** The wait implementation, injectable so a test does not sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/**
 * Retries transient failures (connection reset, 429, 5xx) only before the stream has produced
 * anything. Once any event has been passed on (above all a tool call) a failure is final, so an
 * action is never requested twice (F03, from nod).
 */
export class RetryingModelProvider extends ModelProviderDecorator {
  /** The total attempts allowed, first one included; three by default. */
  private readonly maxAttempts: number;
  /** The first backoff, doubled per attempt; 500 ms by default. */
  private readonly baseDelayMs: number;
  /** The backoff ceiling; 30 s by default. */
  private readonly maxDelayMs: number;
  /** The wait implementation; a test passes one that returns at once. */
  private readonly sleep: NonNullable<RetryOptions['sleep']>;

  constructor(
    /** The provider whose transient failures are retried. */
    inner: ModelProvider,
    /** The retry policy and logger. */
    private readonly options: RetryOptions,
  ) {
    super(inner);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Streams the inner response, retrying only a retryable failure before anything was emitted. */
  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    for (let attempt = 1; ; attempt++) {
      let emitted = false;
      try {
        for await (const event of this.inner.stream(request, signal)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const retryable = error instanceof ProviderError && error.retryable;
        if (emitted || !retryable || attempt >= this.maxAttempts || signal?.aborted) throw error;
        const hinted = Number((error as ProviderError).details.retryAfterSeconds) * 1000;
        const backoff = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
        const wait = Number.isFinite(hinted)
          ? Math.min(Math.max(hinted, backoff), this.maxDelayMs)
          : backoff;
        this.options.log.warn('Model call failed, retrying', {
          provider: this.id,
          attempt,
          waitMs: wait,
          error: serializeError(error),
        });
        await this.sleep(wait, signal);
      }
    }
  }
}

/** Where metering writes: the owner, the usage ledger, the price catalogue and the clock. */
export interface MeteringOptions {
  /** The owner the usage row belongs to. */
  ownerId: OwnerId;
  /** The append-only ledger; a failed write is logged, never thrown. */
  usage: UsageRepository;
  /** Prices the request; a model with no price records tokens with no cost. */
  catalog: ModelCatalog;
  /** Injected clock for the row's timestamp. */
  clock: Clock;
  /** Structured logger; a missing usage event or a failed write is reported here. */
  log: Logger;
}

/**
 * Writes one usage row per completed request: tokens, and cost when the model has a price (F03, F22).
 * A failed write is logged, never thrown: metering must not break a reply.
 */
export class MeteredModelProvider extends ModelProviderDecorator {
  constructor(
    /** The provider whose usage is recorded. */
    inner: ModelProvider,
    /** The owner, ledger, catalogue and clock the row is written with. */
    private readonly options: MeteringOptions,
  ) {
    super(inner);
  }

  /** Passes events through and records the usage on `done`, once the counts are known. */
  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    let usage: TokenUsage | undefined;
    for await (const event of this.inner.stream(request, signal)) {
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'done') await this.record(request, usage);
      yield event;
    }
  }

  /** Appends the usage row; failures are logged so metering never breaks a reply. */
  private async record(request: ModelRequest, usage: TokenUsage | undefined): Promise<void> {
    const { ownerId, catalog, clock, log } = this.options;
    const ref = `${this.id}/${request.model}`;
    const tokens = usage ?? { inputTokens: 0, outputTokens: 0 };
    if (!usage) log.warn('Model response reported no token usage', { model: ref });
    try {
      await this.options.usage.append({
        ownerId,
        turnId: request.metadata?.turnId as TurnId | undefined,
        sessionId: request.metadata?.sessionId as SessionId | undefined,
        purpose: request.metadata?.purpose,
        provider: this.id,
        model: request.model,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cachedInputTokens: tokens.cachedInputTokens,
        reasoningTokens: tokens.reasoningTokens,
        background: request.metadata?.background === true,
        cost: catalog.cost(ref, tokens),
        at: clock.now(),
      });
    } catch (error) {
      log.error('Could not record model usage', { model: ref, error: serializeError(error) });
    }
  }
}

/**
 * Will remove known secrets from requests before they leave (F12). Until the secrets vault exists it
 * passes requests through unchanged; it is in the chain now so F12 only has to fill it in.
 */
export class RedactingModelProvider extends ModelProviderDecorator {
  /** Passes the request through unchanged until F12 adds the secret removal. */
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    return this.inner.stream(request, signal);
  }
}
