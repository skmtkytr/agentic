import { MockActivityEnvironment } from '@temporalio/testing';
import type { PlannerResponse } from '../../src/types/agents';

jest.mock('../../src/llm/parseWithRetry', () => ({
  callStructured: jest.fn(),
}));

import { callStructured } from '../../src/llm/parseWithRetry';
import { plannerActivity } from '../../src/activities/plannerActivity';

const mockCallStructured = callStructured as jest.MockedFunction<typeof callStructured>;

describe('plannerActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockCallStructured.mockReset());

  // --- callStructured argument verification ---

  it('calls callStructured with correct provider, model, and prompt', async () => {
    mockCallStructured.mockResolvedValue({
      planSummary: 'Plan',
      tasks: [{ id: 'task_1', description: 'Do something', dependsOn: [], status: 'pending', reviewPassed: false }],
    });

    await env.run(plannerActivity, {
      prompt: 'Build a calculator',
      model: 'claude-sonnet-4-6',
      provider: 'local-llm',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.provider).toBe('local-llm');
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.userContent).toBe('Build a calculator');
  });

  it('system prompt contains intent analysis and task design instructions', async () => {
    mockCallStructured.mockResolvedValue({
      planSummary: 'Plan',
      tasks: [{ id: 'task_1', description: 'task', dependsOn: [], status: 'pending', reviewPassed: false }],
    });

    await env.run(plannerActivity, {
      prompt: 'Test',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.system).toContain('ステップ1');
    expect(opts.system).toContain('userIntent');
    expect(opts.system).toContain('qualityGuidelines');
    // Planner no longer generates purpose/successCriteria/outputFormat (TaskDesigner handles that)
    expect(opts.system).not.toContain('successCriteria');
    expect(opts.system).toContain('設計エージェント'); // references task designer
  });

  // --- UUID remapping ---

  it('remaps LLM-generated IDs to UUIDs', async () => {
    mockCallStructured.mockResolvedValue({
      planSummary: 'Plan',
      tasks: [
        { id: 'task_1', description: 'Write function', dependsOn: [], status: 'pending', reviewPassed: false },
        { id: 'task_2', description: 'Write tests', dependsOn: ['task_1'], status: 'pending', reviewPassed: false },
      ],
    });

    const result = (await env.run(plannerActivity, {
      prompt: 'Create utility',
      model: 'test',
    })) as PlannerResponse;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(result.plan.tasks).toHaveLength(2);
    for (const task of result.plan.tasks) {
      expect(task.id).toMatch(uuidRegex);
    }
    // Second task depends on first task's UUID
    expect(result.plan.tasks[1].dependsOn).toContain(result.plan.tasks[0].id);
  });

  it('preserves dependsOn IDs that are not in the plan (fallback)', async () => {
    mockCallStructured.mockResolvedValue({
      planSummary: 'Plan',
      tasks: [
        { id: 'task_1', description: 'task', dependsOn: ['external_id'], status: 'pending', reviewPassed: false },
      ],
    });

    const result = (await env.run(plannerActivity, {
      prompt: 'Test',
      model: 'test',
    })) as PlannerResponse;

    expect(result.plan.tasks[0].dependsOn).toContain('external_id');
  });

  // --- Intent analysis fields ---

  it('passes through userIntent and qualityGuidelines from LLM output', async () => {
    mockCallStructured.mockResolvedValue({
      planSummary: 'Intent-driven plan',
      userIntent: 'User wants ETH price for investment',
      qualityGuidelines: 'Use real-time data',
      tasks: [{
        id: 'task_1',
        description: 'Fetch ETH price',
        dependsOn: [],
        status: 'pending',
        reviewPassed: false,
      }],
    });

    const result = (await env.run(plannerActivity, {
      prompt: 'Get ETH price',
      model: 'test',
    })) as PlannerResponse;

    expect(result.plan.userIntent).toBe('User wants ETH price for investment');
    expect(result.plan.qualityGuidelines).toBe('Use real-time data');
  });

  it('handles plan without userIntent/qualityGuidelines (backward compat)', async () => {
    mockCallStructured.mockResolvedValue({
      planSummary: 'Simple plan',
      tasks: [
        { id: 'task_1', description: 'A task', dependsOn: [], status: 'pending', reviewPassed: false },
      ],
    });

    const result = (await env.run(plannerActivity, {
      prompt: 'Simple request',
      model: 'test',
    })) as PlannerResponse;

    expect(result.plan.tasks).toHaveLength(1);
    expect(result.plan.userIntent).toBeUndefined();
    expect(result.plan.qualityGuidelines).toBeUndefined();
  });

  it('remaps multi-dependency IDs correctly (task_3 depends on task_1 and task_2)', async () => {
    mockCallStructured.mockResolvedValue({
      planSummary: 'Diamond',
      tasks: [
        { id: 'task_1', description: 'A', dependsOn: [], status: 'pending', reviewPassed: false },
        { id: 'task_2', description: 'B', dependsOn: [], status: 'pending', reviewPassed: false },
        { id: 'task_3', description: 'C', dependsOn: ['task_1', 'task_2'], status: 'pending', reviewPassed: false },
      ],
    });

    const result = (await env.run(plannerActivity, {
      prompt: 'Test',
      model: 'test',
    })) as PlannerResponse;

    const [t1, t2, t3] = result.plan.tasks;
    expect(t3.dependsOn).toHaveLength(2);
    expect(t3.dependsOn).toContain(t1.id);
    expect(t3.dependsOn).toContain(t2.id);
    // All IDs are UUIDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const t of result.plan.tasks) {
      expect(t.id).toMatch(uuidRegex);
    }
  });
});
