import { log } from '@temporalio/activity';
import { callRawText } from '../llm/parseWithRetry';
import type { IntegratorRequest, IntegratorResponse } from '../types/agents';

export async function integratorActivity(req: IntegratorRequest): Promise<IntegratorResponse> {
  log.info('Integrator started', { taskCount: req.reviewedTasks.length });

  const taskResultsSection = req.reviewedTasks
    .map((t) => `### ${t.description}\n${t.result ?? '(no result)'}`)
    .join('\n\n');

  const { text: integratedResponse } = await callRawText({
    model: req.model,
    system: `あなたは統合エージェントです。複数のタスクの実行結果を、ユーザーの元のリクエストに直接対応する一貫した高品質な回答に統合してください。

ガイドライン:
- すべてのタスク結果を統一された、流れのある回答にまとめてください
- 冗長な部分を排除し、論理的な流れを確保してください
- 最終的な回答はタスク出力の寄せ集めではなく、一つのまとまった成果物に仕上げてください
- タスク結果に含まれる重要な情報はすべて保持してください
- コンテンツの種類に応じた適切なフォーマットで出力してください（散文、コード、リスト等）
- 回答は日本語で出力してください`,
    allowedTools: req.allowedTools,
    userContent: `元のリクエスト: ${req.originalPrompt}

統合対象のタスク実行結果:

${taskResultsSection}

これらの結果を元のリクエストに対する包括的で統一された回答に日本語で統合してください。`,
  });

  log.info('Integrator completed', { responseLength: integratedResponse.length });
  return { integratedResponse };
}
