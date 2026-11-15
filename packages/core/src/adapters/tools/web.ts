import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod/v4';
import type { SearchProvider } from '../../ports/SearchProvider.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../ports/Tool.js';

const searchInput = z.object({
  query: z.string().min(1).max(400).describe('What to search for'),
  limit: z.number().int().min(1).max(20).default(8),
});

/** web.search: results from the configured SearchProvider. Output is untrusted. */
export class WebSearchTool extends BaseTool<typeof searchInput> {
  readonly name = 'web.search';
  readonly description =
    'Search the web. Returns titles, URLs and snippets; use web.fetch to read a page.';
  readonly input = searchInput;
  readonly effect = 'read' as const;
  override readonly untrustedOutput = true;

  constructor(private readonly provider: SearchProvider) {
    super();
  }

  async run({ query, limit }: z.infer<typeof searchInput>, ctx: ToolContext): Promise<ToolOutput> {
    const results = await this.provider.search(query, { limit, signal: ctx.signal });
    if (!results.length) return { content: `No results for "${query}".` };
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
    return { content: lines.join('\n'), data: { count: results.length } };
  }
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}

export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const fetchInput = z.object({
  url: z.url({ protocol: /^https?$/ }).describe('An http(s) URL'),
});

export interface WebFetchOptions {
  maxBytes?: number;
  maxRedirects?: number;
  resolver?: Resolver;
  fetch?: typeof fetch;
}

/**
 * web.fetch: a page's readable text. Refuses hosts that resolve to private or local addresses (so the
 * model cannot reach the database, the LAN or cloud metadata), checking every redirect. Output is
 * untrusted. A DNS answer could still change between the check and the request; the egress proxy
 * (F12) closes that gap for the sandbox.
 */
export class WebFetchTool extends BaseTool<typeof fetchInput> {
  readonly name = 'web.fetch';
  readonly description =
    'Fetch a public web page and return its readable text (scripts, styles and tags removed).';
  readonly input = fetchInput;
  readonly effect = 'read' as const;
  override readonly untrustedOutput = true;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly resolve: Resolver;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebFetchOptions = {}) {
    super();
    this.maxBytes = options.maxBytes ?? 2_000_000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.resolve = options.resolver ?? systemResolver;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async run({ url }: z.infer<typeof fetchInput>, ctx: ToolContext): Promise<ToolOutput> {
    let current = new URL(url);
    for (let hop = 0; ; hop++) {
      await this.assertPublic(current);
      const response = await this.fetchImpl(current, {
        redirect: 'manual',
        signal: ctx.signal,
        headers: {
          'user-agent': 'Shitsuji/0.1 (personal assistant)',
          accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
        },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (hop >= this.maxRedirects)
          return { content: `Too many redirects from ${url}`, isError: true };
        current = new URL(response.headers.get('location')!, current);
        if (!/^https?:$/.test(current.protocol)) {
          return { content: `Refused a redirect to ${current.protocol} URL`, isError: true };
        }
        continue;
      }
      if (!response.ok) {
        return { content: `${current.href} returned HTTP ${response.status}`, isError: true };
      }
      const body = await this.readLimited(response);
      const type = response.headers.get('content-type') ?? '';
      const text = /html/i.test(type) ? htmlToText(body) : body;
      return {
        content: `${current.href}\n\n${text}`.trim(),
        data: { url: current.href, contentType: type, bytes: body.length },
      };
    }
  }

  private async assertPublic(url: URL): Promise<void> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : await this.resolve(host).catch(() => []);
    if (!addresses.length) throw new Error(`Cannot resolve ${host}`);
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
      throw new Error(`Refused: ${host} is a private or local address (${blocked})`);
    }
  }

  private async readLimited(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > this.maxBytes) {
        await reader.cancel();
        chunks.push(value.subarray(0, value.length - (size - this.maxBytes)));
        break;
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}

/** Crude but dependency-free: drop scripts, styles and tags, decode common entities, tidy space. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
