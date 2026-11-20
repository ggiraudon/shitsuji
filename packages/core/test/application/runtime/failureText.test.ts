import { describe, expect, it } from 'vitest';
import { failureText } from '../../../src/application/runtime/failureText.js';

describe('the owner-facing failure line (#101)', () => {
  it('turns a database encoding error into plain words', () => {
    const text = failureText('unsupported Unicode escape sequence');

    expect(text).toContain("couldn't save that result");
    expect(text).toContain('text file');
    expect(text).not.toContain('Unicode escape');
  });

  it('explains a context overflow and an unreachable model', () => {
    expect(failureText('maximum context length exceeded')).toMatch(/too long for the model/);
    expect(failureText('fetch failed')).toMatch(/model service could not be reached/);
  });

  it('keeps an ordinary reason as the error', () => {
    expect(failureText('No scripted reply left')).toBe('Error: No scripted reply left');
  });
});
