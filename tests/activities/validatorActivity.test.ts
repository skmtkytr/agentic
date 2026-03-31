import { MockActivityEnvironment } from '@temporalio/testing';
import type { ValidatorResponse } from '../../src/types/agents';

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

import { validatorActivity } from '../../src/activities/validatorActivity';

const basePlan = {
  planSummary: 'Test plan',
  tasks: [
    { id: 't1', description: 'Task 1', dependsOn: [] as string[], status: 'pending' as const, reviewPassed: false },
  ],
};

describe('validatorActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockQuery.mockReset());

  it('returns valid result when plan is correct', async () => {
    setupQueryMock(JSON.stringify({ valid: true, issues: [] }));

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'claude-opus-4-6',
    })) as ValidatorResponse;

    expect(result.result.valid).toBe(true);
    expect(result.result.issues).toEqual([]);
  });

  it('returns invalid result with issues', async () => {
    setupQueryMock(
      JSON.stringify({
        valid: false,
        issues: ['Circular dependency between t1 and t2'],
      }),
    );

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'claude-opus-4-6',
    })) as ValidatorResponse;

    expect(result.result.valid).toBe(false);
    expect(result.result.issues).toHaveLength(1);
    expect(result.result.issues[0]).toMatch(/Circular dependency/);
  });

  it('returns revised plan when validator corrects issues', async () => {
    const revisedPlan = {
      planSummary: 'Revised plan',
      tasks: [
        { id: 't1', description: 'Fixed task', dependsOn: [], status: 'pending', reviewPassed: false },
        { id: 't2', description: 'New task', dependsOn: ['t1'], status: 'pending', reviewPassed: false },
      ],
    };

    setupQueryMock(
      JSON.stringify({
        valid: true,
        issues: ['Added missing step'],
        revisedPlan,
      }),
    );

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'claude-opus-4-6',
    })) as ValidatorResponse;

    expect(result.result.valid).toBe(true);
    expect(result.result.revisedPlan).toBeDefined();
    expect(result.result.revisedPlan!.tasks).toHaveLength(2);
  });

  it('defaults issues to empty array when not provided', async () => {
    setupQueryMock(JSON.stringify({ valid: true }));

    const result = (await env.run(validatorActivity, {
      plan: basePlan,
      model: 'claude-opus-4-6',
    })) as ValidatorResponse;

    expect(result.result.issues).toEqual([]);
  });

  it('throws on invalid JSON', async () => {
    setupQueryMock('This is not valid JSON');

    await expect(
      env.run(validatorActivity, { plan: basePlan, model: 'claude-opus-4-6' }),
    ).rejects.toThrow(/JSON parse failed/);
  });
});
