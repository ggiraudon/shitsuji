import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Agent } from '../../application/Agent.js';
import type { SoulService } from '../../application/soul/SoulService.js';
import { SoulEditChanged, SoulNoPendingEdit } from '../../domain/model/Soul.js';
import { asId, type OwnerId, type SessionId, type TurnId } from '../../domain/model/ids.js';
import { textOf, toolCallsOf, type Message } from '../../domain/model/Message.js';
import type { Clock } from '../../ports/Clock.js';
import type { InboundMessage, InboundResult } from '../../ports/ChannelAdapter.js';
import type { EventBus } from '../../ports/EventBus.js';
import type { Logger } from '../../ports/Logger.js';
import type { Repositories, TurnEvent } from '../../ports/Repositories.js';
import {
  LIVE_EVENT_TYPES,
  confirmSoulBody,
  postMessageBody,
  type ActivityReceiptDto,
  type ActivityResponse,
  type ConfirmSoulResponse,
  type LiveEvent,
  type MessageDto,
  type PostMessageResponse,
  type SoulDto,
  type TurnDto,
  type UsageDto,
} from './contract.js';

export interface ApiDeps {
  agent: Agent;
  repos: Repositories;
  events: EventBus;
  clock: Clock;
  log: Logger;
  ownerId: OwnerId;
  /** The assembled SOUL: reading it and confirming an edit of its export (S23). */
  soul: SoulService;
  /**
   * How an API message reaches the runtime. Defaults to agent.submit; the composition can pass the
   * same sink the channel adapters use (S30), so both entry points share the inbound model.
   */
  receive?: (message: InboundMessage) => Promise<InboundResult>;
  /** Checks the owner key (decision Q3). */
  verifyKey: (key: string | undefined) => boolean;
  /** Builds the WebSocket upgrade for this app (@hono/node-ws); omitted in tests that only use REST. */
  webSocket?: (app: Hono) => UpgradeWebSocket;
}

const TICKET_TTL_MS = 30_000;

/**
 * The HTTP API (Hono): REST for reads and commands, one WebSocket for live events. Every route except
 * /api/health needs `Authorization: Bearer <owner key>`. Browsers and Node's WebSocket client cannot
 * send that header on a WebSocket, so a client first gets a single-use ticket over REST.
 */
