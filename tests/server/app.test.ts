import request from 'supertest';

// Mock workflow module to avoid Temporal webpack bundler
jest.mock('../../src/workflows/agenticWorkflow', () => ({
  agenticWorkflow: jest.fn(),
  statusQuery: 'status',
}));

import { createApp } from '../../src/server/app';
import type { Client } from '@temporalio/client';

// --- Mock Temporal Client factory ---

function makeMockHandle(overrides: {
  describe?: () => Promise<any>;
  query?: (q: any) => Promise<any>;
  result?: () => Promise<any>;
} = {}) {
  return {
    describe: overrides.describe ?? (async () => ({
      status: { name: 'COMPLETED' },
      startTime: new Date('2026-03-31T10:00:00Z'),
      closeTime: new Date('2026-03-31T10:01:00Z'),
    })),
    query: overrides.query ?? (async () => ({ phase: 'complete' })),
    result: overrides.result ?? (async () => ({
      finalResponse: 'test result',
      integrationReviewPassed: true,
      integrationReviewNotes: 'ok',
      tasks: [],
      executionTimeMs: 1000,
    })),
  };
}

function makeMockClient(overrides: {
  start?: (...args: any[]) => Promise<any>;
  getHandle?: (id: string) => any;
} = {}) {
  return {
    workflow: {
      start: overrides.start ?? (async () => undefined),
      getHandle: overrides.getHandle ?? (() => makeMockHandle()),
    },
  } as unknown as Client;
}

