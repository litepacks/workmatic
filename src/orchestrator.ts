import { sql } from 'kysely';
import { createClient } from './client.js';
import { createWorker } from './worker.js';
import type {
  WorkmaticDb,
  OrchestratorOptions,
  RegisterQueueOptions,
  WorkmaticOrchestrator,
  WorkmaticClient,
  WorkmaticWorker,
  TransferOptions,
  TransferResult,
  MoveJobOptions,
  JobStats,
  JobStatus,
  JobProcessor,
} from './types.js';
import { now } from './utils.js';

const DEFAULT_TRANSFER_STATUSES: JobStatus[] = ['ready', 'dead'];
const DEFAULT_TRANSFER_LIMIT = 10_000;

/** @internal Exported for tests */
export function rowsUpdated(result: unknown): number {
  const row = (result as { numUpdatedRows?: number | bigint }[])[0];
  return Number(row?.numUpdatedRows ?? 0);
}

function normalizeStatuses(status?: JobStatus | JobStatus[]): JobStatus[] {
  if (!status) return [...DEFAULT_TRANSFER_STATUSES];
  return Array.isArray(status) ? status : [status];
}

interface QueueEntry {
  client: WorkmaticClient;
  worker?: WorkmaticWorker;
}

/**
 * Create a multi-queue orchestrator for registration, lifecycle, and transfers.
 */
