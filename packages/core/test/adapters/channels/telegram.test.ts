import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryLogger } from '../../../src/adapters/logging/loggers.js';
import { HandoffStore } from '../../../src/adapters/files/HandoffStore.js';
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
  readonly downloads: string[] = [];
  readonly documents: { chatId: string; name: string; bytes: Uint8Array; caption?: string }[] = [];
  started = 0;
  stopped = 0;
  failDownload = false;
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
  async downloadFile(fileId: string): Promise<Uint8Array> {
    this.downloads.push(fileId);
    if (this.failDownload) throw new Error('download failed');
    return new Uint8Array([1, 2, 3]);
  }
  async sendDocument(
    chatId: string,
    name: string,
    bytes: Uint8Array,
    caption?: string,
  ): Promise<number> {
    this.documents.push({ chatId, name, bytes, ...(caption && { caption }) });
    return 100 + this.documents.length;
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

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setupFiles() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shitsuji-telegram-'));
  dirs.push(dir);
  const transport = new FakeTelegram();
  const adapter = new TelegramChannelAdapter(transport, new MemoryLogger(), {
    handoff: new HandoffStore(dir),
  });
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
  return { adapter, transport, received, dir };
}

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

describe('TelegramChannelAdapter: attachments (S33)', () => {
  it('stores a document in the handoff folder and tells the turn where it is', async () => {
    const { transport, received, dir } = await setupFiles();

    transport.receive({
      chatId: '42',
      messageId: 7,
      text: 'Here is the report.',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      attachment: {
        kind: 'document',
        fileId: 'file-1',
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 3,
      },
    });

    await until(() => received.length === 1);
    const attachment = received[0]!.attachments![0]!;
    expect(attachment).toMatchObject({
      name: 'report.pdf',
      mediaType: 'application/pdf',
      size: 3,
    });
    expect(attachment.path.startsWith(dir)).toBe(true);
    expect(await fs.readFile(attachment.path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('stores a photo', async () => {
    const { transport, received, dir } = await setupFiles();

    transport.receive({
      chatId: '42',
      messageId: 8,
      text: 'Look at this',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      attachment: {
        kind: 'photo',
        fileId: 'photo-1',
        name: 'photo-abc.jpg',
        mediaType: 'image/jpeg',
      },
    });

    await until(() => received.length === 1);
    expect(received[0]!.attachments![0]).toMatchObject({
      name: 'photo-abc.jpg',
      mediaType: 'image/jpeg',
    });
    expect(received[0]!.text).toBe('Look at this');
    expect(received[0]!.attachments![0]!.path.startsWith(dir)).toBe(true);
  });

  it('stores a voice note and answers that it cannot listen yet, without a turn', async () => {
    const { transport, received } = await setupFiles();

    transport.receive({
      chatId: '42',
      messageId: 9,
      text: '',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      attachment: {
        kind: 'voice',
        fileId: 'voice-1',
        name: 'voice-abc.ogg',
        mediaType: 'audio/ogg',
        size: 3,
      },
    });

    await until(() => transport.sent.length === 1);
    expect(transport.sent[0]!.html).toBe("I can't listen to voice notes yet.");
    expect(transport.downloads).toEqual(['voice-1']);
    expect(received).toEqual([]);
  });

  it('loses the file, not the message, when the download fails', async () => {
    const { transport, received } = await setupFiles();
    transport.failDownload = true;

    transport.receive({
      chatId: '42',
      messageId: 10,
      text: 'The report is attached.',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      attachment: {
        kind: 'document',
        fileId: 'file-2',
        name: 'report.pdf',
        mediaType: 'application/pdf',
      },
    });

    await until(() => received.length === 1);
    expect(received[0]!.text).toBe('The report is attached.');
    expect(received[0]!.attachments).toBeUndefined();
  });
});

describe('TelegramChannelAdapter: files sent back (S33)', () => {
  it('sends a file the turn attached as a Telegram document', async () => {
    const { adapter, transport, dir } = await setupFiles();
    const file = path.join(dir, 'report.pdf');
    await fs.writeFile(file, 'pdf');

    const receipt = await adapter.deliver(
      { chatId: '42' },
      {
        intent: 'final',
        parts: [
          { kind: 'text', markdown: 'Here is the report.' },
          {
            kind: 'file',
            fileRef: { name: 'report.pdf', path: file },
            caption: 'The report',
          },
        ],
      },
    );

    expect(receipt).toEqual({ delivered: true, externalId: '1' });
    expect(transport.sent).toEqual([{ chatId: '42', html: 'Here is the report.' }]);
    expect(transport.documents).toHaveLength(1);
    expect(transport.documents[0]).toMatchObject({
      chatId: '42',
      name: 'report.pdf',
      caption: 'The report',
    });
    expect(Buffer.from(transport.documents[0]!.bytes).toString()).toBe('pdf');
  });

  it('keeps the text when the file cannot be read', async () => {
    const { adapter, transport } = await setupFiles();

    const receipt = await adapter.deliver(
      { chatId: '42' },
      {
        intent: 'final',
        parts: [
          { kind: 'text', markdown: 'The file is gone.' },
          { kind: 'file', fileRef: { name: 'missing.pdf', path: '/no/such/file.pdf' } },
        ],
      },
    );

    expect(receipt.delivered).toBe(true);
    expect(transport.sent).toEqual([{ chatId: '42', html: 'The file is gone.' }]);
    expect(transport.documents).toEqual([]);
  });
});
