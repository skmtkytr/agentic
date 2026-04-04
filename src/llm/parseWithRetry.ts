import { z } from 'zod';
import { log } from '@temporalio/activity';
import type { ToolUsageRecord } from '../types/agents';
import { registry } from './providerRegistry';

export interface LLMCallOptions {
  provider?: string;
  model?: string;
  system: string;
  userContent: string;
  allowedTools?: string[];
}

export interface RawTextResult {
  text: string;
  toolUsage: ToolUsageRecord[];
}

/** LLM returned invalid JSON. Retryable since LLM output is non-deterministic. */
export class JSONParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JSONParseError';
  }
}

/** LLM output doesn't match expected schema. Retryable since LLM output is non-deterministic. */
export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

// --- Public API ---

/**
 * Call the LLM, parse the response as JSON, and validate against a Zod schema.
 * JSON parse and schema validation failures are retryable since LLM output
 * is non-deterministic and may produce valid output on retry.
 */
export async function callStructured<T extends z.ZodTypeAny>(
  schema: T,
  opts: LLMCallOptions,
): Promise<z.infer<T>> {
  const provider = registry.get(opts.provider);
  const { text: resultText } = await provider.call({
    model: opts.model,
    system: opts.system,
    prompt:
      opts.userContent +
      '\n\nYou MUST respond with ONLY valid JSON. No explanations, no markdown code blocks, just raw JSON.',
    jsonMode: !opts.allowedTools?.length,
    allowedTools: opts.allowedTools,
  });

  if (!resultText) {
    // Empty result may be transient (rate limit, timeout) — allow retry
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
    log.warn('JSON parse failed, will retry', { preview: cleaned.slice(0, 300) });
    throw new JSONParseError(`JSON parse failed: ${(parseErr as Error).message}`);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    log.warn('Schema validation failed, will retry', { errors: result.error.issues });
    throw new SchemaValidationError(`Schema validation failed: ${result.error.message}`);
  }

  return result.data;
}

/**
 * Call the LLM and return plain text + tool usage records.
 */
export async function callRawText(opts: LLMCallOptions): Promise<RawTextResult> {
  const provider = registry.get(opts.provider);
  return provider.call({
    model: opts.model,
    system: opts.system,
    prompt: opts.userContent,
    allowedTools: opts.allowedTools,
  });
}
