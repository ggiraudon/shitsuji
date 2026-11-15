import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/adapters/clock/SystemClock.js';
import { JsonLogger, MemoryLogger, PrettyLogger } from '../../../src/adapters/logging/loggers.js';
import { ProviderError } from '../../../src/domain/errors.js';
import type { LogLevel } from '../../../src/ports/Logger.js';

const capture = () => {
  const lines: { line: string; level: LogLevel }[] = [];
  return { lines, sink: (line: string, level: LogLevel) => void lines.push({ line, level }) };
};
const clock = new ManualClock('2026-03-01T10:00:00Z');

describe('JsonLogger', () => {
  it('writes one JSON object per line with time, level, message and context', () => {
    const { lines, sink } = capture();
    new JsonLogger({ clock, sink }).info('started', { port: 8080 });
    expect(JSON.parse(lines[0]!.line)).toEqual({
      time: '2026-03-01T10:00:00.000Z',
      level: 'info',
      msg: 'started',
      port: 8080,
    });
  });

  it('drops lines below the configured level', () => {
    const { lines, sink } = capture();
    const log = new JsonLogger({ clock, sink, level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('adds child bindings to every line without changing the parent', () => {
    const { lines, sink } = capture();
    const parent = new JsonLogger({ clock, sink, bindings: { service: 'core' } });
    parent.child({ component: 'agent' }).info('a');
    parent.info('b');
    expect(lines.map((l) => JSON.parse(l.line))).toMatchObject([
      { service: 'core', component: 'agent', msg: 'a' },
      { service: 'core', msg: 'b' },
    ]);
    expect(JSON.parse(lines[1]!.line)).not.toHaveProperty('component');
  });

  it('serialises errors in the context instead of printing {}', () => {
    const { lines, sink } = capture();
    const error = new ProviderError('deepseek', 'HTTP 503', true);
    new JsonLogger({ clock, sink }).error('model call failed', { error });
    expect(JSON.parse(lines[0]!.line).error).toEqual({
      name: 'ProviderError',
      code: 'provider_failed',
      message: 'HTTP 503',
      details: { provider: 'deepseek', retryable: true },
    });
  });
});

describe('PrettyLogger', () => {
  it('keeps the existing human-readable format', () => {
    const { lines, sink } = capture();
    const log = new PrettyLogger({ clock, sink });
    log.info('Configuration loaded', { dataDir: '/data' });
    log.warn('plain');
    expect(lines.map((l) => l.line)).toEqual([
      '[2026-03-01T10:00:00.000Z] [INFO] Configuration loaded {"dataDir":"/data"}',
      '[2026-03-01T10:00:00.000Z] [WARN] plain',
    ]);
  });
});

describe('MemoryLogger', () => {
  it('shares records with its children', () => {
    const log = new MemoryLogger();
    log.child({ c: 1 }).info('x');
    expect(log.records).toMatchObject([{ level: 'info', message: 'x', context: { c: 1 } }]);
  });
});
