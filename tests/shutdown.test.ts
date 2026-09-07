import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachGracefulShutdown } from '../src/shutdown.js';
import { createDatabase } from '../src/database.js';
import { createWorker } from '../src/worker.js';
import { createOrchestrator } from '../src/orchestrator.js';
import type { WorkmaticWorker, WorkmaticOrchestrator } from '../src/types.js';

describe('Graceful Shutdown', () => {
  let db: ReturnType<typeof createDatabase>;
  let exitMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createDatabase();
    exitMock = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(async () => {
    exitMock.mockRestore();
    await db.destroy();
  });

  it('stops a single worker gracefully when signal received', async () => {
    const worker = createWorker({ db });
    worker.process(async () => {});
    worker.start();
    expect(worker.isRunning).toBe(true);

    let startSignal: string | null = null;
    let completed = false;

    const detach = attachGracefulShutdown(worker, {
      signals: ['SIGTERM'],
      exitOnComplete: false,
      onShutdownStart: (sig) => {
        startSignal = sig;
      },
      onShutdownComplete: () => {
        completed = true;
      },
    });

    process.emit('SIGTERM', 'SIGTERM');

    // Wait for async shutdown to finish
    await new Promise((r) => setTimeout(r, 50));

    expect(startSignal).toBe('SIGTERM');
    expect(completed).toBe(true);
    expect(worker.isRunning).toBe(false);

    detach();
  });

  it('stops orchestrator all workers gracefully', async () => {
    const orch = createOrchestrator({ db });
    orch.register('q1', { worker: true });
    orch.register('q2', { worker: true });
    orch.process('q1', async () => {});
    orch.process('q2', async () => {});
    orch.startAll();

    let completed = false;
    const detach = attachGracefulShutdown(orch, {
      signals: ['SIGINT'],
      exitOnComplete: false,
      onShutdownComplete: () => {
        completed = true;
      },
    });

    process.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setTimeout(r, 50));

    expect(completed).toBe(true);
    expect(orch.worker('q1').isRunning).toBe(false);
    expect(orch.worker('q2').isRunning).toBe(false);

    detach();
  });

  it('stops an array of workers gracefully', async () => {
    const w1 = createWorker({ db, queue: 'arr1' });
    const w2 = createWorker({ db, queue: 'arr2' });
    w1.process(async () => {});
    w2.process(async () => {});
    w1.start();
    w2.start();

    let completed = false;
    const detach = attachGracefulShutdown([w1, w2], {
      signals: ['SIGTERM'],
      exitOnComplete: false,
      onShutdownComplete: () => {
        completed = true;
      },
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    expect(completed).toBe(true);
    expect(w1.isRunning).toBe(false);
    expect(w2.isRunning).toBe(false);

    detach();
  });

  it('ignores subsequent signals while shutdown is in progress', async () => {
    const worker = createWorker({ db });
    let startCount = 0;

    const detach = attachGracefulShutdown(worker, {
      signals: ['SIGTERM'],
      exitOnComplete: false,
      onShutdownStart: () => {
        startCount++;
      },
    });

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGTERM', 'SIGTERM');

    await new Promise((r) => setTimeout(r, 50));
    expect(startCount).toBe(1);

    detach();
  });

  it('unregisters signal listeners when detach is called', async () => {
    const worker = createWorker({ db });
    let started = false;

    const detach = attachGracefulShutdown(worker, {
      signals: ['SIGTERM'],
      exitOnComplete: false,
      onShutdownStart: () => {
        started = true;
      },
    });

    detach();

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toBe(false);
  });

  it('handles timeout when shutdown exceeds timeoutMs', async () => {
    const slowWorker = {
      stop: () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
    } as unknown as WorkmaticWorker;

    let errorCaught: unknown;

    const detach = attachGracefulShutdown(slowWorker, {
      signals: ['SIGTERM'],
      timeoutMs: 20,
      exitOnComplete: true,
      timeoutExitCode: 42,
      onShutdownError: (err) => {
        errorCaught = err;
      },
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 60));

    expect(errorCaught).toBeDefined();
    expect((errorCaught as Error).message).toContain('timed out');
    expect(exitMock).toHaveBeenCalledWith(42);

    detach();
  });

  it('handles timeout when exitOnComplete is false', async () => {
    const slowWorker = {
      stop: () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
    } as unknown as WorkmaticWorker;

    let errorCaught: unknown;

    const detach = attachGracefulShutdown(slowWorker, {
      signals: ['SIGTERM'],
      timeoutMs: 20,
      exitOnComplete: false,
      onShutdownError: (err) => {
        errorCaught = err;
      },
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 60));

    expect(errorCaught).toBeDefined();
    expect(exitMock).not.toHaveBeenCalled();

    detach();
  });

  it('handles error when target stop throws', async () => {
    const brokenWorker = {
      stop: () => Promise.reject(new Error('stop boom')),
    } as unknown as WorkmaticWorker;

    let errorCaught: unknown;

    const detach = attachGracefulShutdown(brokenWorker, {
      signals: ['SIGTERM'],
      timeoutMs: 50,
      exitOnComplete: true,
      timeoutExitCode: 99,
      onShutdownError: (err) => {
        errorCaught = err;
      },
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 30));

    expect(errorCaught).toBeDefined();
    expect((errorCaught as Error).message).toBe('stop boom');
    expect(exitMock).toHaveBeenCalledWith(99);

    detach();
  });

  it('handles error when timeoutMs is 0 and exitOnComplete is false', async () => {
    const brokenWorker = {
      stop: () => Promise.reject(new Error('no timer fail')),
    } as unknown as WorkmaticWorker;

    let errorCaught: unknown;

    const detach = attachGracefulShutdown(brokenWorker, {
      signals: ['SIGTERM'],
      timeoutMs: 0,
      exitOnComplete: false,
      onShutdownError: (err) => {
        errorCaught = err;
      },
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 30));

    expect(errorCaught).toBeDefined();
    expect(exitMock).not.toHaveBeenCalled();

    detach();
  });

  it('calls process.exit with clean exit code when exitOnComplete is true', async () => {
    const worker = createWorker({ db });
    const detach = attachGracefulShutdown(worker, {
      signals: ['SIGTERM'],
      timeoutMs: 0,
      exitOnComplete: true,
      exitCode: 0,
    });

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 30));

    expect(exitMock).toHaveBeenCalledWith(0);
    detach();
  });

  it('supports worker.attachSignalHandlers() convenience method', async () => {
    const worker = createWorker({ db });
    worker.process(async () => {});
    worker.start();

    let completed = false;
    const detach = worker.attachSignalHandlers({
      signals: ['SIGINT'],
      exitOnComplete: false,
      onShutdownComplete: () => {
        completed = true;
      },
    });

    process.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setTimeout(r, 50));

    expect(completed).toBe(true);
    expect(worker.isRunning).toBe(false);

    detach();
  });

  it('supports orchestrator.attachSignalHandlers() convenience method', async () => {
    const orch = createOrchestrator({ db });
    orch.register('test-q', { worker: true });
    orch.process('test-q', async () => {});
    orch.startAll();

    let completed = false;
    const detach = orch.attachSignalHandlers({
      signals: ['SIGINT'],
      exitOnComplete: false,
      onShutdownComplete: () => {
        completed = true;
      },
    });

    process.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setTimeout(r, 50));

    expect(completed).toBe(true);
    expect(orch.worker('test-q').isRunning).toBe(false);

    detach();
  });
});
