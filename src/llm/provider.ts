import type { ToolUsageRecord } from '../types/agents';

/**
 * LLM provider interface.
 * Implement this to plug in different LLM backends (Claude Agent SDK, Anthropic API, OpenAI, etc.)
 */
export interface LLMProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Whether this provider supports tool use (e.g. Read, Bash, WebFetch). Default: false */
  readonly supportsTools?: boolean;

  /**
   * Call the LLM and return plain text + tool usage records.
   * This is the core method that all providers must implement.
   */
  call(opts: LLMProviderCallOptions): Promise<LLMProviderResult>;
}

export interface LLMProviderCallOptions {
  model?: string;
  system: string;
  prompt: string;
  allowedTools?: string[];
  /** If true, instruct the LLM to return only valid JSON */
  jsonMode?: boolean;
}

export interface LLMProviderResult {
  text: string;
  toolUsage: ToolUsageRecord[];
}
