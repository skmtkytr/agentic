import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { TaskPlanSchema } from '../types/schemas';
import type { PlannerRequest, PlannerResponse } from '../types/agents';

export async function plannerActivity(req: PlannerRequest): Promise<PlannerResponse> {
  log.info('Planner started', { promptLength: req.prompt.length });

  const parsed = await callStructured(TaskPlanSchema, {
    model: req.model,
    system: `You are a planning agent. Your job is to decompose the user's request into discrete, atomic tasks that form a directed acyclic graph (DAG).

Rules:
- Each task must have a unique short string id (e.g. "task_1", "task_2")
- Each task must have a clear, specific description of what needs to be done
- The "dependsOn" field lists ids of tasks that must complete BEFORE this task can start
- There must be NO circular dependencies
- Tasks should be granular enough to be independently executable
- Include a brief planSummary explaining the overall approach

Output JSON matching this schema:
{
  "planSummary": "string",
  "tasks": [
    {
      "id": "string",
      "description": "string",
      "dependsOn": ["string"],
      "status": "pending",
      "reviewPassed": false
    }
  ]
}`,
    userContent: req.prompt,
  });

  // LLM が生成したIDをUUIDに付け直す（一貫性確保）
  const { randomUUID } = await import('node:crypto');
  const idMap = new Map<string, string>();

  const tasks = parsed.tasks.map((t) => {
    const newId = randomUUID();
    idMap.set(t.id, newId);
    return { ...t, id: newId };
  });

  const remapped = tasks.map((t) => ({
    ...t,
    dependsOn: t.dependsOn.map((dep) => idMap.get(dep) ?? dep),
  }));

  log.info('Planner produced plan', {
    taskCount: remapped.length,
    summary: parsed.planSummary.slice(0, 100),
  });

  return { plan: { tasks: remapped, planSummary: parsed.planSummary } };
}
