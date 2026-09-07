---
title: Client API
description: Complete reference for the Workmatic Client — enqueuing jobs, batching, priorities, delayed execution, and queue stats
order: 4
---

# Client API 📬

:::lead
The Workmatic Client provides a lightweight, strongly-typed interface to enqueue, batch, query, and manage background jobs in SQLite.
:::

## 🛠️ Creating a Client

A client is instantiated with `createClient()`. You can create multiple clients pointing to different queues or sharing the same SQLite database handle.

```typescript
import { createDatabase, createClient } from 'workmatic';

const db = createDatabase({ filename: './jobs.db' });

const client = createClient({
  db,
  queue: 'reports', // Target queue name (default: 'default')
});
```

### Options (`ClientOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `db` | `WorkmaticDb` | **Required** | The Kysely/better-sqlite3 database instance created via `createDatabase()`. |
| `queue` | `string` | `'default'` | Queue name this client will submit jobs to by default. |
| `worker` | `WorkmaticWorker` | `undefined` | Optional worker reference to trigger event-driven zero-latency wakeups (`worker.wakeUp()`) when non-delayed jobs are added. |
| `onJobAdded` | `() => void` | `undefined` | Callback hook triggered whenever a ready job is enqueued. |

---

## ➕ Enqueuing Jobs (`add`)

Use `client.add(payload, options?)` to schedule a single background job.

```typescript
interface GeneratePdfPayload {
  reportId: string;
  userId: string;
  format: 'a4' | 'letter';
}

const client = createClient<GeneratePdfPayload>({ db, queue: 'reports' });

const result = await client.add(
  {
    reportId: 'rep_98124',
    userId: 'usr_441',
    format: 'a4',
  },
  {
    priority: 10,
    maxAttempts: 5,
  }
);

console.log('Job ID:', result.id); // e.g. "V1StGXR8_Z5jdHi6B-myT"
console.log('Success:', result.ok); // true
```

### Options (`AddJobOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `priority` | `number` | `0` | Higher numbers are claimed first by workers. Negative values can be used for low-priority background chores. |
| `delayMs` | `number` | `0` | Delay in milliseconds before the job becomes eligible for processing (`run_at = Date.now() + delayMs`). |
| `maxAttempts` | `number` | `3` | Maximum number of execution attempts before the job transitions to `dead` status. |

---

## 🚀 Delayed Jobs

Jobs can be scheduled to run in the future by passing `delayMs`:

```typescript
// Run in 15 minutes
await client.add(
  { reminderId: 'rem_123' },
  { delayMs: 15 * 60 * 1000 }
);

// Run tomorrow
const oneDayMs = 24 * 60 * 60 * 1000;
await client.add(
  { invoiceId: 'inv_555' },
  { delayMs: oneDayMs }
);
```

> [!NOTE]
> Delayed jobs have `run_at > now()`. The worker's covering index `idx_workmatic_jobs_claim` skips delayed jobs until their timestamp is reached, ensuring zero overhead on active claims.

---

## ⚡ High-Throughput Batch Enqueuing (`addMany`)

When enqueuing multiple jobs (e.g. bulk email campaigns, data ingestion pipelines), calling `add()` in a loop creates separate transactions. Use `addMany()` to execute the entire batch inside a **single SQLite transaction**:

```typescript
const items = Array.from({ length: 5000 }, (_, i) => ({
  index: i,
  timestamp: Date.now(),
}));

const batchResult = await client.addMany(items, {
  priority: 2,
  maxAttempts: 3,
});

console.log(`Inserted ${batchResult.ids.length} jobs in a single transaction.`);
```

### Performance:
- Individual `add()`: ~37,000 ops/sec (sequential).
- Batch `addMany()`: Over **150,000+ jobs/sec** inserted into SQLite.

---

## 📊 Inspecting Queue Stats (`stats`)

Retrieve live job counts for the client's queue:

```typescript
const stats = await client.stats();

console.log(stats);
// Output:
// {
//   ready: 42,     // Waiting to be claimed (includes pending and retrying)
//   running: 4,    // Currently leased and being executed by workers
//   done: 10520,   // Successfully completed
//   dead: 3,       // Exhausted max attempts (failed permanently)
//   total: 10569   // Total jobs across all statuses in this queue
// }
```

Thanks to the covering index `idx_workmatic_jobs_stats`, `stats()` queries take less than **0.2 ms** even with hundreds of thousands of rows.

---

## 🧹 Clearing Jobs (`clear`)

Remove jobs from the database for maintenance or testing:

```typescript
// Clear all completed ("done") jobs
const deletedDone = await client.clear({ status: 'done' });
console.log(`Deleted ${deletedDone} completed jobs.`);

// Clear all dead jobs
const deletedDead = await client.clear({ status: 'dead' });
console.log(`Deleted ${deletedDead} dead-letter jobs.`);

// Purge the entire queue regardless of status
const totalDeleted = await client.clear();
console.log(`Purged ${totalDeleted} total jobs from queue.`);
```

---

## 🔍 Payload Validation

Workmatic enforces JSON serializability on all payloads before hitting SQLite:
- Cyclic references are rejected with an informative error.
- Payloads larger than SQLite's limits are caught early.
- You can use standard schema validators like `zod` or `valibot` before passing payloads to `client.add()`.

```typescript
import { z } from 'zod';

const OrderSchema = z.object({
  orderId: z.string(),
  amount: z.number().positive(),
});

type OrderPayload = z.infer<typeof OrderSchema>;

const orderClient = createClient<OrderPayload>({ db, queue: 'orders' });

async function enqueueOrder(raw: unknown) {
  const payload = OrderSchema.parse(raw);
  return await orderClient.add(payload);
}
```
