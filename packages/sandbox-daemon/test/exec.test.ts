import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecEvent } from '@shitsuji/sandbox-protocol';
import { ExecSupervisor } from '../src/exec.js';
import { SandboxPaths } from '../src/paths.js';

let base: string;
let supervisor: ExecSupervisor;

const NODE = process.execPath;
const argv = (script: string, ...args: string[]) => [NODE, '-e', script, ...args];

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxd-exec-'));
  const paths = new SandboxPaths({
    workspace: { dir: path.join(base, 'workspace') },
    handoff: { dir: path.join(base, 'handoff'), readOnly: true },
  });
  await paths.start();
  supervisor = new ExecSupervisor(paths, {
    maxTimeoutMs: 60_000,
    maxOutputBytes: 1_000,
    killGraceMs: 500,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/agent',
      LANG: 'C.UTF-8',
      USER: 'agent',
    },
  });
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const run = async (
  request: Parameters<ExecSupervisor['run']>[0],
  signal?: AbortSignal,
): Promise<ExecEvent[]> => {
  const events: ExecEvent[] = [];
  await supervisor.run(request, (event) => events.push(event), signal);
  return events;
};

const textOf = (events: ExecEvent[]) =>
  events.flatMap((e) => (e.type === 'stdout' ? [e.text] : [])).join('');
const exitOf = (events: ExecEvent[]) => {
  const exit = events.find((e) => e.type === 'exit');
  expect(exit, 'an exit frame').toBeDefined();
  return exit as Extract<ExecEvent, { type: 'exit' }>;
};

describe('exec supervisor (F08, S46)', () => {
  it('runs a command in the workspace and streams its output, exit code and stderr', async () => {
    const events = await run({
      argv: argv("console.log('one'); console.error('two'); process.exit(3)"),
      cwd: '.',
      env: {},
      timeoutMs: 10_000,
    });

    expect(events[0]).toMatchObject({ type: 'start' });
    expect(textOf(events).trim()).toBe('one');
    expect(events.flatMap((e) => (e.type === 'stderr' ? [e.text] : [])).join('')).toContain('two');
    expect(exitOf(events)).toMatchObject({ code: 3, timedOut: false, truncated: false });
  });

  it('starts commands from a fixed environment and never inherits the daemon’s', async () => {
    process.env.SANDBOX_TOKEN = 'leak-me-please';
    process.env.SHITSUJI_TEST_SECRET = 'also-secret';
    try {
      const events = await run({
        argv: argv('console.log(JSON.stringify(process.env))'),
        cwd: '.',
        env: { EXTRA: 'yes' },
        timeoutMs: 10_000,
      });

      const env = JSON.parse(textOf(events)) as Record<string, string>;
      expect(env).not.toHaveProperty('SANDBOX_TOKEN');
      expect(env).not.toHaveProperty('SHITSUJI_TEST_SECRET');
      expect(env).toMatchObject({
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/home/agent',
        LANG: 'C.UTF-8',
        USER: 'agent',
        TERM: 'dumb',
        EXTRA: 'yes',
      });
    } finally {
      delete process.env.SANDBOX_TOKEN;
      delete process.env.SHITSUJI_TEST_SECRET;
    }
  });

  it('writes stdin and closes it', async () => {
    const events = await run({
      argv: argv("process.stdin.on('data', (d) => process.stdout.write(d))"),
      cwd: '.',
      env: {},
      timeoutMs: 10_000,
      stdin: 'typed yes\n',
    });

    expect(textOf(events)).toBe('typed yes\n');
    expect(exitOf(events).code).toBe(0);
  });

  it('kills a command that runs past its timeout', async () => {
    const started = Date.now();
    const events = await run({
      argv: argv('setTimeout(() => {}, 60000)'),
      cwd: '.',
      env: {},
      timeoutMs: 300,
    });

    expect(exitOf(events).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('caps the output and says so', async () => {
    const events = await run({
      argv: argv("process.stdout.write('x'.repeat(5000))"),
      cwd: '.',
      env: {},
      timeoutMs: 10_000,
    });

    expect(textOf(events).length).toBeLessThanOrEqual(1_000);
    expect(exitOf(events).truncated).toBe(true);
  });

  it('reports a program that is not there and a cwd outside the workspace', async () => {
    const missing = await run({
      argv: ['no-such-program-xyz'],
      cwd: '.',
      env: {},
      timeoutMs: 10_000,
    });
    expect(missing).toContainEqual(expect.objectContaining({ type: 'error', code: 'not_found' }));

    const outside = await run({
      argv: argv("console.log('no')"),
      cwd: '../outside',
      env: {},
      timeoutMs: 10_000,
    });
    expect(outside).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'outside_root' }),
    );
  });

  it('stops a command by id, and reports an unknown one', async () => {
    const events: ExecEvent[] = [];
    const running = supervisor.run(
      {
        argv: argv('setTimeout(() => {}, 60000)'),
        cwd: '.',
        env: {},
        timeoutMs: 60_000,
      },
      (event) => {
        events.push(event);
        if (event.type === 'start') {
          expect(supervisor.signal(event.id, 'SIGTERM', 100)).toBe(true);
          expect(supervisor.signal('no-such-id')).toBe(false);
        }
      },
    );

    await running;
    expect(exitOf(events).signal).toBe('SIGTERM');
    expect(exitOf(events).timedOut).toBe(false);
  });

  it('stops a command when the caller aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const events: ExecEvent[] = [];
    const running = supervisor.run(
      {
        argv: argv('setTimeout(() => {}, 60000)'),
        cwd: '.',
        env: {},
        timeoutMs: 60_000,
      },
      (event) => events.push(event),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);

    await running;
    expect(exitOf(events).signal).toBe('SIGTERM');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.skipIf(process.platform === 'win32')(
    'stops the whole process group, including a detached child',
    async () => {
      const marker = path.join(base, 'workspace', 'leaked.txt');
      // The background child writes after a second; if the group is killed, it never does.
      const events: ExecEvent[] = [];
      const running = supervisor.run(
        {
          argv: ['sh', '-c', `(sleep 1; echo leaked > ${marker}) & wait`],
          cwd: '.',
          env: {},
          timeoutMs: 60_000,
        },
        (event) => {
          events.push(event);
          if (event.type === 'start') {
            setTimeout(() => supervisor.signal(event.id, 'SIGTERM', 100), 200);
          }
        },
      );

      await running;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(fs.existsSync(marker)).toBe(false);
      expect(exitOf(events).timedOut).toBe(false);
    },
  );
});
