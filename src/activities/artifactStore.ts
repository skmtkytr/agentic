import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_BASE_DIR = process.env.ARTIFACT_DIR ?? path.join(os.tmpdir(), 'agentic');

export function getArtifactDir(baseDir: string, workflowId: string): string {
  return path.join(baseDir, workflowId);
}

export async function writeArtifact(
  baseDir: string,
  workflowId: string,
  taskId: string,
  filename: string,
  content: string,
): Promise<string> {
  const dir = path.join(baseDir, workflowId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Write executor result to file and return the path.
 * Used by executor activity to persist large results.
 */
export async function writeTaskResult(
  workflowId: string,
  taskId: string,
  result: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<string> {
  return writeArtifact(baseDir, workflowId, taskId, 'result.md', result);
}

/**
 * Write tool evidence to file and return the path.
 */
export async function writeToolEvidence(
  workflowId: string,
  taskId: string,
  evidence: unknown[],
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<string> {
  return writeArtifact(baseDir, workflowId, taskId, 'tool-evidence.json', JSON.stringify(evidence, null, 2));
}

/**
 * Write integrated response to file and return the path.
 */
export async function writeIntegratedResult(
  workflowId: string,
  content: string,
  baseDir: string = DEFAULT_BASE_DIR,
): Promise<string> {
  return writeArtifact(baseDir, workflowId, '_integrated', 'response.md', content);
}
