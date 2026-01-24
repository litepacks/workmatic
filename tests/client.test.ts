import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createClient } from '../src/index.js';
import type { WorkmaticDb } from '../src/types.js';

describe('createClient', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('should throw if db is not provided', () => {
    expect(() => createClient({ db: undefined as any })).toThrow('Database instance is required');
  });

  describe('add', () => {
    it('should add a job and return ok with id', async () => {
      const client = createClient({ db });
      
      const result = await client.add({ email: 'test@example.com' });
      
      expect(result.ok).toBe(true);
      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);
    });

    it('should store job with correct default values', async () => {
      const client = createClient({ db, queue: 'emails' });
      
      const result = await client.add({ email: 'test@example.com' });
      
      // Verify job in database
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', result.id)
        .executeTakeFirst();
      
      expect(job).toBeDefined();
      expect(job!.queue).toBe('emails');
      expect(job!.status).toBe('ready');
      expect(job!.priority).toBe(0);
      expect(job!.attempts).toBe(0);
      expect(job!.max_attempts).toBe(3);
      expect(JSON.parse(job!.payload)).toEqual({ email: 'test@example.com' });
    });

    it('should respect priority option', async () => {
      const client = createClient({ db });
      
      const result = await client.add({ data: 'test' }, { priority: 5 });
      
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', result.id)
        .executeTakeFirst();
      
      expect(job!.priority).toBe(5);
    });

    it('should respect maxAttempts option', async () => {
      const client = createClient({ db });
      
      const result = await client.add({ data: 'test' }, { maxAttempts: 10 });
      
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', result.id)
        .executeTakeFirst();
      
      expect(job!.max_attempts).toBe(10);
    });

    it('should respect delayMs option', async () => {
      const client = createClient({ db });
      const beforeAdd = Date.now();
      
      const result = await client.add({ data: 'test' }, { delayMs: 5000 });
      
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', result.id)
        .executeTakeFirst();
      
      // run_at should be ~5000ms after created_at
      expect(job!.run_at - job!.created_at).toBeGreaterThanOrEqual(5000);
      expect(job!.run_at - job!.created_at).toBeLessThan(5100);
    });

    it('should throw for non-serializable payloads', async () => {
      const client = createClient({ db });
      const circular: any = { foo: 'bar' };
      circular.self = circular;
      
      await expect(client.add(circular)).rejects.toThrow('Payload is not JSON-serializable');
    });

    it('should use default queue name', async () => {
      const client = createClient({ db });
      
      const result = await client.add({ data: 'test' });
      
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', result.id)
        .executeTakeFirst();
      
      expect(job!.queue).toBe('default');
    });
  });

  describe('stats', () => {
    it('should return zero counts for empty queue', async () => {
      const client = createClient({ db });
      
      const stats = await client.stats();
      
      expect(stats).toEqual({
        ready: 0,
        running: 0,
        done: 0,
        failed: 0,
        dead: 0,
        total: 0,
      });
    });

    it('should count jobs by status', async () => {
      const client = createClient({ db });
      
      // Add some jobs
      await client.add({ n: 1 });
      await client.add({ n: 2 });
      await client.add({ n: 3 });
      
      const stats = await client.stats();
      
      expect(stats.ready).toBe(3);
      expect(stats.total).toBe(3);
    });

    it('should only count jobs in the same queue', async () => {
      const clientA = createClient({ db, queue: 'queue-a' });
      const clientB = createClient({ db, queue: 'queue-b' });
      
      await clientA.add({ n: 1 });
      await clientA.add({ n: 2 });
      await clientB.add({ n: 3 });
      
      const statsA = await clientA.stats();
      const statsB = await clientB.stats();
      
      expect(statsA.ready).toBe(2);
      expect(statsA.total).toBe(2);
      expect(statsB.ready).toBe(1);
      expect(statsB.total).toBe(1);
    });
  });

  describe('clear', () => {
    it('should clear all jobs from the queue', async () => {
      const client = createClient({ db, queue: 'test-queue' });
      
      // Add some jobs
      await client.add({ n: 1 });
      await client.add({ n: 2 });
      await client.add({ n: 3 });
      
      const statsBefore = await client.stats();
      expect(statsBefore.total).toBe(3);
      
      // Clear all jobs
      const deleted = await client.clear();
      
      expect(deleted).toBe(3);
      
      const statsAfter = await client.stats();
      expect(statsAfter.total).toBe(0);
    });

    it('should clear only jobs with specific status', async () => {
      const client = createClient({ db, queue: 'test-queue' });
      
      // Add jobs
      await client.add({ n: 1 });
      await client.add({ n: 2 });
      
      // Manually set one to done
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'done' })
        .where('queue', '=', 'test-queue')
        .where('public_id', '=', (await db
          .selectFrom('workmatic_jobs')
          .select('public_id')
          .where('queue', '=', 'test-queue')
          .limit(1)
          .executeTakeFirst())!.public_id)
        .execute();
      
      const statsBefore = await client.stats();
      expect(statsBefore.ready).toBe(1);
      expect(statsBefore.done).toBe(1);
      
      // Clear only done jobs
      const deleted = await client.clear({ status: 'done' });
      
      expect(deleted).toBe(1);
      
      const statsAfter = await client.stats();
      expect(statsAfter.ready).toBe(1);
      expect(statsAfter.done).toBe(0);
      expect(statsAfter.total).toBe(1);
    });

    it('should only clear jobs from the same queue', async () => {
      const clientA = createClient({ db, queue: 'queue-a' });
      const clientB = createClient({ db, queue: 'queue-b' });
      
      await clientA.add({ n: 1 });
      await clientA.add({ n: 2 });
      await clientB.add({ n: 3 });
      
      // Clear queue-a
      const deleted = await clientA.clear();
      
      expect(deleted).toBe(2);
      
      const statsA = await clientA.stats();
      const statsB = await clientB.stats();
      
      expect(statsA.total).toBe(0);
      expect(statsB.total).toBe(1);
    });

    it('should return 0 when clearing empty queue', async () => {
      const client = createClient({ db });
      
      const deleted = await client.clear();
      
      expect(deleted).toBe(0);
    });
  });
});
