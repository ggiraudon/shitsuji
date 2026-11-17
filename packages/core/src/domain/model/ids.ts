import { randomUUID } from 'node:crypto';

declare const brand: unique symbol;

/** A string ID that cannot be mixed up with another kind of ID at compile time. */
export type Id<Kind extends string> = string & { readonly [brand]: Kind };

export type OwnerId = Id<'owner'>;
export type ThreadId = Id<'thread'>;
export type SessionId = Id<'session'>;
export type TurnId = Id<'turn'>;
export type MessageId = Id<'message'>;
export type ToolCallId = Id<'tool_call'>;
export type ApprovalId = Id<'approval'>;

/** A new random ID (UUID v4). */
export function newId<T extends Id<string>>(): T {
  return randomUUID() as T;
}

/** Marks an existing string (from the database, a request…) as an ID of a given kind. */
export function asId<T extends Id<string>>(value: string): T {
  if (!value) throw new TypeError('An ID cannot be empty');
  return value as T;
}
