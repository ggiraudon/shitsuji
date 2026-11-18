import { describe, expect, it } from 'vitest';
import { Turn } from '../../src/domain/model/Turn.js';
import { InvalidTransition } from '../../src/domain/errors.js';
import { asId, type SessionId, type TurnId } from '../../src/domain/model/ids.js';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 10, minute, 0));

const turn = () =>
  Turn.create({
    id: asId<TurnId>('turn-1'),
    sessionId: asId<SessionId>('session-1'),
    source: 'user',
    createdAt: at(0),
  });

describe('Turn (F04)', () => {
  it('goes queued -> running -> waiting -> succeeded when the owner answers (#30)', () => {
    const t = turn();
    t.start(at(1));
    t.wait(at(2));
    t.answered(at(3));

    expect(t.status).toBe('succeeded');
    expect(t.toProps()).toMatchObject({ startedAt: at(1), endedAt: at(3) });
  });

  it('still lets Stop cancel a waiting turn', () => {
    const t = turn();
    t.start(at(1));
    t.wait(at(2));
    t.cancel(at(3), 'stopped by owner');

    expect(t.status).toBe('cancelled');
  });

  it('refuses to answer a turn that is not waiting', () => {
    const t = turn();
    expect(() => t.answered(at(1))).toThrow(InvalidTransition);

    t.start(at(1));
    t.succeed(at(2));
    expect(() => t.answered(at(3))).toThrow(InvalidTransition);
  });
});
