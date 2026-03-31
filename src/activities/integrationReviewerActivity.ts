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
  log.info('Integration reviewer started', {
    responseLength: req.integratedResponse.length,
    toolEvidenceCount: req.toolEvidence?.length ?? 0,
  });

  // Truncate long responses to avoid exceeding context limits
  const MAX_RESPONSE_CHARS = 15000;
  let responseForReview = req.integratedResponse;
  let truncated = false;
  if (responseForReview.length > MAX_RESPONSE_CHARS) {
    truncated = true;
    responseForReview = responseForReview.slice(0, MAX_RESPONSE_CHARS) + '\n\n[... 以下省略（全文が長すぎるため先頭部分のみレビュー対象）...]';
    log.warn('Integrated response truncated for review', {
      original: req.integratedResponse.length,
      truncated: responseForReview.length,
    });
  }

  // Limit tool evidence to summary
  const MAX_EVIDENCE = 10;
  const toolEvidenceSection = req.toolEvidence && req.toolEvidence.length > 0
    ? `\nツール使用証跡 (${req.toolEvidence.length}件):\n${req.toolEvidence.slice(0, MAX_EVIDENCE).map((e) => `- [${e.taskDescription.slice(0, 40)}] ${e.tool}: ${e.input.slice(0, 60)}`).join('\n')}${req.toolEvidence.length > MAX_EVIDENCE ? `\n... 他${req.toolEvidence.length - MAX_EVIDENCE}件` : ''}`
    : '';

  const result = await callStructured(IntegrationReviewerResultSchema, {
    model: req.model,
    system: `あなたは最終品質保証エージェントです。統合された回答がユーザーの元のリクエストに対して適切かを最終レビューしてください。${truncated ? '\n\n注意: 回答が非常に長いため、先頭部分のみ提示されています。構造・品質・方向性を中心にレビューしてください。' : ''}

チェック項目:
1. 回答が元のリクエストに対して完全かつ正確に対応しているか
2. 回答が一貫性があり、構造化されていて、完全か
3. 事実誤認、矛盾、重大な欠落がないか
4. 納品可能な品質か
5. 回答が日本語で記述されているか

回答が十分な場合: { "passed": true, "notes": "日本語で品質の概要" }
軽微な改善が可能な場合: { "passed": true, "notes": "日本語で改善内容", "revisedResponse": "改善後の回答（日本語）" }
深刻な品質問題がある場合: { "passed": false, "notes": "日本語で問題の説明" }

重要な制約:
- notes の値は**必ず日本語**で書いてください。英語で書かないでください。
- revisedResponse を含める場合も**必ず日本語**で書いてください。
- キー名（passed, notes, revisedResponse）は英語のままにしてください。

以下のスキーマに**厳密に**従ってJSONを出力してください:
{
  "passed": boolean,
  "notes": "string（日本語で記述）",
  "revisedResponse": "string（日本語で記述、optional）"
}`,
    userContent: `元のリクエスト: ${req.originalPrompt}

レビュー対象の統合回答:
${responseForReview}
${toolEvidenceSection}`,
  });

  log.info('Integration reviewer completed', { passed: result.passed });
  return result;
}
