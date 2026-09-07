import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { WorkmaticDatabase, WorkmaticDb, DatabaseOptions } from './types.js';

/** Maps Kysely instances created via {@link createDatabase} to the underlying driver DB. */
const kyselyToSqlite = new WeakMap<WorkmaticDb, Database.Database>();

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
  sqliteDb.pragma('cache_size = -64000');
  sqliteDb.pragma('temp_store = MEMORY');
  sqliteDb.pragma('mmap_size = 268435456');

  // Enable prepared statement cache
  const cacheSize = options.statementCacheSize ?? 1000;
  enableStatementCache(sqliteDb, cacheSize);

  // Create Kysely instance
  const db = new Kysely<WorkmaticDatabase>({
    dialect: new SqliteDialect({
      database: sqliteDb,
    }),
  });

  // Create schema synchronously using better-sqlite3 directly
  createSchema(sqliteDb);

  kyselyToSqlite.set(db, sqliteDb);

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

  // Create composite partial index for efficient job claiming
  // Only indexes active ready jobs, preventing unbounded index growth from done/dead jobs
  ensurePartialIndex(
    db,
    'idx_workmatic_jobs_claim',
    `CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_claim 
     ON workmatic_jobs (queue, status, run_at, priority, id)
     WHERE status = 'ready'`
  );

  // Create partial index for lease expiration checking
  // Only indexes running jobs with active leases
  ensurePartialIndex(
    db,
    'idx_workmatic_jobs_lease',
    `CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_lease 
     ON workmatic_jobs (status, lease_until)
     WHERE status = 'running'`
  );

  // Composite covering index for queue-level stats queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workmatic_jobs_queue_status 
    ON workmatic_jobs (queue, status)
  `);

  // Create settings table for queue-level settings (pause state, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workmatic_settings (
      queue TEXT PRIMARY KEY,
      paused INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);

  // Legacy status no longer used in the state machine (retries use `ready`, terminal errors use `dead`)
  db.exec(`
    UPDATE workmatic_jobs SET status = 'dead' WHERE status = 'failed'
  `);
}

/**
 * Create or upgrade an index to a partial index
 */
function ensurePartialIndex(db: Database.Database, indexName: string, createSql: string): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
    )
    .get(indexName) as { sql?: string } | undefined;

  if (row?.sql && !row.sql.toUpperCase().includes('WHERE')) {
    db.exec(`DROP INDEX IF EXISTS ${indexName}`);
  }

  db.exec(createSql);
}

/**
 * Get the underlying better-sqlite3 database instance from a Kysely instance
 * created with {@link createDatabase}. For manually constructed `Kysely` instances,
 * falls back to reading the dialect adapter (may break across Kysely versions).
 */
export function getUnderlyingDb(db: WorkmaticDb): Database.Database {
  const mapped = kyselyToSqlite.get(db);
  if (mapped) {
    return mapped;
  }
  try {
    const ex = (db as unknown as { getExecutor?: () => { adapter: { db: Database.Database } } })
      .getExecutor?.();
    const dialect = ex?.adapter?.db;
    if (dialect) {
      return dialect;
    }
  } catch {
    /* ignore */
  }
  throw new Error(
    'getUnderlyingDb: could not resolve better-sqlite3 instance (use createDatabase() or pass db from it)'
  );
}

/**
 * Enable prepared statement caching on a better-sqlite3 database instance.
 * Reuses compiled statements across queries, bypassing SQLite SQL parsing
 * and bytecode recompilation on repeated queries.
 *
 * @param db - better-sqlite3 database instance
 * @param maxStatements - Maximum cached statements (default: 1000). Set <= 0 to disable.
 */
export function enableStatementCache(
  db: Database.Database,
  maxStatements = 1000
): Database.Database {
  if (maxStatements <= 0) {
    return db;
  }

  const originalPrepare = db.prepare.bind(db);
  const cache = new Map<string, Database.Statement>();

  db.prepare = function (sql: string) {
    const cached = cache.get(sql);
    if (cached) {
      cache.delete(sql);
      cache.set(sql, cached);
      if (!cached.busy) {
        return cached;
      }
      return originalPrepare(sql);
    }

    const stmt = originalPrepare(sql);
    if (cache.size >= maxStatements) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey!);
    }
    cache.set(sql, stmt);
    return stmt;
  } as typeof db.prepare;

  const originalClose = db.close.bind(db);
  db.close = function () {
    cache.clear();
    return originalClose();
  };

  return db;
}

