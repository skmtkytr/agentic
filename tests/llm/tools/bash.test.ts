import { bashTool } from '../../../src/llm/tools/bash';

describe('bashTool', () => {
  it('has correct definition', () => {
    expect(bashTool.definition.name).toBe('Bash');
    expect(bashTool.definition.input_schema.required).toContain('command');
  });

  it('executes a simple command', async () => {
    const result = await bashTool.execute({ command: 'echo hello' });
    expect(result.trim()).toBe('hello');
  });

  it('returns error for empty command', async () => {
    const result = await bashTool.execute({});
    expect(result).toContain('Error');
  });

  it('captures stderr on failure', async () => {
    const result = await bashTool.execute({ command: 'ls /nonexistent_dir_12345' });
    expect(result).toContain('No such file or directory');
  });

  it('returns exit code on failure', async () => {
    const result = await bashTool.execute({ command: 'exit 42' });
    expect(result).toContain('42');
  });
});
