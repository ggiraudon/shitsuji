import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../../src/adapters/logging/loggers.js';
import { WebhookChannelAdapter } from '../../../src/adapters/channels/WebhookChannelAdapter.js';
import { asId, type SessionId, type TurnId } from '../../../src/domain/model/ids.js';
import type { InboundMessage } from '../../../src/ports/ChannelAdapter.js';
import { describeChannelContract } from '../../contracts/channel.contract.js';

const logger = () => new MemoryLogger();
const KEY = 'test-owner-key';
const authorize = (key: string | undefined) => key === KEY;
const started = async (
  options: { replyTimeoutMs?: number; reply?: string; fail?: boolean } = {},
) => {
  const adapter = new WebhookChannelAdapter(logger(), {
    port: 0,
    replyTimeoutMs: options.replyTimeoutMs ?? 2000,
    authorize,
  });
  const received: InboundMessage[] = [];
  await adapter.start({
    receive: async (message) => {
      received.push(message);
      if (options.fail) throw new Error('agent down');
      if (options.reply) {
        setTimeout(
          () =>
            void adapter.deliver(
              { chatId: message.chatId, turnId: asId<TurnId>('turn') },
              { parts: [{ kind: 'text', markdown: options.reply! }], intent: 'final' },
            ),
          5,
        );
      }
      return {
        kind: 'turn',
        sessionId: asId<SessionId>('session'),
        turnId: asId<TurnId>('turn'),
        steered: false,
      };
    },
  });
  const url = `http://127.0.0.1:${adapter.getPort()}/webhook`;
  /** `null` sends no Authorization header. */
  const post = (body: unknown, key: string | null = KEY) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key !== null && { authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify(body),
    });
  return { adapter, received, post, url: `http://127.0.0.1:${adapter.getPort()}` };
};

describe('WebhookChannelAdapter: access (#34)', () => {
  it('refuses a message without the owner key and starts no turn', async () => {
    const { adapter, received, post } = await started({ reply: 'secret answer' });

    const response = await post({ content: 'Ping' }, null);

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('secret answer');
    expect(received).toEqual([]);
    await adapter.stop();
  });

  it('refuses a wrong key', async () => {
    const { adapter, received, post } = await started({ reply: 'Pong.' });

    const response = await post({ content: 'Ping' }, 'not-the-key');

    expect(response.status).toBe(401);
    expect(received).toEqual([]);
    await adapter.stop();
  });

  it('listens on 127.0.0.1 unless told otherwise', async () => {
    const { adapter } = await started();
    expect(adapter.getHost()).toBe('127.0.0.1');
    await adapter.stop();
  });
});

describe('WebhookChannelAdapter', () => {
  it('answers a message with the reply the turn delivered (bug 5)', async () => {
    const { adapter, received, post } = await started({ reply: 'Pong.' });

    const response = await post({ content: 'Ping', destination: 'd1' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      reply: 'Pong.',
      intent: 'final',
    });
    expect(received[0]).toMatchObject({ channel: 'webhook', chatId: 'd1', text: 'Ping' });
    await adapter.stop();
  });

  it('rejects a body without content, and one that is not JSON', async () => {
    const { adapter, post, url } = await started();
    const empty = await post({ destination: 'd1' });
    expect(empty.status).toBe(400);
    const notJson = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}` },
      body: 'not json',
    });
    expect(notJson.status).toBe(400);
    await adapter.stop();
  });

  it('answers 500 when the core refuses the message', async () => {
    const { adapter, post } = await started({ fail: true });
    const response = await post({ content: 'Ping' });
    expect(response.status).toBe(500);
    await adapter.stop();
  });

  it('answers 202 when no reply arrives before the timeout', async () => {
    const { adapter, post } = await started({ replyTimeoutMs: 20 });
    const response = await post({ content: 'Ping' });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true, pending: true });
    await adapter.stop();
  });

  it('reports a delivery with no waiting request instead of throwing', async () => {
    const adapter = new WebhookChannelAdapter(logger(), { port: 0, authorize });
    await adapter.start({
      receive: async () => ({
        kind: 'turn',
        sessionId: asId<SessionId>('session'),
        turnId: asId<TurnId>('turn'),
        steered: false,
      }),
    });

    const receipt = await adapter.deliver(
      { chatId: 'nobody' },
      { parts: [{ kind: 'text', markdown: 'hello' }], intent: 'final' },
    );

    expect(receipt).toEqual({ delivered: false, reason: 'no waiting request' });
    await adapter.stop();
  });

  it('serves a health check', async () => {
    const { adapter, url } = await started();
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    await adapter.stop();
  });
});

describeChannelContract(
  'webhook',
  () => new WebhookChannelAdapter(logger(), { port: 0, replyTimeoutMs: 10, authorize }),
);

describe('WebhookChannelAdapter: steering (#35)', () => {
  it("gives every request steered into a turn that turn's reply, not the next caller's", async () => {
    const adapter = new WebhookChannelAdapter(logger(), {
      port: 0,
      authorize,
      replyTimeoutMs: 2_000,
    });
    const received: InboundMessage[] = [];
    const turnIds = ['t1', 't1', 't2'];
    await adapter.start({
      receive: async (message) => {
        received.push(message);
        const turnId = asId<TurnId>(turnIds[received.length - 1]!);
        return {
          kind: 'turn',
          sessionId: asId<SessionId>('session'),
          turnId,
          steered: received.length > 1,
        };
      },
    });
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${adapter.getPort()}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      });
    const until = async (check: () => boolean) => {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > 1_000) throw new Error('Timed out');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const turn = (id: string) => ({
      parts: [{ kind: 'text' as const, markdown: `${id} reply` }],
      intent: 'final' as const,
    });

    const a = post({ content: 'A', destination: 'd1' });
    await until(() => received.length === 1);
    const b = post({ content: 'B', destination: 'd1' });
    await until(() => received.length === 2);

    await adapter.deliver({ chatId: 'd1', turnId: asId<TurnId>('t1') }, turn('t1'));

    expect(await (await a).json()).toMatchObject({
      reply: 't1 reply',
      messageId: expect.any(String),
    });
    expect(await (await b).json()).toMatchObject({
      reply: 't1 reply',
      messageId: expect.any(String),
    });

    const c = post({ content: 'C', destination: 'd1' });
    await until(() => received.length === 3);
    await adapter.deliver({ chatId: 'd1', turnId: asId<TurnId>('t2') }, turn('t2'));

    expect(await (await c).json()).toMatchObject({ reply: 't2 reply' });
    await adapter.stop();
  });
});
