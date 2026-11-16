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
              { chatId: message.chatId },
              { parts: [{ kind: 'text', markdown: options.reply! }], intent: 'final' },
            ),
          5,
        );
      }
      return {
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
