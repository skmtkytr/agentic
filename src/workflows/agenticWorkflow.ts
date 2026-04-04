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
import type { PlanContext, ToolEvidenceEntry, ToolUsageRecord } from '../types/agents';
import type { AgentRole, PipelineAttempt, ActivityEvent, ActivityEventKind, WorkflowInput, WorkflowOutput, WorkflowState } from '../types/workflow';

// --- Activity proxies with role-specific retry policies ---

const NON_RETRYABLE_ERRORS = ['AnthropicAuthError'];

// Planner/TaskDesigner: structured JSON output — typically completes in 1-2 min
const { plannerActivity, taskDesignerActivity } = proxyActivities<Activities>({
  startToCloseTimeout: '10 minutes',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '2 minutes', maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_ERRORS },
});

// Executor: tool usage (WebFetch, Bash, etc.) can take longer
const { executorActivity } = proxyActivities<Activities>({
  startToCloseTimeout: '30 minutes',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '2 minutes', maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE_ERRORS },
});

// Reviewer/Integrator/IntegrationReviewer: structured output — typically completes in 1-3 min
const { reviewerActivity, integratorActivity, integrationReviewerActivity } =
  proxyActivities<Activities>({
    startToCloseTimeout: '10 minutes',
    retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumInterval: '2 minutes', maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_ERRORS },
  });

// --- Signals and Queries ---

export const statusQuery = defineQuery<WorkflowState>('status');
export const cancelSignal = defineSignal('cancel');

// --- Config resolution helper ---

function resolveConfig(
  role: AgentRole,
  input: WorkflowInput,
): { model: string; provider?: string } {
  const roleConfig = input.agentConfig?.[role];
  return {
    model: roleConfig?.model ?? input.model ?? 'claude-opus-4-6',
    provider: roleConfig?.provider ?? input.provider,
  };
}

// --- DAG execution helper ---

