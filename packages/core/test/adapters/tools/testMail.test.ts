import { describe, expect, it } from 'vitest';
import { TestMailTool } from '../../../src/adapters/tools/TestMailTool.js';
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
  new TestMailTool({ url: 'https://mock.invalid/mail', fetch: fetchImpl });

describe('test.mail (S38)', () => {
  it('posts the message to the mock mailbox', async () => {
    const calls: unknown[] = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 202 });
    };

    const output = await tool(fetchMock).run(
      { to: 'anna@example.com', subject: 'Report', body: 'Here it is.' },
      ctx(),
    );

    expect(output).toEqual({ content: 'Email sent.', data: { status: 202 } });
    expect(calls).toEqual([{ to: 'anna@example.com', subject: 'Report', body: 'Here it is.' }]);
  });

  it('reports a refusal or an unreachable mailbox without throwing', async () => {
    const refusing = tool(async () => new Response('no', { status: 500 }));
    expect(await refusing.run({ to: 'a@b.c', subject: 's', body: 'b' }, ctx())).toMatchObject({
      isError: true,
      content: expect.stringContaining('500'),
    });

    const down = tool(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await down.run({ to: 'a@b.c', subject: 's', body: 'b' }, ctx())).toMatchObject({
      isError: true,
      content: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('is an external action, so trust always checks it', () => {
    expect(tool(fetch).effect).toBe('external');
  });
});
