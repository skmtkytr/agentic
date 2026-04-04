import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import { activities } from './activities/index';
import { registry } from './llm/providerRegistry';
import { ClaudeAgentProvider } from './llm/providers/claudeAgent';
import { AnthropicApiProvider } from './llm/providers/anthropicApi';
import path from 'node:path';

// Save API key before deleting from env (ClaudeAgentProvider needs it removed,
// but AnthropicApiProvider may need it)
const savedAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

// Claude Code SDK は内部の OAuth 認証を使う。
// ANTHROPIC_API_KEY が環境にあると claude CLI が API キーモードで起動して失敗するため削除する。
delete process.env.ANTHROPIC_API_KEY;

// Register additional providers from environment variables
if (process.env.LOCAL_LLM_BASE_URL) {
  const providerName = process.env.LOCAL_LLM_PROVIDER_NAME ?? 'local-llm';
  const baseURL = process.env.LOCAL_LLM_BASE_URL;
  const apiKey = process.env.LOCAL_LLM_API_KEY ?? 'local-llm';

  // Claude Agent SDK provider with local LLM backend (supports tools, thinking disabled)
  registry.register(new ClaudeAgentProvider({
    name: providerName,
    baseURL,
    apiKey,
    disableThinking: true,
    fallbackModel: process.env.LOCAL_LLM_FALLBACK_MODEL,
  }));
  console.log(`Registered local LLM provider (agent): ${providerName} at ${baseURL}`);

  // Direct Anthropic API provider with native tool support (WebSearch, WebFetch, Read, Write, Bash)
  registry.register(new AnthropicApiProvider({
    name: `${providerName}-direct`,
    baseURL,
    defaultModel: process.env.LOCAL_LLM_MODEL ?? 'default',
    apiKey,
    enableTools: true,
  }));
  console.log(`Registered local LLM provider (direct+tools): ${providerName}-direct at ${baseURL}`);
}

if (savedAnthropicApiKey) {
  registry.register(new AnthropicApiProvider({
    name: 'anthropic-api',
    apiKey: savedAnthropicApiKey,
  }));
  console.log('Registered anthropic-api provider');
}

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

  console.log(`Connecting to Temporal at ${address} (namespace: ${namespace})`);
  console.log(`Registered providers: ${['claude-agent', ...(process.env.LOCAL_LLM_BASE_URL ? [process.env.LOCAL_LLM_PROVIDER_NAME ?? 'local-llm'] : []), ...(savedAnthropicApiKey ? ['anthropic-api'] : [])].join(', ')}`);

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
