import { serializeError } from '../../domain/errors.js';
import type { Clock } from '../../ports/Clock.js';
import type {
  EventBus,
  EventMeta,
  EventName,
  EventPattern,
  Handler,
  PublishedEvent,
  ShitsujiEvents,
  Unsubscribe,
} from '../../ports/EventBus.js';
import type { Logger } from '../../ports/Logger.js';

/**
 * Delivers events to subscribers in the same process. Publishing never throws: a handler error (sync or
 * async) is logged and re-published as `system.error`. Errors from `system.error` handlers are only
 * logged, so a failing error handler cannot loop.
 */
export class InProcessEventBus implements EventBus {
  private readonly exact = new Map<string, Set<Handler<unknown>>>();
  private readonly patterns = new Map<EventPattern, Set<Handler<unknown>>>();

  constructor(
    private readonly log: Logger,
    private readonly clock: Clock,
  ) {}

  publish<K extends EventName>(type: K, payload: ShitsujiEvents[K], meta: EventMeta = {}): void {
    const event: PublishedEvent<K> = { type, payload, meta, at: this.clock.now() };
    for (const handler of this.handlersFor(type)) {
      this.deliver(handler, event as PublishedEvent);
    }
  }

  subscribe<K extends EventName>(type: K, handler: Handler<ShitsujiEvents[K]>): Unsubscribe {
    return add(this.exact, type, handler as Handler<unknown>);
  }

  subscribePattern(pattern: EventPattern, handler: Handler<unknown>): Unsubscribe {
    return add(this.patterns, pattern, handler);
  }

  private handlersFor(type: string): Handler<unknown>[] {
    const out = [...(this.exact.get(type) ?? [])];
    for (const [pattern, handlers] of this.patterns) {
      if (pattern === '*' || type.startsWith(pattern.slice(0, -1))) out.push(...handlers);
    }
    return out;
  }

  private deliver(handler: Handler<unknown>, event: PublishedEvent): void {
    try {
      const result = handler(event.payload, event);
      if (result instanceof Promise) result.catch((error) => this.failed(error, event));
    } catch (error) {
      this.failed(error, event);
    }
  }

  private failed(error: unknown, event: PublishedEvent): void {
    this.log.error('Event handler failed', { event: event.type, error: serializeError(error) });
    if (event.type !== 'system.error') {
      this.publish('system.error', { error: serializeError(error), event: event.type });
    }
  }
}

function add<K>(
  map: Map<K, Set<Handler<unknown>>>,
  key: K,
  handler: Handler<unknown>,
): Unsubscribe {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(handler);
  return () => {
    set.delete(handler);
  };
}
