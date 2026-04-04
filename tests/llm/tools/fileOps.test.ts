import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTool, writeTool } from '../../../src/llm/tools/fileOps';

describe('readTool', () => {
  it('has correct definition', () => {
    expect(readTool.definition.name).toBe('Read');
    expect(readTool.definition.input_schema.required).toContain('file_path');
  });

  it('reads a file', async () => {
    const tmpFile = path.join(os.tmpdir(), `agentic-test-read-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'line1\nline2\nline3\n');

    try {
      const result = await readTool.execute({ file_path: tmpFile });
      expect(result).toContain('line1');
      expect(result).toContain('line3');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('supports offset and limit', async () => {
    const tmpFile = path.join(os.tmpdir(), `agentic-test-read-ol-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'a\nb\nc\nd\ne\n');

    try {
      const result = await readTool.execute({ file_path: tmpFile, offset: 1, limit: 2 });
      expect(result).toBe('b\nc');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns error for missing file', async () => {
    const result = await readTool.execute({ file_path: '/nonexistent_file_12345.txt' });
    expect(result).toContain('Error');
  });
});

describe('writeTool', () => {
  it('has correct definition', () => {
    expect(writeTool.definition.name).toBe('Write');
    expect(writeTool.definition.input_schema.required).toContain('file_path');
  });

  it('writes a file and creates directories', async () => {
    const tmpDir = path.join(os.tmpdir(), `agentic-test-write-${Date.now()}`);
    const tmpFile = path.join(tmpDir, 'sub', 'test.txt');

    try {
      const result = await writeTool.execute({ file_path: tmpFile, content: 'hello world' });
      expect(result).toContain('Successfully wrote');
      expect(fs.readFileSync(tmpFile, 'utf-8')).toBe('hello world');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
