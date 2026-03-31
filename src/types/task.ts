export type TaskStatus =
  | 'pending'
  | 'executing'
  | 'executed'
  | 'reviewed'
  | 'rejected';

export interface Task {
  id: string;
  description: string;
  dependsOn: string[];
  status: TaskStatus;
  result?: string;
  reviewNotes?: string;
  reviewPassed: boolean;
}

export interface TaskPlan {
  tasks: Task[];
  planSummary: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  revisedPlan?: TaskPlan;
}
