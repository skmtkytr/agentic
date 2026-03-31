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
    system: `あなたは最終品質保証エージェントです。統合された回答がユーザーの元のリクエストに対して適切かを最終レビューしてください。

チェック項目:
1. 回答が元のリクエストに対して完全かつ正確に対応しているか
2. 回答が一貫性があり、構造化されていて、完全か
3. 事実誤認、矛盾、重大な欠落がないか
4. 納品可能な品質か
5. 回答が日本語で記述されているか

回答が十分な場合: { "passed": true, "notes": "日本語で品質の概要" }
軽微な改善が可能な場合: { "passed": true, "notes": "日本語で改善内容", "revisedResponse": "改善後の回答（日本語）" }
深刻な品質問題がある場合: { "passed": false, "notes": "日本語で問題の説明" }

notes と revisedResponse は日本語で記述してください。

以下のスキーマに従ってJSONを出力してください:
{
  "passed": boolean,
  "notes": "string（日本語）",
  "revisedResponse": "string（日本語、optional）"
}`,
    userContent: `元のリクエスト: ${req.originalPrompt}

レビュー対象の統合回答:
${req.integratedResponse}`,
  });

  log.info('Integration reviewer completed', { passed: result.passed });
  return result;
}
