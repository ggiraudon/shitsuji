import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway } from '../src/gateway.js';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

describe('the sandboxd gateway (F08, S48)', () => {
  it('forwards both directions and closes the pair', async () => {
    const target = net.createServer((socket) => {
      socket.write('hello ');
      socket.once('data', (data) => socket.end(`you said ${data.toString()}`));
    });
    servers.push(target);
    const targetPort = await listen(target);
    const gateway = createGateway({ targetHost: '127.0.0.1', targetPort });
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const answer = await new Promise<string>((resolve, reject) => {
      const client = net.connect({ host: '127.0.0.1', port: gatewayPort }, () => {
        client.write('ping');
      });
      let text = '';
      client.on('data', (data) => (text += data.toString()));
      client.on('end', () => resolve(text));
      client.on('error', reject);
    });

    expect(answer).toBe('hello you said ping');
  });

  it('closes the client when sandboxd is not there', async () => {
    const gateway = createGateway({ targetHost: '127.0.0.1', targetPort: 1 });
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const ended = await new Promise<boolean>((resolve) => {
      const client = net.connect({ host: '127.0.0.1', port: gatewayPort });
      client.on('close', () => resolve(true));
      client.on('error', () => resolve(true));
    });

    expect(ended).toBe(true);
  });
});
