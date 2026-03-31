jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentProvider } from '../../src/llm/providers/claudeAgent';

const mockQuery = query as jest.MockedFunction<typeof query>;

describe('ClaudeAgentProvider', () => {
  const provider = new ClaudeAgentProvider();

  beforeEach(() => mockQuery.mockReset());

  it('has name "claude-agent"', () => {
    expect(provider.name).toBe('claude-agent');
  });

  it('returns text from query result', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { result: 'Hello' } as never;
    } as any);

    const result = await provider.call({ system: 'sys', prompt: 'hi' });
    expect(result.text).toBe('Hello');
  });

  it('passes tools: [] and jsonMode when jsonMode is true', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { result: '{}' } as never;
    } as any);

    await provider.call({ system: 'sys', prompt: 'json', jsonMode: true });

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts?.tools).toEqual([]);
    expect(opts?.permissionMode).toBe('dontAsk');
  });

  it('passes allowedTools when provided', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { result: 'ok' } as never;
    } as any);

    await provider.call({ system: 'sys', prompt: 'fetch', allowedTools: ['WebFetch'] });

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts?.allowedTools).toEqual(['WebFetch']);
    expect(opts?.permissionMode).toBe('dontAsk');
    expect(opts).not.toHaveProperty('tools');
  });

  it('extracts tool usage from messages', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://example.com' } }] },
      } as never;
      yield {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"data":1}' }] },
      } as never;
      yield { result: 'done' } as never;
    } as any);

    const result = await provider.call({ system: 'sys', prompt: 'fetch', allowedTools: ['WebFetch'] });

    expect(result.text).toBe('done');
    expect(result.toolUsage).toHaveLength(1);
    expect(result.toolUsage[0].tool).toBe('WebFetch');
    expect(result.toolUsage[0].input).toBe('https://example.com');
  });

  it('returns empty toolUsage when no tools used', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { result: 'plain text' } as never;
    } as any);

    const result = await provider.call({ system: 'sys', prompt: 'no tools' });
    expect(result.toolUsage).toEqual([]);
  });

  it('throws on timeout when query hangs', async () => {
    // Create an async generator that yields nothing and hangs via a long delay
    mockQuery.mockImplementation(() => {
      const neverEnding = {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<{ done: boolean; value: never }>(() => {}), // never resolves
            return: async () => ({ done: true as const, value: undefined as never }),
          };
        },
      };
      return neverEnding as any;
    });

    const shortTimeout = new ClaudeAgentProvider({ timeoutMs: 100 });
    await expect(shortTimeout.call({ system: 'sys', prompt: 'hang' }))
      .rejects.toThrow(/timed out/i);
  }, 3000);

  it('uses default 10 minute timeout', () => {
    const p = new ClaudeAgentProvider();
    expect(p.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('accepts custom timeout', () => {
    const p = new ClaudeAgentProvider({ timeoutMs: 30000 });
    expect(p.timeoutMs).toBe(30000);
  });
});
