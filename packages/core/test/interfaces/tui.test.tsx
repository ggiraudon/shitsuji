import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { LiveEvent, MessageDto } from '../../src/interfaces/http/contract.js';
import { historyLines, ShitsujiApp, type TuiClient } from '../../src/interfaces/tui/app.js';

const msg = (over: Partial<MessageDto>): MessageDto => ({
  id: Math.random().toString(36),
  role: 'user',
  author: 'owner',
  text: '',
  toolCalls: [],
  toolResults: [],
  withdrawn: false,
  createdAt: new Date().toISOString(),
  ...over,
});

/** A fake API: records calls; the test pushes live events with emit(). */
function fakeClient(history: MessageDto[] = []) {
  let listener: ((e: LiveEvent) => void) | undefined;
  const calls = {
    sent: [] as string[],
    stopped: [] as string[],
    newSessions: 0,
    soulApplied: 0,
    soulHash: '',
  };
  const client: TuiClient = {
    history: async () => ({ sessionId: 's1', messages: history }),
    send: async (content: string) => {
      calls.sent.push(content);
      return { sessionId: 's1', turnId: 't1', steered: false };
    },
    stop: async (turnId: string) => {
      calls.stopped.push(turnId);
      return true;
    },
    newSession: async () => {
      calls.newSessions++;
      return 's2';
    },
    soul: async () => ({
      revision: 3,
      body: 'Be kind.',
      updatedAt: new Date(0).toISOString(),
      pending: {
        path: '/data/SOUL.md',
        current: 'Be kind.',
        proposed: 'Be very kind.\nSecond line of the edit.',
        hash: 'h'.repeat(64),
      },
    }),
    applySoul: async (hash: string) => {
      calls.soulApplied++;
      calls.soulHash = hash;
      return 4;
    },
    events: async (onEvent: (e: LiveEvent) => void) => {
      listener = onEvent;
      return () => (listener = undefined);
    },
  };
  return { client, calls, emit: (e: LiveEvent) => listener?.(e) };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const type = async (stdin: { write: (s: string) => void }, text: string) => {
  for (const ch of text) stdin.write(ch);
  await tick();
};

describe('TUI', () => {
  it('shows the history, without withdrawn messages', async () => {
    const { client } = fakeClient([
      msg({ text: 'Hello' }),
      msg({ role: 'assistant', author: 'assistant', text: 'Good evening.' }),
      msg({ text: 'cancelled request', withdrawn: true }),
    ]);
    const ui = render(<ShitsujiApp client={client} />);
    await tick();
    const frame = ui.lastFrame()!;
    expect(frame).toContain('You: Hello');
    expect(frame).toContain('Shitsuji: Good evening.');
    expect(frame).not.toContain('cancelled request');
    expect(frame).toContain('Ready');
    ui.unmount();
  });

  it('sends a message, streams the reply and shows tool activity', async () => {
    const { client, calls, emit } = fakeClient();
    const ui = render(<ShitsujiApp client={client} />);
    await tick();
    await type(ui.stdin, 'What is 2+2?');
    ui.stdin.write('\r');
    await tick();
    expect(calls.sent).toEqual(['What is 2+2?']);
    emit({ type: 'turn.status', turnId: 't1', sessionId: 's1', status: 'running' });
    emit({
      type: 'tool.started',
      turnId: 't1',
      sessionId: 's1',
      toolName: 'math.evaluate',
      toolCallId: 'c1',
    });
    emit({
      type: 'tool.finished',
      turnId: 't1',
      sessionId: 's1',
      toolName: 'math.evaluate',
      toolCallId: 'c1',
      ok: true,
    });
    emit({ type: 'turn.text_delta', turnId: 't1', sessionId: 's1', text: 'It is ' });
    await tick();
    expect(ui.lastFrame()).toContain('Shitsuji: It is');
    expect(ui.lastFrame()).toContain('Working… (Esc to stop)');
    emit({
      type: 'turn.status',
      turnId: 't1',
      sessionId: 's1',
      status: 'succeeded',
      reply: 'It is 4.',
    });
    await tick();
    const frame = ui.lastFrame()!;
    expect(frame).toContain('⚙ math.evaluate…');
    expect(frame).toContain('✓ math.evaluate');
    expect(frame).toContain('Shitsuji: It is 4.');
    expect(frame).toContain('Ready');
    ui.unmount();
  });

  it('stops the running turn on Esc', async () => {
    const { client, calls, emit } = fakeClient();
    const ui = render(<ShitsujiApp client={client} />);
    await tick();
    emit({ type: 'turn.status', turnId: 't9', sessionId: 's1', status: 'running' });
    await tick();
    ui.stdin.write('\u001B');
    await tick();
    expect(calls.stopped).toEqual(['t9']);
    emit({
      type: 'turn.status',
      turnId: 't9',
      sessionId: 's1',
      status: 'cancelled',
      error: 'stopped by owner',
    });
    await tick();
    expect(ui.lastFrame()).toContain('Stopped.');
    ui.unmount();
  });

  it('starts a new conversation with /new and ignores events from other sessions', async () => {
    const { client, calls, emit } = fakeClient([msg({ text: 'old' })]);
    const ui = render(<ShitsujiApp client={client} />);
    await tick();
    await type(ui.stdin, '/new');
    ui.stdin.write('\r');
    await tick();
    expect(calls.newSessions).toBe(1);
    expect(ui.lastFrame()).not.toContain('You: old');
    emit({
      type: 'turn.status',
      turnId: 'x',
      sessionId: 's1',
      status: 'succeeded',
      reply: 'from the old session',
    });
    await tick();
    expect(ui.lastFrame()).not.toContain('from the old session');
    ui.unmount();
  });

  it('shows the SOUL and confirms an edit with /soul apply', async () => {
    const { client, calls } = fakeClient();
    const ui = render(<ShitsujiApp client={client} />);
    await tick();

    await type(ui.stdin, '/soul');
    ui.stdin.write('\r');
    await tick();
    let frame = ui.lastFrame()!;
    expect(frame).toContain('SOUL revision 3');
    expect(frame).toContain('has an edit waiting');
    expect(frame).toContain('Be very kind.');

    await type(ui.stdin, '/soul apply');
    ui.stdin.write('\r');
    await tick();
    frame = ui.lastFrame()!;
    expect(calls.soulApplied).toBe(1);
    expect(calls.soulHash).toBe('h'.repeat(64));
    expect(frame).toContain('SOUL revision 4 takes effect at the next turn.');
    expect(calls.sent).toEqual([]); // the command never reaches the model
    ui.unmount();
  });

  it('lists tool calls from history as tool lines', () => {
    const lines = historyLines([
      msg({
        role: 'assistant',
        author: 'assistant',
        toolCalls: [{ id: 'c1', name: 'web.search' }],
      }),
      msg({ role: 'tool', author: 'system' }),
      msg({ role: 'assistant', author: 'assistant', text: 'Found it.' }),
    ]);
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'tool:⚙ web.search',
      'assistant:Found it.',
    ]);
  });
});
