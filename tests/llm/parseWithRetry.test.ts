jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('@temporalio/activity', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { z } from 'zod';
import { callStructured, callRawText } from '../../src/llm/parseWithRetry';
import { registry } from '../../src/llm/providerRegistry';
import type { LLMProvider, LLMProviderCallOptions } from '../../src/llm/provider';

function mockProvider(text: string, name = 'test'): LLMProvider {
  return {
    name,
    call: async () => ({ text, toolUsage: [] }),
  };
}

function setTestProvider(provider: LLMProvider) {
  registry.register(provider);
  registry.setDefault(provider.name);
}

const TestSchema = z.object({ name: z.string(), value: z.number() });

describe('callStructured', () => {
  it('parses valid JSON and validates against schema', async () => {
    setTestProvider(mockProvider('{"name":"test","value":42}'));
    const result = await callStructured(TestSchema, { system: 'test', userContent: 'test' });
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('strips markdown code fences before parsing', async () => {
    setTestProvider(mockProvider('```json\n{"name":"fenced","value":1}\n```'));
    const result = await callStructured(TestSchema, { system: 'test', userContent: 'test' });
    expect(result.name).toBe('fenced');
  });

  it('strips code fences without json label', async () => {
    setTestProvider(mockProvider('```\n{"name":"plain","value":2}\n```'));
    const result = await callStructured(TestSchema, { system: 'test', userContent: 'test' });
    expect(result.name).toBe('plain');
  });

  it('throws JSONParseError (non-retryable) on invalid JSON', async () => {
    setTestProvider(mockProvider('not json'));
    try {
      await callStructured(TestSchema, { system: 's', userContent: 'u' });
      fail('Expected to throw');
    } catch (err: any) {
      expect(err.name).toBe('JSONParseError');
      expect(err.message).toMatch(/JSON parse failed/);
    }
  });

  it('throws SchemaValidationError (non-retryable) on schema mismatch', async () => {
    setTestProvider(mockProvider('{"name":"test","value":"not_a_number"}'));
    try {
      await callStructured(TestSchema, { system: 's', userContent: 'u' });
      fail('Expected to throw');
    } catch (err: any) {
      expect(err.name).toBe('SchemaValidationError');
      expect(err.message).toMatch(/Schema validation failed/);
    }
  });

  it('throws plain Error (retryable) when result is empty', async () => {
    setTestProvider(mockProvider(''));
    try {
      await callStructured(TestSchema, { system: 's', userContent: 'u' });
      fail('Expected to throw');
    } catch (err: any) {
      expect(err.name).toBe('Error');
      expect(err.message).toMatch(/LLM returned empty result/);
    }
  });

  it('appends JSON instruction to prompt', async () => {
    let receivedPrompt = '';
    setTestProvider({
      name: 'spy',
      call: async (opts: LLMProviderCallOptions) => { receivedPrompt = opts.prompt; return { text: '{"name":"x","value":0}', toolUsage: [] }; },
    });
    await callStructured(TestSchema, { system: 's', userContent: 'original prompt' });
    expect(receivedPrompt).toContain('original prompt');
    expect(receivedPrompt).toContain('ONLY valid JSON');
  });

  it('passes model to provider', async () => {
    let receivedModel: string | undefined;
    setTestProvider({
      name: 'spy',
      call: async (opts: LLMProviderCallOptions) => { receivedModel = opts.model; return { text: '{"name":"x","value":0}', toolUsage: [] }; },
    });
    await callStructured(TestSchema, { system: 's', userContent: 'u', model: 'gpt-4o' });
    expect(receivedModel).toBe('gpt-4o');
  });

  it('uses provider specified by name', async () => {
    registry.register(mockProvider('{"name":"from-named","value":99}', 'named-provider'));
    const result = await callStructured(TestSchema, { system: 's', userContent: 'u', provider: 'named-provider' });
    expect(result).toEqual({ name: 'from-named', value: 99 });
  });
});

describe('callRawText', () => {
  it('returns text from provider', async () => {
    setTestProvider(mockProvider('Hello'));
    const result = await callRawText({ system: 's', userContent: 'u' });
    expect(result.text).toBe('Hello');
  });

  it('passes allowedTools to provider', async () => {
    let receivedTools: string[] | undefined;
    setTestProvider({
      name: 'spy',
      call: async (opts: LLMProviderCallOptions) => { receivedTools = opts.allowedTools; return { text: 'ok', toolUsage: [] }; },
    });
    await callRawText({ system: 's', userContent: 'u', allowedTools: ['WebFetch'] });
    expect(receivedTools).toEqual(['WebFetch']);
  });

  it('returns tool usage from provider', async () => {
    setTestProvider({
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
    setTestProvider({
      name: 'spy',
      call: async (opts: LLMProviderCallOptions) => { receivedModel = opts.model; return { text: 'ok', toolUsage: [] }; },
    });
    await callRawText({ system: 's', userContent: 'u', model: 'claude-haiku-4-5' });
    expect(receivedModel).toBe('claude-haiku-4-5');
  });
});
