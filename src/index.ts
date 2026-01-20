/**
 * Workmatic - A persistent job queue for Node.js
 * 
 * @packageDocumentation
 */

// Main exports
export { createDatabase } from './database.js';
export { createClient } from './client.js';
export { createWorker } from './worker.js';
export { createDashboard, createDashboardMiddleware } from './dashboard.js';

// Utility exports
export { defaultBackoff, validatePayload } from './utils.js';

// Type exports
export type {
  // Core types
  Job,
  JobStatus,
  JobStats,
  ClaimedJob,
  
  // Options
  AddJobOptions,
  AddJobResult,
  DatabaseOptions,
  ClientOptions,
  WorkerOptions,
  DashboardOptions,
  DashboardMiddlewareOptions,
  BackoffFunction,
  JobProcessor,
  
  // Interfaces
  WorkmaticClient,
  WorkmaticWorker,
  WorkmaticDashboard,
  DashboardMiddleware,
  WorkmaticDb,
  WorkmaticDatabase,
  WorkmaticJobsTable,
} from './types.js';
