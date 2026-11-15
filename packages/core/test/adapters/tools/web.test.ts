import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SearxngSearchProvider } from '../../../src/adapters/search/SearxngSearchProvider.js';
import {
  htmlToText,
  isPrivateAddress,
  WebFetchTool,
  WebSearchTool,
  type Resolver,
} from '../../../src/adapters/tools/web.js';
import type { ToolContext } from '../../../src/ports/Tool.js';
import { testServices } from '../../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = fs.readFileSync(
  path.join(here, '../../fixtures/search/searxng-recorded.json'),
  'utf8',
);

const ctx = (): ToolContext => {
  const s = testServices();
  return {
    turnId: 't',
    sessionId: 's',
    signal: new AbortController().signal,
    log: s.log,
    events: s.events,
    writeFenced: async () => {
      throw new Error('unused');
    },
  };
};

describe('SearxngSearchProvider (recorded response)', () => {
  it('turns the JSON API into deduplicated results, asking for format=json', async () => {
    const urls: string[] = [];
    const provider = new SearxngSearchProvider('http://searxng:8080/', (async (u: string) => {
      urls.push(u);
      return new Response(recorded, { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    const results = await provider.search('butler japanese word', { limit: 5 });
    expect(urls[0]).toBe('http://searxng:8080/search?q=butler+japanese+word&format=json');
    expect(results).toHaveLength(5);
    expect(new Set(results.map((r) => r.url)).size).toBe(5);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
  });

  it('explains a 403 (JSON format not enabled) and an unreachable server', async () => {
    const forbidden = new SearxngSearchProvider(
      'http://s',
      (async () => new Response('', { status: 403 })) as typeof fetch,
    );
    await expect(forbidden.search('x')).rejects.toThrow(/enable "json" in search.formats/);
    const down = new SearxngSearchProvider('http://s', (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    await expect(down.search('x')).rejects.toThrow(/cannot reach SearXNG/);
  });
});

describe('web.search', () => {
  it('lists results as numbered lines, and marks its output untrusted', async () => {
    const tool = new WebSearchTool({
      id: 'fake',
      search: async () => [
        { title: 'Shitsuji', url: 'https://example.com/a', snippet: 'A butler' },
      ],
    });
    expect(tool.untrustedOutput).toBe(true);
    const out = await tool.run({ query: 'butler', limit: 3 }, ctx());
    expect(out.content).toBe('1. Shitsuji\n   https://example.com/a\n   A butler');
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])('%s is public', (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('web.fetch', () => {
  const resolver: Resolver = async (host) =>
    ({
      'example.com': ['93.184.216.34'],
      postgres: ['172.20.0.3'],
      'evil.test': ['93.184.216.99'],
    })[host] ?? [];

  const tool = (respond: (url: URL) => Response) =>
    new WebFetchTool({
      resolver,
      maxBytes: 200,
      fetch: (async (input: URL) => respond(new URL(input))) as unknown as typeof fetch,
    });

  it('returns readable text from HTML', async () => {
    const html =
      '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>';
    const out = await tool(
      () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    ).run({ url: 'https://example.com/page' }, ctx());
    expect(out.content).toBe('https://example.com/page\n\nTitle\nOne & two');
  });

  it.each([
    'http://postgres:5432/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
  ])('refuses %s (private or local)', async (url) => {
    await expect(tool(() => new Response('secret')).run({ url }, ctx())).rejects.toThrow(
      /private or local/,
    );
  });

  it('refuses a redirect into the private network', async () => {
    const t = tool((u) =>
      u.hostname === 'evil.test'
        ? new Response(null, { status: 302, headers: { location: 'http://postgres:5432/' } })
        : new Response('ok'),
    );
    await expect(t.run({ url: 'https://evil.test/' }, ctx())).rejects.toThrow(/private or local/);
  });

  it('follows a public redirect, caps the size, and reports HTTP errors', async () => {
    const t = tool((u) =>
      u.pathname === '/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : u.pathname === '/new'
          ? new Response('x'.repeat(1000), { headers: { 'content-type': 'text/plain' } })
          : new Response('gone', { status: 404 }),
    );
    const out = await t.run({ url: 'https://example.com/old' }, ctx());
    expect(out.data).toMatchObject({ url: 'https://example.com/new', bytes: 200 });
    expect(await t.run({ url: 'https://example.com/missing' }, ctx())).toMatchObject({
      isError: true,
      content: 'https://example.com/missing returned HTTP 404',
    });
  });

  it('rejects non-http URLs in its schema', () => {
    const t = new WebFetchTool();
    expect(t.input.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(t.input.safeParse({ url: 'https://example.com' }).success).toBe(true);
  });
});

describe('htmlToText', () => {
  it('keeps line breaks for blocks and decodes entities', () => {
    expect(htmlToText('<ul><li>A</li><li>B&#39;s</li></ul><!-- x -->')).toBe("A\nB's");
  });
});
