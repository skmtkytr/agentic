import type { ToolHandler } from './types';

const MAX_CONTENT_LENGTH = 15_000;
const TIMEOUT_MS = 30_000;

export const webFetchTool: ToolHandler = {
  definition: {
    name: 'WebFetch',
    description:
      'Fetch the content of a web page at the given URL. ' +
      'Returns the text content extracted from the page. ' +
      'HTML tags are stripped and only text is returned.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const url = String(input.url ?? '');
    if (!url) return 'Error: url is required';

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; Agentic/1.0; +https://github.com/skmtkytr/agentic)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        return `Error: HTTP ${res.status} ${res.statusText} for ${url}`;
      }

      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        const text = raw
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim();
        return text.slice(0, MAX_CONTENT_LENGTH);
      }

      // Non-HTML content (JSON, plain text, etc.)
      return raw.slice(0, MAX_CONTENT_LENGTH);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: WebFetch failed for ${url}: ${msg}`;
    }
  },
};
