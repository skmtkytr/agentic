import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { agenticWorkflow, statusQuery, cancelSignal } from '../../src/workflows/agenticWorkflow';
import type { Activities } from '../../src/activities/index';
import type { WorkflowInput } from '../../src/types/workflow';
import type { Task } from '../../src/types/task';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TASK_ID = randomUUID();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    description: 'Test task',
    dependsOn: [],
    status: 'pending',
    reviewPassed: false,
    ...overrides,
  };
}

const defaultMockActivities: Activities = {
  plannerActivity: async () => ({
    plan: {
      planSummary: 'Test plan',
      tasks: [makeTask()],
    },
  }),
  validatorActivity: async () => ({
    result: { valid: true, issues: [] },
  }),
  executorActivity: async (req) => ({
    taskId: req.task.id,
    result: 'Mock execution result',
  }),
  reviewerActivity: async (req) => ({
    taskId: req.task.id,
    passed: true,
    notes: 'Looks good',
  }),
  integratorActivity: async () => ({
    integratedResponse: 'Mock integrated response',
  }),
  integrationReviewerActivity: async () => ({
    passed: true,
    notes: 'Final review passed',
  }),
};

describe('agenticWorkflow', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 30_000);

  afterAll(async () => {
    await testEnv.teardown();
  });

  async function runWorkflow(
    activities: Activities,
    input: WorkflowInput = { prompt: 'Test prompt' },
  ) {
    // Use a unique task queue per invocation to avoid "multiple workers on same queue" errors
    const taskQueue = `test-agentic-${randomUUID()}`;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: path.resolve(__dirname, '../../src/workflows/agenticWorkflow.ts'),
      activities,
    });

    const workerRunPromise = worker.run();

    try {
      return await testEnv.client.workflow.execute(agenticWorkflow, {
        taskQueue,
        workflowId: `test-${randomUUID()}`,
        args: [input],
      });
    } finally {
      worker.shutdown();
      await workerRunPromise;
    }
  }

  it('runs the full happy-path pipeline', async () => {
    const result = await runWorkflow(defaultMockActivities);

    expect(result.finalResponse).toBe('Mock integrated response');
    expect(result.integrationReviewPassed).toBe(true);
    expect(result.integrationReviewNotes).toBe('Final review passed');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe('reviewed');
    expect(result.tasks[0].reviewPassed).toBe(true);
  }, 60_000);

  it('uses revised response from integration reviewer when provided', async () => {
    const activities: Activities = {
      ...defaultMockActivities,
      integrationReviewerActivity: async () => ({
        passed: true,
        notes: 'Minor improvements made',
        revisedResponse: 'Revised and improved response',
      }),
    };

    const result = await runWorkflow(activities);
    expect(result.finalResponse).toBe('Revised and improved response');
  }, 60_000);

  it('marks task as rejected when reviewer fails it', async () => {
    const activities: Activities = {
      ...defaultMockActivities,
      reviewerActivity: async (req) => ({
        taskId: req.task.id,
        passed: false,
        notes: 'Result was insufficient',
      }),
    };

    const result = await runWorkflow(activities);
    expect(result.tasks[0].status).toBe('rejected');
    expect(result.tasks[0].reviewPassed).toBe(false);
  }, 60_000);

  it('fails the workflow when plan validation returns invalid', async () => {
    const activities: Activities = {
      ...defaultMockActivities,
      validatorActivity: async () => ({
        result: {
          valid: false,
          issues: ['Circular dependency detected between task_1 and task_2'],
        },
      }),
    };

    // Temporal wraps workflow failures in WorkflowFailedError; the actual message is in .cause
    try {
      await runWorkflow(activities);
      fail('Expected workflow to throw');
    } catch (err: unknown) {
      const msg =
        (err as { cause?: { message?: string }; message?: string }).cause?.message ??
        (err as { message?: string }).message ??
        '';
      expect(msg).toMatch(/Plan validation failed/);
    }
  }, 60_000);

  it('executes independent tasks in parallel (multiple tasks, no deps)', async () => {
    const task1Id = randomUUID();
    const task2Id = randomUUID();
    const executedIds: string[] = [];

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Two parallel tasks',
          tasks: [
            makeTask({ id: task1Id, description: 'Task 1' }),
            makeTask({ id: task2Id, description: 'Task 2' }),
          ],
        },
      }),
      executorActivity: async (req) => {
        executedIds.push(req.task.id);
        return { taskId: req.task.id, result: `Result for ${req.task.description}` };
      },
    };

    const result = await runWorkflow(activities);
    expect(result.tasks).toHaveLength(2);
    expect(executedIds).toHaveLength(2);
    expect(executedIds).toContain(task1Id);
    expect(executedIds).toContain(task2Id);
  }, 60_000);

  it('executes dependent tasks in correct order (A → B → C)', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const idC = randomUUID();
    const executionOrder: string[] = [];

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Chain: A → B → C',
          tasks: [
            makeTask({ id: idA, description: 'Task A', dependsOn: [] }),
            makeTask({ id: idB, description: 'Task B', dependsOn: [idA] }),
            makeTask({ id: idC, description: 'Task C', dependsOn: [idB] }),
          ],
        },
      }),
      executorActivity: async (req) => {
        executionOrder.push(req.task.id);
        return { taskId: req.task.id, result: `Result of ${req.task.description}` };
      },
    };

    const result = await runWorkflow(activities);
    expect(result.tasks).toHaveLength(3);
    // A must execute before B, B before C
    expect(executionOrder.indexOf(idA)).toBeLessThan(executionOrder.indexOf(idB));
    expect(executionOrder.indexOf(idB)).toBeLessThan(executionOrder.indexOf(idC));
  }, 60_000);

  it('uses revisedPlan from validator when provided', async () => {
    const revisedTaskId = randomUUID();

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Original plan',
          tasks: [makeTask({ description: 'Original task' })],
        },
      }),
      validatorActivity: async () => ({
        result: {
          valid: true,
          issues: ['Added missing step'],
          revisedPlan: {
            planSummary: 'Revised plan',
            tasks: [
              makeTask({ id: revisedTaskId, description: 'Revised task' }),
            ],
          },
        },
      }),
      executorActivity: async (req) => ({
        taskId: req.task.id,
        result: 'executed',
      }),
    };

    const result = await runWorkflow(activities);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe(revisedTaskId);
    expect(result.tasks[0].description).toBe('Revised task');
  }, 60_000);

  it('passes allowedTools from input to executor activities', async () => {
    let receivedTools: string[] | undefined;

    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => {
        receivedTools = req.allowedTools;
        return { taskId: req.task.id, result: 'done' };
      },
    };

    await runWorkflow(activities, {
      prompt: 'Test with tools',
      allowedTools: ['WebFetch', 'Bash'],
    });

    expect(receivedTools).toEqual(['WebFetch', 'Bash']);
  }, 60_000);

  it('passes allowedTools from input to integrator activity', async () => {
    let receivedTools: string[] | undefined;

    const activities: Activities = {
      ...defaultMockActivities,
      integratorActivity: async (req) => {
        receivedTools = req.allowedTools;
        return { integratedResponse: 'integrated' };
      },
    };

    await runWorkflow(activities, {
      prompt: 'Test with tools',
      allowedTools: ['Read', 'Grep'],
    });

    expect(receivedTools).toEqual(['Read', 'Grep']);
  }, 60_000);

  it('passes executor toolUsage to reviewer', async () => {
    let reviewerReceivedToolUsage: unknown;

    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => ({
        taskId: req.task.id,
        result: 'ETH is $2,047',
        toolUsage: [
          { tool: 'WebFetch', input: 'https://api.example.com', output: '{"usd":2047}', timestamp: Date.now() },
        ],
      }),
      reviewerActivity: async (req) => {
        reviewerReceivedToolUsage = req.toolUsage;
        return { taskId: req.task.id, passed: true, notes: 'ok' };
      },
    };

    await runWorkflow(activities);
    expect(reviewerReceivedToolUsage).toBeDefined();
    expect(reviewerReceivedToolUsage).toHaveLength(1);
    expect((reviewerReceivedToolUsage as any)[0].tool).toBe('WebFetch');
  }, 60_000);

  it('passes aggregated tool evidence to integration reviewer', async () => {
    let integrationReviewerReceivedEvidence: unknown;

    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => ({
        taskId: req.task.id,
        result: 'result',
        toolUsage: [
          { tool: 'WebSearch', input: 'ETH price', output: 'search results', timestamp: Date.now() },
        ],
      }),
      integrationReviewerActivity: async (req) => {
        integrationReviewerReceivedEvidence = req.toolEvidence;
        return { passed: true, notes: 'ok' };
      },
    };

    await runWorkflow(activities);
    expect(integrationReviewerReceivedEvidence).toBeDefined();
    expect((integrationReviewerReceivedEvidence as any[]).length).toBeGreaterThan(0);
  }, 60_000);

  it('handles mixed pass/reject tasks correctly', async () => {
    const passId = randomUUID();
    const failId = randomUUID();

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Two tasks',
          tasks: [
            makeTask({ id: passId, description: 'Good task' }),
            makeTask({ id: failId, description: 'Bad task' }),
          ],
        },
      }),
      reviewerActivity: async (req) => ({
        taskId: req.task.id,
        passed: req.task.id === passId,
        notes: req.task.id === passId ? 'Good' : 'Bad',
      }),
    };

    const result = await runWorkflow(activities);
    const passedTask = result.tasks.find((t) => t.id === passId);
    const failedTask = result.tasks.find((t) => t.id === failId);

    expect(passedTask?.status).toBe('reviewed');
    expect(passedTask?.reviewPassed).toBe(true);
    expect(failedTask?.status).toBe('rejected');
    expect(failedTask?.reviewPassed).toBe(false);
  }, 60_000);

  it('can query workflow status during execution', async () => {
    const taskQueue = `test-agentic-${randomUUID()}`;

    const activities: Activities = {
      ...defaultMockActivities,
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: path.resolve(__dirname, '../../src/workflows/agenticWorkflow.ts'),
      activities,
    });

    const workerRunPromise = worker.run();

    try {
      const handle = await testEnv.client.workflow.start(agenticWorkflow, {
        taskQueue,
        workflowId: `test-status-${randomUUID()}`,
        args: [{ prompt: 'Test prompt' }],
      });

      // Wait for completion
      await handle.result();

      // Query after completion should return 'complete'
      const state = await handle.query(statusQuery);
      expect(state.phase).toBe('complete');
      expect(state.totalTasks).toBeGreaterThan(0);
      expect(state.events).toBeDefined();
      expect(state.events.length).toBeGreaterThan(0);
      expect(state.tasks).toBeDefined();
    } finally {
      worker.shutdown();
      await workerRunPromise;
    }
  }, 60_000);

  it('retries from planning when integration review fails and maxPipelineRetries > 0', async () => {
    let attempt = 0;

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => {
        attempt++;
        return {
          plan: {
            planSummary: `Plan attempt ${attempt}`,
            tasks: [makeTask({ id: randomUUID(), description: `Task attempt ${attempt}` })],
          },
        };
      },
      integrationReviewerActivity: async () => {
        // Fail first attempt, pass second
        if (attempt <= 1) {
          return { passed: false, notes: 'Quality insufficient, retry needed' };
        }
        return { passed: true, notes: 'Good on retry' };
      },
    };

    const result = await runWorkflow(activities, {
      prompt: 'Test retry',
      maxPipelineRetries: 2,
    });

    expect(attempt).toBe(2);
    expect(result.integrationReviewPassed).toBe(true);
    expect(result.pipelineAttempt).toBe(2);
  }, 120_000);

  it('returns failed result after exhausting maxPipelineRetries', async () => {
    const activities: Activities = {
      ...defaultMockActivities,
      integrationReviewerActivity: async () => ({
        passed: false,
        notes: 'Always fails',
      }),
    };

    const result = await runWorkflow(activities, {
      prompt: 'Test exhaust retries',
      maxPipelineRetries: 1,
    });

    // Should complete (not throw) but with failed review
    expect(result.integrationReviewPassed).toBe(false);
    expect(result.pipelineAttempt).toBe(2); // initial + 1 retry
  }, 120_000);

  it('does not retry when maxPipelineRetries is 0 (default)', async () => {
    let plannerCalls = 0;
    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => {
        plannerCalls++;
        return { plan: { planSummary: 'Plan', tasks: [makeTask({ id: randomUUID() })] } };
      },
      integrationReviewerActivity: async () => ({
        passed: false,
        notes: 'Failed',
      }),
    };

    const result = await runWorkflow(activities, { prompt: 'No retry' });

    expect(plannerCalls).toBe(1);
    expect(result.integrationReviewPassed).toBe(false);
    expect(result.pipelineAttempt).toBe(1);
  }, 60_000);

  it('passes previous failure notes to planner on retry', async () => {
    let plannerPrompts: string[] = [];

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async (req) => {
        plannerPrompts.push(req.prompt);
        return {
          plan: { planSummary: 'Plan', tasks: [makeTask({ id: randomUUID() })] },
        };
      },
      integrationReviewerActivity: async () => {
        if (plannerPrompts.length <= 1) return { passed: false, notes: 'Missing error handling' };
        return { passed: true, notes: 'Fixed' };
      },
    };

    await runWorkflow(activities, { prompt: 'Build API', maxPipelineRetries: 1 });

    expect(plannerPrompts).toHaveLength(2);
    // Second prompt should contain the failure feedback
    expect(plannerPrompts[1]).toContain('Missing error handling');
  }, 120_000);

  it('records activity events throughout the workflow', async () => {
    const taskQueue = `test-agentic-${randomUUID()}`;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: path.resolve(__dirname, '../../src/workflows/agenticWorkflow.ts'),
      activities: defaultMockActivities,
    });

    const workerRunPromise = worker.run();

    try {
      const handle = await testEnv.client.workflow.start(agenticWorkflow, {
        taskQueue,
        workflowId: `test-events-${randomUUID()}`,
        args: [{ prompt: 'Test prompt' }],
      });

      await handle.result();
      const state = await handle.query(statusQuery);

      // Should have events for each activity phase
      const kinds = state.events.map((e) => e.kind);
      expect(kinds).toContain('planner_start');
      expect(kinds).toContain('planner_done');
      expect(kinds).toContain('validator_start');
      expect(kinds).toContain('validator_done');
      expect(kinds).toContain('executor_start');
      expect(kinds).toContain('executor_done');
      expect(kinds).toContain('reviewer_start');
      expect(kinds).toContain('reviewer_done');
      expect(kinds).toContain('integrator_start');
      expect(kinds).toContain('integrator_done');
      expect(kinds).toContain('integration_reviewer_start');
      expect(kinds).toContain('integration_reviewer_done');
    } finally {
      worker.shutdown();
      await workerRunPromise;
    }
  }, 60_000);
});
