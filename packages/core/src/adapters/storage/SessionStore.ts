import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { type Session } from '../../domain/Session.js';
import { type Message } from '../../ports/LLMProvider.js';
import { logger } from '../logging/logger.js';

export interface SessionData {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  memory: Record<string, string>;
}

export class SessionStore {
  private storeDir: string;
  private sessions = new Map<string, SessionData>();

  constructor(storeDir: string) {
    this.storeDir = storeDir;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true });
    }
  }

  save(session: Session): void {
    const data: SessionData = {
      id: session.id,
      agentId: session.agentId,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messages: session.messages,
      memory: Object.fromEntries(session.memory),
    };

    const filePath = join(this.storeDir, `${session.id}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    this.sessions.set(session.id, data);
    logger.debug(`Session saved: ${session.id}`);
  }

  load(sessionId: string): SessionData | null {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const filePath = join(this.storeDir, `${sessionId}.json`);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as SessionData;
      this.sessions.set(sessionId, data);
      return data;
    } catch (error) {
      logger.error(`Failed to load session ${sessionId}`, { error: String(error) });
      return null;
    }
  }

  delete(sessionId: string): void {
    const filePath = join(this.storeDir, `${sessionId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    this.sessions.delete(sessionId);
    logger.debug(`Session deleted: ${sessionId}`);
  }

  list(): SessionData[] {
    const files = readdirSync(this.storeDir).filter((f) => f.endsWith('.json'));
    const sessions: SessionData[] = [];

    for (const file of files) {
      const sessionId = file.replace('.json', '');
      const data = this.load(sessionId);
      if (data) {
        sessions.push(data);
      }
    }

    return sessions;
  }

  exists(sessionId: string): boolean {
    if (this.sessions.has(sessionId)) {
      return true;
    }
    return existsSync(join(this.storeDir, `${sessionId}.json`));
  }
}
