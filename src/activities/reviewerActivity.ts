import { log } from '@temporalio/activity';
import { callStructured } from '../llm/parseWithRetry';
import { ReviewerResultSchema } from '../types/schemas';
import type { ReviewerRequest, ReviewerResponse } from '../types/agents';

export async function reviewerActivity(req: ReviewerRequest): Promise<ReviewerResponse> {
  log.info('Reviewer started', { taskId: req.task.id, hasFilePath: !!req.resultFilePath, hasEvidenceFile: !!req.toolEvidenceFilePath, provider: req.provider ?? 'default', model: req.model });

  // If file path available, instruct LLM to read file instead of embedding full text
  const resultSection = req.resultFilePath
    ? `実行結果はファイルに保存されています。Read ツールで以下のファイルを読んでからレビューしてください:\n${req.resultFilePath}`
    : `レビュー対象の実行結果:\n${req.result}`;

  // Tool evidence: prefer file (full data) over inline (truncated)
  let toolEvidenceSection = '';
  if (req.toolEvidenceFilePath) {
    toolEvidenceSection = `\nツール使用の証跡ファイル（JSON形式）。Read ツールで読み取り、実行結果のファクトチェックに使用してください:\n${req.toolEvidenceFilePath}`;
  } else if (req.toolUsage && req.toolUsage.length > 0) {
    toolEvidenceSection = `\nツール使用の証跡:\n${req.toolUsage.map((t) => `- ${t.tool}: 入力="${t.input}" → 出力="${t.output.slice(0, 200)}"`).join('\n')}`;
  }

  // Need Read tool if we have file paths to read
  const needsRead = !!(req.resultFilePath || req.toolEvidenceFilePath);

  const result = await callStructured(ReviewerResultSchema, {
    provider: req.provider,
    model: req.model,
    allowedTools: needsRead ? ['Read'] : undefined,
    system: `あなたは品質レビューエージェントです。タスクの実行結果が完全かつ正確かを評価してください。

評価基準:
1. タスクの説明に対して結果が十分に対応しているか
2. 結果が正確で論理的に妥当か
3. 明らかなエラーや欠落がないか
4. ツール使用が必要なタスクの場合、実際にツールで取得したデータに基づいているか（ハルシネーションではないか）
${req.task.successCriteria?.length ? `\nこのタスク固有の成功基準（必ずすべて確認してください）:\n${req.task.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : ''}

## ファクトチェック手順

ツール証跡ファイルが提供されている場合:
1. まず Read ツールでツール証跡ファイル（JSON）を読み取る
2. 各ツール呼び出しの input（何を検索/取得したか）と output（何が返ってきたか）を確認する
3. 実行結果がツール出力に基づいているか、ハルシネーション（ツール出力にないデータの捏造）がないかを検証する
4. ツールがエラーを返している場合、そのデータに依存した記述がないかチェックする

## 判定ルール

結果が許容可能な場合: { "passed": true, "notes": "品質サマリー" }
軽微な問題を修正できる場合: { "passed": true, "notes": "修正内容", "revisedResult": "修正後の結果" }
根本的に不十分な場合: { "passed": false, "notes": "問題の説明と改善指示" }

## ★ reject時のnotes記述ルール（最重要）

passed: false の場合、notes には以下の**3つすべて**を含めてください:
1. **何が不十分か**: 具体的に何が欠けているか・何が間違っているか
2. **なぜ不十分か**: どの成功基準を満たしていないか
3. **次にどうすべきか**: 実行エージェントが次の試行で具体的に何をすべきか（例: 「○○というクエリでWebSearchを実行し、△△のデータを取得すべき」「取得したデータをMarkdown表形式で整理すべき」）

悪い例: 「結果ファイルが空です。基準を満たしていません。」
良い例: 「結果ファイルが空です。ツール証跡からWebSearchで株価データを取得していますが、最終テキスト出力に反映されていません。次回は、取得したデータ（株価○○円、PER○○倍等）をMarkdown形式で整理し、テキストとして出力してください。」

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
    revisedResult: result.revisedResult ?? undefined,
  };
}
