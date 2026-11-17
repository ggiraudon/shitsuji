import { describe, expect, it } from 'vitest';
import { NotifyTool } from '../../../src/adapters/tools/NotifyTool.js';
import type { ToolContext } from '../../../src/ports/Tool.js';
import { testServices } from '../../helpers.js';

const ctx = (): ToolContext => {
  const services = testServices();
  return {
    turnId: 't',
    sessionId: 's',
    signal: new AbortController().signal,
    log: services.log,
    events: services.events,
    writeFenced: async () => {
      throw new Error('unused');
    },
  };
};

const tool = (fetchImpl: typeof fetch) =>
  new NotifyTool({
    url: 'http://127.0.0.1:9999/notify',
    fetch: fetchImpl,
    now: () => new Date('2026-11-17T10:00:00Z'),
  });

describe('test.notify (S36)', () => {
  it('posts the text and time to the mock service', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } });
    };

    const output = await tool(fetchMock).run({ text: 'Hello' }, ctx());

    expect(output).toEqual({ content: 'Notification sent.', data: { status: 202 } });
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:9999/notify',
        body: { text: 'Hello', at: '2026-11-17T10:00:00.000Z' },
      },
    ]);
  });

  it('reports a refusal or an unreachable service without throwing', async () => {
    const refusing = tool(async () => new Response('no', { status: 500 }));
    expect(await refusing.run({ text: 'Hello' }, ctx())).toMatchObject({
      isError: true,
      content: expect.stringContaining('500'),
    });

    const down = tool(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await down.run({ text: 'Hello' }, ctx())).toMatchObject({
      isError: true,
      content: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('is an external action, so trust always checks it', () => {
    expect(tool(fetch).effect).toBe('external');
  });
});
