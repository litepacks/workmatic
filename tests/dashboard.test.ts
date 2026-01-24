import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createClient, createWorker, createDashboard } from '../src/index.js';
import type { WorkmaticDb, WorkmaticDashboard } from '../src/types.js';

describe('createDashboard', () => {
  let db: WorkmaticDb;
  let dashboard: WorkmaticDashboard | null = null;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    if (dashboard) {
      await dashboard.close();
      dashboard = null;
    }
    await db.destroy();
  });

  it('should throw if db is not provided', () => {
    expect(() => createDashboard({ db: undefined as any })).toThrow('Database instance is required');
  });

  it('should create dashboard with default port', () => {
    dashboard = createDashboard({ db, port: 3003 });
    expect(dashboard.port).toBe(3003);
  });

  it('should create dashboard with custom port', () => {
    dashboard = createDashboard({ db, port: 4000 });
    expect(dashboard.port).toBe(4000);
  });

  describe('API endpoints', () => {
    const port = 3456;
    const baseUrl = `http://localhost:${port}`;

    beforeEach(() => {
      dashboard = createDashboard({ db, port });
    });

    it('GET /api/stats should return stats', async () => {
      const client = createClient({ db });
      await client.add({ n: 1 });
      await client.add({ n: 2 });
      
      const response = await fetch(`${baseUrl}/api/stats`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.stats).toBeDefined();
      expect(data.stats.ready).toBe(2);
      expect(data.stats.total).toBe(2);
      expect(data.queues).toContain('default');
    });

    it('GET /api/jobs should return jobs list', async () => {
      const client = createClient({ db });
      const result = await client.add({ message: 'hello' });
      
      const response = await fetch(`${baseUrl}/api/jobs`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.jobs).toHaveLength(1);
      expect(data.jobs[0].id).toBe(result.id);
      expect(data.jobs[0].payload).toEqual({ message: 'hello' });
      expect(data.jobs[0].status).toBe('ready');
    });

    it('GET /api/jobs should support pagination', async () => {
      const client = createClient({ db });
      
      // Add 10 jobs
      for (let i = 0; i < 10; i++) {
        await client.add({ n: i });
      }
      
      const response = await fetch(`${baseUrl}/api/jobs?limit=3&offset=2`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.jobs).toHaveLength(3);
      expect(data.limit).toBe(3);
      expect(data.offset).toBe(2);
    });

    it('GET /api/jobs should filter by queue', async () => {
      const clientA = createClient({ db, queue: 'queue-a' });
      const clientB = createClient({ db, queue: 'queue-b' });
      
      await clientA.add({ n: 1 });
      await clientB.add({ n: 2 });
      
      const response = await fetch(`${baseUrl}/api/jobs?queue=queue-a`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.jobs).toHaveLength(1);
      expect(data.jobs[0].queue).toBe('queue-a');
    });

    it('GET /api/jobs should filter by status', async () => {
      const client = createClient({ db });
      await client.add({ n: 1 });
      
      // Manually update one job to done
      await db
        .updateTable('workmatic_jobs')
        .set({ status: 'done' })
        .execute();
      
      await client.add({ n: 2 });
      
      const response = await fetch(`${baseUrl}/api/jobs?status=ready`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.jobs).toHaveLength(1);
      expect(data.jobs[0].status).toBe('ready');
    });

    it('GET /api/jobs/:id should return single job', async () => {
      const client = createClient({ db });
      const result = await client.add({ message: 'test' });
      
      const response = await fetch(`${baseUrl}/api/jobs/${result.id}`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.id).toBe(result.id);
      expect(data.payload).toEqual({ message: 'test' });
    });

    it('GET /api/jobs/:id should return 404 for unknown job', async () => {
      const response = await fetch(`${baseUrl}/api/jobs/unknown-id`);
      const data = await response.json();
      
      expect(response.status).toBe(404);
      expect(data.error).toBe('Job not found');
    });
  });

  describe('worker control', () => {
    it('should pause and resume workers', async () => {
      const port = 3457;
      const baseUrl = `http://localhost:${port}`;
      
      const worker = createWorker({ db, queue: 'test-queue' });
      worker.process(async () => {});
      worker.start();
      
      dashboard = createDashboard({ db, port, workers: [worker] });
      
      // Pause
      const pauseResponse = await fetch(`${baseUrl}/api/workers/test-queue/pause`, { method: 'POST' });
      const pauseData = await pauseResponse.json();
      
      expect(pauseResponse.status).toBe(200);
      expect(pauseData.ok).toBe(true);
      expect(pauseData.paused).toBe(true);
      expect(worker.isPaused).toBe(true);
      
      // Resume
      const resumeResponse = await fetch(`${baseUrl}/api/workers/test-queue/resume`, { method: 'POST' });
      const resumeData = await resumeResponse.json();
      
      expect(resumeResponse.status).toBe(200);
      expect(resumeData.ok).toBe(true);
      expect(resumeData.paused).toBe(false);
      expect(worker.isPaused).toBe(false);
      
      await worker.stop();
    });

    it('should return 404 for unknown worker queue', async () => {
      const port = 3458;
      const baseUrl = `http://localhost:${port}`;
      
      dashboard = createDashboard({ db, port });
      
      const response = await fetch(`${baseUrl}/api/workers/unknown/pause`, { method: 'POST' });
      const data = await response.json();
      
      expect(response.status).toBe(404);
      expect(data.error).toContain('not found');
    });
  });
});
