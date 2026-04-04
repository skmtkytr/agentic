import { webFetchTool } from '../../../src/llm/tools/webFetch';

describe('webFetchTool', () => {
  it('has correct definition', () => {
    expect(webFetchTool.definition.name).toBe('WebFetch');
    expect(webFetchTool.definition.input_schema.required).toContain('url');
  });

  it('returns error for empty url', async () => {
    const result = await webFetchTool.execute({});
    expect(result).toContain('Error');
  });

  it('fetches HTML and extracts text', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/html']]) as any,
      text: () => Promise.resolve('<html><body><script>var x=1;</script><p>Hello world</p></body></html>'),
    }) as any;

    const result = await webFetchTool.execute({ url: 'https://example.com' });
    expect(result).toContain('Hello world');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('var x=1');
  });

  it('returns plain text for non-HTML content', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'application/json']]) as any,
      text: () => Promise.resolve('{"key": "value"}'),
    }) as any;

    const result = await webFetchTool.execute({ url: 'https://api.example.com/data' });
    expect(result).toContain('{"key": "value"}');
  });

  it('handles HTTP error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }) as any;

    const result = await webFetchTool.execute({ url: 'https://example.com/missing' });
    expect(result).toContain('404');
  });

  it('handles network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')) as any;

    const result = await webFetchTool.execute({ url: 'https://nonexistent.example.com' });
    expect(result).toContain('ENOTFOUND');
  });
});
