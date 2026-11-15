import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/adapters/clock/SystemClock.js';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { InMemoryRepositories } from '../../src/adapters/memory/InMemoryRepositories.js';
import { ContextBuilder } from '../../src/application/context/ContextBuilder.js';
import { ClockInjectable } from '../../src/application/context/ClockInjectable.js';
import { OwnerProfileInjectable } from '../../src/application/context/OwnerProfileInjectable.js';
import { Session, type SessionKind } from '../../src/domain/model/Session.js';
import { Turn } from '../../src/domain/model/Turn.js';
import {
  asId,
  newId,
  type OwnerId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from '../../src/domain/model/ids.js';
import type { ContentPart, Message, MessageRole } from '../../src/domain/model/Message.js';
import {
  BaseContextInjectable,
  type ContextInjectable,
  type InjectionCondition,
  type InjectionPlacement,
} from '../../src/ports/ContextInjectable.js';

const OWNER = asId<OwnerId>('owner');

class Note extends BaseContextInjectable {
  readonly name: string;
  readonly description = '';
  constructor(
    readonly id: string,
    placement: InjectionPlacement,
    order: number,
    private readonly text: string | null,
    condition: InjectionCondition = { type: 'always' },
  ) {
    super();
    this.name = id;
    this.placement = placement;
    this.order = order;
    this.condition = condition;
  }
  render(): string | null {
    return this.text;
  }
}

async function fixture(
  injectables: ContextInjectable[],
  options: { kind?: SessionKind; historyLimit?: number } = {},
) {
  const repos = new InMemoryRepositories();
  const log = new MemoryLogger();
  const clock = new ManualClock('2026-11-15T09:00:00.000Z');
  await repos.owners.upsert({
    id: OWNER,
    displayName: 'Jeanne',
    timezone: 'Europe/Paris',
    locale: 'fr-FR',
  });
  const thread = await repos.threads.getOrCreateForOwner(OWNER, clock.now());
  const session = new Session(newId<SessionId>(), thread.id, options.kind ?? 'chat', clock.now());
  await repos.sessions.insert(session);
  const turn = Turn.create({
    id: newId<TurnId>(),
    sessionId: session.id,
    source: 'user',
    createdAt: clock.now(),
  });

  const append = async (role: MessageRole, parts: ContentPart[], turnId: TurnId = turn.id) => {
    const message: Message = {
      id: newId(),
      threadId: thread.id,
      sessionId: session.id,
      turnId,
      role,
      author: role === 'user' ? 'owner' : role === 'assistant' ? 'assistant' : 'system',
      parts,
      withdrawn: false,
      createdAt: clock.now(),
    };
    await repos.messages.append(message);
    return message;
  };

  const builder = new ContextBuilder({
    injectables: () => injectables,
    repos,
    ownerId: OWNER,
    log,
    historyLimit: options.historyLimit,
  });
  return { builder, repos, session, turn, append, log, clock };
}

const text = (value: string): ContentPart[] => [{ type: 'text', text: value }];

describe('ContextBuilder: placement and order (S23)', () => {
  it('lays out headers in order, context notes at the start, and the tail on the newest message', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('tail-2', 'tail', 2, 'TAIL TWO'),
      new Note('header-2', 'header', 2, 'HEADER TWO'),
      new Note('context-1', 'context', 1, 'CONTEXT ONE'),
      new Note('header--1', 'header', -1, 'HEADER FIRST'),
      new Note('tail-1', 'tail', 1, 'TAIL ONE'),
      new Note('context-0', 'context', 0, 'CONTEXT ZERO'),
      new Note('header-0', 'header', 0, 'HEADER MIDDLE'),
    ]);
    await append('user', text('Good evening.'));

    const built = await builder.build(session, turn);

    expect(built.header.map((n) => n.id)).toEqual(['header--1', 'header-0', 'header-2']);
    expect(built.system).toBe('HEADER FIRST\n\nHEADER MIDDLE\n\nHEADER TWO');
    expect(built.context.map((n) => n.id)).toEqual(['context-0', 'context-1']);
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(built.messages[0]!.parts).toEqual([{ type: 'text', text: 'CONTEXT ZERO' }]);
    expect(built.messages[1]!.parts).toEqual([{ type: 'text', text: 'CONTEXT ONE' }]);
    // The tail joined, on the owner's message: this call carries it, the transcript does not.
    expect(built.tail).toBe('TAIL ONE\n\nTAIL TWO');
    expect(built.messages.at(-1)!.parts).toEqual([
      { type: 'text', text: 'Good evening.' },
      { type: 'text', text: 'TAIL ONE\n\nTAIL TWO' },
    ]);
  });

  it('keeps the tail on the opening request, unchanged, for every step of a turn', async () => {
    let now = 'It is 09:00.';
    const clockNote = new (class extends Note {
      override render() {
        return now;
      }
    })('clock', 'tail', 2, '');
    const { builder, session, turn, append } = await fixture([clockNote]);
    await append('user', text('What is the time?'));
    const first = await builder.build(session, turn);

    await append('assistant', [
      { type: 'tool_call', call: { id: asId<ToolCallId>('c1'), name: 'x', arguments: {} } },
    ]);
    await append('tool', text('tool output'));
    now = 'It is 09:01.';
    const second = await builder.build(session, turn);

    // The second step's request starts with exactly the first one: the provider's cache still matches.
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.messages[0]!.parts.at(-1)).toEqual({ type: 'text', text: 'It is 09:00.' });

    // The next turn renders it afresh, on its own opening request.
    const next = Turn.create({
      id: newId<TurnId>(),
      sessionId: session.id,
      source: 'user',
      createdAt: new Date(),
    });
    await append('assistant', text('Nine.'));
    await append('user', text('And now?'), next.id);
    const third = await builder.build(session, next);
    expect(third.messages.at(-1)!.parts.at(-1)).toEqual({ type: 'text', text: 'It is 09:01.' });
    expect(third.messages[0]!.parts).toEqual(text('What is the time?'));
  });

  it('adds the tail as a note at the end when the turn has no owner message', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('clock', 'tail', 2, 'It is 09:00.'),
    ]);
    await append('user', text('An earlier request.'), newId<TurnId>());
    await append('assistant', [
      { type: 'tool_call', call: { id: asId<ToolCallId>('c1'), name: 'x', arguments: {} } },
    ]);
    await append('tool', text('tool output'));

    const built = await builder.build(session, turn);

    expect(built.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(built.messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'It is 09:00.' }]);
  });

  it('renders a once injectable only in its first call of a session', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('welcome', 'header', 0, 'WELCOME', { type: 'once' }),
    ]);
    await append('user', text('hello'));

    const first = await builder.build(session, turn);
    const second = await builder.build(session, turn);

    expect(first.system).toBe('WELCOME');
    expect(second.system).toBeUndefined();
  });

  it('puts the owner profile in the header and the clock in the tail, never the header', async () => {
    const injectables: ContextInjectable[] = [];
    const { builder, session, turn, append, clock } = await fixture(injectables);
    injectables.push(new OwnerProfileInjectable(), new ClockInjectable(clock));
    await append('user', text('What time is it?'));

    const built = await builder.build(session, turn);

    expect(built.header.map((n) => n.id)).toEqual(['owner-profile']);
    expect(built.system).toContain('Jeanne');
    expect(built.system).toContain('Europe/Paris');
    expect(built.system).not.toContain('Current local date and time');
    expect(built.tail).toContain('10:00'); // 09:00 UTC in Paris
    expect(built.messages.at(-1)!.parts).toContainEqual({
      type: 'text',
      text: built.tail,
    });
  });

  it('selects injectables by session kind', async () => {
    const { builder, session, turn, append } = await fixture([
      new Note('chat-only', 'header', 0, 'CHAT', { type: 'session_kind', kinds: ['chat'] }),
      new Note('task-only', 'header', 1, 'TASK', { type: 'session_kind', kinds: ['task'] }),
    ]);
    await append('user', text('hello'));

    const built = await builder.build(session, turn);

    expect(built.header.map((n) => n.id)).toEqual(['chat-only']);
  });

  it('never drops the open request when the history is longer than the window', async () => {
    const { builder, session, turn, append } = await fixture([], { historyLimit: 3 });
    for (let i = 0; i < 6; i++) {
      await append('assistant', text(`answer ${i}`), newId<TurnId>());
      await append('user', text(`follow-up ${i}`), newId<TurnId>());
    }
    // The open request, then a long tool loop in the same turn: the last three messages alone
    // would not include it.
    await append('user', text('the open request'));
    for (let i = 0; i < 4; i++) {
      await append('assistant', text(`working ${i}`));
    }

    const built = await builder.build(session, turn);

    expect(built.sources[0]!.parts).toEqual([{ type: 'text', text: 'the open request' }]);
    expect(built.messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'working 3' }]);
  });
});

