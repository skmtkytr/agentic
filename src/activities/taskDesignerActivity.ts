import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { TaskDesignResultSchema } from '../types/schemas';
import type { TaskDesignerRequest, TaskDesignerResponse } from '../types/agents';

export async function taskDesignerActivity(req: TaskDesignerRequest): Promise<TaskDesignerResponse> {
  log.info('TaskDesigner started', { taskCount: req.plan.tasks.length, provider: req.provider ?? 'default', model: req.model });

  const planJson = JSON.stringify(req.plan, null, 2);

  const hasTools = req.allowedTools && req.allowedTools.length > 0;
  const toolSection = hasTools
    ? `\n## 利用可能なツール\n実行エージェントは以下のツールを使用できます: ${req.allowedTools!.join(', ')}\n成功基準の設計時にツールの活用を前提としてください。\n`
    : `\n## ツール制約\n実行エージェントには外部ツールが許可されていません。\n`;

  const result = await callStructured(TaskDesignResultSchema, {
    provider: req.provider,
    model: req.model,
    system: `あなたはタスク設計エージェントです。タスクプラン（DAG）を検証し、各タスクの実行指針を設計してください。
${toolSection}
## 検証チェック（必須）
1. 循環依存（タスクAがBに依存し、BがAに依存している等）
2. 存在しないIDへの依存参照
3. 曖昧すぎて実行不能なタスク
4. 元のリクエストを達成するために必要なステップがすべて含まれているか

## タスク詳細設計（必須）
各タスクに以下のフィールドを設計して追加してください:
- purpose: このタスクが全体計画で果たす役割（1文、日本語）
- successCriteria: このタスクの成功条件（具体的に2-4項目、日本語）
- outputFormat: 期待される出力形式（例: "Markdown表形式", "箇条書き", "コードブロック"）

成功基準は具体的・測定可能にしてください:
✗ 「正確であること」（曖昧）
○ 「信頼できるAPIから24時間以内のデータを取得していること」（具体的）

プランが妥当な場合: { "valid": true, "issues": [], "designedPlan": { ...設計済みプラン... } }
致命的な問題がある場合: { "valid": false, "issues": ["日本語で問題を記述"] }

designedPlan には、元のプランのタスクに purpose, successCriteria, outputFormat を追加したものを含めてください。
issues の内容は日本語で記述してください。

以下のスキーマに**厳密に**従ってJSONを出力してください。キー名は必ず英語のままにしてください:
{
  "valid": boolean,
  "issues": ["string（日本語で記述）"],
  "designedPlan": {
    "planSummary": "string",
    "userIntent": "string（optional）",
    "qualityGuidelines": "string（optional）",
    "tasks": [
      {
        "id": "string",
        "description": "string",
        "purpose": "string（日本語）",
        "successCriteria": ["string（日本語）"],
        "outputFormat": "string",
        "dependsOn": ["string"],
        "status": "pending",
        "reviewPassed": false
      }
    ]
  }
}`,
    userContent: `元のリクエスト: ${req.originalPrompt}\n\n以下のタスクプランを検証し、各タスクの実行指針を設計してください:\n\n${planJson}`,
  });

  log.info('TaskDesigner completed', { valid: result.valid, issueCount: result.issues.length, hasDesignedPlan: !!result.designedPlan });
  return { result };
}
