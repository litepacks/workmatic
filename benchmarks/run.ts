/**
 * Workmatic Performance Benchmarks
 * 
 * Run with: npx tsx benchmarks/run.ts
 */

import { createDatabase, createClient, createWorker } from '../src/index.js';
import type { WorkmaticDb } from '../src/types.js';

// Benchmark configuration
const CONFIG = {
  // Number of jobs for each benchmark
  insertBatch: 10_000,
  processBatch: 5_000,
  concurrencyTest: 1_000,
  
  // Concurrency levels to test
  concurrencyLevels: [1, 2, 4, 8, 16],
};

interface BenchmarkResult {
  name: string;
  ops: number;
  duration: number;
  opsPerSec: number;
  avgLatency: number;
}

const results: BenchmarkResult[] = [];

function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function printResult(result: BenchmarkResult): void {
  console.log(`  ${result.name}`);
  console.log(`    Operations:    ${formatNumber(result.ops)}`);
  console.log(`    Duration:      ${formatNumber(result.duration)} ms`);
  console.log(`    Throughput:    ${formatNumber(result.opsPerSec)} ops/sec`);
  console.log(`    Avg Latency:   ${formatNumber(result.avgLatency)} ms`);
  console.log();
}

async function benchmark(
  name: string,
  ops: number,
  fn: () => Promise<void>,
  options: { warmup?: boolean } = {}
): Promise<BenchmarkResult> {
  const { warmup = true } = options;
  
  // Warmup (skip for processing benchmarks)
  if (warmup) {
    await fn();
  }
  
  const start = performance.now();
  await fn();
  const duration = performance.now() - start;
  
  const result: BenchmarkResult = {
    name,
    ops,
    duration,
    opsPerSec: (ops / duration) * 1000,
    avgLatency: duration / ops,
  };
  
  results.push(result);
  printResult(result);
  
  return result;
}

// ============================================================
// Benchmark: Sequential Insert
// ============================================================
async function benchmarkSequentialInsert(db: WorkmaticDb): Promise<void> {
  console.log('📥 Sequential Insert Benchmark');
  console.log(`   Inserting ${formatNumber(CONFIG.insertBatch)} jobs one by one\n`);
  
  const client = createClient({ db, queue: 'bench-insert' });
  
  await benchmark('Sequential Insert', CONFIG.insertBatch, async () => {
    for (let i = 0; i < CONFIG.insertBatch; i++) {
      await client.add({ index: i, data: 'test payload' });
    }
  });
}

// ============================================================
// Benchmark: Batch Insert (parallel)
// ============================================================
async function benchmarkParallelInsert(db: WorkmaticDb): Promise<void> {
  console.log('📥 Parallel Insert Benchmark');
  console.log(`   Inserting ${formatNumber(CONFIG.insertBatch)} jobs in parallel batches\n`);
  
  const client = createClient({ db, queue: 'bench-parallel-insert' });
  const batchSize = 100;
  
  await benchmark('Parallel Insert (batch=100)', CONFIG.insertBatch, async () => {
    for (let i = 0; i < CONFIG.insertBatch; i += batchSize) {
      const promises = [];
      for (let j = 0; j < batchSize && i + j < CONFIG.insertBatch; j++) {
        promises.push(client.add({ index: i + j, data: 'test payload' }));
      }
      await Promise.all(promises);
    }
  });
}

// ============================================================
// Benchmark: Job Processing with various concurrency
// ============================================================
async function benchmarkProcessing(db: WorkmaticDb): Promise<void> {
  console.log('⚙️  Processing Benchmark');
  console.log(`   Processing ${formatNumber(CONFIG.processBatch)} jobs at different concurrency levels\n`);
  
  for (const concurrency of CONFIG.concurrencyLevels) {
    const queueName = `bench-process-c${concurrency}-${Date.now()}`;
    const client = createClient({ db, queue: queueName });
    
    // Insert jobs
    console.log(`   Preparing ${formatNumber(CONFIG.processBatch)} jobs for concurrency=${concurrency}...`);
    const batchSize = 500;
    for (let i = 0; i < CONFIG.processBatch; i += batchSize) {
      const promises = [];
      for (let j = 0; j < batchSize && i + j < CONFIG.processBatch; j++) {
        promises.push(client.add({ index: i + j }));
      }
      await Promise.all(promises);
    }
    
    const worker = createWorker({
      db,
      queue: queueName,
      concurrency,
      pollMs: 5,
    });
    
    let processed = 0;
    
    worker.process(async () => {
      processed++;
    });
    
    await benchmark(
      `Process (concurrency=${concurrency})`,
      CONFIG.processBatch,
      async () => {
        worker.start();
        
        // Wait until all jobs are processed
        while (processed < CONFIG.processBatch) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        
        await worker.stop();
      },
      { warmup: false } // No warmup for processing - jobs are consumed
    );
  }
}

