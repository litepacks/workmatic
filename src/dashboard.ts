import { createServer, IncomingMessage, ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFile } from 'fs/promises';
import { sql } from 'kysely';
import type {
  WorkmaticDb,
  DashboardOptions,
  DashboardMiddlewareOptions,
  WorkmaticDashboard,
  WorkmaticWorker,
  DashboardMiddleware,
  JobStats,
  JobStatus,
} from './types.js';

// Get the directory of this module for static file serving
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Content types for static files
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Create the core request handler (shared between standalone and middleware)
 */
function createRequestHandler(
  db: WorkmaticDb,
  workerMap: Map<string, WorkmaticWorker>,
  basePath: string = ''
) {
  /**
   * Send JSON response
   */
  function sendJson(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Send error response
   */
  function sendError(res: ServerResponse, message: string, status = 500): void {
    sendJson(res, { error: message }, status);
  }

  /**
   * Parse URL query parameters
   */
  function parseQuery(url: string): URLSearchParams {
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) return new URLSearchParams();
    return new URLSearchParams(url.slice(queryIndex + 1));
  }

  /**
   * Get path from URL (removing basePath prefix)
   */
  function getPath(url: string): string {
    const queryIndex = url.indexOf('?');
    let path = queryIndex === -1 ? url : url.slice(0, queryIndex);
    
    // Remove basePath prefix if present
    if (basePath && path.startsWith(basePath)) {
      path = path.slice(basePath.length) || '/';
    }
    
    return path;
  }

  /**
   * API: Get jobs list
   */
  async function handleGetJobs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const query = parseQuery(req.url || '');
    const queueFilter = query.get('queue');
    const statusFilter = query.get('status') as JobStatus | null;
    const limit = Math.min(parseInt(query.get('limit') || '50', 10), 100);
    const offset = parseInt(query.get('offset') || '0', 10);

    let queryBuilder = db
      .selectFrom('workmatic_jobs')
      .select([
        'public_id',
        'queue',
        'payload',
        'status',
        'priority',
        'attempts',
        'max_attempts',
        'run_at',
        'created_at',
        'updated_at',
        'last_error',
      ])
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    if (queueFilter) {
      queryBuilder = queryBuilder.where('queue', '=', queueFilter);
    }
    if (statusFilter) {
      queryBuilder = queryBuilder.where('status', '=', statusFilter);
    }

    const jobs = await queryBuilder.execute();

    // Transform to API format
    const apiJobs = jobs.map(job => ({
      id: job.public_id,
      queue: job.queue,
      payload: JSON.parse(job.payload),
      status: job.status,
      priority: job.priority,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      runAt: job.run_at,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      lastError: job.last_error,
    }));

    sendJson(res, { jobs: apiJobs, limit, offset });
  }

  /**
   * API: Get statistics
   */
  async function handleGetStats(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const query = parseQuery(req.url || '');
    const queueFilter = query.get('queue');

    // Get counts by status
    let statsQuery = db
      .selectFrom('workmatic_jobs')
      .select([
        'status',
        sql<number>`count(*)`.as('count'),
      ])
      .groupBy('status');

    if (queueFilter) {
      statsQuery = statsQuery.where('queue', '=', queueFilter);
    }

    const statusCounts = await statsQuery.execute();

    const stats: JobStats = {
      ready: 0,
      running: 0,
      done: 0,
      failed: 0,
      dead: 0,
      total: 0,
    };

    for (const row of statusCounts) {
      const status = row.status as JobStatus;
      const count = Number(row.count);
      if (status in stats) {
        stats[status] = count;
      }
      stats.total += count;
    }

    // Get queue list
    const queuesResult = await db
      .selectFrom('workmatic_jobs')
      .select('queue')
      .groupBy('queue')
      .execute();

    const queues = queuesResult.map(q => q.queue);

    // Get worker status
    const workersStatus = Array.from(workerMap.entries()).map(([queue, worker]) => ({
      queue,
      running: worker.isRunning,
      paused: worker.isPaused,
    }));

    sendJson(res, { stats, queues, workers: workersStatus });
  }

  /**
   * API: Get single job by ID
   */
  async function handleGetJob(req: IncomingMessage, res: ServerResponse, publicId: string): Promise<void> {
    const job = await db
      .selectFrom('workmatic_jobs')
      .select([
        'public_id',
        'queue',
        'payload',
        'status',
        'priority',
        'attempts',
        'max_attempts',
        'run_at',
        'lease_until',
        'created_at',
        'updated_at',
        'last_error',
      ])
      .where('public_id', '=', publicId)
      .executeTakeFirst();

    if (!job) {
      return sendError(res, 'Job not found', 404);
    }

    sendJson(res, {
      id: job.public_id,
      queue: job.queue,
      payload: JSON.parse(job.payload),
      status: job.status,
      priority: job.priority,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      runAt: job.run_at,
      leaseUntil: job.lease_until,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      lastError: job.last_error,
    });
  }

  /**
   * API: Pause worker
   */
  async function handlePauseWorker(res: ServerResponse, queue: string): Promise<void> {
    const worker = workerMap.get(queue);
    if (!worker) {
      return sendError(res, `Worker for queue '${queue}' not found`, 404);
    }
    worker.pause();
    sendJson(res, { ok: true, queue, paused: true });
  }

  /**
   * API: Resume worker
   */
  async function handleResumeWorker(res: ServerResponse, queue: string): Promise<void> {
    const worker = workerMap.get(queue);
    if (!worker) {
      return sendError(res, `Worker for queue '${queue}' not found`, 404);
    }
    worker.resume();
    sendJson(res, { ok: true, queue, paused: false });
  }

  /**
   * Serve static files from the dashboard directory
   */
  async function serveStatic(res: ServerResponse, filePath: string): Promise<void> {
    // Navigate from dist/dashboard.js to dashboard/ directory
    const dashboardDir = join(__dirname, '..', 'dashboard');
    const fullPath = join(dashboardDir, filePath);
    
    // Determine content type
    const ext = filePath.substring(filePath.lastIndexOf('.')) || '.html';
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

    try {
      const content = await readFile(fullPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (error) {
      sendError(res, 'Not found', 404);
    }
  }

  /**
   * Main request handler
   */
  return async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    next?: () => void
  ): Promise<boolean> {
    const path = getPath(req.url || '/');

    // Check if this request is for the dashboard
    const fullUrl = req.url || '/';
    if (basePath && !fullUrl.startsWith(basePath)) {
      // Not our route, call next middleware if available
      if (next) next();
      return false;
    }

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    try {
      // API routes
      if (path === '/api/jobs' && req.method === 'GET') {
        await handleGetJobs(req, res);
        return true;
      }

      if (path === '/api/stats' && req.method === 'GET') {
        await handleGetStats(req, res);
        return true;
      }

      // Single job: /api/jobs/:id
      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === 'GET') {
        await handleGetJob(req, res, jobMatch[1]);
        return true;
      }

      // Pause worker: /api/workers/:queue/pause
      const pauseMatch = path.match(/^\/api\/workers\/([^/]+)\/pause$/);
      if (pauseMatch && req.method === 'POST') {
        await handlePauseWorker(res, pauseMatch[1]);
        return true;
      }

      // Resume worker: /api/workers/:queue/resume
      const resumeMatch = path.match(/^\/api\/workers\/([^/]+)\/resume$/);
      if (resumeMatch && req.method === 'POST') {
        await handleResumeWorker(res, resumeMatch[1]);
        return true;
      }

      // Static files
      if (path === '/' || path === '/index.html') {
        await serveStatic(res, 'index.html');
        return true;
      }
      if (path === '/style.css') {
        await serveStatic(res, 'style.css');
        return true;
      }
      if (path === '/app.js') {
        await serveStatic(res, 'app.js');
        return true;
      }

      // 404 for unknown routes under our basePath
      sendError(res, 'Not found', 404);
      return true;
    } catch (error) {
      console.error('[workmatic] Dashboard error:', error);
      sendError(res, 'Internal server error', 500);
      return true;
    }
  };
}

