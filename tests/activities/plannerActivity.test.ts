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
});
