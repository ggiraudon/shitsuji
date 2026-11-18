import { Box, render, Text, useApp, useInput } from 'ink';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveEvent, MessageDto } from '@shitsuji/shared';
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
  kind: 'owner' | 'assistant' | 'tool' | 'note' | 'error' | 'approval';
  text: string;
}

/** The parts of ApiClient the TUI uses (a fake one is enough for tests). */
export type TuiClient = Pick<
  ApiClient,
  | 'history'
  | 'send'
  | 'stop'
  | 'newSession'
  | 'events'
  | 'soul'
  | 'applySoul'
  | 'usage'
  | 'activity'
  | 'pair'
  | 'approvals'
  | 'resolveApproval'
>;

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
  /** The hash of the SOUL edit shown by /soul: /soul apply confirms only that text. */
  const reviewedSoul = useRef<string | null>(null);
  /** Cards waiting for the owner; /approve and /decline answer the newest unless given an id. */
  const pending = useRef<{ id: string; summary: string }[]>([]);

  const add = useCallback((kind: Line['kind'], text: string) => {
    setLines((prev) => [...prev, { id: lineId(), kind, text }].slice(-500));
  }, []);

  const showApproval = useCallback(
    (approval: { id: string; summary: string }) => {
      pending.current = [...pending.current.filter((a) => a.id !== approval.id), approval];
      add('approval', `🔐 ${approval.summary}`);
      add(
        'note',
        `Approve: /approve ${approval.id.slice(0, 8)} · Decline: /decline ${approval.id.slice(0, 8)}`,
      );
      setStatus('Waiting for your approval');
    },
    [add],
  );

  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (session.current && e.sessionId !== session.current) return;
      switch (e.type) {
        case 'turn.status':
          if (e.status === 'running') {
            turn.current = e.turnId;
            setTurnId(e.turnId);
            setStatus('Working… (Esc to stop)');
          } else if (e.status === 'waiting') {
            setStreaming('');
            add('assistant', e.question ?? '');
            turn.current = null;
            setTurnId(null);
            setStatus('Waiting for your answer');
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
        case 'approval.requested':
          showApproval({ id: e.approvalId, summary: e.summary });
          break;
        case 'approval.resolved': {
          pending.current = pending.current.filter((a) => a.id !== e.approvalId);
          add(
            'note',
            e.status === 'approved'
              ? 'Approved. Running it.'
              : e.status === 'declined'
                ? 'Declined.'
                : e.status === 'expired'
                  ? 'The approval expired.'
                  : `The action is ${e.status}.`,
          );
          if (!pending.current.length && e.status !== 'executed' && e.status !== 'uncertain') {
            setStatus('Ready');
          }
          break;
        }
      }
    },
    [add, showApproval],
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
        // Cards opened before the TUI connected are still waiting.
        const { approvals } = await client.approvals();
        if (!cancelled) {
          for (const approval of approvals) {
            if (approval.status === 'pending') {
              showApproval({ id: approval.id, summary: approval.summary });
            }
          }
        }
        setStatus('Ready');
      } catch (error) {
        setStatus(`Cannot connect: ${(error as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      close?.();
    };
  }, [client, onEvent, showApproval]);

  const submit = useCallback(
    async (text: string) => {
      if (text === '/exit' || text === '/quit') return exit();
      if (text === '/help') {
        return add(
          'note',
          'Enter: send (also while working). Esc: stop. /new: new conversation. /soul: the standing instructions. /pair: pair a chat. /approve, /decline: answer an approval card. /usage: what it cost. /activity: recent tool calls. /exit: quit.',
        );
      }
      if (text.startsWith('/approve') || text.startsWith('/decline')) {
        const decision = text.startsWith('/approve') ? 'approve' : 'decline';
        const arg = text.split(/\s+/)[1];
        const target = arg
          ? pending.current.find((a) => a.id.startsWith(arg))
          : pending.current.at(-1);
        if (!target) return add('note', 'No approval is waiting.');
        try {
          const { approval } = await client.resolveApproval(target.id, decision);
          pending.current = pending.current.filter((a) => a.id !== target.id);
          add('note', `Approval ${approval.status}.`);
        } catch (error) {
          add('error', (error as Error).message);
        }
        return;
      }
      if (text === '/pair') {
        try {
          const { code, expiresAt } = await client.pair();
          add(
            'note',
            `Send /start ${code} to the bot in the chat you want to pair (valid until ` +
              `${expiresAt.slice(11, 16)} UTC).`,
          );
        } catch (error) {
          add('error', (error as Error).message);
        }
        return;
      }
      if (text === '/usage') {
        try {
          const usage = await client.usage();
          add(
            'note',
            `${usage.calls} model calls since ${usage.since.slice(0, 10)}: ${usage.inputTokens} in, ` +
              `${usage.outputTokens} out, ${formatMoney(usage.cost)}.`,
          );
        } catch (error) {
          add('error', (error as Error).message);
        }
        return;
      }
      if (text === '/activity') {
        try {
          const { receipts } = await client.activity(10);
          if (!receipts.length) {
            add('note', 'No tool calls yet.');
            return;
          }
          for (const receipt of receipts) {
            const took = receipt.durationMs === undefined ? '' : ` in ${receipt.durationMs} ms`;
            add(
              'note',
              `${receipt.tool} (${receipt.effect ?? '?'} / ${receipt.target ?? '?'}) → ` +
                `${receipt.outcome}${took} — ${receipt.allowedBy?.kind ?? 'unknown'}`,
            );
          }
        } catch (error) {
          add('error', (error as Error).message);
        }
        return;
      }
      if (text === '/soul') {
        try {
          const soul = await client.soul();
          add('note', `SOUL revision ${soul.revision}.`);
          reviewedSoul.current = soul.pending?.hash ?? null;
          if (soul.pending) {
            add('note', `${soul.pending.path} has an edit waiting. /soul apply keeps it.`);
            add('note', preview(soul.pending.proposed));
          } else {
            add('note', 'Edit SOUL.md in the data folder, then /soul to review and /soul apply.');
          }
        } catch (error) {
          add('error', (error as Error).message);
        }
        return;
      }
      if (text === '/soul apply') {
        if (!reviewedSoul.current) {
          return add('note', 'Review the edit with /soul first, then /soul apply.');
        }
        try {
          const revision = await client.applySoul(reviewedSoul.current);
          reviewedSoul.current = null;
          add('note', `SOUL revision ${revision} takes effect at the next turn.`);
        } catch (error) {
          add('error', (error as Error).message);
        }
        return;
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

/** The first lines of a proposed SOUL, so the TUI shows the gist rather than the whole file. */
const preview = (text: string) => text.split('\n').slice(0, 8).join('\n').slice(0, 600);

/** A cost as the TUI shows it; unknown prices stay unknown. */
const formatMoney = (cost: { micros: number; currency: string } | null) =>
  cost ? `${(cost.micros / 1_000_000).toFixed(4)} ${cost.currency}` : 'cost unknown';
const lineColor = (kind: Line['kind']) =>
  kind === 'owner'
    ? colors.accent
    : kind === 'assistant'
      ? undefined
      : kind === 'error'
        ? colors.error
        : kind === 'tool'
          ? colors.purple
          : kind === 'approval'
            ? colors.warning
            : colors.dim;

/** Starts the TUI; resolves when it exits. */
export async function startTUI(client: TuiClient): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error('The TUI needs an interactive terminal (stdin is not a TTY).');
  }
  const app = render(<ShitsujiApp client={client} />);
  await app.waitUntilExit();
}
