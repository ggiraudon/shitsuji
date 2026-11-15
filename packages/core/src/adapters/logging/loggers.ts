import { serializeError } from '../../domain/errors.js';
import type { Clock } from '../../ports/Clock.js';
import { LOG_LEVELS, type LogContext, type LogLevel, type Logger } from '../../ports/Logger.js';

export interface LogRecord {
  level: LogLevel;
  message: string;
  time: Date;
  context: LogContext;
}

/** Where formatted lines go. Defaults to stdout (info and below) and stderr (warn and error). */
export type LogSink = (line: string, level: LogLevel) => void;

export const consoleSink: LogSink = (line, level) => {
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

export interface LoggerOptions {
  level?: LogLevel;
  clock: Clock;
  sink?: LogSink;
  bindings?: LogContext;
}

/** Template method: level filtering, bindings and error serialisation; subclasses format a record. */
abstract class BaseLogger implements Logger {
  protected readonly level: LogLevel;
  protected readonly clock: Clock;
  protected readonly sink: LogSink;
  protected readonly bindings: LogContext;

  constructor(options: LoggerOptions) {
    this.level = options.level ?? 'info';
    this.clock = options.clock;
    this.sink = options.sink ?? consoleSink;
    this.bindings = options.bindings ?? {};
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  abstract child(bindings: LogContext): Logger;
  protected abstract format(record: LogRecord): string;

  protected childOptions(bindings: LogContext): LoggerOptions {
    return {
      level: this.level,
      clock: this.clock,
      sink: this.sink,
      bindings: { ...this.bindings, ...bindings },
    };
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.level)) return;
    const merged = { ...this.bindings, ...normalise(context) };
    this.sink(this.format({ level, message, time: this.clock.now(), context: merged }), level);
  }
}

/** One JSON object per line: for containers and log collectors. */
export class JsonLogger extends BaseLogger {
  child(bindings: LogContext): Logger {
    return new JsonLogger(this.childOptions(bindings));
  }

  protected format({ level, message, time, context }: LogRecord): string {
    return JSON.stringify({ time: time.toISOString(), level, msg: message, ...context });
  }
}

/** Human-readable lines for the CLI: `[time] [LEVEL] message {context}`. */
export class PrettyLogger extends BaseLogger {
  child(bindings: LogContext): Logger {
    return new PrettyLogger(this.childOptions(bindings));
  }

  protected format({ level, message, time, context }: LogRecord): string {
    const ctx = Object.keys(context).length ? ` ${JSON.stringify(context)}` : '';
    return `[${time.toISOString()}] [${level.toUpperCase()}] ${message}${ctx}`;
  }
}

/** Discards everything. For tests that do not care about logs. */
export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

/** Keeps records in memory. For tests that assert on logs. */
export class MemoryLogger implements Logger {
  constructor(
    readonly records: LogRecord[] = [],
    private readonly bindings: LogContext = {},
  ) {}

  debug(message: string, context?: LogContext): void {
    this.push('debug', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.push('info', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.push('warn', message, context);
  }
  error(message: string, context?: LogContext): void {
    this.push('error', message, context);
  }
  child(bindings: LogContext): Logger {
    return new MemoryLogger(this.records, { ...this.bindings, ...bindings });
  }

  private push(level: LogLevel, message: string, context?: LogContext): void {
    this.records.push({
      level,
      message,
      time: new Date(0),
      context: { ...this.bindings, ...normalise(context) },
    });
  }
}

/** Errors inside a context become plain objects so JSON.stringify keeps their message. */
function normalise(context?: LogContext): LogContext {
  if (!context) return {};
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}
