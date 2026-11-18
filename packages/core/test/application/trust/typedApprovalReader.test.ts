import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TypedApprovalReader } from '../../../src/application/trust/TypedApprovalReader.js';
import { Approval } from '../../../src/domain/model/Approval.js';
import {
  asId,
  type ApprovalId,
  type OwnerId,
  type SessionId,
  type TurnId,
} from '../../../src/domain/model/ids.js';
import type { ModelProvider, ModelStreamEvent } from '../../../src/ports/ModelProvider.js';
import { ScriptedProvider, routerFor, testServices } from '../../helpers.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/trust');
const fixture = (name: string) => fs.readFileSync(path.join(fixtureDir, name), 'utf8');

const approval = Approval.request({
  id: asId<ApprovalId>('approval-1'),
  ownerId: asId<OwnerId>('owner'),
  turnId: asId<TurnId>('turn-1'),
  sessionId: asId<SessionId>('session-1'),
  tool: 'mail.send',
  effect: 'external',
  target: 'core',
  actionHash: 'a'.repeat(64),
  arguments: { to: 'anna@example.com' },
  summary: 'mail.send (external) {"to":"anna@example.com"}',
  createdAt: new Date(),
});

const readerWith = (provider: ModelProvider) => {
  const services = testServices();
  return {
    reader: new TypedApprovalReader({ models: routerFor(provider), log: services.log }),
    provider,
    log: services.log,
  };
};

describe('TypedApprovalReader (S37, F11)', () => {
  it('reads an unconditional yes and an unconditional no', async () => {
    const yes = readerWith(new ScriptedProvider([{ content: fixture('typed-yes.json') }], 'fake'));
    const no = readerWith(new ScriptedProvider([{ content: fixture('typed-no.json') }], 'fake'));

    expect(await yes.reader.read('Yes, go ahead.', approval)).toBe('approve');
    expect(await no.reader.read('No, do not send it.', approval)).toBe('decline');
  });

  it('does not approve "yes, but to Bob": a change is unclear, not an approval', async () => {
    const provider = new ScriptedProvider([{ content: fixture('typed-conditional.json') }], 'fake');
    const { reader } = readerWith(provider);

    expect(await reader.read('Yes, but send it to Bob instead.', approval)).toBe('unclear');
    const prompt = JSON.stringify(provider.requests[0]!.messages);
    expect(prompt).toContain('Yes, but send it to Bob instead.');
    expect(prompt).toContain('mail.send');
  });

  it('fails safe to unclear on a malformed answer or a provider error', async () => {
    const malformed = readerWith(new ScriptedProvider([{ content: 'sure!' }], 'fake'));
    expect(await malformed.reader.read('yes', approval)).toBe('unclear');

    const broken: ModelProvider = {
      id: 'broken',
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield { type: 'text_delta', text: '' };
        throw new Error('down');
      },
      async listModels() {
        return [];
      },
    };
    expect(await readerWith(broken).reader.read('yes', approval)).toBe('unclear');
  });

  it('leaves room for the reasoning before the answer, and warns on a cut-off reply (#63)', async () => {
    const reasoner = new ScriptedProvider(
      [
        {
          reasoning: 'The owner said yes plainly, with no condition attached.',
          content: fixture('typed-yes.json'),
        },
      ],
      'fake',
    );
    const { reader, log } = readerWith(reasoner);

    expect(await reader.read('Yes, go ahead.', approval)).toBe('approve');
    // 20 tokens ended deepseek-flash mid-reasoning, so a plain yes counted as unclear.
    expect(reasoner.requests[0]!.maxOutputTokens).toBe(400);
    expect(log.records.some((r) => /token limit/.test(r.message))).toBe(false);

    const truncated = readerWith(
      new ScriptedProvider(
        [
          {
            reasoning: 'The owner said yes plainly, so this is an unconditional approval.',
            content: '{"answer": "app',
            finishReason: 'length',
          },
        ],
        'fake',
      ),
    );

    expect(await truncated.reader.read('Yes, go ahead.', approval)).toBe('unclear');
    expect(
      truncated.log.records.some(
        (r) =>
          r.level === 'warn' &&
          r.message === 'Typed approval answer stopped at its token limit; treating it as unclear',
      ),
    ).toBe(true);
  });
});