describe('Server API', () => {
  describe('POST /api/run', () => {
    it('returns 400 when prompt is missing', async () => {
      const mockClient = makeMockClient();
      const { app } = createApp(async () => mockClient);

      const res = await request(app)
        .post('/api/run')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('prompt is required');
    });

    it('returns 400 when prompt is not a string', async () => {
      const mockClient = makeMockClient();
      const { app } = createApp(async () => mockClient);

      const res = await request(app)
        .post('/api/run')
        .send({ prompt: 123 });

      expect(res.status).toBe(400);
    });

    it('starts a workflow and returns workflowId', async () => {
      const startFn = jest.fn().mockResolvedValue(undefined);
      const mockClient = makeMockClient({ start: startFn });
      const { app } = createApp(async () => mockClient);

      const res = await request(app)
        .post('/api/run')
        .send({ prompt: 'Test prompt' });

      expect(res.status).toBe(200);
      expect(res.body.workflowId).toMatch(/^agentic-/);
      expect(startFn).toHaveBeenCalledTimes(1);
    });

    it('records workflow in knownWorkflows', async () => {
      const mockClient = makeMockClient();
      const { app, knownWorkflows } = createApp(async () => mockClient);

      await request(app)
        .post('/api/run')
        .send({ prompt: 'My prompt', model: 'claude-sonnet-4-6' });

      expect(knownWorkflows).toHaveLength(1);
      expect(knownWorkflows[0].prompt).toBe('My prompt');
      expect(knownWorkflows[0].model).toBe('claude-sonnet-4-6');
      expect(knownWorkflows[0].workflowId).toMatch(/^agentic-/);
    });

    it('passes allowedTools to workflow input', async () => {
      const startFn = jest.fn().mockResolvedValue(undefined);
      const mockClient = makeMockClient({ start: startFn });
      const { app } = createApp(async () => mockClient);

      await request(app)
        .post('/api/run')
        .send({ prompt: 'Test', allowedTools: ['WebFetch', 'Bash'] });

      const args = startFn.mock.calls[0][1].args[0];
      expect(args.allowedTools).toEqual(['WebFetch', 'Bash']);
    });

    it('returns 500 when workflow start fails', async () => {
      const mockClient = makeMockClient({
        start: async () => { throw new Error('Temporal unavailable'); },
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app)
        .post('/api/run')
        .send({ prompt: 'Test' });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Temporal unavailable');
    });
  });

  describe('GET /api/workflows', () => {
    it('returns empty array when no workflows exist', async () => {
      const mockClient = makeMockClient();
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflows');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns workflows with enriched status', async () => {
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          describe: async () => ({ status: { name: 'COMPLETED' } }),
        }),
      });
      const { app, knownWorkflows } = createApp(async () => mockClient);

      // Manually add a workflow entry
      knownWorkflows.push({
        workflowId: 'agentic-test-1',
        prompt: 'Hello world',
        model: 'claude-opus-4-6',
        startTime: '2026-03-31T10:00:00Z',
      });

      const res = await request(app).get('/api/workflows');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toEqual({
        workflowId: 'agentic-test-1',
        prompt: 'Hello world',
        status: 'COMPLETED',
        startTime: '2026-03-31T10:00:00Z',
      });
    });

    it('returns NOT_FOUND status for missing workflows', async () => {
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          describe: async () => { throw new Error('not found'); },
        }),
      });
      const { app, knownWorkflows } = createApp(async () => mockClient);

      knownWorkflows.push({
        workflowId: 'agentic-deleted',
        prompt: 'Old prompt',
        model: 'claude-opus-4-6',
        startTime: '2026-01-01T00:00:00Z',
      });

      const res = await request(app).get('/api/workflows');

      expect(res.body[0].status).toBe('NOT_FOUND');
    });

    it('truncates prompt to 80 characters', async () => {
      const mockClient = makeMockClient();
      const { app, knownWorkflows } = createApp(async () => mockClient);

      knownWorkflows.push({
        workflowId: 'agentic-long',
        prompt: 'A'.repeat(200),
        model: 'claude-opus-4-6',
        startTime: '2026-03-31T10:00:00Z',
      });

      const res = await request(app).get('/api/workflows');
      expect(res.body[0].prompt).toHaveLength(80);
    });

    it('limits to 50 workflows', async () => {
      const mockClient = makeMockClient();
      const { app, knownWorkflows } = createApp(async () => mockClient);

      for (let i = 0; i < 60; i++) {
        knownWorkflows.push({
          workflowId: `agentic-${i}`,
          prompt: `Prompt ${i}`,
          model: 'claude-opus-4-6',
          startTime: new Date().toISOString(),
        });
      }

      const res = await request(app).get('/api/workflows');
      expect(res.body).toHaveLength(50);
    });
  });

  describe('GET /api/workflow/:id', () => {
    it('returns workflow detail for completed workflow', async () => {
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          describe: async () => ({
            status: { name: 'COMPLETED' },
            startTime: new Date('2026-03-31T10:00:00Z'),
            closeTime: new Date('2026-03-31T10:05:00Z'),
          }),
          query: async () => ({ phase: 'complete' }),
        }),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflow/agentic-test-1');

      expect(res.status).toBe(200);
      expect(res.body.workflowId).toBe('agentic-test-1');
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.phase).toBe('complete');
      expect(res.body.startTime).toBe('2026-03-31T10:00:00.000Z');
      expect(res.body.closeTime).toBe('2026-03-31T10:05:00.000Z');
    });

    it('falls back to status-based phase when query fails', async () => {
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          describe: async () => ({
            status: { name: 'FAILED' },
            startTime: new Date('2026-03-31T10:00:00Z'),
            closeTime: new Date('2026-03-31T10:01:00Z'),
          }),
          query: async () => { throw new Error('workflow completed'); },
        }),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflow/agentic-failed');

      expect(res.body.phase).toBe('failed');
    });

    it('returns RUNNING phase for running workflow when query fails', async () => {
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          describe: async () => ({
            status: { name: 'RUNNING' },
            startTime: new Date('2026-03-31T10:00:00Z'),
            closeTime: null,
          }),
          query: async () => { throw new Error('not ready'); },
        }),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflow/agentic-running');

      expect(res.body.phase).toBe('running');
      expect(res.body.closeTime).toBeNull();
    });

    it('returns 404 when workflow does not exist', async () => {
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          describe: async () => { throw new Error('not found'); },
        }),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflow/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Workflow not found');
    });
  });

  describe('GET /api/result/:id', () => {
    it('returns workflow result', async () => {
      const mockResult = {
        finalResponse: 'Hello',
        integrationReviewPassed: true,
        integrationReviewNotes: 'Good',
        tasks: [],
        executionTimeMs: 500,
      };
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          result: async () => mockResult,
        }),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/result/agentic-test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockResult);
    });

    it('returns 500 when result fetch fails', async () => {
      const mockClient = makeMockClient({
        getHandle: () => makeMockHandle({
          result: async () => { throw new Error('Workflow failed'); },
        }),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/result/agentic-failed');

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Workflow failed');
    });
  });

  describe('Workflow ordering', () => {
    it('records workflows in reverse chronological order', async () => {
      const mockClient = makeMockClient();
      const { app, knownWorkflows } = createApp(async () => mockClient);

      await request(app).post('/api/run').send({ prompt: 'First' });
      await request(app).post('/api/run').send({ prompt: 'Second' });

      expect(knownWorkflows[0].prompt).toBe('Second');
      expect(knownWorkflows[1].prompt).toBe('First');
    });
  });
});
