/**
 * Advanced Workmatic Example
 * 
 * This example demonstrates:
 * - Priority-based job processing
 * - Delayed jobs
 * - Custom retry settings
 * - Error handling and retries
 * - Custom backoff function
 * 
 * Run with: npx tsx examples/advanced.ts
 */

import { createDatabase, createClient, createWorker, type Job } from '../src/index.js';

const db = createDatabase({ filename: ':memory:' });

// Create clients for different queues
const highPriorityClient = createClient({ db, queue: 'notifications' });
const batchClient = createClient({ db, queue: 'batch-jobs' });

// Custom backoff: linear instead of exponential
const linearBackoff = (attempts: number) => 1000 * attempts;

// Worker for notifications (fast, high priority)
const notificationWorker = createWorker({
  db,
  queue: 'notifications',
  concurrency: 4,
  pollMs: 100,
});

// Worker for batch jobs (slow, with retries)
const batchWorker = createWorker({
  db,
  queue: 'batch-jobs',
  concurrency: 1,
  leaseMs: 60000, // 1 minute lease
  backoff: linearBackoff,
});

interface NotificationJob {
  userId: string;
  message: string;
  channel: 'push' | 'sms' | 'email';
}

interface BatchJob {
  reportId: string;
  shouldFail?: boolean;
}

// Notification processor
notificationWorker.process<NotificationJob>(async (job) => {
  const { userId, message, channel } = job.payload;
  console.log(`🔔 [${channel.toUpperCase()}] User ${userId}: ${message}`);
  await new Promise(resolve => setTimeout(resolve, 100));
});

// Batch job processor with simulated failures
let batchAttempts: Record<string, number> = {};

batchWorker.process<BatchJob>(async (job) => {
  const { reportId, shouldFail } = job.payload;
  
  console.log(`📊 Processing report ${reportId} (attempt ${job.attempts + 1}/${job.maxAttempts})`);
  
  // Simulate work
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Track attempts for demo
  batchAttempts[reportId] = (batchAttempts[reportId] || 0) + 1;
  
  // Fail on first two attempts if shouldFail is true
  if (shouldFail && batchAttempts[reportId] < 3) {
    console.log(`❌ Report ${reportId} failed (will retry)`);
    throw new Error(`Simulated failure for report ${reportId}`);
  }
  
  console.log(`✅ Report ${reportId} completed!`);
});

async function main() {
  console.log('🚀 Starting Workmatic advanced example\n');

  // Start workers
  notificationWorker.start();
  batchWorker.start();

  // Example 1: Priority-based notifications
  console.log('--- Priority-based notifications ---\n');

  await highPriorityClient.add<NotificationJob>(
    { userId: 'user1', message: 'Low priority update', channel: 'email' },
    { priority: 10 }
  );

  await highPriorityClient.add<NotificationJob>(
    { userId: 'user2', message: 'URGENT: Account alert!', channel: 'push' },
    { priority: 1 } // Higher priority (lower number)
  );

  await highPriorityClient.add<NotificationJob>(
    { userId: 'user3', message: 'Weekly digest', channel: 'email' },
    { priority: 20 }
  );

  await highPriorityClient.add<NotificationJob>(
    { userId: 'user4', message: 'Security alert', channel: 'sms' },
    { priority: 1 } // Also high priority
  );

  // Wait for notifications
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Example 2: Delayed job
  console.log('\n--- Delayed job ---\n');

  const delayedJob = await highPriorityClient.add<NotificationJob>(
    { userId: 'user5', message: 'Scheduled reminder', channel: 'push' },
    { delayMs: 2000 } // 2 second delay
  );
  console.log(`Scheduled job ${delayedJob.id} to run in 2 seconds...`);

  // Example 3: Batch jobs with retries
  console.log('\n--- Batch jobs with retries ---\n');

  // This job will fail twice then succeed
  await batchClient.add<BatchJob>(
    { reportId: 'report-A', shouldFail: true },
    { maxAttempts: 5 }
  );

  // This job will succeed immediately
  await batchClient.add<BatchJob>(
    { reportId: 'report-B', shouldFail: false },
    { maxAttempts: 3 }
  );

  // Wait for all processing including retries
  console.log('\nWaiting for all jobs to complete (including retries)...\n');
  await new Promise(resolve => setTimeout(resolve, 8000));

  // Final stats
  console.log('\n--- Final Stats ---\n');
  
  const notifStats = await notificationWorker.stats();
  console.log('Notifications queue:', notifStats);
  
  const batchStats = await batchWorker.stats();
  console.log('Batch jobs queue:', batchStats);

  // Stop workers
  await notificationWorker.stop();
  await batchWorker.stop();
  await db.destroy();

  console.log('\n✨ Done!');
}

main().catch(console.error);
