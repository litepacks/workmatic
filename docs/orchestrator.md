---
title: Multi-Queue Orchestrator
description: Managing multiple job queues, coordinating workers, pausing/resuming queues, and bulk job transfers
order: 6
---

# Multi-Queue Orchestrator 🎛️

:::lead
The Workmatic Orchestrator coordinates multiple queues within a single Node.js application, enabling unified lifecycle management, cross-queue routing, and dead-letter queue recovery.
:::

## 🚀 Overview

Real-world applications typically separate workloads into distinct queues (e.g. `urgent-emails`, `bulk-indexing`, `billing-webhooks`, `pdf-generation`).

The Orchestrator simplifies multi-queue architectures by:
- Registering clients and workers under a unified registry.
- Providing batch lifecycle controls (`startAll()`, `stopAll()`).
- Pausing and resuming specific queues dynamically.
- Transferring jobs between queues (e.g. moving failed jobs to a dead-letter queue or retrying them in bulk).
- Moving individual jobs by ID.

---

## 🛠️ Creating an Orchestrator

```typescript
import { createDatabase, createOrchestrator } from 'workmatic';

const db = createDatabase({ filename: './jobs.db' });
const orchestrator = createOrchestrator({ db });
```

---

## 📋 Registering Queues

Use `orchestrator.register(queueName, options?)` to declare queues and configure their dedicated worker:

```typescript
// 1. High priority notifications queue
orchestrator.register('notifications', {
  worker: {
    concurrency: 5,
    timeoutMs: 10_000,
  },
});

// 2. Heavy background export queue
orchestrator.register('reports', {
  worker: {
    concurrency: 2,
    timeoutMs: 120_000,
    leaseMs: 180_000,
  },
});

// 3. Register processor functions
orchestrator.process('notifications', async (job) => {
  await sendPushNotification(job.payload);
});

orchestrator.process('reports', async (job) => {
  await generateLargeCsv(job.payload);
});

// 4. Start all registered workers simultaneously
orchestrator.startAll();
```

---

## 📬 Accessing Registered Clients & Workers

```typescript
// Get client for a specific queue to enqueue jobs
const notificationsClient = orchestrator.client('notifications');
await notificationsClient.add({ userId: '123', message: 'Order shipped' });

// Get worker for a specific queue
const reportsWorker = orchestrator.worker('reports');
console.log('Reports worker running:', reportsWorker.isRunning);

// List all known queue names in the database
const allQueues = await orchestrator.queues();
console.log('Active queues:', allQueues); // ['default', 'notifications', 'reports']
```

---

## ⏸️ Pausing and Resuming Queues

Pausing a queue stops workers from claiming new jobs, while allowing currently executing jobs to finish cleanly. 

The pause state is synchronized in SQLite (`workmatic_settings`), which means external CLI commands and other processes will immediately observe the pause.

```typescript
// Pause the reports queue during high system traffic
await orchestrator.pause('reports');

console.log('Is paused?', await orchestrator.isPaused('reports')); // true

// Resume processing when traffic normalizes
await orchestrator.resume('reports');
```

---

## 🔀 Bulk Job Transfers (`transfer`)

The Orchestrator allows moving jobs en masse between queues. This is especially useful for:
- Moving dead jobs to a specialized inspection queue (`dead-letter-box`).
- Re-queuing failed jobs back into an active queue after fixing a bug.
- Re-balancing load during peak events.

```typescript
// Transfer up to 500 dead jobs from 'notifications' to 'dead-letters'
const result = await orchestrator.transfer({
  from: 'notifications',
  to: 'dead-letters',
  status: 'dead',
  limit: 500,
});
console.log(`Transferred ${result.moved} dead jobs.`);

// Retry dead jobs by moving them back to 'notifications' with resetForRetry: true
const retried = await orchestrator.transfer({
  from: 'dead-letters',
  to: 'notifications',
  status: 'dead',
  resetForRetry: true, // Resets attempts to 0, status to 'ready', and clears last_error
});
console.log(`Reset and queued ${retried.moved} jobs for immediate re-execution.`);
```

### Transfer Options (`TransferOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `from` | `string` | **Required** | Source queue name. |
| `to` | `string` | **Required** | Destination queue name. |
| `status` | `JobStatus \| JobStatus[]` | `['ready', 'dead']` | Filter by status to transfer. |
| `limit` | `number` | `10000` | Maximum number of rows to move in one operation. |
| `resetForRetry`| `boolean` | `false` | When transferring `'dead'` jobs, resets `status = 'ready'`, `attempts = 0`, and `last_error = null`. |

---

## 🎯 Moving Individual Jobs (`moveJob`)

Move a single job to another queue by its public ID:

```typescript
await orchestrator.moveJob('V1StGXR8_Z5jdHi6B-myT', 'priority-queue', {
  status: ['ready', 'dead'],
  resetForRetry: true,
});
```

---

## 📊 Aggregated Queue Statistics

Fetch real-time stats across all queues in one call:

```typescript
const stats = await orchestrator.stats();

console.log(stats);
// {
//   notifications: { ready: 10, running: 2, done: 400, dead: 1, total: 413 },
//   reports:       { ready: 1,  running: 2, done: 50,  dead: 0, total: 53 }
// }
```

---

## 🛡️ Graceful Shutdown

Shut down all registered queue workers in parallel with a single call:

```typescript
// Drains all active fastq queues across all workers
await orchestrator.stopAll();

// Or automatically hook into OS signals:
orchestrator.attachSignalHandlers({
  timeoutMs: 15_000,
  onShutdown: (signal) => console.log(`Stopping orchestrator on ${signal}...`),
});
```
