/** One hit: a title, its URL and a snippet, plus the engine that found it when the provider says. */
export interface SearchResult {
  /** The page title, or the URL when the engine gave no title. */
  title: string;
  /** The absolute URL to open; duplicates are dropped by the adapter. */
  url: string;
  /** A one-paragraph extract, whitespace collapsed. */
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
  /** The provider's id, for config and logs, e.g. `searxng`. */
  readonly id: string;
  /** At most `limit` results (the adapter's default when unset); duplicates by URL are dropped. */
  search(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>;
}
