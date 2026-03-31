import 'dotenv/config';
import { Client, Connection } from '@temporalio/client';
import { agenticWorkflow, statusQuery } from './workflows/agenticWorkflow';
import type { WorkflowInput } from './types/workflow';
import { randomUUID } from 'node:crypto';

async function main() {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt) {
    console.error('Usage: npm start "<your prompt here>"');
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const workflowId = `agentic-${randomUUID()}`;
  const input: WorkflowInput = {
    prompt,
    model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
    maxParallelTasks: 5,
  };

  console.log(`\nStarting workflow: ${workflowId}`);
  console.log(`Prompt: ${prompt}\n`);

  const handle = await client.workflow.start(agenticWorkflow, {
    taskQueue: 'agentic-pipeline',
    workflowId,
    args: [input],
  });

  // Poll status every 5 seconds while waiting
  const pollInterval = setInterval(async () => {
    try {
      const state = await handle.query(statusQuery);
      console.log(
        `[${new Date().toISOString()}] Phase: ${state.phase} | Tasks: ${state.completedTasks}/${state.totalTasks}` +
          (state.currentlyExecuting.length
            ? ` | Executing: ${state.currentlyExecuting.length} task(s)`
            : ''),
      );
    } catch {
      // Workflow may have completed — ignore query errors
    }
  }, 5000);

  try {
    const result = await handle.result();
    clearInterval(pollInterval);

    console.log('\n========================================');
    console.log('FINAL RESPONSE');
    console.log('========================================\n');
    console.log(result.finalResponse);
    console.log('\n----------------------------------------');
    console.log(`Integration review passed: ${result.integrationReviewPassed}`);
    console.log(`Review notes: ${result.integrationReviewNotes}`);
    console.log(`Total tasks: ${result.tasks.length}`);
    console.log(
      `Passed review: ${result.tasks.filter((t) => t.reviewPassed).length}/${result.tasks.length}`,
    );
    console.log(`Execution time: ${(result.executionTimeMs / 1000).toFixed(1)}s`);
  } catch (err) {
    clearInterval(pollInterval);
    console.error('\nWorkflow failed:', err);
    process.exit(1);
  } finally {
    await connection.close();
  }
}

main();
