/**
 * Workmatic Dashboard Example
 * 
 * This example demonstrates:
 * - Running the dashboard for monitoring
 * - Adding jobs while monitoring
 * - Worker control via dashboard
 * 
 * Run with: npx tsx examples/with-dashboard.ts
 * Then open: http://localhost:3000
 */

import { createDatabase, createClient, createWorker, createDashboard } from '../src/index.js';

// Use a file-based database so data persists
const db = createDatabase({ filename: ':memory:' });

// Create client and workers
const client = createClient({ db, queue: 'tasks' });

const worker = createWorker({
  db,
  queue: 'tasks',
  concurrency: 2,
  pollMs: 500,
});

interface TaskJob {
  name: string;
  duration: number;
}

// Processor that simulates work
worker.process<TaskJob>(async (job) => {
  console.log(`⚙️  Processing: ${job.payload.name}`);
  
  // Simulate work with random failures
  await new Promise(resolve => setTimeout(resolve, job.payload.duration));
  
  // 20% chance of failure for demo
  if (Math.random() < 0.2) {
    throw new Error('Random failure occurred');
  }
  
  console.log(`✅ Completed: ${job.payload.name}`);
});

async function main() {
  console.log('🚀 Starting Workmatic with Dashboard\n');

  // Start worker
  worker.start();

  // Create dashboard
  const dashboard = createDashboard({
    db,
    port: 3000,
    workers: [worker],
  });

  console.log(`📊 Dashboard running at http://localhost:${dashboard.port}\n`);
  console.log('Press Ctrl+C to stop\n');

  // Add some initial jobs
  console.log('Adding initial jobs...\n');

  const tasks = [
    { name: 'Send welcome email', duration: 500 },
    { name: 'Generate report', duration: 1000 },
    { name: 'Sync inventory', duration: 800 },
    { name: 'Process payment', duration: 600 },
    { name: 'Update analytics', duration: 400 },
  ];

  for (const task of tasks) {
    const result = await client.add<TaskJob>(task);
    console.log(`Added: ${task.name} (${result.id})`);
  }

  // Periodically add more jobs
  const jobNames = [
    'Process user data',
    'Send notification',
    'Backup database',
    'Clean cache',
    'Generate thumbnail',
    'Index document',
    'Validate order',
    'Calculate metrics',
  ];

  let jobCounter = 0;
  const addJobInterval = setInterval(async () => {
    const name = jobNames[Math.floor(Math.random() * jobNames.length)];
    const duration = 200 + Math.floor(Math.random() * 800);
    const priority = Math.floor(Math.random() * 10);
    
    await client.add<TaskJob>(
      { name: `${name} #${++jobCounter}`, duration },
      { priority }
    );
  }, 3000);

  // Handle shutdown
  const shutdown = async () => {
    console.log('\n\nShutting down...');
    
    clearInterval(addJobInterval);
    await worker.stop();
    await dashboard.close();
    await db.destroy();
    
    console.log('Goodbye! 👋');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep running
  await new Promise(() => {});
}

main().catch(console.error);
