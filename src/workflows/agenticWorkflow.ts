import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  log,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { Activities } from '../activities/index';
import type { Task } from '../types/task';
import type { ToolEvidenceEntry, ToolUsageRecord } from '../types/agents';
import type { ActivityEvent, ActivityEventKind, WorkflowInput, WorkflowOutput, WorkflowState } from '../types/workflow';

// --- Activity proxies with distinct retry policies ---

const { plannerActivity, validatorActivity } = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['AnthropicAuthError'],
  },
});

const { executorActivity } = proxyActivities<Activities>({
  startToCloseTimeout: '3 minutes',
  retry: {
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['AnthropicAuthError'],
  },
});

const { reviewerActivity, integratorActivity, integrationReviewerActivity } =
  proxyActivities<Activities>({
    startToCloseTimeout: '3 minutes',
    retry: {
      initialInterval: '5 seconds',
      backoffCoefficient: 2,
      maximumInterval: '60 seconds',
      maximumAttempts: 5,
      nonRetryableErrorTypes: ['AnthropicAuthError'],
    },
  });

// --- Signals and Queries ---

export const statusQuery = defineQuery<WorkflowState>('status');
export const cancelSignal = defineSignal('cancel');

// --- DAG execution helper ---

async function executeDag(
  tasks: Task[],
  completedResults: Map<string, string>,
  allToolEvidence: ToolEvidenceEntry[],
  state: WorkflowState,
  originalPrompt: string,
  model: string,
  maxParallelTasks: number,
  emit: (kind: ActivityEventKind, summary: string, taskId?: string, taskDescription?: string) => void,
  allowedTools?: string[],
): Promise<void> {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set<string>();

  while (done.size < tasks.length) {
    // Find all tasks whose dependencies are satisfied and not yet started
    const ready = tasks
      .filter((t) => !done.has(t.id) && t.dependsOn.every((dep) => done.has(dep)))
      .slice(0, maxParallelTasks);

    if (ready.length === 0) {
      // Should have been caught by validator — guard against infinite loop
      throw ApplicationFailure.create({
        message: 'DAG execution deadlock: no tasks are ready but work remains',
        type: 'PlanCircularDependencyError',
        nonRetryable: true,
      });
    }

    state.currentlyExecuting = ready.map((t) => t.id);

    await Promise.all(
      ready.map(async (task) => {
        task.status = 'executing';
        emit('executor_start', `実行開始: ${task.description}`, task.id, task.description);

        const context = [...completedResults.entries()].map(([taskId, result]) => ({
          taskId,
          description: taskMap.get(taskId)!.description,
          result,
        }));

        const execResult = await executorActivity({
          task,
          completedTaskResults: context,
          originalPrompt,
          model,
          allowedTools,
        });

        task.result = execResult.result;
        task.status = 'executed';
        const taskToolUsage = execResult.toolUsage ?? [];
        if (taskToolUsage.length > 0) {
          emit('executor_done', `実行完了: ${task.description} (ツール${taskToolUsage.length}件使用)`, task.id, task.description);
          for (const tu of taskToolUsage) {
            allToolEvidence.push({
              taskDescription: task.description,
              tool: tu.tool,
              input: tu.input,
              output: tu.output,
            });
          }
        } else {
          emit('executor_done', `実行完了: ${task.description}`, task.id, task.description);
        }

        emit('reviewer_start', `レビュー開始: ${task.description}`, task.id, task.description);
        const review = await reviewerActivity({
          task,
          result: execResult.result,
          originalPrompt,
          model,
          toolUsage: taskToolUsage,
        });

        task.reviewPassed = review.passed;
        task.reviewNotes = review.notes;
        if (review.revisedResult) {
          task.result = review.revisedResult;
        }
        task.status = review.passed ? 'reviewed' : 'rejected';
        emit(
          'reviewer_done',
          `レビュー${review.passed ? '通過' : '却下'}: ${task.description}${review.notes ? ` — ${review.notes.slice(0, 80)}` : ''}`,
          task.id,
          task.description,
        );

        completedResults.set(task.id, task.result!);
        done.add(task.id);
        state.completedTasks = done.size;
      }),
    );

    state.currentlyExecuting = [];
  }
}

// --- Main Workflow ---

