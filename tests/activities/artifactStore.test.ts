import { writeArtifact, readArtifact, getArtifactDir } from '../../src/activities/artifactStore';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('artifactStore', () => {
  const workflowId = 'test-wf-123';
  let baseDir: string;

  beforeEach(() => {
    baseDir = path.join(os.tmpdir(), 'agentic-test-' + Date.now());
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes and reads an artifact file', async () => {
    const filePath = await writeArtifact(baseDir, workflowId, 'task-1', 'result.md', '# Hello\nWorld');
    expect(fs.existsSync(filePath)).toBe(true);

    const content = await readArtifact(filePath);
    expect(content).toBe('# Hello\nWorld');
  });

  it('creates nested directories', async () => {
    const filePath = await writeArtifact(baseDir, workflowId, 'task-2', 'result.md', 'data');
    expect(filePath).toContain(workflowId);
    expect(filePath).toContain('task-2');
  });

  it('returns correct artifact directory', () => {
    const dir = getArtifactDir(baseDir, workflowId);
    expect(dir).toBe(path.join(baseDir, workflowId));
  });

  it('overwrites existing artifact', async () => {
    await writeArtifact(baseDir, workflowId, 'task-1', 'result.md', 'old');
    await writeArtifact(baseDir, workflowId, 'task-1', 'result.md', 'new');
    const content = await readArtifact(path.join(baseDir, workflowId, 'task-1', 'result.md'));
    expect(content).toBe('new');
  });

  it('writes tool evidence as JSON', async () => {
    const evidence = [{ tool: 'WebFetch', input: 'https://example.com', output: '{}', timestamp: 123 }];
    const filePath = await writeArtifact(baseDir, workflowId, 'task-1', 'tool-evidence.json', JSON.stringify(evidence, null, 2));
    const content = JSON.parse(await readArtifact(filePath));
    expect(content).toHaveLength(1);
    expect(content[0].tool).toBe('WebFetch');
  });
});
