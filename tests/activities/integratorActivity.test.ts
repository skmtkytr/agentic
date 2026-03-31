import { MockActivityEnvironment } from '@temporalio/testing';
import type { IntegratorResponse } from '../../src/types/agents';
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

import { integratorActivity } from '../../src/activities/integratorActivity';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    description: 'Test task',
    dependsOn: [],
    status: 'reviewed',
    reviewPassed: true,
    result: 'task result',
    ...overrides,
  };
}

describe('integratorActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockQuery.mockReset());

  it('integrates reviewed task results', async () => {
    setupQueryMock('Integrated response combining all results');

    const result = (await env.run(integratorActivity, {
      originalPrompt: 'Build a calculator',
      reviewedTasks: [
        makeTask({ id: 't1', description: 'Add function', result: 'add impl' }),
        makeTask({ id: 't2', description: 'Multiply function', result: 'multiply impl' }),
      ],
      model: 'claude-opus-4-6',
    })) as IntegratorResponse;

    expect(result.integratedResponse).toBe('Integrated response combining all results');
  });

  it('includes all task results in prompt', async () => {
    setupQueryMock('combined');

    await env.run(integratorActivity, {
      originalPrompt: 'test',
      reviewedTasks: [
        makeTask({ description: 'Task A', result: 'Result A' }),
        makeTask({ description: 'Task B', result: 'Result B' }),
      ],
      model: 'claude-opus-4-6',
    });

    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('### Task A');
    expect(prompt).toContain('Result A');
    expect(prompt).toContain('### Task B');
    expect(prompt).toContain('Result B');
  });

  it('handles tasks with no result', async () => {
    setupQueryMock('handled');

    await env.run(integratorActivity, {
      originalPrompt: 'test',
      reviewedTasks: [makeTask({ result: undefined })],
      model: 'claude-opus-4-6',
    });

    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('(no result)');
  });

  it('uses file paths in prompt when taskResultFiles provided', async () => {
    setupQueryMock('integrated from files');

    await env.run(integratorActivity, {
      originalPrompt: 'test',
      reviewedTasks: [makeTask()],
      taskResultFiles: [
        { taskId: 't1', description: 'Task A', filePath: '/tmp/agentic/wf/t1/result.md' },
        { taskId: 't2', description: 'Task B', filePath: '/tmp/agentic/wf/t2/result.md' },
      ],
      model: 'claude-opus-4-6',
    });

    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('/tmp/agentic/wf/t1/result.md');
    expect(prompt).toContain('/tmp/agentic/wf/t2/result.md');
    expect(prompt).toContain('Read ツール');
    // Read tool should be in allowedTools
    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts?.allowedTools).toContain('Read');
  });

  it('uses inline results when no taskResultFiles', async () => {
    setupQueryMock('integrated inline');

    await env.run(integratorActivity, {
      originalPrompt: 'test',
      reviewedTasks: [makeTask({ description: 'Inline task', result: 'Inline data' })],
      model: 'claude-opus-4-6',
    });

    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('Inline data');
  });

  it('passes allowedTools when specified', async () => {
    setupQueryMock('result');

    await env.run(integratorActivity, {
      originalPrompt: 'test',
      reviewedTasks: [makeTask()],
      model: 'claude-opus-4-6',
      allowedTools: ['Read', 'Grep'],
    });

    const opts = mockQuery.mock.calls[0][0].options;
    expect(opts?.allowedTools).toEqual(['Read', 'Grep']);
    expect(opts?.permissionMode).toBe('dontAsk');
  });
});
