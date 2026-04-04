import type { ToolHandler } from './types';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

export const webSearchTool: ToolHandler = {
  definition: {
    name: 'WebSearch',
    description:
      'Search the web for information using a search query. ' +
      'Returns a list of results with titles, URLs, and descriptions. ' +
      'Use this to find current information, news, data, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The search query string' },
      },
      required: ['query'],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const query = String(input.query ?? '');
    if (!query) return 'Error: query is required';

    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return 'Error: BRAVE_SEARCH_API_KEY environment variable is not set. WebSearch is unavailable.';
    }

    try {
      const url = `${BRAVE_API_URL}?q=${encodeURIComponent(query)}&count=10`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return `Error: Brave Search API returned HTTP ${res.status}: ${body.slice(0, 200)}`;
      }

      const data = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const results = data.web?.results ?? [];

      if (results.length === 0) return 'No search results found.';

      return results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title ?? '(no title)'}\n    URL: ${r.url ?? ''}\n    ${r.description ?? ''}`,
        )
        .join('\n\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: WebSearch failed: ${msg}`;
    }
  },
};
