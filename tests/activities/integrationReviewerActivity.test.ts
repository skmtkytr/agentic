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

  it('truncates response exceeding 15000 chars', async () => {
    setupMock({});

    const longResponse = 'x'.repeat(15001);
    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: longResponse,
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).not.toContain('x'.repeat(15001));
    expect(opts.userContent).toContain('以下省略');
  });

  it('does not truncate response at exactly 15000 chars', async () => {
    setupMock({});

    const exactResponse = 'y'.repeat(15000);
    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: exactResponse,
      model: 'test',
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain(exactResponse);
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

  it('limits tool evidence to MAX_EVIDENCE=10 entries', async () => {
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
    expect(opts.userContent).toContain('url0');
    expect(opts.userContent).toContain('url9');
  });

  it('truncates taskDescription to 40 chars in evidence', async () => {
    setupMock({});

    const longDesc = 'D'.repeat(50);
    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
      toolEvidence: [{ taskDescription: longDesc, tool: 'Bash', input: 'ls', output: 'files' }],
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('D'.repeat(40));
    expect(opts.userContent).not.toContain('D'.repeat(41));
  });

  it('truncates input to 60 chars in evidence', async () => {
    setupMock({});

    const longInput = 'I'.repeat(70);
    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
      toolEvidence: [{ taskDescription: 'Task', tool: 'Bash', input: longInput, output: 'out' }],
    });

    const [_schema, opts] = mockCallStructured.mock.calls[0];
    expect(opts.userContent).toContain('I'.repeat(60));
    expect(opts.userContent).not.toContain('I'.repeat(61));
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

  it('passes through revisedResponse from LLM output', async () => {
    setupMock({ revisedResponse: 'improved response' });

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'original',
      model: 'test',
    })) as IntegrationReviewerResponse;

    expect(result.revisedResponse).toBe('improved response');
  });
});
