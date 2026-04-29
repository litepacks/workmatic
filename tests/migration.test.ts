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
});
