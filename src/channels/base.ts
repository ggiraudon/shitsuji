export interface ChannelMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelOptions {
  name: string;
}

export interface Channel {
  readonly name: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  send(destination: string, message: string): Promise<void>;

  onMessage(handler: (message: ChannelMessage, destination: string) => void): void;
  onError(handler: (error: Error) => void): void;
}

export abstract class BaseChannel implements Channel {
  abstract readonly name: string;
  protected messageHandlers: ((message: ChannelMessage, destination: string) => void)[] = [];
  protected errorHandlers: ((error: Error) => void)[] = [];
  protected running = false;

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  abstract send(destination: string, message: string): Promise<void>;

  onMessage(handler: (message: ChannelMessage, destination: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  protected emitMessage(message: ChannelMessage, destination: string): void {
    for (const handler of this.messageHandlers) {
      handler(message, destination);
    }
  }

  protected emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
