---
title: Worker API
description: Complete reference for the Workmatic Worker — concurrency, leases, execution timeouts, backoff retries, and lifecycle management
order: 5
---

# Worker API 👷

:::lead
The Workmatic Worker pulls jobs from SQLite using atomic lease-based claims, executes your async processors concurrently via fastq, manages retries with exponential backoff, and ensures crash recovery.
:::

## 🛠️ Creating a Worker

Workers are created via `createWorker()`. Each worker is bound to a specific queue and database handle.

```typescript
import { createDatabase, createWorker } from 'workmatic';

const db = createDatabase({ filename: './jobs.db' });

const worker = createWorker({
  db,
  queue: 'image-processing',
  concurrency: 8,
  timeoutMs: 30_000,
  leaseMs: 60_000,
});
```

### Options (`WorkerOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `db` | `WorkmaticDb` | **Required** | The Kysely/better-sqlite3 database instance. |
| `queue` | `string` | `'default'` | Name of the queue to claim jobs from. |
| `concurrency` | `number` | `1` | Number of jobs processed simultaneously via in-memory `fastq`. |
| `leaseMs` | `number` | `30000` (30s) | Duration in ms that a claimed job is locked to this worker. If the worker crashes, the lease expires and the job is automatically requeued. |
| `pollMs` | `number` | `1000` (1s) | Polling interval when the queue is idle. (Instant wakeups are triggered when clients enqueue jobs). |
| `timeoutMs` | `number` | `60000` (60s) | Maximum execution time for a single job before throwing a timeout error and triggering retry. Set `0` to disable timeouts. |
| `backoff` | `BackoffFunction` | `defaultBackoff` | Custom retry backoff calculation function `(attempt: number) => number` (returns delay in ms). |
| `completionBatchSize` | `number` | `50` | Micro-batching threshold for marking jobs as `done`. Flushes immediately via `setImmediate` or when buffer reaches size. |
| `persistState` | `boolean` | `false` | Whether to persist running/paused/stopped state in `workmatic_settings` table. |
| `autoRestore` | `boolean` | `true` | When `persistState` is true, automatically restores saved state on boot. |
| `pauseCheckIntervalMs`| `number` | `300` | How often (ms) the worker checks SQLite to see if the queue was paused externally via CLI or Dashboard. |
| `onPumpError` | `(err: unknown) => void` | `undefined` | Error handler for SQLite query failures in the worker pump loop. |

---

## ⚡ Defining the Job Processor (`process`)

Register an async function that receives the claimed `job` object:

```typescript
interface ImageJobPayload {
  imageUrl: string;
  targetWidth: number;
}

worker.process<ImageJobPayload>(async (job) => {
  console.log(`[Job ${job.id}] Attempt ${job.attempts} of ${job.maxAttempts}`);
  console.log(`Payload:`, job.payload);

  // Perform processing
  const resizedBuffer = await resizeImage(job.payload.imageUrl, job.payload.targetWidth);
  await uploadToS3(resizedBuffer);

  // Returning cleanly marks the job as 'done'
});
```

### The `Job` Object

| Property | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Public unique nanoid string of the job. |
| `queue` | `string` | Queue name. |
| `payload` | `TPayload` | Deserialized JSON payload object. |
| `status` | `'running'` | Current execution status. |
| `priority` | `number` | Job priority number. |
| `attempts` | `number` | Current execution attempt count (starts at 1). |
| `maxAttempts` | `number` | Maximum allowed attempts before marking `dead`. |
| `createdAt` | `number` | Creation timestamp in epoch milliseconds. |
| `lastError` | `string \| null` | Error message from the previous failed attempt, if any. |

---

## 🔄 Automatic Retries & Backoff

When an error is thrown inside `worker.process()`, Workmatic intercepts the exception:
1. If `attempts < maxAttempts`:
   - Increments `attempts`.
   - Computes delay using `backoff(attempts)`.
   - Schedules `run_at = now + delay`.
   - Sets status back to `'ready'` (or retrying).
   - Saves `last_error` to SQLite for debugging.
2. If `attempts >= maxAttempts`:
   - Marks status as `'dead'`.
   - Saves `last_error`. The job will not be retried automatically (can be retried later via CLI or MCP).

### Custom Backoff Functions

By default, Workmatic uses exponential backoff: `Math.min(1000 * Math.pow(2, attempts - 1), 60000)`.

You can supply a custom backoff curve:

```typescript
const worker = createWorker({
  db,
  queue: 'webhooks',
  // Custom linear backoff: 5s, 10s, 15s, 20s...
  backoff: (attempt) => attempt * 5000,
});
```

---

## ⏱️ Execution Timeouts

Prevent runaway tasks, infinite loops, or hanging network sockets from locking worker slots indefinitely:

```typescript
const worker = createWorker({
  db,
  queue: 'external-api',
  timeoutMs: 10_000, // Abort after 10 seconds
});
```

If the processor promise does not resolve within 10,000 ms, Workmatic rejects with:
```
Error: Job <id> timed out after 10000ms
```
The timeout triggers the standard retry mechanism and saves the timeout message to `last_error`.

---

## 🛑 Lifecycle Controls

### Starting and Stopping
```typescript
// Start worker loop and begin claiming jobs
worker.start();

// Gracefully drain active jobs and stop polling
await worker.stop();
```
`worker.stop()` stops claiming new jobs, waits for currently running in-flight tasks in `fastq` to finish, flushes buffered completion writes, and saves state.

### Pausing and Resuming
```typescript
// Pause: stops claiming new jobs, but finishes active ones
worker.pause();
console.log(worker.isPaused); // true

// Resume: resumes pulling jobs
worker.resume();
```

### Immediate Event Wakeup
```typescript
// Break out of the sleep poll timer immediately
worker.wakeUp();
```

### Signal Handling
```typescript
// Automatically listen for SIGINT and SIGTERM and call worker.stop()
const cleanup = worker.attachSignalHandlers({
  timeoutMs: 15_000, // Force exit after 15s if tasks don't drain
  onShutdown: (signal) => console.log(`Shutting down on ${signal}...`),
});
```
