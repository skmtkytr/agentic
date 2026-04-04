jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'mock response' }],
        }),
      },
    })),
  };
});

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicApiProvider } from '../../src/llm/providers/anthropicApi';

const MockedAnthropic = Anthropic as jest.MockedClass<typeof Anthropic>;

describe('AnthropicApiProvider', () => {
  beforeEach(() => {
    MockedAnthropic.mockClear();
  });

  it('uses default name "anthropic-api"', () => {
    const provider = new AnthropicApiProvider();
    expect(provider.name).toBe('anthropic-api');
  });

  it('accepts custom name', () => {
    const provider = new AnthropicApiProvider({ name: 'local-llm' });
    expect(provider.name).toBe('local-llm');
  });

  it('passes baseURL to Anthropic client', () => {
    new AnthropicApiProvider({ baseURL: 'http://localhost:1234' });
    expect(MockedAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:1234' }),
    );
  });

  it('does not pass baseURL when not specified', () => {
    new AnthropicApiProvider();
    const callArgs = MockedAnthropic.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('baseURL');
  });

  it('calls messages.create with correct params', async () => {
    const provider = new AnthropicApiProvider({ defaultModel: 'test-model' });
    const result = await provider.call({
      system: 'you are helpful',
      prompt: 'hello',
    });

    const client = MockedAnthropic.mock.results[0].value;
    expect(client.messages.create).toHaveBeenCalledWith({
      model: 'test-model',
      max_tokens: 8192,
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.text).toBe('mock response');
    expect(result.toolUsage).toEqual([]);
  });

  it('uses per-call model over default', async () => {
    const provider = new AnthropicApiProvider({ defaultModel: 'default-model' });
    await provider.call({
      system: 'sys',
      prompt: 'p',
      model: 'override-model',
    });

    const client = MockedAnthropic.mock.results[0].value;
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'override-model' }),
    );
  });

  it('returns empty toolUsage', async () => {
    const provider = new AnthropicApiProvider();
    const result = await provider.call({ system: '', prompt: '' });
    expect(result.toolUsage).toEqual([]);
  });
});
