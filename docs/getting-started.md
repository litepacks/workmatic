---
title: Getting Started
description: Quick start guide to installing and running Workmatic in your Node.js application
order: 2
---

# Getting Started 🚀

:::lead
Get up and running with Workmatic in less than 5 minutes. No Redis, no external processes, just embedded SQLite speed.
:::

## 📦 Installation

Workmatic requires **Node.js 18+** (Node.js 20+ or 22+ recommended). Install Workmatic along with its runtime dependency `better-sqlite3`:

```bash
npm install workmatic better-sqlite3
```

Or using your favorite package manager:

```bash
# pnpm
pnpm add workmatic better-sqlite3

# yarn
yarn add workmatic better-sqlite3
```

---

## 🗄️ 1. Initialize the Database

Workmatic encapsulates SQLite initialization via `createDatabase`. It automatically applies optimal production pragmas (WAL mode, memory temp store, 64MB page cache) and runs schema migrations if `autoMigrate` is true (the default).

```typescript
import { createDatabase } from 'workmatic';

const db = createDatabase({
  filename: './data/jobs.db', // Path to SQLite file, or ':memory:' for tests
  autoMigrate: true,          // Automatically create tables & covering indexes
  verbose: false,             // Set true to log raw SQL queries during debugging
});
```

> [!TIP]
> In production, make sure the directory containing the SQLite file is persistent (e.g., a mounted Docker volume or persistent disk) so that job data survives process restarts.

---

## 👷 2. Create a Worker

A Worker polls the SQLite queue for pending jobs and executes your registered processor function.

```typescript
import { createWorker } from 'workmatic';

// Instantiate worker for the "emails" queue
const worker = createWorker({
  db,
  queue: 'emails',
  concurrency: 4,      // Process up to 4 jobs concurrently
  pollIntervalMs: 500, // Fallback poll interval (event-driven wakeup wakes it up immediately)
});

// Register the async job processor
worker.process(async (job) => {
  console.log(`Processing job ${job.id}, attempt ${job.attempts}/${job.maxAttempts}`);
  console.log('Payload:', job.payload);

  // Perform async work (e.g. call email API)
  await sendEmail(job.payload.to, job.payload.subject, job.payload.body);

  // Throwing an error will mark the job as failed and schedule an automatic retry
  // Returning cleanly marks the job as completed
});

// Start processing jobs
worker.start();
```

---

## 📬 3. Enqueue Jobs with Client

Use `createClient` to enqueue jobs from HTTP route handlers, event listeners, or CLI scripts.

```typescript
import { createClient } from 'workmatic';

interface WelcomeEmailPayload {
  to: string;
  name: string;
}

// Client is strongly typed with your payload interface
const client = createClient<WelcomeEmailPayload>({
  db,
  queue: 'emails',
});

// Enqueue a single job
const job = await client.add({
  to: 'alice@example.com',
  name: 'Alice',
}, {
  priority: 10,       // Higher numbers process first (default: 0)
  maxAttempts: 3,     // Automatic retries on failure (default: 3)
});

console.log(`Enqueued job ${job.id} with status ${job.status}`);
```

### Batch Enqueuing (`addMany`)

When enqueuing hundreds or thousands of jobs at once, use `addMany` to wrap insertions in a single SQLite transaction:

```typescript
const jobs = await client.addMany([
  { payload: { to: 'bob@example.com', name: 'Bob' }, priority: 5 },
  { payload: { to: 'carol@example.com', name: 'Carol' }, priority: 1 },
]);

console.log(`Enqueued ${jobs.length} jobs in a single transaction.`);
```

---

## 🔄 4. Complete End-to-End Example

Here is a minimal, self-contained example you can run immediately:

```typescript
import { createDatabase, createClient, createWorker } from 'workmatic';

async function main() {
  const db = createDatabase({ filename: ':memory:' });

  const worker = createWorker({ db, queue: 'notifications', concurrency: 2 });
  worker.process(async (job) => {
    console.log(`[Worker] Handled notification:`, job.payload);
  });
  worker.start();

  const client = createClient({ db, queue: 'notifications' });
  await client.add({ message: 'Hello from Workmatic!' });

  // Give the worker a moment to process before exiting
  await new Promise((resolve) => setTimeout(resolve, 100));
  await worker.stop();
}

main().catch(console.error);
```

---

## 🧭 Next Steps

- Explore [Architecture & Engine](./architecture.md) to learn how SQLite WAL mode, atomic leases, and event-driven wakeup achieve 37,000+ ops/sec.
- Check [Client API](./client.md) for full configuration options, delays, and queue statistics.
- Learn about [Worker API](./worker.md) for concurrency, lease renewal, and completion micro-batching.
- Add real-time monitoring with the [Web Dashboard](./dashboard.md).
- Control your queues using AI coding assistants via the [Model Context Protocol (MCP)](./mcp.md).
