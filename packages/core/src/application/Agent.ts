import { randomUUID } from 'crypto';
import { Session, type SessionObserver } from '../domain/Session.js';
import { type SessionStore } from '../adapters/storage/SessionStore.js';
import {
  type LLMProvider,
  type LLMCompletionOptions,
  type Message,
  type ToolDefinition,
} from '../ports/LLMProvider.js';
import { ToolRegistry } from './ToolRegistry.js';
import { type Tool } from '../ports/Tool.js';
import {
  type ContextInjectable,
  IdentityInjectable,
  ToolListInjectable,
  RulesInjectable,
} from './context/index.js';
import type { Logger } from '../ports/Logger.js';
import type { EventBus, ShitsujiEvents } from '../ports/EventBus.js';

export interface AgentOptions {
  id?: string;
  name: string;
  llmProvider: LLMProvider;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  sessionStore?: SessionStore;
  log: Logger;
  events: EventBus;
}

export interface AgentConfig {
  id: string;
  name: string;
  model?: string;
}

export class Agent {
  readonly id: string;
  readonly name: string;
  private llmProvider: LLMProvider;
  private sessions = new Map<string, Session>();
  private activeSession: Session | null = null;
  private injectables: ContextInjectable[] = [];
  private toolRegistry: ToolRegistry;
  private tools: ToolDefinition[] = [];
  private model?: string;
  private maxTokens: number;
  private sessionStore?: SessionStore;

  private readonly log: Logger;
  private readonly events: EventBus;

  /** Session events are defined in the domain; ShitsujiEvents extends them, so the cast is exact. */
  private readonly forwardSessionEvent: SessionObserver = (type, payload) =>
    this.events.publish(type, payload as ShitsujiEvents[typeof type], { source: 'session' });

  constructor(options: AgentOptions) {
    this.log = options.log;
    this.events = options.events;
    this.id = options.id ?? randomUUID();
    this.name = options.name;
    this.llmProvider = options.llmProvider;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 32000;
    this.sessionStore = options.sessionStore;
    this.toolRegistry = new ToolRegistry(this.log);

    this.setupDefaultInjectables();
    this.log.info(`Agent created: ${this.name} (${this.id})`);
  }

  private setupDefaultInjectables(): void {
    this.injectables.push(
      new IdentityInjectable({
        name: this.name,
        description: 'a helpful AI assistant',
      }),
    );

    this.injectables.push(new ToolListInjectable([]));

    this.injectables.push(
      new RulesInjectable([
        { id: 'helpful', text: 'Be helpful and concise' },
        { id: 'safe', text: 'Do not reveal sensitive information' },
      ]),
    );

    this.injectables.sort((a, b) => b.priority - a.priority);
  }

  addInjectable(injectable: ContextInjectable): void {
    this.injectables.push(injectable);
    this.injectables.sort((a, b) => b.priority - a.priority);
  }

  /** The tools this agent can call. */
  getTools(): Tool[] {
    return this.toolRegistry.list();
  }

  registerTool(tool: Tool): void {
    this.toolRegistry.register(tool);
    this.tools = this.toolRegistry.getToolDefinitions();
    this.updateToolListInjectable();
  }

  setTools(tools: ToolDefinition[]): void {
    this.tools = tools;
    this.updateToolListInjectable();
  }

  private updateToolListInjectable(): void {
    this.injectables = this.injectables.filter((i) => i.id !== 'tool-list');
    this.injectables.push(new ToolListInjectable(this.tools));
    this.injectables.sort((a, b) => b.priority - a.priority);
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  createSession(sessionId?: string): Session {
    const session = new Session({
      id: sessionId,
      agentId: this.id,
      maxTokens: this.maxTokens,
      store: this.sessionStore,
      observer: this.forwardSessionEvent,
    });
    this.sessions.set(session.id, session);
    this.activeSession = session;
    this.log.info(`Session created: ${session.id} for agent ${this.name}`);
    return session;
  }

  async send(message: string, sessionId?: string): Promise<string> {
    let session: Session;

    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      session = this.createSession(sessionId);
    }

    this.activeSession = session;
    session.addUserMessage(message);

    return this.runLoop(session);
  }

