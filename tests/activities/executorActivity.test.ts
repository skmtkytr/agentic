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

  // --- Result handling ---

  it('returns taskId and result text', async () => {
    setupMock('function add(a, b) { return a + b; }');

    const result = (await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Create a calculator',
      model: 'test',
    })) as ExecutorResponse;

    expect(result.taskId).toBe('task-1');
    expect(result.result).toBe('function add(a, b) { return a + b; }');
  });

  it('returns toolUsage from callRawText', async () => {
    setupMock('ETH = $2000', [
      { tool: 'WebFetch', input: 'https://api.coingecko.com', output: '{"usd":2000}', timestamp: 1000 },
    ]);

    const result = (await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Get ETH',
      model: 'test',
      allowedTools: ['WebFetch'],
    })) as ExecutorResponse;

    expect(result.toolUsage).toHaveLength(1);
    expect(result.toolUsage![0].tool).toBe('WebFetch');
  });

  it('returns empty toolUsage when none used', async () => {
    setupMock('plain result');

    const result = (await env.run(executorActivity, {
      task: makeTask(),
      completedTaskResults: [],
      originalPrompt: 'Test',
      model: 'test',
    })) as ExecutorResponse;

    expect(result.toolUsage).toEqual([]);
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
