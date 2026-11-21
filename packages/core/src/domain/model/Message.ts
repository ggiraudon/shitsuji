import type { MessageId, SessionId, ThreadId, ToolCallId, TurnId } from './ids.js';

/**
 * One call the model asked a tool to make. `id` is what the tool result quotes back so the two pair
 * up; `name` is the tool's dotted name (`workspace.exec`); `arguments` is the model's raw JSON, which
 * the tool's schema validates before anything runs.
 */
export interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * An image attached to a message or a tool result. Requests carry `data` (base64) or `url`;
 * stored messages keep only `ref`, a workspace-relative file the ContextBuilder loads at build time,
 * so jsonb never holds the bytes.
 */
export interface ImageAttachment {
  mediaType: string;
  /** Base64 bytes, built per request by the ContextBuilder; never stored. */
  data?: string;
  /** A remote image URL, used as-is by the provider. */
  url?: string;
  /** A workspace-relative path such as `sessions/<id>/images/chart.png`; what storage keeps. */
  ref?: string;
  /** A name for the deterministic placeholder when the image is pruned. */
  name?: string;
}

/**
 * One piece of a message. A message can mix text, images, tool calls and tool results. Order carries
 * meaning: the tool results of a step follow the assistant message that asked for them. The array is
 * stored as `jsonb`, so every part must stay JSON-safe (see {@link sanitizeMessage}).
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | ({ type: 'image' } & ImageAttachment)
  | { type: 'tool_call'; call: ToolCall }
  | {
      type: 'tool_result';
      toolCallId: ToolCallId;
      content: string;
      isError: boolean;
      /** Images the tool returned, by workspace reference; loaded when the context is built. */
      images?: ImageAttachment[];
    }
  /** Model reasoning (e.g. DeepSeek): kept in the transcript, never shown as the reply. */
  | { type: 'reasoning'; text: string };

/**
 * The role the model sees: `user` for the owner's words, `assistant` for the model's own output,
 * `tool` for the results of its calls, and `system` for injected notes such as the one
 * `StartupRecovery` leaves after a crash.
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** Who actually wrote it: the owner, the assistant, or the system (injected notes, errors). */
export type MessageAuthor = 'owner' | 'assistant' | 'system';

/**
 * One message of a session's transcript. Rows are appended in order and never edited; the only
 * change is {@link Message.withdrawn}, which a Stop sets on the owner messages it takes back. Thus
 * the transcript is also the audit trail of what the model was shown, minus the withdrawn rows.
 */
export interface Message {
  id: MessageId;
  threadId: ThreadId;
  sessionId: SessionId;
  /** The turn that produced it; every message the runtime stores carries one. */
  turnId?: TurnId;
  role: MessageRole;
  author: MessageAuthor;
  parts: ContentPart[];
  /** Which channel it came in on or went out through ("cli", "telegram", …). */
  channel?: string;
  /** The channel's own ID for it (e.g. a Telegram message id), to edit or withdraw it later. */
  externalRef?: string;
  /** Withdrawn messages stay in the transcript but no longer feed the model or the budget check-in. */
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

/**
 * The tool calls of a message, in the order the model emitted them. Used to rebuild history for the
 * model and to show the calls in the API; a message with no tool calls yields an empty array.
 */
export function toolCallsOf(message: Pick<Message, 'parts'>): ToolCall[] {
  return message.parts
    .filter((p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call')
    .map((p) => p.call);
}

/**
 * Strips U+0000 from every string in a JSON-shaped value (#101). Postgres jsonb refuses a NUL in a
 * string ("unsupported Unicode escape sequence"), so a tool result containing one used to fail the
 * whole turn at the message write. The repository applies this before storage as a safety net; the
 * text tools also refuse binary input before it can get here. Returns a copy: the argument is not
 * mutated.
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

/**
 * A message whose content parts are safe to store in jsonb (no U+0000 anywhere). The in-memory
 * repository stores this copy; the Postgres one strips the same characters from `parts` on write.
 */
export function sanitizeMessage(message: Message): Message {
  return { ...message, parts: stripNul(message.parts) };
}
