import { webSearchTool } from '../../../src/llm/tools/webSearch';

// Save and restore env
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('webSearchTool', () => {
  it('has correct definition', () => {
    expect(webSearchTool.definition.name).toBe('WebSearch');
    expect(webSearchTool.definition.input_schema.required).toContain('query');
  });

  it('returns error when BRAVE_SEARCH_API_KEY is not set', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    const result = await webSearchTool.execute({ query: 'test' });
    expect(result).toContain('BRAVE_SEARCH_API_KEY');
    expect(result).toContain('Error');
  });

  it('returns error for empty query', async () => {
    const result = await webSearchTool.execute({});
    expect(result).toContain('Error');
  });

  it('calls Brave Search API and parses results', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';

    const mockResults = {
      web: {
        results: [
          { title: 'Result 1', url: 'https://example.com/1', description: 'First result' },
          { title: 'Result 2', url: 'https://example.com/2', description: 'Second result' },
        ],
      },
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResults),
    }) as any;

    const result = await webSearchTool.execute({ query: 'test query' });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('test%20query'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Subscription-Token': 'test-key' }),
      }),
    );
    expect(result).toContain('Result 1');
    expect(result).toContain('https://example.com/1');
    expect(result).toContain('Result 2');
  });

  it('handles empty search results', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ web: { results: [] } }),
    }) as any;

    const result = await webSearchTool.execute({ query: 'no results query' });
    expect(result).toContain('No search results found');
  });

  it('handles API error response', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    }) as any;

    const result = await webSearchTool.execute({ query: 'test' });
    expect(result).toContain('429');
  });

  it('handles network error', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
    global.fetch = jest.fn().mockRejectedValue(new Error('Network failure')) as any;

    const result = await webSearchTool.execute({ query: 'test' });
    expect(result).toContain('Network failure');
  });
});
