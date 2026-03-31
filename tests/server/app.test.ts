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
  list?: (opts?: any) => AsyncIterable<any>;
} = {}) {
  const defaultList = async function* () {
    // empty by default
  };
  return {
    workflow: {
      start: overrides.start ?? (async () => undefined),
      getHandle: overrides.getHandle ?? (() => makeMockHandle()),
      list: overrides.list ?? defaultList,
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

    it('stores prompt in workflow memo', async () => {
      const startFn = jest.fn().mockResolvedValue(undefined);
      const mockClient = makeMockClient({ start: startFn });
      const { app } = createApp(async () => mockClient);

      await request(app)
        .post('/api/run')
        .send({ prompt: 'My test prompt' });

      expect(startFn.mock.calls[0][1].memo).toEqual({ prompt: 'My test prompt' });
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
    it('returns empty array when no workflows in Temporal', async () => {
      const mockClient = makeMockClient();
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflows');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns workflows from Temporal list API', async () => {
      const mockClient = makeMockClient({
        list: () => (async function* () {
          yield {
            workflowId: 'agentic-test-1',
            status: { name: 'COMPLETED' },
            startTime: new Date('2026-03-31T10:00:00Z'),
          };
        })(),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflows');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].workflowId).toBe('agentic-test-1');
      expect(res.body[0].status).toBe('COMPLETED');
    });

    it('reads prompt from Temporal memo', async () => {
      const mockClient = makeMockClient({
        list: () => (async function* () {
          yield {
            workflowId: 'agentic-memo-test',
            status: { name: 'COMPLETED' },
            startTime: new Date('2026-03-31T10:00:00Z'),
            memo: { prompt: 'ETH価格を教えて' },
          };
        })(),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflows');
      expect(res.body[0].prompt).toBe('ETH価格を教えて');
    });

    it('falls back to knownWorkflows when memo has no prompt', async () => {
      const mockClient = makeMockClient({
        list: () => (async function* () {
          yield {
            workflowId: 'agentic-known',
            status: { name: 'COMPLETED' },
            startTime: new Date('2026-03-31T10:00:00Z'),
          };
        })(),
      });
      const { app, knownWorkflows } = createApp(async () => mockClient);

      knownWorkflows.push({
        workflowId: 'agentic-known',
        prompt: 'Hello world',
        model: 'claude-opus-4-6',
        startTime: '2026-03-31T10:00:00Z',
      });

      const res = await request(app).get('/api/workflows');
      expect(res.body[0].prompt).toBe('Hello world');
    });

    it('returns undefined prompt for workflows not in knownWorkflows', async () => {
      const mockClient = makeMockClient({
        list: () => (async function* () {
          yield {
            workflowId: 'agentic-unknown',
            status: { name: 'COMPLETED' },
            startTime: new Date('2026-03-31T10:00:00Z'),
          };
        })(),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflows');
      expect(res.body[0].prompt).toBeUndefined();
    });

    it('limits to 50 workflows', async () => {
      const mockClient = makeMockClient({
        list: () => (async function* () {
          for (let i = 0; i < 60; i++) {
            yield {
              workflowId: `agentic-${i}`,
              status: { name: 'COMPLETED' },
              startTime: new Date(),
            };
          }
        })(),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflows');
      expect(res.body).toHaveLength(50);
    });

    it('returns 500 when Temporal list fails', async () => {
      const mockClient = makeMockClient({
        list: () => (async function* () {
          throw new Error('Temporal unavailable');
        })(),
      });
      const { app } = createApp(async () => mockClient);

      const res = await request(app).get('/api/workflows');
      expect(res.status).toBe(500);
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
