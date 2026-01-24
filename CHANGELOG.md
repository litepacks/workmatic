# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5] - 2026-01-24

### Added

- **Clear Jobs Method**: Added `clear()` method to both `WorkmaticClient` and `WorkmaticWorker`
  - Clear all jobs from a queue: `await client.clear()`
  - Clear jobs by status: `await worker.clear({ status: 'dead' })`

## [1.0.4] - 2026-01-22

### Added

- **Persist State Mode**: Workers can now optionally persist their state (running/paused/stopped) to the database
  - New `persistState` option in `createWorker()`
  - New `autoRestore` option to automatically restore state on creation
  - New `worker.restoreState()` method for manual state restoration

## [1.0.3] - 2026-01-22

### Added

- **CLI Table Display**: Improved CLI output with `cli-table3` for better readability
  - `stats`, `list`, and `queues` commands now display formatted tables

### Changed

- CLI now gracefully handles missing `workmatic_settings` table

## [1.0.2] - 2026-01-22

### Added

- **CommonJS Support**: Package now supports both ESM and CJS via `tsup`
  - Added `require` export for CJS consumers
  - Added `.cjs` and `.d.cts` files to dist

### Changed

- Build system switched from `tsc` to `tsup` for dual format output

## [1.0.1] - 2026-01-20

### Added

- GitHub repository information in `package.json`

## [1.0.0] - 2026-01-20

### Added

- **Core Queue System**
  - `createDatabase()` - Initialize SQLite database with schema
  - `createClient()` - Add jobs to queues with priority, delay, and retry options
  - `createWorker()` - Process jobs with configurable concurrency

- **Job Features**
  - Priority-based processing (lower number = higher priority)
  - Delayed/scheduled jobs with `delayMs` option
  - Automatic retries with exponential backoff
  - Job timeout support with `timeoutMs` option
  - Lease-based locking to prevent double processing

- **Worker Controls**
  - `start()` / `stop()` - Start and gracefully stop workers
  - `pause()` / `resume()` - Pause and resume job claiming
  - `stats()` - Get queue statistics

- **Dashboard**
  - `createDashboard()` - Standalone HTTP server for monitoring
  - `createDashboardMiddleware()` - Express-compatible middleware
  - Real-time job statistics and queue overview
  - Worker pause/resume controls from UI

- **CLI Tool**
  - `workmatic stats` - Show job statistics
  - `workmatic list` - List jobs with filters
  - `workmatic queues` - List all queues with status
  - `workmatic export` - Export jobs to CSV
  - `workmatic import` - Import jobs from CSV
  - `workmatic purge` - Delete jobs by status
  - `workmatic retry` - Retry dead/failed jobs
  - `workmatic pause` - Pause a queue (affects running workers)
  - `workmatic resume` - Resume a paused queue

- **Type Safety**
  - Full TypeScript support
  - Kysely for type-safe SQL queries
  - Exported types for all options and interfaces

### Dependencies

- `better-sqlite3` - Synchronous SQLite driver
- `fastq` - High-performance concurrent queue
- `kysely` - Type-safe SQL query builder
- `nanoid` - Unique ID generation
- `cli-table3` - CLI table formatting

[1.0.5]: https://github.com/litepacks/workmatic/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/litepacks/workmatic/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/litepacks/workmatic/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/litepacks/workmatic/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/litepacks/workmatic/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/litepacks/workmatic/releases/tag/v1.0.0
