import { BaseChannel, ChannelMessage } from './base.js';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

export class CLIChannel extends BaseChannel {
  readonly name = 'cli';
  private rl: readline.Interface | null = null;
  private prompt = '> ';
  private messageHandler: ((message: ChannelMessage, destination: string) => void) | null = null;

  async start(): Promise<void> {
    await super.start();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    logger.info('CLI Channel started');
    this.startInputLoop();
  }

  async stop(): Promise<void> {
    await super.stop();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    logger.info('CLI Channel stopped');
  }

  async send(_destination: string, message: string): Promise<void> {
    console.log(`\n${message}\n`);
    if (this.isRunning()) {
      this.promptUser();
    }
  }

  onMessage(handler: (message: ChannelMessage, destination: string) => void): void {
    super.onMessage(handler);
    this.messageHandler = handler;
  }

  private startInputLoop(): void {
    this.promptUser();
  }

  private promptUser(): void {
    if (!this.rl || !this.isRunning()) return;

    this.rl.question(this.prompt, (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        this.promptUser();
        return;
      }

      if (trimmed === '/exit' || trimmed === '/quit') {
        this.stop();
        process.exit(0);
        return;
      }

      if (trimmed === '/help') {
        console.log(`
Available commands:
  /help  - Show this help
  /exit  - Exit the program
  /quit  - Exit the program
`);
        this.promptUser();
        return;
      }

      const message: ChannelMessage = {
        id: randomUUID(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      };

      this.emitMessage(message, 'cli');
      this.promptUser();
    });
  }
}
