import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../../src/adapters/logging/loggers.js';
import { TelegramChannelAdapter } from '../../../src/adapters/channels/TelegramChannelAdapter.js';
import type {
  TelegramIncoming,
  TelegramTransport,
} from '../../../src/adapters/channels/TelegramTransport.js';
import { asId, type SessionId, type TurnId } from '../../../src/domain/model/ids.js';
import type { InboundMessage, OutboundMessage } from '../../../src/ports/ChannelAdapter.js';
import { describeChannelContract } from '../../contracts/channel.contract.js';
import { until } from '../../helpers.js';

class FakeTelegram implements TelegramTransport {
  readonly sent: { chatId: string; html: string }[] = [];
  readonly deleted: { chatId: string; messageId: number }[] = [];
  readonly typed: string[] = [];
  started = 0;
  stopped = 0;
  private handler?: (message: TelegramIncoming) => void;

  async start(onMessage: (message: TelegramIncoming) => void): Promise<void> {
    this.handler = onMessage;
    this.started++;
  }
  async stop(): Promise<void> {
    this.stopped++;
    this.handler = undefined;
  }
  async sendMessage(chatId: string, html: string): Promise<number> {
    this.sent.push({ chatId, html });
    return this.sent.length;
  }
  async editMessage(): Promise<void> {}
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    this.deleted.push({ chatId, messageId });
  }
  async sendTyping(chatId: string): Promise<void> {
    this.typed.push(chatId);
  }
  receive(message: TelegramIncoming): void {
    this.handler?.(message);
  }
}

async function setup() {
  const transport = new FakeTelegram();
  const adapter = new TelegramChannelAdapter(transport, new MemoryLogger());
  const received: InboundMessage[] = [];
  await adapter.start({
    receive: async (message) => {
      received.push(message);
      return {
        kind: 'turn',
        sessionId: asId<SessionId>('session'),
        turnId: asId<TurnId>('turn'),
        steered: false,
      };
    },
  });
  return { adapter, transport, received };
}

const reply = (markdown: string): OutboundMessage => ({
  intent: 'final',
  parts: [{ kind: 'text', markdown }],
});

describe('TelegramChannelAdapter (S32)', () => {
  it('requires pairing and starts the transport', async () => {
    const { adapter, transport } = await setup();
    expect(adapter.requiresPairing).toBe(true);
    expect(transport.started).toBe(1);
    await adapter.stop();
    expect(transport.stopped).toBe(1);
  });

  it('turns a Telegram update into an InboundMessage', async () => {
    const { transport, received } = await setup();

    transport.receive({
      chatId: '42',
      messageId: 5,
      text: '/start ABCD2345',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({
      channel: 'telegram',
      chatId: '42',
      text: '/start ABCD2345',
      externalId: '5',
    });
  });

  it('delivers Markdown as Telegram HTML', async () => {
    const { adapter, transport } = await setup();

    const receipt = await adapter.deliver({ chatId: '42' }, reply('**Hi** <there>'));

    expect(receipt).toEqual({ delivered: true, externalId: '1' });
    expect(transport.sent).toEqual([{ chatId: '42', html: '<b>Hi</b> &lt;there&gt;' }]);
  });

  it('splits a long reply into several messages', async () => {
    const { adapter, transport } = await setup();

    await adapter.deliver({ chatId: '42' }, reply('x'.repeat(9000)));

    expect(transport.sent.length).toBeGreaterThan(1);
  });

  it('shows one working message and removes it when the reply arrives', async () => {
    const { adapter, transport } = await setup();

    await adapter.typing({ chatId: '42' });
    await adapter.typing({ chatId: '42' }); // already showing: no second message
    expect(transport.typed).toEqual(['42']);
    expect(transport.sent).toEqual([{ chatId: '42', html: 'Working…' }]);

    await adapter.deliver({ chatId: '42' }, reply('Done.'));

    expect(transport.deleted).toEqual([{ chatId: '42', messageId: 1 }]);
    expect(transport.sent.at(-1)).toEqual({ chatId: '42', html: 'Done.' });
  });
});

describeChannelContract(
  'telegram',
  () => new TelegramChannelAdapter(new FakeTelegram(), new MemoryLogger()),
);
