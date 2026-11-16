import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod/v4';
import { PlainTextRenderer } from './PlainTextRenderer.js';
import type {
  ChannelCapabilities,
  ChannelTarget,
  DeliveryReceipt,
  InboundMessage,
  InboundSink,
  OutboundMessage,
} from '../../ports/ChannelAdapter.js';
import { BaseChannelAdapter } from '../../ports/ChannelAdapter.js';
import type { Logger } from '../../ports/Logger.js';

const webhookBody = z
  .object({
    id: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
    destination: z.string().min(1).max(200).default('default'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((body) => Boolean(body.content ?? body.message), {
    message: 'content or message is required',
  });

export interface WebhookChannelOptions {
  /** 127.0.0.1 by default, so only this machine can reach it; Compose sets 0.0.0.0 in the container. */
  host?: string;
  port?: number;
  path?: string;
  /**
   * Checks the key from `Authorization: Bearer <key>`. Required: a POST talks to Shitsuji as the owner
   * and gets the reply back, so it needs the owner key like the API does (#34).
   */
  authorize: (key: string | undefined) => boolean;
  /** How long a POST waits for the turn's reply before answering "pending". */
  replyTimeoutMs?: number;
}

interface PendingRequest {
  messageId: string;
  timer: NodeJS.Timeout;
  respond(body: unknown, status: number): void;
}

/**
 * An HTTP endpoint that turns a POST into an inbound message and answers with the reply. The old
 * channel only printed replies (bug 5); this one holds the request open until the turn's reply is
 * delivered, or answers 202 when it takes too long. A reply with no waiting request (a background
 * turn, or a request that timed out) cannot be delivered and is logged (F06, S30).
 *
 * A POST speaks as the owner and reads the answer, so it needs the owner key, and the server listens
 * on 127.0.0.1 unless the host is set (#34).
 */
export class WebhookChannelAdapter extends BaseChannelAdapter {
  readonly id = 'webhook';
  readonly capabilities: ChannelCapabilities = {
    markdown: 'basic',
    buttons: false,
    files: false,
    images: false,
    voice: false,
    edits: false,
    maxMessageLength: 100_000,
  };

  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private readonly replyTimeoutMs: number;
  private readonly authorize: (key: string | undefined) => boolean;
  private readonly renderer = new PlainTextRenderer();
  private readonly pending = new Map<string, PendingRequest[]>();
  private server: Server | null = null;
  private actualPort?: number;

  constructor(
    private readonly log: Logger,
    options: WebhookChannelOptions,
  ) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.authorize = options.authorize;
    this.port = options.port ?? 3000;
    this.path = options.path ?? '/webhook';
    this.replyTimeoutMs = options.replyTimeoutMs ?? 60_000;
  }

  override async start(sink: InboundSink): Promise<void> {
    await super.start(sink);
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off('error', reject);
        this.actualPort = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
    this.log.info('Webhook channel started', {
      host: this.host,
      port: this.actualPort,
      path: this.path,
    });
  }

  override async stop(): Promise<void> {
    for (const queue of this.pending.values()) {
      for (const pending of queue) {
        clearTimeout(pending.timer);
        pending.respond({ success: false, error: 'stopping' }, 503);
      }
    }
    this.pending.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await super.stop();
    this.log.info('Webhook channel stopped');
  }

  async deliver(target: ChannelTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    const rendered = this.renderer.render(message, this.capabilities);
    const pending = this.pending.get(target.chatId)?.shift();
    if (!pending) {
      this.log.warn('Webhook reply has no waiting request', {
        intent: message.intent,
        length: rendered.text.length,
      });
      return { delivered: false, reason: 'no waiting request' };
    }
    pending.respond(
      {
        success: true,
        messageId: pending.messageId,
        reply: rendered.text,
        intent: message.intent,
      },
      200,
    );
    return { delivered: true, externalId: pending.messageId };
  }

  /** The port it listens on; useful when constructed with port 0. */
  getPort(): number {
    return this.actualPort ?? this.port;
  }

  /** The address it listens on. */
  getHost(): string {
    return this.host;
  }

  getUrl(): string {
    return `http://localhost:${this.getPort()}${this.path}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/') {
      return this.json(res, 200, {
        service: 'Shitsuji webhook channel',
        status: 'running',
        endpoints: { webhook: this.path, health: '/health' },
      });
    }
    if (req.method === 'GET' && url === '/health') {
      return this.json(res, 200, { status: 'ok' });
    }
    if (req.method !== 'POST' || url !== this.path) {
      return this.json(res, 404, { error: 'Not found' });
    }
    // Checked before the body is read: without the key nothing reaches the core (#34).
    const header = req.headers.authorization;
    const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!this.authorize(key)) {
      req.resume();
      return this.json(res, 401, { error: 'Missing or wrong owner key' });
    }

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (error) {
      return this.json(res, 413, { error: (error as Error).message });
    }
    const parsed = webhookBody.safeParse(safeJson(body));
    if (!parsed.success) {
      return this.json(res, 400, {
        error: 'Invalid body',
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    if (!this.sink) {
      return this.json(res, 503, { error: 'Channel is not running' });
    }

    const data = parsed.data;
    const messageId = data.id ?? randomUUID();
    const inbound: InboundMessage = {
      channel: this.id,
      chatId: data.destination,
      text: data.content ?? data.message ?? '',
      externalId: messageId,
      receivedAt: new Date(),
      ...(data.metadata && { metadata: data.metadata }),
    };

    await new Promise<void>((resolve) => {
      let done = false;
      const respond = (payload: unknown, status: number) => {
        if (done) return;
        done = true;
        this.json(res, status, payload);
        resolve();
      };
      const timer = setTimeout(() => {
        this.removeByMessageId(data.destination, messageId);
        respond({ success: true, messageId, pending: true }, 202);
      }, this.replyTimeoutMs);
      timer.unref();
      const pending: PendingRequest = { messageId, timer, respond };
      this.enqueue(data.destination, pending);

      this.sink!.receive(inbound).catch((error: unknown) => {
        this.log.error('Webhook message failed', {
          error: { name: (error as Error)?.name, message: (error as Error)?.message },
        });
        this.removeByMessageId(data.destination, messageId);
        respond({ success: false, error: (error as Error)?.message ?? 'Message failed' }, 500);
      });
    });
  }

  private enqueue(chatId: string, pending: PendingRequest): void {
    const queue = this.pending.get(chatId) ?? [];
    queue.push(pending);
    this.pending.set(chatId, queue);
  }

  private removeByMessageId(chatId: string, messageId: string): void {
    const queue = this.pending.get(chatId);
    if (!queue) return;
    const at = queue.findIndex((pending) => pending.messageId === messageId);
    if (at !== -1) queue.splice(at, 1);
    if (!queue.length) this.pending.delete(chatId);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new Error('Body is larger than 1 MB');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
