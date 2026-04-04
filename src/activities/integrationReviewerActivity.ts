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
  const hasFilePath = !!req.integratedResponseFilePath;
  const hasEvidenceFiles = req.toolEvidenceFilePaths && req.toolEvidenceFilePaths.length > 0;
  log.info('Integration reviewer started', {
    responseLength: req.integratedResponse.length,
    toolEvidenceCount: req.toolEvidence?.length ?? 0,
    toolEvidenceFileCount: req.toolEvidenceFilePaths?.length ?? 0,
    hasFilePath,
    provider: req.provider ?? 'default',
    model: req.model,
  });

  // If file path is available, instruct LLM to read it via Read tool
  const responseSection = hasFilePath
    ? `統合回答はファイルに保存されています。Read ツールで以下のファイルを読んでからレビューしてください:\n${req.integratedResponseFilePath}`
    : (() => {
        const MAX_RESPONSE_CHARS = 15000;
        if (req.integratedResponse.length > MAX_RESPONSE_CHARS) {
          log.warn('Integrated response truncated for review', { original: req.integratedResponse.length });
          return req.integratedResponse.slice(0, MAX_RESPONSE_CHARS) + '\n\n[... 以下省略 ...]';
        }
        return req.integratedResponse;
      })();

  // Tool evidence: prefer files (full data) over inline summary
  let toolEvidenceSection = '';
  if (hasEvidenceFiles) {
    toolEvidenceSection = `\nツール使用の証跡ファイル一覧（各タスクのJSON）。Read ツールで必要に応じて読み取り、統合回答のファクトチェックに使用してください:\n${req.toolEvidenceFilePaths!.map(p => `- ${p}`).join('\n')}`;
  } else if (req.toolEvidence && req.toolEvidence.length > 0) {
    const MAX_EVIDENCE = 10;
    toolEvidenceSection = `\nツール使用証跡 (${req.toolEvidence.length}件):\n${req.toolEvidence.slice(0, MAX_EVIDENCE).map((e) => `- [${e.taskDescription.slice(0, 40)}] ${e.tool}: ${e.input.slice(0, 60)} → ${e.output.slice(0, 100)}`).join('\n')}${req.toolEvidence.length > MAX_EVIDENCE ? `\n... 他${req.toolEvidence.length - MAX_EVIDENCE}件` : ''}`;
  }

  // Need Read tool if we have any file paths
  const needsRead = !!(hasFilePath || hasEvidenceFiles);

  const result = await callStructured(IntegrationReviewerResultSchema, {
    provider: req.provider,
    model: req.model,
    allowedTools: needsRead ? ['Read'] : undefined,
    system: `あなたは最終品質保証エージェントです。統合された回答をユーザーの元のリクエストに対して多角的に評価してください。

## ファクトチェック手順

ツール証跡ファイルが提供されている場合:
1. Read ツールで証跡ファイル（JSON）を読み取る
2. 統合回答に含まれるデータが、ツール出力に基づいているか検証する
3. ツール出力にないデータが統合回答に含まれていないか（ハルシネーション検出）
4. ツールがエラーを返したデータに依存した記述がないかチェックする

## 評価カテゴリ（各1〜5点）:
- completeness: リクエストへの網羅性（全ての要求に対応しているか）
- accuracy: 正確性（事実誤認・矛盾がないか、ソースが明記されているか）
- structure: 構造・読みやすさ（論理的な流れ、Markdown構造、見やすさ）
- actionability: 実用性（ユーザーが次のアクションを取れる具体性があるか）
- overall: 総合評価

判定基準:
- overall 4以上 → passed: true
- overall 3以下 → passed: false

出力内容:
- notes: 全体的な品質評価の要約（日本語）
- strengths: 良かった点を箇条書き（日本語）
- improvements: 改善すべき点を箇条書き（日本語）
- revisedResponse: 深刻な問題があり修正可能な場合のみ含める（日本語）

重要な制約:
- notes, strengths, improvements の値は**必ず日本語**で書いてください
- revisedResponse を含める場合も**必ず日本語**で書いてください
- キー名は英語のままにしてください

以下のスキーマに**厳密に**従ってJSONを出力してください:
{
  "passed": boolean,
  "notes": "string（日本語）",
  "score": {
    "completeness": number（1-5）,
    "accuracy": number（1-5）,
    "structure": number（1-5）,
    "actionability": number（1-5）,
    "overall": number（1-5）
  },
  "strengths": ["string（日本語）"],
  "improvements": ["string（日本語）"],
  "revisedResponse": "string（日本語、optional）"
}`,
    userContent: `元のリクエスト: ${req.originalPrompt}
${req.planContext?.userIntent ? `\nユーザーの意図: ${req.planContext.userIntent}` : ''}
${req.planContext?.qualityGuidelines ? `品質指針: ${req.planContext.qualityGuidelines}` : ''}

レビュー対象の統合回答:
${responseSection}
${toolEvidenceSection}`,
  });

  log.info('Integration reviewer completed', { passed: result.passed });
  return {
    ...result,
    revisedResponse: result.revisedResponse ?? undefined,
  };
}
