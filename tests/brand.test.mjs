// The rename, the logo and the language files. These were three of the reported
// faults, so they are checked as build rules rather than eyeballed once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from './helpers.mjs';
import { LANGS, keysFor, missingIn, translator } from '../public/js/i18n.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const brand = JSON.parse(read('public', 'brand.json'));

const RETIRED = /(?<![A-Za-z])di\s?sha\b/i; // the lookbehind keeps "Odisha" out of it

test('the retired name is gone from everything the browser loads', () => {
  // the build tools and this test may mention the old spelling to explain the
  // rename; nothing that reaches an owner's screen may
  const SURFACES = ['public', 'data', 'src'];
  const allowed = new Set(['public/brand.json']);
  const hits = [];
  const check = (full, rel) => {
    if (allowed.has(rel)) return;
    if (!/\.(js|mjs|css|html|json|webmanifest|svg)$/.test(full)) return;
    fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
      if (RETIRED.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      check(full, path.relative(ROOT, full).replaceAll('\\', '/'));
    }
  };
  for (const dir of SURFACES) walk(path.join(ROOT, dir));
  check(path.join(ROOT, 'server.mjs'), 'server.mjs');
  assert.deepEqual(hits, [], 'the old spelling still reaches the browser');

  assert.equal(brand.name, 'U-Disa');
  assert.deepEqual(brand.retiredNames, ['U-Disha'], 'the rename is recorded in one place');
});

test('brand identity is one source of truth', () => {
  const html = read('public', 'index.html');
  const manifest = JSON.parse(read('public', 'manifest.webmanifest'));
  const css = read('public', 'css', 'brand.css');

  assert.match(html, new RegExp(`<title>${brand.name}</title>`));
  assert.equal(manifest.name, brand.name);
  assert.equal(manifest.short_name, brand.name);
  assert.equal(manifest.theme_color, brand.colors.navy, 'the status bar colour is the logo colour');
  assert.equal(manifest.background_color, brand.colors.paper);
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'Android needs a maskable icon');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));

  for (const [key, token] of [['navy', '--navy'], ['orange', '--orange'], ['paper', '--paper']]) {
    assert.ok(css.includes(`${token}:${brand.colors[key]}`), `brand.css must carry ${token}`);
  }
});

