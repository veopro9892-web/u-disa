import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isVercel = Boolean(process.env.VERCEL);
const dbFile = isVercel ? path.join('/tmp', 'udisa.db') : path.join(ROOT, 'data', 'udisa.db');

let instance = null;

function getInstance() {
  if (!instance) {
    instance = createServer({ dbFile, quiet: true });
  }
  return instance;
}

export default async function handler(req, res) {
  const { handler: handleRequest } = getInstance();
  await handleRequest(req, res);
}
