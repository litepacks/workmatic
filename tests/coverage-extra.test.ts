import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import { createDatabase, createClient, createWorker, createOrchestrator, createDashboardMiddleware } from '../src/index.js';
import { parsePayload, sleep } from '../src/utils.js';
import { runCommand } from '../src/cli/handlers.js';
import type { WorkmaticDb } from '../src/types.js';

describe('coverage gaps', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('utils', () => {
    it('parsePayload throws on invalid JSON', () => {
      expect(() => parsePayload('not-json')).toThrow('Invalid JSON payload');
    });

    it('sleep resolves after delay', async () => {
      const t0 = Date.now();
      await sleep(30);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
    });
  });

  describe('orchestrator', () => {
    it('moveJob no-op when already on target queue', async () => {
      const orch = createOrchestrator({ db });
      const { id } = await orch.client('q').add({ n: 1 });
      await orch.moveJob(id, 'q');
      expect((await orch.client('q').stats()).ready).toBe(1);
    });

    it('moveJob with resetForRetry on dead job', async () => {
      const orch = createOrchestrator({ db });
      const { id } = await orch.client('src').add({ n: 1 }, { maxAttempts: 1 });
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead', last_error: 'err' })
        .where('public_id', '=', id)
        .execute();
      await orch.moveJob(id, 'retry', { resetForRetry: true });
      const stats = await orch.client('retry').stats();
      expect(stats.ready).toBe(1);
    });

    it('transfer dead without reset keeps dead status', async () => {
      const orch = createOrchestrator({ db });
      const { id } = await orch.client('a').add({ n: 1 }, { maxAttempts: 1 });
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'dead' })
        .where('public_id', '=', id)
        .execute();
      const { moved } = await orch.transfer({
        from: 'a',
        to: 'b',
        status: 'dead',
        resetForRetry: false,
      });
      expect(moved).toBe(1);
      expect((await orch.client('b').stats()).dead).toBe(1);
    });

    it('transfer done jobs', async () => {
      const orch = createOrchestrator({ db });
      const { id } = await orch.client('src').add({ n: 1 });
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'done' })
        .where('public_id', '=', id)
        .execute();
      const { moved } = await orch.transfer({ from: 'src', to: 'archive', status: 'done' });
      expect(moved).toBe(1);
    });
  });

  describe('worker', () => {
    it('loadState returns null when settings query fails', async () => {
      const worker = createWorker({
        db,
        queue: 'load-fail',
        persistState: true,
        autoRestore: false,
      });
      worker.process(async () => {});
      vi.spyOn(db, 'selectFrom').mockImplementation(() => {
        throw new Error('db fail');
      });
      const state = await worker.restoreState();
      expect(state).toBeNull();
    });

    it('persistState and restoreState', async () => {
      const ts = Date.now();
      await db
        .insertInto('workmatic_settings')
        .values({ queue: 'worker_state_persist-q', paused: 1, updated_at: ts })
        .execute();

      const worker = createWorker({
        db,
        queue: 'persist-q',
        pollMs: 50,
        persistState: true,
        autoRestore: false,
      });
      worker.process(async () => {});
      const restored = await worker.restoreState();
      expect(restored).toBe('paused');
      expect(worker.isPaused).toBe(true);
      await worker.stop();
    });

    it('requeueExpiredIntervalMs throttles lease scan', async () => {
      const client = createClient({ db });
      const { id } = await client.add({ n: 1 });
      const past = Date.now() - 60_000;
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'running', lease_until: past })
        .where('public_id', '=', id)
        .execute();

      const worker = createWorker({
        db,
        pollMs: 30,
        requeueExpiredIntervalMs: 500,
        timeoutMs: 0,
      });
      const processed: string[] = [];
      worker.process(async (job) => {
        processed.push(job.id);
      });
      worker.start();
      await new Promise((r) => setTimeout(r, 400));
      await worker.stop();
      expect(processed).toContain(id);
    });

    it('restoreState running starts worker', async () => {
      await db
        .insertInto('workmatic_settings')
        .values({ queue: 'worker_state_run-q', paused: 2, updated_at: Date.now() })
        .execute();
      const worker = createWorker({
        db,
        queue: 'run-q',
        pollMs: 50,
        persistState: true,
        autoRestore: false,
      });
      worker.process(async () => {});
      const state = await worker.restoreState();
      expect(state).toBe('running');
      expect(worker.isRunning).toBe(true);
      await worker.stop();
    });

    it('autoRestore on create when processor is set', async () => {
      await db
        .insertInto('workmatic_settings')
        .values({ queue: 'worker_state_auto-q', paused: 2, updated_at: Date.now() })
        .execute();
      const worker = createWorker({
        db,
        queue: 'auto-q',
        pollMs: 50,
        persistState: true,
        autoRestore: true,
      });
      worker.process(async () => {});
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 50));
      expect(worker.isRunning).toBe(true);
      await worker.stop();
    });

    it('stop is no-op when not running', async () => {
      const worker = createWorker({ db });
      worker.process(async () => {});
      await worker.stop();
    });

    it('start is no-op when already running', async () => {
      const worker = createWorker({ db, pollMs: 50 });
      worker.process(async () => {});
      worker.start();
      worker.start();
      await worker.stop();
    });

    it('respects database pause flag', async () => {
      const client = createClient({ db, queue: 'db-pause' });
      await client.add({ n: 1 });
      const ts = Date.now();
      await db
        .insertInto('workmatic_settings')
        .values({ queue: 'db-pause', paused: 1, updated_at: ts })
        .execute();

      const worker = createWorker({ db, queue: 'db-pause', pollMs: 50 });
      const processed: number[] = [];
      worker.process(async (job) => {
        processed.push((job.payload as { n: number }).n);
      });
      worker.start();
      await new Promise((r) => setTimeout(r, 250));
      await worker.stop();
      expect(processed.length).toBe(0);
    });
  });

  describe('dashboard middleware', () => {
    it('returns 500 when handler throws and next is omitted', async () => {
      const broken = {
        selectFrom: () => {
          throw new Error('db down');
        },
      } as unknown as WorkmaticDb;
      const middleware = createDashboardMiddleware({ db: broken });
      const server = createServer((req, res) => middleware(req, res));
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/stats`);
      expect(response.status).toBe(500);
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    });

    it('handles OPTIONS, unknown routes, and basePath next', async () => {
      const middleware = createDashboardMiddleware({ db, basePath: '/wm' });
      let nextCalled = false;

      const server = createServer((req, res) => {
        middleware(req, res, () => {
          nextCalled = true;
          res.writeHead(404);
          res.end('pass');
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;

      const opt = await fetch(`http://127.0.0.1:${port}/wm/api/stats`, { method: 'OPTIONS' });
      expect(opt.status).toBe(204);

      const miss = await fetch(`http://127.0.0.1:${port}/wm/unknown`);
      expect(miss.status).toBe(404);

      await fetch(`http://127.0.0.1:${port}/other`);
      expect(nextCalled).toBe(true);

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    });

  });

  describe('cli handlers', () => {
    it('runCommand pause requires queue name', async () => {
      const { mkdtemp, rm } = await import('fs/promises');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const dir = await mkdtemp(join(tmpdir(), 'wm-'));
      const dbPath = join(dir, 't.db');
      const d = createDatabase({ filename: dbPath });
      await d.destroy();
      await expect(runCommand('pause', dbPath, [dbPath], {})).rejects.toThrow(
        'Queue name is required'
      );
      await rm(dir, { recursive: true, force: true });
    });
  });
});
