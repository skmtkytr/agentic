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

// 30 min timeout — LLM calls can take minutes for complex tasks.
const { plannerActivity, validatorActivity } = proxyActivities<Activities>({
  startToCloseTimeout: '24 hours',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '2 minutes', maximumAttempts: 3, nonRetryableErrorTypes: ['AnthropicAuthError'] },
});

const { executorActivity } = proxyActivities<Activities>({
  startToCloseTimeout: '24 hours',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '2 minutes', maximumAttempts: 3, nonRetryableErrorTypes: ['AnthropicAuthError'] },
});

const { reviewerActivity, integratorActivity, integrationReviewerActivity } =
  proxyActivities<Activities>({
    startToCloseTimeout: '24 hours',
    retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '2 minutes', maximumAttempts: 3, nonRetryableErrorTypes: ['AnthropicAuthError'] },
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
  maxTaskRetries: number = 0,
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
        let taskAttempt = 0;
        let lastReviewNotes = '';

        while (taskAttempt <= maxTaskRetries) {
          taskAttempt++;
          task.status = 'executing';
          const attemptSuffix = taskAttempt > 1 ? ` (試行${taskAttempt})` : '';
          emit('executor_start', `実行開始${attemptSuffix}: ${task.description}`, task.id, task.description);

          const context = [...completedResults.entries()].map(([taskId, result]) => ({
            taskId,
            description: taskMap.get(taskId)!.description,
            result,
          }));

          // On retry, include previous review feedback in the task description context
          const retryContext = taskAttempt > 1
            ? `\n\n[前回の実行がレビューで却下されました。フィードバック: ${lastReviewNotes}]`
            : '';

          const execResult = await executorActivity({
            task: retryContext
              ? { ...task, description: task.description + retryContext }
              : task,
            completedTaskResults: context,
            originalPrompt,
            model,
            allowedTools,
          });

          task.result = execResult.result;
          task.status = 'executed';
          const taskToolUsage = execResult.toolUsage ?? [];
          if (taskToolUsage.length > 0) {
            emit('executor_done', `実行完了${attemptSuffix}: ${task.description} (ツール${taskToolUsage.length}件使用)`, task.id, task.description);
            for (const tu of taskToolUsage) {
              allToolEvidence.push({
                taskDescription: task.description,
                tool: tu.tool,
                input: tu.input,
                output: tu.output,
              });
            }
          } else {
            emit('executor_done', `実行完了${attemptSuffix}: ${task.description}`, task.id, task.description);
          }

          emit('reviewer_start', `レビュー開始${attemptSuffix}: ${task.description}`, task.id, task.description);
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

          if (review.passed) {
            task.status = 'reviewed';
            emit('reviewer_done', `レビュー通過${attemptSuffix}: ${task.description}`, task.id, task.description);
            break;
          }

          // Review rejected
          lastReviewNotes = review.notes;
          if (taskAttempt > maxTaskRetries) {
            task.status = 'rejected';
            emit('reviewer_done', `レビュー却下 (リトライ上限): ${task.description} — ${review.notes.slice(0, 80)}`, task.id, task.description);
          } else {
            emit('task_retry', `タスクリトライ (${taskAttempt}→${taskAttempt + 1}): ${task.description} — ${review.notes.slice(0, 60)}`, task.id, task.description);
          }
        }

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
  const maxPipelineRetries = input.maxPipelineRetries ?? 0;

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

  let pipelineAttempt = 0;
  let currentPrompt = input.prompt;
  let lastReviewNotes = '';
  let lastIntegratedResponse = '';
  let lastReviewPassed = false;

  while (pipelineAttempt <= maxPipelineRetries) {
    pipelineAttempt++;

    if (pipelineAttempt > 1) {
      // Reset state for retry
      tasks.length = 0;
      state.totalTasks = 0;
      state.completedTasks = 0;
      state.currentlyExecuting = [];

      emit('pipeline_retry', `パイプラインリトライ (${pipelineAttempt}/${maxPipelineRetries + 1}): ${lastReviewNotes.slice(0, 80)}`);
      log.info('Pipeline retry', { attempt: pipelineAttempt, reason: lastReviewNotes.slice(0, 200) });

      // Augment prompt with previous failure feedback
      currentPrompt = `${input.prompt}

[前回の試行が統合レビューで不合格になりました。以下のフィードバックを踏まえて改善してください]
レビュー指摘: ${lastReviewNotes}`;
    }

    // Phase 1: Plan
    state.phase = 'planning';
    emit('planner_start', `プランニング開始${pipelineAttempt > 1 ? ` (試行 ${pipelineAttempt})` : ''}`);
    log.info('Starting planning phase', { attempt: pipelineAttempt, promptPreview: currentPrompt.slice(0, 100) });

    const { plan } = await plannerActivity({ prompt: currentPrompt, model });
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

    log.info('Validation passed', { taskCount: tasks.length, issues: validation.issues });

    if (cancelled) {
      throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
    }

    // Phase 3: Execute DAG
    state.phase = 'executing';
    log.info('Starting execution phase');

    const completedResults = new Map<string, string>();
    const allToolEvidence: ToolEvidenceEntry[] = [];
    const maxTaskRetries = input.maxTaskRetries ?? 0;
    await executeDag(tasks, completedResults, allToolEvidence, state, input.prompt, model, maxParallelTasks, emit, input.allowedTools, maxTaskRetries);

    if (cancelled) {
      throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
    }

    // Phase 4: Integrate
    state.phase = 'integrating';
    const reviewedTasks = tasks.filter((t) => t.reviewPassed);
    emit('integrator_start', `統合開始: ${reviewedTasks.length}タスクの結果を統合`);
    log.info('Starting integration phase', { reviewedCount: reviewedTasks.length, rejectedCount: tasks.length - reviewedTasks.length });

    const { integratedResponse } = await integratorActivity({
      originalPrompt: input.prompt,
      reviewedTasks,
      model,
      allowedTools: input.allowedTools,
    });
    emit('integrator_done', '統合完了');

    // Phase 5: Review
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

    lastReviewPassed = integrationReview.passed;
    lastReviewNotes = integrationReview.notes;
    lastIntegratedResponse = integrationReview.revisedResponse ?? integratedResponse;

    if (integrationReview.passed || pipelineAttempt > maxPipelineRetries) {
      // Done — either passed or exhausted retries
      state.phase = 'complete';
      log.info('Workflow complete', { passed: integrationReview.passed, attempt: pipelineAttempt });

      return {
        finalResponse: lastIntegratedResponse,
        integrationReviewPassed: integrationReview.passed,
        integrationReviewNotes: integrationReview.notes,
        tasks,
        executionTimeMs: Date.now() - startTime,
        pipelineAttempt,
      };
    }

    // Review failed, loop will retry
    log.info('Integration review failed, will retry pipeline', { attempt: pipelineAttempt, maxRetries: maxPipelineRetries });
  }

  // Should not reach here, but safety return
  state.phase = 'complete';
  return {
    finalResponse: lastIntegratedResponse,
    integrationReviewPassed: lastReviewPassed,
    integrationReviewNotes: lastReviewNotes,
    tasks,
    executionTimeMs: Date.now() - startTime,
    pipelineAttempt,
  };
}
