import { MockActivityEnvironment } from '@temporalio/testing';
import type { IntegrationReviewerResponse } from '../../src/types/agents';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = query as jest.MockedFunction<typeof query>;

function setupQueryMock(resultText: string) {
  mockQuery.mockImplementation(async function* () {
    yield { result: resultText } as never;
  } as any);
}

import { integrationReviewerActivity } from '../../src/activities/integrationReviewerActivity';

describe('integrationReviewerActivity', () => {
  const env = new MockActivityEnvironment();

  beforeEach(() => mockQuery.mockReset());

  const mockScore = { completeness: 4, accuracy: 4, structure: 4, actionability: 4, overall: 4 };

  it('returns passed review', async () => {
    setupQueryMock(
      JSON.stringify({
        passed: true, notes: 'Response is complete and accurate',
        score: { completeness: 5, accuracy: 5, structure: 5, actionability: 4, overall: 5 },
        strengths: ['Complete'], improvements: [],
      }),
    );

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Create a calculator',
      integratedResponse: 'Here is your calculator implementation...',
      model: 'claude-opus-4-6',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(true);
    expect(result.notes).toBe('Response is complete and accurate');
    expect(result.score.overall).toBe(5);
    expect(result.strengths).toContain('Complete');
    expect(result.revisedResponse).toBeUndefined();
  });

  it('returns failed review', async () => {
    setupQueryMock(
      JSON.stringify({
        passed: false, notes: 'Missing error handling throughout',
        score: { completeness: 2, accuracy: 3, structure: 3, actionability: 2, overall: 2 },
        strengths: [], improvements: ['Add error handling'],
      }),
    );

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Build robust API',
      integratedResponse: 'Here is an API without error handling',
      model: 'claude-opus-4-6',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(/Missing error handling/);
    expect(result.score.overall).toBe(2);
    expect(result.improvements).toContain('Add error handling');
  });

  it('returns revised response when improvements made', async () => {
    setupQueryMock(
      JSON.stringify({
        passed: true, notes: 'Minor formatting improved',
        score: mockScore, strengths: ['Well formatted'], improvements: [],
        revisedResponse: 'Better formatted response here',
      }),
    );

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Write docs',
      integratedResponse: 'Poorly formatted docs',
      model: 'claude-opus-4-6',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(true);
    expect(result.revisedResponse).toBe('Better formatted response here');
  });

  it('uses file path and Read tool when integratedResponseFilePath provided', async () => {
    setupQueryMock(
      JSON.stringify({ passed: true, notes: 'Reviewed from file', score: { completeness: 4, accuracy: 4, structure: 4, actionability: 4, overall: 4 }, strengths: [], improvements: [] }),
    );

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'test',
      integratedResponse: 'inline (ignored)',
      integratedResponseFilePath: '/tmp/agentic/wf/_integrated/response.md',
      model: 'claude-opus-4-6',
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain('/tmp/agentic/wf/_integrated/response.md');
    expect(callArgs.prompt).toContain('Read ツール');
    expect(callArgs.options?.allowedTools).toContain('Read');
  });

  it('uses inline response when no file path', async () => {
    setupQueryMock(
      JSON.stringify({ passed: true, notes: 'ok', score: { completeness: 4, accuracy: 4, structure: 4, actionability: 4, overall: 4 }, strengths: [], improvements: [] }),
    );

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'test',
      integratedResponse: 'My inline integrated response',
      model: 'claude-opus-4-6',
    });

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.prompt).toContain('My inline integrated response');
  });

  it('includes tool evidence summary in prompt when provided', async () => {
    setupQueryMock(
      JSON.stringify({ passed: true, notes: 'Data verified via tool evidence', score: { completeness: 5, accuracy: 5, structure: 4, actionability: 4, overall: 5 }, strengths: ['good'], improvements: [] }),
    );

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Get ETH price',
      integratedResponse: 'ETH is $2,047',
      model: 'claude-opus-4-6',
      toolEvidence: [
        { taskDescription: 'Fetch ETH price', tool: 'WebFetch', input: 'https://api.coingecko.com/...', output: '{"usd":2047}' },
      ],
    });

    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('WebFetch');
    expect(prompt).toContain('https://api.coingecko.com/');
  });

  it('throws on invalid JSON', async () => {
    setupQueryMock('this is not json');

    await expect(
      env.run(integrationReviewerActivity, {
        originalPrompt: 'test',
        integratedResponse: 'test response',
        model: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(/JSON parse failed/);
  });

  it('throws on schema mismatch (missing required fields)', async () => {
    setupQueryMock(JSON.stringify({ passed: true }));

    await expect(
      env.run(integrationReviewerActivity, {
        originalPrompt: 'test',
        integratedResponse: 'test',
        model: 'claude-opus-4-6',
      }),
    ).rejects.toThrow(/Schema validation failed/);
  });

  it('includes planContext.userIntent and qualityGuidelines in prompt', async () => {
    setupQueryMock(
      JSON.stringify({ passed: true, notes: 'ok', score: mockScore, strengths: [], improvements: [] }),
    );

    await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
      planContext: {
        userIntent: 'Investment decision making',
        qualityGuidelines: 'Real-time data required',
      },
    });

    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('Investment decision making');
    expect(prompt).toContain('Real-time data required');
  });

  it('works without planContext', async () => {
    setupQueryMock(
      JSON.stringify({ passed: true, notes: 'ok', score: mockScore, strengths: [], improvements: [] }),
    );

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Test',
      integratedResponse: 'response',
      model: 'test',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(true);
  });
});
