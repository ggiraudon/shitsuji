/**
 * Shitsuji's error hierarchy. Every error has a stable `code` and `details` that are safe to log and
 * show (no secrets). Messages keep the specific cause; never "something went wrong".
 *
 * `code` is the part clients and logs may branch on; the class is what callers catch. `toJSON()`
 * returns the shape `serializeError` puts in events and log lines, so a `ShitsujiError` always
 * reports the same fields.
 */
export class ShitsujiError extends Error {
  override readonly name: string = 'ShitsujiError';

  /**
   * `code` is a stable snake_case identifier (`tool_input_invalid`): never reword it, logs and clients
   * branch on it. `details` carries context for the log and the owner and must be safe to show, so no
   * secrets. `options.cause` keeps the thrown value this wraps; `serializeError` recurses into it.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** The fields logged and published, without a stack, so events stay small and stable. */
  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Configuration is missing or invalid. Thrown while reading config, before anything starts. */
export class ConfigError extends ShitsujiError {
  override readonly name = 'ConfigError';
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super('config_invalid', message, details, options);
  }
}

/**
 * A model provider failed. `retryable` says whether the request may be sent again: a network blip is,
 * a 400 is not. The runner still never retries after a tool call has been emitted, whatever this says.
 */
export class ProviderError extends ShitsujiError {
  override readonly name = 'ProviderError';
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super('provider_failed', message, { provider, retryable, ...details }, options);
  }
}

/**
 * A tool was called with arguments that do not match its schema. The pipeline currently reports that
 * as a `ToolOutcome` of kind `error` with reason `invalid_input`, so nothing throws this yet.
 */
export class ToolInputError extends ShitsujiError {
  override readonly name = 'ToolInputError';
  constructor(
    readonly tool: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super('tool_input_invalid', message, { tool, ...details });
  }
}

/**
 * A policy check refused an action. The trust service returns a `deny` verdict instead of throwing, and
 * the pipeline reports it as a tool error, so nothing throws this yet.
 */
export class PolicyDenied extends ShitsujiError {
  override readonly name = 'PolicyDenied';
  constructor(message: string, details?: Record<string, unknown>) {
    super('policy_denied', message, details);
  }
}

/**
 * A model request was refused before it was sent because the budget would not cover it (F22). Thrown
 * by `BudgetService.reserve`, so the turn fails with a reason the owner can act on.
 */
export class BudgetExceeded extends ShitsujiError {
  override readonly name = 'BudgetExceeded';
  constructor(message: string, details?: Record<string, unknown>) {
    super('budget_exceeded', message, details);
  }
}

/**
 * The workspace or desktop container could not be reached or answered in the expected shape. Thrown by
 * the sandbox drivers, `SandboxService` and the startup egress probe; never swallowed, because every
 * tool that needs the sandbox is unusable until it is fixed.
 */
export class SandboxUnavailable extends ShitsujiError {
  override readonly name = 'SandboxUnavailable';
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super('sandbox_unavailable', message, details, options);
  }
}

/** Something that should exist does not. The message is built from `what` and `id`; both are details. */
export class NotFound extends ShitsujiError {
  override readonly name = 'NotFound';
  constructor(what: string, id: string) {
    super('not_found', `${what} ${id} not found`, { what, id });
  }
}

/**
 * A state machine was asked for a transition it does not allow (`Turn`, `Approval`, `Thread`).
 * Thrown instead of ignoring the move, so a bug surfaces where it happened and not as a corrupt row
 * later.
 */
export class InvalidTransition extends ShitsujiError {
  override readonly name = 'InvalidTransition';
  constructor(entity: string, from: string, to: string) {
    super('invalid_transition', `${entity} cannot go from ${from} to ${to}`, { entity, from, to });
  }
}

/**
 * Turns any thrown value into a plain object for logs and events. A `ShitsujiError` keeps its `code`
 * and `details`; any other `Error` keeps its name and message and recurses into `cause`; anything else
 * becomes `NonError`. No stack is included, and nothing here is redacted further: errors must never be
 * built with a secret in the first place.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof ShitsujiError) return error.toJSON();
  if (error instanceof Error) {
    const out: Record<string, unknown> = { name: error.name, message: error.message };
    if (error.cause !== undefined) out.cause = serializeError(error.cause);
    return out;
  }
  return { name: 'NonError', message: String(error) };
}
