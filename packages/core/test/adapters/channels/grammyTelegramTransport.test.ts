import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  GrammyTelegramTransport,
  type TelegramIncoming,
} from '../../../src/adapters/channels/TelegramTransport.js';
import { MemoryLogger } from '../../../src/adapters/logging/loggers.js';

/** Hand-written from the Telegram Bot API docs; replace with a real recording once a token exists. */
const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/telegram',
);
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

function setup() {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/sendMessage') || url.endsWith('/editMessageText')) {
      return jsonResponse(fixture('send-message.json'));
    }
    if (url.endsWith('/getFile')) return jsonResponse(fixture('get-file.json'));
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return jsonResponse({ ok: true, result: true });
  };
  const bot = new Bot('123456:TEST-token', {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: 'Shitsuji',
      username: 'shitsuji_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
    client: { fetch: fetchMock, apiRoot: 'https://telegram.test' },
  });
  return {
    transport: new GrammyTelegramTransport(bot, new MemoryLogger(), fetchMock),
    bot,
    calls,
  };
}

describe('GrammyTelegramTransport (S32)', () => {
  it('sends HTML and returns the Telegram message id', async () => {
    const { transport, calls } = setup();

    const id = await transport.sendMessage('42', '<b>hi</b>');

    expect(id).toBe(77);
    const call = calls.find((c) => c.url.endsWith('/sendMessage'))!;
    expect(call.url).toContain('/bot123456:TEST-token/sendMessage');
    expect(call.body).toMatchObject({
      chat_id: '42',
      text: '<b>hi</b>',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('edits, deletes and shows typing', async () => {
    const { transport, calls } = setup();

    await transport.editMessage('42', 77, '<b>edited</b>');
    await transport.deleteMessage('42', 77);
    await transport.sendTyping('42');

    expect(calls.find((c) => c.url.endsWith('/editMessageText'))!.body).toMatchObject({
      chat_id: '42',
      message_id: 77,
      text: '<b>edited</b>',
      parse_mode: 'HTML',
    });
    expect(calls.find((c) => c.url.endsWith('/deleteMessage'))!.body).toMatchObject({
      chat_id: '42',
      message_id: 77,
    });
    expect(calls.find((c) => c.url.endsWith('/sendChatAction'))!.body).toMatchObject({
      chat_id: '42',
      action: 'typing',
    });
  });

  it('maps a recorded update to a TelegramIncoming', async () => {
    const { transport, bot } = setup();
    const received: TelegramIncoming[] = [];
    transport.register((message) => received.push(message));

    await bot.handleUpdate(fixture('update-message.json'));

    expect(received[0]).toMatchObject({
      chatId: '42',
      messageId: 5,
      text: '/start ABCD2345',
    });
    expect(received[0]!.receivedAt).toEqual(new Date(1767225600 * 1000));
  });

  it('downloads a file the owner sent', async () => {
    const { transport, calls } = setup();

    const bytes = await transport.downloadFile('doc-1');

    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(calls.some((call) => call.url.endsWith('/getFile'))).toBe(true);
    expect(
      calls.some((call) => call.url.includes('/file/bot123456:TEST-token/documents/file_1.pdf')),
    ).toBe(true);
  });

  it('maps document, photo and voice updates with their files', async () => {
    const { transport, bot } = setup();
    const received: TelegramIncoming[] = [];
    transport.register((message) => received.push(message));

    await bot.handleUpdate(fixture('update-document.json'));
    await bot.handleUpdate(fixture('update-photo.json'));
    await bot.handleUpdate(fixture('update-voice.json'));

    expect(received[0]).toMatchObject({
      attachment: {
        kind: 'document',
        fileId: 'doc-1',
        name: 'report.pdf',
        mediaType: 'application/pdf',
        size: 3,
      },
    });
    expect(received[1]).toMatchObject({
      text: 'Look at this',
      attachment: {
        kind: 'photo',
        fileId: 'large',
        name: 'photo-abc.jpg',
        mediaType: 'image/jpeg',
        size: 300,
      },
    });
    expect(received[2]).toMatchObject({
      text: '',
      attachment: {
        kind: 'voice',
        fileId: 'voice-1',
        name: 'voice-v1.ogg',
        mediaType: 'audio/ogg',
        size: 3,
      },
    });
  });
});
