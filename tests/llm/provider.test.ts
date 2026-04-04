jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('@temporalio/activity', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { z } from 'zod';
import { callStructured, callRawText } from '../../src/llm/parseWithRetry';
import { registry } from '../../src/llm/providerRegistry';
import type { LLMProvider, LLMProviderCallOptions, LLMProviderResult } from '../../src/llm/provider';

function makeMockProvider(
  response: string | ((opts: LLMProviderCallOptions) => LLMProviderResult),
  name = 'mock',
): LLMProvider {
  return {
    name,
    call: async (opts: LLMProviderCallOptions) => {
      if (typeof response === 'function') return response(opts);
      return { text: response, toolUsage: [] };
    },
  };
}

function setTestProvider(provider: LLMProvider) {
  registry.register(provider);
  registry.setDefault(provider.name);
}

const TestSchema = z.object({ name: z.string(), value: z.number() });

describe('Provider abstraction', () => {
  describe('registry + callStructured', () => {
    it('uses registered provider for structured calls', async () => {
      setTestProvider(makeMockProvider('{"name":"test","value":42}'));

      const result = await callStructured(TestSchema, {
        system: 'test',
        userContent: 'test',
      });

      expect(result).toEqual({ name: 'test', value: 42 });
    });

    it('passes jsonMode: true to provider for structured calls', async () => {
      let receivedOpts: LLMProviderCallOptions | undefined;
      setTestProvider({
        name: 'spy',
        call: async (opts: LLMProviderCallOptions) => {
          receivedOpts = opts;
          return { text: '{"name":"x","value":0}', toolUsage: [] };
        },
      });

      await callStructured(TestSchema, { system: 'sys', userContent: 'uc' });

      expect(receivedOpts?.jsonMode).toBe(true);
      expect(receivedOpts?.system).toBe('sys');
    });

    it('passes model to provider', async () => {
      let receivedModel: string | undefined;
      setTestProvider({
        name: 'spy',
        call: async (opts: LLMProviderCallOptions) => {
          receivedModel = opts.model;
          return { text: '{"name":"x","value":0}', toolUsage: [] };
        },
      });

      await callStructured(TestSchema, { system: 's', userContent: 'u', model: 'gpt-4o' });

      expect(receivedModel).toBe('gpt-4o');
    });

    it('selects provider by name', async () => {
      registry.register(makeMockProvider('{"name":"named","value":1}', 'specific'));
      const result = await callStructured(TestSchema, { system: 's', userContent: 'u', provider: 'specific' });
      expect(result.name).toBe('named');
    });
  });

  describe('registry + callRawText', () => {
    it('uses registered provider for raw text calls', async () => {
      setTestProvider(makeMockProvider('Hello from custom provider'));

      const result = await callRawText({ system: 'test', userContent: 'test' });

      expect(result.text).toBe('Hello from custom provider');
    });

    it('passes allowedTools to provider', async () => {
      let receivedTools: string[] | undefined;
      setTestProvider({
        name: 'spy',
        call: async (opts: LLMProviderCallOptions) => {
          receivedTools = opts.allowedTools;
          return { text: 'ok', toolUsage: [] };
        },
      });

      await callRawText({ system: 's', userContent: 'u', allowedTools: ['WebFetch'] });

      expect(receivedTools).toEqual(['WebFetch']);
    });

    it('returns tool usage from provider', async () => {
      setTestProvider(makeMockProvider(() => ({
        text: 'result',
        toolUsage: [{ tool: 'WebFetch', input: 'https://example.com', output: '{}', timestamp: 123 }],
      })));

      const result = await callRawText({ system: 's', userContent: 'u' });

      expect(result.toolUsage).toHaveLength(1);
      expect(result.toolUsage[0].tool).toBe('WebFetch');
    });

    it('does not pass jsonMode for raw text calls', async () => {
      let receivedOpts: LLMProviderCallOptions | undefined;
      setTestProvider({
        name: 'spy',
        call: async (opts: LLMProviderCallOptions) => {
          receivedOpts = opts;
          return { text: 'ok', toolUsage: [] };
        },
      });

      await callRawText({ system: 's', userContent: 'u' });

      expect(receivedOpts?.jsonMode).toBeFalsy();
    });
  });
});
