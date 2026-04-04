import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMProviderCallOptions, LLMProviderResult } from '../provider';
import type { ToolUsageRecord } from '../../types/agents';
import { getToolHandlers, type ToolHandler } from '../tools/index';

const MAX_TOOL_ROUNDS = 30;

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
  /** Enable native tool execution loop (WebSearch, WebFetch, Read, Write, Bash).
   *  When true and allowedTools are provided, this provider executes tools natively
   *  instead of relying on the Claude CLI. */
  enableTools?: boolean;
}

export class AnthropicApiProvider implements LLMProvider {
  readonly name: string;
  private client: Anthropic;
  private defaultModel: string;
  private maxTokens: number;
  private enableTools: boolean;

  constructor(opts?: AnthropicApiProviderOptions) {
    this.name = opts?.name ?? 'anthropic-api';
    this.defaultModel = opts?.defaultModel ?? 'claude-sonnet-4-6';
    this.maxTokens = opts?.maxTokens ?? 8192;
    this.enableTools = opts?.enableTools ?? false;
    this.client = new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? 'local-llm',
      ...(opts?.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async call(opts: LLMProviderCallOptions): Promise<LLMProviderResult> {
    const handlers = this.enableTools ? getToolHandlers(opts.allowedTools) : new Map();

    if (handlers.size > 0 && !opts.jsonMode) {
      return this.callWithTools(opts, handlers);
    }
    return this.callSimple(opts);
  }

  /** Simple call without tool use (original behavior) */
  private async callSimple(opts: LLMProviderCallOptions): Promise<LLMProviderResult> {
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

  /** Call with tool-use loop: model can use tools, we execute them and feed results back */
  private async callWithTools(
    opts: LLMProviderCallOptions,
    handlers: Map<string, ToolHandler>,
  ): Promise<LLMProviderResult> {
    const toolDefs = [...handlers.values()].map((h) => h.definition);
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.prompt }];
    const toolUsage: ToolUsageRecord[] = [];
    let finalText = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.client.messages.create({
        model: opts.model ?? this.defaultModel,
        max_tokens: this.maxTokens,
        system: opts.system,
        messages,
        tools: toolDefs,
      });

      // Collect text from this response
      const textParts: string[] = [];
      const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({ id: block.id, name: block.name, input: block.input });
        }
        // thinking blocks are ignored (local LLM with disableThinking)
      }

      if (textParts.length > 0) {
        finalText = textParts.join('');
      }

      // If no tool use or stop_reason is end_turn, we're done
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        break;
      }

      // Add assistant message to conversation
      // Cast content to work with both ContentBlock and ContentBlockParam
      messages.push({
        role: 'assistant',
        content: response.content as unknown as Anthropic.ContentBlockParam[],
      });

      // Execute tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const handler = handlers.get(toolUse.name);
        let output: string;

        if (handler) {
          try {
            const inp = (toolUse.input && typeof toolUse.input === 'object')
              ? toolUse.input as Record<string, unknown>
              : {};
            output = await handler.execute(inp);
          } catch (err: unknown) {
            output = `Error executing ${toolUse.name}: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          output = `Error: Tool "${toolUse.name}" is not available. Available tools: ${[...handlers.keys()].join(', ')}`;
        }

        const inputStr = toolUse.input && typeof toolUse.input === 'object'
          ? ((toolUse.input as Record<string, unknown>).query as string)
            ?? ((toolUse.input as Record<string, unknown>).url as string)
            ?? ((toolUse.input as Record<string, unknown>).command as string)
            ?? ((toolUse.input as Record<string, unknown>).file_path as string)
            ?? JSON.stringify(toolUse.input)
          : String(toolUse.input);

        toolUsage.push({
          tool: toolUse.name,
          input: inputStr,
          output: output.slice(0, 500),
          timestamp: Date.now(),
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: output,
        });
      }

      // Add tool results to conversation
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText) {
      throw new Error('LLM returned no text after tool-use loop');
    }

    return { text: finalText, toolUsage };
  }
}
