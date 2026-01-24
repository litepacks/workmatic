import fastq from 'fastq';
import type { queueAsPromised } from 'fastq';
import { sql } from 'kysely';
import type {
  WorkmaticDb,
  WorkerOptions,
  WorkmaticWorker,
  JobProcessor,
  JobStats,
  JobStatus,
  Job,
  ClaimedJob,
  WorkerState,
} from './types.js';
import { defaultBackoff, parsePayload, sleep, now } from './utils.js';

/**
 * Create a job queue worker for processing jobs
 * 
 * @param options - Worker options
 * @returns Worker instance
 * 
 * @example
 * ```ts
 * const worker = createWorker({ db, concurrency: 4 });
 * 
 * // Set the processor function
 * worker.process(async (job) => {
 *   console.log('Processing job:', job.id);
 *   await sendEmail(job.payload.email);
 * });
 * 
 * // Start processing
 * worker.start();
 * 
 * // Later, gracefully stop
 * await worker.stop();
 * ```
 */
export function createWorker(options: WorkerOptions): WorkmaticWorker {
  const {
    db,
    queue = 'default',
    concurrency = 1,
    leaseMs = 30000,
    pollMs = 1000,
    timeoutMs,
    backoff = defaultBackoff,
    persistState = false,
    autoRestore = true,
  } = options;

  if (!db) {
    throw new Error('Database instance is required');
  }

  // State
  let running = false;
  let paused = false;
  let processor: JobProcessor<any> | null = null;
  let pumpTimeout: NodeJS.Timeout | null = null;
  let fastqQueue: queueAsPromised<ClaimedJob, void> | null = null;

  /**
   * Get the settings key for this worker's state
   */
  function getStateKey(): string {
    return `worker_state_${queue}`;
  }

  /**
   * Save worker state to database
   */
  async function saveState(state: WorkerState): Promise<void> {
    if (!persistState) return;

    const timestamp = now();
    const key = getStateKey();

    // Ensure settings table exists
    await db.schema
      .createTable('workmatic_settings')
      .ifNotExists()
      .addColumn('queue', 'text', (col) => col.primaryKey())
      .addColumn('paused', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('updated_at', 'integer', (col) => col.notNull())
      .execute()
      .catch(() => {}); // Ignore if exists

    // Use raw SQL for upsert since different SQLite versions have different syntax
    await sql`
      INSERT INTO workmatic_settings (queue, paused, updated_at)
      VALUES (${key}, ${state === 'paused' ? 1 : state === 'running' ? 2 : 0}, ${timestamp})
      ON CONFLICT(queue) DO UPDATE SET 
        paused = ${state === 'paused' ? 1 : state === 'running' ? 2 : 0},
        updated_at = ${timestamp}
    `.execute(db);
  }

  /**
   * Load worker state from database
   */
  async function loadState(): Promise<WorkerState | null> {
    if (!persistState) return null;

    try {
      const key = getStateKey();
      const result = await db
        .selectFrom('workmatic_settings')
        .select('paused')
        .where('queue', '=', key)
        .executeTakeFirst();

      if (!result) return null;
      
      // paused: 0 = stopped, 1 = paused, 2 = running
      if (result.paused === 2) return 'running';
      if (result.paused === 1) return 'paused';
      return 'stopped';
    } catch {
      return null;
    }
  }

  /**
   * Requeue jobs with expired leases
   */
  async function requeueExpiredLeases(): Promise<number> {
    const timestamp = now();

    const result = await db
      .updateTable('workmatic_jobs')
      .set({
        status: 'ready',
        lease_until: 0,
        updated_at: timestamp,
      })
      .where('status', '=', 'running')
      .where('lease_until', '<', timestamp)
      .where('lease_until', '>', 0)
      .execute();

    return Number(result[0]?.numUpdatedRows ?? 0);
  }

  /**
   * Claim a batch of jobs for processing
   */
  async function claimBatch(limit: number): Promise<ClaimedJob[]> {
    const timestamp = now();
    const leaseUntil = timestamp + leaseMs;

    // Use a transaction to ensure atomic claim
    return await db.transaction().execute(async (trx) => {
      // Select eligible jobs
      const jobs = await trx
        .selectFrom('workmatic_jobs')
        .select(['id', 'public_id', 'queue', 'payload', 'attempts', 'max_attempts'])
        .where('queue', '=', queue)
        .where('status', '=', 'ready')
        .where('run_at', '<=', timestamp)
        .orderBy('priority', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .execute();

      if (jobs.length === 0) {
        return [];
      }

      // Get the IDs of claimed jobs
      const jobIds = jobs.map(j => j.id);

      // Update them to running status
      await trx
        .updateTable('workmatic_jobs')
        .set({
          status: 'running',
          lease_until: leaseUntil,
          updated_at: timestamp,
        })
        .where('id', 'in', jobIds)
        .execute();

      return jobs;
    });
  }

  /**
   * Mark a job as completed
   */
  async function markDone(jobId: number): Promise<void> {
    await db
      .updateTable('workmatic_jobs')
      .set({
        status: 'done',
        lease_until: 0,
        updated_at: now(),
      })
      .where('id', '=', jobId)
      .execute();
  }

  /**
   * Handle job failure
   */
  async function markFailed(
    jobId: number,
    attempts: number,
    maxAttempts: number,
    error: Error
  ): Promise<void> {
    const timestamp = now();
    const newAttempts = attempts + 1;
    const errorMessage = error.message || String(error);

    if (newAttempts < maxAttempts) {
      // Retry: set back to ready with backoff delay
      const runAt = timestamp + backoff(newAttempts);
      
      await db
        .updateTable('workmatic_jobs')
        .set({
          status: 'ready',
          attempts: newAttempts,
          run_at: runAt,
          lease_until: 0,
          last_error: errorMessage,
          updated_at: timestamp,
        })
        .where('id', '=', jobId)
        .execute();
    } else {
      // Max attempts reached: mark as dead
      await db
        .updateTable('workmatic_jobs')
        .set({
          status: 'dead',
          attempts: newAttempts,
          lease_until: 0,
          last_error: errorMessage,
          updated_at: timestamp,
        })
        .where('id', '=', jobId)
        .execute();
    }
  }

  /**
   * Run a promise with timeout
   */
  async function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    jobId: string
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Job ${jobId} timed out after ${ms}ms`));
      }, ms);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  /**
   * Process a single job
   */
  async function processJob(claimedJob: ClaimedJob): Promise<void> {
    if (!processor) {
      throw new Error('No processor set');
    }

    // Parse payload and create job object
    const payload = parsePayload(claimedJob.payload);
    const job: Job = {
      id: claimedJob.public_id,
      queue: claimedJob.queue,
      payload,
      status: 'running',
      priority: 0, // Not needed for processing
      attempts: claimedJob.attempts,
      maxAttempts: claimedJob.max_attempts,
      createdAt: 0, // Not needed for processing
      lastError: null,
    };

    try {
      // Run processor with optional timeout
      if (timeoutMs) {
        await withTimeout(processor(job), timeoutMs, job.id);
      } else {
        await processor(job);
      }
      await markDone(claimedJob.id);
    } catch (error) {
      await markFailed(
        claimedJob.id,
        claimedJob.attempts,
        claimedJob.max_attempts,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Check if queue is paused in database (for CLI control)
   */
  async function isQueuePausedInDb(): Promise<boolean> {
    const setting = await db
      .selectFrom('workmatic_settings')
      .select('paused')
      .where('queue', '=', queue)
      .executeTakeFirst();
    
    return setting?.paused === 1;
  }

  /**
   * Main pump loop
   */
  async function pump(): Promise<void> {
    if (!running) {
      return;
    }

    // Check both in-memory pause and database pause (for CLI control)
    if (paused) {
      pumpTimeout = setTimeout(pump, pollMs);
      return;
    }

    try {
      // Check database pause state (allows CLI to pause running workers)
      const dbPaused = await isQueuePausedInDb();
      if (dbPaused) {
        pumpTimeout = setTimeout(pump, pollMs);
        return;
      }

      // Requeue expired leases
      await requeueExpiredLeases();

      // Claim a batch of jobs
      const batchSize = concurrency * 2;
      const jobs = await claimBatch(batchSize);

      if (jobs.length > 0) {
        // Push jobs into fastq
        for (const job of jobs) {
          fastqQueue!.push(job);
        }
        // Immediately pump again
        pumpTimeout = setTimeout(pump, 0);
      } else {
        // No jobs, wait before polling again
        pumpTimeout = setTimeout(pump, pollMs);
      }
    } catch (error) {
      // Log error and continue
      console.error('[workmatic] Pump error:', error);
      pumpTimeout = setTimeout(pump, pollMs);
    }
  }

  // Create the worker object
  const worker: WorkmaticWorker = {
    process<TPayload = unknown>(fn: JobProcessor<TPayload>): void {
      processor = fn as JobProcessor<any>;
    },

    start(): void {
      if (running) {
        return;
      }

      if (!processor) {
        throw new Error('No processor set. Call process() before start()');
      }

      running = true;
      paused = false;

      // Create fastq queue
      fastqQueue = fastq.promise(processJob, concurrency);

      // Save state to database
      saveState('running').catch(() => {});

      // Start pump loop
      pump();
    },

    async stop(): Promise<void> {
      if (!running) {
        return;
      }

      running = false;

      // Clear pump timeout
      if (pumpTimeout) {
        clearTimeout(pumpTimeout);
        pumpTimeout = null;
      }

      // Wait for fastq to drain
      if (fastqQueue) {
        await fastqQueue.drained();
        fastqQueue = null;
      }

      // Save state to database
      await saveState('stopped');
    },

    pause(): void {
      paused = true;
      saveState('paused').catch(() => {});
    },

    resume(): void {
      paused = false;
      saveState('running').catch(() => {});
    },

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

    get isRunning(): boolean {
      return running;
    },

    get isPaused(): boolean {
      return paused;
    },

    get queue(): string {
      return queue;
    },

    async restoreState(): Promise<WorkerState | null> {
      const state = await loadState();
      if (state === 'running' && processor) {
        this.start();
      } else if (state === 'paused' && processor) {
        this.start();
        this.pause();
      }
      return state;
    },

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

  // Auto-restore state if enabled
  if (persistState && autoRestore) {
    // Use setImmediate to allow processor to be set first
    setImmediate(async () => {
      if (processor) {
        await worker.restoreState();
      }
    });
  }

  return worker;
}
