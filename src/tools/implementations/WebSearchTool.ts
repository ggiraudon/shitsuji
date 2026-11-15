import { BaseTool, type ToolResult, type ToolExecuteParams } from '../base.js';

export class WebSearchTool extends BaseTool {
  readonly name = 'web_search';
  readonly description = 'Search the web for information. Use this when you need current info or don\'t know something.';
  readonly schema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
    },
    required: ['query'],
  };

  async execute(params: ToolExecuteParams): Promise<ToolResult> {
    const { query } = params.args;

    if (typeof query !== 'string') {
      return {
        success: false,
        result: '',
        error: 'Query must be a string',
      };
    }

    try {
      const results = await this.search(query);
      return {
        success: true,
        result: results,
      };
    } catch (error) {
      return {
        success: false,
        result: '',
        error: `Search error: ${String(error)}`,
      };
    }
  }

  private async search(query: string): Promise<string> {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(
      `https://ddg-api.vercel.app/search?q=${encodedQuery}&max_results=5`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    interface DuckDuckGoResult {
      title: string;
      url: string;
      snippet: string;
    }

    const data = await response.json() as DuckDuckGoResult[];
    
    if (data.length === 0) {
      return 'No results found.';
    }

    return data
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
  }
}
