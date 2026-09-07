---
title: Benchmarks & Performance
description: Comprehensive throughput, latency, and concurrency metrics for Workmatic on SQLite
order: 11
---

# Benchmarks & Performance ⚡

:::lead
Real-world throughput, latency numbers, and reproducible test suites demonstrating how Workmatic outperforms traditional queues on single-node workloads.
:::

## 📊 Summary of Benchmark Results

Tests run on Apple Silicon (M-series) / Ubuntu 22.04 with NVMe SSD and Node.js v22 using SQLite WAL mode and Workmatic's single-pass atomic claim engine:

| Workload | Operations | Throughput | Avg Latency | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Sequential Insert (`add`)** | 10,000 jobs | **37,600+ ops/sec** | **0.026 ms** | Direct single-pass prepared statement insert |
| **Batch Insert (`addMany`)** | 50,000 jobs | **150,000+ ops/sec** | **0.006 ms** | Single transaction multi-row insert |
| **Concurrent Processing (c=1)** | 5,000 jobs | **12,400+ ops/sec** | **0.080 ms** | 1 worker fastq stream |
| **Concurrent Processing (c=4)** | 5,000 jobs | **24,800+ ops/sec** | **0.040 ms** | 4 parallel fastq threads |
| **Concurrent Processing (c=16)** | 5,000 jobs | **32,600+ ops/sec** | **0.030 ms** | High concurrency micro-batching enabled |
| **Mixed Workload (Insert + Process)** | 1,000 jobs | **18,500+ ops/sec** | **0.054 ms** | Writers and readers running simultaneously in WAL mode |
| **Live Stats Query (`stats()`)** | 1,000 queries | **4,900+ ops/sec** | **0.204 ms** | Covering composite index lookups |
| **Event-Driven Wakeup Latency** | Single job | **~0.03 ms** | **0.030 ms** | Client-to-worker in-process event notification |

---

## 🏎️ How Workmatic Achieves This Speed

### 1. Zero Network Latency
Redis and Postgres job queues incur at least **0.5 ms to 2.0 ms** per round-trip network hop for every claim, complete, and lock extension. Workmatic runs in the same process memory space as your application—function calls and SQLite C-bindings execute in microseconds.

### 2. SQLite WAL Mode (Concurrent Read/Write)
With `PRAGMA journal_mode = WAL`, writers write sequentially to the `-wal` log file while concurrent workers read committed snapshots without blocking or being blocked.

### 3. Single-Pass Atomic Claims
Instead of executing a `SELECT ... FOR UPDATE` followed by an `UPDATE ...`, Workmatic's atomic:
```sql
UPDATE workmatic_jobs SET status = 'running', ...
WHERE rowid IN (SELECT rowid FROM workmatic_jobs WHERE ... LIMIT ?)
RETURNING *;
```
claims up to $N$ jobs in a single SQLite transaction and returns their full records immediately.

### 4. Statement Caching
Workmatic eliminates the SQLite bytecode compilation step by reusing compiled statement pointers via an O(1) LRU statement cache.

### 5. Completion Micro-Batching
When running under high concurrency, marking jobs as `done` is automatically micro-batched into chunked multi-row updates, eliminating write transaction contention.

---

## 🧪 Running the Benchmarks Locally

Workmatic includes a built-in benchmarking suite that you can execute at any time:

### Full Benchmark Suite
Runs sequential insert, parallel insert, processing at concurrency 1, 2, 4, 8, 16, and mixed workloads:

```bash
npm run bench
```

To test against a persistent file on disk instead of in-memory SQLite:
```bash
npm run bench -- --file
```

### Micro Benchmark Suite
Runs a rapid 2,000-job sequential insert and stats query check for quick CI validation:

```bash
npm run bench:micro
```
