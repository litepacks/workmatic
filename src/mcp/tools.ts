import { sql } from 'kysely';
import type { WorkmaticDb, JobStatus, JobStatusChangeEvent } from '../types.js';
import { createClient } from '../client.js';
import { createOrchestrator } from '../orchestrator.js';
import { now } from '../utils.js';

export interface ToolExecutionContext {
  onJobStatusChanged?: (event: JobStatusChangeEvent) => void;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}


export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'workmatic_list_queues',
    description: 'List all queues present in the Workmatic database along with job counts',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'workmatic_get_stats',
    description: 'Get real-time job counts (ready, running, done, dead, total) for a specific queue or all queues',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Optional queue name. If omitted, stats for all queues will be returned.',
        },
      },
    },
  },
  {
    name: 'workmatic_list_jobs',
    description: 'List jobs in the database filtered by queue, status, and limit',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Filter by queue name',
        },
        status: {
          type: 'string',
          enum: ['ready', 'running', 'done', 'dead'],
          description: 'Filter by job status',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of jobs to return (default: 20, max: 100)',
        },
        offset: {
          type: 'number',
          description: 'Number of jobs to skip for pagination (default: 0)',
        },
      },
    },
  },
  {
    name: 'workmatic_get_dead_jobs',
    description: 'Retrieve failed/dead jobs with error details and payloads for debugging',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Filter dead jobs by queue name',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of dead jobs to return (default: 20)',
        },
      },
    },
  },
  {
    name: 'workmatic_add_job',
    description: 'Enqueue a new background job into Workmatic',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Target queue name (default: "default")',
        },
        payload: {
          description: 'Job payload (JSON object, string, number, etc.)',
        },
        priority: {
          type: 'number',
          description: 'Job priority (lower number = higher priority, default: 0)',
        },
        delayMs: {
          type: 'number',
          description: 'Delay in milliseconds before job can run (default: 0)',
        },
        maxAttempts: {
          type: 'number',
          description: 'Maximum execution retry attempts (default: 3)',
        },
      },
      required: ['payload'],
    },
  },
  {
    name: 'workmatic_retry_job',
    description: 'Retry a specific dead or failed job by resetting it to ready status',
    inputSchema: {
      type: 'object',
      properties: {
        publicId: {
          type: 'string',
          description: 'Public ID of the job to retry',
        },
      },
      required: ['publicId'],
    },
  },
  {
    name: 'workmatic_retry_all_dead',
    description: 'Retry all dead jobs (optionally in a specific queue) by resetting them to ready status',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Optional queue name to restrict retrying',
        },
      },
    },
  },
  {
    name: 'workmatic_pause_queue',
    description: 'Pause a queue so workers stop claiming new jobs from it',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Queue name to pause',
        },
      },
      required: ['queue'],
    },
  },
  {
    name: 'workmatic_resume_queue',
    description: 'Resume a paused queue so workers resume claiming jobs',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Queue name to resume',
        },
      },
      required: ['queue'],
    },
  },
  {
    name: 'workmatic_purge_jobs',
    description: 'Permanently remove done or dead jobs from the database',
    inputSchema: {
      type: 'object',
      properties: {
        queue: {
          type: 'string',
          description: 'Queue name to purge jobs from (optional)',
        },
        status: {
          type: 'string',
          enum: ['done', 'dead', 'all'],
          description: 'Status of jobs to purge (default: "done")',
        },
      },
    },
  },
  {
    name: 'workmatic_transfer_jobs',
    description: 'Move jobs from one queue to another (e.g. from dead-letter queue back to primary)',
    inputSchema: {
      type: 'object',
      properties: {
        fromQueue: {
          type: 'string',
          description: 'Source queue name',
        },
        toQueue: {
          type: 'string',
          description: 'Destination queue name',
        },
        status: {
          type: 'string',
          enum: ['ready', 'dead'],
          description: 'Status of jobs to transfer (default: "ready")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of jobs to transfer (default: 1000)',
        },
        resetForRetry: {
          type: 'boolean',
          description: 'If transferring dead jobs, reset their status to ready (default: false)',
        },
      },
      required: ['fromQueue', 'toQueue'],
    },
  },
  {
    name: 'workmatic_update_job_status',
    description: 'Update the status of a specific job (ready, done, dead) and signal workers / listeners',
    inputSchema: {
      type: 'object',
      properties: {
        publicId: {
          type: 'string',
          description: 'Public ID of the job to update',
        },
        status: {
          type: 'string',
          enum: ['ready', 'done', 'dead'],
          description: 'New status for the job',
        },
        error: {
          type: 'string',
          description: 'Optional error message when marking as dead or recording failure details',
        },
        resetAttempts: {
          type: 'boolean',
          description: 'Whether to reset attempts to 0 (default: true if status is ready, false otherwise)',
        },
        delayMs: {
          type: 'number',
          description: 'Delay in milliseconds before the job becomes ready (default: 0)',
        },
      },
      required: ['publicId', 'status'],
    },
  },
];

