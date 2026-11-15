import { BaseChannel, type ChannelMessage } from '../../ports/Channel.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { randomUUID } from 'crypto';
import type { Logger } from '../../ports/Logger.js';

export interface WebhookChannelOptions {
  port?: number;
  path?: string;
}

export class WebhookChannel extends BaseChannel {
  readonly name = 'webhook';
  private port: number;
  private path: string;
  private server: Server | null = null;

  constructor(
    private readonly log: Logger,
    options: WebhookChannelOptions = {},
  ) {
    super();
    this.port = options.port ?? 3000;
    this.path = options.path ?? '/webhook';
  }

  override async start(): Promise<void> {
    await super.start();

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      if (url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            service: 'Shitsuji Webhook Channel',
            status: 'running',
            endpoints: {
              webhook: this.path,
              health: '/health',
            },
          }),
        );
        return;
      }

      if (url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url === this.path && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const data = JSON.parse(body);

            const message: ChannelMessage = {
              id: data.id ?? randomUUID(),
              role: data.role ?? 'user',
              content: data.content ?? data.message ?? '',
              timestamp: Date.now(),
              metadata: data.metadata,
            };

            const destination = data.destination ?? 'default';
            this.emitMessage(message, destination);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, messageId: message.id }));
          } catch (error) {
            this.emitError(error as Error);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: String(error) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    this.server.listen(this.port, () => {
      this.log.info(`Webhook Channel started on port ${this.port}`);
    });
  }

  override async stop(): Promise<void> {
    await super.stop();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.log.info('Webhook Channel stopped');
  }

  async send(_destination: string, message: string): Promise<void> {
    console.log(`[Webhook] ${message}`);
  }

  getPort(): number {
    return this.port;
  }

  getUrl(): string {
    return `http://localhost:${this.port}${this.path}`;
  }
}
