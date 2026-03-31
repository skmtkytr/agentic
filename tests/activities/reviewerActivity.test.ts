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
