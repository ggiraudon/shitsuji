import net from 'node:net';

/**
 * Opens a TCP connection from inside the sandbox and closes it again (S48): the driver's
 * `egress.reachable` is how `core` checks lanBlocked from where commands actually run.
 */
export function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
