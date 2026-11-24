import path from 'node:path';
import { fileURLToPath } from 'node:url';

let appInstance = null;
let initError = null;

async function getApp() {
  if (initError) throw initError;
  if (!appInstance) {
    try {
      const { createServer } = await import('../server.mjs');
      const ROOT = process.env.VERCEL ? process.cwd() : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      const dbFile = process.env.VERCEL ? path.join('/tmp', 'udisa.db') : path.join(ROOT, 'data', 'udisa.db');
      appInstance = createServer({ dbFile, quiet: true });
    } catch (err) {
      initError = err;
      console.error('Failed to initialize U-Disa on Vercel:', err);
      throw err;
    }
  }
  return appInstance;
}

export default async function handler(req, res) {
  try {
    if (req.url === '/api/index.js' || req.url === '/api' || !req.url.startsWith('/api')) {
      const original = req.headers['x-matched-path'] || req.headers['x-now-route-matches'];
      if (original && original.startsWith('/api')) {
        req.url = original;
      }
    }
    const { handler: handleRequest } = await getApp();
    await handleRequest(req, res);
  } catch (err) {
    console.error('API Error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: false,
      error: {
        code: 'serverless-init-error',
        message: err.message,
        stack: err.stack,
        nodeVersion: process.version
      }
    }));
  }
}
