import { describe, expect, it } from 'vitest';
import { shitsujiConfigSchema } from '../../src/composition/config/schema.js';
import { publicUrlOf } from '../../src/composition/config/publicUrl.js';

const config = (api: Record<string, unknown>) => shitsujiConfigSchema.parse({ api });

describe('publicUrlOf (Y2, S51)', () => {
  it('defaults to loopback and the API port', () => {
    expect(publicUrlOf(config({}))).toBe('http://127.0.0.1:3001');
  });

  it('uses the published host and port when they are real', () => {
    expect(publicUrlOf(config({ publishedHost: '192.168.1.20', publishedPort: 3100 }))).toBe(
      'http://192.168.1.20:3100',
    );
  });

  it('keeps a wildcard publish on loopback unless a public URL is set', () => {
    expect(publicUrlOf(config({ publishedHost: '0.0.0.0', publishedPort: 3100 }))).toBe(
      'http://127.0.0.1:3100',
    );
  });

  it('prefers api.publicUrl and follows the TLS scheme', () => {
    expect(publicUrlOf(config({ publicUrl: 'https://shitsuji.example/' }))).toBe(
      'https://shitsuji.example',
    );
    expect(
      publicUrlOf(
        config({
          publishedHost: '192.168.1.20',
          publishedPort: 3443,
          tls: { cert: '/c', key: '/k' },
        }),
      ),
    ).toBe('https://192.168.1.20:3443');
  });

  it('brackets an IPv6 published host', () => {
    expect(publicUrlOf(config({ publishedHost: 'fd00::1', publishedPort: 3001 }))).toBe(
      'http://[fd00::1]:3001',
    );
  });
});
