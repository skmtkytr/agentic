import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { TaskPlanSchema } from '../types/schemas';
import type { PlannerRequest, PlannerResponse } from '../types/agents';

export async function plannerActivity(req: PlannerRequest): Promise<PlannerResponse> {
  log.info('Planner started', { promptLength: req.prompt.length });

  const parsed = await callStructured(TaskPlanSchema, {
    model: req.model,
    system: `あなたはプランニングエージェントです。ユーザーのリクエストを、有向非巡回グラフ（DAG）を構成する個別の実行可能タスクに分解してください。

ルール:
- 各タスクには一意の短い文字列ID（例: "task_1", "task_2"）を付けてください
- 各タスクの description には、何を実行すべきかを具体的に日本語で記述してください
- "dependsOn" には、このタスクの実行前に完了が必要なタスクのIDを列挙してください
- 循環依存は絶対に含めないでください
- タスクは独立して実行できる粒度にしてください
- planSummary には全体的なアプローチの概要を日本語で記述してください

以下のスキーマに**厳密に**従ってJSONを出力してください。キー名は必ず英語のままにしてください:
{
  "planSummary": "string（日本語で記述）",
  "tasks": [
    {
      "id": "string",
      "description": "string（日本語で記述）",
      "dependsOn": ["string"],
      "status": "pending",
      "reviewPassed": false
    }
  ]
}

重要: "planSummary" と "tasks" はトップレベルのキーです。これらを別のキー名やラッパーオブジェクトで囲まないでください。`,
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
