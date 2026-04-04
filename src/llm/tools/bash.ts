import { execSync } from 'node:child_process';
import type { ToolHandler } from './types';

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 10_000;

export const bashTool: ToolHandler = {
  definition: {
    name: 'Bash',
    description:
      'Execute a shell command and return its stdout/stderr. ' +
      'Use this for running scripts, system commands, file operations, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },

  async execute(input: Record<string, unknown>): Promise<string> {
    const command = String(input.command ?? '');
    if (!command) return 'Error: command is required';

    try {
      const result = execSync(command, {
        encoding: 'utf-8',
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.slice(0, MAX_OUTPUT);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'stderr' in err) {
        const e = err as { stderr?: string; stdout?: string; status?: number };
        const output = [
          e.stdout ? `stdout: ${e.stdout}` : '',
          e.stderr ? `stderr: ${e.stderr}` : '',
          `exit code: ${e.status ?? 'unknown'}`,
        ]
          .filter(Boolean)
          .join('\n');
        return output.slice(0, MAX_OUTPUT);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  },
};