/**
 * Execute an MCP tool invocation against a Workmatic database
 */
export async function executeTool(
  db: WorkmaticDb,
  name: string,
  args: Record<string, unknown> = {},
  context?: ToolExecutionContext
): Promise<unknown> {

  switch (name) {
    case 'workmatic_list_queues': {
      const qJobs = await db
        .selectFrom('workmatic_jobs')
        .select('queue')
        .distinct()
        .execute();

      const qSettings = await db
        .selectFrom('workmatic_settings')
        .select('queue')
        .distinct()
        .execute();

      const set = new Set<string>();
      for (const r of qJobs) set.add(r.queue);
      for (const r of qSettings) {
        // filter out internal worker_state_ keys
        if (!r.queue.startsWith('worker_state_')) {
          set.add(r.queue);
        }
      }

      const queueList = Array.from(set).sort();
      const result: Array<{ queue: string; stats: Record<string, number>; isPaused: boolean }> = [];

      for (const q of queueList) {
        const client = createClient({ db, queue: q });
        const stats = await client.stats();
        const setting = await db
          .selectFrom('workmatic_settings')
          .select('paused')
          .where('queue', '=', q)
          .executeTakeFirst();

        result.push({
          queue: q,
          stats: {
            ready: stats.ready,
            running: stats.running,
            done: stats.done,
            dead: stats.dead,
            total: stats.total,
          },
          isPaused: setting?.paused === 1,
        });
      }

      return { queues: result, totalQueues: result.length };
    }

    case 'workmatic_get_stats': {
      const queue = args.queue as string | undefined;
      if (queue) {
        const client = createClient({ db, queue });
        return { queue, stats: await client.stats() };
      }

      // All queues
      const listRes = (await executeTool(db, 'workmatic_list_queues')) as {
        queues: Array<{ queue: string; stats: Record<string, number> }>;
      };

      const summary: Record<string, Record<string, number>> = {};
      const grandTotal = { ready: 0, running: 0, done: 0, dead: 0, total: 0 };

      for (const item of listRes.queues) {
        summary[item.queue] = item.stats;
        grandTotal.ready += item.stats.ready;
        grandTotal.running += item.stats.running;
        grandTotal.done += item.stats.done;
        grandTotal.dead += item.stats.dead;
        grandTotal.total += item.stats.total;
      }

      return { queues: summary, grandTotal };
    }

    case 'workmatic_list_jobs': {
      const queue = args.queue as string | undefined;
      const status = args.status as JobStatus | undefined;
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
      const offset = Math.max(Number(args.offset ?? 0), 0);

      let query = db
        .selectFrom('workmatic_jobs')
        .select([
          'id',
          'public_id',
          'queue',
          'status',
          'priority',
          'payload',
          'attempts',
          'max_attempts',
          'run_at',
          'created_at',
          'updated_at',
          'last_error',
        ]);

      if (queue) {
        query = query.where('queue', '=', queue);
      }
      if (status) {
        query = query.where('status', '=', status);
      }

      const rows = await query
        .orderBy('priority', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .offset(offset)
        .execute();

      const jobs = rows.map((r) => {
        let parsedPayload: unknown;
        try {
          parsedPayload = JSON.parse(r.payload);
        } catch {
          parsedPayload = r.payload;
        }
        return {
          id: r.id,
          publicId: r.public_id,
          queue: r.queue,
          status: r.status,
          priority: r.priority,
          attempts: r.attempts,
          maxAttempts: r.max_attempts,
          runAt: r.run_at,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          lastError: r.last_error,
          payload: parsedPayload,
        };
      });

      return { jobs, count: jobs.length, limit, offset };
    }

    case 'workmatic_get_dead_jobs': {
      const queue = args.queue as string | undefined;
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);

      return executeTool(db, 'workmatic_list_jobs', {
        queue,
        status: 'dead',
        limit,
      });
    }

    case 'workmatic_add_job': {
      const queue = (args.queue as string) || 'default';
      const payload = args.payload;
      const priority = args.priority !== undefined ? Number(args.priority) : 0;
      const delayMs = args.delayMs !== undefined ? Number(args.delayMs) : 0;
      const maxAttempts = args.maxAttempts !== undefined ? Number(args.maxAttempts) : 3;

      const client = createClient({ db, queue });
      const result = await client.add(payload, { priority, delayMs, maxAttempts });
      return { ok: true, id: result.id, queue };
    }

    case 'workmatic_retry_job': {
      const publicId = args.publicId as string;
      if (!publicId) {
        throw new Error('publicId is required');
      }

      const job = await db
        .selectFrom('workmatic_jobs')
        .select(['queue', 'status'])
        .where('public_id', '=', publicId)
        .executeTakeFirst();

      if (!job) {
        throw new Error(`Job not found: ${publicId}`);
      }

      const timestamp = now();
      await db
        .updateTable('workmatic_jobs')
        .set({
          status: 'ready',
          attempts: 0,
          lease_until: 0,
          last_error: null,
          run_at: timestamp,
          updated_at: timestamp,
        })
        .where('public_id', '=', publicId)
        .execute();

      context?.onJobStatusChanged?.({
        publicId,
        queue: job.queue,
        previousStatus: job.status as JobStatus,
        status: 'ready',
        timestamp,
        error: null,
      });

      return { ok: true, id: publicId, message: `Job ${publicId} reset to ready` };
    }

    case 'workmatic_retry_all_dead': {
      const queue = args.queue as string | undefined;
      const timestamp = now();

      let query = db
        .updateTable('workmatic_jobs')
        .set({
          status: 'ready',
          attempts: 0,
          lease_until: 0,
          last_error: null,
          run_at: timestamp,
          updated_at: timestamp,
        })
        .where('status', '=', 'dead');

      if (queue) {
        query = query.where('queue', '=', queue);
      }

      const res = await query.execute();
      const retriedCount = Number(res[0].numUpdatedRows);

      if (retriedCount > 0) {
        context?.onJobStatusChanged?.({
          publicId: '*',
          queue: queue ?? '*',
          previousStatus: 'dead',
          status: 'ready',
          timestamp,
          error: null,
        });
      }

      return { ok: true, retriedCount, queue: queue ?? 'all' };
    }

    case 'workmatic_update_job_status': {
      const publicId = args.publicId as string;
      const status = args.status as JobStatus;
      if (!publicId) {
        throw new Error('publicId is required');
      }
      if (!status || !['ready', 'done', 'dead'].includes(status)) {
        throw new Error("status is required and must be 'ready', 'done', or 'dead'");
      }

      const job = await db
        .selectFrom('workmatic_jobs')
        .select(['id', 'public_id', 'queue', 'status', 'attempts'])
        .where('public_id', '=', publicId)
        .executeTakeFirst();

      if (!job) {
        throw new Error(`Job not found: ${publicId}`);
      }

      if (job.status === status) {
        return {
          ok: true,
          id: publicId,
          queue: job.queue,
          status,
          unchanged: true,
        };
      }

      const timestamp = now();
      const previousStatus = job.status as JobStatus;
      const delayMs = Math.max(Number(args.delayMs ?? 0), 0);
      const resetAttempts =
        args.resetAttempts !== undefined
          ? Boolean(args.resetAttempts)
          : status === 'ready';

      const updateData: Record<string, unknown> = {
        status,
        updated_at: timestamp,
        lease_until: 0,
      };

      if (status === 'ready') {
        updateData.run_at = timestamp + delayMs;
      }
      if (resetAttempts) {
        updateData.attempts = 0;
      }
      if (args.error !== undefined) {
        updateData.last_error = args.error;
      } else if (status === 'ready') {
        updateData.last_error = null;
      }

      await db
        .updateTable('workmatic_jobs')
        .set(updateData)
        .where('public_id', '=', publicId)
        .execute();

      const event: JobStatusChangeEvent = {
        publicId,
        queue: job.queue,
        previousStatus,
        status,
        timestamp,
        error: (updateData.last_error as string | null) ?? null,
      };

      context?.onJobStatusChanged?.(event);

      return {
        ok: true,
        id: publicId,
        queue: job.queue,
        previousStatus,
        status,
        signaled: true,
      };
    }


    case 'workmatic_pause_queue': {
      const queue = args.queue as string;
      if (!queue) {
        throw new Error('queue is required');
      }

      const timestamp = now();
      await sql`
        INSERT INTO workmatic_settings (queue, paused, updated_at)
        VALUES (${queue}, 1, ${timestamp})
        ON CONFLICT(queue) DO UPDATE SET
          paused = 1,
          updated_at = ${timestamp}
      `.execute(db);

      return { ok: true, queue, paused: true };
    }

    case 'workmatic_resume_queue': {
      const queue = args.queue as string;
      if (!queue) {
        throw new Error('queue is required');
      }

      const timestamp = now();
      await sql`
        INSERT INTO workmatic_settings (queue, paused, updated_at)
        VALUES (${queue}, 0, ${timestamp})
        ON CONFLICT(queue) DO UPDATE SET
          paused = 0,
          updated_at = ${timestamp}
      `.execute(db);

      return { ok: true, queue, paused: false };
    }

    case 'workmatic_purge_jobs': {
      const queue = args.queue as string | undefined;
      const status = (args.status as string) || 'done';

      let query = db.deleteFrom('workmatic_jobs');

      if (queue) {
        query = query.where('queue', '=', queue);
      }

      if (status !== 'all') {
        query = query.where('status', '=', status as JobStatus);
      }

      const res = await query.execute();
      const deletedCount = Number(res[0].numDeletedRows);
      return { ok: true, deletedCount, queue: queue ?? 'all', status };
    }


    case 'workmatic_transfer_jobs': {
      const fromQueue = args.fromQueue as string;
      const toQueue = args.toQueue as string;
      if (!fromQueue || !toQueue) {
        throw new Error('fromQueue and toQueue are required');
      }
      if (fromQueue === toQueue) {
        return { ok: true, moved: 0 };
      }

      const status = (args.status as JobStatus) || 'ready';
      const limit = Math.max(Number(args.limit ?? 1000), 1);
      const resetForRetry = Boolean(args.resetForRetry);

      const orch = createOrchestrator({ db });
      const result = await orch.transfer({
        from: fromQueue,
        to: toQueue,
        status,
        limit,
        resetForRetry,
      });

      return {
        ok: true,
        moved: result.moved,
        fromQueue,
        toQueue,
        status: resetForRetry && status === 'dead' ? 'ready' : status,
      };
    }


    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
