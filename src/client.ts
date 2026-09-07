import { nanoid } from 'nanoid';
import { CompiledQuery } from 'kysely';
import type {
  WorkmaticDb,
  ClientOptions,
  WorkmaticClient,
  AddJobOptions,
  AddJobResult,
  AddManyResult,
  JobStats,
  JobStatus,
} from './types.js';
import { validatePayload, now } from './utils.js';

/**
 * Create a job queue client for adding jobs
 * 
 * @param options - Client options
 * @returns Client instance
 * 
 * @example
 * ```ts
 * const client = createClient({ db });
 * 
 * // Add a simple job
 * const result = await client.add({ email: 'user@example.com' });
 * console.log(result.id); // Job public ID
 * 
 * // Add a job with options
 * await client.add(
 *   { userId: 123 },
 *   { priority: 1, delayMs: 5000, maxAttempts: 5 }
 * );
 * 
 * // Get queue statistics
 * const stats = await client.stats();
 * console.log(stats); // { ready: 5, running: 2, done: 100, ... }
 * ```
 */
export function createClient(options: ClientOptions): WorkmaticClient {
  const { db, queue = 'default', onJobAdded, worker } = options;

  if (!db) {
    throw new Error('Database instance is required');
  }

  function notifyJobAdded(delayMs: number): void {
    if (delayMs <= 0) {
      worker?.wakeUp();
      onJobAdded?.();
    }
  }

  return {
    /**
     * Add a job to the queue
     */
    async add<TPayload = unknown>(
      payload: TPayload,
      opts: AddJobOptions = {}
    ): Promise<AddJobResult> {
      const {
        priority = 0,
        delayMs = 0,
        maxAttempts = 3,
      } = opts;

      // Validate and serialize payload
      const payloadJson = validatePayload(payload);
      
      // Generate unique public ID
      const publicId = nanoid();
      
      const timestamp = now();
      const runAt = timestamp + delayMs;

      // Insert job
      await db.executeQuery(
        CompiledQuery.raw(
          `INSERT INTO workmatic_jobs (public_id, queue, payload, status, priority, run_at, attempts, max_attempts, lease_until, created_at, updated_at, last_error) VALUES (?, ?, ?, 'ready', ?, ?, 0, ?, 0, ?, ?, null)`,
          [publicId, queue, payloadJson, priority, runAt, maxAttempts, timestamp, timestamp]
        )
      );

      notifyJobAdded(delayMs);

      return { ok: true, id: publicId };
    },

    async addMany<TPayload = unknown>(
      payloads: TPayload[],
      opts: AddJobOptions = {}
    ): Promise<AddManyResult> {
      const {
        priority = 0,
        delayMs = 0,
        maxAttempts = 3,
      } = opts;

      if (payloads.length === 0) {
        return { ok: true, ids: [] };
      }

      const timestamp = now();
      const runAt = timestamp + delayMs;

      const result = await db.transaction().execute(async (trx) => {
        const ids: string[] = [];
        const rows = payloads.map((payload) => {
          const payloadJson = validatePayload(payload);
          const publicId = nanoid();
          ids.push(publicId);
          return {
            public_id: publicId,
            queue,
            payload: payloadJson,
            status: 'ready' as const,
            priority,
            run_at: runAt,
            attempts: 0,
            max_attempts: maxAttempts,
            lease_until: 0,
            created_at: timestamp,
            updated_at: timestamp,
            last_error: null,
          };
        });

        await trx.insertInto('workmatic_jobs').values(rows).execute();
        return { ok: true as const, ids };
      });

      notifyJobAdded(delayMs);

      return result;
    },

    /**
     * Get job statistics for the queue
     */
    async stats(): Promise<JobStats> {
      const result = await db.executeQuery<{ status: JobStatus; count: number }>(
        CompiledQuery.raw(
          'SELECT status, count(*) AS count FROM workmatic_jobs WHERE queue = ? GROUP BY status',
          [queue]
        )
      );

      const stats: JobStats = {
        ready: 0,
        running: 0,
        done: 0,
        dead: 0,
        total: 0,
      };

      for (const row of result.rows) {
        const status = row.status;
        const count = Number(row.count);
        if (status in stats) {
          stats[status] = count;
        }
        stats.total += count;
      }

      return stats;
    },

    /**
     * Clear all jobs from the queue
     */
    async clear(options: { status?: JobStatus } = {}): Promise<number> {
      let query = db
        .deleteFrom('workmatic_jobs')
        .where('queue', '=', queue);

      if (options.status) {
        query = query.where('status', '=', options.status);
      }

      const result = await query.execute();
      return Number(result[0]?.numDeletedRows ?? 0);
    },
  };
}
