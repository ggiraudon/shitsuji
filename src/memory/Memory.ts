import { type Message } from '../llm/types.js';

export interface MemoryOptions {
  maxMessages?: number;
}

export interface MemoryEntry {
  id: string;
  type: 'message' | 'fact' | 'summary';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export class Memory {
  private entries: MemoryEntry[] = [];
  private maxMessages: number;

  constructor(options: MemoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 100;
  }

  addMessage(role: Message['role'], content: string, metadata?: Record<string, unknown>): void {
    this.entries.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: 'message',
      content: `[${role}] ${content}`,
      timestamp: Date.now(),
      metadata,
    });
    this.prune();
  }

  addFact(fact: string, metadata?: Record<string, unknown>): void {
    this.entries.push({
      id: `${Date.now()}-fact`,
      type: 'fact',
      content: fact,
      timestamp: Date.now(),
      metadata,
    });
  }

  addSummary(summary: string): void {
    this.entries.push({
      id: `${Date.now()}-summary`,
      type: 'summary',
      content: summary,
      timestamp: Date.now(),
    });
  }

  getRecent(count: number = 10): MemoryEntry[] {
    return this.entries.slice(-count);
  }

  getAll(): MemoryEntry[] {
    return [...this.entries];
  }

  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return this.entries.filter((e) => e.content.toLowerCase().includes(lower));
  }

  clear(): void {
    this.entries = [];
  }

  private prune(): void {
    if (this.entries.length > this.maxMessages) {
      const summary = this.summarize(this.entries.slice(0, -this.maxMessages));
      this.entries = [
        ...this.entries.slice(-this.maxMessages),
        {
          id: `${Date.now()}-pruned-summary`,
          type: 'summary',
          content: `Earlier messages summarized: ${summary}`,
          timestamp: Date.now(),
        },
      ];
    }
  }

  private summarize(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';
    const messageCount = entries.filter((e) => e.type === 'message').length;
    const factCount = entries.filter((e) => e.type === 'fact').length;
    return `${messageCount} messages, ${factCount} facts`;
  }

  toJSON() {
    return this.entries;
  }

  static fromJSON(data: MemoryEntry[]): Memory {
    const mem = new Memory();
    mem.entries = data;
    return mem;
  }
}
