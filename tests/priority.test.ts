import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createClient, createWorker } from '../src/index.js';
import type { WorkmaticDb, Job } from '../src/types.js';

describe('Priority ordering', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('should process jobs in priority order (lower priority first)', async () => {
    const client = createClient({ db });
    const worker = createWorker({ db, concurrency: 1, pollMs: 50 });
    
    const processed: number[] = [];
    
    worker.process(async (job: Job<{ n: number }>) => {
      processed.push(job.payload.n);
      // Small delay to ensure sequential processing
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    
    // Add jobs with different priorities (lower number = higher priority)
    await client.add({ n: 3 }, { priority: 10 });  // Low priority
    await client.add({ n: 1 }, { priority: 1 });   // High priority
    await client.add({ n: 2 }, { priority: 5 });   // Medium priority
    await client.add({ n: 4 }, { priority: 20 });  // Very low priority
    
    worker.start();
    
    // Wait for all jobs
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await worker.stop();
    
    // Should be processed in priority order: 1, 5, 10, 20 -> [1, 2, 3, 4]
    expect(processed).toEqual([1, 2, 3, 4]);
  });

  it('should process jobs with same priority in FIFO order', async () => {
    const client = createClient({ db });
    const worker = createWorker({ db, concurrency: 1, pollMs: 50 });
    
    const processed: number[] = [];
    
    worker.process(async (job: Job<{ n: number }>) => {
      processed.push(job.payload.n);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    
    // Add jobs with same priority
    await client.add({ n: 1 }, { priority: 0 });
    await client.add({ n: 2 }, { priority: 0 });
    await client.add({ n: 3 }, { priority: 0 });
    
    worker.start();
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await worker.stop();
    
    // Should be processed in insertion order
    expect(processed).toEqual([1, 2, 3]);
  });

  it('should mix priority and FIFO ordering', async () => {
    const client = createClient({ db });
    const worker = createWorker({ db, concurrency: 1, pollMs: 50 });
    
    const processed: string[] = [];
    
    worker.process(async (job: Job<{ name: string }>) => {
      processed.push(job.payload.name);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    
    // Add jobs
    await client.add({ name: 'low-1' }, { priority: 10 });
    await client.add({ name: 'high-1' }, { priority: 1 });
    await client.add({ name: 'low-2' }, { priority: 10 });
    await client.add({ name: 'high-2' }, { priority: 1 });
    
    worker.start();
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await worker.stop();
    
    // High priority first (FIFO within same priority), then low priority
    expect(processed).toEqual(['high-1', 'high-2', 'low-1', 'low-2']);
  });
});
