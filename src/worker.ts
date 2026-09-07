import fastq from 'fastq';
import type { queueAsPromised } from 'fastq';
import { sql, CompiledQuery } from 'kysely';
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
  GracefulShutdownOptions,
} from './types.js';
import { defaultBackoff, parsePayload, now } from './utils.js';
import { attachGracefulShutdown } from './shutdown.js';

/** Default job execution timeout when `timeoutMs` is omitted (1 minute). Use `timeoutMs: 0` for no limit. */
export const DEFAULT_WORKER_TIMEOUT_MS = 60_000;

/** @internal Exported for tests — maps SQLite RETURNING result to claimed jobs */
export function parseClaimedRows(result: unknown): ClaimedJob[] {
  const rows = (result as { rows?: ClaimedJob[] }).rows;
  if (!rows || !Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => ({
    id: row.id,
    public_id: row.public_id,
    queue: row.queue,
    payload: row.payload,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    priority: row.priority,
    created_at: row.created_at,
    last_error: row.last_error,
  }));
}

/** @internal Exported for tests */
export function requireProcessor<T>(processor: JobProcessor<T> | null): JobProcessor<T> {
  if (!processor) {
    throw new Error('No processor set');
  }
  return processor;
}

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
    timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
    backoff = defaultBackoff,
    persistState = false,
    autoRestore = true,
    pauseCheckIntervalMs = 300,
    requeueExpiredIntervalMs = 0,
    onPumpError,
    completionBatchSize = 50,
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
  let lastPauseCheckAt = 0;
  let cachedDbPaused = false;
  let lastRequeueAt = 0;
  let pendingDone: Array<{ id: number; resolve: () => void; reject: (err: unknown) => void }> = [];
  let flushTimeout: NodeJS.Immediate | null = null;

  function notifyPumpError(error: unknown): void {
    console.error('[workmatic] Pump error:', error);
    onPumpError?.(error);
  }

  /**
   * Get the settings key for this worker's state
   */
  function getStateKey(): string {
    return `worker_state_${queue}`;
  }

  async function saveState(state: WorkerState): Promise<void> {
    if (!persistState) return;

    const timestamp = now();
    const key = getStateKey();

    try {
      // Use raw SQL for upsert since different SQLite versions have different syntax
      await sql`
        INSERT INTO workmatic_settings (queue, paused, updated_at)
        VALUES (${key}, ${state === 'paused' ? 1 : state === 'running' ? 2 : 0}, ${timestamp})
        ON CONFLICT(queue) DO UPDATE SET 
          paused = ${state === 'paused' ? 1 : state === 'running' ? 2 : 0},
          updated_at = ${timestamp}
      `.execute(db);
    } catch {
      // Ignore errors
    }
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
   * Claim a batch of jobs for processing (single UPDATE … RETURNING per SQLite 3.35+)
   */
  async function claimBatch(limit: number): Promise<ClaimedJob[]> {
    const timestamp = now();
    const leaseUntil = timestamp + leaseMs;

    const result = await sql<{
      id: number;
      public_id: string;
      queue: string;
      payload: string;
      attempts: number;
      max_attempts: number;
      priority: number;
      created_at: number;
      last_error: string | null;
    }>`
      UPDATE workmatic_jobs
      SET status = 'running', lease_until = ${leaseUntil}, updated_at = ${timestamp}
      WHERE rowid IN (
        SELECT rowid FROM workmatic_jobs
        WHERE queue = ${queue}
          AND status = 'ready'
          AND run_at <= ${timestamp}
        ORDER BY priority ASC, id ASC
        LIMIT ${limit}
      )
      RETURNING id, public_id, queue, payload, attempts, max_attempts, priority, created_at, last_error
    `.execute(db);

    return parseClaimedRows(result);
  }

  /**
   * Flush all buffered completion updates in a single batch
   */
  async function flushDoneBatch(): Promise<void> {
    if (flushTimeout !== null) {
      clearImmediate(flushTimeout);
      flushTimeout = null;
    }
    if (pendingDone.length === 0) {
      return;
    }
    const current = pendingDone;
    pendingDone = [];

    const timestamp = now();
    try {
      if (current.length === 1) {
        await db.executeQuery(
          CompiledQuery.raw(
            "UPDATE workmatic_jobs SET status = 'done', lease_until = 0, updated_at = ? WHERE id = ?",
            [timestamp, current[0].id]
          )
        );
      } else {
        const CHUNK_SIZE = 500;
        for (let i = 0; i < current.length; i += CHUNK_SIZE) {
          const chunk = current.slice(i, i + CHUNK_SIZE);
          const placeholders = chunk.map(() => '?').join(', ');
          const params = [timestamp, ...chunk.map((item) => item.id)];
          await db.executeQuery(
            CompiledQuery.raw(
              `UPDATE workmatic_jobs SET status = 'done', lease_until = 0, updated_at = ? WHERE id IN (${placeholders})`,
              params
            )
          );
        }
      }
      for (const item of current) {
        item.resolve();
      }
    } catch (err) {
      for (const item of current) {
        item.reject(err);
      }
    }
  }

  /**
   * Mark a job as completed (buffers for micro-batching if completionBatchSize > 0)
   */
  function markDone(jobId: number): Promise<void> {
    if (completionBatchSize <= 0) {
      return db.executeQuery(
        CompiledQuery.raw(
          "UPDATE workmatic_jobs SET status = 'done', lease_until = 0, updated_at = ? WHERE id = ?",
          [now(), jobId]
        )
      ).then(() => {});
    }

    return new Promise((resolve, reject) => {
      pendingDone.push({ id: jobId, resolve, reject });
      if (pendingDone.length >= completionBatchSize) {
        void flushDoneBatch();
      } else if (!flushTimeout) {
        flushTimeout = setImmediate(() => {
          flushTimeout = null;
          void flushDoneBatch();
        });
      }
    });
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
      
      await db.executeQuery(
        CompiledQuery.raw(
          "UPDATE workmatic_jobs SET status = 'ready', attempts = ?, run_at = ?, lease_until = 0, last_error = ?, updated_at = ? WHERE id = ?",
          [newAttempts, runAt, errorMessage, timestamp, jobId]
        )
      );
    } else {
      // Max attempts reached: mark as dead
      await db.executeQuery(
        CompiledQuery.raw(
          "UPDATE workmatic_jobs SET status = 'dead', attempts = ?, lease_until = 0, last_error = ?, updated_at = ? WHERE id = ?",
          [newAttempts, errorMessage, timestamp, jobId]
        )
      );
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
    const fn = requireProcessor(processor);

    // Parse payload and create job object
    const payload = parsePayload(claimedJob.payload);
    const job: Job = {
      id: claimedJob.public_id,
      queue: claimedJob.queue,
      payload,
      status: 'running',
      priority: claimedJob.priority,
      attempts: claimedJob.attempts,
      maxAttempts: claimedJob.max_attempts,
      createdAt: claimedJob.created_at,
      lastError: claimedJob.last_error,
    };

    try {
      // Run processor with optional timeout
      if (timeoutMs) {
        await withTimeout(fn(job), timeoutMs, job.id);
      } else {
        await fn(job);
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
    const result = await db.executeQuery<{ paused: number }>(
      CompiledQuery.raw(
        'SELECT paused FROM workmatic_settings WHERE queue = ? LIMIT 1',
        [queue]
      )
    );
    return result.rows[0]?.paused === 1;
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
      const t = now();
      if (t - lastPauseCheckAt >= pauseCheckIntervalMs) {
        lastPauseCheckAt = t;
        cachedDbPaused = await isQueuePausedInDb();
      }
      if (cachedDbPaused) {
        pumpTimeout = setTimeout(pump, pollMs);
        return;
      }

      if (
        requeueExpiredIntervalMs <= 0 ||
        t - lastRequeueAt >= requeueExpiredIntervalMs
      ) {
        if (requeueExpiredIntervalMs > 0) {
          lastRequeueAt = t;
        }
        await requeueExpiredLeases();
      }

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
      notifyPumpError(error);
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
      void saveState('running');

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
      await fastqQueue!.drained();
      fastqQueue = null;

      // Flush remaining buffered completions
      await flushDoneBatch();

      // Save state to database
      await saveState('stopped');
    },

    pause(): void {
      paused = true;
      void flushDoneBatch();
      void saveState('paused');
    },

    resume(): void {
      paused = false;
      void saveState('running');
    },

    async stats(): Promise<JobStats> {
      await flushDoneBatch();

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

    wakeUp(): void {
      if (!running || paused) {
        return;
      }
      if (pumpTimeout) {
        clearTimeout(pumpTimeout);
        pumpTimeout = null;
      }
      pumpTimeout = setTimeout(pump, 0);
    },

    async flushCompletions(): Promise<void> {
      await flushDoneBatch();
    },

    attachSignalHandlers(options?: GracefulShutdownOptions): () => void {
      return attachGracefulShutdown(this, options);
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
