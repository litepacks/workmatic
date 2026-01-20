import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, createClient, createWorker } from '../src/index.js';
import type { WorkmaticDb, Job } from '../src/types.js';

describe('createWorker', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('should throw if db is not provided', () => {
    expect(() => createWorker({ db: undefined as any })).toThrow('Database instance is required');
  });

  it('should throw if started without a processor', () => {
    const worker = createWorker({ db });
    expect(() => worker.start()).toThrow('No processor set');
  });

  describe('process and start', () => {
    it('should process a job to completion', async () => {
      const client = createClient({ db });
      const worker = createWorker({ db, pollMs: 50 });
      
      const processed: Job[] = [];
      
      worker.process(async (job) => {
        processed.push(job);
      });
      
      // Add a job
      const result = await client.add({ message: 'hello' });
      
      // Start worker
      worker.start();
      
      // Wait for job to be processed
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Stop worker
      await worker.stop();
      
      // Verify job was processed
      expect(processed.length).toBe(1);
      expect(processed[0].id).toBe(result.id);
      expect(processed[0].payload).toEqual({ message: 'hello' });
      
      // Verify job status is done
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', result.id)
        .executeTakeFirst();
      
      expect(job!.status).toBe('done');
    });

    it('should process multiple jobs with concurrency', async () => {
      const client = createClient({ db });
      const worker = createWorker({ db, concurrency: 3, pollMs: 50 });
      
      const processed: number[] = [];
      
      worker.process(async (job: Job<{ n: number }>) => {
        processed.push(job.payload.n);
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      
      // Add jobs
      await client.add({ n: 1 });
      await client.add({ n: 2 });
      await client.add({ n: 3 });
      
      worker.start();
      
      // Wait for all jobs
      await new Promise(resolve => setTimeout(resolve, 500));
      
      await worker.stop();
      
      expect(processed.sort()).toEqual([1, 2, 3]);
    });
  });

  describe('retry logic', () => {
    it('should retry failed jobs', async () => {
      const client = createClient({ db });
      const worker = createWorker({ 
        db, 
        pollMs: 50,
        backoff: () => 50, // Short backoff for testing
      });
      
      let attempts = 0;
      
      worker.process(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Attempt ${attempts} failed`);
        }
      });
      
      await client.add({ data: 'test' }, { maxAttempts: 5 });
      
      worker.start();
      
      // Wait for retries
      await new Promise(resolve => setTimeout(resolve, 500));
      
      await worker.stop();
      
      // Should have tried 3 times (2 failures + 1 success)
      expect(attempts).toBe(3);
      
      // Job should be done
      const stats = await client.stats();
      expect(stats.done).toBe(1);
    });

    it('should mark job as dead after max attempts', async () => {
      const client = createClient({ db });
      const worker = createWorker({ 
        db, 
        pollMs: 50,
        backoff: () => 50,
      });
      
      let attempts = 0;
      
      worker.process(async () => {
        attempts++;
        throw new Error('Always fails');
      });
      
      await client.add({ data: 'test' }, { maxAttempts: 3 });
      
      worker.start();
      
      // Wait for all attempts
      await new Promise(resolve => setTimeout(resolve, 800));
      
      await worker.stop();
      
      expect(attempts).toBe(3);
      
      // Job should be dead
      const stats = await client.stats();
      expect(stats.dead).toBe(1);
      
      // Verify last_error is stored
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('status', '=', 'dead')
        .executeTakeFirst();
      
      expect(job!.last_error).toBe('Always fails');
    });
  });

  describe('lease requeue', () => {
    it('should requeue jobs with expired leases', async () => {
      const client = createClient({ db });
      
      // Add a job
      const result = await client.add({ data: 'test' });
      
      // Manually set it to running with an expired lease
      const pastTime = Date.now() - 60000; // 1 minute ago
      await db
        .updateTable('workmatic_jobs')
        .set({
          status: 'running',
          lease_until: pastTime,
        })
        .where('public_id', '=', result.id)
        .execute();
      
      // Create worker and start
      const worker = createWorker({ db, pollMs: 50 });
      
      const processed: string[] = [];
      worker.process(async (job) => {
        processed.push(job.id);
      });
      
      worker.start();
      
      // Wait for lease requeue and processing
      await new Promise(resolve => setTimeout(resolve, 300));
      
      await worker.stop();
      
      // Job should have been requeued and processed
      expect(processed).toContain(result.id);
      
      // Job should be done
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('public_id', '=', result.id)
        .executeTakeFirst();
      
      expect(job!.status).toBe('done');
    });
  });

  describe('pause and resume', () => {
    it('should pause and resume processing', async () => {
      const client = createClient({ db });
      const worker = createWorker({ db, pollMs: 50 });
      
      const processed: number[] = [];
      
      worker.process(async (job: Job<{ n: number }>) => {
        processed.push(job.payload.n);
      });
      
      await client.add({ n: 1 });
      
      worker.start();
      
      // Wait for first job
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Pause
      worker.pause();
      expect(worker.isPaused).toBe(true);
      
      // Add more jobs while paused
      await client.add({ n: 2 });
      await client.add({ n: 3 });
      
      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Only first job should be processed
      expect(processed).toEqual([1]);
      
      // Resume
      worker.resume();
      expect(worker.isPaused).toBe(false);
      
      // Wait for remaining jobs
      await new Promise(resolve => setTimeout(resolve, 300));
      
      await worker.stop();
      
      // All jobs should be processed
      expect(processed.sort()).toEqual([1, 2, 3]);
    });
  });

  describe('stats', () => {
    it('should return correct stats', async () => {
      const client = createClient({ db });
      const worker = createWorker({ db, pollMs: 50 });
      
      await client.add({ n: 1 });
      await client.add({ n: 2 });
      
      const statsBeforeStart = await worker.stats();
      expect(statsBeforeStart.ready).toBe(2);
      
      let processCount = 0;
      worker.process(async () => {
        processCount++;
        if (processCount === 1) {
          throw new Error('fail first');
        }
      });
      
      worker.start();
      await new Promise(resolve => setTimeout(resolve, 300));
      await worker.stop();
      
      const statsAfter = await worker.stats();
      expect(statsAfter.done).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isRunning', () => {
    it('should reflect running state', async () => {
      const worker = createWorker({ db });
      worker.process(async () => {});
      
      expect(worker.isRunning).toBe(false);
      
      worker.start();
      expect(worker.isRunning).toBe(true);
      
      await worker.stop();
      expect(worker.isRunning).toBe(false);
    });
  });

  describe('timeout', () => {
    it('should timeout slow jobs and retry', async () => {
      const client = createClient({ db });
      const worker = createWorker({
        db,
        pollMs: 50,
        timeoutMs: 100, // 100ms timeout
        backoff: () => 50,
      });
      
      let attempts = 0;
      
      worker.process(async () => {
        attempts++;
        if (attempts === 1) {
          // First attempt: take too long (will timeout)
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        // Second attempt: complete quickly
      });
      
      await client.add({ data: 'test' }, { maxAttempts: 3 });
      
      worker.start();
      
      // Wait for timeout and retry
      await new Promise(resolve => setTimeout(resolve, 800));
      
      await worker.stop();
      
      // Should have attempted twice (first timed out, second succeeded)
      expect(attempts).toBe(2);
      
      // Job should be done
      const stats = await client.stats();
      expect(stats.done).toBe(1);
    });

    it('should mark job as dead after max timeout failures', async () => {
      const client = createClient({ db });
      const worker = createWorker({
        db,
        pollMs: 50,
        timeoutMs: 50, // Very short timeout
        backoff: () => 50,
      });
      
      worker.process(async () => {
        // Always timeout
        await new Promise(resolve => setTimeout(resolve, 200));
      });
      
      await client.add({ data: 'test' }, { maxAttempts: 2 });
      
      worker.start();
      
      await new Promise(resolve => setTimeout(resolve, 800));
      
      await worker.stop();
      
      // Job should be dead after 2 timeout failures
      const stats = await client.stats();
      expect(stats.dead).toBe(1);
      
      // Verify error message mentions timeout
      const job = await db
        .selectFrom('workmatic_jobs')
        .selectAll()
        .where('status', '=', 'dead')
        .executeTakeFirst();
      
      expect(job!.last_error).toContain('timed out');
    });
  });
});
