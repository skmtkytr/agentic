import type { Task } from './task';

export type WorkflowPhase =
  | 'planning'
  | 'validating'
  | 'executing'
  | 'integrating'
  | 'reviewing'
  | 'complete'
  | 'failed';

export interface WorkflowInput {
  prompt: string;
  model?: string;
  maxParallelTasks?: number;
  allowedTools?: string[];
  maxPipelineRetries?: number;
  maxTaskRetries?: number;
  workflowId?: string;
}

export interface WorkflowOutput {
  finalResponse: string;
  integrationReviewPassed: boolean;
  integrationReviewNotes: string;
  tasks: Task[];
  executionTimeMs: number;
  pipelineAttempt: number;
}

export type ActivityEventKind =
  | 'planner_start'
  | 'planner_done'
  | 'validator_start'
  | 'validator_done'
  | 'executor_start'
  | 'executor_done'
  | 'reviewer_start'
  | 'reviewer_done'
  | 'integrator_start'
  | 'integrator_done'
  | 'integration_reviewer_start'
  | 'integration_reviewer_done'
  | 'pipeline_retry'
  | 'task_retry';

export interface ActivityEvent {
  kind: ActivityEventKind;
  timestamp: number;
  taskId?: string;
  taskDescription?: string;
  summary: string;
}

export interface WorkflowState {
  phase: WorkflowPhase;
  totalTasks: number;
  completedTasks: number;
  currentlyExecuting: string[];
  events: ActivityEvent[];
  tasks: Task[];
}
