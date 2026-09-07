import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, createClient, getUnderlyingDb } from '../src/index.js';
import type { WorkmaticDb } from '../src/types.js';

describe('schema migration', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wm-mig-'));
    dbPath = join(dir, 'jobs.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps legacy failed rows to dead on database open', async () => {
    let db: WorkmaticDb = createDatabase({ filename: dbPath });
    const client = createClient({ db });
    const { id } = await client.add({ n: 1 });
    const sqlite = getUnderlyingDb(db);
    sqlite.prepare('UPDATE workmatic_jobs SET status = ? WHERE public_id = ?').run('failed', id);
    await db.destroy();

    db = createDatabase({ filename: dbPath });
    const row = await db
      .selectFrom('workmatic_jobs')
      .select(['status'])
      .where('public_id', '=', id)
      .executeTakeFirst();
    expect(row?.status).toBe('dead');
    await db.destroy();
  });

  it('upgrades legacy non-partial indexes to partial indexes', async () => {
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE workmatic_jobs (
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
      );
      CREATE INDEX idx_workmatic_jobs_claim ON workmatic_jobs (queue, status, run_at, priority, id);
      CREATE INDEX idx_workmatic_jobs_lease ON workmatic_jobs (status, lease_until);
    `);
    sqlite.close();

    const db = createDatabase({ filename: dbPath });
    const underlying = getUnderlyingDb(db);
    const claimRow = underlying
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_workmatic_jobs_claim') as { sql: string };
    const leaseRow = underlying
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_workmatic_jobs_lease') as { sql: string };

    expect(claimRow?.sql).toContain("WHERE status = 'ready'");
    expect(leaseRow?.sql).toContain("WHERE status = 'running'");
    await db.destroy();
  });
});
