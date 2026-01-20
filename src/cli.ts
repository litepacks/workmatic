#!/usr/bin/env node

/**
 * Workmatic CLI
 * 
 * Commands:
 *   stats <db>                    Show job statistics
 *   export <db> [output]          Export jobs to CSV
 *   import <db> <input>           Import jobs from CSV
 *   purge <db> [--status=done]    Delete jobs by status
 *   retry <db> [--status=dead]    Retry failed/dead jobs
 *   pause <db> <queue>            Pause a queue (workers stop claiming)
 *   resume <db> <queue>           Resume a paused queue
 */

import Database from 'better-sqlite3';
import { createReadStream, createWriteStream } from 'fs';
import { createInterface } from 'readline';
import Table from 'cli-table3';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  console.log(`
Workmatic CLI - Job Queue Management

Usage:
  workmatic <command> [options]

Commands:
  stats <db>                     Show job statistics
  queues <db>                    List all queues with status
  list <db> [--status=<status>]  List jobs (optionally filter by status)
  export <db> [output.csv]       Export jobs to CSV (default: stdout)
  import <db> <input.csv>        Import jobs from CSV
  purge <db> --status=<status>   Delete jobs by status
  retry <db> [--status=dead]     Retry dead/failed jobs (reset to ready)
  pause <db> <queue>             Pause a queue (running workers stop claiming)
  resume <db> <queue>            Resume a paused queue

Options:
  --status=<status>   Filter by status (ready|running|done|failed|dead)
  --queue=<queue>     Filter by queue name
  --limit=<n>         Limit number of results (default: 100)

Examples:
  workmatic stats ./jobs.db
  workmatic list ./jobs.db --status=dead --limit=10
  workmatic export ./jobs.db backup.csv
  workmatic export ./jobs.db --status=failed > failed-jobs.csv
  workmatic import ./jobs.db backup.csv
  workmatic purge ./jobs.db --status=done
  workmatic retry ./jobs.db --status=dead
  workmatic pause ./jobs.db emails
  workmatic resume ./jobs.db emails
`);
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      options[key] = value ?? 'true';
    }
  }
  return options;
}

function getPositionalArgs(args: string[]): string[] {
  return args.filter(arg => !arg.startsWith('--'));
}

