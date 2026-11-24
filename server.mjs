#!/usr/bin/env node
// U-Disa server. Node built-ins only: no node_modules means there is no install
// step to fail, which is the single biggest cause of "the app did not open".
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

import { openDb } from './src/db.mjs';
import { createApi } from './src/api.mjs';
import { loadSchemes } from './src/schemes.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const RUNTIME = path.join(DATA, 'runtime.json');

const argv = {};
for (let i=2; i<process.argv.length; i++) {
  const [key,value]=process.argv[i].replace(/^--/,'').split('=');
  argv[key]=value ?? (process.argv[i+1] && !process.argv[i+1].startsWith('--') ? process.argv[++i] : true);
}

export const VERSION = '1.1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const REQUIRED = [
  ['data/catalog.json', 'the option list (business types, units, categories)'],
  ['data/nic-divisions.json', 'the activity (NIC) list shown at registration'],
  ['data/schemes.json', 'the government scheme reference'],
  ['public/brand.json', 'the brand colours and app name'],
  ['public/css/brand.css', 'the generated stylesheet tokens'],
  ['public/index.html', 'the app screen'],
  ['public/icons/icon-192.png', 'the app icon'],
  ['public/icons/icon-512.png', 'the large app icon'],
  ['public/manifest.webmanifest', 'the home-screen install file'],
  ['public/js/app.js', 'the app code'],
];

function fail(lines) {
  console.error('\n  U-Disa could not start.\n');
  for (const l of lines) console.error('   ' + l);
  console.error('\n  Nothing was changed on your computer. Fix the line above and try again.\n');
  process.exitCode = 1;
  return false;
}

export function preflight() {
  const problems = [];
  for (const [rel, what] of REQUIRED) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      problems.push(`- missing ${rel} (${what})`);
      continue;
    }
    if (rel.endsWith('.json') || rel.endsWith('.webmanifest')) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        problems.push(`- ${rel} is not readable (${what}): ${e.message}`);
      }
    }
  }
  return problems;
}

export function loadAssets() {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog.json'), 'utf8'));
  // the NIC-2004 division list is the longest option set in the app, so it lives
  // in its own file and is checked against the section table on the way in
  const divisions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/nic-divisions.json'), 'utf8'));
  const sections = new Set(catalog.nicSections.map((s) => s.code));
  const activities = new Set(catalog.activities.map((a) => a.id));
  for (const d of divisions) {
    if (!sections.has(d.section)) throw new Error(`data/nic-divisions.json: ${d.code} points at unknown section ${d.section}`);
    if (!activities.has(d.activity)) throw new Error(`data/nic-divisions.json: ${d.code} has unknown activity ${d.activity}`);
  }
  catalog.nicDivisions = divisions;
  const { schemes, meta } = loadSchemes(path.join(ROOT, 'data/schemes.json'));
  const brand = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'brand.json'), 'utf8'));
  return { catalog, schemes, meta, brand };
}

