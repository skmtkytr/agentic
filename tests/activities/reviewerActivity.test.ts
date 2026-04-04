import { MockActivityEnvironment } from '@temporalio/testing';
import type { ReviewerResponse } from '../../src/types/agents';
import type { Task } from '../../src/types/task';
import type { LLMCallOptions } from '../../src/llm/parseWithRetry';

jest.mock('../../src/llm/parseWithRetry', () => ({
  callStructured: jest.fn(),
}));

import { callStructured } from '../../src/llm/parseWithRetry';
import { reviewerActivity } from '../../src/activities/reviewerActivity';

const mockCallStructured = callStructured as jest.MockedFunction<typeof callStructured>;

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

function setupMock(result: Partial<ReviewerResponse>) {
  mockCallStructured.mockResolvedValue({
    taskId: 'task-1',
    passed: true,
    notes: 'Good',
    ...result,
  });
}

describe('reviewerActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockCallStructured.mockReset());

  // --- callStructured argument verification ---

  it('calls callStructured with correct provider and model', async () => {
    setupMock({});

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'some result',
      originalPrompt: 'Test',
      model: 'claude-sonnet-4-6',
      provider: 'local-llm',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.provider).toBe('local-llm');
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('uses Read tool when resultFilePath is provided', async () => {
    setupMock({});

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'inline result',
      resultFilePath: '/tmp/agentic/wf/task-1/result.md',
      originalPrompt: 'Test',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.allowedTools).toEqual(['Read']);
    expect(opts.userContent).toContain('/tmp/agentic/wf/task-1/result.md');
    expect(opts.userContent).toContain('Read ツール');
  });

  it('uses inline result when no resultFilePath', async () => {
    setupMock({});

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'inline execution result',
      originalPrompt: 'Test',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.userContent).toContain('inline execution result');
  });

  // --- System prompt: successCriteria ---

  it('includes successCriteria in system prompt when present', async () => {
    setupMock({});

    await env.run(reviewerActivity, {
      task: makeTask({
        successCriteria: ['Data from reliable source', 'Includes USD price'],
      }),
      result: 'ETH = $2000',
      originalPrompt: 'Get ETH price',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.system).toContain('タスク固有の成功基準');
    expect(opts.system).toContain('1. Data from reliable source');
    expect(opts.system).toContain('2. Includes USD price');
  });

  it('does not include successCriteria section when absent', async () => {
    setupMock({});

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'result',
      originalPrompt: 'Test',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.system).not.toContain('タスク固有の成功基準');
  });

  it('does not include successCriteria section when array is empty', async () => {
    setupMock({});

    await env.run(reviewerActivity, {
      task: makeTask({ successCriteria: [] }),
      result: 'result',
      originalPrompt: 'Test',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.system).not.toContain('タスク固有の成功基準');
  });

  // --- Tool evidence in userContent ---

  it('includes tool usage evidence in userContent', async () => {
    setupMock({});

    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'ETH data',
      originalPrompt: 'Test',
      model: 'test',
      toolUsage: [
        { tool: 'WebFetch', input: 'https://api.coingecko.com', output: '{"usd":2000}', timestamp: 1 },
      ],
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('WebFetch');
    expect(opts.userContent).toContain('https://api.coingecko.com');
  });

  it('truncates tool output to exactly 200 chars in evidence', async () => {
    setupMock({});

    const output201 = 'a'.repeat(201);
    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'result',
      originalPrompt: 'Test',
      model: 'test',
      toolUsage: [
        { tool: 'WebFetch', input: 'url', output: output201, timestamp: 1 },
      ],
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('a'.repeat(200));
    expect(opts.userContent).not.toContain('a'.repeat(201));
  });

  it('does not truncate tool output at exactly 200 chars', async () => {
    setupMock({});

    const output200 = 'b'.repeat(200);
    await env.run(reviewerActivity, {
      task: makeTask(),
      result: 'result',
      originalPrompt: 'Test',
      model: 'test',
      toolUsage: [
        { tool: 'WebFetch', input: 'url', output: output200, timestamp: 1 },
      ],
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain(output200);
  });

  // --- Result handling ---

  it('falls back to req.task.id when LLM returns empty taskId', async () => {
    setupMock({ taskId: '', passed: true, notes: 'ok' });

    const result = (await env.run(reviewerActivity, {
      task: makeTask({ id: 'my-task' }),
      result: 'result',
      originalPrompt: 'Test',
      model: 'test',
    })) as ReviewerResponse;

    expect(result.taskId).toBe('my-task');
  });
});
