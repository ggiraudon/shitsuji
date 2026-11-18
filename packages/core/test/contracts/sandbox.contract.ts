import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import type {
  ExecEvent,
  LeaseRequest,
  Sandbox,
  SandboxDriver,
} from '../../src/ports/SandboxDriver.js';

export interface SandboxContractOptions {
  /** The driver's name in the test titles. */
  name: string;
  driver: SandboxDriver;
  /** Where the contract's workspace lives when the driver needs a folder (the host driver does). */
  lease?: LeaseRequest;
  /** A command that prints `1` without a shell; node is in every image we ship. */
  printOne?: { program: string; args: string[] };
  /**
   * True when the driver contains runaway processes (a PID limit, a process session per command).
   * The host has neither, so the fork bomb test is skipped for it (F08, S42).
   */
  processContainment?: boolean;
}

const DEFAULT_LEASE: LeaseRequest = { ownerId: asId<OwnerId>('owner') };

/**
 * What every SandboxDriver must do, whatever its transport (F08, S42). Each test runs only for the
 * capabilities the driver claims, so the host driver skips the network test it makes no claim about,
 * and a container driver skips nothing.
 *
 * Call it with `await` at the top level of a test file: capabilities are read before the tests are
 * declared.
 */
export async function describeSandboxContract(options: SandboxContractOptions): Promise<void> {
  const capabilities = await options.driver.capabilities();
  const printOne = options.printOne ?? {
    program: 'node',
    args: ['-e', 'console.log(1)'],
  };
  const itExec = capabilities.exec && capabilities.files ? it : it.skip;
  const itFiles = capabilities.files ? it : it.skip;
  const itContainer = options.processContainment ? it : it.skip;
  const itNetwork = capabilities.egress.lanBlocked ? it : it.skip;

  describe(`${options.name}: sandbox contract`, () => {
    let sandbox: Sandbox;

    beforeAll(async () => {
      sandbox = await options.driver.open(options.lease ?? DEFAULT_LEASE);
    });
    afterAll(async () => {
      await sandbox?.close();
    });

    it('opens a sandbox that provides what its capabilities promise', () => {
      expect(options.driver.id.length).toBeGreaterThan(0);
      expect(Boolean(sandbox.files)).toBe(Boolean(capabilities.files));
      expect(Boolean(sandbox.exec)).toBe(Boolean(capabilities.exec));
      for (const root of capabilities.files?.roots ?? []) expect(root.length).toBeGreaterThan(0);
    });

    itExec('runs a program and returns its output', async () => {
      const result = await run(sandbox, await cwd(sandbox), printOne, { timeoutMs: 30_000 });

      expect(result.exit.code).toBe(0);
      expect(result.exit.timedOut).toBe(false);
      expect(result.stdout.trim()).toBe('1');
    });

    itExec('reports a non-zero exit and stderr as such', async () => {
      const failed = await run(
        sandbox,
        await cwd(sandbox),
        {
          program: printOne.program,
          args: ['-e', "process.stderr.write('boom'); process.exit(3)"],
        },
        { timeoutMs: 30_000 },
      );

      expect(failed.exit.code).toBe(3);
      expect(failed.stderr).toContain('boom');
    });

    itExec('kills a command that runs past its timeout', async () => {
      const started = Date.now();
      const result = await run(
        sandbox,
        await cwd(sandbox),
        { program: printOne.program, args: ['-e', 'setTimeout(() => {}, 60000)'] },
        { timeoutMs: 300 },
      );

      expect(result.exit.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    itExec('ends the command when the request is stopped', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = run(
        sandbox,
        await cwd(sandbox),
        { program: printOne.program, args: ['-e', 'setTimeout(() => {}, 60000)'] },
        { timeoutMs: 30_000, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 100);

      await expect(pending).rejects.toThrow(/Stopped/);
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    itContainer('contains a fork bomb and cleans it up', async () => {
      const shell = { program: 'sh', args: ['-c', ':(){ :|:& };:'] };
      const result = await run(sandbox, await cwd(sandbox), shell, { timeoutMs: 5_000 });
      // The limit kills it; what matters is that the sandbox survives and answers again.
      expect(result.exit).toBeDefined();
      const after = await run(sandbox, await cwd(sandbox), printOne, { timeoutMs: 30_000 });
      expect(after.exit.code).toBe(0);
    });

    itFiles('writes, reads, lists and stats a file', async () => {
      const files = sandbox.files!;
      const name = `contract-${Date.now()}.txt`;
      const absolute = await files.resolve(name);

      await files.write(absolute, 'hello', { append: false });
      await files.write(absolute, ' world', { append: true });
      expect(await files.read(absolute)).toBe('hello world');
      expect(Array.from(await files.readBytes(absolute))).toEqual(
        Array.from(Buffer.from('hello world')),
      );
      expect(await files.stat(absolute)).toMatchObject({ isFile: true, size: 11 });
      expect(files.display(absolute).endsWith(name)).toBe(true);
      const entries = await files.list((await files.resolve('.'))!);
      expect(entries?.some((entry) => entry.name === name)).toBe(true);
    });

    itFiles('refuses a path outside its roots', async () => {
      const files = sandbox.files!;

      await expect(files.resolve('../outside.txt')).rejects.toThrow();
      await expect(files.resolve('/etc/passwd')).rejects.toThrow();
      await expect(files.resolveRead('../../outside.txt')).rejects.toThrow();
    });

    itNetwork('cannot reach the network it claims to block', async () => {
      expect(capabilities.egress.lanBlocked).toBe(true);
      const reachable = await sandbox.egress!.reachable('192.168.1.1', 80, 1_000);
      expect(reachable).toBe(false);
    });
  });
}

/** Runs one command and collects its output until the exit event. */
async function run(
  sandbox: Sandbox,
  cwd: string,
  command: { program: string; args: readonly string[] },
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exit: Extract<ExecEvent, { type: 'exit' }> }> {
  const out: string[] = [];
  const err: string[] = [];
  let exit: Extract<ExecEvent, { type: 'exit' }> | undefined;
  for await (const event of sandbox.exec!.run(
    { ...command, cwd, timeoutMs: options.timeoutMs },
    options.signal,
  )) {
    if (event.type === 'stdout') out.push(event.text);
    else if (event.type === 'stderr') err.push(event.text);
    else exit = event;
  }
  if (!exit) throw new Error('the command ended without an exit event');
  return { stdout: out.join(''), stderr: err.join(''), exit };
}

async function cwd(sandbox: Sandbox): Promise<string> {
  return sandbox.files!.resolve('.');
}
