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

describe('sandboxd gateway config (S48, S51, S55)', () => {
  it('defaults to the control port and keeps the viewer listeners off', () => {
    expect(gatewayConfigFromEnv({})).toEqual({
      control: { port: 4555, targetHost: 'sandbox', targetPort: 4555 },
    });
  });

  it('reads the opt-in view-only and full-control listeners', () => {
    expect(
      gatewayConfigFromEnv({
        SANDBOX_GATEWAY_VIEWER_PORT: '6081',
        SANDBOX_GATEWAY_VIEWER_TARGET: 'sandbox:6081',
        SANDBOX_GATEWAY_FULL_VIEWER_PORT: '6080',
        SANDBOX_GATEWAY_FULL_VIEWER_TARGET: 'sandbox:6080',
      }),
    ).toEqual({
      control: { port: 4555, targetHost: 'sandbox', targetPort: 4555 },
      viewer: { port: 6081, targetHost: 'sandbox', targetPort: 6081 },
      fullViewer: { port: 6080, targetHost: 'sandbox', targetPort: 6080 },
    });
  });

  it('refuses listeners that share a port or a bad target', () => {
    expect(() => gatewayConfigFromEnv({ SANDBOX_GATEWAY_VIEWER_PORT: '4555' })).toThrow(
      /must differ/,
    );
    expect(() =>
      gatewayConfigFromEnv({
        SANDBOX_GATEWAY_VIEWER_PORT: '6081',
        SANDBOX_GATEWAY_FULL_VIEWER_PORT: '6081',
      }),
    ).toThrow(/must differ/);
    expect(() =>
      gatewayConfigFromEnv({
        SANDBOX_GATEWAY_VIEWER_PORT: '6081',
        SANDBOX_GATEWAY_VIEWER_TARGET: 'sandbox',
      }),
    ).toThrow(/host:port/);
  });

  it('runs the control, watch-only and full-control listeners (S51, S55)', async () => {
    const controlTarget = echo('control:');
    const viewerTarget = echo('viewer:');
    const fullTarget = echo('full:');
    await listen(controlTarget);
    await listen(viewerTarget);
    await listen(fullTarget);
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
        fullViewer: {
          port: 0,
          targetHost: '127.0.0.1',
          targetPort: (fullTarget.address() as AddressInfo).port,
        },
      },
      { info: () => undefined, warn: () => undefined },
    );
    await Promise.all(servers.map((server) => whenListening(server)));
    const [control, viewer, full] = servers.map((server) => (server.address() as AddressInfo).port);

    await expect(roundTrip(control!, 'ping')).resolves.toBe('control:ping');
    await expect(roundTrip(viewer!, 'ping')).resolves.toBe('viewer:ping');
    await expect(roundTrip(full!, 'ping')).resolves.toBe('full:ping');

    await Promise.all(servers.map((server) => close(server)));
    await close(controlTarget);
    await close(viewerTarget);
    await close(fullTarget);
  });
});
