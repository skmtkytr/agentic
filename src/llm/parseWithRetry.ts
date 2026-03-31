import { z } from 'zod';
import { log } from '@temporalio/activity';
import type { ToolUsageRecord } from '../types/agents';
import type { LLMProvider } from './provider';
import { ClaudeAgentProvider } from './providers/claudeAgent';

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

// --- Provider management ---

let currentProvider: LLMProvider = new ClaudeAgentProvider();

/** Set the LLM provider. Pass undefined to reset to default (Claude Agent SDK). */
export function setProvider(provider: LLMProvider): void {
  currentProvider = provider ?? new ClaudeAgentProvider();
}

/** Get the current LLM provider. */
export function getProvider(): LLMProvider {
  return currentProvider;
}

// --- Public API ---

/**
 * Call the LLM, parse the response as JSON, and validate against a Zod schema.
 * Throws on parse/validation failure → Temporal retries the activity.
 */
export async function callStructured<T extends z.ZodTypeAny>(
  schema: T,
  opts: LLMCallOptions,
): Promise<z.infer<T>> {
  const { text: resultText } = await currentProvider.call({
    model: opts.model,
    system: opts.system,
    prompt:
      opts.userContent +
      '\n\nYou MUST respond with ONLY valid JSON. No explanations, no markdown code blocks, just raw JSON.',
    jsonMode: true,
  });

  if (!resultText) {
    throw new Error('LLM returned empty result');
  }

  // Strip markdown code fences
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
 * Call the LLM and return plain text + tool usage records.
 */
export async function callRawText(opts: LLMCallOptions): Promise<RawTextResult> {
  return currentProvider.call({
    model: opts.model,
    system: opts.system,
    prompt: opts.userContent,
    allowedTools: opts.allowedTools,
  });
}
