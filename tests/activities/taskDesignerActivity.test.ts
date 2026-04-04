import { MockActivityEnvironment } from '@temporalio/testing';
import type { TaskDesignerResponse } from '../../src/types/agents';

jest.mock('../../src/llm/parseWithRetry', () => ({
  callStructured: jest.fn(),
}));

import { callStructured } from '../../src/llm/parseWithRetry';
import { taskDesignerActivity } from '../../src/activities/taskDesignerActivity';

const mockCallStructured = callStructured as jest.MockedFunction<typeof callStructured>;

const basePlan = {
  planSummary: 'Test plan',
  tasks: [
    { id: 't1', description: 'Task 1', dependsOn: [] as string[], status: 'pending' as const, reviewPassed: false },
  ],
};

describe('taskDesignerActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockCallStructured.mockReset());

  // --- callStructured argument verification ---

  it('calls callStructured with correct provider, model, and plan + originalPrompt in userContent', async () => {
    mockCallStructured.mockResolvedValue({ valid: true, issues: [] });

    await env.run(taskDesignerActivity, {
      plan: basePlan,
      originalPrompt: 'Get ETH price',
      model: 'claude-sonnet-4-6',
      provider: 'local-llm',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.provider).toBe('local-llm');
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.userContent).toContain('Task 1');
    expect(opts.userContent).toContain('Test plan');
    expect(opts.userContent).toContain('Get ETH price');
  });

  it('system prompt contains validation and design instructions', async () => {
    mockCallStructured.mockResolvedValue({ valid: true, issues: [] });

    await env.run(taskDesignerActivity, {
      plan: basePlan,
      originalPrompt: 'Test',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.system).toContain('タスク設計エージェント');
    expect(opts.system).toContain('循環依存');
    expect(opts.system).toContain('purpose');
    expect(opts.system).toContain('successCriteria');
    expect(opts.system).toContain('outputFormat');
  });

  // --- Result handling ---

  it('returns valid result', async () => {
    mockCallStructured.mockResolvedValue({ valid: true, issues: [] });

    const result = (await env.run(taskDesignerActivity, {
      plan: basePlan,
      originalPrompt: 'Test',
      model: 'test',
    })) as TaskDesignerResponse;

    expect(result.result.valid).toBe(true);
    expect(result.result.issues).toEqual([]);
  });

  it('returns invalid result with issues', async () => {
    mockCallStructured.mockResolvedValue({
      valid: false,
      issues: ['Circular dependency between t1 and t2'],
    });

    const result = (await env.run(taskDesignerActivity, {
      plan: basePlan,
      originalPrompt: 'Test',
      model: 'test',
    })) as TaskDesignerResponse;

    expect(result.result.valid).toBe(false);
    expect(result.result.issues[0]).toMatch(/Circular dependency/);
  });

  it('returns designedPlan with purpose and successCriteria', async () => {
    const designedPlan = {
      planSummary: 'Designed plan',
      tasks: [
        {
          id: 't1', description: 'Fetch ETH price', dependsOn: [],
          status: 'pending' as const, reviewPassed: false,
          purpose: 'Get current market data',
          successCriteria: ['Data from CoinGecko API', 'Includes USD and JPY'],
          outputFormat: 'Markdown table',
        },
      ],
    };

    mockCallStructured.mockResolvedValue({
      valid: true,
      issues: [],
      designedPlan,
    });

    const result = (await env.run(taskDesignerActivity, {
      plan: basePlan,
      originalPrompt: 'Test',
      model: 'test',
    })) as TaskDesignerResponse;

    expect(result.result.designedPlan).toBeDefined();
    expect(result.result.designedPlan!.tasks[0].purpose).toBe('Get current market data');
    expect(result.result.designedPlan!.tasks[0].successCriteria).toEqual(['Data from CoinGecko API', 'Includes USD and JPY']);
    expect(result.result.designedPlan!.tasks[0].outputFormat).toBe('Markdown table');
  });
});
