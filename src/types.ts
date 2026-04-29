import type { Kysely, Generated, ColumnType } from 'kysely';

/**
 * Job status types
 */
export type JobStatus = 'ready' | 'running' | 'done' | 'dead';

/**
 * Database table schema for workmatic_jobs
 */
export interface WorkmaticJobsTable {
  id: Generated<number>;
  public_id: string;
  queue: string;
  payload: string;
  status: JobStatus;
  priority: number;
  run_at: number;
  attempts: number;
  max_attempts: number;
  lease_until: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

/**
 * Database table schema for workmatic_settings
 */
export interface WorkmaticSettingsTable {
  queue: string;
  paused: number;
  updated_at: number;
}

/**
 * Kysely database schema
 */
export interface WorkmaticDatabase {
  workmatic_jobs: WorkmaticJobsTable;
  workmatic_settings: WorkmaticSettingsTable;
}

/**
 * Kysely database instance type
 */
export type WorkmaticDb = Kysely<WorkmaticDatabase>;

/**
 * Job representation returned to users
 */
export interface Job<TPayload = unknown> {
  /** Unique public identifier (nanoid) */
  id: string;
  /** Queue name */
  queue: string;
  /** Job payload */
  payload: TPayload;
  /** Current status */
  status: JobStatus;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Number of attempts made */
  attempts: number;
  /** Maximum allowed attempts */
  maxAttempts: number;
  /** When the job was created (unix ms) */
  createdAt: number;
  /** Last error from a previous attempt (e.g. before retry) */
  lastError: string | null;
}

/**
 * Options for adding a job
 */
export interface AddJobOptions {
  /** Job priority (lower = higher priority). Default: 0 */
  priority?: number;
  /** Delay before job becomes available (ms). Default: 0 */
  delayMs?: number;
  /** Maximum retry attempts. Default: 3 */
  maxAttempts?: number;
}

/**
 * Result of adding a job
 */
export interface AddJobResult {
  ok: true;
  id: string;
}

/**
 * Result of adding multiple jobs in one transaction
 */
export interface AddManyResult {
  ok: true;
  ids: string[];
}

/**
 * Options for creating a database
 */
export interface DatabaseOptions {
  /** Existing better-sqlite3 Database instance */
  db?: import('better-sqlite3').Database;
  /** Path to SQLite database file (ignored if db is provided) */
  filename?: string;
}

/**
 * Options for creating a client
 */
export interface ClientOptions {
  /** Kysely database instance */
  db: WorkmaticDb;
  /** Queue name. Default: 'default' */
  queue?: string;
}

/**
 * Backoff function type
 */
export type BackoffFunction = (attempts: number) => number;

/**
 * Worker state for persistence
 */
export type WorkerState = 'stopped' | 'running' | 'paused';

/**
 * Options for creating a worker
 */
export interface WorkerOptions {
  /** Kysely database instance */
  db: WorkmaticDb;
  /** Queue name. Default: 'default' */
  queue?: string;
  /** Number of concurrent job processors. Default: 1 */
  concurrency?: number;
  /** Lease duration in ms. Default: 30000 */
  leaseMs?: number;
  /** Poll interval in ms when no jobs available. Default: 1000 */
  pollMs?: number;
  /** Job execution timeout in ms. Default: undefined (no timeout) */
  timeoutMs?: number;
  /** Backoff function for retries. Default: exponential */
  backoff?: BackoffFunction;
  /** Persist worker state to database. Default: false */
  persistState?: boolean;
  /** Auto-restore worker state on creation. Default: true (only applies if persistState is true) */
  autoRestore?: boolean;
  /**
   * Minimum interval between database pause checks (CLI `pause`). Reduces round-trips while pumping.
   * Default: 300 ms
   */
  pauseCheckIntervalMs?: number;
  /**
   * Minimum interval between lease requeue scans. Default: every pump (0).
   * Set to e.g. 1000 to run expired-lease recovery at most once per second.
   */
  requeueExpiredIntervalMs?: number;
  /** Called when the pump loop catches an error (after optional default logging) */
  onPumpError?: (error: unknown) => void;
}

/**
 * Job processor function type
 */
export type JobProcessor<TPayload = unknown> = (job: Job<TPayload>) => Promise<void>;

/**
 * Stats by status
 */
export interface JobStats {
  ready: number;
  running: number;
  done: number;
  dead: number;
  total: number;
}

/**
 * Client interface
 */
export interface WorkmaticClient {
  /** Add a job to the queue */
  add<TPayload = unknown>(payload: TPayload, options?: AddJobOptions): Promise<AddJobResult>;
  /**
   * Add many jobs in a single transaction (shared priority, delay, maxAttempts).
   * Faster than repeated `add()` when inserting large batches.
   */
  addMany<TPayload = unknown>(
    payloads: TPayload[],
    options?: AddJobOptions
  ): Promise<AddManyResult>;
  /** Get job statistics */
  stats(): Promise<JobStats>;
  /** Clear all jobs from the queue */
  clear(options?: { status?: JobStatus }): Promise<number>;
}

/**
 * Worker interface
 */
export interface WorkmaticWorker {
  /** Set the job processor function */
  process<TPayload = unknown>(fn: JobProcessor<TPayload>): void;
  /** Start processing jobs */
  start(): void;
  /** Stop processing jobs (drains current jobs) */
  stop(): Promise<void>;
  /** Pause processing (stops claiming new jobs) */
  pause(): void;
  /** Resume processing */
  resume(): void;
  /** Get job statistics */
  stats(): Promise<JobStats>;
  /** Restore worker state from database (only when persistState is true) */
  restoreState(): Promise<WorkerState | null>;
  /** Clear all jobs from the queue */
  clear(options?: { status?: JobStatus }): Promise<number>;
  /** Check if worker is running */
  readonly isRunning: boolean;
  /** Check if worker is paused */
  readonly isPaused: boolean;
  /** Queue name */
  readonly queue: string;
}

/**
 * Options for creating a dashboard
 */
export interface DashboardOptions {
  /** Kysely database instance */
  db: WorkmaticDb;
  /** HTTP server port. Default: 3000 */
  port?: number;
  /** Worker instances to control */
  workers?: WorkmaticWorker[];
}

/**
 * Options for creating dashboard middleware
 */
export interface DashboardMiddlewareOptions {
  /** Kysely database instance */
  db: WorkmaticDb;
  /** Worker instances to control */
  workers?: WorkmaticWorker[];
  /** Base path for mounting (e.g., '/workmatic'). Default: '' */
  basePath?: string;
}

/**
 * Express-compatible request handler
 */
export type DashboardMiddleware = (
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  next?: () => void
) => void;

/**
 * Dashboard interface
 */
export interface WorkmaticDashboard {
  /** Close the dashboard server */
  close(): Promise<void>;
  /** Server port */
  readonly port: number;
}

/**
 * Internal job representation from database
 */
export interface ClaimedJob {
  id: number;
  public_id: string;
  queue: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  priority: number;
  created_at: number;
  last_error: string | null;
}
