import { Message, ToolCall, ToolResult } from '../llm/types.js';
import { logger } from '../utils/logger.js';
import { messageBus, Topic } from '../core/MessageBus.js';
import { randomUUID } from 'crypto';

export interface SessionOptions {
  id?: string;
  agentId: string;
  maxTokens?: number;
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

  constructor(options: SessionOptions) {
    this.id = options.id ?? randomUUID();
    this.agentId = options.agentId;
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.maxTokens = options.maxTokens ?? 32000;

    messageBus.publish('session.created', { sessionId: this.id, agentId: this.agentId });
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
    messageBus.publish('message.sent', { sessionId: this.id, role: 'tool', isError });
    return message;
  }

  private addMessage(message: Message): Message {
    this.messages.push(message);
    this.updatedAt = new Date();
    
    const topic: Topic = message.role === 'user' ? 'message.received' : 'message.sent';
    messageBus.publish(topic, { 
      sessionId: this.id, 
      role: message.role,
      content: message.content,
    });
    
    return message;
  }

  remember(key: string, value: string): void {
    this.memory.set(key, value);
    messageBus.publish('session.updated', { 
      sessionId: this.id, 
      action: 'remember',
      key, 
      value,
    });
    logger.debug(`Session ${this.id} remembered: ${key}`);
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
        .map(m => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Tool'}: ${m.content}`)
        .join('\n');
      parts.push(`Recent conversation:\n${msgStr}`);
    }

    return parts.join('\n\n');
  }

  end(): void {
    messageBus.publish('session.ended', { sessionId: this.id });
    logger.info(`Session ${this.id} ended`);
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
