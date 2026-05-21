import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createOrchestrator } from '../src/index.js';
import type { WorkmaticDb } from '../src/types.js';

describe('createOrchestrator', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('should throw without db', () => {
    expect(() => createOrchestrator({ db: undefined as any })).toThrow(
      'Database instance is required'
    );
  });

  it('should register queues and process jobs with startAll', async () => {
    const orch = createOrchestrator({ db });
    const clientA = orch.register('queue-a', { worker: { pollMs: 50 } });
    const clientB = orch.register('queue-b', { worker: { pollMs: 50 } });

    const processedA: number[] = [];
    const processedB: number[] = [];

    orch.process('queue-a', async (job) => {
      processedA.push((job.payload as { n: number }).n);
    });
    orch.process('queue-b', async (job) => {
      processedB.push((job.payload as { n: number }).n);
    });

    await clientA.add({ n: 1 });
    await clientB.add({ n: 2 });

    orch.startAll();
    await new Promise((r) => setTimeout(r, 500));
    await orch.stopAll();

    expect(processedA).toContain(1);
    expect(processedB).toContain(2);
  });

  it('should lazy-create client via client()', async () => {
    const orch = createOrchestrator({ db });
    await orch.client('lazy').add({ x: 1 });
    const stats = await orch.client('lazy').stats();
    expect(stats.ready).toBe(1);
  });

  it('should throw when worker not registered', () => {
    const orch = createOrchestrator({ db });
    orch.register('no-worker');
    expect(() => orch.worker('no-worker')).toThrow('No worker registered');
  });

  it('should list queues from db and registry', async () => {
    const orch = createOrchestrator({ db });
    orch.register('registered-empty');
    await orch.client('with-jobs').add({ n: 1 });

    const names = await orch.queues();
    expect(names).toContain('registered-empty');
    expect(names).toContain('with-jobs');
  });

  it('should return stats for all or one queue', async () => {
    const orch = createOrchestrator({ db });
    await orch.client('q1').add({ n: 1 });
    await orch.client('q2').add({ n: 2 });

    const all = await orch.stats();
    expect(all.q1.ready).toBe(1);
    expect(all.q2.ready).toBe(1);

    const one = await orch.stats('q1');
    expect(Object.keys(one)).toEqual(['q1']);
  });

  it('should transfer ready jobs between queues', async () => {
    const orch = createOrchestrator({ db });
    await orch.client('source').add({ n: 1 });
    await orch.client('source').add({ n: 2 });

    const { moved } = await orch.transfer({
      from: 'source',
      to: 'target',
      status: 'ready',
    });

    expect(moved).toBe(2);
    const sourceStats = await orch.client('source').stats();
    const targetStats = await orch.client('target').stats();
    expect(sourceStats.ready).toBe(0);
    expect(targetStats.ready).toBe(2);
  });

  it('should respect transfer limit', async () => {
    const orch = createOrchestrator({ db });
    for (let i = 0; i < 5; i++) {
      await orch.client('src').add({ n: i });
    }

    const { moved } = await orch.transfer({
      from: 'src',
      to: 'dst',
      status: 'ready',
      limit: 2,
    });

    expect(moved).toBe(2);
    const srcStats = await orch.client('src').stats();
    expect(srcStats.ready).toBe(3);
  });

  it('should reset dead jobs when resetForRetry', async () => {
    const orch = createOrchestrator({ db });
    await orch.client('fail-q').add({ n: 1 }, { maxAttempts: 1 });

    orch.register('fail-q', { worker: { pollMs: 50 } });
    orch.process('fail-q', async () => {
      throw new Error('fail');
    });
    orch.startAll();
    await new Promise((r) => setTimeout(r, 400));
    await orch.stopAll();

    const before = await orch.client('fail-q').stats();
    expect(before.dead).toBe(1);

    const { moved } = await orch.transfer({
      from: 'fail-q',
      to: 'retry-q',
      status: 'dead',
      resetForRetry: true,
    });

    expect(moved).toBe(1);
    const retryStats = await orch.client('retry-q').stats();
    expect(retryStats.ready).toBe(1);
  });

  it('should not transfer running jobs by default', async () => {
    const orch = createOrchestrator({ db });
    await orch.client('run-src').add({ n: 1 });

    orch.register('run-src', { worker: { pollMs: 50, concurrency: 1 } });
    let claimed = false;
    orch.process('run-src', async () => {
      claimed = true;
      await new Promise((r) => setTimeout(r, 300));
    });
    orch.startAll();
    await new Promise((r) => setTimeout(r, 150));

    const { moved } = await orch.transfer({ from: 'run-src', to: 'run-dst' });
    expect(moved).toBe(0);

    await orch.stopAll();
    expect(claimed).toBe(true);
  });

  it('should move a single job by public id', async () => {
    const orch = createOrchestrator({ db });
    const { id } = await orch.client('from').add({ n: 42 });

    await orch.moveJob(id, 'to');
    const toStats = await orch.client('to').stats();
    expect(toStats.ready).toBe(1);
  });

  it('should throw moveJob when job not found', async () => {
    const orch = createOrchestrator({ db });
    await expect(orch.moveJob('missing-id', 'to')).rejects.toThrow('Job not found');
  });

  it('should throw moveJob for disallowed status', async () => {
    const orch = createOrchestrator({ db });
    const { id } = await orch.client('q').add({ n: 1 });
    orch.register('q', { worker: { pollMs: 50 } });
    orch.process('q', async () => {});
    orch.startAll();
    await new Promise((r) => setTimeout(r, 300));
    await orch.stopAll();

    await expect(
      orch.moveJob(id, 'other', { status: 'ready' })
    ).rejects.toThrow('cannot be moved');
  });

  it('should pause and resume via settings and worker', async () => {
    const orch = createOrchestrator({ db });
    orch.register('p-q', { worker: { pollMs: 50 } });
    orch.process('p-q', async () => {});

    await orch.pause('p-q');
    expect(await orch.isPaused('p-q')).toBe(true);
    expect(orch.worker('p-q').isPaused).toBe(true);

    await orch.resume('p-q');
    expect(await orch.isPaused('p-q')).toBe(false);
    expect(orch.worker('p-q').isPaused).toBe(false);
  });

  it('should return workers for dashboard', () => {
    const orch = createOrchestrator({ db });
    orch.register('w1', { worker: {} });
    orch.register('w2', { worker: {} });
    orch.register('client-only');

    expect(orch.workers()).toHaveLength(2);
  });

  it('should no-op transfer when from equals to', async () => {
    const orch = createOrchestrator({ db });
    await orch.client('same').add({ n: 1 });
    const { moved } = await orch.transfer({ from: 'same', to: 'same' });
    expect(moved).toBe(0);
  });
});
