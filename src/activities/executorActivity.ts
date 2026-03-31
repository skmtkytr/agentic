import { log } from '@temporalio/activity';
import { callRawText } from '../llm/parseWithRetry';
import type { ExecutorRequest, ExecutorResponse } from '../types/agents';

export async function executorActivity(req: ExecutorRequest): Promise<ExecutorResponse> {
  log.info('Executor started', {
    taskId: req.task.id,
    description: req.task.description.slice(0, 80),
  });

  const contextSection =
    req.completedTaskResults.length > 0
      ? `\n\nCompleted tasks context:\n${req.completedTaskResults
          .map((t) => `[${t.description}]:\n${t.result}`)
          .join('\n\n')}`
      : '';

  const result = await callRawText({
    model: req.model,
    system: `あなたはタスク実行エージェントです。割り当てられたタスクを完遂してください。
ユーザーの元のリクエストはコンテキストとして提供されます。自分に割り当てられたタスクに集中し、高品質で完全な結果を日本語で出力してください。
ツールを使用してデータを取得した場合は、ソースURL・取得日時を明記してください。${contextSection}`,
    userContent: `元のリクエスト: ${req.originalPrompt}\n\nあなたのタスク: ${req.task.description}\n\nこのタスクを日本語で徹底的に完遂してください。`,
    allowedTools: req.allowedTools,
  });

  log.info('Executor completed', { taskId: req.task.id, resultLength: result.length });
  return { taskId: req.task.id, result };
}
