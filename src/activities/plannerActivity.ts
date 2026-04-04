import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { TaskPlanSchema } from '../types/schemas';
import type { PlannerRequest, PlannerResponse } from '../types/agents';

export async function plannerActivity(req: PlannerRequest): Promise<PlannerResponse> {
  log.info('Planner started', { promptLength: req.prompt.length, provider: req.provider ?? 'default', model: req.model });

  const hasTools = req.allowedTools && req.allowedTools.length > 0;
  const hasWebTools = hasTools && req.allowedTools!.some(t => t === 'WebSearch' || t === 'WebFetch');
  const toolSection = hasTools
    ? `\n\n## 利用可能なツール（重要）
実行エージェントは以下のツールを**実際に使用できます**。これを前提にタスクを設計してください。
${req.allowedTools!.map(t => `- ${t}`).join('\n')}
${hasWebTools ? `
### ★ Web検索・取得について（最重要）
WebSearch と WebFetch が利用可能です。つまり実行エージェントは**リアルタイムでWebから情報を取得できます**。
- 「フレームワークの設計」「指標の定義」のような抽象的なタスクではなく、「WebSearchで○○を検索し、実際のデータを取得して分析する」という**具体的なデータ取得・分析タスク**にしてください
- 例: ✗「PER/PBRの評価指標を設計する」→ ○「WebSearchで○○社の最新の財務データ(PER/PBR/ROE等)を取得し、分析する」
- 例: ✗「競合比較フレームワークを設計する」→ ○「WebSearchで○○社の競合企業の情報を検索し、比較分析する」
- 実在するデータの取得と分析を中心にタスクを構成してください` : ''}

タスクは「何を調べるか・何を実行するか」を具体的に記述してください。
「設計する」「フレームワークを作る」「定義する」ではなく「取得する」「分析する」「実行する」という動詞を使ってください。
「ツールがないから案内だけする」「一般的な説明をする」というタスクは、ツールが使える場合には不適切です。`
    : `\n\n## ツール制約
実行エージェントには外部ツールが許可されていません。LLMの知識の範囲内で実行可能なタスクのみを設計してください。`;

  const parsed = await callStructured(TaskPlanSchema, {
    provider: req.provider,
    model: req.model,
    system: `あなたはプランニングエージェントです。ユーザーの意図を深く分析し、高レベルなタスクプランを生成してください。

## ステップ1: ユーザー意図の分析
リクエストの表面的な内容だけでなく、背景にある目的を推測してください。
- 何を達成したいのか（ゴール）
- どんな品質が求められているか（速度重視/正確性重視/網羅性重視 等）
- 暗黙の期待は何か
分析結果を userIntent に記述してください。
${toolSection}

## ステップ2: タスク分解
DAGを構成する実行可能タスクに分解してください。
- description: 何を実行するか（具体的に日本語で）
- 各タスクには一意のID（例: "task_1", "task_2"）を付けてください
- "dependsOn" には、前のタスクの出力が必要な場合のみIDを列挙
- 循環依存は絶対に含めないでください
- 独立して実行できるタスクは dependsOn を空にして並列化してください

★重要: ユーザーのリクエストに含まれる固有名詞（企業名、人名、商品名、証券コード等）は**一字一句そのまま**使用してください。
勝手に読み替えたり、類似の名前に変換したりしないでください。
例: 「ユナイテッド」を「ユニテッド」に変えることは禁止です。

注意: 各タスクの詳細な成功基準や出力形式は後続の設計エージェントが担当します。
ここでは「何をするか」の分解に集中してください。

## ステップ3: 品質指針
qualityGuidelines に、このリクエスト特有の品質基準を記述してください。

以下のスキーマに**厳密に**従ってJSONを出力してください:
{
  "userIntent": "string（日本語で記述）",
  "qualityGuidelines": "string（日本語で記述）",
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
