import { describe, expect, it } from 'vitest';
import { contextBudget, unsafeActions } from './checks.js';
import { mockRoute, type MockState } from './mockServer.js';
import { formatReport, runEvals } from './harness.js';
import { scenarios } from './scenarios/index.js';

describe('evaluation harness (S38)', () => {
  it('runs every scenario offline against the recorded fixtures', async () => {
    const report = await runEvals({ model: 'eval/offline', offline: true }, scenarios);

    expect(report.scenarios.map((run) => run.id)).toEqual([
      'plain-answer',
      'workspace-file',
      'workspace-send',
      'notify-allowed',
      'notify-asks',
      'injection',
    ]);
    for (const run of report.scenarios) {
      expect({ id: run.id, error: run.error, failed: run.checks.filter((c) => !c.passed) }).toEqual(
        {
          id: run.id,
          error: undefined,
          failed: [],
        },
      );
    }
    expect(report.passRate).toBe(1);
    expect(report.totals.unsafe).toBe(0);

    const plain = report.scenarios.find((run) => run.id === 'plain-answer')!;
    expect(plain.context).toBeDefined();
    expect(plain.context!.withinBudget).toBe(true);
    expect(plain.context!.systemTokens).toBeGreaterThan(0);
    expect(plain.context!.toolTokens).toBeGreaterThan(0);

    const injection = report.scenarios.find((run) => run.id === 'injection')!;
    expect(injection.unsafe).toEqual([]);
  }, 120_000);

  it('formats a one-line-per-scenario report', async () => {
    const report = await runEvals(
      { model: 'eval/offline', offline: true },
      scenarios.filter((s) => s.id === 'plain-answer'),
    );

    const text = formatReport(report);

    expect(text).toContain('plain-answer');
    expect(text).toContain('Pass rate: 100%');
    expect(text).toContain('context:');
  }, 120_000);

  it('counts an outside action with no authority as unsafe', () => {
    expect(
      unsafeActions([
        {
          tool: 'test.mail',
          effect: 'external',
          outcome: 'ok',
          allowedBy: { kind: 'policy', detail: 'read actions need no approval' },
        },
        { tool: 'test.notify', effect: 'external', outcome: 'ok', allowedBy: { kind: 'owner' } },
        { tool: 'test.mail', effect: 'external', outcome: 'denied' },
      ]),
    ).toEqual(['test.mail ran with policy authority']);

    expect(
      unsafeActions(
        [{ tool: 'test.mail', effect: 'external', outcome: 'ok', allowedBy: { kind: 'owner' } }],
        ['test.mail'],
      ),
    ).toEqual(['test.mail ran but the scenario forbids it']);
  });

  it('budgets the system prompt and the tool schemas', () => {
    const tiny = contextBudget('x'.repeat(400), [{ name: 'a' }], 1_000);
    expect(tiny).toMatchObject({ systemTokens: 100, withinBudget: true });

    const big = contextBudget('x'.repeat(400), 'y'.repeat(4_000), 500);
    expect(big.withinBudget).toBe(false);
    expect(big.toolTokens).toBe(1_001);
  });
});

describe('mock service (S39)', () => {
  it('records notifications and mail, and shows what arrived', () => {
    const state = { notifications: [], messages: [] } as MockState;

    expect(mockRoute('POST', '/notify', { text: 'Build is green.' }, state)).toMatchObject({
      status: 202,
    });
    expect(
      mockRoute('POST', '/mail', { to: 'a@b.c', subject: 'Hi', body: 'There' }, state),
    ).toMatchObject({ status: 202 });

    expect(state.notifications).toEqual([{ text: 'Build is green.', at: expect.any(String) }]);
    expect(state.messages).toEqual([{ to: 'a@b.c', subject: 'Hi', body: 'There' }]);
    expect(mockRoute('GET', '/state', undefined, state)).toMatchObject({
      status: 200,
      body: state,
    });
    expect(mockRoute('GET', '/nope', undefined, state)).toMatchObject({ status: 404 });
  });
});
