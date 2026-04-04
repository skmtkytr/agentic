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
ツールが使えない場合は、その旨を正直に報告してください。

★最重要★: ツールでデータを取得した後、必ずその結果を整理して**テキストとして最終回答に含めてください**。
ツールを実行するだけで終わらないでください。取得したデータを分析・整理し、包括的なレポートとして最終テキスト出力に書き出してください。
最終出力が空や1行だけになることは絶対に許容されません。`
    : `\n\n注意: 外部ツールは使用できません。知識の範囲内で回答してください。リアルタイムデータや外部情報が必要な場合は、その旨を明記してください。`;

  // Build task-specific guidance from Planner output
  const task = req.task;
  const taskGuidance = [
    task.purpose ? `目的: ${task.purpose}` : '',
    task.successCriteria?.length ? `成功基準:\n${task.successCriteria.map(c => `- ${c}`).join('\n')}` : '',
    task.outputFormat ? `出力形式: ${task.outputFormat}` : '',
  ].filter(Boolean).join('\n');

  const guidanceSection = taskGuidance ? `\n\nタスク固有の指針:\n${taskGuidance}` : '';

  const intentSection = req.planContext?.userIntent
    ? `\nユーザーの意図: ${req.planContext.userIntent}`
    : '';

  const qualitySection = req.planContext?.qualityGuidelines
    ? `\n品質指針: ${req.planContext.qualityGuidelines}`
    : '';

  let { text, toolUsage } = await callRawText({
    provider: req.provider,
    model: req.model,
    system: `あなたはタスク実行エージェントです。割り当てられたタスクを完遂してください。
ユーザーの元のリクエストはコンテキストとして提供されます。自分に割り当てられたタスクに集中し、高品質で完全な結果を日本語で出力してください。${intentSection}${qualitySection}${toolInstruction}${contextSection}`,
    userContent: `元のリクエスト: ${req.originalPrompt}\n\nあなたのタスク: ${task.description}${guidanceSection}\n\nこのタスクを日本語で徹底的に完遂してください。`,
    allowedTools: req.allowedTools,
  });

  // Fallback: if LLM returned empty text but used tools, construct result from tool outputs
  if (!text.trim() && toolUsage.length > 0) {
    log.warn('Executor produced empty text with tool usage, constructing fallback result', {
      taskId: req.task.id,
      toolCount: toolUsage.length,
    });
    text = `# ${task.description}\n\n以下のツールを使用してデータを取得しました。\n\n${toolUsage
      .map(
        (t) =>
          `## ${t.tool}: ${t.input}\n\n${t.output}`,
      )
      .join('\n\n---\n\n')}`;
  }

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