export function createOrchestrator(options: OrchestratorOptions): WorkmaticOrchestrator {
  const { db } = options;
  if (!db) {
    throw new Error('Database instance is required');
  }

  const registry = new Map<string, QueueEntry>();

  function ensureEntry(queue: string): QueueEntry {
    let entry = registry.get(queue);
    if (!entry) {
      entry = { client: createClient({ db, queue }) };
      registry.set(queue, entry);
    }
    return entry;
  }

  async function setQueuePaused(queue: string, paused: boolean): Promise<void> {
    const timestamp = now();
    const value = paused ? 1 : 0;
    await sql`
      INSERT INTO workmatic_settings (queue, paused, updated_at)
      VALUES (${queue}, ${value}, ${timestamp})
      ON CONFLICT(queue) DO UPDATE SET
        paused = ${value},
        updated_at = ${timestamp}
    `.execute(db);
  }

  async function selectJobIds(
    from: string,
    status: JobStatus,
    limit: number
  ): Promise<number[]> {
    const rows = await db
      .selectFrom('workmatic_jobs')
      .select('id')
      .where('queue', '=', from)
      .where('status', '=', status)
      .orderBy('priority', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }

  async function transferReady(from: string, to: string, limit: number): Promise<number> {
    const ids = await selectJobIds(from, 'ready', limit);
    if (ids.length === 0) return 0;
    const timestamp = now();
    const result = await db
      .updateTable('workmatic_jobs')
      .set({ queue: to, updated_at: timestamp })
      .where('id', 'in', ids)
      .execute();
    return rowsUpdated(result);
  }

  async function transferDead(
    from: string,
    to: string,
    limit: number,
    resetForRetry: boolean
  ): Promise<number> {
    const ids = await selectJobIds(from, 'dead', limit);
    if (ids.length === 0) return 0;
    const timestamp = now();
    if (resetForRetry) {
      const result = await db
        .updateTable('workmatic_jobs')
        .set({
          queue: to,
          status: 'ready',
          attempts: 0,
          lease_until: 0,
          last_error: null,
          updated_at: timestamp,
          run_at: timestamp,
        })
        .where('id', 'in', ids)
        .execute();
      return rowsUpdated(result);
    }

    const result = await db
      .updateTable('workmatic_jobs')
      .set({ queue: to, updated_at: timestamp })
      .where('id', 'in', ids)
      .execute();
    return rowsUpdated(result);
  }

  async function transferOtherStatus(
    from: string,
    to: string,
    status: JobStatus,
    limit: number
  ): Promise<number> {
    const ids = await selectJobIds(from, status, limit);
    if (ids.length === 0) return 0;
    const timestamp = now();
    const result = await db
      .updateTable('workmatic_jobs')
      .set({ queue: to, updated_at: timestamp })
      .where('id', 'in', ids)
      .execute();
    return rowsUpdated(result);
  }

  const orchestrator: WorkmaticOrchestrator = {
    register(queue: string, opts: RegisterQueueOptions = {}): WorkmaticClient {
      const client = createClient({ db, queue });
      let worker: WorkmaticWorker | undefined;
      if (opts.worker) {
        worker = createWorker({ db, queue, ...opts.worker });
      }
      registry.set(queue, { client, worker });
      return client;
    },

    client(queue: string): WorkmaticClient {
      return ensureEntry(queue).client;
    },

    worker(queue: string): WorkmaticWorker {
      const entry = registry.get(queue);
      if (!entry?.worker) {
        throw new Error(`No worker registered for queue "${queue}"`);
      }
      return entry.worker;
    },

    workers(): WorkmaticWorker[] {
      return [...registry.values()]
        .map((e) => e.worker)
        .filter((w): w is WorkmaticWorker => w !== undefined);
    },

    async queues(): Promise<string[]> {
      const rows = await db
        .selectFrom('workmatic_jobs')
        .select('queue')
        .distinct()
        .execute();
      const names = new Set<string>(rows.map((r) => r.queue));
      for (const name of registry.keys()) {
        names.add(name);
      }
      return [...names].sort();
    },

    process<TPayload = unknown>(queue: string, fn: JobProcessor<TPayload>): void {
      this.worker(queue).process(fn);
    },

    startAll(): void {
      for (const entry of registry.values()) {
        entry.worker?.start();
      }
    },

    async stopAll(): Promise<void> {
      const stops = [...registry.values()]
        .map((e) => e.worker?.stop())
        .filter((p): p is Promise<void> => p !== undefined);
      await Promise.all(stops);
    },

    async pause(queue: string): Promise<void> {
      const entry = registry.get(queue);
      entry?.worker?.pause();
      await setQueuePaused(queue, true);
    },

    async resume(queue: string): Promise<void> {
      const entry = registry.get(queue);
      entry?.worker?.resume();
      await setQueuePaused(queue, false);
    },

    async isPaused(queue: string): Promise<boolean> {
      const setting = await db
        .selectFrom('workmatic_settings')
        .select('paused')
        .where('queue', '=', queue)
        .executeTakeFirst();
      return setting?.paused === 1;
    },

    async stats(queueName?: string): Promise<Record<string, JobStats>> {
      const names = queueName ? [queueName] : await this.queues();
      const result: Record<string, JobStats> = {};
      for (const name of names) {
        result[name] = await ensureEntry(name).client.stats();
      }
      return result;
    },

    async transfer(opts: TransferOptions): Promise<TransferResult> {
      const { from, to, resetForRetry = false } = opts;
      if (from === to) {
        return { moved: 0 };
      }

      const statuses = normalizeStatuses(opts.status);
      let remaining = opts.limit ?? DEFAULT_TRANSFER_LIMIT;
      let moved = 0;

      if (statuses.includes('ready') && remaining > 0) {
        const n = await transferReady(from, to, remaining);
        moved += n;
        remaining -= n;
      }
      if (statuses.includes('dead') && remaining > 0) {
        const n = await transferDead(from, to, remaining, resetForRetry);
        moved += n;
        remaining -= n;
      }
      for (const status of statuses) {
        if (status === 'ready' || status === 'dead' || remaining <= 0) continue;
        const n = await transferOtherStatus(from, to, status, remaining);
        moved += n;
        remaining -= n;
      }

      return { moved };
    },

    async moveJob(
      publicId: string,
      toQueue: string,
      opts: MoveJobOptions = {}
    ): Promise<void> {
      const allowed = normalizeStatuses(opts.status);
      const row = await db
        .selectFrom('workmatic_jobs')
        .select(['id', 'queue', 'status'])
        .where('public_id', '=', publicId)
        .executeTakeFirst();

      if (!row) {
        throw new Error(`Job not found: ${publicId}`);
      }
      if (row.queue === toQueue) {
        return;
      }
      if (!allowed.includes(row.status)) {
        throw new Error(
          `Job ${publicId} has status "${row.status}" and cannot be moved (allowed: ${allowed.join(', ')})`
        );
      }

      const timestamp = now();
      const resetForRetry = opts.resetForRetry ?? false;

      if (row.status === 'dead' && resetForRetry) {
        await db
          .updateTable('workmatic_jobs')
          .set({
            queue: toQueue,
            status: 'ready',
            attempts: 0,
            lease_until: 0,
            last_error: null,
            updated_at: timestamp,
            run_at: timestamp,
          })
          .where('public_id', '=', publicId)
          .execute();
        return;
      }

      await db
        .updateTable('workmatic_jobs')
        .set({ queue: toQueue, updated_at: timestamp })
        .where('public_id', '=', publicId)
        .execute();
    },
  };

  return orchestrator;
}
