/** One hit: a title, its URL and a snippet, plus the engine that found it when the provider says. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which engine(s) found it, when the provider says. */
  source?: string;
}

/**
 * Web search behind one interface: SearXNG now, Brave or Tavily could be added (decision Q2). The
 * provider may throw on an unreachable or misconfigured engine; `web.search` lets that surface as a
 * tool error rather than an empty result, so the model knows the search did not happen.
 */
export interface SearchProvider {
  readonly id: string;
  /** At most `limit` results (the adapter's default when unset); duplicates by URL are dropped. */
  search(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>;
}