// ============================================================
// Benchmark: Mixed workload (insert + process)
// ============================================================
async function benchmarkMixedWorkload(db: WorkmaticDb): Promise<void> {
  console.log('🔄 Mixed Workload Benchmark');
  console.log(`   Concurrent insert and process of ${formatNumber(CONFIG.concurrencyTest)} jobs\n`);
  
  const queueName = `bench-mixed-${Date.now()}`;
  const client = createClient({ db, queue: queueName });
  const worker = createWorker({
    db,
    queue: queueName,
    concurrency: 8,
    pollMs: 5,
  });
  
  let processed = 0;
  
  worker.process(async () => {
    processed++;
  });
  
  await benchmark(
    'Mixed Insert+Process',
    CONFIG.concurrencyTest,
    async () => {
      worker.start();
      
      // Insert jobs while processing
      const batchSize = 100;
      for (let i = 0; i < CONFIG.concurrencyTest; i += batchSize) {
        const promises = [];
        for (let j = 0; j < batchSize && i + j < CONFIG.concurrencyTest; j++) {
          promises.push(client.add({ index: i + j }));
        }
        await Promise.all(promises);
      }
      
      // Wait until all jobs are processed
      while (processed < CONFIG.concurrencyTest) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      
      await worker.stop();
    },
    { warmup: false }
  );
}

// ============================================================
// Benchmark: Stats query
// ============================================================
async function benchmarkStats(db: WorkmaticDb): Promise<void> {
  console.log('📊 Stats Query Benchmark');
  console.log(`   Running 1000 stats queries\n`);
  
  const client = createClient({ db, queue: 'bench-stats' });
  
  // Add some jobs first
  for (let i = 0; i < 1000; i++) {
    await client.add({ index: i });
  }
  
  await benchmark('Stats Query', 1000, async () => {
    for (let i = 0; i < 1000; i++) {
      await client.stats();
    }
  });
}

// ============================================================
// Benchmark: Claim batch (internal operation)
// ============================================================
async function benchmarkClaimBatch(db: WorkmaticDb): Promise<void> {
  console.log('🔒 Claim Batch Benchmark');
  console.log(`   Claiming jobs in batches of 50\n`);
  
  const queueName = `bench-claim-${Date.now()}`;
  const client = createClient({ db, queue: queueName });
  
  // Add jobs
  const jobCount = 5000;
  console.log(`   Preparing ${formatNumber(jobCount)} jobs...`);
  const batchSize = 500;
  for (let i = 0; i < jobCount; i += batchSize) {
    const promises = [];
    for (let j = 0; j < batchSize && i + j < jobCount; j++) {
      promises.push(client.add({ index: i + j }));
    }
    await Promise.all(promises);
  }
  
  const worker = createWorker({
    db,
    queue: queueName,
    concurrency: 50,
    pollMs: 1,
  });
  
  let processed = 0;
  worker.process(async () => {
    processed++;
  });
  
  await benchmark(
    'Claim + Process Batch',
    jobCount,
    async () => {
      worker.start();
      
      while (processed < jobCount) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      
      await worker.stop();
    },
    { warmup: false }
  );
}

// ============================================================
// Main
// ============================================================
async function main(): Promise<void> {
  // Check for --file flag
  const useFile = process.argv.includes('--file');
  const dbPath = useFile ? './bench.db' : ':memory:';
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              WORKMATIC PERFORMANCE BENCHMARKS              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Configuration:`);
  console.log(`  Database:         ${useFile ? dbPath + ' (file)' : 'in-memory'}`);
  console.log(`  Insert batch:     ${formatNumber(CONFIG.insertBatch)} jobs`);
  console.log(`  Process batch:    ${formatNumber(CONFIG.processBatch)} jobs`);
  console.log(`  Concurrency test: ${formatNumber(CONFIG.concurrencyTest)} jobs`);
  console.log(`  Concurrency levels: ${CONFIG.concurrencyLevels.join(', ')}`);
  console.log();
  console.log('─'.repeat(60));
  console.log();
  
  // Create database for benchmarks
  const db = createDatabase({ filename: dbPath });
  
  try {
    await benchmarkSequentialInsert(db);
    console.log('─'.repeat(60));
    console.log();
    
    await benchmarkParallelInsert(db);
    console.log('─'.repeat(60));
    console.log();
    
    await benchmarkProcessing(db);
    console.log('─'.repeat(60));
    console.log();
    
    await benchmarkMixedWorkload(db);
    console.log('─'.repeat(60));
    console.log();
    
    await benchmarkStats(db);
    console.log('─'.repeat(60));
    console.log();
    
    await benchmarkClaimBatch(db);
    
    // Summary
    console.log('─'.repeat(60));
    console.log();
    console.log('📈 SUMMARY');
    console.log();
    console.log('┌────────────────────────────────────┬──────────────┬──────────────┐');
    console.log('│ Benchmark                          │  Throughput  │  Avg Latency │');
    console.log('├────────────────────────────────────┼──────────────┼──────────────┤');
    
    for (const result of results) {
      const name = result.name.padEnd(34);
      const throughput = formatNumber(Math.round(result.opsPerSec)).padStart(10) + '/s';
      const latency = formatNumber(result.avgLatency).padStart(9) + ' ms';
      console.log(`│ ${name} │ ${throughput} │ ${latency} │`);
    }
    
    console.log('└────────────────────────────────────┴──────────────┴──────────────┘');
    console.log();
    
  } finally {
    await db.destroy();
    
    // Clean up file if used
    if (useFile) {
      const { unlink } = await import('fs/promises');
      try {
        await unlink(dbPath);
        await unlink(dbPath + '-wal').catch(() => {});
        await unlink(dbPath + '-shm').catch(() => {});
      } catch {}
    }
  }
  
  console.log('✨ Benchmarks complete!\n');
}

main().catch(console.error);
