import { log } from '@temporalio/activity';
import { callRawText } from '../llm/parseWithRetry';
import type { IntegratorRequest, IntegratorResponse } from '../types/agents';

export async function integratorActivity(req: IntegratorRequest): Promise<IntegratorResponse> {
  log.info('Integrator started', { taskCount: req.reviewedTasks.length });

  const taskResultsSection = req.reviewedTasks
    .map((t) => `### ${t.description}\n${t.result ?? '(no result)'}`)
    .join('\n\n');

  const integratedResponse = await callRawText({
    model: req.model,
    system: `You are an integration agent. Your job is to synthesize the results of multiple completed tasks into a single, coherent, well-structured response that directly addresses the user's original request.

Guidelines:
- Combine all task results into a unified, flowing response
- Eliminate redundancy and ensure logical flow
- The final response should feel like a single piece of work, not a list of task outputs
- Preserve all important information from the task results
- Format appropriately for the type of content (prose, code, lists, etc.)`,
    allowedTools: req.allowedTools,
    userContent: `Original request: ${req.originalPrompt}

Completed task results to integrate:

${taskResultsSection}

Please synthesize these results into a comprehensive, unified response to the original request.`,
  });

  log.info('Integrator completed', { responseLength: integratedResponse.length });
  return { integratedResponse };
}
