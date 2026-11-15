import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Agent } from '../../application/Agent.js';
import { asId, type OwnerId, type SessionId, type TurnId } from '../../domain/model/ids.js';
import { textOf, toolCallsOf, type Message } from '../../domain/model/Message.js';
import type { Clock } from '../../ports/Clock.js';
import type { EventBus } from '../../ports/EventBus.js';
import type { Logger } from '../../ports/Logger.js';
import type { Repositories } from '../../ports/Repositories.js';
import {
  LIVE_EVENT_TYPES,
  postMessageBody,
  type LiveEvent,
  type MessageDto,
  type PostMessageResponse,
  type TurnDto,
} from './contract.js';

export interface ApiDeps {
  agent: Agent;
  repos: Repositories;
  events: EventBus;
  clock: Clock;
  log: Logger;
  ownerId: OwnerId;
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
    const submitted = await deps.agent.submit(parsed.data.content, {
      sessionId,
      channel: 'api',
    });
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

  app.get('/api/usage', async (c) => {
    const since = new Date(c.req.query('since') ?? Date.now() - 30 * 24 * 3600_000);
    if (Number.isNaN(since.getTime())) return c.json({ error: 'since must be an ISO date' }, 400);
    const rows = await deps.repos.usage.listSince(deps.ownerId, since);
    return c.json({
      since: since.toISOString(),
      calls: rows.length,
      inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
      rows: rows.map((r) => ({ ...r, cost: r.cost?.toJSON(), at: r.at.toISOString() })),
    });
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
