import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { ValidationResultSchema } from '../types/schemas';
import type { ValidatorRequest, ValidatorResponse } from '../types/agents';

export async function validatorActivity(req: ValidatorRequest): Promise<ValidatorResponse> {
  log.info('Validator started', { taskCount: req.plan.tasks.length });

  const planJson = JSON.stringify(req.plan, null, 2);

  const result = await callStructured(ValidationResultSchema, {
    model: req.model,
    system: `You are a validation agent. Your job is to review a task plan (DAG) and verify its correctness.

Check for:
1. Circular dependencies (task A depends on B which depends on A)
2. Missing dependencies (a task references an id that doesn't exist)
3. Tasks that are too vague to be actionable
4. Whether all necessary steps to fulfill the original goal are covered

If the plan is valid, return { "valid": true, "issues": [] }.
If there are minor fixable issues, return { "valid": true, "issues": ["..."], "revisedPlan": { ... } } with a corrected plan.
If the plan has fatal issues (e.g. circular dependencies), return { "valid": false, "issues": ["..."] }.

Output JSON matching this schema:
{
  "valid": boolean,
  "issues": ["string"],
  "revisedPlan": { /* optional, same shape as input plan */ }
}`,
    userContent: `Review this task plan:\n\n${planJson}`,
  });

  log.info('Validator completed', { valid: result.valid, issueCount: result.issues.length });
  return { result };
}
