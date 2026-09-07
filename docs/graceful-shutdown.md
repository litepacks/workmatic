---
title: Graceful Shutdown
description: Zero-downtime termination, OS signal handling (SIGINT/SIGTERM), and container lifecycle management in Docker & Kubernetes
order: 10
---

# Graceful Shutdown 🛡️

:::lead
Prevent data corruption and interrupted background jobs during deployments, container scale-downs, and server restarts.
:::

## 💡 The Problem

When a Node.js process is stopped (via `Ctrl+C`, `docker stop`, or Kubernetes pod termination), the OS sends `SIGTERM` or `SIGINT`.

If your application exits abruptly:
- Jobs currently executing in memory are aborted mid-flight.
- Database locks or incomplete transactions may linger.
- Third-party API calls may be left in an inconsistent state.

Workmatic's **Graceful Shutdown** ensures that:
1. Workers immediately stop claiming **new** jobs from SQLite.
2. In-flight jobs are given a configurable grace period to finish and mark themselves `done`.
3. Micro-batch completion buffers are completely flushed to disk.
4. If tasks hang beyond the timeout deadline, the process forces exit cleanly.

---

## 🚀 Quick Usage

### On a Single Worker
```typescript
import { createDatabase, createWorker } from 'workmatic';

const db = createDatabase({ filename: './jobs.db' });
const worker = createWorker({ db, queue: 'transcoding' });
worker.start();

// Automatically attach SIGINT / SIGTERM handlers
worker.attachSignalHandlers({
  timeoutMs: 30_000, // Wait up to 30 seconds for in-flight tasks to finish
  onShutdownStart: (signal) => console.log(`Received ${signal}, draining worker...`),
  onShutdownComplete: () => console.log('All jobs finished successfully. Exiting.'),
});
```

### On an Orchestrator (Multi-Queue)
```typescript
import { createDatabase, createOrchestrator } from 'workmatic';

const db = createDatabase({ filename: './jobs.db' });
const orchestrator = createOrchestrator({ db });

orchestrator.register('emails', { worker: { concurrency: 4 } });
orchestrator.register('webhooks', { worker: { concurrency: 10 } });
orchestrator.startAll();

// Stop all registered workers simultaneously on shutdown
orchestrator.attachSignalHandlers({
  timeoutMs: 20_000,
  onShutdownComplete: () => console.log('All workers stopped cleanly.'),
});
```

### Direct Function: `attachGracefulShutdown`
You can also use the standalone utility function on any worker, orchestrator, or array of workers:

```typescript
import { attachGracefulShutdown } from 'workmatic';

const detach = attachGracefulShutdown([worker1, worker2], {
  timeoutMs: 15_000,
  exitOnComplete: true, // Calls process.exit(0) on success
});

// To unregister the signal handlers later:
// detach();
```

---

## ⚙️ Configuration Options (`GracefulShutdownOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `signals` | `NodeJS.Signals[]` | `['SIGINT', 'SIGTERM']` | Array of POSIX signals to intercept. |
| `timeoutMs` | `number` | `30000` (30s) | Maximum milliseconds to wait for running jobs to finish. |
| `exitOnComplete`| `boolean` | `true` | Whether to automatically call `process.exit()` once finished. |
| `exitCode` | `number` | `0` | Exit code used when all jobs drain successfully. |
| `timeoutExitCode` | `number` | `1` | Exit code used if shutdown times out before jobs finish. |
| `onShutdownStart` | `(sig: NodeJS.Signals) => void` | `undefined` | Callback invoked as soon as an OS signal is intercepted. |
| `onShutdownComplete` | `() => void` | `undefined` | Callback invoked when all workers are drained and stopped. |
| `onShutdownError` | `(err: unknown) => void` | `undefined` | Callback invoked if an error occurs or timeout expires. |

---

## 🐳 Docker & Kubernetes Best Practices

### Dockerfile Tips
Ensure your container process receives signals properly:

```dockerfile
# Use node directly or dumb-init so PID 1 forwards SIGTERM
CMD ["node", "dist/index.js"]
```

If using Docker Compose:
```yaml
services:
  worker:
    build: .
    stop_grace_period: 35s # Must be greater than Workmatic timeoutMs (30s)
    volumes:
      - ./data:/app/data
```

### Kubernetes Pod Spec
Ensure `terminationGracePeriodSeconds` is configured with enough buffer for Workmatic's `timeoutMs`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workmatic-workers
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 45 # 45s > 30s timeoutMs
      containers:
        - name: worker
          image: my-app:latest
          volumeMounts:
            - mountPath: /data
              name: sqlite-storage
```
