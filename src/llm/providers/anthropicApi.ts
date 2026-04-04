import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMProviderCallOptions, LLMProviderResult } from '../provider';

export interface AnthropicApiProviderOptions {
  /** Provider name for registry (default: 'anthropic-api') */
  name?: string;
  /** API key (default: ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  /** Base URL — set to LM Studio endpoint for local LLM (e.g. 'http://localhost:1234') */
  baseURL?: string;
  /** Default model when not specified per-call */
  defaultModel?: string;
  maxTokens?: number;
}

export class AnthropicApiProvider implements LLMProvider {
  readonly name: string;
  private client: Anthropic;
  private defaultModel: string;
  private maxTokens: number;

  constructor(opts?: AnthropicApiProviderOptions) {
    this.name = opts?.name ?? 'anthropic-api';
    this.defaultModel = opts?.defaultModel ?? 'claude-sonnet-4-6';
    this.maxTokens = opts?.maxTokens ?? 8192;
    this.client = new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? 'local-llm',
      ...(opts?.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async call(opts: LLMProviderCallOptions): Promise<LLMProviderResult> {
    const response = await this.client.messages.create({
      model: opts.model ?? this.defaultModel,
      max_tokens: this.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!text && response.content.length === 0) {
      throw new Error(
        `LLM returned empty content (model: ${opts.model ?? this.defaultModel}). ` +
        'Reasoning models may need a higher maxTokens to finish both thinking and output.',
      );
    }

    return { text, toolUsage: [] };
  }
}
