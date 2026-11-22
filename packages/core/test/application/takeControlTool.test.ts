import { describe, expect, it, vi } from 'vitest';
import { RequestTakeoverTool } from '../../src/application/desktop/TakeControlTool.js';
import type { TakeControlPort } from '../../src/ports/DesktopControl.js';
import { effectOf, type ToolContext } from '../../src/ports/Tool.js';

function setup(options: { mode?: 'agent' | 'owner'; ok?: boolean; pause?: boolean } = {}) {
  let mode = options.mode ?? 'agent';
  const requestByAgent = vi.fn(async () => ({
    ok: options.ok ?? true,
    message: options.ok === false ? 'The owner already has control.' : 'The owner has been asked.',
    ...((options.ok ?? true) && { question: 'The agent asked for control.' }),
  }));
  const abandonAgentRequest = vi.fn(() => {
    mode = 'agent';
  });
  const control: TakeControlPort = {
    get mode() {
      return mode;
    },
    requestByAgent,
    abandonAgentRequest,
  };
  const pause = vi.fn();
  const ctx = {
    turnId: 't1',
    sessionId: 's1',
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    events: { publish() {}, subscribe() {}, subscribePattern() {} },
    writeFenced: async <T>(fn: () => Promise<T>) => fn(),
    ...(options.pause === false ? {} : { requestPause: pause }),
  } as unknown as ToolContext;
  return {
    tool: new RequestTakeoverTool(control),
    control,
    requestByAgent,
    abandonAgentRequest,
    pause,
    ctx,
  };
}

describe('computer.request_takeover (S55)', () => {
  it('asks for control and hands the question to the runner to pause the turn', async () => {
    const { tool, requestByAgent, pause, ctx } = setup();
    expect(tool.name).toBe('computer.request_takeover');
    expect(tool.target).toBe('desktop');
    expect(effectOf(tool, { reason: 'CAPTCHA' })).toBe('write_local');

    const output = await tool.run({ reason: 'A CAPTCHA blocks the form.' }, ctx);
    expect(requestByAgent).toHaveBeenCalledWith({
      sessionId: 's1',
      turnId: 't1',
      reason: 'A CAPTCHA blocks the form.',
    });
    expect(pause).toHaveBeenCalledWith('The agent asked for control.');
    expect(output.isError).toBeUndefined();
    expect(output.content).toContain('owner has been asked');
  });

  it('returns the refusal when the owner already has control', async () => {
    const { tool, ctx } = setup({ ok: false });
    const output = await tool.run({ reason: 'again' }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain('already has control');
  });

  it('gives the desktop straight back when the run cannot pause', async () => {
    const { tool, abandonAgentRequest, ctx } = setup({ pause: false });
    const output = await tool.run({ reason: 'CAPTCHA' }, ctx);
    expect(output.isError).toBe(true);
    expect(abandonAgentRequest).toHaveBeenCalled();
  });
});
