---
title: Model Context Protocol (MCP)
description: Connect AI coding assistants (Claude Desktop, Cursor, Antigravity) to Workmatic with 12 tools and 3-layer signaling
order: 8
---

# Model Context Protocol (MCP) 🤖

:::lead
Integrate Workmatic with AI assistants such as Claude Desktop, Cursor, and Antigravity via the official Model Context Protocol (JSON-RPC 2.0 stdio server).
:::

## 🧠 Why MCP for Job Queues?

Autonomous AI coding agents can write code, run tests, and manage servers. With Workmatic's MCP server, your AI assistant can also:
- Monitor live queue statistics without running custom SQL queries.
- Inspect dead jobs and view stack traces when debugging production failures.
- Enqueue test jobs to verify pipeline behaviors.
- Retry failed tasks or transfer jobs between queues.
- Pause and resume queues during deployments or migrations.
- Update job statuses with real-time reactive signals sent directly to active workers.

---

## ⚡ Starting the MCP Server

### 1. Via the Workmatic CLI
The simplest way to start the MCP server is via the built-in CLI:

```bash
npx workmatic mcp --db ./data/jobs.db
```

### 2. Programmatically in Node.js
You can embed the MCP server directly into your application process, linking it to your active workers or orchestrator:

```typescript
import { createDatabase, createOrchestrator, createMcpServer } from 'workmatic';

const db = createDatabase({ filename: './jobs.db' });
const orchestrator = createOrchestrator({ db });

// Register queues and workers...
orchestrator.register('emails', { worker: { concurrency: 4 } });
orchestrator.startAll();

// Start MCP Server on stdio
const mcpServer = createMcpServer({
  db,
  orchestrator, // Linking orchestrator enables instant worker wakeups when jobs are updated/retried!
});

mcpServer.start();
```

---

## 🛠️ The 12 MCP Tools

| Tool Name | Description | Arguments |
| :--- | :--- | :--- |
| `workmatic_list_queues` | Lists all active queues in SQLite along with job counts. | *None* |
| `workmatic_get_stats` | Live breakdown of `ready`, `running`, `done`, `dead`, and `total` jobs. | `queue?: string` |
| `workmatic_list_jobs` | Query jobs with filtering by queue, status, limit, and offset. | `queue?: string`, `status?: 'ready'\|'running'\|'done'\|'dead'`, `limit?: number`, `offset?: number` |
| `workmatic_get_dead_jobs` | Retrieve dead-letter jobs with payload and `last_error` for debugging. | `queue?: string`, `limit?: number` |
| `workmatic_add_job` | Enqueue a new background job. | `queue?: string`, `payload: any`, `priority?: number`, `delayMs?: number`, `maxAttempts?: number` |
| `workmatic_retry_job` | Retry a single dead job by public ID. | `publicId: string` |
| `workmatic_retry_all_dead` | Bulk retry all dead jobs (optionally filtered by queue). | `queue?: string` |
| `workmatic_pause_queue` | Pause worker polling for a queue. | `queue: string` |
| `workmatic_resume_queue` | Resume a paused queue. | `queue: string` |
| `workmatic_purge_jobs` | Permanently delete done or dead jobs. | `queue?: string`, `status?: 'done'\|'dead'\|'all'` |
| `workmatic_transfer_jobs` | Transfer jobs between queues with optional retry reset. | `fromQueue: string`, `toQueue: string`, `status?: 'ready'\|'dead'`, `limit?: number`, `resetForRetry?: boolean` |
| `workmatic_update_job_status` | Update job status (`ready`, `done`, `dead`) and broadcast signals. | `publicId: string`, `status: 'ready'\|'done'\|'dead'`, `error?: string`, `resetAttempts?: boolean`, `delayMs?: number` |

---

## 📡 3-Layer Reactive Signaling

When an AI assistant updates a job status (e.g. marking a dead job back to `ready` or enqueuing a high-priority task), Workmatic dispatches a **3-layer reactive signal**:

1. **Worker Wakeup (`worker.wakeUp()`)**:
   If the job is reset to `'ready'`, linked workers in the process are signaled immediately (~0.03 ms), preventing polling delays.
2. **MCP JSON-RPC Stdio Notification**:
   Broadcasts an asynchronous JSON-RPC notification to the connected AI client:
   ```json
   {
     "jsonrpc": "2.0",
     "method": "notifications/workmatic/job_status_changed",
     "params": {
       "publicId": "job_123",
       "queue": "emails",
       "previousStatus": "dead",
       "status": "ready",
       "timestamp": 1757235000000
     }
   }
   ```
3. **In-Process EventEmitter**:
   Allows your application code to listen for status changes:
   ```typescript
   mcpServer.onJobStatusChanged((event) => {
     console.log(`[MCP Signal] Job ${event.publicId} moved from ${event.previousStatus} to ${event.status}`);
   });
   ```

---

## ⚙️ Connecting to Claude Desktop & Cursor

### Claude Desktop Configuration
Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "workmatic": {
      "command": "npx",
      "args": [
        "-y",
        "workmatic",
        "mcp",
        "--db",
        "/absolute/path/to/your/project/jobs.db"
      ]
    }
  }
}
```

### Cursor Configuration
Add to your `.cursor/mcp.json` or Global Cursor Settings:

```json
{
  "mcpServers": {
    "workmatic": {
      "command": "node",
      "args": [
        "./node_modules/workmatic/dist/cli.js",
        "mcp",
        "--db",
        "./jobs.db"
      ]
    }
  }
}
```