export async function agenticWorkflow(input: WorkflowInput): Promise<WorkflowOutput> {
  const startTime = Date.now();
  const model = input.model ?? 'claude-opus-4-6';
  const maxParallelTasks = input.maxParallelTasks ?? 5;

  let cancelled = false;
  const events: ActivityEvent[] = [];
  const tasks: Task[] = [];

  function emit(kind: ActivityEventKind, summary: string, taskId?: string, taskDescription?: string) {
    events.push({ kind, timestamp: Date.now(), summary, taskId, taskDescription });
  }

  const state: WorkflowState = {
    phase: 'planning',
    totalTasks: 0,
    completedTasks: 0,
    currentlyExecuting: [],
    events,
    tasks,
  };

  setHandler(statusQuery, () => ({
    ...state,
    events: [...events],
    tasks: tasks.map((t) => ({ ...t })),
  }));
  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  // Phase 1: Plan
  state.phase = 'planning';
  emit('planner_start', 'プランニング開始');
  log.info('Starting planning phase', { promptPreview: input.prompt.slice(0, 100) });

  const { plan } = await plannerActivity({ prompt: input.prompt, model });
  emit('planner_done', `プラン生成完了: ${plan.tasks.length}タスク — ${plan.planSummary.slice(0, 100)}`);

  if (cancelled) {
    throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
  }

  // Phase 2: Validate
  state.phase = 'validating';
  emit('validator_start', 'プラン検証開始');
  log.info('Starting validation phase', { taskCount: plan.tasks.length });

  const { result: validation } = await validatorActivity({ plan, model });

  if (!validation.valid) {
    emit('validator_done', `検証失敗: ${validation.issues.join('; ')}`);
    throw ApplicationFailure.create({
      message: `Plan validation failed: ${validation.issues.join('; ')}`,
      type: 'ValidationFatalError',
      nonRetryable: true,
    });
  }

  emit('validator_done', `検証通過${validation.issues.length > 0 ? ` (注意: ${validation.issues.join(', ')})` : ''}`);

  const finalPlan = validation.revisedPlan ?? plan;
  tasks.push(...finalPlan.tasks);
  state.totalTasks = tasks.length;

  log.info('Validation passed', {
    taskCount: tasks.length,
    issues: validation.issues,
  });

  if (cancelled) {
    throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
  }

  // Phase 3: Execute DAG (parallel where dependencies allow)
  state.phase = 'executing';
  log.info('Starting execution phase');

  const completedResults = new Map<string, string>();
  const allToolEvidence: ToolEvidenceEntry[] = [];
  await executeDag(tasks, completedResults, allToolEvidence, state, input.prompt, model, maxParallelTasks, emit, input.allowedTools);

  if (cancelled) {
    throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
  }

  // Phase 4: Integrate reviewed task results
  state.phase = 'integrating';
  const reviewedTasks = tasks.filter((t) => t.reviewPassed);
  emit('integrator_start', `統合開始: ${reviewedTasks.length}タスクの結果を統合`);
  log.info('Starting integration phase', {
    reviewedCount: reviewedTasks.length,
    rejectedCount: tasks.length - reviewedTasks.length,
  });

  const { integratedResponse } = await integratorActivity({
    originalPrompt: input.prompt,
    reviewedTasks,
    model,
    allowedTools: input.allowedTools,
  });
  emit('integrator_done', '統合完了');

  // Phase 5: Review the integration
  state.phase = 'reviewing';
  emit('integration_reviewer_start', '統合レビュー開始');
  log.info('Starting integration review phase');

  const integrationReview = await integrationReviewerActivity({
    originalPrompt: input.prompt,
    integratedResponse,
    model,
    toolEvidence: allToolEvidence.length > 0 ? allToolEvidence : undefined,
  });
  emit('integration_reviewer_done', `統合レビュー${integrationReview.passed ? '通過' : '却下'}: ${integrationReview.notes.slice(0, 100)}`);

  state.phase = 'complete';
  log.info('Workflow complete', { passed: integrationReview.passed });

  return {
    finalResponse: integrationReview.revisedResponse ?? integratedResponse,
    integrationReviewPassed: integrationReview.passed,
    integrationReviewNotes: integrationReview.notes,
    tasks,
    executionTimeMs: Date.now() - startTime,
  };
}