  private async runLoop(session: Session): Promise<string> {
    let continueLoop = true;
    let finalResponse = '';

    while (continueLoop) {
      const response = await this.callLLM(session);

      session.addAssistantMessage(response.content, response.toolCalls);

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const toolCall of response.toolCalls) {
          const result = await this.executeTool(session, toolCall);
          session.addToolMessage(toolCall.id, result);
        }
        continueLoop = true;
      } else {
        finalResponse = response.content;
        continueLoop = false;
      }
    }

    return finalResponse;
  }

  private async callLLM(session: Session): Promise<ReturnType<LLMProvider['complete']>> {
    const contextStr = this.buildContext(session);
    const recentMessages = session.getRecentMessages(20);

    const messages: Message[] = [
      { id: randomUUID(), role: 'system', content: contextStr, timestamp: Date.now() },
      ...recentMessages,
    ];

    const options: LLMCompletionOptions = {
      model: this.model,
      messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
      temperature: 0.7,
      maxTokens: 4096,
    };

    this.events.publish('llm.request', {
      agentId: this.id,
      sessionId: session.id,
      model: options.model,
    });

    try {
      const response = await this.llmProvider.complete(options);

      this.events.publish('llm.response', {
        agentId: this.id,
        sessionId: session.id,
        contentLength: response.content.length,
        hasToolCalls: !!response.toolCalls?.length,
      });

      return response;
    } catch (error) {
      this.events.publish('llm.error', {
        agentId: this.id,
        sessionId: session.id,
        error: String(error),
      });
      throw error;
    }
  }

  private buildContext(session: Session): string {
    return this.injectables
      .filter((injectable) => this.checkCondition(injectable, session))
      .map((injectable) => injectable.render({ session }))
      .filter((s): s is string => s !== null)
      .join('\n\n');
  }

  private checkCondition(injectable: ContextInjectable, session: Session): boolean {
    const condition = injectable.condition;

    if (condition.type === 'always') {
      return true;
    }

    if (condition.type === 'tool_used') {
      const lastMessage = session.messages[session.messages.length - 1];
      if (lastMessage?.role === 'assistant' && lastMessage.toolName) {
        return (
          condition.toolNames.length === 0 || condition.toolNames.includes(lastMessage.toolName)
        );
      }
      return false;
    }

    if (condition.type === 'pattern_detected') {
      const lastUserMsg = session.messages.filter((m) => m.role === 'user').pop();
      if (lastUserMsg) {
        return condition.patterns.some((p) => p.test(lastUserMsg.content));
      }
      return false;
    }

    if (condition.type === 'custom') {
      return condition.check({ session });
    }

    return false;
  }

  private async executeTool(
    session: Session,
    toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  ): Promise<string> {
    this.events.publish('tool.called', {
      sessionId: session.id,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
    });

    this.log.info(`Executing tool: ${toolCall.name}`);

    try {
      const result = await this.toolRegistry.execute(toolCall.name, {
        sessionId: session.id,
        args: toolCall.arguments,
      });

      this.events.publish('tool.result', {
        sessionId: session.id,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        success: result.success,
      });

      return result.success ? result.result : `Error: ${result.error}`;
    } catch (error) {
      const errorMsg = String(error);

      this.events.publish('tool.error', {
        sessionId: session.id,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        error: errorMsg,
      });

      return `Error: ${errorMsg}`;
    }
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.end();
      this.sessions.delete(sessionId);
      if (this.activeSession?.id === sessionId) {
        this.activeSession = null;
      }
    }
  }

  getSessions(): Session[] {
    return Array.from(this.sessions.values());
  }
}
