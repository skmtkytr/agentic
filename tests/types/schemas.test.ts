import {
  TaskSchema,
  TaskPlanSchema,
  ValidationResultSchema,
  ReviewerResultSchema,
  IntegrationReviewerResultSchema,
} from '../../src/types/schemas';

describe('TaskSchema', () => {
  it('parses a valid task', () => {
    const result = TaskSchema.safeParse({
      id: 'task_1',
      description: 'Do something',
      dependsOn: ['task_0'],
      status: 'pending',
      reviewPassed: false,
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults for optional fields', () => {
    const result = TaskSchema.parse({
      id: 'task_1',
      description: 'Do something',
    });
    expect(result.dependsOn).toEqual([]);
    expect(result.status).toBe('pending');
    expect(result.reviewPassed).toBe(false);
  });

  it('allows optional result and reviewNotes', () => {
    const result = TaskSchema.parse({
      id: 't1',
      description: 'test',
      result: 'some result',
      reviewNotes: 'looks good',
    });
    expect(result.result).toBe('some result');
    expect(result.reviewNotes).toBe('looks good');
  });

  it('rejects invalid status', () => {
    const result = TaskSchema.safeParse({
      id: 't1',
      description: 'test',
      status: 'invalid_status',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing id', () => {
    const result = TaskSchema.safeParse({ description: 'no id' });
    expect(result.success).toBe(false);
  });

  it('rejects missing description', () => {
    const result = TaskSchema.safeParse({ id: 't1' });
    expect(result.success).toBe(false);
  });
});

describe('TaskPlanSchema', () => {
  it('requires at least one task', () => {
    const result = TaskPlanSchema.safeParse({
      planSummary: 'empty plan',
      tasks: [],
    });
    expect(result.success).toBe(false);
  });

  it('parses valid plan with one task', () => {
    const result = TaskPlanSchema.safeParse({
      planSummary: 'A plan',
      tasks: [{ id: 't1', description: 'task' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing planSummary', () => {
    const result = TaskPlanSchema.safeParse({
      tasks: [{ id: 't1', description: 'task' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('ValidationResultSchema', () => {
  it('parses valid: true with empty issues', () => {
    const result = ValidationResultSchema.parse({ valid: true, issues: [] });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('defaults issues to empty array', () => {
    const result = ValidationResultSchema.parse({ valid: true });
    expect(result.issues).toEqual([]);
  });

  it('parses with revisedPlan', () => {
    const result = ValidationResultSchema.parse({
      valid: true,
      issues: ['fixed something'],
      revisedPlan: {
        planSummary: 'revised',
        tasks: [{ id: 't1', description: 'revised task' }],
      },
    });
    expect(result.revisedPlan?.tasks).toHaveLength(1);
  });

  it('rejects missing valid field', () => {
    const result = ValidationResultSchema.safeParse({ issues: [] });
    expect(result.success).toBe(false);
  });
});

describe('ReviewerResultSchema', () => {
  it('parses passed review', () => {
    const result = ReviewerResultSchema.parse({
      taskId: 't1',
      passed: true,
      notes: 'Good',
    });
    expect(result.passed).toBe(true);
    expect(result.revisedResult).toBeUndefined();
  });

  it('parses review with revisedResult', () => {
    const result = ReviewerResultSchema.parse({
      taskId: 't1',
      passed: true,
      notes: 'Fixed',
      revisedResult: 'better version',
    });
    expect(result.revisedResult).toBe('better version');
  });

  it('rejects missing taskId', () => {
    const result = ReviewerResultSchema.safeParse({ passed: true, notes: 'ok' });
    expect(result.success).toBe(false);
  });

  it('rejects missing notes', () => {
    const result = ReviewerResultSchema.safeParse({ taskId: 't1', passed: true });
    expect(result.success).toBe(false);
  });
});

describe('IntegrationReviewerResultSchema', () => {
  const validScore = { completeness: 4, accuracy: 5, structure: 4, actionability: 3, overall: 4 };

  it('parses passed review with score', () => {
    const result = IntegrationReviewerResultSchema.parse({
      passed: true,
      notes: 'All good',
      score: validScore,
    });
    expect(result.passed).toBe(true);
    expect(result.score.overall).toBe(4);
    expect(result.strengths).toEqual([]);
    expect(result.improvements).toEqual([]);
  });

  it('parses with strengths and improvements', () => {
    const result = IntegrationReviewerResultSchema.parse({
      passed: true,
      notes: 'Good',
      score: validScore,
      strengths: ['Well structured', 'Accurate data'],
      improvements: ['Add more sources'],
    });
    expect(result.strengths).toHaveLength(2);
    expect(result.improvements).toHaveLength(1);
  });

  it('parses with revisedResponse', () => {
    const result = IntegrationReviewerResultSchema.parse({
      passed: true,
      notes: 'Improved',
      score: validScore,
      revisedResponse: 'better response',
    });
    expect(result.revisedResponse).toBe('better response');
  });

  it('rejects missing score', () => {
    const result = IntegrationReviewerResultSchema.safeParse({ passed: true, notes: 'no score' });
    expect(result.success).toBe(false);
  });

  it('rejects score out of range', () => {
    const result = IntegrationReviewerResultSchema.safeParse({
      passed: true, notes: 'bad score',
      score: { completeness: 6, accuracy: 5, structure: 4, actionability: 3, overall: 4 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing notes', () => {
    const result = IntegrationReviewerResultSchema.safeParse({ passed: true, score: validScore });
    expect(result.success).toBe(false);
  });
});
