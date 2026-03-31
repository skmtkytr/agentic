import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import { activities } from './activities/index';
import path from 'node:path';

// Claude Code SDK は内部の OAuth 認証を使う。
// ANTHROPIC_API_KEY が環境にあると claude CLI が API キーモードで起動して失敗するため削除する。
delete process.env.ANTHROPIC_API_KEY;

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

  console.log(`Connecting to Temporal at ${address} (namespace: ${namespace})`);

  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    workflowsPath: path.resolve(__dirname, './workflows/agenticWorkflow.ts'),
    activities,
    taskQueue: 'agentic-pipeline',
    maxConcurrentActivityTaskExecutions: 10,
    maxConcurrentWorkflowTaskExecutions: 20,
  });

  console.log('Worker started on task queue: agentic-pipeline');
  console.log('Press Ctrl+C to stop.');

  await worker.run();
}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
