import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { ReviewerResultSchema } from '../types/schemas';
import type { ReviewerRequest, ReviewerResponse } from '../types/agents';

export async function reviewerActivity(req: ReviewerRequest): Promise<ReviewerResponse> {
  log.info('Reviewer started', { taskId: req.task.id, hasFilePath: !!req.resultFilePath });

  // If file path available, instruct LLM to read file instead of embedding full text
  const resultSection = req.resultFilePath
    ? `実行結果はファイルに保存されています。Read ツールで以下のファイルを読んでからレビューしてください:\n${req.resultFilePath}`
    : `レビュー対象の実行結果:\n${req.result}`;

  const toolEvidenceSection = req.toolUsage && req.toolUsage.length > 0
    ? `\nツール使用の証跡:\n${req.toolUsage.map((t) => `- ${t.tool}: 入力="${t.input}" → 出力="${t.output.slice(0, 200)}"`).join('\n')}`
    : '';

  const result = await callStructured(ReviewerResultSchema, {
    model: req.model,
    // Allow Read tool so LLM can read the result file
    allowedTools: req.resultFilePath ? ['Read'] : undefined,
    system: `あなたは品質レビューエージェントです。タスクの実行結果が完全かつ正確かを評価してください。

評価基準:
1. タスクの説明に対して結果が十分に対応しているか
2. 結果が正確で論理的に妥当か
3. 明らかなエラーや欠落がないか
4. ツール使用が必要なタスクの場合、実際にツールで取得したデータに基づいているか（ハルシネーションではないか）

結果が許容可能な場合: { "passed": true, "notes": "日本語で品質サマリー" }
軽微な問題を修正できる場合: { "passed": true, "notes": "日本語で修正内容", "revisedResult": "修正後の結果（日本語）" }
根本的に不十分な場合: { "passed": false, "notes": "日本語で問題の説明" }

重要な制約:
- notes の値は**必ず日本語**で書いてください。英語で書かないでください。
- revisedResult を含める場合も**必ず日本語**で書いてください。
- キー名（taskId, passed, notes, revisedResult）は英語のままにしてください。

以下のスキーマに**厳密に**従ってJSONを出力してください:
{
  "taskId": "string",
  "passed": boolean,
  "notes": "string（日本語で記述）",
  "revisedResult": "string（日本語で記述、optional）"
}`,
    userContent: `元のリクエスト: ${req.originalPrompt}

タスク: ${req.task.description}

${resultSection}
${toolEvidenceSection}
タスクID: ${req.task.id}`,
  });

  log.info('Reviewer completed', { taskId: req.task.id, passed: result.passed });
  return {
    taskId: result.taskId || req.task.id,
    passed: result.passed,
    notes: result.notes,
    revisedResult: result.revisedResult,
  };
}
