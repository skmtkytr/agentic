import { MockActivityEnvironment } from '@temporalio/testing';
import type { PlannerResponse } from '../../src/types/agents';

// Agent SDK をモック（実際の Claude Code セッション不要）
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = query as jest.MockedFunction<typeof query>;

function setupQueryMock(resultText: string) {
  // Query 型は AsyncIterable + 追加メソッドを持つため as any でキャスト
  mockQuery.mockImplementation(async function* () {
    yield { result: resultText } as never;
  } as any);
}

// モック設定後に activity をインポート
import { plannerActivity } from '../../src/activities/plannerActivity';

describe('plannerActivity', () => {
  const env = new MockActivityEnvironment();

  it('parses a valid plan and remaps task IDs to UUIDs', async () => {
    const planJson = JSON.stringify({
      planSummary: 'Write and test a function',
      tasks: [
        { id: 'task_1', description: 'Write the function', dependsOn: [], status: 'pending', reviewPassed: false },
        { id: 'task_2', description: 'Write tests for the function', dependsOn: ['task_1'], status: 'pending', reviewPassed: false },
      ],
    });

    setupQueryMock(planJson);

    const result = (await env.run(plannerActivity, {
      prompt: 'Create a utility function',
      model: 'claude-opus-4-6',
    })) as PlannerResponse;

    expect(result.plan.tasks).toHaveLength(2);
    expect(result.plan.planSummary).toBe('Write and test a function');

    // IDs should be UUIDs (remapped from task_1, task_2)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const task of result.plan.tasks) {
      expect(task.id).toMatch(uuidRegex);
    }

    // 2つ目のタスクは1つ目のUUIDに依存しているはず
    const [task1, task2] = result.plan.tasks;
    expect(task2.dependsOn).toContain(task1.id);
  });

  it('retries when response is not valid JSON', async () => {
    setupQueryMock('This is not JSON at all');

    await expect(
      env.run(plannerActivity, { prompt: 'Test', model: 'claude-opus-4-6' }),
    ).rejects.toThrow(/JSON parse failed/);
  });

  it('retries when JSON does not match schema (empty tasks array)', async () => {
    setupQueryMock(JSON.stringify({ planSummary: 'oops', tasks: [] }));

    await expect(
      env.run(plannerActivity, { prompt: 'Test', model: 'claude-opus-4-6' }),
    ).rejects.toThrow(/Schema validation failed/);
  });

  it('passes provider to callStructured', async () => {
    // Register a test provider in the registry
    const { registry } = require('../../src/llm/providerRegistry');

    const planJson = JSON.stringify({
      planSummary: 'A plan',
      tasks: [
        { id: 'task_1', description: 'Do something', dependsOn: [], status: 'pending', reviewPassed: false },
      ],
    });

    registry.register({
      name: 'local-llm',
      call: async () => ({ text: planJson, toolUsage: [] }),
    });

    const result = (await env.run(plannerActivity, {
      prompt: 'Test',
      model: 'test-model',
      provider: 'local-llm',
    })) as PlannerResponse;

    // Verify it used the local-llm provider (which returned our planJson)
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.planSummary).toBe('A plan');
  });

  it('parses plan with new intent-driven fields', async () => {
    const planJson = JSON.stringify({
      planSummary: 'Intent-driven plan',
      userIntent: 'User wants ETH price for investment',
      qualityGuidelines: 'Use real-time data',
      tasks: [
        {
          id: 'task_1',
          description: 'Fetch ETH price',
          purpose: 'Get market data',
          successCriteria: ['Data from reliable API', 'Includes USD price'],
          outputFormat: 'Markdown table',
          dependsOn: [],
          status: 'pending',
          reviewPassed: false,
        },
      ],
    });

    setupQueryMock(planJson);

    const result = (await env.run(plannerActivity, {
      prompt: 'Get ETH price',
      model: 'claude-opus-4-6',
    })) as PlannerResponse;

    expect(result.plan.userIntent).toBe('User wants ETH price for investment');
    expect(result.plan.qualityGuidelines).toBe('Use real-time data');
    expect(result.plan.tasks[0].purpose).toBe('Get market data');
    expect(result.plan.tasks[0].successCriteria).toEqual(['Data from reliable API', 'Includes USD price']);
    expect(result.plan.tasks[0].outputFormat).toBe('Markdown table');
  });

  it('strips markdown code fences before parsing', async () => {
    const planJson = JSON.stringify({
      planSummary: 'A plan',
      tasks: [
        { id: 'task_1', description: 'Do something', dependsOn: [], status: 'pending', reviewPassed: false },
      ],
    });

    setupQueryMock('```json\n' + planJson + '\n```');

    const result = (await env.run(plannerActivity, {
      prompt: 'Test',
      model: 'claude-opus-4-6',
    })) as PlannerResponse;

    expect(result.plan.tasks).toHaveLength(1);
  });

  it('handles legacy plan without new intent-driven fields', async () => {
    const legacyPlanJson = JSON.stringify({
      planSummary: 'Legacy plan',
      tasks: [
        { id: 'task_1', description: 'Old-style task', dependsOn: [], status: 'pending', reviewPassed: false },
      ],
    });

    setupQueryMock(legacyPlanJson);

    const result = (await env.run(plannerActivity, {
      prompt: 'Legacy request',
      model: 'claude-opus-4-6',
    })) as PlannerResponse;

    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.userIntent).toBeUndefined();
    expect(result.plan.qualityGuidelines).toBeUndefined();
    expect(result.plan.tasks[0].purpose).toBeUndefined();
    expect(result.plan.tasks[0].successCriteria).toBeUndefined();
    expect(result.plan.tasks[0].outputFormat).toBeUndefined();
  });
});
