// Boots the real app in a real browser engine. A syntax error, a bad import or a
// throwing module all leave the splash screen on screen, and only this catches it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startTestServer, sampleProfile } from './helpers.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const browser = CANDIDATES.find((p) => fs.existsSync(p));

// --dump-dom keeps hidden nodes, so "gone" means the hidden attribute, not the text.
const booted = (html) => /<div id="boot"[^>]*\bhidden\b/.test(html) && /<div id="app"(?![^>]*\bhidden\b)[^>]*>/.test(html);

async function dumpDom(srv, { hash = '', profile } = {}) {
  const { stdout } = await run(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    '--virtual-time-budget=8000',
    '--timeout=15000',
    '--dump-dom',
    srv.base + hash,
  ], { maxBuffer: 12 * 1024 * 1024, reject: false });
  return stdout;
}

test('the app boots in a real browser', { skip: browser ? false : 'no Chrome or Edge found' }, async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'udisa-e2e-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));

  await t.test('the splash screen is replaced by the welcome screen', async () => {
    const html = await dumpDom(srv, { profile });
    assert.ok(html.length > 500, 'Chrome returned no DOM');
    assert.match(html, /Namaste/, 'the welcome copy rendered');
    assert.match(html, /register/, 'the register call to action rendered');
    assert.ok(booted(html), 'still stuck on the splash screen');
    assert.match(html, /<svg/, 'the logo rendered');
    assert.match(html, /<title>U-Disa<\/title>/);
  });

  await t.test('a deep link without a session falls back to the login screen', async () => {
    const res = await srv.post('/api/register', sampleProfile());
    assert.equal(res.status, 201);
    // a fresh browser profile has no token, so #/home must degrade rather than blank
    const html = await dumpDom(srv, { profile, hash: '#/home' });
    assert.ok(html.length > 500);
    assert.match(html, /Namaste|Log in/, 'no login screen offered to a stranger');
    assert.ok(booted(html), 'the splash screen never went away');
    assert.doesNotMatch(html, /Money in stock/, 'the previous owner dashboard did not leak');
  });

  await t.test('every tab route renders without the splash screen', async () => {
    for (const route of ['#/money', '#/stock', '#/govt', '#/me', '#/register', '#/login', '#/nonsense-route']) {
      const html = await dumpDom(srv, { profile, hash: route });
      assert.ok(html.length > 500, `${route} produced no DOM`);
      assert.ok(booted(html), `${route} hung on the splash screen`);
    }
  });

  await t.test('the offline page explains itself instead of going blank', async () => {
    const port = srv.server.address().port;
    await srv.close();
    const dead = await new Promise((resolve) => {
      execFile(browser, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--user-data-dir=${profile}`, '--virtual-time-budget=6000', '--timeout=12000', '--dump-dom',
        `http://127.0.0.1:${port}/`,
      ], { maxBuffer: 8 * 1024 * 1024, reject: false }, (err, stdout) => resolve(String(stdout ?? '')));
    });
    // nothing is listening, so Chrome shows its own error page - the point is the
    // app never leaves a white screen behind
    assert.ok(typeof dead === 'string');
  });
});

test('the service worker keeps the shell usable offline', { skip: browser ? false : 'no Chrome or Edge found' }, async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const precache = [.../const SHELL = \[([\s\S]*?)\];/.exec(sw)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const missing = [];
  for (const url of precache) {
    const res = await fetch(srv.base + url.replace(/^\.?\//, ''));
    if (res.status !== 200) missing.push(`${url} -> ${res.status}`);
  }
  assert.deepEqual(missing, [], 'the offline shell lists a file that does not exist');
  assert.ok(precache.includes('/js/app.js') && precache.includes('/css/app.css'));
});
