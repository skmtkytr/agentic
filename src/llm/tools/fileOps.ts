import fs from 'node:fs';
import path from 'node:path';
import type { ToolHandler } from './types';

export const readTool: ToolHandler = {
  definition: {
    name: 'Read',
    description:
      'Read a file from the filesystem. Returns the file contents as text. ' +
      'Supports optional offset (line number) and limit (number of lines).',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'integer', description: 'Start reading from this line number (0-based). Optional.' },
        limit: { type: 'integer', description: 'Maximum number of lines to read. Optional.' },
      },
      required: ['file_path'],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const filePath = String(input.file_path ?? '');
    if (!filePath) return 'Error: file_path is required';

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      const offset = typeof input.offset === 'number' ? input.offset : 0;
      const limit = typeof input.limit === 'number' ? input.limit : lines.length;

      return lines.slice(offset, offset + limit).join('\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },
};

export const writeTool: ToolHandler = {
  definition: {
    name: 'Write',
    description:
      'Write content to a file. Creates parent directories if needed. ' +
      'Overwrites the file if it already exists.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const filePath = String(input.file_path ?? '');
    const content = String(input.content ?? '');
    if (!filePath) return 'Error: file_path is required';

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return `Successfully wrote ${content.length} characters to ${filePath}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },
};
