import { randomUUID } from 'node:crypto';

declare const brand: unique symbol;

/**
 * A string ID that cannot be mixed up with another kind of ID at compile time. The brand exists only
 * in the type system: at runtime an ID is a plain string, so a value read from the database or a
 * request must be marked with {@link asId}.
 */
export type Id<Kind extends string> = string & { readonly [brand]: Kind };

/** The single owner this process serves; `createShitsuji` uses the fixed `owner` id. */
export type OwnerId = Id<'owner'>;
/** The owner's one conversation, shared by every channel. */
export type ThreadId = Id<'thread'>;
/** One line of work inside a thread (see {@link Session}). */
export type SessionId = Id<'session'>;
/** One run of the agent in a session (see {@link Turn}). */
export type TurnId = Id<'turn'>;
/** One stored message (see {@link Message}). */
export type MessageId = Id<'message'>;
/** One tool call the model asked for; its result quotes the same id. */
export type ToolCallId = Id<'tool_call'>;
/** One approval card waiting for the owner (see {@link Approval}). */
export type ApprovalId = Id<'approval'>;

/** A new random ID (UUID v4). Entities get their id here before they are stored. */
export function newId<T extends Id<string>>(): T {
  return randomUUID() as T;
}

/**
 * Marks an existing string (from the database, a request…) as an ID of a given kind. It only checks
 * that the string is non-empty; the format is the caller's business. Throws a `TypeError` for an
 * empty string, so an adapter that read a blank column fails at once instead of storing `""`.
 */
export function asId<T extends Id<string>>(value: string): T {
  if (!value) throw new TypeError('An ID cannot be empty');
  return value as T;
}
