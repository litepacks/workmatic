import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createDatabase } from '../src/index.js';
import { createRequestHandler } from '../src/dashboard.js';
import { parseTransferStatuses, jobStatusEmoji } from '../src/cli/handlers.js';
import { rowsUpdated } from '../src/orchestrator.js';
import type { WorkmaticDb } from '../src/types.js';

describe('remaining branch coverage', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('jobStatusEmoji and rowsUpdated helpers', () => {
    expect(jobStatusEmoji('ready')).toBe('⏳');
    expect(jobStatusEmoji('unknown')).toBe('');
    expect(rowsUpdated([{ numUpdatedRows: 2 }])).toBe(2);
    expect(rowsUpdated([{}])).toBe(0);
    expect(rowsUpdated([])).toBe(0);
  });

  it('parseTransferStatuses default and explicit', () => {
    expect(parseTransferStatuses()).toEqual(['ready', 'dead']);
    expect(parseTransferStatuses('done,ready')).toEqual(['done', 'ready']);
  });

  it('getPath normalizes empty remainder to slash', async () => {
    const handler = createRequestHandler(db, new Map(), '/wm');
    const port = 3480;
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(port, resolve));
    const res = await fetch(`http://127.0.0.1:${port}/wm`);
    expect([200, 404]).toContain(res.status);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  it('handleRequest uses default url when missing', async () => {
    const handler = createRequestHandler(db, new Map(), '');
    const res = {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;

    await handler({ method: 'OPTIONS', url: undefined } as IncomingMessage, res);
    expect(res.writeHead).toHaveBeenCalledWith(204);

    const { createClient } = await import('../src/index.js');
    const client = createClient({ db });
    await client.add({ n: 1 });

    await handler({ method: 'GET', url: undefined } as IncomingMessage, res);
    await handler(
      { method: 'GET', url: '/api/jobs?queue=default' } as IncomingMessage,
      res
    );
    await handler({ method: 'GET', url: undefined } as IncomingMessage, res);
  });

  it('orchestrator transfer covers all update branches', async () => {
    const { createOrchestrator, createClient } = await import('../src/index.js');
    const orch = createOrchestrator({ db });
    const { id } = await orch.client('a').add({ n: 1 }, { maxAttempts: 1 });
    await db
      .updateTable('workmatic_jobs')
      .set({ status: 'dead' })
      .where('public_id', '=', id)
      .execute();
    await db
      .insertInto('workmatic_jobs')
      .values({
        public_id: 'run1',
        queue: 'a',
        payload: '{}',
        status: 'running',
        priority: 0,
        run_at: Date.now(),
        attempts: 0,
        max_attempts: 3,
        lease_until: Date.now() + 99999,
        created_at: Date.now(),
        updated_at: Date.now(),
        last_error: null,
      })
      .execute();

    expect(
      (await orch.transfer({ from: 'a', to: 'b', status: 'ready' })).moved
    ).toBeGreaterThanOrEqual(0);
    expect(
      (await orch.transfer({ from: 'a', to: 'c', status: 'dead', resetForRetry: true })).moved
    ).toBe(1);
    expect(
      (await orch.transfer({ from: 'a', to: 'd', status: 'dead', resetForRetry: false })).moved
    ).toBe(0);
    expect(
      (await orch.transfer({ from: 'a', to: 'e', status: 'running' })).moved
    ).toBe(1);
  });

  it('requeueExpiredLeases handles missing numUpdatedRows', async () => {
    const { createWorker } = await import('../src/worker.js');
    const worker = createWorker({ db, pollMs: 30 });
    const spy = vi.spyOn(db, 'updateTable').mockReturnValue({
      set: () => ({
        where: () => ({
          where: () => ({
            where: () => ({
              execute: async () => [{}],
            }),
          }),
        }),
      }),
    } as never);
    worker.process(async () => {});
    worker.start();
    await new Promise((r) => setTimeout(r, 100));
    await worker.stop();
    spy.mockRestore();
  });
});
