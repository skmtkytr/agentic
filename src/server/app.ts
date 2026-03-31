import express, { Router } from 'express';
import type { Client } from '@temporalio/client';
import { agenticWorkflow, statusQuery } from '../workflows/agenticWorkflow';
import type { WorkflowInput } from '../types/workflow';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface WorkflowRegistry {
  workflowId: string;
  prompt: string;
  model: string;
  startTime: string;
}

export function createApp(getClient: () => Promise<Client>, webDist?: string) {
  const app = express();
  app.use(express.json());

  const knownWorkflows: WorkflowRegistry[] = [];

  const api = Router();

  api.post('/run', async (req, res) => {
    try {
      const { prompt, model, maxParallelTasks, allowedTools, maxPipelineRetries } = req.body as {
        prompt?: string;
        model?: string;
        maxParallelTasks?: number;
        allowedTools?: string[];
        maxPipelineRetries?: number;
      };

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required' });
        return;
      }

      const client = await getClient();
      const workflowId = `agentic-${randomUUID()}`;
      const input: WorkflowInput = {
        prompt,
        model: model ?? process.env.CLAUDE_MODEL ?? 'claude-opus-4-6',
        maxParallelTasks: maxParallelTasks ?? 5,
        allowedTools,
        maxPipelineRetries: maxPipelineRetries ?? 0,
      };

      await client.workflow.start(agenticWorkflow, {
        taskQueue: 'agentic-pipeline',
        workflowId,
        args: [input],
        memo: { prompt: prompt.slice(0, 200) },
      });

      knownWorkflows.unshift({
        workflowId,
        prompt,
        model: input.model ?? 'claude-opus-4-6',
        startTime: new Date().toISOString(),
      });

      res.json({ workflowId });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  api.get('/workflows', async (_req, res) => {
    try {
      const client = await getClient();
      const promptMap = new Map(knownWorkflows.map((w) => [w.workflowId, w.prompt]));

      const workflows: Array<{
        workflowId: string;
        status: string;
        startTime: string;
        prompt?: string;
      }> = [];

      let count = 0;
      for await (const wf of client.workflow.list({
        query: "WorkflowType = 'agenticWorkflow'",
      })) {
        if (count >= 50) break;
        // Try memo first, then in-memory cache
        const memoPrompt = (wf.memo as any)?.prompt as string | undefined;
        workflows.push({
          workflowId: wf.workflowId,
          status: wf.status.name,
          startTime: wf.startTime.toISOString(),
          prompt: (memoPrompt ?? promptMap.get(wf.workflowId))?.slice(0, 80),
        });
        count++;
      }

      res.json(workflows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  api.get('/workflow/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const client = await getClient();
      const handle = client.workflow.getHandle(id);
      const desc = await handle.describe();
      let phase: string = 'unknown';
      try {
        const state = await handle.query(statusQuery);
        phase = state.phase;
      } catch {
        if (desc.status.name === 'COMPLETED') phase = 'complete';
        else if (desc.status.name === 'FAILED') phase = 'failed';
        else if (desc.status.name === 'RUNNING') phase = 'running';
      }

      res.json({
        workflowId: id,
        status: desc.status.name,
        phase,
        startTime: desc.startTime.toISOString(),
        closeTime: desc.closeTime?.toISOString() ?? null,
      });
    } catch {
      res.status(404).json({ error: `Workflow not found: ${req.params.id}` });
    }
  });

  api.get('/status/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const client = await getClient();
      const handle = client.workflow.getHandle(id);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const send = (data: unknown) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const interval = setInterval(async () => {
        try {
          const state = await handle.query(statusQuery);
          send({ type: 'status', ...state });

          if (state.phase === 'complete' || state.phase === 'failed') {
            clearInterval(interval);
            res.end();
          }
        } catch {
          clearInterval(interval);
          res.end();
        }
      }, 1000);

      req.on('close', () => clearInterval(interval));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  api.get('/result/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const client = await getClient();
      const handle = client.workflow.getHandle(id);
      const result = await handle.result();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use('/api', api);

  if (webDist) {
    app.use(express.static(webDist));
    app.use((_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return { app, knownWorkflows };
}
