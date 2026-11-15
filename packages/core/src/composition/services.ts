import { SystemClock } from '../adapters/clock/SystemClock.js';
import { InProcessEventBus } from '../adapters/events/InProcessEventBus.js';
import { JsonLogger, PrettyLogger } from '../adapters/logging/loggers.js';
import type { Clock } from '../ports/Clock.js';
import type { EventBus } from '../ports/EventBus.js';
import type { LogLevel, Logger } from '../ports/Logger.js';

/** The cross-cutting services every part of Shitsuji receives through its constructor. */
export interface CoreServices {
  clock: Clock;
  log: Logger;
  events: EventBus;
}

export interface CoreServicesOptions {
  level?: LogLevel;
  /** JSON lines for containers, readable lines for a terminal. */
  format?: 'json' | 'pretty';
}

/** Temporary home until createShitsuji() (S6) builds the whole object graph. */
export function createCoreServices(options: CoreServicesOptions = {}): CoreServices {
  const level = options.level ?? 'info';
  const clock = new SystemClock();
  const log =
    options.format === 'json'
      ? new JsonLogger({ level, clock })
      : new PrettyLogger({ level, clock });
  return { clock, log, events: new InProcessEventBus(log, clock) };
}