// CSV helpers
function escapeCSV(value: string | null): string {
  if (value === null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  
  result.push(current);
  return result;
}

// Commands
async function cmdStats(dbPath: string): Promise<void> {
  const db = new Database(dbPath, { readonly: true });
  
  try {
    const stats = db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM workmatic_jobs 
      GROUP BY status
    `).all() as { status: string; count: number }[];
    
    const queues = db.prepare(`
      SELECT queue, COUNT(*) as count 
      FROM workmatic_jobs 
      GROUP BY queue
    `).all() as { queue: string; count: number }[];
    
    const total = stats.reduce((sum, s) => sum + s.count, 0);
    
    console.log('\n📊 Job Statistics\n');
    
    const statusOrder = ['ready', 'running', 'done', 'failed', 'dead'];
    const statusEmoji: Record<string, string> = {
      ready: '⏳',
      running: '▶️',
      done: '✅',
      failed: '⚠️',
      dead: '💀',
    };
    
    const statusTable = new Table({
      head: ['', 'Status', 'Count'],
      style: { head: ['cyan'], border: ['gray'] },
      colAligns: ['left', 'left', 'right'],
    });
    
    for (const status of statusOrder) {
      const stat = stats.find(s => s.status === status);
      const count = stat?.count ?? 0;
      const emoji = statusEmoji[status] || '';
      statusTable.push([emoji, status, count.toLocaleString()]);
    }
    statusTable.push([{ colSpan: 2, content: 'Total', hAlign: 'right' }, total.toLocaleString()]);
    
    console.log(statusTable.toString());
    
    if (queues.length > 0) {
      console.log('\n📋 By Queue\n');
      
      const queueTable = new Table({
        head: ['Queue', 'Jobs'],
        style: { head: ['cyan'], border: ['gray'] },
        colAligns: ['left', 'right'],
      });
      
      for (const q of queues) {
        queueTable.push([q.queue, q.count.toLocaleString()]);
      }
      
      console.log(queueTable.toString());
    }
    
    console.log();
  } finally {
    db.close();
  }
}

async function cmdList(dbPath: string, options: Record<string, string>): Promise<void> {
  const db = new Database(dbPath, { readonly: true });
  
  try {
    let query = 'SELECT public_id, queue, status, priority, attempts, max_attempts, created_at, last_error FROM workmatic_jobs WHERE 1=1';
    const params: any[] = [];
    
    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }
    if (options.queue) {
      query += ' AND queue = ?';
      params.push(options.queue);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(options.limit || '100', 10));
    
    const jobs = db.prepare(query).all(...params) as any[];
    
    if (jobs.length === 0) {
      console.log('No jobs found.');
      return;
    }
    
    const statusEmoji: Record<string, string> = {
      ready: '⏳',
      running: '▶️',
      done: '✅',
      failed: '⚠️',
      dead: '💀',
    };
    
    const table = new Table({
      head: ['ID', 'Queue', 'Status', 'Pri', 'Attempts', 'Created'],
      style: { head: ['cyan'], border: ['gray'] },
      colAligns: ['left', 'left', 'left', 'right', 'center', 'left'],
      colWidths: [24, 16, 12, 5, 10, 21],
      wordWrap: true,
    });
    
    for (const job of jobs) {
      const emoji = statusEmoji[job.status] || '';
      table.push([
        job.public_id.slice(0, 21),
        job.queue.slice(0, 14),
        `${emoji} ${job.status}`,
        job.priority,
        `${job.attempts}/${job.max_attempts}`,
        new Date(job.created_at).toISOString().slice(0, 19),
      ]);
    }
    
    console.log();
    console.log(table.toString());
    console.log(`\n  Showing ${jobs.length} jobs\n`);
  } finally {
    db.close();
  }
}

async function cmdExport(dbPath: string, outputPath: string | undefined, options: Record<string, string>): Promise<void> {
  const db = new Database(dbPath, { readonly: true });
  
  try {
    let query = 'SELECT * FROM workmatic_jobs WHERE 1=1';
    const params: any[] = [];
    
    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }
    if (options.queue) {
      query += ' AND queue = ?';
      params.push(options.queue);
    }
    
    query += ' ORDER BY id';
    
    const jobs = db.prepare(query).all(...params) as any[];
    
    const output = outputPath ? createWriteStream(outputPath) : process.stdout;
    
    // Header
    const columns = [
      'public_id', 'queue', 'payload', 'status', 'priority',
      'run_at', 'attempts', 'max_attempts', 'lease_until',
      'created_at', 'updated_at', 'last_error'
    ];
    
    if (outputPath) {
      output.write(columns.join(',') + '\n');
    } else {
      console.log(columns.join(','));
    }
    
    // Rows
    for (const job of jobs) {
      const row = columns.map(col => escapeCSV(job[col]));
      if (outputPath) {
        output.write(row.join(',') + '\n');
      } else {
        console.log(row.join(','));
      }
    }
    
    if (outputPath) {
      (output as any).end();
      console.error(`✅ Exported ${jobs.length} jobs to ${outputPath}`);
    }
  } finally {
    db.close();
  }
}

async function cmdImport(dbPath: string, inputPath: string): Promise<void> {
  const db = new Database(dbPath);
  
  // Ensure schema exists
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
  
  const insert = db.prepare(`
    INSERT OR REPLACE INTO workmatic_jobs 
    (public_id, queue, payload, status, priority, run_at, attempts, max_attempts, lease_until, created_at, updated_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const rl = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });
  
  let lineNum = 0;
  let imported = 0;
  let columns: string[] = [];
  
  try {
    const insertMany = db.transaction((rows: any[]) => {
      for (const row of rows) {
        insert.run(
          row.public_id,
          row.queue,
          row.payload,
          row.status,
          parseInt(row.priority, 10) || 0,
          parseInt(row.run_at, 10) || Date.now(),
          parseInt(row.attempts, 10) || 0,
          parseInt(row.max_attempts, 10) || 3,
          parseInt(row.lease_until, 10) || 0,
          parseInt(row.created_at, 10) || Date.now(),
          parseInt(row.updated_at, 10) || Date.now(),
          row.last_error || null
        );
        imported++;
      }
    });
    
    const batch: any[] = [];
    
    for await (const line of rl) {
      lineNum++;
      
      if (lineNum === 1) {
        // Header row
        columns = parseCSVLine(line);
        continue;
      }
      
      if (!line.trim()) continue;
      
      const values = parseCSVLine(line);
      const row: Record<string, string> = {};
      
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]] = values[i] ?? '';
      }
      
      batch.push(row);
      
      // Batch insert every 1000 rows
      if (batch.length >= 1000) {
        insertMany(batch);
        batch.length = 0;
        process.stderr.write(`\rImported ${imported} jobs...`);
      }
    }
    
    // Insert remaining
    if (batch.length > 0) {
      insertMany(batch);
    }
    
    console.log(`\n✅ Imported ${imported} jobs from ${inputPath}`);
  } finally {
    db.close();
  }
}

async function cmdPurge(dbPath: string, options: Record<string, string>): Promise<void> {
  if (!options.status) {
    console.error('Error: --status is required for purge command');
    console.error('Example: workmatic purge ./jobs.db --status=done');
    process.exit(1);
  }
  
  const db = new Database(dbPath);
  
  try {
    const result = db.prepare('DELETE FROM workmatic_jobs WHERE status = ?').run(options.status);
    console.log(`🗑️  Deleted ${result.changes} jobs with status '${options.status}'`);
  } finally {
    db.close();
  }
}

