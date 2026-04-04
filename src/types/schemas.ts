import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  dependsOn: z.array(z.string()).default([]),
  status: z
    .enum(['pending', 'executing', 'executed', 'reviewed', 'rejected'])
    .default('pending'),
  result: z.string().optional(),
  reviewNotes: z.string().optional(),
  reviewPassed: z.boolean().default(false),
  purpose: z.string().optional(),
  successCriteria: z.array(z.string()).optional(),
  outputFormat: z.string().optional(),
});

export const TaskPlanSchema = z.object({
  tasks: z.array(TaskSchema).min(1),
  planSummary: z.string(),
  userIntent: z.string().optional(),
  qualityGuidelines: z.string().optional(),
});

export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.string()).default([]),
  revisedPlan: TaskPlanSchema.optional(),
});

export const ReviewerResultSchema = z.object({
  taskId: z.string(),
  passed: z.boolean(),
  notes: z.string(),
  revisedResult: z.string().optional(),
});

export const IntegrationReviewerResultSchema = z.object({
  passed: z.boolean(),
  notes: z.string(),
  score: z.object({
    completeness: z.number().min(1).max(5),
    accuracy: z.number().min(1).max(5),
    structure: z.number().min(1).max(5),
    actionability: z.number().min(1).max(5),
    overall: z.number().min(1).max(5),
  }),
  strengths: z.array(z.string()).default([]),
  improvements: z.array(z.string()).default([]),
  revisedResponse: z.string().optional(),
});
