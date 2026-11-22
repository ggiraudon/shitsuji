import { SystemClock } from '../adapters/clock/SystemClock.js';
import { InProcessEventBus } from '../adapters/events/InProcessEventBus.js';
import { JsonLogger, PrettyLogger } from '../adapters/logging/loggers.js';
import type { Clock } from '../ports/Clock.js';
import type { EventBus } from '../ports/EventBus.js';
import type { LogLevel, Logger } from '../ports/Logger.js';

/** The cross-cutting services every part of Shitsuji receives through its constructor. */
export interface CoreServices {
  /** The one clock; every timestamp in a request comes from it. */
  clock: Clock;
  /** The one logger; components take a child with their own bindings. */
  log: Logger;
  /** The in-process bus every component publishes to and subscribes on. */
  events: EventBus;
}

/** How the services are built: the log level and its shape. */
export interface CoreServicesOptions {
  /** The threshold for the logger; `info` by default. */
  level?: LogLevel;
  /** JSON lines for containers, readable lines for a terminal. */
  format?: 'json' | 'pretty';
}

/** Builds the three services with one clock, so log lines, events and turns agree on time. */
export function createCoreServices(options: CoreServicesOptions = {}): CoreServices {
  const level = options.level ?? 'info';
  const clock = new SystemClock();
  const log =
    options.format === 'json'
      ? new JsonLogger({ level, clock })
      : new PrettyLogger({ level, clock });
  return { clock, log, events: new InProcessEventBus(log, clock) };
}
