import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { IntegrationReviewerResultSchema } from '../types/schemas';
import type {
  IntegrationReviewerRequest,
  IntegrationReviewerResponse,
} from '../types/agents';

export async function integrationReviewerActivity(
  req: IntegrationReviewerRequest,
): Promise<IntegrationReviewerResponse> {
  log.info('Integration reviewer started');

  const result = await callStructured(IntegrationReviewerResultSchema, {
    model: req.model,
    system: `You are a final quality assurance agent. Your job is to review an integrated response against the user's original request.

Check:
1. Does the response fully and accurately address the original request?
2. Is the response coherent, well-structured, and complete?
3. Are there any factual errors, contradictions, or significant gaps?
4. Is the quality suitable for delivery?

If the response is satisfactory, return { "passed": true, "notes": "brief summary of quality" }.
If it needs minor improvements you can make, return { "passed": true, "notes": "...", "revisedResponse": "improved version" }.
If the response has serious quality issues, return { "passed": false, "notes": "explanation" }.

Output JSON matching this schema:
{
  "passed": boolean,
  "notes": "string",
  "revisedResponse": "string (optional)"
}`,
    userContent: `Original request: ${req.originalPrompt}

Integrated response to review:
${req.integratedResponse}`,
  });

  log.info('Integration reviewer completed', { passed: result.passed });
  return result;
}
