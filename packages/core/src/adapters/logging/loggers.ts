import { serializeError } from '../../domain/errors.js';
import type { Clock } from '../../ports/Clock.js';
import { LOG_LEVELS, type LogContext, type LogLevel, type Logger } from '../../ports/Logger.js';

/** One line as a logger produced it, before formatting; useful for asserting on logs in tests. */
export interface LogRecord {
  /** The line's severity, after the level filter. */
  level: LogLevel;
  /** The message as the caller wrote it. */
  message: string;
  /** When it was written, from the injected clock (`MemoryLogger` uses the epoch). */
  time: Date;
  /** The bindings and the call's context, merged; errors already serialised. */
  context: LogContext;
}

/** Where formatted lines go. Defaults to stdout (info and below) and stderr (warn and error). */
export type LogSink = (line: string, level: LogLevel) => void;

/** The default sink: warn and error to stderr, everything else to stdout. */
export const consoleSink: LogSink = (line, level) => {
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

/** How to build a logger: its threshold, clock, sink and initial bindings. */
export interface LoggerOptions {
  /** Lines below this level are dropped; `info` by default. */
  level?: LogLevel;
  /** Supplies each line's timestamp; tests inject a manual clock. */
  clock: Clock;
  /** Where the formatted line goes; `consoleSink` by default. */
  sink?: LogSink;
  /** Fields added to every line, e.g. the component or plugin id. */
  bindings?: LogContext;
}

/** Template method: level filtering, bindings and error serialisation; subclasses format a record. */
abstract class BaseLogger implements Logger {
  /** Lines below this threshold are dropped before formatting. */
  protected readonly level: LogLevel;
  /** Supplies each line's timestamp. */
  protected readonly clock: Clock;
  /** Where the formatted line goes; shared with children. */
  protected readonly sink: LogSink;
  /** Fields added to every line, merged with the call's context. */
  protected readonly bindings: LogContext;

  /** Applies the defaults (`info`, `consoleSink`, no bindings) and stores the options. */
  constructor(options: LoggerOptions) {
    this.level = options.level ?? 'info';
    this.clock = options.clock;
    this.sink = options.sink ?? consoleSink;
    this.bindings = options.bindings ?? {};
  }

  /** Writes a debug line, dropping it below the threshold. */
  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }
  /** Writes an info line, dropping it below the threshold. */
  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }
  /** Writes a warning, dropping it below the threshold. */
  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }
  /** Writes an error, dropping it below the threshold. */
  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  abstract child(bindings: LogContext): Logger;
  protected abstract format(record: LogRecord): string;

  /** The options a child shares: same level, clock and sink, with the bindings extended. */
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
  /** A logger that adds these fields to every line and shares level, clock and sink. */
  child(bindings: LogContext): Logger {
    return new JsonLogger(this.childOptions(bindings));
  }

  /** Serialises one record as JSON; `time`, `level` and `msg` first, then the context fields. */
  protected format({ level, message, time, context }: LogRecord): string {
    return JSON.stringify({ time: time.toISOString(), level, msg: message, ...context });
  }
}

/** Human-readable lines for the CLI: `[time] [LEVEL] message {context}`. */
export class PrettyLogger extends BaseLogger {
  /** A logger that adds these fields to every line and shares level, clock and sink. */
  child(bindings: LogContext): Logger {
    return new PrettyLogger(this.childOptions(bindings));
  }

  /** Formats one record for a terminal, with the context as compact JSON when present. */
  protected format({ level, message, time, context }: LogRecord): string {
    const ctx = Object.keys(context).length ? ` ${JSON.stringify(context)}` : '';
    return `[${time.toISOString()}] [${level.toUpperCase()}] ${message}${ctx}`;
  }
}

/** Discards everything. For tests that do not care about logs. */
export class NullLogger implements Logger {
  /** Discarded. */
  debug(): void {}
  /** Discarded. */
  info(): void {}
  /** Discarded. */
  warn(): void {}
  /** Discarded. */
  error(): void {}
  /** Returns the same logger: there is nothing to bind. */
  child(): Logger {
    return this;
  }
}

/** Keeps records in memory. For tests that assert on logs. */
export class MemoryLogger implements Logger {
  constructor(
    /** The records written so far, oldest first; a test reads this array after acting. */
    readonly records: LogRecord[] = [],
    /** Fields added to every record this logger writes. */
    private readonly bindings: LogContext = {},
  ) {}

  /** Records a debug line. */
  debug(message: string, context?: LogContext): void {
    this.push('debug', message, context);
  }
  /** Records an info line. */
  info(message: string, context?: LogContext): void {
    this.push('info', message, context);
  }
  /** Records a warning. */
  warn(message: string, context?: LogContext): void {
    this.push('warn', message, context);
  }
  /** Records an error. */
  error(message: string, context?: LogContext): void {
    this.push('error', message, context);
  }
  /** A logger that writes into the same array with extra bindings. */
  child(bindings: LogContext): Logger {
    return new MemoryLogger(this.records, { ...this.bindings, ...bindings });
  }

  /** Appends one record with the epoch as its time, so a test's assertions do not depend on it. */
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
