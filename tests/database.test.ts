import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { createDatabase, getUnderlyingDb } from '../src/database.js';
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
});
