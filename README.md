# Workmatic

A persistent job queue for Node.js using SQLite. Simple, reliable, and zero external dependencies beyond SQLite.

## Why?

I love [fastq](https://github.com/mcollina/fastq) - it's fast, simple, and has a great API. But it's in-memory only, which can be frustrating when you need jobs to survive process restarts or crashes.

Workmatic combines the simplicity of fastq with SQLite persistence. No Redis, no external services - just a single file that keeps your jobs safe. Perfect for small to medium workloads where you want durability without infrastructure complexity.

## Features

- **Persistent**: Jobs survive restarts via SQLite storage
- **Concurrent**: Process multiple jobs simultaneously with fastq
- **Priority**: Process high-priority jobs first
- **Delayed**: Schedule jobs to run in the future
- **Retries**: Automatic retries with exponential backoff
- **Lease-based**: Prevents double processing with lease locks
- **Dashboard**: Built-in web UI for monitoring
- **Type-safe**: Full TypeScript support with Kysely

## Installation

```bash
npm install workmatic
```

## Quick Start

```typescript
import { createDatabase, createClient, createWorker } from 'workmatic';

// Create database (use file path for persistence)
const db = createDatabase({ filename: './jobs.db' });

// Create a client to add jobs
const client = createClient({ db, queue: 'emails' });

// Add a job
const { id } = await client.add({ 
  to: 'user@example.com', 
  subject: 'Hello!' 
});
console.log(`Job created: ${id}`);

// Create a worker to process jobs
const worker = createWorker({
  db,
  queue: 'emails',
  concurrency: 4,
});

// Define the processor
worker.process(async (job) => {
  console.log(`Sending email to ${job.payload.to}`);
  await sendEmail(job.payload);
});

// Start processing
worker.start();
```

## API Reference

### `createDatabase(options)`

Initialize the database connection and schema.

```typescript
const db = createDatabase({
  // Option 1: File path (creates or opens existing)
  filename: './jobs.db',
  
  // Option 2: In-memory (for testing)
  filename: ':memory:',
  
  // Option 3: Existing better-sqlite3 instance
  db: existingSqliteInstance,
});
```

### `createClient(options)`

Create a client for adding jobs to a queue.

```typescript
const client = createClient({
  db,                    // Required: Database instance
  queue: 'default',      // Optional: Queue name (default: 'default')
});
```

#### `client.add(payload, options?)`

Add a job to the queue.

```typescript
const { ok, id } = await client.add(
  { email: 'user@example.com' },  // Payload (must be JSON-serializable)
  {
    priority: 0,      // Lower = higher priority (default: 0)
    delayMs: 5000,    // Delay before job becomes available (default: 0)
    maxAttempts: 3,   // Max retry attempts (default: 3)
  }
);
```

#### `client.stats()`

Get job statistics for the queue.

```typescript
const stats = await client.stats();
// { ready: 5, running: 2, done: 100, failed: 0, dead: 1, total: 108 }
```

### `createWorker(options)`

Create a worker to process jobs from a queue.

```typescript
const worker = createWorker({
  db,                     // Required: Database instance
  queue: 'default',       // Optional: Queue name (default: 'default')
  concurrency: 1,         // Optional: Parallel job count (default: 1)
  leaseMs: 30000,         // Optional: Job lease duration in ms (default: 30000)
  pollMs: 1000,           // Optional: Poll interval when idle (default: 1000)
  timeoutMs: 60000,       // Optional: Job execution timeout in ms (default: none)
  backoff: (n) => 1000 * Math.pow(2, n),  // Optional: Retry backoff function
});
```

#### `worker.process(fn)`

Set the job processor function.

```typescript
worker.process(async (job) => {
  console.log(`Processing job ${job.id}`);
  console.log(`Payload:`, job.payload);
  console.log(`Attempt ${job.attempts + 1} of ${job.maxAttempts}`);
  
  // Do work here
  // Throw an error to trigger retry
});
```

#### `worker.start()`

Start processing jobs.

```typescript
worker.start();
```

#### `worker.stop()`

Stop processing and wait for current jobs to finish.

```typescript
await worker.stop();
```

#### `worker.pause()` / `worker.resume()`

Pause and resume job processing.

```typescript
worker.pause();   // Stop claiming new jobs
worker.resume();  // Resume claiming jobs
```

#### `worker.stats()`

Get job statistics for the queue.

```typescript
const stats = await worker.stats();
```

#### Worker properties

```typescript
worker.isRunning;  // boolean
worker.isPaused;   // boolean
worker.queue;      // string
```

### `createDashboard(options)`

Create a standalone web dashboard server for monitoring and control.

```typescript
const dashboard = createDashboard({
  db,                    // Required: Database instance
  port: 3000,            // Optional: HTTP port (default: 3000)
  workers: [worker1],    // Optional: Workers to control
});

console.log(`Dashboard at http://localhost:${dashboard.port}`);

// Later, close the server
await dashboard.close();
```

### `createDashboardMiddleware(options)`

Create an Express-compatible middleware to mount the dashboard on an existing app.

```typescript
import express from 'express';
import { createDashboardMiddleware } from 'workmatic';

const app = express();

// Mount dashboard at /workmatic
app.use(createDashboardMiddleware({
  db,                        // Required: Database instance
  basePath: '/workmatic',    // Optional: URL prefix (default: '')
  workers: [worker],         // Optional: Workers to control
}));

app.listen(3000);
// Dashboard available at http://localhost:3000/workmatic
```

Works with any framework that supports Node.js `(req, res, next)` middleware:

```typescript
// Fastify
import fastify from 'fastify';
import middie from '@fastify/middie';

const app = fastify();
await app.register(middie);
app.use(createDashboardMiddleware({ db, basePath: '/jobs' }));

// Hono
import { Hono } from 'hono';
import { handle } from 'hono/node-server';

const app = new Hono();
app.use('/workmatic/*', (c) => {
  return new Promise((resolve) => {
    const middleware = createDashboardMiddleware({ db, basePath: '/workmatic' });
    middleware(c.env.incoming, c.env.outgoing, resolve);
  });
});
```

## Job Object

The job object passed to processors has these properties:

```typescript
interface Job<TPayload> {
  id: string;           // Unique public ID (nanoid)
  queue: string;        // Queue name
  payload: TPayload;    // Your job data
  status: JobStatus;    // 'ready' | 'running' | 'done' | 'failed' | 'dead'
  priority: number;     // Priority value
  attempts: number;     // Current attempt count (starts at 0)
  maxAttempts: number;  // Maximum attempts allowed
  createdAt: number;    // Unix timestamp (ms)
  lastError: string | null;  // Last error message
}
```

## Durability Model

Workmatic provides **at-least-once** delivery:

- Jobs are persisted to SQLite before `add()` returns
- A job may be processed multiple times if:
  - The worker crashes during processing
  - The lease expires before completion
- Jobs are only marked `done` after successful processing

### Idempotency Recommendation

Design your job handlers to be idempotent (safe to run multiple times):

```typescript
worker.process(async (job) => {
  // Check if already processed
  const exists = await db.checkProcessed(job.id);
  if (exists) return;
  
  // Process the job
  await processPayment(job.payload);
  
  // Mark as processed
  await db.markProcessed(job.id);
});
```

## Job Lifecycle

```
┌─────────┐     add()      ┌─────────┐
│  NEW    │ ─────────────▶ │  READY  │
└─────────┘                └────┬────┘
                                │
                         claim  │
                                ▼
                          ┌─────────┐
                          │ RUNNING │
                          └────┬────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         success          failure          failure
              │          (retries           (max
              │           left)           attempts)
              ▼                │                │
        ┌─────────┐           │                ▼
        │  DONE   │           │          ┌─────────┐
        └─────────┘           │          │  DEAD   │
                              │          └─────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  READY (retry)  │
                    │  with backoff   │
                    └─────────────────┘
```

## Options Glossary

| Option | Default | Description |
|--------|---------|-------------|
| `queue` | `'default'` | Queue name for job isolation |
| `concurrency` | `1` | Number of jobs to process in parallel |
| `leaseMs` | `30000` | How long a job is "locked" during processing |
| `pollMs` | `1000` | How often to check for new jobs when idle |
| `timeoutMs` | `undefined` | Job execution timeout (fails job if exceeded) |
| `priority` | `0` | Job priority (lower = processed first) |
| `delayMs` | `0` | Delay before job becomes available |
| `maxAttempts` | `3` | Maximum processing attempts |
| `backoff` | `2^n * 1000` | Function returning retry delay in ms |

## Dashboard

The built-in dashboard provides:

- Real-time job statistics
- Job list with filtering and pagination
- Worker status and control (pause/resume)
- Auto-refresh every 2 seconds

![Dashboard Screenshot](dashboard-screenshot.png)

## Examples

See the `examples/` directory:

- `basic.ts` - Simple job processing
- `advanced.ts` - Priority, delays, retries
- `with-dashboard.ts` - Dashboard monitoring

Run examples:

```bash
npx tsx examples/basic.ts
npx tsx examples/with-dashboard.ts
```

## Benchmarks

Run performance benchmarks:

```bash
# In-memory (fastest, for testing)
npm run bench

# File-based (realistic, persistent)
npm run bench -- --file
```

### Results Comparison

| Benchmark | In-Memory | File-based |
|-----------|-----------|------------|
| Sequential Insert | 27,000/s | 13,000/s |
| Parallel Insert | 23,000/s | 12,000/s |
| Process (concurrency=1) | 1,100/s | 1,100/s |
| Process (concurrency=4) | 4,800/s | 4,800/s |
| Process (concurrency=8) | 10,000/s | 8,300/s |
| Process (concurrency=16) | 18,000/s | 5,700/s |
| Mixed Insert+Process | 7,500/s | 3,500/s |
| Claim + Process Batch | 23,600/s | 11,800/s |

**Note**: File-based performance degrades at high concurrency due to disk I/O. For file-based databases, `concurrency=8` is often optimal. Performance varies by hardware.

## CLI

Workmatic includes a command-line tool for managing jobs directly from the database file.

```bash
# Show job statistics
npx workmatic stats ./jobs.db

# List queues with pause status
npx workmatic queues ./jobs.db

# Pause/resume a queue (workers stop/start claiming new jobs)
npx workmatic pause ./jobs.db emails
npx workmatic resume ./jobs.db emails

# List jobs (with filters)
npx workmatic list ./jobs.db --status=dead --limit=10

# Export jobs to CSV
npx workmatic export ./jobs.db backup.csv
npx workmatic export ./jobs.db --status=failed > failed.csv

# Import jobs from CSV
npx workmatic import ./jobs.db backup.csv

# Delete jobs by status
npx workmatic purge ./jobs.db --status=done

# Retry dead/failed jobs (reset to ready)
npx workmatic retry ./jobs.db --status=dead
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `stats <db>` | Show job counts by status and queue |
| `queues <db>` | List all queues with pause status |
| `pause <db> <queue>` | Pause a queue (workers stop claiming) |
| `resume <db> <queue>` | Resume a paused queue |
| `list <db>` | List jobs with optional filters |
| `export <db> [file]` | Export jobs to CSV (stdout if no file) |
| `import <db> <file>` | Import jobs from CSV |
| `purge <db> --status=X` | Delete jobs with specific status |
| `retry <db> --status=X` | Reset jobs to ready status |

### CLI Options

| Option | Description |
|--------|-------------|
| `--status=<status>` | Filter by status (ready/running/done/failed/dead) |
| `--queue=<queue>` | Filter by queue name |
| `--limit=<n>` | Limit results (default: 100) |

### Live Pause/Resume

The `pause` and `resume` commands work on running workers in real-time. When you pause a queue:
- Running workers immediately stop claiming new jobs
- Jobs currently being processed will complete
- The queue resumes when you run `resume`

This allows you to manage workers without restarting your application.

### CSV Import for AI Workflows

The CSV import feature makes Workmatic particularly useful for AI-powered automation:

```csv
public_id,queue,payload,status,priority,run_at,attempts,max_attempts,lease_until,created_at,updated_at,last_error
job_001,emails,"{""to"":""user@example.com"",""template"":""welcome""}",ready,0,1704067200000,0,3,0,1704067200000,1704067200000,
job_002,emails,"{""to"":""other@example.com"",""template"":""reminder""}",ready,5,1704067200000,0,3,0,1704067200000,1704067200000,
```

**Use cases:**

- **AI Agents**: Tools like Claude, GPT, or custom agents can generate CSV files with batch jobs. Simply ask an AI to "create 100 email jobs for these users" and import the result.
- **Spreadsheet workflows**: Edit jobs in Excel/Google Sheets, export to CSV, and import into the queue.
- **Migration**: Move jobs between environments or recover from backups.
- **Testing**: Generate test datasets with specific job configurations.
- **Bulk operations**: Create thousands of jobs without writing code.

```bash
# AI generates jobs.csv, then:
npx workmatic import ./jobs.db jobs.csv

# Or pipe directly from another tool:
cat ai-generated-jobs.csv | npx workmatic import ./jobs.db /dev/stdin
```

The simple CSV format means any tool that can output text can create jobs for your queue.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        Your App                          │
├────────────────────┬─────────────────────────────────────┤
│      Client        │              Worker                 │
│  ┌─────────────┐   │   ┌─────────────┐  ┌─────────────┐  │
│  │   add()     │   │   │   pump()    │  │   fastq     │  │
│  │   stats()   │   │   │   claim()   │  │   pool      │  │
│  └─────────────┘   │   └─────────────┘  └─────────────┘  │
├────────────────────┴─────────────────────────────────────┤
│                    Kysely (Query Builder)                │
├──────────────────────────────────────────────────────────┤
│                  better-sqlite3 (SQLite)                 │
├──────────────────────────────────────────────────────────┤
│                      jobs.db (File)                      │
└──────────────────────────────────────────────────────────┘
```

## License

MIT
