import { afterAll, describe, expect, it } from 'vitest';
import { shitsujiConfigSchema } from '../../src/composition/config/schema.js';
import { createShitsuji } from '../../src/composition/createShitsuji.js';
import type { ShitsujiPlugin } from '../../src/ports/Plugin.js';
import { ScriptedProvider, testServices, transcript } from '../helpers.js';
import { closeAll, freshDatabase } from './postgres.js';

afterAll(closeAll);

const fakeModel = (provider: ScriptedProvider): ShitsujiPlugin => ({
  manifest: { id: 'test.model', name: 'model', version: '1', provides: ['model'] },
  register: (ctx) => ctx.addModelProvider(provider),
});

describe('restarting core (F02)', () => {
  it('keeps the thread and its messages across a restart', async () => {
    const { url } = await freshDatabase();
    const config = shitsujiConfigSchema.parse({
      database: { url },
      channels: { cli: { enabled: false }, webhook: { enabled: false } },
      models: { providers: { fake: { kind: 'plugin' } }, purposes: { chat: 'fake/m' } },
    });

    const before = new ScriptedProvider([{ content: 'Noted: your name is Sam.' }], 'fake');
    const first = await createShitsuji(config, {
      services: testServices(),
      plugins: [fakeModel(before)],
    });
    const one = await first.agent.send('My name is Sam');
    await first.stop();

    const after = new ScriptedProvider([{ content: 'You are Sam.' }], 'fake');
    const second = await createShitsuji(config, {
      services: testServices(),
      plugins: [fakeModel(after)],
    });
    const two = await second.agent.send('What is my name?');
    await second.stop();

    expect(two.sessionId).toBe(one.sessionId);
    const sent = transcript(after.requests[0]!);
    expect(sent).toEqual([
      'user:My name is Sam',
      'assistant:Noted: your name is Sam.',
      'user:What is my name?',
    ]);
  });

  it('fails clearly when the database cannot be reached', async () => {
    const config = shitsujiConfigSchema.parse({
      database: { url: 'postgres://nobody:wrong@127.0.0.1:1/none' },
      models: { providers: { fake: { kind: 'plugin' } }, purposes: { chat: 'fake/m' } },
    });
    await expect(createShitsuji(config, { services: testServices() })).rejects.toThrow(
      /Cannot use the database at database\.url/,
    );
  });
});
