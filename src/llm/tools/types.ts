import type Anthropic from '@anthropic-ai/sdk';

export interface ToolHandler {
  /** Anthropic API tool definition */
  definition: Anthropic.Tool;
  /** Execute the tool and return result as string */
  execute(input: Record<string, unknown>): Promise<string>;
}
