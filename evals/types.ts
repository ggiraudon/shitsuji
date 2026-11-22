/** The shapes the evaluation harness works with (F22, S38). */

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface Notification {
  text: string;
  at: string;
}

/** Everything the fake outside world recorded during one scenario. */
export interface Mailbox {
  messages: MailMessage[];
  notifications: Notification[];
}

/** One scripted model step for an offline run. */
export interface EvalStep {
  text?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}

export type OfflineJudge = 'allow' | 'ask' | 'deny';

/** A tool receipt, as the activity log shows it. */
export interface Receipt {
  tool: string;
  effect?: string;
  target?: string;
  outcome: string;
  allowedBy?: { kind: string; detail?: string };
  deniedBecause?: string;
}

export interface ApprovalRecord {
  id: string;
  tool: string;
  summary: string;
  status: string;
}

/** The size of the first model request: the system prompt and the core tool schemas. */
export interface ContextBudget {
  systemTokens: number;
  toolTokens: number;
  totalTokens: number;
  budgetTokens: number;
  withinBudget: boolean;
}

import type { DesktopCapability } from '../packages/core/src/ports/SandboxDriver.js';

export interface ScenarioContext {
  workspaceDir: string;
  mailbox: Mailbox;
  receipts: Receipt[];
  approvals: ApprovalRecord[];
  reply: string;
  /** Image parts that reached the model in this offline run; absent for a live run. */
  imagesSent?: number;
  /** Absent for a live run, where the request cannot be inspected. */
  context?: ContextBudget;
}

export interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

/**
 * One evaluation scenario. `steps` and `judge` script the model for an offline run; a live run uses
 * `message`, `approvals` and `check` with the real model.
 */
export interface Scenario {
  id: string;
  title: string;
  /** The owner's message. */
  message: string;
  /** The chat model's scripted replies (offline). */
  steps: EvalStep[];
  /** Enable `workspace.exec` for this scenario (the Calc task reads its saved file). */
  exec?: boolean;
  /** Declare the offline eval model vision-capable (the screenshot-only Calc run). */
  vision?: boolean;
  /** Build a fake desktop for an offline run (S56); ignored by a live run. */
  desktop?: (workspaceDir: string) => DesktopCapability;
  /** The offline judge's answer; defaults to allowing with the owner's words. */
  judge?: OfflineJudge;
  /** How the harness answers an approval card; defaults to approve. */
  approvals?: 'approve' | 'decline';
  /** Tools that must never run here (e.g. the mail tool in the injection scenario). */
  forbiddenTools?: string[];
  check(context: ScenarioContext): Promise<Check[]> | Check[];
}

export interface ScenarioRun {
  id: string;
  title: string;
  passed: boolean;
  checks: Check[];
  /** Model calls in the turn (chat + trust). */
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costMicros?: number;
  currency?: string;
  unsafe: string[];
  context?: ContextBudget;
  error?: string;
}

export interface EvalReport {
  model: string;
  scenarios: ScenarioRun[];
  passRate: number;
  totals: {
    steps: number;
    inputTokens: number;
    outputTokens: number;
    costMicros?: number;
    currency?: string;
    unsafe: number;
  };
}
