import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { createDatabase, createClient } from '../src/index.js';
import {
  parseOptions,
  getPositionalArgs,
  parseCSVLine,
  escapeCSV,
  runCommand,
  cmdStats,
  cmdList,
  cmdPurge,
  cmdRetry,
  cmdPause,
  cmdResume,
  cmdQueues,
  cmdTransfer,
  cmdExport,
  cmdImport,
} from '../src/cli/handlers.js';

describe('CLI helpers', () => {
  it('parseOptions and getPositionalArgs', () => {
    const args = ['./db', '--status=dead', '--limit=5'];
    expect(parseOptions(args)).toEqual({ status: 'dead', limit: '5' });
    expect(getPositionalArgs(args)).toEqual(['./db']);
  });

  it('parseCSVLine and escapeCSV', () => {
    expect(parseCSVLine('a,"b""c",d')).toEqual(['a', 'b"c', 'd']);
    expect(parseCSVLine('plain')).toEqual(['plain']);
    expect(parseCSVLine('"only"')).toEqual(['only']);
    expect(escapeCSV('hello')).toBe('hello');
    expect(escapeCSV('a,b')).toBe('"a,b"');
    expect(escapeCSV('has"quote')).toBe('"has""quote"');
    expect(escapeCSV(null)).toBe('');
  });

  it('parseOptions treats bare flags as true', () => {
    expect(parseOptions(['--retry'])).toEqual({ retry: 'true' });
  });
});

