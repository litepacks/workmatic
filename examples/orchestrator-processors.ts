/**
 * Orchestrator with different processors per queue
 *
 * Each queue gets its own worker options and process() handler.
 * Run with: npx tsx examples/orchestrator-processors.ts
 */

import { createDatabase, createOrchestrator } from '../src/index.js';

const db = createDatabase({ filename: ':memory:' });
const orch = createOrchestrator({ db });

interface NotificationJob {
  userId: string;
  message: string;
  channel: 'push' | 'sms' | 'email';
}

interface ReportJob {
  reportId: string;
  shouldFail?: boolean;
}

interface WebhookJob {
  url: string;
  body: Record<string, unknown>;
}

// Fast notifications — high concurrency, short poll
orch.register('notifications', {
  worker: { concurrency: 4, pollMs: 50 },
});

// Heavy reports — single worker, long lease, linear backoff
orch.register('reports', {
  worker: {
    concurrency: 1,
    pollMs: 100,
    leaseMs: 60_000,
    backoff: (attempts) => 500 * attempts,
  },
});

// Outbound webhooks — moderate throughput
orch.register('webhooks', {
  worker: { concurrency: 2, pollMs: 80 },
});

const reportAttempts: Record<string, number> = {};

// --- Different processor per queue ---

orch.process<NotificationJob>('notifications', async (job) => {
  const { userId, message, channel } = job.payload;
  console.log(`  🔔 [${channel}] ${userId}: ${message}`);
  await new Promise((r) => setTimeout(r, 80));
});

orch.process<ReportJob>('reports', async (job) => {
  const { reportId, shouldFail } = job.payload;
  reportAttempts[reportId] = (reportAttempts[reportId] ?? 0) + 1;
  console.log(
    `  📊 Report ${reportId} (attempt ${job.attempts + 1}/${job.maxAttempts})`
  );
  await new Promise((r) => setTimeout(r, 120));

  if (shouldFail && reportAttempts[reportId] < 2) {
    throw new Error(`Simulated failure for ${reportId}`);
  }
  console.log(`  ✅ Report ${reportId} done`);
});

orch.process<WebhookJob>('webhooks', async (job) => {
  const { url, body } = job.payload;
  console.log(`  🌐 POST ${url}`, body);
  await new Promise((r) => setTimeout(r, 60));
});

async function main() {
  console.log('Orchestrator — different processors per queue\n');

  await orch.client('notifications').add<NotificationJob>(
    { userId: 'u1', message: 'Order shipped', channel: 'push' },
    { priority: 1 }
  );
  await orch.client('notifications').add<NotificationJob>(
    { userId: 'u2', message: 'Weekly digest', channel: 'email' },
    { priority: 10 }
  );

  await orch.client('reports').add<ReportJob>(
    { reportId: 'R-100', shouldFail: false }
  );
  await orch.client('reports').add<ReportJob>(
    { reportId: 'R-200', shouldFail: true },
    { maxAttempts: 4 }
  );

  await orch.client('webhooks').add<WebhookJob>({
    url: 'https://api.example.com/hooks/order',
    body: { event: 'order.created', id: 'ord_1' },
  });

  orch.startAll();

  console.log('\nProcessing (all queues in parallel)...\n');
  await new Promise((r) => setTimeout(r, 2500));

  await orch.stopAll();

  console.log('\n--- Stats per queue ---\n');
  const stats = await orch.stats();
  for (const [queue, s] of Object.entries(stats)) {
    console.log(
      `  ${queue}: ready=${s.ready} running=${s.running} done=${s.done} dead=${s.dead}`
    );
  }

  await db.destroy();
  console.log('\nDone.');
}

main().catch(console.error);
