import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { log } from '@temporalio/activity';

export interface LLMCallOptions {
  model?: string;
  system: string;
  userContent: string;
  allowedTools?: string[];
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
 * Claude Code SDK の query() でモデルを呼び出し、プレーンテキストを返す。
 * executor / integrator など JSON が不要なケースに使う。
 */
export async function callRawText(opts: LLMCallOptions): Promise<string> {
  let resultText = '';

  const hasTools = opts.allowedTools && opts.allowedTools.length > 0;

  for await (const message of query({
    prompt: opts.userContent,
    options: {
      systemPrompt: opts.system,
      // tools: available tool set. Empty = no tools visible to Claude.
      // allowedTools: pre-approved subset. permissionMode dontAsk = deny unapproved.
      ...(hasTools
        ? { allowedTools: opts.allowedTools, permissionMode: 'dontAsk' as const }
        : { tools: [], permissionMode: 'dontAsk' as const }),
      ...(opts.model ? { model: opts.model } : {}),
    },
  })) {
    if ('result' in message) {
      resultText = message.result;
    }
  }

  return resultText;
}
