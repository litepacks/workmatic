import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { createDatabase } from '../src/index.js';
import {
  createRequestHandler,
  staticContentTypeFor,
  requestUrl,
} from '../src/dashboard.js';
import type { WorkmaticDb } from '../src/types.js';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (path: string, encoding?: string) => {
      if (String(path).includes('index.html')) {
        throw new Error('ENOENT');
      }
      return actual.readFile(path, encoding as BufferEncoding);
    }),
  };
});

describe('requestUrl', () => {
  it('falls back to empty string', () => {
    expect(requestUrl(undefined)).toBe('');
    expect(requestUrl('/api/jobs')).toBe('/api/jobs');
  });
});

describe('staticContentTypeFor', () => {
  it('covers extension fallbacks', () => {
    expect(staticContentTypeFor('index.html')).toContain('text/html');
    expect(staticContentTypeFor('')).toContain('text/html');
    expect(staticContentTypeFor('file.xyz')).toBe('application/octet-stream');
  });
});

describe('dashboard static errors', () => {
  let db: WorkmaticDb;

  beforeEach(() => {
    db = createDatabase({ filename: ':memory:' });
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('serveStatic returns 404 when readFile throws', async () => {
    const handler = createRequestHandler(db, new Map(), '');
    const port = 3477;
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(port, resolve));
    const res = await fetch(`http://127.0.0.1:${port}/index.html`);
    expect(res.status).toBe(404);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });
});
