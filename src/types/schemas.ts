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
});

export const TaskPlanSchema = z.object({
  tasks: z.array(TaskSchema).min(1),
  planSummary: z.string(),
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
  revisedResponse: z.string().optional(),
});
