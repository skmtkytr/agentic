import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { log } from '@temporalio/activity';
import type { ToolUsageRecord } from '../types/agents';

export interface LLMCallOptions {
  model?: string;
  system: string;
  userContent: string;
  allowedTools?: string[];
}

export interface RawTextResult {
  text: string;
  toolUsage: ToolUsageRecord[];
}

/**
 * Claude Code SDK の query() でモデルを呼び出し、レスポンスを Zod スキーマで検証して返す。
 * JSON parse / schema validation 失敗時は Error を throw → Temporal が activity をリトライする。
 */
export async function callStructured<T extends z.ZodTypeAny>(
  schema: T,
  opts: LLMCallOptions,
): Promise<z.infer<T>> {
  let resultText = '';

  for await (const message of query({
    prompt:
      opts.userContent +
      '\n\nYou MUST respond with ONLY valid JSON. No explanations, no markdown code blocks, just raw JSON.',
    options: {
      systemPrompt: opts.system,
      tools: [],
      permissionMode: 'dontAsk',
      ...(opts.model ? { model: opts.model } : {}),
    },
  })) {
    if ('result' in message) {
      resultText = message.result;
    }
  }

  if (!resultText) {
    throw new Error('Agent SDK returned empty result');
  }

  // Claude がたまに markdown コードフェンスで包む場合に対応
  const cleaned = resultText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch (parseErr) {
    log.warn('JSON parse failed, activity will retry', { preview: cleaned.slice(0, 300) });
    throw new Error(`JSON parse failed: ${(parseErr as Error).message}`);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    log.warn('Schema validation failed, activity will retry', { errors: result.error.issues });
    throw new Error(`Schema validation failed: ${result.error.message}`);
  }

  return result.data;
}

/**
 * Claude Code SDK の query() でモデルを呼び出し、プレーンテキストとツール使用記録を返す。
 * executor / integrator など JSON が不要なケースに使う。
 */
export async function callRawText(opts: LLMCallOptions): Promise<RawTextResult> {
  let resultText = '';
  const toolUsage: ToolUsageRecord[] = [];

  // Pending tool_use calls waiting for their tool_result
  const pendingTools = new Map<string, { tool: string; input: string; timestamp: number }>();

  const hasTools = opts.allowedTools && opts.allowedTools.length > 0;

  for await (const message of query({
    prompt: opts.userContent,
    options: {
      systemPrompt: opts.system,
      ...(hasTools
        ? { allowedTools: opts.allowedTools, permissionMode: 'dontAsk' as const }
        : { tools: [], permissionMode: 'dontAsk' as const }),
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
