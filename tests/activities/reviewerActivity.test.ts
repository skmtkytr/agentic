import { MockActivityEnvironment } from '@temporalio/testing';
import type { ReviewerResponse } from '../../src/types/agents';
import type { Task } from '../../src/types/task';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = query as jest.MockedFunction<typeof query>;

function setupQueryMock(resultText: string) {
  mockQuery.mockImplementation(async function* () {
    yield { result: resultText } as never;
  } as any);
}

import { reviewerActivity } from '../../src/activities/reviewerActivity';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    description: 'Write a function',
    dependsOn: [],
    status: 'executed',
    reviewPassed: false,
    ...overrides,
  };
}

describe('reviewerActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockQuery.mockReset());

  it('returns passed review', async () => {
    setupQueryMock(
      JSON.stringify({
        taskId: 'task-1',
        passed: true,
        notes: 'Good implementation',
      }),
    );

    const result = (await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'function add(a, b) { return a + b; }',
      originalPrompt: 'Create add function',
      model: 'claude-opus-4-6',
    })) as ReviewerResponse;

    expect(result.passed).toBe(true);
    expect(result.taskId).toBe('task-1');
    expect(result.notes).toBe('Good implementation');
    expect(result.revisedResult).toBeUndefined();
  });

  it('returns failed review with notes', async () => {
    setupQueryMock(
      JSON.stringify({
        taskId: 'task-1',
        passed: false,
        notes: 'Missing error handling',
      }),
    );

    const result = (await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'bad code',
      originalPrompt: 'Create robust function',
      model: 'claude-opus-4-6',
    })) as ReviewerResponse;

    expect(result.passed).toBe(false);
    expect(result.notes).toBe('Missing error handling');
  });

  it('returns revised result when provided', async () => {
    setupQueryMock(
      JSON.stringify({
        taskId: 'task-1',
        passed: true,
        notes: 'Fixed minor issue',
        revisedResult: 'improved code here',
      }),
    );

    const result = (await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'original code',
      originalPrompt: 'Create function',
      model: 'claude-opus-4-6',
    })) as ReviewerResponse;

    expect(result.passed).toBe(true);
    expect(result.revisedResult).toBe('improved code here');
  });

  it('uses task.id as fallback when taskId missing from LLM response', async () => {
    setupQueryMock(
      JSON.stringify({
        taskId: '',
        passed: true,
        notes: 'ok',
      }),
    );

    const result = (await env.run(reviewerActivity, {
      task: makeTask({ id: 'my-task-id' }),
      result: 'some result',
      originalPrompt: 'test',
      model: 'claude-opus-4-6',
    })) as ReviewerResponse;

    expect(result.taskId).toBe('my-task-id');
  });

  it('uses file path in prompt and enables Read tool when resultFilePath provided', async () => {
    setupQueryMock(
      JSON.stringify({ taskId: 'task-1', passed: true, notes: 'Verified via file' }),
    );

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'inline result (ignored)',
      resultFilePath: '/tmp/agentic/wf-1/task-1/result.md',
      originalPrompt: 'test',
      model: 'claude-opus-4-6',
    });

    const callArgs = mockQuery.mock.calls[0][0];
    // Prompt should contain file path, not inline result
    expect(callArgs.prompt).toContain('/tmp/agentic/wf-1/task-1/result.md');
    expect(callArgs.prompt).toContain('Read ツール');
    // Read tool should be allowed
    expect(callArgs.options?.allowedTools).toContain('Read');
  });

  it('uses inline result when no resultFilePath', async () => {
    setupQueryMock(
      JSON.stringify({ taskId: 'task-1', passed: true, notes: 'ok' }),
    );

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'my inline result text',
      originalPrompt: 'test',
      model: 'claude-opus-4-6',
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain('my inline result text');
    // No Read tool needed
    expect(callArgs.options?.allowedTools).toBeUndefined();
  });

  it('includes tool usage evidence in prompt when provided', async () => {
    setupQueryMock(
      JSON.stringify({ taskId: 'task-1', passed: true, notes: 'Verified with tool evidence' }),
    );

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'ETH is $2,047',
      originalPrompt: 'Get ETH price',
      model: 'claude-opus-4-6',
      toolUsage: [
        { tool: 'WebFetch', input: 'https://api.coingecko.com/...', output: '{"usd":2047}', timestamp: 1234567890 },
      ],
    });

    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('WebFetch');
    expect(prompt).toContain('https://api.coingecko.com/');
    expect(prompt).toContain('{"usd":2047}');
  });

  it('throws on invalid JSON', async () => {
    setupQueryMock('not json');

    await expect(
      env.run(reviewerActivity, {
        task: makeTask(),
        result: 'code',
        originalPrompt: 'test',
        model: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(/JSON parse failed/);
  });
});
