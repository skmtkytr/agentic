import { log } from '@temporalio/activity';
import { callRawText } from '../llm/parseWithRetry';
import type { ExecutorRequest, ExecutorResponse } from '../types/agents';

export async function executorActivity(req: ExecutorRequest): Promise<ExecutorResponse> {
  log.info('Executor started', {
    taskId: req.task.id,
    description: req.task.description.slice(0, 80),
  });

  const contextSection =
    req.completedTaskResults.length > 0
      ? `\n\nCompleted tasks context:\n${req.completedTaskResults
          .map((t) => `[${t.description}]:\n${t.result}`)
          .join('\n\n')}`
      : '';

  const result = await callRawText({
    model: req.model,
    system: `You are a task execution agent. Your job is to complete the specific task assigned to you.
The user's original request is provided for context. Focus on producing a high-quality, complete result for your assigned task only.${contextSection}`,
    userContent: `Original request: ${req.originalPrompt}\n\nYour task: ${req.task.description}\n\nPlease complete this task thoroughly.`,
    allowedTools: req.allowedTools,
  });

  log.info('Executor completed', { taskId: req.task.id, resultLength: result.length });
  return { taskId: req.task.id, result };
}
