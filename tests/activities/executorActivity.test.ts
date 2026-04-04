import { MockActivityEnvironment } from '@temporalio/testing';
import type { ExecutorResponse } from '../../src/types/agents';
import type { Task } from '../../src/types/task';
import type { LLMCallOptions, RawTextResult } from '../../src/llm/parseWithRetry';

// Mock callRawText at the parseWithRetry module level
jest.mock('../../src/llm/parseWithRetry', () => ({
  callRawText: jest.fn(),
}));

// Mock artifactStore to avoid filesystem side effects
jest.mock('../../src/activities/artifactStore', () => ({
  writeTaskResult: jest.fn().mockResolvedValue('/tmp/agentic/mock/result.md'),
  writeToolEvidence: jest.fn().mockResolvedValue('/tmp/agentic/mock/evidence.md'),
}));

import { callRawText } from '../../src/llm/parseWithRetry';
import { writeTaskResult, writeToolEvidence } from '../../src/activities/artifactStore';
import { executorActivity } from '../../src/activities/executorActivity';

const mockCallRawText = callRawText as jest.MockedFunction<typeof callRawText>;
const mockWriteTaskResult = writeTaskResult as jest.MockedFunction<typeof writeTaskResult>;
const mockWriteToolEvidence = writeToolEvidence as jest.MockedFunction<typeof writeToolEvidence>;

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

function setupMock(text: string, toolUsage: RawTextResult['toolUsage'] = []) {
  mockCallRawText.mockResolvedValue({ text, toolUsage });
}

describe('executorActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => {
    mockCallRawText.mockReset();
    mockWriteTaskResult.mockReset().mockResolvedValue('/tmp/agentic/mock/result.md');
    mockWriteToolEvidence.mockReset().mockResolvedValue('/tmp/agentic/mock/evidence.md');
  });

  // --- callRawText argument verification ---

  it('calls callRawText with correct provider and model', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'claude-sonnet-4-6',
      provider: 'local-llm',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.provider).toBe('local-llm');
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('passes allowedTools to callRawText', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Fetch data',
      model: 'test',
      allowedTools: ['WebFetch', 'Bash'],
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.allowedTools).toEqual(['WebFetch', 'Bash']);
  });

  it('does not pass allowedTools when not specified', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Simple',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.allowedTools).toBeUndefined();
  });

  // --- System prompt construction ---

  it('includes tool instruction when allowedTools present', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
      allowedTools: ['WebFetch'],
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).toContain('WebFetch');
    expect(opts.system).toContain('ツールを使わずに推測やハルシネーション');
  });

  it('includes no-tool warning when allowedTools absent', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).toContain('外部ツールは使用できません');
  });

  it('includes completed task context in system prompt', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask({ id: 'task-2', description: 'Step 2' }),
      completedTaskResults: [
        { taskId: 'task-1', description: 'Step 1', result: 'step 1 output' },
      ],
      originalPrompt: 'Multi-step',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).toContain('step 1 output');
    expect(opts.system).toContain('[Step 1]');
  });

  it('includes planContext.userIntent in system prompt', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
      planContext: { userIntent: 'Investment analysis', qualityGuidelines: 'Use real-time data' },
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).toContain('Investment analysis');
    expect(opts.system).toContain('Use real-time data');
  });

  it('omits planContext sections when not provided', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).not.toContain('ユーザーの意図');
    expect(opts.system).not.toContain('品質指針');
  });

  // --- userContent construction ---

  it('includes task guidance in userContent when present', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask({
        purpose: 'Get price data',
        successCriteria: ['From CoinGecko', 'Include JPY'],
        outputFormat: 'Markdown table',
      }),
      completedTaskResults: [],
      originalPrompt: 'Get ETH price',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).toContain('目的: Get price data');
    expect(opts.userContent).toContain('- From CoinGecko');
    expect(opts.userContent).toContain('- Include JPY');
    expect(opts.userContent).toContain('出力形式: Markdown table');
  });

  it('omits task guidance section when no guidance fields', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).not.toContain('タスク固有の指針');
  });

  it('includes originalPrompt and task description in userContent', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask({ description: 'Analyze market trends' }),
      completedTaskResults: [],
      originalPrompt: 'Give me a market report',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.userContent).toContain('Give me a market report');
    expect(opts.userContent).toContain('Analyze market trends');
  });

  // --- planContext partial combinations ---

  it('includes only userIntent when qualityGuidelines absent', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
      planContext: { userIntent: 'Only intent' },
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).toContain('Only intent');
    expect(opts.system).not.toContain('品質指針');
  });

  it('includes only qualityGuidelines when userIntent absent', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
      planContext: { qualityGuidelines: 'Only guidelines' },
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).toContain('Only guidelines');
    expect(opts.system).not.toContain('ユーザーの意図');
  });

  // --- completedTaskResults formatting ---

  it('joins multiple completed task results with double newlines', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask({ id: 'task-3' }),
      completedTaskResults: [
        { taskId: 'task-1', description: 'Step 1', result: 'result 1' },
        { taskId: 'task-2', description: 'Step 2', result: 'result 2' },
      ],
      originalPrompt: 'Test',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).toContain('[Step 1]:\nresult 1');
    expect(opts.system).toContain('[Step 2]:\nresult 2');
  });

  it('omits context section when completedTaskResults is empty', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
    });

    const opts = mockCallRawText.mock.calls[0][0];
    expect(opts.system).not.toContain('完了済みタスクのコンテキスト');
  });

  // --- Result handling ---

  it('maps task.id to result.taskId', async () => {
    setupMock('any result');

    const result = (await env.run(executorActivity, {
      task: makeTask({ id: 'my-task-id' }),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
    })) as ExecutorResponse;

    expect(result.taskId).toBe('my-task-id');
  });

  // --- Error handling ---

  it('propagates callRawText errors for Temporal retry', async () => {
    mockCallRawText.mockRejectedValue(new Error('LLM service unavailable'));

    await expect(
      env.run(executorActivity, {
        task: makeTask(),
        completedTaskResults: [],
        originalPrompt: 'Test',
        model: 'test',
      }),
    ).rejects.toThrow('LLM service unavailable');
  });

  // --- File writing ---

  it('calls writeTaskResult when workflowId is provided', async () => {
    setupMock('file result');

    const result = (await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
      workflowId: 'wf-123',
    })) as ExecutorResponse;

    expect(mockWriteTaskResult).toHaveBeenCalledWith('wf-123', 'task-1', 'file result');
    expect(result.resultFilePath).toBe('/tmp/agentic/mock/result.md');
  });

  it('calls writeToolEvidence when workflowId and toolUsage present', async () => {
    const toolUsage = [{ tool: 'WebFetch', input: 'url', output: 'data', timestamp: 1 }];
    setupMock('result', toolUsage);

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
      workflowId: 'wf-123',
      allowedTools: ['WebFetch'],
    });

    expect(mockWriteToolEvidence).toHaveBeenCalledWith('wf-123', 'task-1', toolUsage);
  });

  it('does not write files when workflowId absent', async () => {
    setupMock('result');

    const result = (await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
    })) as ExecutorResponse;

    expect(mockWriteTaskResult).not.toHaveBeenCalled();
    expect(result.resultFilePath).toBeUndefined();
  });

  it('does not write evidence when no toolUsage', async () => {
    setupMock('result');

    await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
      workflowId: 'wf-123',
    });

    expect(mockWriteTaskResult).toHaveBeenCalled();
    expect(mockWriteToolEvidence).not.toHaveBeenCalled();
  });
});
