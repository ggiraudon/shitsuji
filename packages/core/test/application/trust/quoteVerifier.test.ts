import { describe, expect, it } from 'vitest';
import type { Authority } from '../../../src/application/trust/Authority.js';
import { QuoteVerifier } from '../../../src/application/trust/QuoteVerifier.js';

const authority = (words: string[], instruction?: string): Authority => ({
  words,
  rules: [],
  ...(instruction && { instruction }),
});

describe('QuoteVerifier (S35, F11)', () => {
  const verifier = new QuoteVerifier();

  it("accepts the owner's words, verbatim", () => {
    const owner = authority(['Email Anna the quarterly report, please.']);

    expect(verifier.verify('Email Anna the quarterly report', owner)).toBe(true);
    expect(verifier.verify('  Email Anna the quarterly report  ', owner)).toBe(true);
  });

  it('rejects a made-up quote, a paraphrase and a changed recipient', () => {
    const owner = authority(['Email Anna the quarterly report, please.']);

    expect(verifier.verify('Email Bob the quarterly report', owner)).toBe(false);
    expect(verifier.verify('send Anna the report', owner)).toBe(false);
    expect(verifier.verify('EMAIL ANNA THE QUARTERLY REPORT', owner)).toBe(false);
  });

  it('rejects a quote assembled across two messages', () => {
    const owner = authority(['Email Anna the', 'quarterly report.']);

    expect(verifier.verify('Email Anna the quarterly report', owner)).toBe(false);
  });

  it('rejects an empty or trivial quote', () => {
    const owner = authority(['Email Anna the report.']);

    expect(verifier.verify(undefined, owner)).toBe(false);
    expect(verifier.verify('', owner)).toBe(false);
    expect(verifier.verify('  ', owner)).toBe(false);
    expect(verifier.verify('a', owner)).toBe(false);
  });

  it('accepts a routine instruction, because it is authority too', () => {
    const owner = authority([], 'Send the weekly report to Anna every Monday.');

    expect(verifier.verify('Send the weekly report to Anna', owner)).toBe(true);
  });
});
