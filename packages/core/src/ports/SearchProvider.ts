export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Which engine(s) found it, when the provider says. */
  source?: string;
}

/** Web search behind one interface: SearXNG now, Brave or Tavily could be added (decision Q2). */
export interface SearchProvider {
  readonly id: string;
  search(
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<SearchResult[]>;
}
