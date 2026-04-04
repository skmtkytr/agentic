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
  purpose?: string;
  successCriteria?: string[];
  outputFormat?: string;
}

export interface TaskPlan {
  tasks: Task[];
  planSummary: string;
  userIntent?: string;
  qualityGuidelines?: string;
}

export interface TaskDesignResult {
  valid: boolean;
  issues: string[];
  designedPlan?: TaskPlan;
}
