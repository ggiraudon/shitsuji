import { describe, expect, it } from 'vitest';
import { InvalidTransition } from '../../src/domain/errors.js';
import {
  asId,
  newId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from '../../src/domain/model/ids.js';
import { textOf, toolCallsOf, stripNul, type ContentPart } from '../../src/domain/model/Message.js';
import { Money } from '../../src/domain/model/Money.js';
import { Thread } from '../../src/domain/model/Thread.js';
import { Turn, type TurnStatus } from '../../src/domain/model/Turn.js';

const t0 = new Date('2026-03-01T10:00:00Z');
const t1 = new Date('2026-03-01T10:00:05Z');
const newTurn = () =>
  Turn.create({
    id: newId<TurnId>(),
    sessionId: newId<SessionId>(),
    source: 'user',
    createdAt: t0,
  });

describe('Turn state machine', () => {
  it('knows which turns the background allowance covers (F22)', () => {
    const turn = (source: 'user' | 'task' | 'schedule' | 'event' | 'resume') =>
      Turn.create({
        id: newId<TurnId>(),
        sessionId: newId<SessionId>(),
        source,
        createdAt: t0,
      });
    expect(turn('user').isBackground).toBe(false);
    expect(turn('resume').isBackground).toBe(false);
    for (const source of ['task', 'schedule', 'event'] as const) {
      expect(turn(source).isBackground, source).toBe(true);
    }
  });

  it('starts queued and records times through a successful run', () => {
    const turn = newTurn();
    expect(turn.status).toBe('queued');
    turn.start(t0);
    turn.succeed(t1);
    expect(turn.status).toBe('succeeded');
    expect(turn.isTerminal).toBe(true);
    expect(turn.toProps()).toMatchObject({ startedAt: t0, endedAt: t1 });
  });

  it('records the reason when a turn fails or is cancelled', () => {
    const failed = newTurn();
    failed.start(t0);
    failed.fail(t1, 'interrupted');
    expect(failed.toProps()).toMatchObject({ status: 'failed', error: 'interrupted' });

    const stopped = newTurn();
    stopped.cancel(t1, 'stopped by owner');
    expect(stopped.toProps()).toMatchObject({ status: 'cancelled', error: 'stopped by owner' });
  });

  const legal: [TurnStatus, TurnStatus][] = [
    ['queued', 'running'],
    ['queued', 'cancelled'],
    ['running', 'succeeded'],
    ['running', 'waiting'],
    ['running', 'failed'],
    ['running', 'cancelled'],
    ['waiting', 'succeeded'],
    ['waiting', 'cancelled'],
  ];
  const all: TurnStatus[] = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'];

  it('allows exactly the transitions in the F04 diagram', () => {
    for (const from of all) {
      for (const to of all) {
        const expected = legal.some(([f, t]) => f === from && t === to);
        expect(Turn.canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('throws InvalidTransition on an illegal transition and leaves the turn unchanged', () => {
    const turn = newTurn();
    turn.start(t0);
    turn.succeed(t1);
    expect(() => turn.start(t1)).toThrow(InvalidTransition);
    expect(() => turn.fail(t1, 'x')).toThrow('Turn cannot go from succeeded to failed');
    expect(turn.status).toBe('succeeded');

    expect(() => newTurn().succeed(t1)).toThrow('Turn cannot go from queued to succeeded');
  });

  it('restores a stored turn in its saved status', () => {
    const stored = newTurn();
    stored.start(t0);
    const restored = Turn.restore(stored.toProps());
    expect(restored.status).toBe('running');
    restored.fail(t1, 'interrupted');
    expect(stored.status).toBe('running'); // toProps() is a copy
  });
});

describe('Thread', () => {
  it('can be archived once', () => {
    const thread = new Thread(newId(), asId('owner-1'), t0);
    expect(thread.status).toBe('active');
    thread.archive();
    expect(thread.status).toBe('archived');
    expect(() => thread.archive()).toThrow(InvalidTransition);
  });
});

describe('Message helpers', () => {
  const parts: ContentPart[] = [
    { type: 'reasoning', text: 'The user wants a sum.' },
    { type: 'text', text: 'Let me ' },
    {
      type: 'tool_call',
      call: { id: asId('c1'), name: 'calculator', arguments: { expression: '1+1' } },
    },
    { type: 'text', text: 'check.' },
  ];

  it('joins text parts and leaves reasoning out', () => {
    expect(textOf({ parts })).toBe('Let me check.');
  });

  it('extracts tool calls', () => {
    expect(toolCallsOf({ parts }).map((c) => c.name)).toEqual(['calculator']);
  });
});

describe('ids', () => {
  it('creates unique ids and refuses empty ones', () => {
    expect(newId()).not.toBe(newId());
    expect(() => asId('')).toThrow(TypeError);
  });
});

describe('Money', () => {
  it('adds tiny amounts exactly', () => {
    let total = Money.zero();
    for (let i = 0; i < 1000; i++) total = total.plus(Money.of(0.000123));
    expect(total.micros).toBe(123_000);
    expect(total.toString()).toBe('0.123 USD');
  });

  it('prices tokens with a per-million rate', () => {
    const perMTok = Money.of(0.27);
    expect(perMTok.times(12_345 / 1_000_000).toString()).toBe('0.003333 USD');
  });

  it('compares, formats and serialises', () => {
    expect(Money.of(1).compare(Money.of(2))).toBe(-1);
    expect(Money.of(5).toString()).toBe('5.00 USD');
    expect(JSON.stringify(Money.of(0.5, 'EUR'))).toBe('{"micros":500000,"currency":"EUR"}');
  });

  it('refuses to mix currencies or accept bad codes', () => {
    expect(() => Money.of(1, 'USD').plus(Money.of(1, 'EUR'))).toThrow(/Cannot combine USD and EUR/);
    expect(() => Money.of(1, 'usd')).toThrow(/Invalid currency/);
  });
});

describe('stored image references (S52)', () => {
  it('survives stripNul and JSON as a reference, never bytes', () => {
    const part: ContentPart = {
      type: 'tool_result',
      toolCallId: asId<ToolCallId>('t1'),
      content: 'a\u0000b',
      isError: false,
      images: [
        {
          mediaType: 'image/png',
          ref: 'sessions/s1/images/a\u0000.png',
          name: 'a\u0000.png',
        },
      ],
    };
    const clean = stripNul(part) as Extract<ContentPart, { type: 'tool_result' }>;
    expect(clean.content).toBe('ab');
    expect(clean.images).toEqual([
      { mediaType: 'image/png', ref: 'sessions/s1/images/a.png', name: 'a.png' },
    ]);
    expect(JSON.stringify(clean)).not.toContain('base64');
    expect(JSON.parse(JSON.stringify(clean))).toEqual(clean);
  });
});
