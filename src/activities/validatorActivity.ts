import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { ValidationResultSchema } from '../types/schemas';
import type { ValidatorRequest, ValidatorResponse } from '../types/agents';

export async function validatorActivity(req: ValidatorRequest): Promise<ValidatorResponse> {
  log.info('Validator started', { taskCount: req.plan.tasks.length, provider: req.provider ?? 'default', model: req.model });

  const planJson = JSON.stringify(req.plan, null, 2);

  const result = await callStructured(ValidationResultSchema, {
    provider: req.provider,
    model: req.model,
    system: `あなたはバリデーションエージェントです。タスクプラン（DAG）を検証し、正確性を確認してください。

チェック項目:
1. 循環依存（タスクAがBに依存し、BがAに依存している等）
2. 存在しないIDへの依存参照
3. 曖昧すぎて実行不能なタスク
4. 元のリクエストを達成するために必要なステップがすべて含まれているか

プランが妥当な場合: { "valid": true, "issues": [] }
軽微な修正可能な問題がある場合: { "valid": true, "issues": ["日本語で問題を記述"], "revisedPlan": { ... } }（修正済みプランを添付）
致命的な問題がある場合: { "valid": false, "issues": ["日本語で問題を記述"] }

issues の内容は日本語で記述してください。

以下のスキーマに**厳密に**従ってJSONを出力してください。キー名は必ず英語のままにしてください:
{
  "valid": boolean,
  "issues": ["string（日本語で記述）"],
  "revisedPlan": { /* optional, 入力と同じ形式 */ }
}`,
    userContent: `以下のタスクプランを検証してください:\n\n${planJson}`,
  });

  log.info('Validator completed', { valid: result.valid, issueCount: result.issues.length });
  return { result };
}
