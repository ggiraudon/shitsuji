import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  InvalidTransition,
  NotFound,
  ProviderError,
  ShitsujiError,
  serializeError,
} from '../../src/domain/errors.js';

describe('ShitsujiError hierarchy', () => {
  it('keeps code, details and the specific message', () => {
    const error = new ProviderError('deepseek', 'Rate limited (429)', true, { retryAfterS: 20 });
    expect(error).toBeInstanceOf(ShitsujiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProviderError');
    expect(error.code).toBe('provider_failed');
    expect(error.message).toBe('Rate limited (429)');
    expect(error.details).toEqual({ provider: 'deepseek', retryable: true, retryAfterS: 20 });
  });

  it('builds readable messages for common cases', () => {
    expect(new NotFound('Session', 's1').message).toBe('Session s1 not found');
    expect(new InvalidTransition('Turn', 'done', 'running').message).toBe(
      'Turn cannot go from done to running',
    );
  });

  it('keeps the cause', () => {
    const cause = new Error('ENOENT');
    expect(new ConfigError('Cannot read config', {}, { cause }).cause).toBe(cause);
  });
});

describe('serializeError', () => {
  it('handles Shitsuji errors, plain errors with causes, and non-errors', () => {
    expect(serializeError(new NotFound('Turn', 't'))).toMatchObject({ code: 'not_found' });
    expect(serializeError(new Error('outer', { cause: new Error('inner') }))).toEqual({
      name: 'Error',
      message: 'outer',
      cause: { name: 'Error', message: 'inner' },
    });
    expect(serializeError('just a string')).toEqual({ name: 'NonError', message: 'just a string' });
  });
});
