import { MockActivityEnvironment } from '@temporalio/testing';
import type { ExecutorResponse } from '../../src/types/agents';
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

import { executorActivity } from '../../src/activities/executorActivity';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    description: 'Write a function',
    dependsOn: [],
    status: 'pending',
    reviewPassed: false,
    ...overrides,
  };
}

describe('executorActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockQuery.mockReset());

  it('executes a task and returns the result', async () => {
    setupQueryMock('function add(a, b) { return a + b; }');

    const result = (await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Create a calculator',
      model: 'claude-opus-4-6',
    })) as ExecutorResponse;

    expect(result.taskId).toBe('task-1');
    expect(result.result).toBe('function add(a, b) { return a + b; }');
  });

  it('includes completed task context in system prompt', async () => {
    setupQueryMock('step 2 result');

    await env.run(executorActivity, {
      task: makeTask({ id: 'task-2', description: 'Step 2' }),
      completedTaskResults: [
        { taskId: 'task-1', description: 'Step 1', result: 'step 1 result' },
      ],
      originalPrompt: 'Multi-step task',
      model: 'claude-opus-4-6',
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options?.systemPrompt).toContain('step 1 result');
    expect(callArgs.options?.systemPrompt).toContain('[Step 1]');
  });

  it('passes allowedTools to query options', async () => {
    setupQueryMock('result with tools');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Fetch data',
      model: 'claude-opus-4-6',
      allowedTools: ['WebFetch', 'Bash'],
    });

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts?.allowedTools).toEqual(['WebFetch', 'Bash']);
    expect(opts?.permissionMode).toBe('dontAsk');
  });

  it('uses tools: [] when allowedTools not specified', async () => {
    setupQueryMock('result without tools');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Simple task',
      model: 'claude-opus-4-6',
    });

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts?.tools).toEqual([]);
    expect(opts).not.toHaveProperty('allowedTools');
  });

  it('returns empty string when no result', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system' } as never;
    } as any);

    const result = (await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'claude-opus-4-6',
    })) as ExecutorResponse;

    expect(result.result).toBe('');
  });
});
