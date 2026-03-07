export type Topic = 
  | 'agent.start'
  | 'agent.stop'
  | 'agent.reset'
  | 'message.received'
  | 'message.sent'
  | 'message.error'
  | 'llm.request'
  | 'llm.response'
  | 'llm.chunk'
  | 'llm.error'
  | 'tool.called'
  | 'tool.start'
  | 'tool.result'
  | 'tool.error'
  | 'session.created'
  | 'session.updated'
  | 'session.ended'
  | 'system.error'
  | 'system.ready';

export interface Message<T = unknown> {
  topic: Topic;
  payload: T;
  timestamp: number;
  source?: string;
  traceId?: string;
}

export type MessageHandler<T = unknown> = (payload: T) => void;

export class MessageBus {
  private handlers = new Map<Topic, Set<MessageHandler>>();
  private messageHistory: Message[] = [];
  private maxHistory = 100;

  publish<T>(topic: Topic, payload: T, source?: string, traceId?: string): void {
    const message: Message<T> = {
      topic,
      payload,
      timestamp: Date.now(),
      source,
      traceId,
    };

    this.messageHistory.push(message as Message);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory.shift();
    }

    const topicHandlers = this.handlers.get(topic);
    if (topicHandlers) {
      for (const handler of topicHandlers) {
        try {
          handler(payload);
        } catch (error) {
          this.publish('system.error', { error, topic, payload });
        }
      }
    }
  }

  subscribe<T>(topic: Topic, handler: MessageHandler<T>): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
    }
    this.handlers.get(topic)!.add(handler as MessageHandler);

    return () => {
      this.handlers.get(topic)?.delete(handler as MessageHandler);
    };
  }

  subscribeMany(topics: Topic[], handler: (topic: Topic, payload: unknown) => void): () => void {
    const unsubscribers = topics.map(topic => this.subscribe(topic, (payload) => handler(topic, payload)));
    return () => unsubscribers.forEach(unsub => unsub());
  }

  getSubscribers(topic: Topic): number {
    return this.handlers.get(topic)?.size ?? 0;
  }

  getHistory(topic?: Topic): Message[] {
    if (topic) {
      return this.messageHistory.filter(m => m.topic === topic);
    }
    return [...this.messageHistory];
  }

  clear(): void {
    this.handlers.clear();
    this.messageHistory = [];
  }
}

export const messageBus = new MessageBus();