/**
 * Create a dashboard HTTP server for monitoring and controlling the job queue
 * 
 * @param options - Dashboard options
 * @returns Dashboard instance
 * 
 * @example
 * ```ts
 * const dashboard = createDashboard({ 
 *   db, 
 *   port: 3000,
 *   workers: [worker1, worker2] 
 * });
 * 
 * console.log(`Dashboard running at http://localhost:${dashboard.port}`);
 * 
 * // Later, close the server
 * await dashboard.close();
 * ```
 */
export function createDashboard(options: DashboardOptions): WorkmaticDashboard {
  const {
    db,
    port = 3000,
    workers = [],
  } = options;

  if (!db) {
    throw new Error('Database instance is required');
  }

  // Worker registry by queue name
  const workerMap = new Map<string, WorkmaticWorker>();
  for (const worker of workers) {
    workerMap.set(worker.queue, worker);
  }

  const handleRequest = createRequestHandler(db, workerMap);

  // Create and start HTTP server
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      console.error('[workmatic] Unhandled error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
  });

  server.listen(port);

  return {
    async close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    get port(): number {
      return port;
    },
  };
}

/**
 * Create an Express-compatible middleware for the dashboard
 * 
 * @param options - Middleware options
 * @returns Express middleware function
 * 
 * @example
 * ```ts
 * import express from 'express';
 * import { createDashboardMiddleware } from 'workmatic';
 * 
 * const app = express();
 * 
 * // Mount dashboard at /workmatic
 * app.use(createDashboardMiddleware({ 
 *   db,
 *   basePath: '/workmatic',
 *   workers: [worker] 
 * }));
 * 
 * app.listen(3000);
 * // Dashboard available at http://localhost:3000/workmatic
 * ```
 */
export function createDashboardMiddleware(options: DashboardMiddlewareOptions): DashboardMiddleware {
  const {
    db,
    workers = [],
    basePath = '',
  } = options;

  if (!db) {
    throw new Error('Database instance is required');
  }

  // Worker registry by queue name
  const workerMap = new Map<string, WorkmaticWorker>();
  for (const worker of workers) {
    workerMap.set(worker.queue, worker);
  }

  const handleRequest = createRequestHandler(db, workerMap, basePath);

  return (req, res, next) => {
    handleRequest(req, res, next).catch(error => {
      console.error('[workmatic] Unhandled error:', error);
      if (next) {
        next();
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  };
}
