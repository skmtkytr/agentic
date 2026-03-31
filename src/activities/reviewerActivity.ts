import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { ReviewerResultSchema } from '../types/schemas';
import type { ReviewerRequest, ReviewerResponse } from '../types/agents';

export async function reviewerActivity(req: ReviewerRequest): Promise<ReviewerResponse> {
  log.info('Reviewer started', { taskId: req.task.id });

  const result = await callStructured(ReviewerResultSchema, {
    model: req.model,
    system: `You are a quality review agent. Your job is to evaluate whether a task result is complete and correct.

Evaluate:
1. Does the result fully address the task description?
2. Is the result accurate and well-reasoned?
3. Are there any obvious errors or omissions?

If the result is acceptable, return { "passed": true, "notes": "..." }.
If there are minor issues you can fix, return { "passed": true, "notes": "...", "revisedResult": "corrected result" }.
If the result is fundamentally inadequate, return { "passed": false, "notes": "explanation of issues" }.

Output JSON matching this schema:
{
  "taskId": "string",
  "passed": boolean,
  "notes": "string",
  "revisedResult": "string (optional)"
}`,
    userContent: `Original request: ${req.originalPrompt}

Task: ${req.task.description}

Task result to review:
${req.result}

Task ID: ${req.task.id}`,
  });

  log.info('Reviewer completed', { taskId: req.task.id, passed: result.passed });
  return {
    taskId: result.taskId || req.task.id,
    passed: result.passed,
    notes: result.notes,
    revisedResult: result.revisedResult,
  };
}
