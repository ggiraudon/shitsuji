import type { Message, ToolCall } from '../domain/model/Message.js';
import type { Session } from '../domain/model/Session.js';

export type InjectionConditionType =
  'always' | 'tool_used' | 'pattern_detected' | 'custom' | 'once';

export interface InjectionConditionAlways {
  type: 'always';
}

export interface InjectionConditionToolUsed {
  type: 'tool_used';
  toolNames: string[];
}

export interface InjectionConditionPatternDetected {
  type: 'pattern_detected';
  patterns: RegExp[];
}

export interface InjectionConditionCustom {
  type: 'custom';
  check: (context: AgentRenderContext) => boolean;
}

export interface InjectionConditionOnce {
  type: 'once';
}

export type InjectionCondition =
  | InjectionConditionAlways
  | InjectionConditionToolUsed
  | InjectionConditionPatternDetected
  | InjectionConditionCustom
  | InjectionConditionOnce;

export interface AgentRenderContext {
  session: Session;
  /** The recent messages being sent to the model, oldest first. */
  messages: Message[];
  /** Tool calls in the latest assistant message. */
  toolCalls?: ToolCall[];
  lastUserMessage?: string;
}

export interface ContextInjectable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priority: number;
  readonly condition: InjectionCondition;

  render(context: AgentRenderContext): string | null;
}

export abstract class BaseContextInjectable implements ContextInjectable {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  priority = 50;
  condition: InjectionCondition = { type: 'always' };

  abstract render(context: AgentRenderContext): string | null;
}
