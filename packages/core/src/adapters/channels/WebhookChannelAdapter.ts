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
import type { TurnId } from '../../domain/model/ids.js';

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

/** How the webhook listens and who may post: everything with a safe default except the key check. */
export interface WebhookChannelOptions {
  /** 127.0.0.1 by default, so only this machine can reach it; Compose sets 0.0.0.0 in the container. */
  host?: string;
  /** The port to listen on; 3000 by default, 0 asks the OS for a free one. */
  port?: number;
  /** The path a POST answers on; `/webhook` by default. */
  path?: string;
  /**
   * Checks the key from `Authorization: Bearer <key>`. Required: a POST talks to Shitsuji as the owner
   * and gets the reply back, so it needs the owner key like the API does (#34).
   */
  authorize: (key: string | undefined) => boolean;
  /** How long a POST waits for the turn's reply before answering "pending". */
  replyTimeoutMs?: number;
}

/** One in-flight POST, waiting for the reply it should return. */
interface PendingRequest {
  /** The id the caller sent (or one we made), echoed in the response. */
  messageId: string;
  /** The destination the request was queued under, until a turn takes it. */
  chatId: string;
  /** The timeout that answers 202 when the reply takes too long. */
  timer: NodeJS.Timeout;
  /** Writes the response once; later calls are ignored. */
  respond(body: unknown, status: number): void;
  /** The turn this request was steered into, once receive() returns it (#35). */
  turnId?: TurnId;
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

  /** The interface to bind; `127.0.0.1` unless the config widens it. */
  private readonly host: string;
  /** The configured port, before the OS picks one. */
  private readonly port: number;
  /** The path a POST answers on. */
  private readonly path: string;
  /** How long a POST waits for its reply before 202. */
  private readonly replyTimeoutMs: number;
  /** The owner-key check; a POST without it is refused before its body is read. */
  private readonly authorize: (key: string | undefined) => boolean;
  /** Degrades the reply to plain text, since the webhook client only reads text. */
  private readonly renderer = new PlainTextRenderer();
  /** Every in-flight request by its message id. */
  private readonly waiting = new Map<string, PendingRequest>();
  /** Plain replies (commands) still use the destination queue. */
  private readonly byDestination = new Map<string, PendingRequest[]>();
  /** Requests waiting on a particular turn; steering puts several here (#35). */
  private readonly byTurn = new Map<TurnId, PendingRequest[]>();
  /** The HTTP server while it runs; null before `start` and after `stop`. */
  private server: Server | null = null;
  /** The port the OS actually bound, when `port` was 0. */
  private actualPort?: number;

  constructor(
    /** Structured logger for startup, delivery misses and failed messages. */
    private readonly log: Logger,
    /** The address, key check and timeout; the composition root builds them from config. */
    options: WebhookChannelOptions,
  ) {
    super();
    this.host = options.host ?? '127.0.0.1';
    this.authorize = options.authorize;
    this.port = options.port ?? 3000;
    this.path = options.path ?? '/webhook';
    this.replyTimeoutMs = options.replyTimeoutMs ?? 60_000;
  }

  /** Opens the HTTP server and records the port the OS bound. */
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

  /** Answers every in-flight POST with 503, closes the server, then clears the adapter's state. */
  override async stop(): Promise<void> {
    for (const pending of [...this.waiting.values()]) {
      clearTimeout(pending.timer);
      pending.respond({ success: false, error: 'stopping' }, 503);
    }
    this.waiting.clear();
    this.byDestination.clear();
    this.byTurn.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await super.stop();
    this.log.info('Webhook channel stopped');
  }

  /**
   * Answers every request waiting on `target.turnId`, so a message steered into a running turn gets
   * that turn's reply instead of the next request in the queue (#35). A delivery without a turn id (a
   * command answered by the gateway) uses the destination queue.
   */
  async deliver(target: ChannelTarget, message: OutboundMessage): Promise<DeliveryReceipt> {
    const rendered = this.renderer.render(message, this.capabilities);
    const waiters = target.turnId
      ? this.takeTurn(target.turnId)
      : this.takeDestination(target.chatId);
    if (!waiters.length) {
      this.log.warn('Webhook reply has no waiting request', {
        intent: message.intent,
        length: rendered.text.length,
      });
      return { delivered: false, reason: 'no waiting request' };
    }
    let first: string | undefined;
    for (const pending of waiters) {
      clearTimeout(pending.timer);
      pending.respond(
        {
          success: true,
          messageId: pending.messageId,
          reply: rendered.text,
          intent: message.intent,
        },
        200,
      );
      first ??= pending.messageId;
    }
    return first === undefined ? { delivered: true } : { delivered: true, externalId: first };
  }

