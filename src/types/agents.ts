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
}

export interface ExecutorResponse {
  taskId: string;
  result: string;
  toolUsage?: ToolUsageRecord[];
}

export interface ReviewerRequest {
  task: Task;
  result: string;
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
  model: string;
  allowedTools?: string[];
}

export interface IntegratorResponse {
  integratedResponse: string;
}

export interface IntegrationReviewerRequest {
  originalPrompt: string;
  integratedResponse: string;
  model: string;
  toolEvidence?: ToolEvidenceEntry[];
}

export interface IntegrationReviewerResponse {
  passed: boolean;
  notes: string;
  revisedResponse?: string;
}