const readBody = (req, limit = 512 * 1024, hardLimit = 4 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch { return reject(Object.assign(new Error('bad-json'), { status: 400 })); }
    }
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > hardLimit) {
        // past any reasonable request the socket is simply dropped
        req.destroy();
        reject(Object.assign(new Error('too-large'), { status: 413 }));
        return;
      }
      if (size > limit) {
        // keep draining without storing, so the client still gets a real 413
        // instead of a connection reset mid-reply
        overflow = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflow) return reject(Object.assign(new Error('too-large'), { status: 413 }));
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('bad-json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });

function cookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createServer({ dbFile = (process.env.VERCEL ? path.join('/tmp', 'udisa.db') : path.join(DATA, 'udisa.db')), quiet = false } = {}) {
  const db = openDb(dbFile);
  const { catalog, schemes, meta, brand } = loadAssets();
  const api = createApi({ db, catalog, schemes, meta, brand, version: VERSION });

  const send = (res, status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Length': Buffer.byteLength(payload),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  };

  const serveStatic = (res, urlPath) => {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const real = path.resolve(PUBLIC, rel);
    // reject anything that resolves outside the public folder, however it is spelled
    if (path.relative(path.resolve(PUBLIC), real).startsWith('..')) return send(res, 403, 'forbidden');
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      return send(res, 404, 'not found');
    }
    if (stat.isDirectory()) return send(res, 404, 'not found');
    const ext = path.extname(real).toLowerCase();
    // Code and markup must revalidate on every load: a five-minute-old app.css is
    // enough to leave the splash screen covering a working app. Only images,
    // which change only when the icons are regenerated, may be cached freely.
    const volatile = !['.png', '.svg', '.ico', '.woff2'].includes(ext);
    const headers = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': volatile ? 'no-cache' : 'public, max-age=300',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    if (real.endsWith('index.html')) {
      headers['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "connect-src 'self'; font-src 'self' data:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    }
    res.writeHead(200, { 'Content-Length': stat.size, 'X-Content-Type-Options': 'nosniff', ...headers });
    fs.createReadStream(real).pipe(res);
  };

  const handler = async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        const token =
          (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || cookies(req.headers.cookie).udisa_session || '';
        const sessionUser = api.userFor(token);
        if (req.headers['x-udisa-owner'] && req.headers['x-udisa-owner'] !== sessionUser?.id) return send(res,401,{ok:false,error:{code:'account-changed',message:'Sign back in to the original business.'}});
        const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
        const ip = (req.socket?.remoteAddress ?? req.headers?.['x-forwarded-for'] ?? '').trim();
        const result = await api.handle({
          method: req.method,
          path: p,
          query: Object.fromEntries(url.searchParams),
          body,
          token,
          ip,
          ua: String(req.headers?.['user-agent'] ?? '').slice(0, 200),
          user: sessionUser,
        });
        if (result?.file) {
          res.writeHead(200, {
            'Content-Type': result.file.type,
            'Content-Disposition': `attachment; filename="${result.file.name}"`,
            'Content-Length': Buffer.byteLength(result.file.text),
          });
          return res.end(result.file.text);
        }
        const status = result?.status ?? 500;
        if (status >= 200 && status < 300 && result?.body?.ok && result.body.token) setSessionCookie(res, result.body.token);
        if (p === '/api/logout' && status === 200) res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
        return send(res, status, result?.body ?? { ok: false, error: { code: 'no-response', message: 'No response' } });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      return serveStatic(res, p);
    } catch (err) {
      const status = err.status ?? 500;
      if (!quiet) console.error(`  ! ${req.method} ${p} -> ${err.message}`);
      return send(res, status, {
        ok: false,
        error: { code: err.message === 'too-large' ? 'too-large' : 'server', message: 'Something went wrong on this step. Your earlier entries are still saved.' },
      });
    } finally {
      if (!quiet) console.log(`  ${req.method} ${p} ${Date.now() - started}ms`);
    }
  };

  const server = http.createServer(handler);

  return { server, db, handler, api };
}

export const COOKIE_NAME = 'udisa_session';
function setSessionCookie(res, token) {
  // SameSite=Lax keeps the session alive inside a phone WebView; the client also
  // keeps the token itself so a browser that drops cookies can still log in.
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
}

const HOST = argv.host ?? process.env.HOST ?? '127.0.0.1';

async function tryListen(server,ports) {
  for (const port of ports) {
    try {
      await new Promise((resolve,reject)=>{
        const onListening=()=>{server.off('error',onError);resolve();};
        const onError=err=>{server.off('listening',onListening);reject(err);};
        server.once('error',onError);
        server.once('listening',onListening);
        server.listen(port,HOST);
      });
      return server.address().port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port===ports.at(-1)) throw error;
    }
  }
}

export function openBrowser(url) {
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`, { shell: 'cmd.exe', stdio: 'ignore' });
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`  open this address in your browser: ${url}`);
  }
}

export async function main() {
  const problems = preflight();
  if (problems.length) {
    fail(problems);
    return null;
  }
  const dbFile = typeof argv.db === 'string' ? path.resolve(ROOT, argv.db) : path.join(DATA, 'udisa.db');
  const { server, db } = createServer({ dbFile, quiet: Boolean(argv.quiet) });
  const explicit = argv.port ?? process.env.PORT;
  const base = Number(explicit ?? 4173);
  const ports = explicit ? [base] : Array.from({ length: 8 }, (_, i) => base + i);

  let port;
  try {
    port = await tryListen(server, ports);
  } catch (err) {
    if (err.code === 'EACCES') fail([`- this computer will not let the app use port ${base}.`, '  Close the program using it, or start with a different port:', `  node server.mjs --port 8080`]);
    else fail([`- could not start a local web server: ${err.code ?? err.message}`]);
    return null;
  }

  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}/`;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(RUNTIME, JSON.stringify({ port, url, pid: process.pid, started: new Date().toISOString(), dbFile }, null, 2));

  if (!argv.quiet) {
    console.log(`\n  U-Disa is running`);
    console.log(`  open   ${url}`);
    console.log(`  data   ${dbFile}`);
    console.log(`  stop   press Ctrl+C in this window\n`);
    if (!argv['no-browser']) openBrowser(url);
  }

  const shutdown = () => {
    try { if (JSON.parse(fs.readFileSync(RUNTIME)).pid===process.pid) fs.unlinkSync(RUNTIME); } catch {}
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, db, port, url, shutdown };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('\n  U-Disa could not start:', err?.stack ?? err, '\n');
    process.exit(1);
  });
}
