---
title: Architecture & Engine
description: Deep dive into Workmatic internal architecture, SQLite WAL optimizations, atomic claiming, and event-driven wakeup
order: 3
---

# Architecture & Engine ⚙️

:::lead
Learn how Workmatic achieves high throughput and sub-millisecond latency using SQLite WAL mode, atomic single-pass lease claiming, covering indexes, and event-driven wakeups.
:::

## 🏛️ System Overview

Traditional job queues (e.g. BullMQ, Celery, Sidekiq) rely on external memory stores like Redis or relational databases like PostgreSQL. This introduces network hops, serialization overhead, memory bloat, and operational maintenance.

Workmatic runs **in-process** via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [Kysely](https://kysely.dev). It treats SQLite not just as a store, but as a high-concurrency, zero-network-hop job engine.

```
┌─────────────────────────────────────────────────────────────┐
│                       Node.js Process                       │
│                                                             │
│  ┌──────────────────┐               ┌────────────────────┐  │
│  │ Workmatic Client │               │  Workmatic Worker  │  │
│  └────────┬─────────┘               └─────────▲──────────┘  │
│           │ add() / addMany()                 │ claimBatch()│
│           │ ~0.03 ms                          │ ~0.04 ms    │
│           ▼                                   │             │
│  ┌────────────────────────────────────────────┴──────────┐  │
│  │            Prepared Statement Cache (O(1))            │  │
│  └──────────────────────────┬────────────────────────────┘  │
│                             │                               │
│                             ▼                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           better-sqlite3 Engine (WAL Mode)            │  │
│  │   • Single-pass UPDATE ... WHERE rowid IN (...)       │  │
│  │   • Covering & Partial Indexes                        │  │
│  │   • 64MB Page Cache + 256MB MMAP                      │  │
│  └──────────────────────────┬────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────┘
                              │
                              ▼
                     [ ./data/jobs.db ]
```

---

## ⚡ SQLite Engine Tuning & Pragmas

When `createDatabase()` is called, Workmatic immediately configures SQLite with production-tuned pragmas:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;
PRAGMA mmap_size = 268435456;
```

### Why These Pragmas Matter

| Pragma | Value | Purpose |
| :--- | :--- | :--- |
| `journal_mode` | `WAL` | **Write-Ahead Logging**: Concurrent readers never block writers, and writers never block readers. |
| `synchronous` | `NORMAL` | Avoids a synchronous disk fsync on every transaction while remaining fully crash-safe against process terminations. |
| `busy_timeout` | `5000` | Eliminates `SQLITE_BUSY` lock contention by automatically waiting up to 5 seconds if another thread or process is committing. |
| `temp_store` | `MEMORY` | Directs all temporary tables, sorting buffers, and intermediate aggregates to RAM instead of disk. |
| `cache_size` | `-64000` | Allocates a 64MB in-memory LRU page cache for active job lookups. |
| `mmap_size` | `268435456` | Maps up to 256MB of the database directly into the process's address space for zero-copy reads. |

---

## 🔒 Atomic Lease-Based Claiming

A major hazard in multi-worker background systems is **double execution** (race conditions where two workers pick up the same job).

Workmatic eliminates this with a **single-pass atomic UPDATE with RETURNING**:

```sql
UPDATE workmatic_jobs
SET status = 'active',
    locked_at = :now,
    locked_by = :workerId,
    lease_expires_at = :leaseExpiresAt,
    attempts = attempts + 1,
    started_at = COALESCE(started_at, :now)
WHERE rowid IN (
  SELECT rowid FROM workmatic_jobs
  WHERE queue = :queue
    AND status IN ('pending', 'retrying')
    AND (run_at IS NULL OR run_at <= :now)
  ORDER BY priority DESC, created_at ASC
  LIMIT :batchSize
)
RETURNING *;
```

### Key Safety Guarantees:
1. **Single SQLite Lock Acquisition**: The candidate selection subquery and status transition occur within SQLite's internal row lock in one atomic step.
2. **Deterministic Priority**: Jobs with higher `priority` are always claimed first; ties are broken by oldest `created_at` (FIFO).
3. **Lease Protection**: If a worker crashes or hangs, its `lease_expires_at` timestamp expires. The built-in reaper query automatically returns the job to `retrying` or `failed` status.

---

## 🎯 Partial & Covering Indexes

To maintain constant sub-millisecond query latency even when the `workmatic_jobs` table holds millions of historical records, Workmatic creates targeted covering indexes:

### 1. The Claim Index
```sql
CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_claim 
ON workmatic_jobs (queue, status, run_at, priority DESC, created_at ASC);
```
Enables SQLite to evaluate `WHERE queue = ? AND status IN ('pending', 'retrying') AND run_at <= ?` and order by `priority DESC, created_at ASC` purely inside B-Tree index pages with zero table scans.

### 2. The Statistics Covering Index
```sql
CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_stats 
ON workmatic_jobs (queue, status);
```
Supplies instantaneous counts for queue stats (`pending`, `active`, `completed`, `failed`, `delayed`) directly from index leaf counts (4,900+ queries/sec).

### 3. The Dead Lease Reaper Index
```sql
CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_reaper 
ON workmatic_jobs (status, lease_expires_at);
```
Allows the worker's background stall detector to identify expired leases in under 0.05 ms without scanning active or completed rows.

---

## ⏱️ Event-Driven Wakeup

Traditional polling queues incur a latency penalty equal to their polling interval (often 500 ms – 1000 ms). If a job is added at second 0.01, it sits idle until the worker ticks at second 1.00.

Workmatic implements an **event-driven wakeup mechanism**:

```
[ Client: add() ] ─── Enqueues Job ───► SQLite DB
         │
         └──── Wakes up worker via worker.wakeUp() ───► [ Worker: claimBatch() ]
                                                         Latency: ~0.03 ms
```

- When a job is scheduled for immediate execution (`run_at <= now`), the client signals active workers in-process.
- The worker breaks its sleep state instantly, claiming and starting the job in **0.03 ms**.
- The fallback poll interval (default: 1000 ms) is only used for delayed jobs or out-of-process multi-instance synchronization.

---

## 🧠 Statement Cache

SQLite queries normally require compilation into bytecode (`sqlite3_prepare_v2`) on every invocation. 

Workmatic uses an **O(1) LRU prepared statement cache** (`enableStatementCache`):
- Prepared statements for `INSERT`, `claimBatch`, `completeJob`, and `failJob` are cached per database connection.
- Parameter binding happens directly against pre-compiled byte-code handles.
- This cuts CPU cycles by ~45% on hot paths.

---

## 📦 Completion Micro-Batching

Under high concurrency (e.g. 50+ concurrent workers processing thousands of sub-millisecond tasks), individual `UPDATE` statements for each completion can contend on SQLite write transactions.

Workmatic provides automatic **micro-batching**:
- Completed job IDs and results are gathered into a non-blocking queue.
- Flushed either on tick boundary or when the batch size threshold is reached.
- Executed as a single multi-row `UPDATE` transaction, yielding up to a **60% throughput boost**.
