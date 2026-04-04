import { MockActivityEnvironment } from '@temporalio/testing';
import type { IntegratorResponse } from '../../src/types/agents';
import type { Task } from '../../src/types/task';
import type { LLMCallOptions } from '../../src/llm/parseWithRetry';

jest.mock('../../src/llm/parseWithRetry', () => ({
  callRawText: jest.fn(),
}));

jest.mock('../../src/activities/artifactStore', () => ({
  writeIntegratedResult: jest.fn().mockResolvedValue('/tmp/agentic/mock/_integrated/response.md'),
}));

import { callRawText } from '../../src/llm/parseWithRetry';
import { writeIntegratedResult } from '../../src/activities/artifactStore';
import { integratorActivity } from '../../src/activities/integratorActivity';

const mockCallRawText = callRawText as jest.MockedFunction<typeof callRawText>;
const mockWriteResult = writeIntegratedResult as jest.MockedFunction<typeof writeIntegratedResult>;

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

function setupMock(text: string) {
  mockCallRawText.mockResolvedValue({ text, toolUsage: [] });
}

describe('integratorActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => {
    mockCallRawText.mockReset();
    mockWriteResult.mockReset().mockResolvedValue('/tmp/agentic/mock/_integrated/response.md');
  });

  // --- callRawText argument verification ---

  it('calls callRawText with correct provider and model', async () => {
    setupMock('integrated');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      model: 'claude-sonnet-4-6',
      provider: 'local-llm',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.provider).toBe('local-llm');
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('includes all task results in userContent (inline)', async () => {
    setupMock('combined');

    await env.run(integratorActivity, {
      originalPrompt: 'Build app',
      reviewedTasks: [
        makeTask({ description: 'Task A', result: 'Result A' }),
        makeTask({ id: 'task-2', description: 'Task B', result: 'Result B' }),
      ],
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).toContain('### Task A');
    expect(opts.userContent).toContain('Result A');
    expect(opts.userContent).toContain('### Task B');
    expect(opts.userContent).toContain('Result B');
  });

  it('shows (no result) for tasks without result', async () => {
    setupMock('handled');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask({ result: undefined })],
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).toContain('(no result)');
  });

  it('uses file paths instead of inline when taskResultFiles provided', async () => {
    setupMock('from files');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      taskResultFiles: [
        { taskId: 't1', description: 'Task A', filePath: '/tmp/agentic/wf/t1/result.md' },
      ],
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).toContain('/tmp/agentic/wf/t1/result.md');
    expect(opts.userContent).toContain('Read ツール');
    expect(opts.allowedTools).toContain('Read');
  });

  it('adds Read tool to existing allowedTools when using file paths', async () => {
    setupMock('result');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      taskResultFiles: [{ taskId: 't1', description: 'Task', filePath: '/tmp/file.md' }],
      model: 'test',
      allowedTools: ['Grep'],
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.allowedTools).toContain('Read');
    expect(opts.allowedTools).toContain('Grep');
  });

  it('does not duplicate Read in allowedTools when already present', async () => {
    setupMock('result');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      taskResultFiles: [{ taskId: 't1', description: 'Task', filePath: '/tmp/file.md' }],
      model: 'test',
      allowedTools: ['Read', 'Grep'],
    });

    const opts = mockCallRawText.mock.calls[0][0];
    const readCount = opts.allowedTools!.filter((t: string) => t === 'Read').length;
    expect(readCount).toBe(1);
  });

  // --- planContext ---

  it('includes planContext.userIntent and qualityGuidelines in userContent', async () => {
    setupMock('integrated with context');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      model: 'test',
      planContext: {
        userIntent: 'User wants comprehensive analysis',
        qualityGuidelines: 'Cite all sources',
      },
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).toContain('User wants comprehensive analysis');
    expect(opts.userContent).toContain('Cite all sources');
  });

  it('includes only userIntent when qualityGuidelines absent', async () => {
    setupMock('result');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      model: 'test',
      planContext: { userIntent: 'Only intent here' },
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).toContain('Only intent here');
    expect(opts.userContent).not.toContain('品質指針');
  });

  it('omits planContext sections when not provided', async () => {
    setupMock('result');

    await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).not.toContain('ユーザーの意図');
    expect(opts.userContent).not.toContain('品質指針');
  });

  // --- File writing ---

  it('calls writeIntegratedResult when workflowId provided', async () => {
    setupMock('integrated text');

    const result = (await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      model: 'test',
      workflowId: 'wf-123',
    })) as IntegratorResponse;

    expect(mockWriteResult).toHaveBeenCalledWith('wf-123', 'integrated text');
    expect(result.integratedResponseFilePath).toBe('/tmp/agentic/mock/_integrated/response.md');
  });

  it('does not write file when workflowId absent', async () => {
    setupMock('inline');

    const result = (await env.run(integratorActivity, {
      originalPrompt: 'Test',
      reviewedTasks: [makeTask()],
      model: 'test',
    })) as IntegratorResponse;

    expect(mockWriteResult).not.toHaveBeenCalled();
    expect(result.integratedResponseFilePath).toBeUndefined();
  });

});
