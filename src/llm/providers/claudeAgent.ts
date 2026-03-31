import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LLMProvider, LLMProviderCallOptions, LLMProviderResult } from '../provider';
import type { ToolUsageRecord } from '../../types/agents';

/**
 * LLM provider using Claude Agent SDK (claude CLI subprocess).
 * Uses Claude Code's OAuth session for authentication.
 */
export class ClaudeAgentProvider implements LLMProvider {
  readonly name = 'claude-agent';

  async call(opts: LLMProviderCallOptions): Promise<LLMProviderResult> {
    let resultText = '';
    const toolUsage: ToolUsageRecord[] = [];
    const pendingTools = new Map<string, { tool: string; input: string; timestamp: number }>();

    const hasTools = opts.allowedTools && opts.allowedTools.length > 0;

    for await (const message of query({
      prompt: opts.prompt,
      options: {
        systemPrompt: opts.system,
        ...(opts.jsonMode || !hasTools
          ? { tools: [], permissionMode: 'dontAsk' as const }
          : { allowedTools: opts.allowedTools, permissionMode: 'dontAsk' as const }),
        ...(opts.model ? { model: opts.model } : {}),
      },
    })) {
      if ('result' in message) {
        resultText = message.result;
      }

      // Extract tool usage from assistant messages
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

      // Match tool_result to pending tool_use
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
