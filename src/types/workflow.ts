import type { Task } from './task';

export type WorkflowPhase =
  | 'planning'
  | 'designing'
  | 'executing'
  | 'integrating'
  | 'reviewing'
  | 'complete'
  | 'failed';

export type AgentRole = 'planner' | 'taskDesigner' | 'executor' | 'reviewer' | 'integrator' | 'integrationReviewer';

export interface AgentLLMConfig {
  provider?: string;
  model?: string;
}

export type AgentConfigMap = Partial<Record<AgentRole, AgentLLMConfig>>;

export interface WorkflowInput {
  prompt: string;
  model?: string;
  provider?: string;
  agentConfig?: AgentConfigMap;
  maxParallelTasks?: number;
  allowedTools?: string[];
  maxPipelineRetries?: number;
  maxTaskRetries?: number;
  workflowId?: string;
}

export interface PipelineAttempt {
  attempt: number;
  tasks: Task[];
  integrationReviewPassed: boolean;
  integrationReviewNotes: string;
}

export interface WorkflowOutput {
  finalResponse: string;
  integrationReviewPassed: boolean;
  integrationReviewNotes: string;
  integrationReviewScore?: {
    completeness: number;
    accuracy: number;
    structure: number;
    actionability: number;
    overall: number;
  };
  integrationReviewStrengths?: string[];
  integrationReviewImprovements?: string[];
  tasks: Task[];
  executionTimeMs: number;
  pipelineAttempt: number;
  pipelineHistory?: PipelineAttempt[];
}

export type ActivityEventKind =
  | 'planner_start'
  | 'planner_done'
  | 'designer_start'
  | 'designer_done'
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
