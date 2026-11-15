import { SearxngSearchProvider } from '../adapters/search/SearxngSearchProvider.js';
import { WebFetchTool, WebSearchTool } from '../adapters/tools/web.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

export interface WebToolsOptions {
  /** SearXNG base URL; web.search is only registered when it is set (decision Q2). */
  searxngUrl?: string;
  fetchEnabled: boolean;
}

/** web.search (through SearXNG) and web.fetch. */
export class WebToolsPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.web-tools',
    name: 'Web search and fetch',
    version: '0.1.0',
    provides: ['tools'],
  } as const;

  constructor(private readonly options: WebToolsOptions) {}

  register(ctx: PluginRegistrationContext): void {
    const tools = [];
    if (this.options.searxngUrl) {
      tools.push(new WebSearchTool(new SearxngSearchProvider(this.options.searxngUrl)));
    } else {
      ctx.log.info('web.search is off: set tools.web.searxngUrl (or SHITSUJI_SEARXNG_URL)');
    }
    if (this.options.fetchEnabled) tools.push(new WebFetchTool());
    ctx.addTools(tools);
  }
}