test('every stylesheet variable is actually defined', () => {
  const tokens = new Set([...read('public', 'css', 'brand.css').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const appCss = read('public', 'css', 'app.css');
  const used = new Set([...appCss.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !tokens.has(u));
  assert.deepEqual(missing, [], 'app.css uses colours nobody defines');

  // .boot sets display:grid, which silently beats the hidden attribute and leaves
  // a full-screen overlay on top of a working app
  assert.match(appCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'the hidden attribute must win over display rules');
  const hides = [...read('public', 'index.html').matchAll(/<(\w+)[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]);
  assert.ok(hides.length, 'index.html relies on hidden elements');
});

test('no string reaches the screen untranslated', async (t) => {
  const src = ['public/js/app.js', 'public/js/ui.js'].map((f) => read(...f.split('/'))).join('\n');
  const literal = new Set([...src.matchAll(/\bt\(\s*'([\w.]+)'/g)].map((m) => m[1]));
  const template = [...src.matchAll(/\bt\(\s*`([\w.]+)\$\{/g)].map((m) => m[1]);

  assert.ok(literal.size > 120, `only ${literal.size} UI strings found - the extractor is wrong`);
  for (const lang of LANGS) {
    const tr = translator(lang);
    const missing = [...literal].filter((k) => tr(k) === `!${k}`);
    assert.deepEqual(missing, [], `${lang} is missing strings`);
    assert.ok(keysFor(lang).length > 120, `${lang} dictionary looks truncated`);
  }
  assert.deepEqual(missingIn('hi'), [], 'Hindi is missing keys English has');
  assert.deepEqual(missingIn('en'), [], 'English is the reference dictionary');

  // dynamic key families: list every suffix the app can build at runtime
  const families = {
    'me.sizes.': ['micro', 'small', 'medium'],
    'stock.states.': ['out', 'low', 'ok', 'dead', 'excess'],
    'sig.': ['no-stock', 'stock-out', 'stock-low', 'stock-dead', 'stock-excess', 'stock-healthy', 'receivable', 'payable', 'loss-month', 'profit-month', 'no-ledger'],
    'govt.why.': ['size-match', 'size-mismatch', 'size-unknown', 'amount-fits', 'amount-over', 'amount-under-min', 'limit-lender-set', 'purpose-match', 'announced-only', 'verify-window', 'guarantee-not-loan', 'subsidy-not-loan'],
    'govt.kinds.': ['loan', 'guarantee', 'subsidy', 'invoice-financing', 'bank-product'],
    'govt.status.': ['open', 'announced', 'confirm'],
    'govt.fit.': ['strong', 'possible', 'weak', 'poor'],
    'govt.tag.': ['working-capital', 'machinery', 'expansion', 'equipment', 'vehicle', 'export', 'food-processing', 'artisan', 'street-vendor', 'startup', 'inventory'],
    'health.': ['server', 'assets', 'session', 'storage', 'offline', 'catalog', 'schemes'],
  };
  assert.ok(template.length >= 5, 'the dynamic-key extractor found nothing');
  for (const p of template) assert.ok(p in families, `t(\`${p}...\`) is not covered by this test`);
  for (const [prefix, suffixes] of Object.entries(families)) {
    for (const lang of LANGS) {
      const tr = translator(lang);
      for (const s of suffixes) assert.notEqual(tr(prefix + s), `!${prefix + s}`, `${lang} lacks ${prefix}${s}`);
    }
  }

  await t.test('Hindi strings stay in Devanagari', () => {
    const hi = read('public', 'js', 'i18n.js');
    const block = hi.slice(hi.indexOf("  hi: {"));
    const bad = [...block.matchAll(/'([\w.]+)':\s*'([^']*)'/g)].filter(([, , v]) =>
      /[\u0600-\u06FF\u0980-\u09FF\u0C80-\u0CFF\u0A80-\u0AFF\u0D00-\u0D7F\u0B80-\u0BFF\u0C00-\u0C7F]/.test(v));
    assert.deepEqual(bad.map((m) => m[1]), [], 'other Indic scripts leaked into the Hindi strings');
    const empty = [...block.matchAll(/'([\w.]+)':\s*''/g)].map((m) => m[1]);
    assert.deepEqual(empty, [], 'empty Hindi strings');
  });
});

test('every shipped script actually parses', async () => {
  // A single unbalanced parenthesis is enough to leave an owner staring at the
  // splash screen forever, and no amount of string scanning catches it.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(e.name)) files.push(full);
    }
  };
  for (const d of ['public/js', 'src', 'tools']) walk(path.join(ROOT, d));
  files.push(path.join(ROOT, 'server.mjs'));
  assert.ok(files.length >= 10, `only found ${files.length} scripts`);

  const broken = [];
  for (const f of files) {
    try {
      await run(process.execPath, ['--check', f]);
    } catch (err) {
      broken.push(`${path.relative(ROOT, f)}: ${String(err.stderr ?? err.message).split('\n').slice(0, 3).join(' ')}`);
    }
  }
  assert.deepEqual(broken, [], 'these files would stop the app from opening');
});

test('no HTTP verb is silently mis-routed', () => {
  const src = read('public', 'js', 'app.js');
  // PATCH once fell through to the DELETE branch, so the language button was
  // sending a delete request instead of a profile update
  const used = new Set([...src.matchAll(/\bapi\(\s*'(\w+)'/g)].map((m) => m[1]));
  const supported = new Set([...src.match(/const VERBS = \{([^}]*)\}/)[1].matchAll(/(\w+):/g)].map((m) => m[1]));
  const missing = [...used].filter((m) => !supported.has(m));
  assert.deepEqual(missing, [], `app.js calls verbs the wrapper does not implement: ${missing}`);
  assert.ok(used.has('PATCH'), 'the profile update path should still be exercised');
  assert.ok(!/:\s*await net\.del/.test(src), 'no verb may fall through to delete');
});

test('lists are never handed to replaceChildren as a raw array', () => {
  const src = read('public', 'js', 'app.js');
  assert.ok(!/\.replaceChildren\(/.test(src), 'use fill() - it flattens, replaceChildren() does not');
  assert.match(read('public', 'js', 'ui.js'), /export function fill/);
});

test('a click handler is never handed the event by mistake', () => {
  // `onclick: itemSheet` passes the MouseEvent as itemSheet(existing), which made
  // "Add an item" open in edit mode and fail. Handlers that take arguments must
  // be wrapped, and this catches every one of them at build time.
  const src = read('public', 'js', 'app.js');
  const withParams = new Set();
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    if (m[2].trim()) withParams.add(m[1]);
  }
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g)) {
    if (m[2].trim()) withParams.add(m[1]);
  }
  const offenders = [];
  for (const m of src.matchAll(/\bonclick:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) {
    if (withParams.has(m[1])) offenders.push(`onclick: ${m[1]}`);
  }
  assert.deepEqual(offenders, [], 'these handlers receive the click event as their first argument');
  assert.ok(withParams.size > 10, `only found ${withParams.size} parameterised functions - check the extractor`);
});

test('the app never depends on an image loading to show its logo', () => {
  const html = read('public', 'index.html');
  assert.ok(html.includes('<svg'), 'the mark is inline SVG');
  assert.ok(!/<img[^>]+src="\/icons/.test(html), 'no <img> that can 404 into a broken icon');
  // CSP forbids inline scripts, so nothing may be written that way
  assert.ok(!/<script>(?!\s*<\/script>)/.test(html), 'inline script would be blocked by CSP');
  assert.ok(!/<style>/.test(html), 'inline style block');
  const sw = read('public', 'sw.js');
  assert.match(sw, /startsWith\('\/api\/'\)/, 'the service worker must never cache account data');
  assert.ok(!/caches.*\/api/m.test(sw), 'no /api precache entry');
  // a cached app.js from an older build is the classic "the app stopped opening"
  assert.match(sw, /ALWAYS_NETWORK_FIRST/, 'code must be fetched network-first');
  assert.ok(sw.includes('(js|css|html|json|webmanifest)'), 'the network-first rule must cover the scripts');
  assert.match(sw, /VERSION = 'udisa-v\d+'/, 'the cache is versioned so old entries get dropped');
});

test('every referenced asset really serves, with the right bytes', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const html = read('public', 'index.html');
  const manifest = JSON.parse(read('public', 'manifest.webmanifest'));
  const swSource = read('public', 'sw.js');
  const shellBlock = /const SHELL = \[([\s\S]*?)\];/.exec(swSource);
  assert.ok(shellBlock, 'the service worker precache list was not found');
  const swShell = [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const urls = new Set([
    ...[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('/')),
    ...manifest.icons.map((i) => i.src),
    ...swShell,
  ]);

  for (const url of urls) {
    const res = await fetch(srv.base + url.slice(1));
    assert.equal(res.status, 200, `${url} did not serve`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (url.endsWith('.png')) {
      assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${url} is not a PNG`);
      const declared = /(\d+)x\d+d/.exec(url) || /(?:icon|maskable|favicon|touch)-(\d+)/.exec(url);
      if (declared) {
        const want = Number(declared[1]);
        const got = buf.readUInt32BE(16);
        assert.equal(got, want, `${url} declares ${want}px but is ${got}px`);
      }
      assert.ok(buf.length > 100, `${url} is suspiciously small`);
    }
    if (url.endsWith('.ico')) assert.deepEqual([...buf.subarray(0, 4)], [0, 0, 1, 0], 'favicon.ico header');
    if (url.endsWith('.svg')) assert.match(buf.toString('utf8'), /<svg/);
    if (url.endsWith('.webmanifest') || url.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(buf.toString('utf8')), `${url} is not valid json`);
    const type = res.headers.get('content-type');
    if (url.endsWith('.js')) assert.match(type, /javascript/, `${url} served as ${type} - the browser would refuse it`);
  }

  await t.test('the served html carries the security headers', async () => {
    const res = await fetch(srv.base);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP present');
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  await t.test('path traversal cannot escape the public folder', async () => {
    for (const probe of ['../../etc/passwd', '..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/server.mjs']) {
      const res = await fetch(srv.base + probe, { redirect: 'manual' });
      assert.ok(res.status === 403 || res.status === 404, `${probe} returned ${res.status}`);
      const text = await res.text();
      assert.ok(!text.includes('createServer'), `${probe} leaked source`);
    }
  });
});
