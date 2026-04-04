import type { Task, TaskPlan, TaskDesignResult } from './task';

export interface PlanContext {
  userIntent?: string;
  qualityGuidelines?: string;
}

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
  provider?: string;
  allowedTools?: string[];
}

export interface PlannerResponse {
  plan: TaskPlan;
}

export interface TaskDesignerRequest {
  plan: TaskPlan;
  originalPrompt: string;
  model: string;
  provider?: string;
  allowedTools?: string[];
}

export interface TaskDesignerResponse {
  result: TaskDesignResult;
}

export interface ExecutorRequest {
  task: Task;
  completedTaskResults: Array<{ taskId: string; description: string; result: string }>;
  originalPrompt: string;
  model: string;
  provider?: string;
  allowedTools?: string[];
  workflowId?: string;
  planContext?: PlanContext;
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
  provider?: string;
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
  provider?: string;
  allowedTools?: string[];
  workflowId?: string;
  planContext?: PlanContext;
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
  provider?: string;
  toolEvidence?: ToolEvidenceEntry[];
  planContext?: PlanContext;
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
