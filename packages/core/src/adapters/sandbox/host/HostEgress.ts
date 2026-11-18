import net from 'node:net';
import type { SandboxEgress } from '../../../ports/SandboxDriver.js';

/**
 * The host driver's egress probe (S42): a plain TCP connect from the core process, which is where its
 * commands run. A refused or timed-out connection means the address is not reachable.
 */
export class HostEgress implements SandboxEgress {
  async reachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  }
}
