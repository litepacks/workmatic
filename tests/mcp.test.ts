import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PassThrough } from 'stream';
import { sql } from 'kysely';
import {
  createDatabase,
  createClient,
  type WorkmaticDb,
  type WorkmaticWorker,
  type WorkmaticOrchestrator,
  type JobStatusChangeEvent,
} from '../src/index.js';
import * as McpIndex from '../src/mcp/index.js';
import * as McpToolsModule from '../src/mcp/tools.js';
const { createMcpServer, executeTool, MCP_TOOL_DEFINITIONS } = McpIndex;
import { cmdMcp, runCommand } from '../src/cli/handlers.js';



describe('MCP Server & Tools', () => {
  let dir: string;
  let dbPath: string;
  let db: WorkmaticDb;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workmatic-mcp-'));
    dbPath = join(dir, 'test.db');
    db = createDatabase({ filename: dbPath });
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  describe('MCP Protocol & JSON-RPC', () => {
    it('returns server info and capabilities on initialize', async () => {
      const server = createMcpServer({ db });
      const response = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        })
      );

      expect(response).not.toBeNull();
      const parsed = JSON.parse(response!);
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'workmatic-mcp', version: '0.1.0' },
        },
      });

      // As notification (id undefined) returns null
      const notifResponse = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
        })
      );
      expect(notifResponse).toBeNull();
    });

    it('handles notifications/initialized without response', async () => {
      const server = createMcpServer({ db });
      const response = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        })
      );
      expect(response).toBeNull();
    });

    it('handles ping request and notification', async () => {
      const server = createMcpServer({ db });
      const req = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping' })
      );
      expect(JSON.parse(req!)).toEqual({ jsonrpc: '2.0', id: 42, result: {} });

      const notif = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'ping' })
      );
      expect(notif).toBeNull();
    });

    it('handles tools/list request and notification', async () => {
      const server = createMcpServer({ db });
      const response = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      );
      const parsed = JSON.parse(response!);
      expect(parsed.result.tools).toHaveLength(12);
      expect(parsed.result.tools).toEqual(MCP_TOOL_DEFINITIONS);


      const notif = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' })
      );
      expect(notif).toBeNull();
    });

    it('handles tools/call with invalid params', async () => {
      const server = createMcpServer({ db });
      const res1 = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call' })
      );
      expect(JSON.parse(res1!).error.code).toBe(-32602);

      const notif = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'tools/call' })
      );
      expect(notif).toBeNull();
    });

    it('handles tools/call success and error formatting', async () => {
      const server = createMcpServer({ db });

      // Successful tool call
      const res = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'workmatic_add_job',
            arguments: { queue: 'test_q', payload: { message: 'hello' } },
          },
        })
      );
      const parsed = JSON.parse(res!);
      expect(parsed.result.content[0].type).toBe('text');
      const content = JSON.parse(parsed.result.content[0].text);
      expect(content.ok).toBe(true);
      expect(content.queue).toBe('test_q');

      // Tool call error formatting
      const errRes = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'workmatic_retry_job',
            arguments: {}, // missing publicId
          },
        })
      );
      const errParsed = JSON.parse(errRes!);
      expect(errParsed.result.isError).toBe(true);
      expect(errParsed.result.content[0].text).toContain('publicId is required');

      // Notification call
      const notifRes = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'workmatic_list_queues',
          },
        })
      );
      expect(notifRes).toBeNull();

      // Tool call notification that throws an error returns null
      const notifErrRes = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'workmatic_retry_job',
            arguments: {},
          },
        })
      );
      expect(notifErrRes).toBeNull();

      // Tool throwing non-Error object (raw string)
      const spy = vi
        .spyOn(McpToolsModule, 'executeTool')
        .mockRejectedValueOnce('raw string error');

      const resStrError = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'workmatic_list_queues',
          },
        })
      );
      spy.mockRestore();

      const parsedStrErr = JSON.parse(resStrError!);
      expect(parsedStrErr.result.isError).toBe(true);
      expect(parsedStrErr.result.content[0].text).toBe('raw string error');
    });


    it('handles unknown method, parse error, and invalid request', async () => {
      const server = createMcpServer({ db });

      // Empty string
      expect(await server.handleMessage('')).toBeNull();
      expect(await server.handleMessage('   \n  ')).toBeNull();

      // Parse error
      const parseErr = await server.handleMessage('{ invalid json');
      expect(JSON.parse(parseErr!).error.code).toBe(-32700);

      // Invalid request format
      const inv1 = await server.handleMessage(JSON.stringify({ invalid: true }));
      expect(JSON.parse(inv1!).error.code).toBe(-32600);

      const inv2 = await server.handleMessage(JSON.stringify({ jsonrpc: '1.0', method: 'ping' }));
      expect(JSON.parse(inv2!).error.code).toBe(-32600);

      const inv3 = await server.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 123 }));
      expect(JSON.parse(inv3!).error.code).toBe(-32600);

      // Unknown method request & notification
      const unk = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'unknown_method' })
      );
      expect(JSON.parse(unk!).error.code).toBe(-32601);

      const unkNotif = await server.handleMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'unknown_method' })
      );
      expect(unkNotif).toBeNull();
    });

    it('streams via readline on start() and stops cleanly', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let outputData = '';
      output.on('data', (chunk) => {
        outputData += chunk.toString();
      });

      const server = createMcpServer({ db, input, output });
      server.start();
      // start() again should be a no-op
      server.start();

      input.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }) + '\n');

      // Wait a tick for readline line event
      await new Promise((r) => setTimeout(r, 50));
      expect(outputData).toContain('"id":10');

      server.stop();
      // stop() again should be a no-op
      server.stop();
    });

    it('ignores responses after server is stopped while async processing', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let outputData = '';
      output.on('data', (chunk) => {
        outputData += chunk.toString();
      });

      const server = createMcpServer({ db, input, output });
      server.start();

      // Write a command and immediately stop before it completes
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' }) + '\n');
      server.stop();

      await new Promise((r) => setTimeout(r, 50));
    });

    it('supports default options fallback', () => {
      const server = createMcpServer({ db });
      expect(typeof server.start).toBe('function');
      expect(typeof server.stop).toBe('function');
      expect(typeof server.handleMessage).toBe('function');
    });
  });

  describe('MCP Tools Implementation', () => {
    it('workmatic_list_queues and workmatic_get_stats', async () => {
      const clientA = createClient({ db, queue: 'queue_a' });
      const clientB = createClient({ db, queue: 'queue_b' });

      await clientA.add({ task: 1 });
      await clientA.add({ task: 2 });
      await clientB.add({ task: 3 });

      // Add a setting for paused queue and an internal worker_state_ queue
      await sql`
        INSERT INTO workmatic_settings (queue, paused, updated_at)
        VALUES ('queue_a', 1, ${Date.now()}), ('worker_state_test', 1, ${Date.now()})
      `.execute(db);

      const listRes = (await executeTool(db, 'workmatic_list_queues')) as {
        queues: Array<{ queue: string; stats: Record<string, number>; isPaused: boolean }>;
        totalQueues: number;
      };

      expect(listRes.totalQueues).toBe(2);
      expect(listRes.queues[0].queue).toBe('queue_a');
      expect(listRes.queues[0].isPaused).toBe(true);
      expect(listRes.queues[1].queue).toBe('queue_b');
      expect(listRes.queues[1].isPaused).toBe(false);

      // get_stats with specific queue
      const statsA = (await executeTool(db, 'workmatic_get_stats', { queue: 'queue_a' })) as {
        queue: string;
        stats: { total: number; ready: number };
      };
      expect(statsA.queue).toBe('queue_a');
      expect(statsA.stats.total).toBe(2);

      // get_stats for all queues
      const statsAll = (await executeTool(db, 'workmatic_get_stats')) as {
        queues: Record<string, Record<string, number>>;
        grandTotal: { ready: number; total: number };
      };
      expect(statsAll.grandTotal.total).toBe(3);
      expect(statsAll.queues['queue_a'].ready).toBe(2);
      expect(statsAll.queues['queue_b'].ready).toBe(1);
    });

    it('workmatic_list_jobs and workmatic_get_dead_jobs with payload parsing', async () => {
      const client = createClient({ db, queue: 'orders' });
      const job1 = await client.add({ orderId: 101 }, { priority: 2 });
      const job2 = await client.add({ orderId: 102 }, { priority: 1 });

      // Insert a job with a non-JSON payload directly into DB to test fallback
      await sql`
        INSERT INTO workmatic_jobs (public_id, queue, payload, status, priority, run_at, attempts, max_attempts, lease_until, created_at, updated_at)
        VALUES ('raw_job', 'orders', 'not a json', 'ready', 0, ${Date.now()}, 0, 3, 0, ${Date.now()}, ${Date.now()})
      `.execute(db);

      // List all jobs
      const res = (await executeTool(db, 'workmatic_list_jobs', {
        queue: 'orders',
        limit: 10,
        offset: 0,
      })) as { jobs: Array<{ publicId: string; payload: unknown; priority: number }>; count: number };

      expect(res.count).toBe(3);
      expect(res.jobs[0].publicId).toBe('raw_job');
      expect(res.jobs[0].payload).toBe('not a json');
      expect(res.jobs[1].payload).toEqual({ orderId: 102 });

      // Mark one job as dead
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead', last_error: 'Simulated failure' })
        .where('public_id', '=', job1.id)
        .execute();

      const deadRes = (await executeTool(db, 'workmatic_get_dead_jobs', {
        queue: 'orders',
      })) as { jobs: Array<{ publicId: string; lastError: string }>; count: number };

      expect(deadRes.count).toBe(1);
      expect(deadRes.jobs[0].publicId).toBe(job1.id);
      expect(deadRes.jobs[0].lastError).toBe('Simulated failure');

      // Filter by status directly in list_jobs
      const statusFiltered = (await executeTool(db, 'workmatic_list_jobs', {
        status: 'ready',
      })) as { count: number };
      expect(statusFiltered.count).toBe(2);
    });

    it('workmatic_add_job with defaults and custom arguments', async () => {
      // With defaults
      const resDefault = (await executeTool(db, 'workmatic_add_job', {
        payload: { item: 'default' },
      })) as { ok: boolean; id: string; queue: string };
      expect(resDefault.ok).toBe(true);
      expect(resDefault.queue).toBe('default');

      // With custom arguments
      const resCustom = (await executeTool(db, 'workmatic_add_job', {
        queue: 'custom_q',
        payload: { item: 'custom' },
        priority: 5,
        delayMs: 1000,
        maxAttempts: 5,
      })) as { ok: boolean; id: string; queue: string };
      expect(resCustom.ok).toBe(true);
      expect(resCustom.queue).toBe('custom_q');

      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', resCustom.id)
        .executeTakeFirst();
      expect(job?.priority).toBe(5);
      expect(job?.max_attempts).toBe(5);
    });

    it('workmatic_retry_job and workmatic_retry_all_dead', async () => {
      const client = createClient({ db, queue: 'retry_q' });
      const job1 = await client.add({ a: 1 });
      const job2 = await client.add({ a: 2 });

      // Mark both dead
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead', attempts: 3, last_error: 'boom' })
        .execute();

      // Retry single job validations
      await expect(executeTool(db, 'workmatic_retry_job', {})).rejects.toThrow(
        'publicId is required'
      );
      await expect(
        executeTool(db, 'workmatic_retry_job', { publicId: 'non_existent' })
      ).rejects.toThrow('Job not found');

      // Retry single job
      const retryRes = (await executeTool(db, 'workmatic_retry_job', {
        publicId: job1.id,
      })) as { ok: boolean; id: string };
      expect(retryRes.ok).toBe(true);

      const job1Db = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', job1.id)
        .executeTakeFirst();
      expect(job1Db?.status).toBe('ready');
      expect(job1Db?.attempts).toBe(0);
      expect(job1Db?.last_error).toBeNull();

      // Retry all dead in retry_q
      const retryAllQ = (await executeTool(db, 'workmatic_retry_all_dead', {
        queue: 'retry_q',
      })) as { ok: boolean; retriedCount: number };
      expect(retryAllQ.retriedCount).toBe(1);

      // Retry all dead globally when none are dead
      const retryAllNone = (await executeTool(db, 'workmatic_retry_all_dead')) as {
        ok: boolean;
        retriedCount: number;
      };
      expect(retryAllNone.retriedCount).toBe(0);
    });

    it('workmatic_pause_queue and workmatic_resume_queue', async () => {
      await expect(executeTool(db, 'workmatic_pause_queue', {})).rejects.toThrow(
        'queue is required'
      );
      await expect(executeTool(db, 'workmatic_resume_queue', {})).rejects.toThrow(
        'queue is required'
      );

      const pauseRes = (await executeTool(db, 'workmatic_pause_queue', {
        queue: 'notifications',
      })) as { ok: boolean; paused: boolean };
      expect(pauseRes.paused).toBe(true);

      const resumeRes = (await executeTool(db, 'workmatic_resume_queue', {
        queue: 'notifications',
      })) as { ok: boolean; paused: boolean };
      expect(resumeRes.paused).toBe(false);
    });

    it('workmatic_purge_jobs', async () => {
      const client = createClient({ db, queue: 'purge_q' });
      await client.add({ x: 1 });
      await client.add({ x: 2 });
      await client.add({ x: 3 });

      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'done' })
        .where('id', '=', 1)
        .execute();

      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead' })
        .where('id', '=', 2)
        .execute();

      // Purge done in queue (default status is done)
      const purgeDone = (await executeTool(db, 'workmatic_purge_jobs', {
        queue: 'purge_q',
      })) as { deletedCount: number };
      expect(purgeDone.deletedCount).toBe(1);

      // Purge all in all queues
      const purgeAll = (await executeTool(db, 'workmatic_purge_jobs', {
        status: 'all',
      })) as { deletedCount: number };
      expect(purgeAll.deletedCount).toBe(2);
    });

    it('workmatic_transfer_jobs', async () => {
      await expect(executeTool(db, 'workmatic_transfer_jobs', {})).rejects.toThrow(
        'fromQueue and toQueue are required'
      );

      // Same queue returns 0
      const sameQ = (await executeTool(db, 'workmatic_transfer_jobs', {
        fromQueue: 'q1',
        toQueue: 'q1',
      })) as { ok: boolean; moved: number };
      expect(sameQ.moved).toBe(0);

      const client = createClient({ db, queue: 'source_q' });
      await client.add({ a: 1 });
      await client.add({ a: 2 });

      // Transfer ready jobs
      const transferReady = (await executeTool(db, 'workmatic_transfer_jobs', {
        fromQueue: 'source_q',
        toQueue: 'dest_q',
        limit: 10,
      })) as { ok: boolean; moved: number };
      expect(transferReady.moved).toBe(2);

      // Transfer dead jobs with resetForRetry: true
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead', queue: 'failed_q', attempts: 3, last_error: 'bad' })
        .execute();

      const transferRetry = (await executeTool(db, 'workmatic_transfer_jobs', {
        fromQueue: 'failed_q',
        toQueue: 'primary_q',
        status: 'dead',
        resetForRetry: true,
      })) as { ok: boolean; moved: number; status: string };
      expect(transferRetry.moved).toBe(2);
      expect(transferRetry.status).toBe('ready');

      const jobInPrimary = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('queue', '=', 'primary_q')
        .execute();
      expect(jobInPrimary).toHaveLength(2);
      expect(jobInPrimary[0].status).toBe('ready');
      expect(jobInPrimary[0].attempts).toBe(0);
      expect(jobInPrimary[0].last_error).toBeNull();
    });

    it('workmatic_update_job_status updates status and supports all branches', async () => {
      const client = createClient({ db, queue: 'updates_q' });
      const job1 = await client.add({ item: 1 });

      // Validations
      await expect(executeTool(db, 'workmatic_update_job_status', {})).rejects.toThrow(
        'publicId is required'
      );
      await expect(
        executeTool(db, 'workmatic_update_job_status', { publicId: job1.id, status: 'invalid' })
      ).rejects.toThrow("status is required and must be 'ready', 'done', or 'dead'");
      await expect(
        executeTool(db, 'workmatic_update_job_status', { publicId: 'non_existent', status: 'done' })
      ).rejects.toThrow('Job not found');

      // Unchanged status
      const unchangedRes = (await executeTool(db, 'workmatic_update_job_status', {
        publicId: job1.id,
        status: 'ready',
      })) as { ok: boolean; unchanged: boolean };
      expect(unchangedRes.unchanged).toBe(true);

      // Update to dead with custom error
      const deadRes = (await executeTool(db, 'workmatic_update_job_status', {
        publicId: job1.id,
        status: 'dead',
        error: 'Manual kill',
        resetAttempts: false,
      })) as { ok: boolean; previousStatus: string; status: string; signaled: boolean };
      expect(deadRes.ok).toBe(true);
      expect(deadRes.previousStatus).toBe('ready');
      expect(deadRes.status).toBe('dead');
      expect(deadRes.signaled).toBe(true);

      let row = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', job1.id)
        .executeTakeFirst();
      expect(row?.status).toBe('dead');
      expect(row?.last_error).toBe('Manual kill');

      // Update to ready with delayMs and default resetAttempts (true)
      const readyRes = (await executeTool(db, 'workmatic_update_job_status', {
        publicId: job1.id,
        status: 'ready',
        delayMs: 5000,
      })) as { ok: boolean; status: string };
      expect(readyRes.status).toBe('ready');

      row = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', job1.id)
        .executeTakeFirst();
      expect(row?.status).toBe('ready');
      expect(row?.last_error).toBeNull();
      expect(row?.attempts).toBe(0);
      expect(row?.run_at).toBeGreaterThan(Date.now());

      // Update to done
      const doneRes = (await executeTool(db, 'workmatic_update_job_status', {
        publicId: job1.id,
        status: 'done',
      })) as { ok: boolean; status: string };
      expect(doneRes.status).toBe('done');

      row = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', job1.id)
        .executeTakeFirst();
      expect(row?.status).toBe('done');
      expect(row?.lease_until).toBe(0);
    });

    it('multi-layer signaling wakes up workers, sends MCP notification, and emits events', async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      let outputData = '';
      output.on('data', (chunk) => {
        outputData += chunk.toString();
      });

      const workerWakeUp = vi.fn();
      const mockWorker = {
        queue: 'sig_q',
        wakeUp: workerWakeUp,
      } as unknown as WorkmaticWorker;

      const orchWorkerWakeUp = vi.fn();
      const mockOrchestrator = {
        worker: (q: string) => {
          if (q === 'sig_q') {
            return { wakeUp: orchWorkerWakeUp };
          }
          throw new Error('Worker not found');
        },
        workers: () => [{ wakeUp: orchWorkerWakeUp }],
      } as unknown as WorkmaticOrchestrator;

      const onJobStatusChanged = vi.fn();
      const eventListener = vi.fn();

      const server = createMcpServer({
        db,
        input,
        output,
        workers: [mockWorker],
        orchestrator: mockOrchestrator,
        onJobStatusChanged,
      });

      server.on('jobStatusChanged', eventListener);
      server.start();

      const client = createClient({ db, queue: 'sig_q' });
      const job = await client.add({ test: true });

      // Call workmatic_update_job_status via MCP JSON-RPC
      await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/call',
          params: {
            name: 'workmatic_update_job_status',
            arguments: {
              publicId: job.id,
              status: 'dead',
              error: 'Test error',
            },
          },
        })
      );

      expect(onJobStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          publicId: job.id,
          queue: 'sig_q',
          previousStatus: 'ready',
          status: 'dead',
        })
      );
      expect(eventListener).toHaveBeenCalledTimes(1);

      // Now update back to ready -> triggers worker.wakeUp() and orch.wakeUp()
      await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: {
            name: 'workmatic_update_job_status',
            arguments: {
              publicId: job.id,
              status: 'ready',
            },
          },
        })
      );

      expect(workerWakeUp).toHaveBeenCalled();
      expect(orchWorkerWakeUp).toHaveBeenCalled();

      // Verify JSON-RPC notification was written to output stream
      expect(outputData).toContain('notifications/workmatic/job_status_changed');

      // Test retry_all_dead with wildcard queue signaling orchestrator all workers
      await db.updateTable('workmatic_jobs').set({ status: 'dead' }).execute();
      await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 102,
          method: 'tools/call',
          params: {
            name: 'workmatic_retry_all_dead',
            arguments: {},
          },
        })
      );

      // Test event listener off()
      server.off('jobStatusChanged', eventListener);
      server.stop();
    });

    it('signaling handles orchestrator without matching worker gracefully', async () => {
      const mockOrchestrator = {
        worker: () => {
          throw new Error('Not registered');
        },
        workers: () => [],
      } as unknown as WorkmaticOrchestrator;

      const server = createMcpServer({
        db,
        orchestrator: mockOrchestrator,
      });

      const client = createClient({ db, queue: 'unregistered_q' });
      const job = await client.add({ data: 1 });
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead' })
        .where('public_id', '=', job.id)
        .execute();

      // retry_job should not throw even if orchestrator throws 'Not registered'
      const res = await server.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'workmatic_retry_job',
            arguments: { publicId: job.id },
          },
        })
      );
      expect(JSON.parse(res!).result.isError).toBeUndefined();
    });

    it('signaling filters workers by queue and works without orchestrator or workers', async () => {
      const wakeUpA = vi.fn();
      const wakeUpB = vi.fn();
      const workerA = { queue: 'q_a', wakeUp: wakeUpA } as unknown as WorkmaticWorker;
      const workerB = { queue: 'q_b', wakeUp: wakeUpB } as unknown as WorkmaticWorker;

      // Server with workers only (no orchestrator)
      const serverWorkersOnly = createMcpServer({
        db,
        workers: [workerA, workerB],
      });

      const client = createClient({ db, queue: 'q_a' });
      const job = await client.add({ x: 1 });
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead' })
        .where('public_id', '=', job.id)
        .execute();

      await serverWorkersOnly.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'workmatic_update_job_status',
            arguments: { publicId: job.id, status: 'ready' },
          },
        })
      );

      expect(wakeUpA).toHaveBeenCalledTimes(1);
      expect(wakeUpB).not.toHaveBeenCalled();

      // Server with no workers and no orchestrator
      const serverEmpty = createMcpServer({ db });
      await serverEmpty.handleMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'workmatic_update_job_status',
            arguments: { publicId: job.id, status: 'ready' },
          },
        })
      );
    });


    it('throws on unknown tool', async () => {
      await expect(executeTool(db, 'non_existent_tool')).rejects.toThrow(
        'Unknown tool: non_existent_tool'
      );
    });
  });

  describe('CLI cmdMcp Integration', () => {
    it('runs cmdMcp with custom streams and stops on end', async () => {
      const input = new PassThrough();
      const output = new PassThrough();

      const mcpPromise = cmdMcp(dbPath, { input, output });
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');

      // End the stream to trigger shutdown
      input.end();
      await mcpPromise;
    });

    it('runCommand delegates mcp command', async () => {
      // Mock cmdMcp by triggering SIGINT on next tick
      const runPromise = runCommand('mcp', dbPath, [dbPath], {});
      setTimeout(() => {
        process.emit('SIGINT');
      }, 20);
      await runPromise;
    });

    it('cmdMcp handles SIGTERM', async () => {
      const runPromise = cmdMcp(dbPath);
      setTimeout(() => {
        process.emit('SIGTERM');
      }, 20);
      await runPromise;
    });

    it('re-exports everything from src/mcp/index.ts', () => {
      expect(McpIndex.createMcpServer).toBeDefined();
      expect(McpIndex.executeTool).toBeDefined();
      expect(McpIndex.MCP_TOOL_DEFINITIONS).toHaveLength(12);
    });
  });
});


