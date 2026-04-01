import type { Task, TaskPlan, ValidationResult } from './task';

export interface ToolUsageRecord {
  tool: string;
  input: string;
  output: string;
  timestamp: number;
}

export interface ToolEvidenceEntry {
  taskDescription: string;
  tool: string;
  input: string;
  output: string;
}

export interface PlannerRequest {
  prompt: string;
  model: string;
}

export interface PlannerResponse {
  plan: TaskPlan;
}

export interface ValidatorRequest {
  plan: TaskPlan;
  model: string;
}

export interface ValidatorResponse {
  result: ValidationResult;
}

export interface ExecutorRequest {
  task: Task;
  completedTaskResults: Array<{ taskId: string; description: string; result: string }>;
  originalPrompt: string;
  model: string;
  allowedTools?: string[];
  workflowId?: string;
}

export interface ExecutorResponse {
  taskId: string;
  result: string;
  resultFilePath?: string;
  toolUsage?: ToolUsageRecord[];
  toolEvidenceFilePath?: string;
}

export interface ReviewerRequest {
  task: Task;
  result: string;
  resultFilePath?: string;
  originalPrompt: string;
  model: string;
  toolUsage?: ToolUsageRecord[];
}

export interface ReviewerResponse {
  taskId: string;
  passed: boolean;
  notes: string;
  revisedResult?: string;
}

export interface IntegratorRequest {
  originalPrompt: string;
  reviewedTasks: Task[];
  taskResultFiles?: Array<{ taskId: string; description: string; filePath: string }>;
  model: string;
  allowedTools?: string[];
  workflowId?: string;
}

export interface IntegratorResponse {
  integratedResponse: string;
  integratedResponseFilePath?: string;
}

export interface IntegrationReviewerRequest {
  originalPrompt: string;
  integratedResponse: string;
  integratedResponseFilePath?: string;
  model: string;
  toolEvidence?: ToolEvidenceEntry[];
}

export interface ReviewScore {
  completeness: number;
  accuracy: number;
  structure: number;
  actionability: number;
  overall: number;
}

export interface IntegrationReviewerResponse {
  passed: boolean;
  notes: string;
  score: ReviewScore;
  strengths: string[];
  improvements: string[];
  revisedResponse?: string;
}
