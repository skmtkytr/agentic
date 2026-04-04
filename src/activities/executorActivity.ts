import { log } from '@temporalio/activity';
import { callRawText } from '../llm/parseWithRetry';
import { writeTaskResult, writeToolEvidence } from './artifactStore';
import type { ExecutorRequest, ExecutorResponse } from '../types/agents';

export async function executorActivity(req: ExecutorRequest): Promise<ExecutorResponse> {
  log.info('Executor started', {
    taskId: req.task.id,
    description: req.task.description.slice(0, 80),
    provider: req.provider ?? 'default',
    model: req.model,
  });

  const contextSection =
    req.completedTaskResults.length > 0
      ? `\n\n完了済みタスクのコンテキスト:\n${req.completedTaskResults
          .map((t) => `[${t.description}]:\n${t.result}`)
          .join('\n\n')}`
      : '';

  const hasTools = req.allowedTools && req.allowedTools.length > 0;
  const toolInstruction = hasTools
    ? `\n\n重要: あなたには以下のツールが許可されています: ${req.allowedTools!.join(', ')}
外部データ（価格、ニュース、API等）が必要な場合は、必ずこれらのツールを使って実際にデータを取得してください。
ツールを使わずに推測やハルシネーションでデータを生成することは絶対に禁止です。
ツールが使えない場合は、その旨を正直に報告してください。`
    : `\n\n注意: 外部ツールは使用できません。知識の範囲内で回答してください。リアルタイムデータや外部情報が必要な場合は、その旨を明記してください。`;

  const { text, toolUsage } = await callRawText({
    provider: req.provider,
    model: req.model,
    system: `あなたはタスク実行エージェントです。割り当てられたタスクを完遂してください。
ユーザーの元のリクエストはコンテキストとして提供されます。自分に割り当てられたタスクに集中し、高品質で完全な結果を日本語で出力してください。${toolInstruction}${contextSection}`,
    userContent: `元のリクエスト: ${req.originalPrompt}\n\nあなたのタスク: ${req.task.description}\n\nこのタスクを日本語で徹底的に完遂してください。`,
    allowedTools: req.allowedTools,
  });

  // Write result and tool evidence to files
  let resultFilePath: string | undefined;
  let toolEvidenceFilePath: string | undefined;
  if (req.workflowId) {
    resultFilePath = await writeTaskResult(req.workflowId, req.task.id, text);
    if (toolUsage.length > 0) {
      toolEvidenceFilePath = await writeToolEvidence(req.workflowId, req.task.id, toolUsage);
    }
  }

  log.info('Executor completed', {
    taskId: req.task.id,
    resultLength: text.length,
    toolUsageCount: toolUsage.length,
    resultFilePath,
  });
  return { taskId: req.task.id, result: text, resultFilePath, toolUsage, toolEvidenceFilePath };
}