export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();
  const tickets = new Map<string, number>(); // ticket -> expiry

  app.onError((error, c) => {
    deps.log.error('API error', { path: c.req.path, error: { message: error.message } });
    return c.json({ error: error.message }, 500);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/events') return next();
    const header = c.req.header('authorization');
    const key = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!deps.verifyKey(key)) return c.json({ error: 'Missing or wrong owner key' }, 401);
    return next();
  });

  app.post('/api/messages', async (c) => {
    const parsed = postMessageBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', issues: parsed.error.issues.map((i) => i.message) },
        400,
      );
    }
    const sessionId = await resolveSession(parsed.data.sessionId);
    const message: InboundMessage = {
      channel: 'api',
      chatId: sessionId ?? 'main',
      text: parsed.data.content,
      receivedAt: deps.clock.now(),
      ...(sessionId && { sessionId }),
    };
    const submitted = await receive(message);
    return c.json(submitted satisfies PostMessageResponse, 202);
  });

  app.post('/api/sessions', async (c) =>
    c.json({ sessionId: await deps.agent.startSession() }, 201),
  );

  app.get('/api/sessions/:id/messages', async (c) => {
    const sessionId = await resolveSession(c.req.param('id'));
    if (!sessionId) return c.json({ sessionId: null, messages: [] });
    const session = await deps.repos.sessions.get(sessionId);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const messages = await deps.repos.messages.listBySession(sessionId, { limit });
    return c.json({ sessionId, messages: messages.map(toMessageDto) });
  });

  app.get('/api/turns/:id', async (c) => {
    const turn = await deps.repos.turns.get(asId<TurnId>(c.req.param('id')));
    if (!turn) return c.json({ error: 'Turn not found' }, 404);
    const p = turn.toProps();
    const dto: TurnDto = {
      id: p.id,
      sessionId: p.sessionId,
      status: p.status,
      error: p.error,
      createdAt: p.createdAt.toISOString(),
      startedAt: p.startedAt?.toISOString(),
      endedAt: p.endedAt?.toISOString(),
    };
    return c.json(dto);
  });

  app.post('/api/turns/:id/stop', async (c) =>
    c.json({ stopped: await deps.agent.stop(asId<TurnId>(c.req.param('id'))) }),
  );

  app.get('/api/soul', async (c) => {
    const view = await deps.soul.view();
    const dto: SoulDto = {
      revision: view.revision.revision,
      body: view.revision.body,
      updatedAt: view.revision.createdAt.toISOString(),
      ...(view.pending && { pending: view.pending }),
    };
    return c.json(dto);
  });

  app.post('/api/soul/confirm', async (c) => {
    const parsed = confirmSoulBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: 'Send the hash of the reviewed edit, from GET /api/soul' }, 400);
    }
    try {
      const revision = await deps.soul.confirmEdit(parsed.data.hash);
      return c.json({ revision: revision.revision } satisfies ConfirmSoulResponse);
    } catch (error) {
      // Nothing to apply is a conflict with the current state, not a server fault.
      if (error instanceof SoulNoPendingEdit || error instanceof SoulEditChanged) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.get('/api/activity', async (c) => {
    const since = new Date(c.req.query('since') ?? deps.clock.now().getTime() - 7 * 24 * 3600_000);
    if (Number.isNaN(since.getTime())) return c.json({ error: 'since must be an ISO date' }, 400);
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const events = await deps.repos.turnEvents.listRecent(deps.ownerId, {
      kinds: ['tool_end'],
      since,
      limit,
    });
    return c.json({
      since: since.toISOString(),
      receipts: events.map(toActivityReceipt),
    } satisfies ActivityResponse);
  });

  app.get('/api/usage', async (c) => {
    const since = new Date(c.req.query('since') ?? deps.clock.now().getTime() - 30 * 24 * 3600_000);
    if (Number.isNaN(since.getTime())) return c.json({ error: 'since must be an ISO date' }, 400);
    const rows = await deps.repos.usage.listSince(deps.ownerId, since);
    const priced = rows.filter((r) => r.cost);
    const currency = priced[0]?.cost!.currency ?? 'USD';
    const costMicros = priced
      .filter((r) => r.cost!.currency === currency)
      .reduce((n, r) => n + r.cost!.micros, 0);
    return c.json({
      since: since.toISOString(),
      calls: rows.length,
      inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
      cost: priced.length ? { micros: costMicros, currency } : null,
      rows: rows.map((r) => ({ ...r, cost: r.cost?.toJSON(), at: r.at.toISOString() })),
    } satisfies UsageDto);
  });

  app.post('/api/events/ticket', (c) => {
    const now = deps.clock.now().getTime();
    for (const [t, exp] of tickets) if (exp < now) tickets.delete(t);
    const ticket = randomBytes(24).toString('base64url');
    tickets.set(ticket, now + TICKET_TTL_MS);
    return c.json({ ticket, expiresInSeconds: TICKET_TTL_MS / 1000 });
  });

  const upgradeWebSocket = deps.webSocket?.(app);
  if (upgradeWebSocket) {
    app.get(
      '/api/events',
      async (c, next) => {
        const ticket = c.req.query('ticket');
        const expiry = ticket ? tickets.get(ticket) : undefined;
        if (!ticket || !expiry || expiry < deps.clock.now().getTime()) {
          return c.json({ error: 'Missing, used or expired ticket' }, 401);
        }
        tickets.delete(ticket); // single use
        return next();
      },
      upgradeWebSocket(() => {
        const offs: (() => void)[] = [];
        return {
          onOpen(_event, ws) {
            for (const type of LIVE_EVENT_TYPES) {
              offs.push(
                deps.events.subscribe(type, (payload) => {
                  const { replyChannel: _r, ...visible } = payload as Record<string, unknown>;
                  ws.send(JSON.stringify({ type, ...visible } as LiveEvent));
                }),
              );
            }
          },
          onClose() {
            offs.forEach((off) => off());
          },
        };
      }),
    );
  }

  async function resolveSession(id: string | undefined): Promise<SessionId | undefined> {
    if (id && id !== 'main') return asId<SessionId>(id);
    const thread = await deps.repos.threads.getOrCreateForOwner(deps.ownerId, deps.clock.now());
    return (await deps.repos.sessions.findMainChat(thread.id))?.id;
  }

  // The API is a transport, not a chat channel: its replies travel on /api/events. It still hands
  // messages over as InboundMessages, so every entry point speaks the same model (S30).
  const receive =
    deps.receive ??
    ((message: InboundMessage) =>
      deps.agent.submit(message.text, {
        ...(message.sessionId && { sessionId: message.sessionId }),
        channel: message.channel,
      }));

  return app;
}

export type ApiContext = Context;

export function toMessageDto(m: Message): MessageDto {
  return {
    id: m.id,
    role: m.role,
    author: m.author,
    text: textOf(m),
    toolCalls: toolCallsOf(m).map((c) => ({ id: c.id, name: c.name })),
    toolResults: m.parts.flatMap((p) =>
      p.type === 'tool_result'
        ? [{ toolCallId: p.toolCallId, isError: p.isError, preview: p.content.slice(0, 200) }]
        : [],
    ),
    withdrawn: m.withdrawn,
    turnId: m.turnId,
    createdAt: m.createdAt.toISOString(),
  };
}

/** One stored tool_end event as the activity log shows it; missing fields stay missing. */
export function toActivityReceipt(event: TurnEvent): ActivityReceiptDto {
  const data = event.data;
  const text = (key: string): string | undefined =>
    typeof data[key] === 'string' ? (data[key] as string) : undefined;
  const rawBasis = data.allowedBy as { kind?: unknown; detail?: unknown } | undefined;
  const allowedBy =
    rawBasis && typeof rawBasis.kind === 'string'
      ? {
          kind: rawBasis.kind,
          ...(typeof rawBasis.detail === 'string' && { detail: rawBasis.detail }),
        }
      : undefined;
  const sessionId = text('sessionId');
  const effect = text('effect');
  const target = text('target');
  const args = text('args');
  const deniedBecause = text('deniedBecause');
  return {
    turnId: event.turnId,
    ...(sessionId ? { sessionId } : {}),
    tool: text('tool') ?? 'unknown',
    toolCallId: text('toolCallId') ?? '',
    ...(effect ? { effect } : {}),
    ...(target ? { target } : {}),
    outcome: text('outcome') ?? event.kind,
    ...(typeof data.ms === 'number' && { durationMs: data.ms }),
    ...(args ? { args } : {}),
    ...(allowedBy ? { allowedBy } : {}),
    ...(deniedBecause ? { deniedBecause } : {}),
    at: event.at.toISOString(),
  };
}
