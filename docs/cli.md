---
title: CLI Reference
description: Command-line interface for managing Workmatic SQLite queues, dead jobs, CSV import/export, and pause controls
order: 9
---

# CLI Reference 💻

:::lead
Manage your Workmatic SQLite queues directly from your terminal or shell scripts without writing any TypeScript code.
:::

## 🚀 Usage

You can run the CLI via `npx` or add it to your project's npm scripts:

```bash
# Using npx
npx workmatic <command> <db-path> [options]

# Or if installed globally or in node_modules/.bin
workmatic <command> <db-path> [options]
```

---

## 📋 Commands

### 1. `stats`
Displays job counts grouped by status in an ASCII table:
```bash
npx workmatic stats ./jobs.db
```
Filter by a specific queue:
```bash
npx workmatic stats ./jobs.db --queue=emails
```

---

### 2. `queues`
Lists all queues detected in the SQLite database, indicating whether each queue is currently running or paused:
```bash
npx workmatic queues ./jobs.db
```

---

### 3. `list`
Prints recent jobs with details including ID, queue, status, attempts, and error message:
```bash
# List last 20 jobs
npx workmatic list ./jobs.db --limit=20

# Filter by dead jobs
npx workmatic list ./jobs.db --status=dead

# Filter by queue and status
npx workmatic list ./jobs.db --queue=reports --status=running
```

---

### 4. `retry`
Resets failed/dead jobs back to `ready` status with `attempts = 0` and `last_error = null`:
```bash
# Retry all dead jobs in the database
npx workmatic retry ./jobs.db

# Retry dead jobs only in the 'emails' queue
npx workmatic retry ./jobs.db --queue=emails
```

---

### 5. `pause` and `resume`
Dynamically pauses or resumes workers claiming from a specific queue. The setting is persisted in the SQLite `workmatic_settings` table, so running workers pick it up within milliseconds:
```bash
# Pause queue
npx workmatic pause ./jobs.db emails

# Resume queue
npx workmatic resume ./jobs.db emails
```

---

### 6. `transfer`
Bulk transfers jobs from one queue to another:
```bash
# Transfer ready jobs from 'staging' to 'production'
npx workmatic transfer ./jobs.db staging production --status=ready

# Transfer dead jobs to a review queue and reset them for retry
npx workmatic transfer ./jobs.db emails retry-emails --status=dead --retry --limit=500
```

---

### 7. `purge`
Permanently deletes finished or dead jobs to reclaim space:
```bash
# Purge all completed jobs
npx workmatic purge ./jobs.db --status=done

# Purge dead jobs in a specific queue
npx workmatic purge ./jobs.db --queue=webhooks --status=dead
```

---

### 8. `export` and `import` (CSV)
Stream jobs to or from CSV files for backups, audits, or offline analysis:
```bash
# Export all dead jobs to a CSV file
npx workmatic export ./jobs.db ./dead-jobs.csv --status=dead

# Stream export to stdout and pipe to gzip
npx workmatic export ./jobs.db | gzip > backup.csv.gz

# Import jobs from CSV into a database
npx workmatic import ./jobs.db ./incoming-jobs.csv
```

---

### 9. `mcp`
Launches the Model Context Protocol (MCP) stdio server for AI assistants:
```bash
npx workmatic mcp ./jobs.db
```

---

## ⚙️ Summary of CLI Flags

| Flag | Values | Description |
| :--- | :--- | :--- |
| `--status` | `ready`, `running`, `done`, `dead` | Filter jobs by status. Can be comma-separated for transfers. |
| `--queue` | `string` | Target a specific queue name. |
| `--limit` | `number` | Maximum number of rows to return or transfer (default: 100). |
| `--retry` | `boolean` | When transferring dead jobs, resets status to `ready`. |
