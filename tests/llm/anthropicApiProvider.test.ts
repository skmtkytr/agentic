jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'mock response' }],
          stop_reason: 'end_turn',
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

  // --- Tool-use loop tests ---

  it('does not send tools when enableTools is false', async () => {
    const provider = new AnthropicApiProvider({ enableTools: false });
    await provider.call({ system: 'sys', prompt: 'hello', allowedTools: ['Read', 'Bash'] });

    const client = MockedAnthropic.mock.results[0].value;
    const callArgs = client.messages.create.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('tools');
  });

  it('sends tool definitions when enableTools is true and allowedTools provided', async () => {
    const provider = new AnthropicApiProvider({ enableTools: true });
    await provider.call({ system: 'sys', prompt: 'hello', allowedTools: ['Read', 'Bash'] });

    const client = MockedAnthropic.mock.results[0].value;
    const callArgs = client.messages.create.mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools.length).toBe(2);
    const toolNames = callArgs.tools.map((t: any) => t.name);
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Bash');
  });

  it('ignores tools without native handlers', async () => {
    const provider = new AnthropicApiProvider({ enableTools: true });
    await provider.call({ system: 'sys', prompt: 'hello', allowedTools: ['NotebookEdit'] });

    const client = MockedAnthropic.mock.results[0].value;
    // No native handler for NotebookEdit → falls back to simple call
    const callArgs = client.messages.create.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('tools');
  });

  it('executes tool-use loop and returns final text with toolUsage', async () => {
    const provider = new AnthropicApiProvider({ enableTools: true });
    const client = MockedAnthropic.mock.results[0].value;

    // First call: model wants to use Read tool
    client.messages.create
      .mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'echo hello' } },
        ],
        stop_reason: 'tool_use',
      })
      // Second call: model returns final answer
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'The file contains hello.' }],
        stop_reason: 'end_turn',
      });

    const result = await provider.call({
      system: 'sys',
      prompt: 'read /tmp/test',
      allowedTools: ['Bash'],
    });

    expect(result.text).toBe('The file contains hello.');
    expect(result.toolUsage.length).toBe(1);
    expect(result.toolUsage[0].tool).toBe('Bash');
    expect(result.toolUsage[0].input).toBe('echo hello');
    // Second call should include tool_result
    const secondCallMessages = client.messages.create.mock.calls[1][0].messages;
    expect(secondCallMessages.length).toBe(3); // user, assistant, tool_result
    const toolResultMsg = secondCallMessages[2];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.content[0].type).toBe('tool_result');
    expect(toolResultMsg.content[0].tool_use_id).toBe('tool_1');
  });

  it('does not enter tool loop in jsonMode', async () => {
    const provider = new AnthropicApiProvider({ enableTools: true });
    await provider.call({ system: 'sys', prompt: 'json', allowedTools: ['Bash'], jsonMode: true });

    const client = MockedAnthropic.mock.results[0].value;
    const callArgs = client.messages.create.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('tools');
  });
});
