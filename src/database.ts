import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { WorkmaticDatabase, WorkmaticDb, DatabaseOptions } from './types.js';

/**
 * Create and initialize the workmatic database
 * 
 * @param options - Database options
 * @returns Kysely database instance
 * 
 * @example
 * ```ts
 * // Using a file path
 * const db = createDatabase({ filename: './jobs.db' });
 * 
 * // Using an existing better-sqlite3 instance
 * import Database from 'better-sqlite3';
 * const sqlite = new Database('./jobs.db');
 * const db = createDatabase({ db: sqlite });
 * 
 * // In-memory database (for testing)
 * const db = createDatabase({ filename: ':memory:' });
 * ```
 */
export function createDatabase(options: DatabaseOptions = {}): WorkmaticDb {
  let sqliteDb: Database.Database;

  if (options.db) {
    sqliteDb = options.db;
  } else {
    const filename = options.filename ?? ':memory:';
    sqliteDb = new Database(filename);
  }

  // Set pragmas for performance and safety
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('synchronous = NORMAL');
  sqliteDb.pragma('busy_timeout = 5000');

  // Create Kysely instance
  const db = new Kysely<WorkmaticDatabase>({
    dialect: new SqliteDialect({
      database: sqliteDb,
    }),
  });

  // Create schema synchronously using better-sqlite3 directly
  createSchema(sqliteDb);

  return db;
}

/**
 * Create the database schema if it doesn't exist
 */
function createSchema(db: Database.Database): void {
  // Create the jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS workmatic_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT UNIQUE NOT NULL,
      queue TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      priority INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      lease_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_error TEXT
    )
  `);

  // Create composite index for efficient job claiming
  // (queue, status, run_at, priority, id)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_claim 
    ON workmatic_jobs (queue, status, run_at, priority, id)
  `);

  // Create index for lease expiration checking
  // (status, lease_until)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_lease 
    ON workmatic_jobs (status, lease_until)
  `);

  // Create settings table for queue-level settings (pause state, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workmatic_settings (
      queue TEXT PRIMARY KEY,
      paused INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Get the underlying better-sqlite3 database instance from a Kysely instance
 * This is useful for advanced operations or testing
 */
export function getUnderlyingDb(db: WorkmaticDb): Database.Database {
  // Access the internal database through the dialect
  // This is a bit hacky but necessary for some operations
  const dialect = (db as any).getExecutor().adapter.db;
  return dialect;
}
