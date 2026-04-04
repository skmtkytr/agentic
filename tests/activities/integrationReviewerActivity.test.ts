import { MockActivityEnvironment } from '@temporalio/testing';
import type { IntegrationReviewerResponse } from '../../src/types/agents';
import type { LLMCallOptions } from '../../src/llm/parseWithRetry';

jest.mock('../../src/llm/parseWithRetry', () => ({
  callStructured: jest.fn(),
}));

import { callStructured } from '../../src/llm/parseWithRetry';
import { integrationReviewerActivity } from '../../src/activities/integrationReviewerActivity';

const mockCallStructured = callStructured as jest.MockedFunction<typeof callStructured>;

const defaultScore = { completeness: 4, accuracy: 4, structure: 4, actionability: 4, overall: 4 };

function setupMock(result: Partial<IntegrationReviewerResponse>) {
  mockCallStructured.mockResolvedValue({
    passed: true,
    notes: 'Good',
    score: defaultScore,
    strengths: [],
    improvements: [],
    ...result,
  });
}

describe('integrationReviewerActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockCallStructured.mockReset());

  // --- callStructured argument verification ---

  it('calls callStructured with correct provider and model', async () => {
    setupMock({});

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'claude-sonnet-4-6',
      provider: 'local-llm',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.provider).toBe('local-llm');
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('uses Read tool when integratedResponseFilePath provided', async () => {
    setupMock({});

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'inline',
      integratedResponseFilePath: '/tmp/agentic/wf/_integrated/response.md',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.allowedTools).toContain('Read');
    expect(opts.userContent).toContain('/tmp/agentic/wf/_integrated/response.md');
    expect(opts.userContent).toContain('Read ツール');
  });

  it('uses inline response when no file path', async () => {
    setupMock({});

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'My inline response',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('My inline response');
    expect(opts.allowedTools).toBeUndefined();
  });

  // --- Text truncation ---

  it('truncates long inline response to MAX_RESPONSE_CHARS', async () => {
    setupMock({});

    const longResponse = 'x'.repeat(20000);
    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: longResponse,
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).not.toContain('x'.repeat(20000));
    expect(opts.userContent).toContain('以下省略');
  });

  it('does not truncate response under limit', async () => {
    setupMock({});

    const shortResponse = 'x'.repeat(1000);
    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: shortResponse,
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain(shortResponse);
    expect(opts.userContent).not.toContain('以下省略');
  });

  // --- Tool evidence ---

  it('includes tool evidence in userContent', async () => {
    setupMock({});

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
      toolEvidence: [
        { taskDescription: 'Fetch ETH price', tool: 'WebFetch', input: 'https://api.coingecko.com', output: '{}' },
      ],
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('WebFetch');
    expect(opts.userContent).toContain('Fetch ETH');
  });

  it('limits tool evidence to MAX_EVIDENCE entries', async () => {
    setupMock({});

    const evidence = Array.from({ length: 15 }, (_, i) => ({
      taskDescription: `Task ${i}`, tool: 'WebFetch', input: `url${i}`, output: `out${i}`,
    }));

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
      toolEvidence: evidence,
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('他5件');
    // Should contain first 10, not the 11th
    expect(opts.userContent).toContain('url0');
    expect(opts.userContent).toContain('url9');
  });

  // --- planContext ---

  it('includes planContext in userContent', async () => {
    setupMock({});

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
      planContext: {
        userIntent: 'Investment decision',
        qualityGuidelines: 'Real-time data required',
      },
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('Investment decision');
    expect(opts.userContent).toContain('Real-time data required');
  });

  it('omits planContext sections when not provided', async () => {
    setupMock({});

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).not.toContain('ユーザーの意図');
    expect(opts.userContent).not.toContain('品質指針');
  });

  // --- Result handling ---

  it('returns passed review with score', async () => {
    setupMock({
      passed: true,
      notes: 'Complete and accurate',
      score: { completeness: 5, accuracy: 5, structure: 5, actionability: 4, overall: 5 },
      strengths: ['Well structured'],
      improvements: [],
    });

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(true);
    expect(result.score.overall).toBe(5);
    expect(result.strengths).toContain('Well structured');
  });

  it('returns failed review', async () => {
    setupMock({
      passed: false,
      notes: 'Missing data',
      score: { completeness: 2, accuracy: 2, structure: 3, actionability: 2, overall: 2 },
      improvements: ['Add error handling'],
    });

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(false);
    expect(result.improvements).toContain('Add error handling');
  });

  it('returns revisedResponse when provided', async () => {
    setupMock({ revisedResponse: 'improved response' });

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'original',
      model: 'test',
    })) as IntegrationReviewerResponse;

    expect(result.revisedResponse).toBe('improved response');
  });
});
