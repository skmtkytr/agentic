jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('@temporalio/activity', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { z } from 'zod';
import { callStructured, callRawText, setProvider } from '../../src/llm/parseWithRetry';
import type { LLMProvider } from '../../src/llm/provider';

function mockProvider(text: string): LLMProvider {
  return {
    name: 'test',
    call: async () => ({ text, toolUsage: [] }),
  };
}

const TestSchema = z.object({ name: z.string(), value: z.number() });

describe('callStructured', () => {
  it('parses valid JSON and validates against schema', async () => {
    setProvider(mockProvider('{"name":"test","value":42}'));
    const result = await callStructured(TestSchema, { system: 'test', userContent: 'test' });
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('strips markdown code fences before parsing', async () => {
    setProvider(mockProvider('```json\n{"name":"fenced","value":1}\n```'));
    const result = await callStructured(TestSchema, { system: 'test', userContent: 'test' });
    expect(result.name).toBe('fenced');
  });

  it('strips code fences without json label', async () => {
    setProvider(mockProvider('```\n{"name":"plain","value":2}\n```'));
    const result = await callStructured(TestSchema, { system: 'test', userContent: 'test' });
    expect(result.name).toBe('plain');
  });

  it('throws on invalid JSON', async () => {
    setProvider(mockProvider('not json'));
    await expect(callStructured(TestSchema, { system: 's', userContent: 'u' })).rejects.toThrow(/JSON parse failed/);
  });

  it('throws on schema validation failure', async () => {
    setProvider(mockProvider('{"name":"test","value":"not_a_number"}'));
    await expect(callStructured(TestSchema, { system: 's', userContent: 'u' })).rejects.toThrow(/Schema validation failed/);
  });

  it('throws when result is empty', async () => {
    setProvider(mockProvider(''));
    await expect(callStructured(TestSchema, { system: 's', userContent: 'u' })).rejects.toThrow(/LLM returned empty result/);
  });

  it('appends JSON instruction to prompt', async () => {
    let receivedPrompt = '';
    setProvider({
      name: 'spy',
      call: async (opts) => { receivedPrompt = opts.prompt; return { text: '{"name":"x","value":0}', toolUsage: [] }; },
    });
    await callStructured(TestSchema, { system: 's', userContent: 'original prompt' });
    expect(receivedPrompt).toContain('original prompt');
    expect(receivedPrompt).toContain('ONLY valid JSON');
  });

  it('passes model to provider', async () => {
    let receivedModel: string | undefined;
    setProvider({
      name: 'spy',
      call: async (opts) => { receivedModel = opts.model; return { text: '{"name":"x","value":0}', toolUsage: [] }; },
    });
    await callStructured(TestSchema, { system: 's', userContent: 'u', model: 'gpt-4o' });
    expect(receivedModel).toBe('gpt-4o');
  });
});

describe('callRawText', () => {
  it('returns text from provider', async () => {
    setProvider(mockProvider('Hello'));
    const result = await callRawText({ system: 's', userContent: 'u' });
    expect(result.text).toBe('Hello');
  });

  it('passes allowedTools to provider', async () => {
    let receivedTools: string[] | undefined;
    setProvider({
      name: 'spy',
      call: async (opts) => { receivedTools = opts.allowedTools; return { text: 'ok', toolUsage: [] }; },
    });
    await callRawText({ system: 's', userContent: 'u', allowedTools: ['WebFetch'] });
    expect(receivedTools).toEqual(['WebFetch']);
  });

  it('returns tool usage from provider', async () => {
    setProvider({
      name: 'spy',
      call: async () => ({
        text: 'done',
        toolUsage: [{ tool: 'Bash', input: 'ls', output: 'file.txt', timestamp: 1 }],
      }),
    });
    const result = await callRawText({ system: 's', userContent: 'u' });
    expect(result.toolUsage).toHaveLength(1);
    expect(result.toolUsage[0].tool).toBe('Bash');
  });

  it('passes model to provider', async () => {
    let receivedModel: string | undefined;
    setProvider({
      name: 'spy',
      call: async (opts) => { receivedModel = opts.model; return { text: 'ok', toolUsage: [] }; },
    });
    await callRawText({ system: 's', userContent: 'u', model: 'claude-haiku-4-5' });
    expect(receivedModel).toBe('claude-haiku-4-5');
  });
});
