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
    score: { completeness: 5, accuracy: 5, structure: 5, actionability: 4, overall: 5 },
    strengths: ['Good quality'],
    improvements: [],
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
    // No pipeline history on first-attempt success
    expect(result.pipelineHistory).toBeUndefined();
  }, 60_000);

  it('uses revised response from integration reviewer when provided', async () => {
    const activities: Activities = {
      ...defaultMockActivities,
      integrationReviewerActivity: async () => ({
        passed: true,
        notes: 'Minor improvements made',
        score: { completeness: 4, accuracy: 4, structure: 5, actionability: 4, overall: 4 },
        strengths: ['Improved'],
        improvements: [],
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

  it('threads workflowId to executor and resultFilePath to reviewer', async () => {
    let receivedWorkflowId: string | undefined;
    let reviewerReceivedFilePath: string | undefined;

    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => {
        receivedWorkflowId = req.workflowId;
        return {
          taskId: req.task.id,
          result: 'file result',
          resultFilePath: `/tmp/agentic/${req.workflowId}/${req.task.id}/result.md`,
        };
      },
      reviewerActivity: async (req) => {
        reviewerReceivedFilePath = req.resultFilePath;
        return { taskId: req.task.id, passed: true, notes: 'ok' };
      },
    };

    await runWorkflow(activities, {
      prompt: 'Test file paths',
      workflowId: 'test-wf-files',
    });

    expect(receivedWorkflowId).toBe('test-wf-files');
    expect(reviewerReceivedFilePath).toContain('test-wf-files');
    expect(reviewerReceivedFilePath).toContain('result.md');
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
        return { passed: true, notes: 'ok', score: { completeness: 4, accuracy: 4, structure: 4, actionability: 4, overall: 4 }, strengths: [], improvements: [] };
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
          return { passed: false, notes: 'Quality insufficient, retry needed', score: { completeness: 2, accuracy: 2, structure: 3, actionability: 2, overall: 2 }, strengths: [], improvements: ['Improve quality'] };
        }
        return { passed: true, notes: 'Good on retry', score: { completeness: 4, accuracy: 4, structure: 4, actionability: 4, overall: 4 }, strengths: ['Improved'], improvements: [] };
      },
    };

    const result = await runWorkflow(activities, {
      prompt: 'Test retry',
      maxPipelineRetries: 2,
    });

    expect(attempt).toBe(2);
    expect(result.integrationReviewPassed).toBe(true);
    expect(result.pipelineAttempt).toBe(2);

    // Pipeline history should contain the failed first attempt
    expect(result.pipelineHistory).toBeDefined();
    expect(result.pipelineHistory).toHaveLength(1);
    expect(result.pipelineHistory![0].attempt).toBe(1);
    expect(result.pipelineHistory![0].integrationReviewPassed).toBe(false);
    expect(result.pipelineHistory![0].integrationReviewNotes).toContain('Quality insufficient');
    expect(result.pipelineHistory![0].tasks).toHaveLength(1);
  }, 120_000);

  it('returns failed result after exhausting maxPipelineRetries', async () => {
    const activities: Activities = {
      ...defaultMockActivities,
      integrationReviewerActivity: async () => ({
        passed: false,
        notes: 'Always fails',
        score: { completeness: 1, accuracy: 1, structure: 1, actionability: 1, overall: 1 },
        strengths: [],
        improvements: ['Everything'],
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

  it('does not retry when maxPipelineRetries is explicitly 0', async () => {
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
        score: { completeness: 1, accuracy: 1, structure: 1, actionability: 1, overall: 1 },
        strengths: [],
        improvements: ['Everything'],
      }),
    };

    const result = await runWorkflow(activities, { prompt: 'No retry', maxPipelineRetries: 0 });

    expect(plannerCalls).toBe(1);
    expect(result.integrationReviewPassed).toBe(false);
    expect(result.pipelineAttempt).toBe(1);
  }, 60_000);

  it('retries rejected task within executor (task-level retry)', async () => {
    let execAttempts = 0;

    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => {
        execAttempts++;
        return { taskId: req.task.id, result: `attempt ${execAttempts}` };
      },
      reviewerActivity: async (req) => {
        // Reject first attempt, pass second
        if (execAttempts <= 1) {
          return { taskId: req.task.id, passed: false, notes: 'Not good enough' };
        }
        return { taskId: req.task.id, passed: true, notes: 'Good on retry' };
      },
    };

    const result = await runWorkflow(activities, {
      prompt: 'Test task retry',
      maxTaskRetries: 2,
    });

    expect(execAttempts).toBe(2);
    expect(result.tasks[0].reviewPassed).toBe(true);
    expect(result.tasks[0].result).toBe('attempt 2');
  }, 60_000);

  it('marks task as rejected after exhausting maxTaskRetries', async () => {
    const activities: Activities = {
      ...defaultMockActivities,
      reviewerActivity: async (req) => ({
        taskId: req.task.id,
        passed: false,
        notes: 'Always bad',
      }),
    };

    const result = await runWorkflow(activities, {
      prompt: 'Test exhaust task retries',
      maxTaskRetries: 1,
    });

    // 2 attempts (initial + 1 retry), still rejected
    expect(result.tasks[0].reviewPassed).toBe(false);
    expect(result.tasks[0].status).toBe('rejected');
  }, 60_000);

  it('does not retry tasks when maxTaskRetries is explicitly 0', async () => {
    let execCalls = 0;
    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => {
        execCalls++;
        return { taskId: req.task.id, result: 'done' };
      },
      reviewerActivity: async (req) => ({
        taskId: req.task.id,
        passed: false,
        notes: 'bad',
      }),
    };

    const result = await runWorkflow(activities, { prompt: 'No task retry', maxTaskRetries: 0 });
    expect(execCalls).toBe(1);
    expect(result.tasks[0].status).toBe('rejected');
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
        if (plannerPrompts.length <= 1) return { passed: false, notes: 'Missing error handling', score: { completeness: 2, accuracy: 3, structure: 3, actionability: 2, overall: 2 }, strengths: [], improvements: ['Add error handling'] };
        return { passed: true, notes: 'Fixed', score: { completeness: 4, accuracy: 4, structure: 4, actionability: 4, overall: 4 }, strengths: ['Fixed'], improvements: [] };
      },
    };

    await runWorkflow(activities, { prompt: 'Build API', maxPipelineRetries: 1 });

    expect(plannerPrompts).toHaveLength(2);
    // Second prompt should contain the failure feedback
    expect(plannerPrompts[1]).toContain('Missing error handling');
  }, 120_000);

  it('passes agentConfig provider and model to each activity', async () => {
    const received: Record<string, { model: string; provider?: string }> = {};

    const activities: Activities = {
      plannerActivity: async (req) => {
        received.planner = { model: req.model, provider: req.provider };
        return { plan: { planSummary: 'Plan', tasks: [makeTask({ id: randomUUID() })] } };
      },
      validatorActivity: async (req) => {
        received.validator = { model: req.model, provider: req.provider };
        return { result: { valid: true, issues: [] } };
      },
      executorActivity: async (req) => {
        received.executor = { model: req.model, provider: req.provider };
        return { taskId: req.task.id, result: 'done' };
      },
      reviewerActivity: async (req) => {
        received.reviewer = { model: req.model, provider: req.provider };
        return { taskId: req.task.id, passed: true, notes: 'ok' };
      },
      integratorActivity: async (req) => {
        received.integrator = { model: req.model, provider: req.provider };
        return { integratedResponse: 'integrated' };
      },
      integrationReviewerActivity: async (req) => {
        received.integrationReviewer = { model: req.model, provider: req.provider };
        return { passed: true, notes: 'ok', score: { completeness: 5, accuracy: 5, structure: 5, actionability: 5, overall: 5 }, strengths: [], improvements: [] };
      },
    };

    await runWorkflow(activities, {
      prompt: 'Test agentConfig',
      model: 'default-model',
      provider: 'default-provider',
      agentConfig: {
        planner: { provider: 'local-llm', model: 'qwen3-32b' },
        executor: { provider: 'claude-agent', model: 'claude-sonnet-4-6' },
        reviewer: { provider: 'local-llm' },
      },
    });

    // Planner: overridden by agentConfig
    expect(received.planner.provider).toBe('local-llm');
    expect(received.planner.model).toBe('qwen3-32b');

    // Validator: falls back to defaults
    expect(received.validator.provider).toBe('default-provider');
    expect(received.validator.model).toBe('default-model');

    // Executor: overridden
    expect(received.executor.provider).toBe('claude-agent');
    expect(received.executor.model).toBe('claude-sonnet-4-6');

    // Reviewer: provider overridden, model falls back to default
    expect(received.reviewer.provider).toBe('local-llm');
    expect(received.reviewer.model).toBe('default-model');

    // Integrator: falls back to defaults
    expect(received.integrator.provider).toBe('default-provider');
    expect(received.integrator.model).toBe('default-model');

    // IntegrationReviewer: falls back to defaults
    expect(received.integrationReviewer.provider).toBe('default-provider');
    expect(received.integrationReviewer.model).toBe('default-model');
  }, 60_000);

  it('uses default model when no agentConfig or model specified', async () => {
    let plannerModel: string | undefined;

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async (req) => {
        plannerModel = req.model;
        return { plan: { planSummary: 'Plan', tasks: [makeTask({ id: randomUUID() })] } };
      },
    };

    await runWorkflow(activities, { prompt: 'No config' });

    expect(plannerModel).toBe('claude-opus-4-6');
  }, 60_000);

  it('passes planContext from planner to executor, integrator, and integrationReviewer', async () => {
    const received: Record<string, any> = {};

    const activities: Activities = {
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Plan with context',
          userIntent: 'User wants real-time ETH data',
          qualityGuidelines: 'Must use reliable API sources',
          tasks: [makeTask({
            id: randomUUID(),
            description: 'Fetch ETH price',
            purpose: 'Get market data',
            successCriteria: ['From CoinGecko', 'USD and JPY'],
          })],
        },
      }),
      validatorActivity: async () => ({ result: { valid: true, issues: [] } }),
      executorActivity: async (req) => {
        received.executor = { planContext: req.planContext, purpose: req.task.purpose, successCriteria: req.task.successCriteria };
        return { taskId: req.task.id, result: 'ETH = $2000' };
      },
      reviewerActivity: async (req) => {
        received.reviewer = { successCriteria: req.task.successCriteria };
        return { taskId: req.task.id, passed: true, notes: 'ok' };
      },
      integratorActivity: async (req) => {
        received.integrator = { planContext: req.planContext };
        return { integratedResponse: 'integrated' };
      },
      integrationReviewerActivity: async (req) => {
        received.integrationReviewer = { planContext: req.planContext };
        return { passed: true, notes: 'ok', score: { completeness: 5, accuracy: 5, structure: 5, actionability: 5, overall: 5 }, strengths: [], improvements: [] };
      },
    };

    await runWorkflow(activities, { prompt: 'Get ETH price' });

    // Executor receives planContext and task-level fields
    expect(received.executor.planContext?.userIntent).toBe('User wants real-time ETH data');
    expect(received.executor.planContext?.qualityGuidelines).toBe('Must use reliable API sources');
    expect(received.executor.purpose).toBe('Get market data');
    expect(received.executor.successCriteria).toEqual(['From CoinGecko', 'USD and JPY']);

    // Reviewer receives task-level successCriteria
    expect(received.reviewer.successCriteria).toEqual(['From CoinGecko', 'USD and JPY']);

    // Integrator receives planContext
    expect(received.integrator.planContext?.userIntent).toBe('User wants real-time ETH data');

    // IntegrationReviewer receives planContext
    expect(received.integrationReviewer.planContext?.qualityGuidelines).toBe('Must use reliable API sources');
  }, 60_000);

  it('works without planContext fields (backward compat)', async () => {
    // defaultMockActivities returns plan without userIntent/qualityGuidelines
    const result = await runWorkflow(defaultMockActivities);
    expect(result.integrationReviewPassed).toBe(true);
  }, 60_000);

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

  // --- DAG deadlock detection ---

  it('throws PlanCircularDependencyError on circular dependency in DAG', async () => {
    const idA = randomUUID();
    const idB = randomUUID();

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Circular plan',
          tasks: [
            makeTask({ id: idA, description: 'Task A', dependsOn: [idB] }),
            makeTask({ id: idB, description: 'Task B', dependsOn: [idA] }),
          ],
        },
      }),
      validatorActivity: async () => ({ result: { valid: true, issues: [] } }),
    };

    try {
      await runWorkflow(activities);
      fail('Expected workflow to throw');
    } catch (err: unknown) {
      const msg =
        (err as { cause?: { message?: string }; message?: string }).cause?.message ??
        (err as { message?: string }).message ??
        '';
      expect(msg).toMatch(/DAG execution deadlock/);
    }
  }, 60_000);

  it('throws on self-referencing task dependency', async () => {
    const idSelf = randomUUID();

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Self-referencing',
          tasks: [
            makeTask({ id: idSelf, description: 'Self-ref', dependsOn: [idSelf] }),
          ],
        },
      }),
      validatorActivity: async () => ({ result: { valid: true, issues: [] } }),
    };

    try {
      await runWorkflow(activities);
      fail('Expected workflow to throw');
    } catch (err: unknown) {
      const msg =
        (err as { cause?: { message?: string }; message?: string }).cause?.message ??
        (err as { message?: string }).message ??
        '';
      expect(msg).toMatch(/DAG execution deadlock/);
    }
  }, 60_000);

  // --- maxParallelTasks ---

  it('limits concurrent task execution to maxParallelTasks', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const ids = Array.from({ length: 4 }, () => randomUUID());

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Parallel test',
          tasks: ids.map((id, i) => makeTask({ id, description: `Task ${i + 1}` })),
        },
      }),
      executorActivity: async (req) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Simulate some async work
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return { taskId: req.task.id, result: 'done' };
      },
    };

    const result = await runWorkflow(activities, {
      prompt: 'Test parallel limits',
      maxParallelTasks: 2,
    });

    expect(result.tasks).toHaveLength(4);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  }, 60_000);

  // --- Cancel signal ---

  it('cancels workflow after planning phase via signal', async () => {
    const taskQueue = `test-agentic-${randomUUID()}`;

    // Use a slow executor to give time for signal
    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => {
        await new Promise((r) => setTimeout(r, 5000));
        return { taskId: req.task.id, result: 'should not reach' };
      },
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
        workflowId: `test-cancel-${randomUUID()}`,
        args: [{ prompt: 'Cancel test' }],
      });

      // Small delay then cancel
      await new Promise((r) => setTimeout(r, 100));
      await handle.signal(cancelSignal);

      try {
        await handle.result();
        fail('Expected workflow to throw on cancel');
      } catch (err: unknown) {
        const msg =
          (err as { cause?: { message?: string }; message?: string }).cause?.message ??
          (err as { message?: string }).message ??
          '';
        expect(msg).toMatch(/Cancelled by signal/);
      }
    } finally {
      worker.shutdown();
      await workerRunPromise;
    }
  }, 60_000);

  // --- Diamond dependency DAG ---

  it('executes diamond dependency (A→B,C→D) in correct order', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    const idC = randomUUID();
    const idD = randomUUID();
    const executionOrder: string[] = [];

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'Diamond: A→B,C→D',
          tasks: [
            makeTask({ id: idA, description: 'Task A', dependsOn: [] }),
            makeTask({ id: idB, description: 'Task B', dependsOn: [idA] }),
            makeTask({ id: idC, description: 'Task C', dependsOn: [idA] }),
            makeTask({ id: idD, description: 'Task D', dependsOn: [idB, idC] }),
          ],
        },
      }),
      executorActivity: async (req) => {
        executionOrder.push(req.task.id);
        return { taskId: req.task.id, result: `Result of ${req.task.description}` };
      },
    };

    const result = await runWorkflow(activities);
    expect(result.tasks).toHaveLength(4);

    // A must be first
    expect(executionOrder[0]).toBe(idA);
    // B and C can be in any order but both before D
    expect(executionOrder.indexOf(idB)).toBeLessThan(executionOrder.indexOf(idD));
    expect(executionOrder.indexOf(idC)).toBeLessThan(executionOrder.indexOf(idD));
    // D must be last
    expect(executionOrder[3]).toBe(idD);
  }, 60_000);

  // --- Integration: completedTaskResults context passing ---

  it('passes prior task result as completedTaskResults to dependent executor', async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    let bReceivedContext: Array<{ taskId: string; description: string; result: string }> = [];

    const activities: Activities = {
      ...defaultMockActivities,
      plannerActivity: async () => ({
        plan: {
          planSummary: 'A then B',
          tasks: [
            makeTask({ id: idA, description: 'Task A' }),
            makeTask({ id: idB, description: 'Task B', dependsOn: [idA] }),
          ],
        },
      }),
      executorActivity: async (req) => {
        if (req.task.id === idB) {
          bReceivedContext = req.completedTaskResults;
        }
        return { taskId: req.task.id, result: `Result of ${req.task.description}` };
      },
    };

    await runWorkflow(activities);

    expect(bReceivedContext).toHaveLength(1);
    expect(bReceivedContext[0].taskId).toBe(idA);
    expect(bReceivedContext[0].result).toBe('Result of Task A');
  }, 60_000);

  // --- Integration: retry description modification ---

  it('appends reviewer feedback to task description on retry', async () => {
    let execAttempts = 0;
    let retryDescription = '';

    const activities: Activities = {
      ...defaultMockActivities,
      executorActivity: async (req) => {
        execAttempts++;
        if (execAttempts === 2) {
          retryDescription = req.task.description;
        }
        return { taskId: req.task.id, result: `attempt ${execAttempts}` };
      },
      reviewerActivity: async (req) => {
        if (execAttempts <= 1) {
          return { taskId: req.task.id, passed: false, notes: 'データソースが不正確です' };
        }
        return { taskId: req.task.id, passed: true, notes: 'Fixed' };
      },
    };

    await runWorkflow(activities, { prompt: 'Test retry desc', maxTaskRetries: 1 });

    expect(execAttempts).toBe(2);
    expect(retryDescription).toContain('データソースが不正確です');
    expect(retryDescription).toContain('前回の実行がレビューで却下されました');
  }, 60_000);
});
