---
title: Introduction
description: Overview of Workmatic — persistent, high-performance background job queue for Node.js using SQLite
order: 1
---

# Workmatic 🚂

:::lead
A persistent, high-performance background job queue for Node.js backed by SQLite with zero external infrastructure dependencies.
:::

Workmatic delivers production-grade background job processing without the operational overhead, memory consumption, or maintenance complexity of Redis, RabbitMQ, PostgreSQL, or Kafka.

Built on **better-sqlite3** and **Kysely**, Workmatic embeds directly into your Node.js application process. It provides atomic lease-based job processing, priority queues, delayed execution, automatic exponential retries, multi-queue orchestration, an embedded real-time web dashboard, a full CLI toolset, and official **Model Context Protocol (MCP)** support for autonomous AI coding agents.

---

## ⚡ Key Highlights

- 🪶 **Zero External Infrastructure**: Operates purely on local SQLite databases in WAL mode (`jobs.db`). No Redis, Docker, or external service required.
- ⚡ **Extreme Hot Path Performance**:
  - **37,600+ ops/sec** sequential job insertion (0.03 ms latency).
  - **32,600+ ops/sec** concurrent claim & process throughput.
  - **4,900+ ops/sec** live queue statistics queries via composite covering indexes.
- 🔒 **Atomic Lease-Based Claiming**: Single-pass `UPDATE ... WHERE rowid IN (SELECT ...) RETURNING ...` guarantees exactly-once claiming with zero duplicate execution across concurrent workers.
- ⏱️ **Event-Driven Wakeup**: Eliminates polling latency. When a ready job is enqueued, waiting workers wake up immediately (~0.03 ms) instead of waiting for the 1000 ms poll timer.
- 🧠 **Smart Memory Caching**: O(1) LRU prepared statement cache eliminates SQLite query compilation overhead on hot paths.
- 📦 **Completion Micro-Batching**: High-concurrency job completions are grouped into single atomic writes, boosting processing throughput by over 60%.
- 🎛️ **Multi-Queue Orchestration**: Register and manage multiple queues, bulk transfer jobs between queues (e.g. dead-letter queues), or move individual jobs.
- 📊 **Embedded Web Dashboard & Middleware**: Mountable real-time monitoring UI with zero frontend build dependencies, compatible with Express, Connect, or standalone HTTP.
- 🤖 **Native Model Context Protocol (MCP)**: 12 built-in AI tools enabling Claude Desktop, Cursor, and Antigravity to monitor queues, debug dead jobs, update job status, and receive real-time signals.
- 🛡️ **Production Reliability & Graceful Shutdown**: Full support for OS signal handling (`SIGINT`, `SIGTERM`), draining jobs safely during container or process termination.

---

## 🚀 Quick Example

```typescript
import { createDatabase, createClient, createWorker } from 'workmatic';

// 1. Initialize SQLite database with optimal pragmas (WAL mode, memory temp store, 64MB cache)
const db = createDatabase({ filename: './jobs.db' });

// 2. Create worker and define job processor
const worker = createWorker({ db, queue: 'emails', concurrency: 4 });

worker.process(async (job) => {
  console.log(`Processing email job ${job.id}:`, job.payload);
  // Send email...
});

worker.start();

// 3. Enqueue jobs from anywhere in your app
const client = createClient({ db, queue: 'emails' });

await client.add({
  to: 'user@example.com',
  subject: 'Welcome to Workmatic!',
});
```

---

## 🧭 Documentation Map

| Guide | Description |
| :--- | :--- |
| [Getting Started](./getting-started.md) | Installation, initial database setup, and basic client/worker workflows |
| [Architecture & Engine](./architecture.md) | SQLite WAL tuning, atomic claiming, partial indexes, and event-driven wakeup |
| [Client API](./client.md) | Enqueuing jobs (`add`, `addMany`), priorities, delays, stats, and clearing |
| [Worker API](./worker.md) | Concurrency, leases, timeouts, backoff strategies, and completion batching |
| [Orchestrator](./orchestrator.md) | Managing multiple queues, cross-queue transfers, and queue pauses |
| [Web Dashboard](./dashboard.md) | Embedded UI and Express/Connect middleware for live monitoring |
| [Model Context Protocol (MCP)](./mcp.md) | Connecting AI assistants (Claude, Cursor, Antigravity) with 12 tools and signals |
| [CLI Reference](./cli.md) | Managing queues, retrying dead jobs, and CSV export/import via CLI |
| [Graceful Shutdown](./graceful-shutdown.md) | Safe process termination in Docker, Kubernetes, and Node.js environments |
| [Benchmarks](./benchmarks.md) | Performance metrics, latency tables, and reproducible benchmark commands |
