import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod/v4';
import type { SearchProvider } from '../../ports/SearchProvider.js';
import { BaseTool, type ToolContext, type ToolOutput } from '../../ports/Tool.js';

const searchInput = z.object({
  /** What to search for. */
  query: z.string().min(1).max(400).describe('What to search for'),
  /** At most this many hits; eight by default. */
  limit: z.number().int().min(1).max(20).default(8),
});

/** web.search: results from the configured SearchProvider. Output is untrusted. */
export class WebSearchTool extends BaseTool<typeof searchInput> {
  /** The tool's name, `web.search`. */
  readonly name = 'web.search';
  /** What the model reads: it searches, and web.fetch reads a page. */
  readonly description =
    'Search the web. Returns titles, URLs and snippets; use web.fetch to read a page.';
  /** The query and limit schema. */
  readonly input = searchInput;
  /** Reading the web changes nothing. */
  readonly effect = 'read' as const;
  /** Search results come from outside and are wrapped as untrusted data. */
  override readonly untrustedOutput = true;

  constructor(
    /** The configured engine; its errors surface as tool errors. */
    private readonly provider: SearchProvider,
  ) {
    super();
  }

  /** Runs the search and formats the hits as numbered lines with their URLs and snippets. */
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

/** Resolves a host name to its addresses; injectable so a test needs no DNS. */
export type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const fetchInput = z.object({
  /** An absolute http(s) URL. */
  url: z.url({ protocol: /^https?$/ }).describe('An http(s) URL'),
});

/** What `web.fetch` may do: its size and redirect caps, and the DNS and fetch it uses. */
export interface WebFetchOptions {
  /** The most bytes read from a page; 2 MB by default. */
  maxBytes?: number;
  /** The most redirects followed; five by default. */
  maxRedirects?: number;
  /** The resolver used for the private-address check; the system one by default. */
  resolver?: Resolver;
  /** The fetch implementation, injectable for tests. */
  fetch?: typeof fetch;
}

/**
 * web.fetch: a page's readable text. Refuses hosts that resolve to private or local addresses (so the
 * model cannot reach the database, the LAN or cloud metadata), checking every redirect. Output is
 * untrusted. A DNS answer could still change between the check and the request; the egress proxy
 * (F12) closes that gap for the sandbox.
 */
export class WebFetchTool extends BaseTool<typeof fetchInput> {
  /** The tool's name, `web.fetch`. */
  readonly name = 'web.fetch';
  /** What the model reads: a page's text, with tags and scripts removed. */
  readonly description =
    'Fetch a public web page and return its readable text (scripts, styles and tags removed).';
  /** The URL schema. */
  readonly input = fetchInput;
  /** Reading a page changes nothing. */
  readonly effect = 'read' as const;
  /** Page text comes from outside and is wrapped as untrusted data. */
  override readonly untrustedOutput = true;
  /** The most bytes read from one page. */
  private readonly maxBytes: number;
  /** How many redirects may be followed before refusing. */
  private readonly maxRedirects: number;
  /** The resolver the private-address check uses. */
  private readonly resolve: Resolver;
  /** The fetch implementation, shared by every page read. */
  private readonly fetchImpl: typeof fetch;

  constructor(
    /** The size and redirect caps and the DNS/fetch seams; defaults when omitted. */
    options: WebFetchOptions = {},
  ) {
    super();
    this.maxBytes = options.maxBytes ?? 2_000_000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.resolve = options.resolver ?? systemResolver;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Fetches the page, following redirects only after checking each hop's address. */
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

  /** Refuses a URL whose host is an address, or resolves to one, that is not public. */
  private async assertPublic(url: URL): Promise<void> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : await this.resolve(host).catch(() => []);
    if (!addresses.length) throw new Error(`Cannot resolve ${host}`);
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
      throw new Error(`Refused: ${host} is a private or local address (${blocked})`);
    }
  }

  /** Reads at most `maxBytes` of the body and decodes it as UTF-8 text. */
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
