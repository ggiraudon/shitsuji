/**
 * Shitsuji's error hierarchy. Every error has a stable `code` and `details` that are safe to log and
 * show (no secrets). Messages keep the specific cause; never "something went wrong".
 */
export class ShitsujiError extends Error {
  override readonly name: string = 'ShitsujiError';

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Configuration is missing or invalid. */
export class ConfigError extends ShitsujiError {
  override readonly name = 'ConfigError';
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super('config_invalid', message, details, options);
  }
}

/** A model provider failed. `retryable` says whether the request may be sent again. */
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

/** A tool was called with arguments that do not match its schema. */
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

/** A policy check refused an action. */
export class PolicyDenied extends ShitsujiError {
  override readonly name = 'PolicyDenied';
  constructor(message: string, details?: Record<string, unknown>) {
    super('policy_denied', message, details);
  }
}

/** A model request was refused before it was sent because the budget would not cover it (F22). */
export class BudgetExceeded extends ShitsujiError {
  override readonly name = 'BudgetExceeded';
  constructor(message: string, details?: Record<string, unknown>) {
    super('budget_exceeded', message, details);
  }
}

/** The workspace or desktop container could not be reached. */
export class SandboxUnavailable extends ShitsujiError {
  override readonly name = 'SandboxUnavailable';
  constructor(message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super('sandbox_unavailable', message, details, options);
  }
}

/** Something that should exist does not. */
export class NotFound extends ShitsujiError {
  override readonly name = 'NotFound';
  constructor(what: string, id: string) {
    super('not_found', `${what} ${id} not found`, { what, id });
  }
}

/** A state machine was asked for a transition it does not allow. */
export class InvalidTransition extends ShitsujiError {
  override readonly name = 'InvalidTransition';
  constructor(entity: string, from: string, to: string) {
    super('invalid_transition', `${entity} cannot go from ${from} to ${to}`, { entity, from, to });
  }
}

/** Turns any thrown value into a plain object for logs and events. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof ShitsujiError) return error.toJSON();
  if (error instanceof Error) {
    const out: Record<string, unknown> = { name: error.name, message: error.message };
    if (error.cause !== undefined) out.cause = serializeError(error.cause);
    return out;
  }
  return { name: 'NonError', message: String(error) };
}
