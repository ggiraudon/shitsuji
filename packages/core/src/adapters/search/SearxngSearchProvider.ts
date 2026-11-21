import type { SearchProvider, SearchResult } from '../../ports/SearchProvider.js';

/** The subset of SearXNG's JSON response the adapter reads. */
interface SearxngResponse {
  /** The hits; every field is optional because the API omits what the engine did not give. */
  results?: {
    /** The page title. */
    title?: string;
    /** The absolute URL. */
    url?: string;
    /** The snippet, possibly with line breaks and entities. */
    content?: string;
    /** The engines that agreed on this hit, when the instance reports it. */
    engines?: string[];
    /** The single engine that found it, on older instances. */
    engine?: string;
  }[];
}

/** Queries a self-hosted SearXNG (its JSON API must be enabled in settings.yml: search.formats). */
export class SearxngSearchProvider implements SearchProvider {
  readonly id = 'searxng';
  /** The instance's URL, without a trailing slash. */
  private readonly baseUrl: string;

  constructor(
    /** The SearXNG base URL, e.g. `http://searxng:8080`; a trailing slash is ignored. */
    baseUrl: string,
    /** The fetch implementation, injectable for tests with recorded responses. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Queries the instance, drops duplicate URLs and clips the list to `limit` (eight by default). */
  async search(
    query: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<SearchResult[]> {
    const url = `${this.baseUrl}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: options.signal,
      });
    } catch (error) {
      throw new Error(
        `Search is unavailable (cannot reach SearXNG at ${this.baseUrl}): ${(error as Error).message}`,
      );
    }
    if (response.status === 403) {
      throw new Error(
        'SearXNG refused the JSON API: enable "json" in search.formats of its settings.yml',
      );
    }
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
    const body = (await response.json()) as SearxngResponse;
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const r of body.results ?? []) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push({
        title: (r.title ?? r.url).trim(),
        url: r.url,
        snippet: (r.content ?? '').replace(/\s+/g, ' ').trim(),
        source: r.engines?.join(', ') ?? r.engine,
      });
      if (results.length >= (options.limit ?? 8)) break;
    }
    return results;
  }
}
