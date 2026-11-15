import { type Message, type ToolCall } from '../ports/LLMProvider.js';
import { type SessionStore } from '../adapters/storage/SessionStore.js';
import { randomUUID } from 'crypto';

/** Events a session emits. The application layer forwards them (for example to the EventBus). */
export interface SessionEventMap {
  'session.created': { sessionId: string; agentId: string };
  'session.updated': { sessionId: string; action: string; key?: string; value?: string };
  'session.ended': { sessionId: string };
  'message.received': { sessionId: string; role: string; content: string };
  'message.sent': { sessionId: string; role: string; content?: string; isError?: boolean };
}

export type SessionObserver = <K extends keyof SessionEventMap>(
  type: K,
  payload: SessionEventMap[K],
) => void;

export interface SessionOptions {
  id?: string;
  agentId: string;
  maxTokens?: number;
  store?: SessionStore;
  observer?: SessionObserver;
}

export class Session {
  readonly id: string;
  readonly agentId: string;
  readonly createdAt: Date;
  updatedAt: Date;

  messages: Message[] = [];
  memory: Map<string, string> = new Map();
  maxTokens: number;

  private tokenCount = 0;
  private store?: SessionStore;
  private readonly notify: SessionObserver;

  constructor(options: SessionOptions) {
    this.id = options.id ?? randomUUID();
    this.agentId = options.agentId;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.maxTokens = options.maxTokens ?? 32000;
    this.store = options.store;
    this.notify = options.observer ?? (() => {});

    if (this.store && this.store.exists(this.id)) {
      this.load();
    }

    this.notify('session.created', { sessionId: this.id, agentId: this.agentId });
  }

  addUserMessage(content: string): Message {
    const message: Message = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    return this.addMessage(message);
  }

  addAssistantMessage(content: string, toolCalls?: ToolCall[]): Message {
    const message: Message = {
      id: randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      toolCalls,
    };
    return this.addMessage(message);
  }

  addToolMessage(toolCallId: string, result: string, isError = false): Message {
    const message: Message = {
      id: randomUUID(),
      role: 'tool',
      content: result,
      toolCallId,
      timestamp: Date.now(),
    };
    this.messages.push(message);
    this.notify('message.sent', { sessionId: this.id, role: 'tool', isError });
    return message;
  }

  private addMessage(message: Message): Message {
    this.messages.push(message);
    this.updatedAt = new Date();

    const topic: 'message.received' | 'message.sent' =
      message.role === 'user' ? 'message.received' : 'message.sent';
    this.notify(topic, {
      sessionId: this.id,
      role: message.role,
      content: message.content,
    });

    return message;
  }

  remember(key: string, value: string): void {
    this.memory.set(key, value);
    this.notify('session.updated', {
      sessionId: this.id,
      action: 'remember',
      key,
      value,
    });
  }

  recall(key: string): string | undefined {
    return this.memory.get(key);
  }

  getRecentMessages(maxMessages = 20): Message[] {
    return this.messages.slice(-maxMessages);
  }

  renderForContext(): string {
    const parts: string[] = [];

    if (this.memory.size > 0) {
      const memEntries = Array.from(this.memory.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      parts.push(`Session memory:\n${memEntries}`);
    }

    const recentMsgs = this.getRecentMessages(10);
    if (recentMsgs.length > 0) {
      const msgStr = recentMsgs
        .map(
          (m) =>
            `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Tool'}: ${m.content}`,
        )
        .join('\n');
      parts.push(`Recent conversation:\n${msgStr}`);
    }

    return parts.join('\n\n');
  }

  end(): void {
    this.save();
    this.notify('session.ended', { sessionId: this.id });
  }

  save(): void {
    if (this.store) {
      this.store.save(this);
    }
  }

  private load(): void {
    if (!this.store) return;

    const data = this.store.load(this.id);
    if (data) {
      this.messages = data.messages;
      this.memory = new Map(Object.entries(data.memory));
      this.updatedAt = new Date(data.updatedAt);
    }
  }

  toJSON() {
    return {
      id: this.id,
      agentId: this.agentId,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      messageCount: this.messages.length,
      memory: Object.fromEntries(this.memory),
    };
  }
}