  /** The port it listens on; useful when constructed with port 0. */
  getPort(): number {
    return this.actualPort ?? this.port;
  }

  /** The address it listens on. */
  getHost(): string {
    return this.host;
  }

  /** The URL a POST goes to; `localhost` because the webhook is a local interface. */
  getUrl(): string {
    return `http://localhost:${this.getPort()}${this.path}`;
  }

  /**
   * The HTTP handler: health and info on GET, the message on POST. It checks the key before reading
   * the body and holds the response until `deliver` answers it.
   */
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
        this.remove(pending);
        respond({ success: true, messageId, pending: true }, 202);
      }, this.replyTimeoutMs);
      timer.unref();
      const pending: PendingRequest = { messageId, chatId: data.destination, timer, respond };
      this.waiting.set(messageId, pending);
      this.enqueue(data.destination, pending);

      this.sink!.receive(inbound).then(
        (result) => {
          if (result.kind === 'turn') {
            this.attachToTurn(pending, result.turnId);
            return;
          }
          if (result.kind !== 'ignored') return;
          this.remove(pending);
          respond({ success: false, ignored: true, reason: result.reason }, 403);
        },
        (error: unknown) => {
          this.log.error('Webhook message failed', {
            error: { name: (error as Error)?.name, message: (error as Error)?.message },
          });
          this.remove(pending);
          respond({ success: false, error: (error as Error)?.message ?? 'Message failed' }, 500);
        },
      );
    });
  }

  /** Moves a request from the destination queue to its turn's queue, so the steer's reply answers it. */
  private attachToTurn(pending: PendingRequest, turnId: TurnId): void {
    pending.turnId = turnId;
    this.removeFromDestination(pending);
    const queue = this.byTurn.get(turnId) ?? [];
    queue.push(pending);
    this.byTurn.set(turnId, queue);
  }

  /** Appends a request to its destination's queue, for a reply that carries no turn id. */
  private enqueue(chatId: string, pending: PendingRequest): void {
    const queue = this.byDestination.get(chatId) ?? [];
    queue.push(pending);
    this.byDestination.set(chatId, queue);
  }

  /** Takes every request waiting on a turn; one reply reaches all of them. */
  private takeTurn(turnId: TurnId): PendingRequest[] {
    const queue = this.byTurn.get(turnId) ?? [];
    this.byTurn.delete(turnId);
    for (const pending of queue) this.waiting.delete(pending.messageId);
    return queue;
  }

  /** Takes the oldest request waiting on a destination; a reply without a turn id answers one. */
  private takeDestination(chatId: string): PendingRequest[] {
    const queue = this.byDestination.get(chatId);
    if (!queue?.length) return [];
    const pending = queue.shift()!;
    if (!queue.length) this.byDestination.delete(chatId);
    this.waiting.delete(pending.messageId);
    return [pending];
  }

  /** Forgets a request everywhere: the main map, its destination queue and its turn queue. */
  private remove(pending: PendingRequest): void {
    this.waiting.delete(pending.messageId);
    clearTimeout(pending.timer);
    this.removeFromDestination(pending);
    if (pending.turnId) {
      const queue = this.byTurn.get(pending.turnId);
      if (queue) {
        const at = queue.indexOf(pending);
        if (at !== -1) queue.splice(at, 1);
        if (!queue.length) this.byTurn.delete(pending.turnId);
      }
    }
  }

  /** Removes a request from its destination queue, dropping the queue when it empties. */
  private removeFromDestination(pending: PendingRequest): void {
    const queue = this.byDestination.get(pending.chatId ?? '');
    if (!queue) return;
    const at = queue.indexOf(pending);
    if (at !== -1) queue.splice(at, 1);
    if (!queue.length) this.byDestination.delete(pending.chatId ?? '');
  }

  /** Reads the body as UTF-8, refusing anything over 1 MB. */
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

  /** Writes a JSON response once; a response already ended is left alone. */
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
