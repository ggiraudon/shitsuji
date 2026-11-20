import type { MessageId, SessionId, ThreadId, ToolCallId, TurnId } from './ids.js';

export interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: Record<string, unknown>;
}

/** One piece of a message. A message can mix text, images, tool calls and tool results. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data?: string; url?: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; toolCallId: ToolCallId; content: string; isError: boolean }
  /** Model reasoning (e.g. DeepSeek): kept in the transcript, never shown as the reply. */
  | { type: 'reasoning'; text: string };

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Who actually wrote it: the owner, the assistant, or the system (injected notes, errors). */
export type MessageAuthor = 'owner' | 'assistant' | 'system';

export interface Message {
  id: MessageId;
  threadId: ThreadId;
  sessionId: SessionId;
  turnId?: TurnId;
  role: MessageRole;
  author: MessageAuthor;
  parts: ContentPart[];
  /** Which channel it came in on or went out through ("cli", "telegram", …). */
  channel?: string;
  /** The channel's own ID for it (e.g. a Telegram message id), to edit or withdraw it later. */
  externalRef?: string;
  withdrawn: boolean;
  createdAt: Date;
}

/** All text parts joined, e.g. for display or search. Reasoning is excluded. */
export function textOf(message: Pick<Message, 'parts'>): string {
  return message.parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export function toolCallsOf(message: Pick<Message, 'parts'>): ToolCall[] {
  return message.parts
    .filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
    .map((p) => p.call);
}

/**
 * Strips U+0000 from every string in a JSON-shaped value (#101). Postgres jsonb refuses a NUL in a
 * string ("unsupported Unicode escape sequence"), so a tool result containing one used to fail the
 * whole turn at the message write. The repository applies this before storage as a safety net; the
 * text tools also refuse binary input before it can get here.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('\u0000', '') as T;
  if (Array.isArray(value)) return value.map((entry) => stripNul(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        stripNul(entry),
      ]),
    ) as T;
  }
  return value;
}

/** A message whose content parts are safe to store in jsonb (no U+0000 anywhere). */
export function sanitizeMessage(message: Message): Message {
  return { ...message, parts: stripNul(message.parts) };
}
