import { log } from '@temporalio/activity';
import { callRawText } from '../llm/parseWithRetry';
import { writeIntegratedResult } from './artifactStore';
import type { IntegratorRequest, IntegratorResponse } from '../types/agents';

export async function integratorActivity(req: IntegratorRequest): Promise<IntegratorResponse> {
  log.info('Integrator started', { taskCount: req.reviewedTasks.length, hasFiles: !!req.taskResultFiles?.length, provider: req.provider ?? 'default', model: req.model });

  // Build task section: use file paths if available, otherwise inline results
  let taskResultsSection: string;
  if (req.taskResultFiles && req.taskResultFiles.length > 0) {
    taskResultsSection = req.taskResultFiles
      .map((f) => `### ${f.description}\nRead ツールで以下のファイルを読んでください: ${f.filePath}`)
      .join('\n\n');
  } else {
    taskResultsSection = req.reviewedTasks
      .map((t) => `### ${t.description}\n${t.result ?? '(no result)'}`)
      .join('\n\n');
  }

  const needsReadTool = !!req.taskResultFiles?.length;
  const tools = [...(req.allowedTools ?? [])];
  if (needsReadTool && !tools.includes('Read')) {
    tools.push('Read');
  }

  const { text: integratedResponse } = await callRawText({
    provider: req.provider,
    model: req.model,
    system: `あなたは統合エージェントです。複数のタスクの実行結果を、ユーザーの元のリクエストに直接対応する一貫した高品質な回答に統合してください。

ガイドライン:
- すべてのタスク結果を統一された、流れのある回答にまとめてください
- 冗長な部分を排除し、論理的な流れを確保してください
- 最終的な回答はタスク出力の寄せ集めではなく、一つのまとまった成果物に仕上げてください
- タスク結果に含まれる重要な情報はすべて保持してください
- コンテンツの種類に応じた適切なフォーマットで出力してください（散文、コード、リスト等）
- 回答は日本語で出力してください

情報源の明記（必須）:
- タスク結果に含まれるURL、データソース、参照元は必ず回答に含めてください
- 回答の末尾に「## 情報源」セクションを設け、参照したURLやソースを箇条書きで列挙してください
- 具体的な数値やデータを記載する場合は、そのデータの出典を明記してください
- 情報源が不明なデータは「出典未確認」と注記してください`,
    allowedTools: tools.length > 0 ? tools : undefined,
    userContent: `元のリクエスト: ${req.originalPrompt}

統合対象のタスク実行結果:

${taskResultsSection}

これらの結果を元のリクエストに対する包括的で統一された回答に日本語で統合してください。`,
  });

  // Write integrated result to file
  let integratedResponseFilePath: string | undefined;
  if (req.workflowId) {
    integratedResponseFilePath = await writeIntegratedResult(req.workflowId, integratedResponse);
  }

  log.info('Integrator completed', { responseLength: integratedResponse.length, filePath: integratedResponseFilePath });
  return { integratedResponse, integratedResponseFilePath };
}
