/** Severity of a log line, lowest first; the adapter drops lines below its configured level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The levels as a runtime list, in severity order; config uses it to validate `logging.level`. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Structured fields attached to a log line. Errors are serialised by the adapter. */
export type LogContext = Record<string, unknown>;

/**
 * Structured logging. Narrow enough that the core depends on no logger library: the adapter decides
 * where lines go, and a child logger carries the component's bindings. Secrets never reach a context:
 * pass a `Secret` (it prints as `[secret]`), never its `reveal()` result.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** A logger that adds `bindings` to every line, e.g. `log.child({ component: 'agent' })`. */
  child(bindings: LogContext): Logger;
}