async function executeDag(
  tasks: Task[],
  completedResults: Map<string, string>,
  resultFilePaths: Map<string, string>,
  allToolEvidence: ToolEvidenceEntry[],
  toolEvidenceFilePaths: string[],
  state: WorkflowState,
  input: WorkflowInput,
  maxParallelTasks: number,
  emit: (kind: ActivityEventKind, summary: string, taskId?: string, taskDescription?: string) => void,
  maxTaskRetries: number = 0,
  planContext?: PlanContext,
): Promise<void> {
  const originalPrompt = input.prompt;
  const allowedTools = input.allowedTools;
  const workflowId = input.workflowId;
  const executorCfg = resolveConfig('executor', input);
  const reviewerCfg = resolveConfig('reviewer', input);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set<string>();

  while (done.size < tasks.length) {
    // Find all tasks whose dependencies are satisfied and not yet started
    const ready = tasks
      .filter((t) => !done.has(t.id) && t.dependsOn.every((dep) => done.has(dep)))
      .slice(0, maxParallelTasks);

    if (ready.length === 0) {
      // Should have been caught by task designer — guard against infinite loop
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
        let lastResultFilePath: string | undefined;

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

          // On retry, include structured review feedback for executor
          const retryContext = taskAttempt > 1
            ? `\n\n[前回の実行がレビューで却下されました（試行${taskAttempt - 1}）]\nレビュー���摘: ${lastReviewNotes}\n上記の指摘を踏まえて、改善した結果を出力してください。特に指摘された具体的なアクションを実行してください。`
            : '';

          const execResult = await executorActivity({
            task: retryContext
              ? { ...task, description: task.description + retryContext }
              : task,
            completedTaskResults: context,
            originalPrompt,
            model: executorCfg.model,
            provider: executorCfg.provider,
            allowedTools,
            workflowId,
            planContext,
          });

          task.result = execResult.result;
          lastResultFilePath = execResult.resultFilePath;
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
            if (execResult.toolEvidenceFilePath) {
              toolEvidenceFilePaths.push(execResult.toolEvidenceFilePath);
            }
          } else {
            emit('executor_done', `実行完了${attemptSuffix}: ${task.description}`, task.id, task.description);
          }

          emit('reviewer_start', `レビュー開始${attemptSuffix}: ${task.description}`, task.id, task.description);
          const review = await reviewerActivity({
            task,
            result: execResult.result,
            resultFilePath: execResult.resultFilePath,
            originalPrompt,
            model: reviewerCfg.model,
            provider: reviewerCfg.provider,
            toolUsage: taskToolUsage,
            toolEvidenceFilePath: execResult.toolEvidenceFilePath,
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

        completedResults.set(task.id, task.result ?? '');
        if (lastResultFilePath) {
          resultFilePaths.set(task.id, lastResultFilePath);
        }
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
  const maxParallelTasks = input.maxParallelTasks ?? 3;
  const maxPipelineRetries = input.maxPipelineRetries ?? 1;

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
  const pipelineHistory: PipelineAttempt[] = [];

  while (pipelineAttempt <= maxPipelineRetries) {
    pipelineAttempt++;

    if (pipelineAttempt > 1) {
      // Save previous attempt before clearing
      pipelineHistory.push({
        attempt: pipelineAttempt - 1,
        tasks: tasks.map((t) => ({ ...t })),
        integrationReviewPassed: lastReviewPassed,
        integrationReviewNotes: lastReviewNotes,
      });

      // Reset state for retry
      tasks.length = 0;
      state.totalTasks = 0;
      state.completedTasks = 0;
      state.currentlyExecuting = [];

      emit('pipeline_retry', `パイプラインリトライ (${pipelineAttempt}/${maxPipelineRetries + 1}): ${lastReviewNotes.slice(0, 80)}`);
      log.info('Pipeline retry', { attempt: pipelineAttempt, reason: lastReviewNotes.slice(0, 200) });

      // Augment prompt with previous failure feedback including rejected task details
      const rejectedTaskFeedback = pipelineHistory[pipelineHistory.length - 1]?.tasks
        .filter((t) => !t.reviewPassed && t.reviewNotes)
        .map((t) => `- ${t.description.slice(0, 60)}: ${t.reviewNotes}`)
        .join('\n');

      currentPrompt = `${input.prompt}

[前回の試行が統合レビューで不合格になりました。以下のフィードバックを踏まえて改善してください]
レビュー指摘: ${lastReviewNotes}${rejectedTaskFeedback ? `\n\n却下されたタスクの詳細:\n${rejectedTaskFeedback}` : ''}`;
    }

    // Phase 1: Plan
    state.phase = 'planning';
    emit('planner_start', `プランニング開始${pipelineAttempt > 1 ? ` (試行 ${pipelineAttempt})` : ''}`);
    log.info('Starting planning phase', { attempt: pipelineAttempt, promptPreview: currentPrompt.slice(0, 100) });

    const plannerCfg = resolveConfig('planner', input);
    const { plan } = await plannerActivity({ prompt: currentPrompt, model: plannerCfg.model, provider: plannerCfg.provider, allowedTools: input.allowedTools });
    emit('planner_done', `プラン生成完了: ${plan.tasks.length}タスク — ${plan.planSummary.slice(0, 100)}`);

    if (cancelled) {
      throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
    }

    // Phase 2: Task Design (validation + detailed task design)
    state.phase = 'designing';
    emit('designer_start', 'タスク設計開始');
    log.info('Starting task design phase', { taskCount: plan.tasks.length });

    const designerCfg = resolveConfig('taskDesigner', input);
    const { result: design } = await taskDesignerActivity({ plan, originalPrompt: input.prompt, model: designerCfg.model, provider: designerCfg.provider, allowedTools: input.allowedTools });

    if (!design.valid) {
      emit('designer_done', `設計失敗: ${design.issues.join('; ')}`);
      throw ApplicationFailure.create({
        message: `Task design failed: ${design.issues.join('; ')}`,
        type: 'TaskDesignFatalError',
        nonRetryable: true,
      });
    }

    emit('designer_done', `設計完了${design.issues.length > 0 ? ` (注意: ${design.issues.join(', ')})` : ''}`);

    const finalPlan = design.designedPlan ?? plan;
    tasks.push(...finalPlan.tasks);
    state.totalTasks = tasks.length;

    log.info('Task design passed', { taskCount: tasks.length, issues: design.issues });

    if (cancelled) {
      throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
    }

    // Phase 3: Execute DAG
    state.phase = 'executing';
    log.info('Starting execution phase');

    const completedResults = new Map<string, string>();
    const resultFilePaths = new Map<string, string>();
    const allToolEvidence: ToolEvidenceEntry[] = [];
    const toolEvidenceFilePaths: string[] = [];
    const maxTaskRetries = input.maxTaskRetries ?? 1;
    const planContext: PlanContext = {
      userIntent: finalPlan.userIntent,
      qualityGuidelines: finalPlan.qualityGuidelines,
    };
    await executeDag(tasks, completedResults, resultFilePaths, allToolEvidence, toolEvidenceFilePaths, state, input, maxParallelTasks, emit, maxTaskRetries, planContext);

    if (cancelled) {
      throw ApplicationFailure.create({ message: 'Cancelled by signal', nonRetryable: true });
    }

    // Phase 4: Integrate
    state.phase = 'integrating';
    const reviewedTasks = tasks.filter((t) => t.reviewPassed);
    emit('integrator_start', `統合開始: ${reviewedTasks.length}タスクの結果を統合`);
    log.info('Starting integration phase', { reviewedCount: reviewedTasks.length, rejectedCount: tasks.length - reviewedTasks.length });

    // Build file path list for integrator
    const taskResultFiles = reviewedTasks
      .filter((t) => resultFilePaths.has(t.id))
      .map((t) => ({ taskId: t.id, description: t.description, filePath: resultFilePaths.get(t.id)! }));

    const integratorCfg = resolveConfig('integrator', input);
    const { integratedResponse, integratedResponseFilePath } = await integratorActivity({
      originalPrompt: input.prompt,
      reviewedTasks,
      taskResultFiles: taskResultFiles.length > 0 ? taskResultFiles : undefined,
      model: integratorCfg.model,
      provider: integratorCfg.provider,
      allowedTools: input.allowedTools,
      workflowId: input.workflowId,
      planContext,
    });
    emit('integrator_done', '統合完了');

    // Phase 5: Review
    state.phase = 'reviewing';
    emit('integration_reviewer_start', '統合レビュー開始');
    log.info('Starting integration review phase');

    const integrationReviewerCfg = resolveConfig('integrationReviewer', input);
    const integrationReview = await integrationReviewerActivity({
      originalPrompt: input.prompt,
      integratedResponse,
      integratedResponseFilePath,
      model: integrationReviewerCfg.model,
      provider: integrationReviewerCfg.provider,
      toolEvidence: allToolEvidence.length > 0 ? allToolEvidence : undefined,
      toolEvidenceFilePaths: toolEvidenceFilePaths.length > 0 ? toolEvidenceFilePaths : undefined,
      planContext,
    });
    emit('integration_reviewer_done', `統合レビュー${integrationReview.passed ? '通過' : '却下'}: ${integrationReview.notes.slice(0, 100)}`);

    lastReviewPassed = integrationReview.passed;
    lastReviewNotes = integrationReview.notes;
    lastIntegratedResponse = integrationReview.revisedResponse || integratedResponse;

    if (integrationReview.passed || pipelineAttempt > maxPipelineRetries) {
      // Done — either passed or exhausted retries
      state.phase = 'complete';
      log.info('Workflow complete', { passed: integrationReview.passed, attempt: pipelineAttempt });

      return {
        finalResponse: lastIntegratedResponse,
        integrationReviewPassed: integrationReview.passed,
        integrationReviewNotes: integrationReview.notes,
        integrationReviewScore: integrationReview.score,
        integrationReviewStrengths: integrationReview.strengths,
        integrationReviewImprovements: integrationReview.improvements,
        tasks,
        executionTimeMs: Date.now() - startTime,
        pipelineAttempt,
        pipelineHistory: pipelineHistory.length > 0 ? pipelineHistory : undefined,
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
    pipelineHistory: pipelineHistory.length > 0 ? pipelineHistory : undefined,
  };
}
