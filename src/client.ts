import { nanoid } from 'nanoid';
import { sql } from 'kysely';
import type {
  WorkmaticDb,
  ClientOptions,
  WorkmaticClient,
  AddJobOptions,
  AddJobResult,
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
  const { db, queue = 'default' } = options;

  if (!db) {
    throw new Error('Database instance is required');
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
      await db
        .insertInto('workmatic_jobs')
        .values({
          public_id: publicId,
          queue,
          payload: payloadJson,
          status: 'ready',
          priority,
          run_at: runAt,
          attempts: 0,
          max_attempts: maxAttempts,
          lease_until: 0,
          created_at: timestamp,
          updated_at: timestamp,
          last_error: null,
        })
        .execute();

      return { ok: true, id: publicId };
    },

    /**
     * Get job statistics for the queue
     */
    async stats(): Promise<JobStats> {
      const result = await db
        .selectFrom('workmatic_jobs')
        .select([
          'status',
          sql<number>`count(*)`.as('count'),
        ])
        .where('queue', '=', queue)
        .groupBy('status')
        .execute();

      const stats: JobStats = {
        ready: 0,
        running: 0,
        done: 0,
        failed: 0,
        dead: 0,
        total: 0,
      };

      for (const row of result) {
        const status = row.status as JobStatus;
        const count = Number(row.count);
        if (status in stats) {
          stats[status] = count;
        }
        stats.total += count;
      }

      return stats;
    },
  };
}
