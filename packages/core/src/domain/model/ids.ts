import { randomUUID } from 'node:crypto';

declare const brand: unique symbol;

/**
 * A string ID that cannot be mixed up with another kind of ID at compile time. The brand exists only
 * in the type system: at runtime an ID is a plain string, so a value read from the database or a
 * request must be marked with {@link asId}.
 */
export type Id<Kind extends string> = string & {
  /** The compile-time brand; no runtime value and never read. */
  readonly [brand]: Kind;
};

/** The single owner this process serves; `createShitsuji` uses the fixed `owner` id. */
export type OwnerId = Id<'owner'>;
/** The owner's one conversation, shared by every channel. */
export type ThreadId = Id<'thread'>;
/** One line of work inside a thread; see `Session`. */
export type SessionId = Id<'session'>;
/** One run of the agent in a session; see `Turn`. */
export type TurnId = Id<'turn'>;
/** One stored message; see `Message`. */
export type MessageId = Id<'message'>;
/** One tool call the model asked for; its result quotes the same id. */
export type ToolCallId = Id<'tool_call'>;
/** One approval card waiting for the owner; see `Approval`. */
export type ApprovalId = Id<'approval'>;

/** A new random ID (UUID v4). Entities get their id here before they are stored. */
export function newId<T extends Id<string>>(): T {
  return randomUUID() as T;
}

/**
 * Marks an existing string (from the database, a request…) as an ID of a given kind. It only checks
 * that the string is non-empty; the format is the caller's business (`createShitsuji` uses the literal
 * `owner`). Throws a `TypeError` for an empty string.
 */
export function asId<T extends Id<string>>(value: string): T {
  if (!value) throw new TypeError('An ID cannot be empty');
  return value as T;
}
