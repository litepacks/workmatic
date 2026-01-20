/**
 * Basic Workmatic Example
 * 
 * This example demonstrates:
 * - Creating a database
 * - Adding jobs with a client
 * - Processing jobs with a worker
 * 
 * Run with: npx tsx examples/basic.ts
 */

import { createDatabase, createClient, createWorker } from '../src/index.js';

// Create an in-memory database for this example
// In production, use a file path: createDatabase({ filename: './jobs.db' })
const db = createDatabase({ filename: ':memory:' });

// Create a client for adding jobs
const client = createClient({ db, queue: 'emails' });

// Create a worker for processing jobs
const worker = createWorker({
  db,
  queue: 'emails',
  concurrency: 2,
});

// Define the job processor
interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

worker.process<EmailJob>(async (job) => {
  console.log(`📧 Sending email to ${job.payload.to}`);
  console.log(`   Subject: ${job.payload.subject}`);
  
  // Simulate sending email
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log(`✅ Email sent! Job ID: ${job.id}`);
});

// Main function
async function main() {
  console.log('🚀 Starting Workmatic basic example\n');

  // Add some jobs
  console.log('Adding jobs...\n');
  
  const job1 = await client.add<EmailJob>({
    to: 'alice@example.com',
    subject: 'Welcome!',
    body: 'Thanks for signing up.',
  });
  console.log(`Added job: ${job1.id}`);

  const job2 = await client.add<EmailJob>({
    to: 'bob@example.com',
    subject: 'Your order',
    body: 'Your order has been shipped.',
  });
  console.log(`Added job: ${job2.id}`);

  const job3 = await client.add<EmailJob>({
    to: 'charlie@example.com',
    subject: 'Newsletter',
    body: 'Check out our latest updates.',
  });
  console.log(`Added job: ${job3.id}`);

  // Show stats before processing
  const statsBefore = await client.stats();
  console.log('\nStats before processing:', statsBefore);

  // Start the worker
  console.log('\nStarting worker...\n');
  worker.start();

  // Wait for jobs to complete
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Show stats after processing
  const statsAfter = await client.stats();
  console.log('\nStats after processing:', statsAfter);

  // Stop the worker gracefully
  console.log('\nStopping worker...');
  await worker.stop();

  // Clean up
  await db.destroy();
  
  console.log('\n✨ Done!');
}

main().catch(console.error);
