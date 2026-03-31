jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

jest.mock('@temporalio/activity', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const mockQuery = query as jest.MockedFunction<typeof query>;

function setupQueryMock(resultText: string) {
  mockQuery.mockImplementation(async function* () {
    yield { result: resultText } as never;
  } as any);
}

function setupEmptyQueryMock() {
  mockQuery.mockImplementation(async function* () {
    yield { type: 'system', subtype: 'init' } as never;
  } as any);
}

import { callStructured, callRawText } from '../../src/llm/parseWithRetry';

const TestSchema = z.object({
  name: z.string(),
  value: z.number(),
});

describe('callStructured', () => {
  beforeEach(() => mockQuery.mockReset());

  it('parses valid JSON and validates against schema', async () => {
    setupQueryMock('{"name":"test","value":42}');

    const result = await callStructured(TestSchema, {
      system: 'test system',
      userContent: 'test prompt',
    });

    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('strips markdown code fences before parsing', async () => {
    setupQueryMock('```json\n{"name":"fenced","value":1}\n```');

    const result = await callStructured(TestSchema, {
      system: 'test',
      userContent: 'test',
    });

    expect(result.name).toBe('fenced');
  });

  it('strips code fences without json label', async () => {
    setupQueryMock('```\n{"name":"plain","value":2}\n```');

    const result = await callStructured(TestSchema, {
      system: 'test',
      userContent: 'test',
    });

    expect(result.name).toBe('plain');
  });

  it('throws on invalid JSON', async () => {
    setupQueryMock('not json at all');

    await expect(
      callStructured(TestSchema, { system: 'test', userContent: 'test' }),
    ).rejects.toThrow(/JSON parse failed/);
  });

  it('throws on schema validation failure', async () => {
    setupQueryMock('{"name":"test","value":"not_a_number"}');

    await expect(
      callStructured(TestSchema, { system: 'test', userContent: 'test' }),
    ).rejects.toThrow(/Schema validation failed/);
  });

  it('throws when result is empty', async () => {
    setupEmptyQueryMock();

    await expect(
      callStructured(TestSchema, { system: 'test', userContent: 'test' }),
    ).rejects.toThrow(/Agent SDK returned empty result/);
  });

  it('passes model to query options', async () => {
    setupQueryMock('{"name":"m","value":0}');

    await callStructured(TestSchema, {
      system: 'sys',
      userContent: 'uc',
      model: 'claude-sonnet-4-6',
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: 'claude-sonnet-4-6',
          tools: [],
          permissionMode: 'dontAsk',
        }),
      }),
    );
  });

  it('does not include model when not specified', async () => {
    setupQueryMock('{"name":"m","value":0}');

    await callStructured(TestSchema, { system: 'sys', userContent: 'uc' });

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts).not.toHaveProperty('model');
  });

  it('uses tools: [] to disable all built-in tools', async () => {
    setupQueryMock('{"name":"m","value":0}');

    await callStructured(TestSchema, { system: 'sys', userContent: 'uc' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ tools: [], permissionMode: 'dontAsk' }),
      }),
    );
  });
});

describe('callRawText', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns raw text result', async () => {
    setupQueryMock('Hello world');

    const result = await callRawText({
      system: 'test',
      userContent: 'say hello',
    });

    expect(result).toBe('Hello world');
  });

  it('returns empty string when no result message', async () => {
    setupEmptyQueryMock();

    const result = await callRawText({ system: 'test', userContent: 'test' });

    expect(result).toBe('');
  });

  it('uses tools: [] when no allowedTools specified', async () => {
    setupQueryMock('text');

    await callRawText({ system: 's', userContent: 'u' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ tools: [], permissionMode: 'dontAsk' }),
      }),
    );
  });

  it('uses tools: [] when allowedTools is empty array', async () => {
    setupQueryMock('text');

    await callRawText({ system: 's', userContent: 'u', allowedTools: [] });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ tools: [], permissionMode: 'dontAsk' }),
      }),
    );
  });

  it('passes allowedTools and permissionMode when tools specified', async () => {
    setupQueryMock('text');

    await callRawText({
      system: 's',
      userContent: 'u',
      allowedTools: ['WebFetch', 'WebSearch'],
    });

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts).toEqual(
      expect.objectContaining({
        allowedTools: ['WebFetch', 'WebSearch'],
        permissionMode: 'dontAsk',
      }),
    );
    expect(opts).not.toHaveProperty('tools');
  });

  it('passes model when specified', async () => {
    setupQueryMock('text');

    await callRawText({
      system: 's',
      userContent: 'u',
      model: 'claude-opus-4-6',
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'claude-opus-4-6' }),
      }),
    );
  });
});
