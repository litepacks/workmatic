---
title: Web Dashboard
description: Real-time web dashboard and Express/Connect middleware for queue monitoring, job inspection, and worker controls
order: 7
---

# Web Dashboard 📊

:::lead
Monitor queue health, inspect payloads, view stack traces for failed jobs, and pause/resume workers in real time with the embedded Workmatic Web Dashboard.
:::

## 🌟 Features

- 🖥️ **Embedded & Zero Build**: Pre-packaged HTML, CSS, and JS. No Webpack, Vite, or frontend build tool required at runtime.
- 🔌 **Standalone or Middleware**: Run as a dedicated HTTP server on its own port or mount directly into an existing Express, Connect, or Fastify app.
- 📈 **Real-Time Queue Metrics**: Live counts of `ready`, `running`, `done`, and `dead` jobs across all queues.
- 🔍 **Job Detail Inspector**: Inspect JSON payloads, execution attempts, creation/update timestamps, and error stack traces.
- ⏯️ **Interactive Worker Controls**: Pause or resume worker polling directly from the web interface.

---

## 🚀 Standalone Dashboard Server

To run the dashboard as a standalone HTTP process:

```typescript
import { createDatabase, createWorker, createDashboard } from 'workmatic';

const db = createDatabase({ filename: './jobs.db' });
const worker = createWorker({ db, queue: 'emails', concurrency: 4 });

// Launch dashboard on port 3000
const dashboard = createDashboard({
  db,
  port: 3000,
  workers: [worker], // Link workers to enable pause/resume controls
});

console.log(`Workmatic Dashboard live at http://localhost:${dashboard.port}`);

// Later, during shutdown:
await dashboard.close();
```

### Options (`DashboardOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `db` | `WorkmaticDb` | **Required** | The SQLite database handle. |
| `port` | `number` | `3000` | HTTP port for the dashboard server. |
| `workers` | `WorkmaticWorker[]` | `[]` | Array of workers to bind for pause/resume controls. |

---

## 🚏 Express / Connect Middleware

If your application already runs an Express server, you can mount Workmatic Dashboard under any route prefix without opening an additional port:

```typescript
import express from 'express';
import { createDatabase, createWorker, createDashboardMiddleware } from 'workmatic';

const app = express();
const db = createDatabase({ filename: './jobs.db' });
const worker = createWorker({ db, queue: 'default' });

// Mount dashboard under /admin/queues
app.use(createDashboardMiddleware({
  db,
  basePath: '/admin/queues',
  workers: [worker],
}));

app.listen(8080, () => {
  console.log('App running on http://localhost:8080');
  console.log('Dashboard available at http://localhost:8080/admin/queues');
});
```

---

## 📡 REST API Reference

The dashboard exposes lightweight JSON endpoints under its base path:

### `GET /api/stats`
Returns aggregated counts by status and a list of active workers.
```json
{
  "stats": {
    "ready": 12,
    "running": 3,
    "done": 8420,
    "dead": 2,
    "total": 8437
  },
  "queues": ["emails", "reports"],
  "workers": [
    { "queue": "emails", "running": true, "paused": false }
  ]
}
```

### `GET /api/jobs`
List jobs with optional filtering and pagination:
- `?queue=emails`
- `?status=dead`
- `?limit=50` (max 100)
- `?offset=0`

### `GET /api/jobs/:id`
Fetch a specific job by its public nanoid ID:
```json
{
  "id": "V1StGXR8_Z5jdHi6B-myT",
  "queue": "emails",
  "payload": { "to": "alice@example.com" },
  "status": "dead",
  "attempts": 3,
  "maxAttempts": 3,
  "lastError": "Connection reset by peer"
}
```

### `POST /api/workers/:queue/pause`
Pauses worker polling for the specified queue.

### `POST /api/workers/:queue/resume`
Resumes worker polling for the specified queue.
