import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, LLMProviderCallOptions, LLMProviderResult } from '../provider';
import type { ToolUsageRecord } from '../../types/agents';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface ClaudeAgentProviderOptions {
  /** Provider name for registry (default: 'claude-agent') */
  name?: string;
  timeoutMs?: number;
  /** Override the Anthropic API base URL (e.g. local LLM endpoint).
   *  Passed as ANTHROPIC_BASE_URL env var to the claude CLI subprocess. */
  baseURL?: string;
  /** API key to use. Passed as ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Disable thinking/reasoning for models that don't support it (e.g. local LLMs). */
  disableThinking?: boolean;
}

/**
 * LLM provider using Claude Agent SDK (claude CLI subprocess).
 * Uses Claude Code's OAuth session for authentication by default.
 * Can be pointed at alternative Anthropic-compatible endpoints via baseURL.
 * Includes a timeout to prevent hung subprocesses from blocking indefinitely.
 */
export class ClaudeAgentProvider implements LLMProvider {
  readonly name: string;
  readonly timeoutMs: number;
  private envOverrides: Record<string, string>;
  private disableThinking: boolean;

  constructor(opts?: ClaudeAgentProviderOptions) {
    this.name = opts?.name ?? 'claude-agent';
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.disableThinking = opts?.disableThinking ?? false;
    this.envOverrides = {};
    if (opts?.baseURL) {
      this.envOverrides.ANTHROPIC_BASE_URL = opts.baseURL;
    }
    if (opts?.apiKey) {
      this.envOverrides.ANTHROPIC_API_KEY = opts.apiKey;
    }
  }

  async call(opts: LLMProviderCallOptions): Promise<LLMProviderResult> {
    return Promise.race([
      this._call(opts),
      this._timeout(),
    ]);
  }

  private _timeout(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Claude Agent SDK call timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
  }

  private async _call(opts: LLMProviderCallOptions): Promise<LLMProviderResult> {
    let resultText = '';
    const toolUsage: ToolUsageRecord[] = [];
    const pendingTools = new Map<string, { tool: string; input: string; timestamp: number }>();

    const hasTools = opts.allowedTools && opts.allowedTools.length > 0;

    const envOption = Object.keys(this.envOverrides).length > 0
      ? { env: { ...process.env, ...this.envOverrides } }
      : {};

    for await (const message of query({
      prompt: opts.prompt,
      options: {
        systemPrompt: opts.system,
        ...(opts.jsonMode || !hasTools
          ? { tools: [], permissionMode: 'dontAsk' as const }
          : { allowedTools: opts.allowedTools, permissionMode: 'dontAsk' as const }),
        ...(opts.model ? { model: opts.model } : {}),
        ...(this.disableThinking ? { thinking: { type: 'disabled' as const } } : {}),
        ...envOption,
      },
    })) {
      if ('result' in message) {
        resultText = message.result;
      }

      const msg = message as any;
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            const inputStr = typeof block.input === 'string'
              ? block.input
              : (block.input?.url ?? block.input?.command ?? JSON.stringify(block.input));
            pendingTools.set(block.id, {
              tool: block.name,
              input: inputStr,
              timestamp: Date.now(),
            });
          }
        }
      }

      if (msg.type === 'user' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const pending = pendingTools.get(block.tool_use_id);
            if (pending) {
              const outputStr = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content);
              toolUsage.push({
                tool: pending.tool,
                input: pending.input,
                output: outputStr.slice(0, 500),
                timestamp: pending.timestamp,
              });
              pendingTools.delete(block.tool_use_id);
            }
          }
        }
      }
    }

    return { text: resultText, toolUsage };
  }
}
