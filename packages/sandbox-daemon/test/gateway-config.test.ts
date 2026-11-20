import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { gatewayConfigFromEnv, startGateways } from '../src/gateway-config.js';

const listen = (server: net.Server): Promise<void> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const whenListening = (server: net.Server): Promise<void> =>
  server.listening
    ? Promise.resolve()
    : new Promise((resolve) => server.once('listening', resolve));

const close = (server: net.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const echo = (prefix: string): net.Server =>
  net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from(prefix), chunk])));
  });

const roundTrip = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(text));
    socket.once('data', (chunk) => {
      socket.end();
      resolve(chunk.toString());
    });
    socket.once('error', reject);
  });

describe('sandboxd gateway config (S48, S51)', () => {
  it('defaults to the control port and keeps the viewer listener off', () => {
    expect(gatewayConfigFromEnv({})).toEqual({
      control: { port: 4555, targetHost: 'sandbox', targetPort: 4555 },
    });
  });

  it('reads the opt-in view-only listener', () => {
    expect(
      gatewayConfigFromEnv({
        SANDBOX_GATEWAY_VIEWER_PORT: '6081',
        SANDBOX_GATEWAY_VIEWER_TARGET: 'sandbox:6081',
      }),
    ).toEqual({
      control: { port: 4555, targetHost: 'sandbox', targetPort: 4555 },
      viewer: { port: 6081, targetHost: 'sandbox', targetPort: 6081 },
    });
  });

  it('refuses a second listener on the control port or a bad target', () => {
    expect(() => gatewayConfigFromEnv({ SANDBOX_GATEWAY_VIEWER_PORT: '4555' })).toThrow(
      /must differ/,
    );
    expect(() =>
      gatewayConfigFromEnv({
        SANDBOX_GATEWAY_VIEWER_PORT: '6081',
        SANDBOX_GATEWAY_VIEWER_TARGET: 'sandbox',
      }),
    ).toThrow(/host:port/);
  });

  it('runs both listeners and forwards each to its own target (S51)', async () => {
    const controlTarget = echo('control:');
    const viewerTarget = echo('viewer:');
    await listen(controlTarget);
    await listen(viewerTarget);
    const servers = startGateways(
      {
        control: {
          port: 0,
          targetHost: '127.0.0.1',
          targetPort: (controlTarget.address() as AddressInfo).port,
        },
        viewer: {
          port: 0,
          targetHost: '127.0.0.1',
          targetPort: (viewerTarget.address() as AddressInfo).port,
        },
      },
      { info: () => undefined, warn: () => undefined },
    );
    await Promise.all(servers.map((server) => whenListening(server)));
    const [control, viewer] = servers.map((server) => (server.address() as AddressInfo).port);

    await expect(roundTrip(control!, 'ping')).resolves.toBe('control:ping');
    await expect(roundTrip(viewer!, 'ping')).resolves.toBe('viewer:ping');

    await Promise.all(servers.map((server) => close(server)));
    await close(controlTarget);
    await close(viewerTarget);
  });
});
