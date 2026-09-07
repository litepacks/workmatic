import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { createDatabase, getUnderlyingDb, enableStatementCache } from '../src/database.js';
import type { WorkmaticDatabase } from '../src/types.js';

describe('createDatabase', () => {
  it('should accept an existing better-sqlite3 instance', async () => {
    const sqlite = new Database(':memory:');
    const db = createDatabase({ db: sqlite });
    const underlying = getUnderlyingDb(db);
    expect(underlying).toBe(sqlite);
    await db.destroy();
  });

  it('getUnderlyingDb uses getExecutor adapter fallback', () => {
    const sqlite = new Database(':memory:');
    const db = {
      getExecutor: () => ({ adapter: { db: sqlite } }),
    } as unknown as import('../src/types.js').WorkmaticDb;
    expect(getUnderlyingDb(db)).toBe(sqlite);
    sqlite.close();
  });

  it('getUnderlyingDb should throw when getExecutor fails', () => {
    const db = {
      getExecutor: () => {
        throw new Error('no executor');
      },
    } as unknown as import('../src/types.js').WorkmaticDb;
    expect(() => getUnderlyingDb(db)).toThrow('getUnderlyingDb');
  });

  it('getUnderlyingDb should throw for unknown Kysely instance', async () => {
    const sqlite = new Database(':memory:');
    const db = new Kysely<WorkmaticDatabase>({
      dialect: new SqliteDialect({ database: sqlite }),
    });
    expect(() => getUnderlyingDb(db)).toThrow('getUnderlyingDb');
    await db.destroy();
    sqlite.close();
  });

  it('should apply performance pragmas on database', async () => {
    const db = createDatabase();
    const underlying = getUnderlyingDb(db);
    expect(underlying.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(underlying.pragma('temp_store', { simple: true })).toBe(2);
    expect(underlying.pragma('cache_size', { simple: true })).toBe(-64000);
    await db.destroy();
  });

  it('should create idx_workmatic_jobs_queue_status index', async () => {
    const db = createDatabase();
    const underlying = getUnderlyingDb(db);
    const row = underlying
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_workmatic_jobs_queue_status'")
      .get() as { sql: string };
    expect(row?.sql).toContain('idx_workmatic_jobs_queue_status');
    await db.destroy();
  });

  describe('enableStatementCache', () => {
    it('returns db unchanged when maxStatements <= 0', () => {
      const sqlite = new Database(':memory:');
      const returned = enableStatementCache(sqlite, 0);
      expect(returned).toBe(sqlite);
      const s1 = sqlite.prepare('SELECT 1');
      const s2 = sqlite.prepare('SELECT 1');
      expect(s1).not.toBe(s2);
      sqlite.close();
    });

    it('caches and reuses prepared statements for identical queries', () => {
      const sqlite = new Database(':memory:');
      enableStatementCache(sqlite, 5);
      const s1 = sqlite.prepare('SELECT 1');
      const s2 = sqlite.prepare('SELECT 1');
      expect(s1).toBe(s2);
      sqlite.close();
    });

    it('bypasses cache when cached statement is busy', () => {
      const sqlite = new Database(':memory:');
      sqlite.exec('CREATE TABLE test (id INT)');
      sqlite.exec('INSERT INTO test VALUES (1), (2)');
      enableStatementCache(sqlite, 5);

      const s1 = sqlite.prepare('SELECT * FROM test');
      const iter = s1.iterate();
      expect(s1.busy).toBe(true);

      // Second prepare of same sql while s1 is busy should return a fresh statement
      const s2 = sqlite.prepare('SELECT * FROM test');
      expect(s2).not.toBe(s1);

      iter.return();
      sqlite.close();
    });

    it('evicts oldest entries when cache exceeds maxStatements', () => {
      const sqlite = new Database(':memory:');
      enableStatementCache(sqlite, 2);

      const s1 = sqlite.prepare('SELECT 1');
      const s2 = sqlite.prepare('SELECT 2');
      // Touch s1 to make s2 the oldest
      sqlite.prepare('SELECT 1');

      // Adding s3 should evict s2
      const s3 = sqlite.prepare('SELECT 3');

      // s1 is still in cache
      expect(sqlite.prepare('SELECT 1')).toBe(s1);
      // s2 was evicted, so preparing it returns a new statement
      expect(sqlite.prepare('SELECT 2')).not.toBe(s2);

      sqlite.close();
    });

    it('clears cache on db.close()', () => {
      const sqlite = new Database(':memory:');
      enableStatementCache(sqlite, 5);
      sqlite.prepare('SELECT 1');
      sqlite.close();
    });
  });
});
