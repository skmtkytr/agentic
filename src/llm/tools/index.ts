import type { ToolHandler } from './types';
import { webSearchTool } from './webSearch';
import { webFetchTool } from './webFetch';
import { readTool, writeTool } from './fileOps';
import { bashTool } from './bash';

export type { ToolHandler } from './types';

/** All available native tool implementations */
const ALL_TOOLS: Map<string, ToolHandler> = new Map([
  ['WebSearch', webSearchTool],
  ['WebFetch', webFetchTool],
  ['Read', readTool],
  ['Write', writeTool],
  ['Bash', bashTool],
]);

/**
 * Get tool handlers for the given allowed tool names.
 * Only returns handlers for tools that have native implementations.
 */
export function getToolHandlers(allowedTools?: string[]): Map<string, ToolHandler> {
  if (!allowedTools || allowedTools.length === 0) return new Map();
  const result = new Map<string, ToolHandler>();
  for (const name of allowedTools) {
    const handler = ALL_TOOLS.get(name);
    if (handler) result.set(name, handler);
  }
  return result;
}

/** Names of all tools with native implementations */
export const NATIVE_TOOL_NAMES = [...ALL_TOOLS.keys()];
