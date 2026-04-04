import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { TaskPlanSchema } from '../types/schemas';
import type { PlannerRequest, PlannerResponse } from '../types/agents';

export async function plannerActivity(req: PlannerRequest): Promise<PlannerResponse> {
  log.info('Planner started', { promptLength: req.prompt.length, provider: req.provider ?? 'default', model: req.model });

  const parsed = await callStructured(TaskPlanSchema, {
    provider: req.provider,
    model: req.model,
    system: `あなたはプランニングエージェントです。以下の3ステップでタスクプランを生成してください。

## ステップ1: ユーザー意図の分析
リクエストの表面的な内容だけでなく、背景にある目的を推測してください。
- 何を達成したいのか（ゴール）
- どんな品質が求められているか（速度重視/正確性重視/網羅性重視 等）
- 暗黙の期待は何か
分析結果を userIntent に記述してください。

## ステップ2: タスク分解
DAGを構成する実行可能タスクに分解してください。各タスクには以下を含めてください:
- description: 何を実行するか（具体的に日本語で）
- purpose: このタスクが全体計画で果たす役割（1文）
- successCriteria: このタスクの成功条件（具体的に2-4項目）
- outputFormat: 期待される出力形式（例: "Markdown表形式", "箇条書き", "コードブロック"）

DAGルール:
- 各タスクには一意の短い文字列ID（例: "task_1", "task_2"）を付けてください
- "dependsOn" には、このタスクの実行前に完了が必要なタスクのIDを列挙してください
- 循環依存は絶対に含めないでください
- 互いに独立して実行できるタスクは dependsOn を空にして並列実行可能にしてください
- 本当に前のタスクの出力が必要な場合のみ dependsOn を設定してください

## ステップ3: 品質指針
qualityGuidelines に、このリクエスト特有の品質基準を記述してください。
例: 「最新のリアルタイムデータに基づくこと」「技術的正確性を最優先」「ユーザーが即座に行動できる具体性」

以下のスキーマに**厳密に**従ってJSONを出力してください。キー名は必ず英語のままにしてください:
{
  "userIntent": "string（日本語で記述）",
  "qualityGuidelines": "string（日本語で記述）",
  "planSummary": "string（日本語で記述）",
  "tasks": [
    {
      "id": "string",
      "description": "string（日本語で記述）",
      "purpose": "string（日本語で記述）",
      "successCriteria": ["string（日本語で記述）"],
      "outputFormat": "string",
      "dependsOn": ["string"],
      "status": "pending",
      "reviewPassed": false
    }
  ]
}

重要: トップレベルのキーを別のキー名やラッパーオブジェクトで囲まないでください。`,
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
    hasUserIntent: !!parsed.userIntent,
    hasQualityGuidelines: !!parsed.qualityGuidelines,
  });

  return {
    plan: {
      tasks: remapped,
      planSummary: parsed.planSummary,
      userIntent: parsed.userIntent,
      qualityGuidelines: parsed.qualityGuidelines,
    },
  };
}
