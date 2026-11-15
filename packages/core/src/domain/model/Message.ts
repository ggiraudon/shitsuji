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
