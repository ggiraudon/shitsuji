import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actionRequest } from '../../../src/application/trust/ActionRequest.js';
import type { Authority } from '../../../src/application/trust/Authority.js';
import { TrustJudge } from '../../../src/application/trust/TrustJudge.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '../../../src/ports/ModelProvider.js';
import { ScriptedProvider, routerFor, testServices } from '../../helpers.js';

/** Hand-written from the judge's reply contract; replace with a real recording once a model is called. */
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/trust');
const fixture = (name: string) => fs.readFileSync(path.join(fixtureDir, name), 'utf8');

const action = actionRequest({
  tool: 'mail.send',
  arguments: { to: 'anna@example.com', subject: 'Quarterly report' },
  effect: 'external',
  target: 'core',
});

const authority: Authority = {
  words: ['Email Anna the quarterly report, please.', 'Yes, go ahead.'],
  rules: [],
};

const judgeWith = (provider: ModelProvider, timeoutMs = 5_000) => {
  const services = testServices();
  return {
    judge: new TrustJudge({ models: routerFor(provider), log: services.log, timeoutMs }),
    services,
    provider,
  };
};

describe('TrustJudge (S35, F11)', () => {
  it("allows with the owner's quote, on the trust purpose", async () => {
    const provider = new ScriptedProvider([{ content: fixture('judge-allow.json') }], 'fake');
    const { judge } = judgeWith(provider);

    const decision = await judge.judge(action, authority);

    expect(decision).toEqual({
      verdict: 'allow',
      quote: 'Email Anna the quarterly report',
      reason: 'The owner named Anna and the report.',
    });
    expect(provider.requests[0]!.metadata?.purpose).toBe('trust');
    expect(provider.requests[0]!.temperature).toBe(0);
    const prompt = JSON.stringify(provider.requests[0]!.messages);
    expect(prompt).toContain('Email Anna the quarterly report');
    expect(prompt).toContain('mail.send');
  });

  it('passes ask and deny straight through', async () => {
    const ask = judgeWith(new ScriptedProvider([{ content: fixture('judge-ask.json') }], 'fake'));
    const deny = judgeWith(new ScriptedProvider([{ content: fixture('judge-deny.json') }], 'fake'));

    expect(await ask.judge.judge(action, authority)).toMatchObject({ verdict: 'ask' });
    expect(await deny.judge.judge(action, authority)).toMatchObject({
      verdict: 'deny',
      reason: 'The owner said never to email this client.',
    });
  });

  it('turns an allow without a quote into an ask when a quote is required', async () => {
    const { judge } = judgeWith(
      new ScriptedProvider(
        [{ content: fixture('judge-no-quote.json') }, { content: fixture('judge-no-quote.json') }],
        'fake',
      ),
    );

    expect(await judge.judge(action, authority)).toMatchObject({ verdict: 'ask' });
    expect(await judge.judge(action, authority, { quoteRequired: false })).toMatchObject({
      verdict: 'allow',
    });
  });

  it('fails safe to ask on a malformed reply', async () => {
    const { judge } = judgeWith(
      new ScriptedProvider([{ content: 'I think it is fine to send.' }], 'fake'),
    );

    expect(await judge.judge(action, authority)).toMatchObject({ verdict: 'ask' });
  });

  it('fails safe to ask when the provider throws', async () => {
    const services = testServices();
    const provider: ModelProvider = {
      id: 'broken',
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: 'text_delta', text: '' };
        throw new Error('provider down');
      },
      async listModels() {
        return [];
      },
    };
    const judge = new TrustJudge({ models: routerFor(provider), log: services.log });

    expect(await judge.judge(action, authority)).toMatchObject({ verdict: 'ask' });
    expect(
      services.log.records.some((r) => r.message === 'Trust judgement failed; asking the owner'),
    ).toBe(true);
  });

  it('fails safe to ask when the judgement times out', async () => {
    class HangingProvider implements ModelProvider {
      readonly id = 'hang';
      async *stream(_request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'));
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        yield { type: 'done', finishReason: 'stop' };
      }
      async listModels() {
        return [];
      }
    }
    const { judge } = judgeWith(new HangingProvider(), 20);

    expect(await judge.judge(action, authority)).toMatchObject({ verdict: 'ask' });
  });
});
