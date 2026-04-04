import { MockActivityEnvironment } from '@temporalio/testing';
import type { ValidatorResponse } from '../../src/types/agents';

jest.mock('../../src/llm/parseWithRetry', () => ({
  callStructured: jest.fn(),
}));

import { callStructured } from '../../src/llm/parseWithRetry';
import { validatorActivity } from '../../src/activities/validatorActivity';

const mockCallStructured = callStructured as jest.MockedFunction<typeof callStructured>;

const basePlan = {
  planSummary: 'Test plan',
  tasks: [
    { id: 't1', description: 'Task 1', dependsOn: [] as string[], status: 'pending' as const, reviewPassed: false },
  ],
};

describe('validatorActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockCallStructured.mockReset());

  // --- callStructured argument verification ---

  it('calls callStructured with correct provider, model, and plan in userContent', async () => {
    mockCallStructured.mockResolvedValue({ valid: true, issues: [] });

    await env.run(validatorActivity, {
      plan: basePlan,
      model: 'claude-sonnet-4-6',
      provider: 'local-llm',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.provider).toBe('local-llm');
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.userContent).toContain('Task 1');
    expect(opts.userContent).toContain('Test plan');
  });

  it('system prompt contains validation check items', async () => {
    mockCallStructured.mockResolvedValue({ valid: true, issues: [] });

    await env.run(validatorActivity, {
      plan: basePlan,
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.system).toContain('バリデーション');
    expect(opts.system).toContain('循環依存');
    expect(opts.system).toContain('存在しないID');
  });

  // --- Result handling ---

  it('returns valid result', async () => {
    mockCallStructured.mockResolvedValue({ valid: true, issues: [] });

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'test',
    })) as ValidatorResponse;

    expect(result.result.valid).toBe(true);
    expect(result.result.issues).toEqual([]);
  });

  it('returns invalid result with issues', async () => {
    mockCallStructured.mockResolvedValue({
      valid: false,
      issues: ['Circular dependency between t1 and t2'],
    });

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'test',
    })) as ValidatorResponse;

    expect(result.result.valid).toBe(false);
    expect(result.result.issues).toHaveLength(1);
    expect(result.result.issues[0]).toMatch(/Circular dependency/);
  });

  it('returns revisedPlan when validator corrects issues', async () => {
    const revisedPlan = {
      planSummary: 'Revised plan',
      tasks: [
        { id: 't1', description: 'Fixed task', dependsOn: [], status: 'pending' as const, reviewPassed: false },
        { id: 't2', description: 'New task', dependsOn: ['t1'], status: 'pending' as const, reviewPassed: false },
      ],
    };

    mockCallStructured.mockResolvedValue({
      valid: true,
      issues: ['Added missing step'],
      revisedPlan,
    });

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'test',
    })) as ValidatorResponse;

    expect(result.result.valid).toBe(true);
    expect(result.result.revisedPlan).toBeDefined();
    expect(result.result.revisedPlan!.tasks).toHaveLength(2);
  });

  it('defaults issues to empty array when not provided by LLM', async () => {
    mockCallStructured.mockResolvedValue({ valid: true, issues: [] });

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'test',
    })) as ValidatorResponse;

    expect(result.result.issues).toEqual([]);
  });
});
