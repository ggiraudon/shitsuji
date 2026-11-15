import { Box, render, Text, useApp, useInput } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent, MessageDto } from '../http/contract.js';
import type { ApiClient } from './ApiClient.js';

const colors = {
  accent: '#61afef',
  success: '#98c379',
  error: '#e06c75',
  warning: '#e5c07b',
  dim: '#5c6370',
  purple: '#c678dd',
};

/** One line on screen. */
export interface Line {
  id: string;
  kind: 'owner' | 'assistant' | 'tool' | 'note' | 'error';
  text: string;
}

/** The parts of ApiClient the TUI uses (a fake one is enough for tests). */
export type TuiClient = Pick<ApiClient, 'history' | 'send' | 'stop' | 'newSession' | 'events'>;

let counter = 0;
const lineId = () => `l${++counter}`;

/** History from the API → lines (tool results are shown as their call, not their output). */
export function historyLines(messages: MessageDto[]): Line[] {
  const lines: Line[] = [];
  for (const m of messages) {
    if (m.withdrawn) continue;
    if (m.author === 'owner') lines.push({ id: m.id, kind: 'owner', text: m.text });
    else if (m.role === 'assistant') {
      for (const call of m.toolCalls)
        lines.push({ id: `${m.id}-${call.id}`, kind: 'tool', text: `⚙ ${call.name}` });
      if (m.text) lines.push({ id: m.id, kind: 'assistant', text: m.text });
    } else if (m.role === 'system' && m.text) lines.push({ id: m.id, kind: 'note', text: m.text });
  }
  return lines;
}

export function ShitsujiApp({ client, maxLines = 40 }: { client: TuiClient; maxLines?: number }) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState('');
  const [turnId, setTurnId] = useState<string | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const session = useRef<string | null>(null);
  const turn = useRef<string | null>(null);

  const add = useCallback((kind: Line['kind'], text: string) => {
    setLines((prev) => [...prev, { id: lineId(), kind, text }].slice(-500));
  }, []);

  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (session.current && e.sessionId !== session.current) return;
      switch (e.type) {
        case 'turn.status':
          if (e.status === 'running') {
            turn.current = e.turnId;
            setTurnId(e.turnId);
            setStatus('Working… (Esc to stop)');
          } else if (
            e.status === 'succeeded' ||
            e.status === 'failed' ||
            e.status === 'cancelled'
          ) {
            setStreaming('');
            if (e.status === 'succeeded') add('assistant', e.reply ?? '');
            else if (e.status === 'cancelled') add('note', 'Stopped.');
            else add('error', e.error ?? 'The turn failed');
            turn.current = null;
            setTurnId(null);
            setStatus('Ready');
          }
          break;
        case 'turn.text_delta':
          setStreaming((s) => s + e.text);
          break;
        case 'tool.started':
          setStreaming('');
          add('tool', `⚙ ${e.toolName}…`);
          break;
        case 'tool.finished':
          add(
            e.ok ? 'tool' : 'error',
            `${e.ok ? '✓' : '✗'} ${e.toolName}${e.ok ? '' : `: ${e.error ?? 'failed'}`}`,
          );
          break;
        case 'turn.steered':
          add('note', 'Added to the current turn.');
          break;
      }
    },
    [add],
  );

  useEffect(() => {
    let close: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const history = await client.history('main');
        if (cancelled) return;
        session.current = history.sessionId;
        setLines(historyLines(history.messages));
        close = await client.events(
          onEvent,
          () => !cancelled && setStatus('Disconnected from Shitsuji'),
        );
        setStatus('Ready');
      } catch (error) {
        setStatus(`Cannot connect: ${(error as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      close?.();
    };
  }, [client, onEvent]);

  const submit = useCallback(
    async (text: string) => {
      if (text === '/exit' || text === '/quit') return exit();
      if (text === '/help') {
        return add(
          'note',
          'Enter: send (also while working). Esc: stop. /new: new conversation. /exit: quit.',
        );
      }
      if (text === '/new') {
        session.current = await client.newSession();
        setLines([]);
        return add('note', 'New conversation.');
      }
      add('owner', text);
      try {
        const sent = await client.send(text, session.current ?? undefined);
        session.current = sent.sessionId;
      } catch (error) {
        add('error', (error as Error).message);
      }
    },
    [add, client, exit],
  );

  useInput((char, key) => {
    if (key.escape) {
      if (turn.current) {
        setStatus('Stopping…');
        void client.stop(turn.current);
      }
      return;
    }
    if (key.ctrl && char === 'c') return exit();
    if (key.return) {
      const text = input.trim();
      setInput('');
      if (text) void submit(text);
      return;
    }
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  const shown = lines.slice(-maxLines);
  return (
    <Box flexDirection="column">
      <Text color={colors.accent} bold>
        Shitsuji 執事 <Text color={colors.dim}>/help for commands</Text>
      </Text>
      {shown.map((l) => (
        <Text key={l.id} color={lineColor(l.kind)} wrap="wrap">
          {prefix(l.kind)}
          {l.text}
        </Text>
      ))}
      {streaming ? <Text color={colors.success}>{`Shitsuji: ${streaming}`}</Text> : null}
      <Text color={turnId ? colors.warning : colors.dim}>{status}</Text>
      <Text>
        <Text color={colors.accent}>{'› '}</Text>
        {input}
        <Text color={colors.dim}>▌</Text>
      </Text>
    </Box>
  );
}

const prefix = (kind: Line['kind']) =>
  kind === 'owner' ? 'You: ' : kind === 'assistant' ? 'Shitsuji: ' : '  ';
const lineColor = (kind: Line['kind']) =>
  kind === 'owner'
    ? colors.accent
    : kind === 'assistant'
      ? undefined
      : kind === 'error'
        ? colors.error
        : kind === 'tool'
          ? colors.purple
          : colors.dim;

/** Starts the TUI; resolves when it exits. */
export async function startTUI(client: TuiClient): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('The TUI needs an interactive terminal (stdin is not a TTY).');
  }
  const app = render(<ShitsujiApp client={client} />);
  await app.waitUntilExit();
}
