import type { WorkmaticWorker, WorkmaticOrchestrator, GracefulShutdownOptions } from './types.js';

export type GracefulShutdownTarget =
  | WorkmaticWorker
  | WorkmaticOrchestrator
  | WorkmaticWorker[];

/**
 * Attach OS signal listeners (SIGINT, SIGTERM) to gracefully stop a worker,
 * an orchestrator, or a group of workers before the process exits.
 *
 * @param target - Worker, orchestrator, or array of workers to stop
 * @param options - Graceful shutdown options
 * @returns Detach function that unregisters the signal listeners
 *
 * @example
 * ```ts
 * const worker = createWorker({ db });
 * worker.start();
 *
 * const detach = attachGracefulShutdown(worker, {
 *   timeoutMs: 15000,
 *   onShutdownComplete: () => console.log('All jobs finished, shutting down'),
 * });
 * ```
 */
export function attachGracefulShutdown(
  target: GracefulShutdownTarget,
  options: GracefulShutdownOptions = {}
): () => void {
  const {
    signals = ['SIGINT', 'SIGTERM'],
    timeoutMs = 30000,
    exitOnComplete = true,
    exitCode = 0,
    timeoutExitCode = 1,
    onShutdownStart,
    onShutdownComplete,
    onShutdownError,
  } = options;

  let shuttingDown = false;

  async function stopTarget(): Promise<void> {
    if (Array.isArray(target)) {
      await Promise.all(target.map((w) => w.stop()));
    } else if ('stopAll' in target) {
      await target.stopAll();
    } else {
      await target.stop();
    }
  }

  const handler = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    onShutdownStart?.(signal);

    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`Graceful shutdown timed out after ${timeoutMs}ms`);
        onShutdownError?.(err);
        if (exitOnComplete) {
          process.exit(timeoutExitCode);
        }
      }, timeoutMs);

      timer.unref();
    }

    try {
      await stopTarget();
      if (timer) {
        clearTimeout(timer);
      }
      onShutdownComplete?.();
      if (exitOnComplete) {
        process.exit(exitCode);
      }
    } catch (err) {
      if (timer) {
        clearTimeout(timer);
      }
      onShutdownError?.(err);
      if (exitOnComplete) {
        process.exit(timeoutExitCode);
      }
    }
  };

  for (const sig of signals) {
    process.on(sig, handler);
  }

  return function detach(): void {
    for (const sig of signals) {
      process.removeListener(sig, handler);
    }
  };
}
