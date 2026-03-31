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

  it('returns passed review', async () => {
    setupQueryMock(
      JSON.stringify({
        passed: true,
        notes: 'Response is complete and accurate',
      }),
    );

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Create a calculator',
      integratedResponse: 'Here is your calculator implementation...',
      model: 'claude-opus-4-6',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(true);
    expect(result.notes).toBe('Response is complete and accurate');
    expect(result.revisedResponse).toBeUndefined();
  });

  it('returns failed review', async () => {
    setupQueryMock(
      JSON.stringify({
        passed: false,
        notes: 'Missing error handling throughout',
      }),
    );

    const result = (await env.run(integrationReviewerActivity, {
      originalPrompt: 'Build robust API',
      integratedResponse: 'Here is an API without error handling',
      model: 'claude-opus-4-6',
    })) as IntegrationReviewerResponse;

    expect(result.passed).toBe(false);
    expect(result.notes).toMatch(/Missing error handling/);
  });

  it('returns revised response when improvements made', async () => {
    setupQueryMock(
      JSON.stringify({
        passed: true,
        notes: 'Minor formatting improved',
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

  it('includes tool evidence summary in prompt when provided', async () => {
    setupQueryMock(
      JSON.stringify({ passed: true, notes: 'Data verified via tool evidence' }),
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
});