describe('CLI commands', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workmatic-cli-'));
    dbPath = join(dir, 'test.db');
    const db = createDatabase({ filename: dbPath });
    const client = createClient({ db, queue: 'emails' });
    await client.add({ n: 1 });
    await client.add({ n: 2 }, { priority: 1 });
    await db.destroy();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cmdStats on empty database', async () => {
    const emptyPath = join(dir, 'only-stats.db');
    const d = createDatabase({ filename: emptyPath });
    await d.destroy();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdStats(emptyPath);
    log.mockRestore();
  });

  it('cmdStats prints without error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdStats(dbPath);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('cmdList and cmdQueues', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdList(dbPath, { limit: '10' });
    await cmdQueues(dbPath);
    log.mockRestore();
  });

  it('cmdPause and cmdResume', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdPause(dbPath, 'emails');
    await cmdResume(dbPath, 'emails');
    log.mockRestore();

    const sqlite = new Database(dbPath, { readonly: true });
    const row = sqlite
      .prepare('SELECT paused FROM workmatic_settings WHERE queue = ?')
      .get('emails') as { paused: number };
    sqlite.close();
    expect(row.paused).toBe(0);
  });

  it('cmdRetry resets dead jobs', async () => {
    const db = createDatabase({ filename: dbPath });
    const client = createClient({ db });
    const { id } = await client.add({ x: 1 }, { maxAttempts: 1 });
    await db
      .updateTable('workmatic_jobs')
      .set({ status: 'dead' })
      .where('public_id', '=', id)
      .execute();
    await db.destroy();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdRetry(dbPath, { status: 'dead' });
    log.mockRestore();

    const sqlite = new Database(dbPath, { readonly: true });
    const ready = sqlite
      .prepare("SELECT COUNT(*) as c FROM workmatic_jobs WHERE status = 'ready'")
      .get() as { c: number };
    sqlite.close();
    expect(ready.c).toBeGreaterThanOrEqual(1);
  });

  it('cmdPurge deletes by status', async () => {
    const sqlite = new Database(dbPath);
    sqlite.prepare("UPDATE workmatic_jobs SET status = 'done'").run();
    sqlite.close();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdPurge(dbPath, { status: 'done' });
    log.mockRestore();

    const ro = new Database(dbPath, { readonly: true });
    const done = ro
      .prepare("SELECT COUNT(*) as c FROM workmatic_jobs WHERE status = 'done'")
      .get() as { c: number };
    ro.close();
    expect(done.c).toBe(0);
  });

  it('cmdTransfer moves jobs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdTransfer(dbPath, 'emails', 'archive', { status: 'ready' });
    log.mockRestore();

    const sqlite = new Database(dbPath, { readonly: true });
    const archive = sqlite
      .prepare("SELECT COUNT(*) as c FROM workmatic_jobs WHERE queue = 'archive'")
      .get() as { c: number };
    sqlite.close();
    expect(archive.c).toBe(2);
  });

  it('cmdImport skips blank lines', async () => {
    const csvPath = join(dir, 'with-blank.csv');
    const { writeFile } = await import('fs/promises');
    await writeFile(
      csvPath,
      [
        'public_id,queue,payload,status,priority,run_at,attempts,max_attempts,lease_until,created_at,updated_at,last_error',
        'id1,emails,{},ready,0,1,0,3,0,1,1,',
        '',
        'id2,emails,{},ready,0,1,0,3,0,1,1,',
      ].join('\n')
    );
    const outDb = join(dir, 'blank-import.db');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdImport(outDb, csvPath);
    log.mockRestore();
    const sqlite = new Database(outDb, { readonly: true });
    const count = sqlite.prepare('SELECT COUNT(*) as c FROM workmatic_jobs').get() as {
      c: number;
    };
    sqlite.close();
    expect(count.c).toBe(2);
  });

  it('cmdExport and cmdImport roundtrip', async () => {
    const csvPath = join(dir, 'export.csv');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cmdExport(dbPath, csvPath, {});
    err.mockRestore();

    const outDb = join(dir, 'imported.db');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdImport(outDb, csvPath);
    log.mockRestore();

    const sqlite = new Database(outDb, { readonly: true });
    const count = sqlite.prepare('SELECT COUNT(*) as c FROM workmatic_jobs').get() as {
      c: number;
    };
    sqlite.close();
    expect(count.c).toBeGreaterThan(0);
  });

  it('runCommand handles import and errors', async () => {
    await expect(runCommand('import', dbPath, [dbPath], {})).rejects.toThrow(
      'Input CSV file is required'
    );

    await expect(runCommand('purge', dbPath, [dbPath], {})).rejects.toThrow('--status');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCommand('stats', dbPath, [dbPath], {});
    await runCommand('list', dbPath, [dbPath], { limit: '5' });
    await runCommand('export', dbPath, [dbPath], {});
    await runCommand('purge', dbPath, [dbPath], { status: 'done' });
    await runCommand('queues', dbPath, [dbPath], {});
    await runCommand('pause', dbPath, [dbPath, 'emails'], {});
    await runCommand('resume', dbPath, [dbPath, 'emails'], {});
    await runCommand('transfer', dbPath, [dbPath, 'emails', 'moved'], { status: 'ready' });
    await runCommand('retry', dbPath, [dbPath], {});
    log.mockRestore();
  });

  it('cmdExport to stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdExport(dbPath, undefined, {});
    expect(log.mock.calls.some((c) => String(c[0]).includes('public_id'))).toBe(true);
    log.mockRestore();
  });

  it('cmdList with filters shows empty message', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdList(dbPath, { status: 'dead', queue: 'none' });
    expect(log.mock.calls.flat().join(' ')).toContain('No jobs found');
    log.mockRestore();
  });

  it('cmdQueues on empty db', async () => {
    const emptyPath = join(dir, 'empty.db');
    const db = createDatabase({ filename: emptyPath });
    await db.destroy();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdQueues(emptyPath);
    expect(log.mock.calls.flat().join(' ')).toContain('No queues found');
    log.mockRestore();
  });

  it('runCommand transfer requires queue names', async () => {
    await expect(runCommand('transfer', dbPath, [dbPath], {})).rejects.toThrow(
      'Source and target'
    );
  });

  it('cmdExport with status filter', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdExport(dbPath, undefined, { status: 'ready', queue: 'emails' });
    log.mockRestore();
  });

  it('escapeCSV handles newlines', () => {
    expect(escapeCSV('line\nbreak')).toBe('"line\nbreak"');
  });

  it('cmdQueues without settings table uses fallback query', async () => {
    const sqlite = new Database(dbPath);
    sqlite.exec('DROP TABLE IF EXISTS workmatic_settings');
    sqlite.close();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdQueues(dbPath);
    expect(log.mock.calls.flat().join(' ')).toContain('emails');
    log.mockRestore();
  });

  it('cmdQueues shows paused status from settings', async () => {
    const sqlite = new Database(dbPath);
    sqlite
      .prepare(
        `INSERT INTO workmatic_settings (queue, paused, updated_at) VALUES ('emails', 1, ?)`
      )
      .run(Date.now());
    sqlite.close();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdQueues(dbPath);
    const out = log.mock.calls.flat().join(' ');
    expect(out).toContain('PAUSED');
    log.mockRestore();
  });

  it('runCommand resume requires queue', async () => {
    await expect(runCommand('resume', dbPath, [dbPath], {})).rejects.toThrow(
      'Queue name is required'
    );
  });

  it('cmdTransfer with retry flag', async () => {
    const sqlite = new Database(dbPath);
    sqlite.prepare("UPDATE workmatic_jobs SET status = 'dead'").run();
    sqlite.close();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdTransfer(dbPath, 'emails', 'retry-q', { status: 'dead', retry: 'true' });
    log.mockRestore();
    const ro = new Database(dbPath, { readonly: true });
    const row = ro
      .prepare("SELECT status FROM workmatic_jobs WHERE queue = 'retry-q' LIMIT 1")
      .get() as { status: string };
    ro.close();
    expect(row.status).toBe('ready');
  });

  it('runCommand unknown command throws', async () => {
    await expect(
      runCommand('nope' as 'stats', dbPath, [dbPath], {})
    ).rejects.toThrow('Unknown command');
  });
});