/** A note whose text changes on every render, like a clock that ended up in the header. */
class VolatileNote extends BaseContextInjectable {
  readonly id = 'volatile';
  readonly name = 'Volatile';
  readonly description = '';
  constructor(placement: InjectionPlacement) {
    super();
    this.placement = placement;
  }
  private count = 0;
  render(): string {
    return `CHANGED ${++this.count}`;
  }
}

describe('ContextBuilder: header stability check (S23)', () => {
  it('warns once when a header injectable changes on every call', async () => {
    const { builder, session, turn, append, log } = await fixture([new VolatileNote('header')]);
    await append('user', text('hello'));

    await builder.build(session, turn);
    await builder.build(session, turn);
    await builder.build(session, turn);
    await builder.build(session, turn);

    const warnings = log.records.filter((r) => r.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/header injectable changes/);
    expect(warnings[0]!.context.injectable).toBe('volatile');
  });

  it('stays quiet for a stable header and a volatile tail', async () => {
    const { builder, session, turn, append, log } = await fixture([
      new Note('identity', 'header', -1, 'You are Shitsuji.'),
      new VolatileNote('tail'),
    ]);
    await append('user', text('hello'));

    for (let i = 0; i < 4; i++) await builder.build(session, turn);

    expect(log.records.filter((r) => r.level === 'warn')).toEqual([]);
  });

  it('accepts a header that changes once', async () => {
    class ChangesOnce extends BaseContextInjectable {
      readonly id = 'once-only';
      readonly name = 'Once';
      readonly description = '';
      private calls = 0;
      render(): string {
        return ++this.calls === 1 ? 'FIRST' : 'SECOND';
      }
    }
    const { builder, session, turn, append, log } = await fixture([new ChangesOnce()]);
    await append('user', text('hello'));

    await builder.build(session, turn);
    await builder.build(session, turn);
    await builder.build(session, turn);

    expect(log.records.filter((r) => r.level === 'warn')).toEqual([]);
  });
});
