import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDatabase,
  createClient,
  createWorker,
  createOrchestrator,
  createDashboard,
  createDashboardMiddleware,
} from '../src/index.js';
import { createRequestHandler } from '../src/dashboard.js';
import { printUsage, runCommand } from '../src/cli/handlers.js';
import { parsePayload } from '../src/utils.js';
import type { WorkmaticDb } from '../src/types.js';

describe('100% coverage gaps', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('dashboard', () => {
    it('POST resume returns 404 when worker not registered', async () => {
      const handler = createRequestHandler(db, new Map(), '');
      const port = 3469;
      const server = createServer((req, res) => void handler(req, res));
      await new Promise<void>((resolve) => server.listen(port, resolve));
      const res = await fetch(`http://127.0.0.1:${port}/api/workers/missing/resume`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    });

    it('createRequestHandler serves static assets', async () => {
      const handler = createRequestHandler(db, new Map(), '');
      const port = 3470;
      const server = createServer((req, res) => {
        void handler(req, res);
      });
      await new Promise<void>((resolve) => server.listen(port, resolve));

      for (const path of ['/', '/index.html', '/style.css', '/app.js']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(res.status).toBe(200);
      }

      const missing = await fetch(`http://127.0.0.1:${port}/missing.xyz`);
      expect(missing.status).toBe(404);

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    });

    it('createRequestHandler lists registered workers in stats', async () => {
      const worker = createWorker({ db, queue: 'wq' });
      worker.process(async () => {});
      const handler = createRequestHandler(db, new Map([['wq', worker]]), '');
      const port = 3471;
      const server = createServer((req, res) => void handler(req, res));
      await new Promise<void>((resolve) => server.listen(port, resolve));

      const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
      const data = await res.json();
      expect(data.workers).toEqual([{ queue: 'wq', running: false, paused: false }]);

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    });

    it('createDashboardMiddleware requires db and delegates with next', async () => {
      expect(() => createDashboardMiddleware({ db: undefined as never })).toThrow(
        'Database instance is required'
      );

      let nextCalled = false;
      const middleware = createDashboardMiddleware({ db, basePath: '/wm' });
      const server = createServer((req, res) =>
        middleware(req, res, () => {
          nextCalled = true;
          res.writeHead(404);
          res.end('nope');
        })
      );
      await new Promise<void>((resolve) => server.listen(3472, resolve));

      await fetch('http://127.0.0.1:3472/other');
      expect(nextCalled).toBe(true);

      const worker = createWorker({ db, queue: 'mw-q' });
      worker.process(async () => {});
      const mw2 = createDashboardMiddleware({ db, basePath: '/wm', workers: [worker] });
      const server2 = createServer((req, res) => void mw2(req, res));
      await new Promise<void>((resolve) => server2.listen(3473, resolve));
      const stats = await fetch('http://127.0.0.1:3473/wm/api/stats');
      expect(stats.status).toBe(200);

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        server2.close((err) => (err ? reject(err) : resolve()))
      );
    });

    it('createDashboard close rejects when server already closed', async () => {
      const dashboard = createDashboard({ db, port: 3474 });
      await dashboard.close();
      await expect(dashboard.close()).rejects.toThrow();
    });

    it('handleGetStats ignores unknown status keys', async () => {
      await db
        .insertInto('workmatic_jobs')
        .values({
          public_id: 'x1',
          queue: 'q',
          payload: '{}',
          status: 'unknown' as 'ready',
          priority: 0,
          run_at: Date.now(),
          attempts: 0,
          max_attempts: 3,
          lease_until: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
          last_error: null,
        })
        .execute();

      const handler = createRequestHandler(db, new Map(), '');
      const port = 3476;
      const server = createServer((req, res) => void handler(req, res));
      await new Promise<void>((resolve) => server.listen(port, resolve));
      const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
      const data = await res.json();
      expect(data.stats.total).toBe(1);
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    });
  });

  describe('worker', () => {
    it('restoreState returns null when persistState is false', async () => {
      const worker = createWorker({ db, persistState: false });
      expect(await worker.restoreState()).toBeNull();
    });

    it('loadState returns null when no settings row exists', async () => {
      const worker = createWorker({
        db,
        queue: 'no-state',
        persistState: true,
        autoRestore: false,
      });
      worker.process(async () => {});
      expect(await worker.restoreState()).toBeNull();
    });

    it('loadState returns stopped when persisted value is 0', async () => {
      await db
        .insertInto('workmatic_settings')
        .values({ queue: 'worker_state_stopped-q', paused: 0, updated_at: Date.now() })
        .execute();
      const worker = createWorker({
        db,
        queue: 'stopped-q',
        persistState: true,
        autoRestore: false,
      });
      worker.process(async () => {});
      expect(await worker.restoreState()).toBe('stopped');
    });

  });

  describe('client', () => {
    it('clear handles missing numDeletedRows', async () => {
      const client = createClient({ db });
      await client.add({ n: 1 });
      const spy = vi.spyOn(db, 'deleteFrom').mockReturnValue({
        where: () => ({
          where: () => ({
            execute: async () => [{}],
          }),
          execute: async () => [{}],
        }),
      } as never);
      const n = await client.clear();
      expect(n).toBe(0);
      spy.mockRestore();
    });
  });

  describe('orchestrator', () => {
    it('moveJob no-op when target is current queue', async () => {
      const orch = createOrchestrator({ db });
      const { id } = await orch.client('same').add({ n: 1 });
      await orch.moveJob(id, 'same');
    });

    it('transferDead without reset and empty transferOtherStatus', async () => {
      const orch = createOrchestrator({ db });
      const { id } = await orch.client('a').add({ n: 1 });
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

      const none = await orch.transfer({ from: 'empty', to: 'b', status: 'done' });
      expect(none.moved).toBe(0);
    });
  });

  describe('utils', () => {
    it('parsePayload unknown error message', () => {
      const orig = JSON.parse;
      JSON.parse = () => {
        throw 'bad';
      };
      try {
        expect(() => parsePayload('{}')).toThrow('Unknown error');
      } finally {
        JSON.parse = orig;
      }
    });
  });

  describe('database', () => {
    it('createDatabase defaults to in-memory file', () => {
      const mem = createDatabase();
      expect(mem).toBeDefined();
      void mem.destroy();
    });
  });

  describe('cli handlers', () => {
    it('printUsage runs', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      printUsage();
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });

    it('cmdStats skips queue table when empty', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wm-empty-stats-'));
      const dbPath = join(dir, 'empty.db');
      createDatabase({ filename: dbPath });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { cmdStats } = await import('../src/cli/handlers.js');
      await cmdStats(dbPath);
      const out = log.mock.calls.flat().join(' ');
      expect(out).not.toContain('By Queue');
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    });

    it('cmdImport uses defaults for bad numeric fields and short rows', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wm-bad-csv-'));
      const csvPath = join(dir, 'bad.csv');
      const dbPath = join(dir, 'bad.db');
      await writeFile(
        csvPath,
        [
          'public_id,queue,payload,status,priority,run_at,attempts,max_attempts,lease_until,created_at,updated_at,last_error',
          'id1,q,{},ready',
        ].join('\n')
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runCommand('import', dbPath, [dbPath, csvPath]);
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    });

    it('cmdImport batches more than 1000 rows', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wm-1k-'));
      const csvPath = join(dir, 'big.csv');
      const header =
        'public_id,queue,payload,status,priority,run_at,attempts,max_attempts,lease_until,created_at,updated_at,last_error';
      const rows = [header];
      for (let i = 0; i < 1001; i++) {
        rows.push(`id${i},q,{},ready,0,1,0,3,0,1,1,`);
      }
      await writeFile(csvPath, rows.join('\n'));
      const dbPath = join(dir, 'jobs.db');
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runCommand('import', dbPath, [dbPath, csvPath]);
      err.mockRestore();
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    });
  });
});
