/**
 * Multi-queue orchestration example
 *
 * Run with: npx tsx examples/orchestrator.ts
 */

import { createDatabase, createOrchestrator } from '../src/index.js';

const db = createDatabase({ filename: ':memory:' });
const orch = createOrchestrator({ db });

// Client-only source queue; worker on destination
orch.register('ingest');
orch.register('process', { worker: { pollMs: 50, concurrency: 1 } });

const processResults: number[] = [];

orch.process('process', async (job) => {
  processResults.push((job.payload as { id: number }).id);
});

async function main() {
  console.log('Multi-queue orchestration example\n');

  await orch.client('ingest').add({ id: 1 });
  await orch.client('ingest').add({ id: 2 });
  console.log('Added 2 jobs to ingest queue');

  const { moved } = await orch.transfer({ from: 'ingest', to: 'process', status: 'ready' });
  console.log(`Transferred ${moved} job(s) to process queue`);

  orch.startAll();
  await new Promise((r) => setTimeout(r, 500));
  await orch.stopAll();

  console.log('Processed IDs:', processResults);
  console.log('Queues:', await orch.queues());
  console.log('Stats:', await orch.stats());

  await db.destroy();
  console.log('\nDone.');
}

main().catch(console.error);
