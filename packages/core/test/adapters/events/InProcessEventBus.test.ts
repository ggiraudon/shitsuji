import { describe, expect, it, vi } from 'vitest';
import { InProcessEventBus } from '../../../src/adapters/events/InProcessEventBus.js';
import { ManualClock } from '../../../src/adapters/clock/SystemClock.js';
import { MemoryLogger } from '../../../src/adapters/logging/loggers.js';

const setup = () => {
  const log = new MemoryLogger();
  const clock = new ManualClock('2026-03-01T10:00:00Z');
  return { log, clock, bus: new InProcessEventBus(log, clock) };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('InProcessEventBus', () => {
  it('delivers a payload and the event envelope to exact subscribers', () => {
    const { bus } = setup();
    const handler = vi.fn();
    bus.subscribe('session.created', handler);

    bus.publish('session.created', { sessionId: 's1', agentId: 'a1' }, { source: 'test' });

    expect(handler).toHaveBeenCalledWith(
      { sessionId: 's1', agentId: 'a1' },
      {
        type: 'session.created',
        payload: { sessionId: 's1', agentId: 'a1' },
        meta: { source: 'test' },
        at: new Date('2026-03-01T10:00:00Z'),
      },
    );
  });

  it('does not deliver other events to an exact subscriber', () => {
    const { bus } = setup();
    const handler = vi.fn();
    bus.subscribe('tool.called', handler);
    bus.publish('tool.result', { sessionId: 's', toolName: 't', toolCallId: 'c', success: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('matches prefix patterns and the catch-all', () => {
    const { bus } = setup();
    const tools: string[] = [];
    const all: string[] = [];
    bus.subscribePattern('tool.*', (_p, e) => void tools.push(e.type));
    bus.subscribePattern('*', (_p, e) => void all.push(e.type));

    bus.publish('tool.called', { sessionId: 's', toolName: 't', toolCallId: 'c' });
    bus.publish('session.ended', { sessionId: 's' });

    expect(tools).toEqual(['tool.called']);
    expect(all).toEqual(['tool.called', 'session.ended']);
  });

  it('stops delivering after unsubscribe', () => {
    const { bus } = setup();
    const handler = vi.fn();
    const off = bus.subscribe('session.ended', handler);
    off();
    bus.publish('session.ended', { sessionId: 's' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('turns a throwing handler into system.error and keeps delivering to others', () => {
    const { bus, log } = setup();
    const errors = vi.fn();
    const second = vi.fn();
    bus.subscribe('system.error', errors);
    bus.subscribe('session.ended', () => {
      throw new Error('boom');
    });
    bus.subscribe('session.ended', second);

    expect(() => bus.publish('session.ended', { sessionId: 's' })).not.toThrow();

    expect(second).toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      { error: { name: 'Error', message: 'boom' }, event: 'session.ended' },
      expect.anything(),
    );
    expect(log.records.map((r) => r.level)).toEqual(['error']);
  });

  it('turns a rejected async handler into system.error', async () => {
    const { bus } = setup();
    const errors = vi.fn();
    bus.subscribe('system.error', errors);
    bus.subscribe('session.ended', async () => {
      throw new Error('later');
    });

    bus.publish('session.ended', { sessionId: 's' });
    await flush();

    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'later' }) }),
      expect.anything(),
    );
  });

  it('only logs when a system.error handler itself fails, so it cannot loop', () => {
    const { bus, log } = setup();
    const errorHandler = vi.fn(() => {
      throw new Error('error handler broke');
    });
    bus.subscribe('system.error', errorHandler);
    bus.subscribe('session.ended', () => {
      throw new Error('first');
    });

    bus.publish('session.ended', { sessionId: 's' });

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(log.records.map((r) => r.context.event)).toEqual(['session.ended', 'system.error']);
  });
});