async function cmdRetry(dbPath: string, options: Record<string, string>): Promise<void> {
  const status = options.status || 'dead';
  const db = new Database(dbPath);
  
  try {
    const now = Date.now();
    const result = db.prepare(`
      UPDATE workmatic_jobs 
      SET status = 'ready', 
          attempts = 0, 
          run_at = ?, 
          lease_until = 0,
          updated_at = ?
      WHERE status = ?
    `).run(now, now, status);
    
    console.log(`🔄 Reset ${result.changes} jobs from '${status}' to 'ready'`);
  } finally {
    db.close();
  }
}

async function cmdPause(dbPath: string, queueName: string): Promise<void> {
  const db = new Database(dbPath);
  
  try {
    // Ensure settings table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS workmatic_settings (
        queue TEXT PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    
    const now = Date.now();
    db.prepare(`
      INSERT INTO workmatic_settings (queue, paused, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(queue) DO UPDATE SET paused = 1, updated_at = ?
    `).run(queueName, now, now);
    
    console.log(`⏸️  Paused queue '${queueName}'`);
    console.log(`   Running workers will stop claiming new jobs.`);
  } finally {
    db.close();
  }
}

async function cmdResume(dbPath: string, queueName: string): Promise<void> {
  const db = new Database(dbPath);
  
  try {
    // Ensure settings table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS workmatic_settings (
        queue TEXT PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    
    const now = Date.now();
    db.prepare(`
      INSERT INTO workmatic_settings (queue, paused, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(queue) DO UPDATE SET paused = 0, updated_at = ?
    `).run(queueName, now, now);
    
    console.log(`▶️  Resumed queue '${queueName}'`);
    console.log(`   Workers will start claiming jobs again.`);
  } finally {
    db.close();
  }
}

async function cmdQueues(dbPath: string): Promise<void> {
  const db = new Database(dbPath, { readonly: true });
  
  try {
    // Check if settings table exists
    const settingsExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='workmatic_settings'
    `).get();
    
    // Get all queues with their job counts and pause state
    let queues: { queue: string; total: number; ready: number; running: number; paused: number }[];
    
    if (settingsExists) {
      queues = db.prepare(`
        SELECT 
          j.queue,
          COUNT(*) as total,
          SUM(CASE WHEN j.status = 'ready' THEN 1 ELSE 0 END) as ready,
          SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) as running,
          COALESCE(s.paused, 0) as paused
        FROM workmatic_jobs j
        LEFT JOIN workmatic_settings s ON j.queue = s.queue
        GROUP BY j.queue
      `).all() as typeof queues;
    } else {
      queues = db.prepare(`
        SELECT 
          queue,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
          0 as paused
        FROM workmatic_jobs
        GROUP BY queue
      `).all() as typeof queues;
    }
    
    if (queues.length === 0) {
      console.log('No queues found.');
      return;
    }
    
    console.log('\n📋 Queues\n');
    
    const table = new Table({
      head: ['Queue', 'Status', 'Ready', 'Running', 'Total'],
      style: { head: ['cyan'], border: ['gray'] },
      colAligns: ['left', 'left', 'right', 'right', 'right'],
    });
    
    for (const q of queues) {
      const status = q.paused ? '⏸️  PAUSED' : '▶️  ACTIVE';
      table.push([
        q.queue,
        status,
        q.ready.toLocaleString(),
        q.running.toLocaleString(),
        q.total.toLocaleString(),
      ]);
    }
    
    console.log(table.toString());
    console.log();
  } finally {
    db.close();
  }
}

// Main
async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  
  const positionalArgs = getPositionalArgs(args.slice(1));
  const options = parseOptions(args);
  
  const dbPath = positionalArgs[0];
  
  if (!dbPath) {
    console.error('Error: Database path is required');
    printUsage();
    process.exit(1);
  }
  
    try {
    switch (command) {
      case 'stats':
        await cmdStats(dbPath);
        break;
        
      case 'list':
        await cmdList(dbPath, options);
        break;
        
      case 'export':
        await cmdExport(dbPath, positionalArgs[1], options);
        break;
        
      case 'import':
        if (!positionalArgs[1]) {
          console.error('Error: Input CSV file is required');
          process.exit(1);
        }
        await cmdImport(dbPath, positionalArgs[1]);
        break;
        
      case 'purge':
        await cmdPurge(dbPath, options);
        break;
        
      case 'retry':
        await cmdRetry(dbPath, options);
        break;
        
      case 'pause':
        if (!positionalArgs[1]) {
          console.error('Error: Queue name is required');
          console.error('Example: workmatic pause ./jobs.db emails');
          process.exit(1);
        }
        await cmdPause(dbPath, positionalArgs[1]);
        break;
        
      case 'resume':
        if (!positionalArgs[1]) {
          console.error('Error: Queue name is required');
          console.error('Example: workmatic resume ./jobs.db emails');
          process.exit(1);
        }
        await cmdResume(dbPath, positionalArgs[1]);
        break;
        
      case 'queues':
        await cmdQueues(dbPath);
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
