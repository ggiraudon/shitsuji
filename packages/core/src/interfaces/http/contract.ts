import { z } from 'zod/v4';

/**
 * The API's request, response and live-event shapes, shared by the server and the TUI. They move to
 * packages/shared when the web UI (F07) needs them too.
 */

export const postMessageBody = z.object({
  content: z.string().min(1).max(100_000),
  /** "main" or omitted: the owner's main chat session. */
  sessionId: z.string().min(1).optional(),
});
export type PostMessageBody = z.infer<typeof postMessageBody>;

export interface PostMessageResponse {
  sessionId: string;
  turnId: string;
  steered: boolean;
}

/** The SOUL a turn runs with, plus any unconfirmed edit of the SOUL.md export (S23). */
export interface SoulDto {
  revision: number;
  body: string;
  updatedAt: string;
  /** `hash` identifies the reviewed text; confirming sends it back. */
  pending?: { path: string; current: string; proposed: string; hash: string };
}

/** Confirming applies only the text that was reviewed: its hash from `SoulDto.pending`. */
export const confirmSoulBody = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) });

export interface ConfirmSoulResponse {
  revision: number;
}

/** A code the owner sends as /start <code> on the chat to pair (S31). */
export interface PairResponse {
  code: string;
  expiresAt: string;
}

export interface MessageDto {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  author: 'owner' | 'assistant' | 'system';
  /** Text parts joined; reasoning is never included. */
  text: string;
  toolCalls: { id: string; name: string }[];
  toolResults: { toolCallId: string; isError: boolean; preview: string }[];
  withdrawn: boolean;
  turnId?: string;
  createdAt: string;
}

export interface TurnDto {
  id: string;
  sessionId: string;
  status: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ActivityReceiptDto {
  turnId: string;
  sessionId?: string;
  tool: string;
  toolCallId: string;
  effect?: string;
  target?: string;
  outcome: string;
  durationMs?: number;
  /** Redacted and shortened arguments. */
  args?: string;
  /** What allowed it: the trust basis (S35 fills in quotes and rules). */
  allowedBy?: { kind: string; detail?: string };
  /** Why trust refused it, when it did. */
  deniedBecause?: string;
  at: string;
}

export interface ActivityResponse {
  since: string;
  receipts: ActivityReceiptDto[];
}

export interface UsageRowDto {
  turnId?: string;
  sessionId?: string;
  purpose?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  background?: boolean;
  cost?: { micros: number; currency: string };
  at: string;
}

export interface UsageDto {
  since: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Settled cost of the rows whose price is known, when there is one. */
  cost: { micros: number; currency: string } | null;
  rows: UsageRowDto[];
}

/** Live events on /api/events, as JSON text frames. */
export interface ApprovalDto {
  id: string;
  turnId: string;
  sessionId: string;
  tool: string;
  effect: string;
  target: string;
  summary: string;
  reason?: string;
  /** A shortened copy; the action hash is what binds the exact arguments. */
  arguments: Record<string, unknown>;
  actionHash: string;
  status: string;
  createdAt: string;
  decidedAt?: string;
  endedAt?: string;
}

export interface ApprovalsResponse {
  approvals: ApprovalDto[];
}

/** The owner's answer to a card (S36). */
export const approvalDecisionBody = z.object({ decision: z.enum(['approve', 'decline']) });

export interface ApprovalResponse {
  approval: ApprovalDto;
}

export type LiveEvent =
  | {
      type: 'turn.status';
      turnId: string;
      sessionId: string;
      status: string;
      reply?: string;
      question?: string;
      error?: string;
    }
  | { type: 'turn.text_delta'; turnId: string; sessionId: string; text: string }
  | { type: 'turn.steered'; turnId: string; sessionId: string }
  | {
      type: 'tool.started';
      turnId: string;
      sessionId: string;
      toolName: string;
      toolCallId: string;
    }
  | {
      type: 'tool.finished';
      turnId: string;
      sessionId: string;
      toolName: string;
      toolCallId: string;
      ok: boolean;
      error?: string;
    }
  | {
      type: 'approval.requested';
      approvalId: string;
      turnId: string;
      sessionId: string;
      tool: string;
      effect: string;
      summary: string;
      actionHash: string;
    }
  | {
      type: 'approval.resolved';
      approvalId: string;
      turnId: string;
      sessionId: string;
      status: string;
    };

export const LIVE_EVENT_TYPES = [
  'turn.status',
  'turn.text_delta',
  'turn.steered',
  'tool.started',
  'tool.finished',
  'approval.requested',
  'approval.resolved',
] as const;
