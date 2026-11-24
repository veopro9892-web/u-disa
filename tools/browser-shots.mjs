// A dependency-free Chrome driver (DevTools protocol over WebSocket).
// Used to prove the real app works in a real browser and to capture the screens.
//   node tools/browser-shots.mjs [--base http://127.0.0.1:4173/] [--out docs/screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const BASE = typeof argv.base === 'string' ? argv.base : 'http://127.0.0.1:4173/';
const OUT = path.join(ROOT, typeof argv.out === 'string' ? argv.out : 'docs/screenshots');
// `--port 9344` arrives as a bare flag, so only take a numeric value
const PORT = Number(typeof argv.port === 'string' ? argv.port : (argv.port === true ? 9333 : 9333));

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('No Chrome or Edge found. Pass --base to a running app or set CHROME_PATH.');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'udisa-shots-'));

const chrome = spawn(exe, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--disable-extensions',
  '--disable-background-networking',
  '--hide-scrollbars',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not expose a debugging endpoint');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  open() {
    return new Promise((resolve) => {
      if (this.ws.readyState === 1) return resolve();
      this.ws.addEventListener('open', resolve, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitFor(eventMethod, timeoutMs = 20000) {
    return this.waitForAny([eventMethod], timeoutMs, eventMethod);
  }

  async waitForAny(methods, timeoutMs = 20000, label = methods.join('/')) {
    const deadline = Date.now() + timeoutMs;
    const seen = () => this.events.some((e) => methods.includes(e.method));
    while (!seen()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(50);
    }
  }

  clearEvents() {
    this.events.length = 0;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

const target = await waitForTarget();
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 892, deviceScaleFactor: 2, mobile: true });
await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });

const consoleErrors = [];
cdp.ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
  }
});
await cdp.send('Log.enable');

const goto = async (url) => {
  cdp.clearEvents();
  await cdp.send('Page.navigate', { url });
  // a hash-only change is a same-document navigation: no load event, only frameStopped
  await cdp.waitForAny(['Page.loadEventFired', 'Page.frameStoppedLoading'], 15000);
  await sleep(700);
};

const js = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  wrote', path.relative(ROOT, file));
};

const clickText = (text) => js(`(() => {
  const el = [...document.querySelectorAll('button, a')].find(e => e.textContent.trim().includes(${JSON.stringify(text)}));
  if (!el) return 'NOT FOUND: ' + ${JSON.stringify(text)};
  el.click();
  return 'clicked';
})()`);

const typeInto = (label, value) => js(`(() => {
  const lab = [...document.querySelectorAll('label.f')].find(l => l.querySelector('span')?.textContent.includes(${JSON.stringify(label)}));
  const input = lab?.querySelector('input, textarea, select');
  if (!input) return 'NOT FOUND: ' + ${JSON.stringify(label)};
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  return 'typed';
})()`);

const pickChip = (text) => js(`(() => {
  const chip = [...document.querySelectorAll('.chip')].find(c => c.textContent.includes(${JSON.stringify(text)}));
  if (!chip) return 'NOT FOUND: ' + ${JSON.stringify(text)};
  const input = chip.querySelector('input');
  chip.click();
  if (input) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); }
  return 'picked';
})()`);

const bodyText = (n = 700) => js(`(document.querySelector("main")?.innerText ?? document.body.innerText).slice(0, ${n})`);
const overlayBlocks = () => js(`(() => {
  const b = document.getElementById('boot');
  const app = document.getElementById('app');
  if (!b) return 'no boot element';
  const bootVisible = getComputedStyle(b).display !== 'none';
  const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  const coveredByBoot = !!mid && b.contains(mid);
  return { bootVisible, coveredByBoot, appHidden: app ? app.hidden : null, atCentre: mid ? mid.tagName + '.' + mid.className : 'none' };
})()`);

const results = [];
// each run registers its own business so repeat runs do not collide
const stamp = String(Date.now()).slice(-9);
const PHONE = `9${stamp}`;
const UDYAM = 'UDYAM-MH-01-'+stamp.slice(-7).padStart(7,'0');
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 220) });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${String(detail).slice(0, 160)}` : ''}`);
};

console.log('\nU-Disa browser walkthrough\n');

const sheetTitle = () => js("document.querySelector('.sheet h2')?.textContent ?? ''");
const stockQty = (name) => js(`(() => {
  const li = [...document.querySelectorAll('#app li')].find(e => e.textContent.includes(${JSON.stringify(name)}));
  return li ? li.innerText.replace(/\\s+/g, ' ').slice(0, 160) : 'ROW NOT FOUND';
})()`);

/** Clicks the real bottom tab bar, so the navigation itself is under test. */
const clickTab = (label) => js(`(() => {
  const btn = [...document.querySelectorAll('nav.tabs button')].find(b => b.textContent.includes(${JSON.stringify(label)}));
  if (!btn) return 'TAB NOT FOUND';
  btn.click();
  return 'clicked';
})()`);

// ---------------------------------------------------------------- public screens
await goto(BASE);
const overlay = await overlayBlocks();
check('splash screen is gone once the app renders', overlay.bootVisible === false && overlay.coveredByBoot === false, JSON.stringify(overlay));
check('welcome screen is showing', (await bodyText()).includes('Namaste'));
await shot('01-welcome');

await clickText('New here');
await sleep(400);
check('register opens step 1', (await bodyText()).includes('Udyam'), await bodyText());
await shot('02-register-step1');

// step 1 validation must refuse and explain
await clickText('Next');
await sleep(300);
const errText = await js('[...document.querySelectorAll(".err")].filter(e => !e.hidden).map(e => e.textContent).join(" | ")');
check('empty step 1 is refused with field messages', errText.length > 5, errText);

await typeInto('Business name', 'Shree Krishna Kirana');
await typeInto('Your name', 'Vinayak Kumar');
await typeInto('Mobile number', PHONE);
await typeInto('Udyam registration', UDYAM);
await clickText('Next');
await sleep(400);
check('step 2 opens after valid details', (await bodyText()).includes('Type of organisation'), await bodyText());
await shot('03-register-step2');

// every option in step 2 must be selectable
check('organisation type picks', (await pickChip('Proprietorship')) === 'picked');
check('activity picks', (await pickChip('Trading')) === 'picked');
await sleep(300);
const nicSearch = await js(`(() => { const i = document.querySelector('input[type=search]'); if (!i) return 'no search box'; i.value = 'kirana'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
await sleep(300);
check('typing "kirana" finds retail trade', nicSearch === 'ok' && (await bodyText()).toLowerCase().includes('retail'), await js("document.querySelector('[data-name=nic_code]')?.innerText.slice(0,200)"));
check('activity option picks', (await pickChip('47')) === 'picked');
check('state option picks', (await pickChip('Uttar Pradesh')) === 'picked');
await clickText('Next');
await sleep(400);
check('step 3 opens', (await bodyText()).includes('Password'), await bodyText());
await shot('04-register-step3');

await typeInto('Password', 'kirana1234');
await typeInto('Type the password again', 'kirana1234');
await typeInto('Investment', '400000');
await typeInto('Last year turnover', '2500000');
await clickText('Register');
await sleep(1400);
const dash = await bodyText();
check('registration lands on the dashboard', dash.includes('Namaste') && dash.includes('Shree Krishna Kirana'), dash);
await shot('05-dashboard');

const token = await js('localStorage.getItem("udisa.token") ? "stored" : "MISSING"');
check('session token survives a reload', token === 'stored', token);
await goto(BASE);
await sleep(900);
const afterReload = await bodyText();
check('reload keeps the owner logged in', afterReload.includes('Shree Krishna Kirana'), afterReload.slice(0, 160));

// ---------------------------------------------------------------- data entry
await clickText('Money in');
await sleep(400);
check('money-in sheet opens', (await sheetTitle()).includes('Add money in'), await sheetTitle());
await typeInto('Amount', '1500');
await js("(() => { const b=[...document.querySelectorAll('.sheet .btn-primary')].pop(); b && b.click(); return 1 })()");
await sleep(900);
check('money-in entry saved', (await bodyText()).includes('1,500'), (await bodyText()).slice(0, 200));

await clickText('Money out');
await sleep(400);
await typeInto('Amount', '600');
await js("(() => { const b=[...document.querySelectorAll('.sheet .btn-primary')].pop(); b && b.click(); return 1 })()");
await sleep(900);
check('money-out entry saved', (await bodyText()).includes('600'), (await bodyText()).slice(0, 200));
await shot('06-dashboard-with-money');

check('the stock tab opens', (await clickTab('Stock')) === 'clicked');
await sleep(700);
check('stock tab renders', (await bodyText(2000)).includes('Add an item'), (await bodyText(2000)).slice(0, 200));
await clickText('Add an item');
await sleep(400);
await typeInto('Item name', 'Biscuit Box');
await typeInto('You buy at', '40');
await typeInto('You sell at', '50');
await typeInto('Stock you have right now', '120');
await typeInto('Alert me when', '30');
await js("(() => { const b=[...document.querySelectorAll('.sheet .btn-primary')].pop(); b && b.click(); return 1 })()");
await sleep(1000);
const afterAdd = await stockQty('Biscuit Box');
check('item saved with the opening balance counted once', /120/.test(afterAdd) && !/9,600/.test(await bodyText(3000)), afterAdd);
await shot('07-stock');

await clickText('Stock out');
await sleep(400);
await typeInto('Quantity', '25');
await js("(() => { const b=[...document.querySelectorAll('.sheet .btn-primary')].pop(); b && b.click(); return 1 })()");
await sleep(1000);
const afterSale = await stockQty('Biscuit Box');
check('stock sale reduces the quantity', /95/.test(afterSale), afterSale);
await shot('08-stock-after-sale');

// ---------------------------------------------------------------- schemes
await clickTab('Schemes');
await sleep(1400);
const govt = await bodyText(2000);
check('scheme list loads with matches', /Mudra|CGTMSE|Best for you/i.test(govt), govt.slice(0, 240));
await shot('09-schemes');

await js("(() => { const c=[...document.querySelectorAll('.scheme')][0]; c && c.click(); return 1 })()");
await sleep(1200);
const detail = await bodyText(4000);
check('scheme detail shows papers and steps', /Papers you need|How to apply/i.test(detail), detail.slice(0, 240));
check('scheme detail carries its caution', /Please note|Open official site/.test(detail), detail.slice(0, 200));
await shot('10-scheme-detail');

await js("(() => { const i=document.querySelector('.check input'); i && i.click(); return 1 })()");
await sleep(900);
const ticked = await js("document.querySelector('.check.done')?.innerText ?? ''");
check('document checklist ticks', ticked.length > 3, ticked);
const schemeHash = await js("location.hash");
await js("(() => { const b=[...document.querySelectorAll('.btn-ghost')].find(x=>x.textContent.includes('Back')); b&&b.click(); return 1 })()");
await sleep(900);
await goto(`${BASE}${schemeHash}`);
const reopened = await js("document.querySelector('.check.done')?.innerText ?? 'NOTHING TICKED'");
check('the tick survives leaving and coming back', reopened === ticked, `${reopened} vs ${ticked}`);

// ---------------------------------------------------------------- language
await clickTab('Home');
await sleep(700);
await clickText('हिंदी');
await sleep(1200);
const hindi = await bodyText(2500);
check('Hindi switch works', /[\u0900-\u097F]/.test(hindi) && /नमस्ते|हिसाब|स्टॉक/.test(hindi), hindi.slice(0, 200));
await shot('11-hindi');
const hindiSaved = await js("fetch('/api/me',{headers:{Authorization:'Bearer '+localStorage.getItem('udisa.token')}}).then(r=>r.json()).then(j=>j.user?.lang)");
check('the language choice is saved to the account', hindiSaved === 'hi', String(hindiSaved));
await clickText('English');
await sleep(800);

// ---------------------------------------------------------------- profile + health
check('the profile tab opens', (await clickTab('Profile')) === 'clicked');
await sleep(900);
check('profile shows the enterprise size', /Micro|enterprise size/i.test(await bodyText()), (await bodyText()).slice(0, 200));
await js("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('App health')); b&&b.click(); return 1 })()");
await sleep(3500);
const health = await js("document.getElementById('health-results')?.innerText ?? 'PANEL NOT FOUND'");
const wanted = ['App server', 'Logo and icons', 'Login session', 'Saved data', 'Works without internet', 'Business type options', 'Scheme list'];
const absent = wanted.filter((w) => !health.includes(w));
check('health panel reports every check', absent.length === 0, absent.length ? `missing ${absent.join(', ')}` : 'all seven listed');
check('health panel finds no failures', !/❌/.test(health) && health.includes('All checks passed'), health.replace(/\s+/g, ' ').slice(0, 260));
await shot('12-profile-health');

// ---------------------------------------------------------------- offline
const swState = await js(`(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { active: !!(r && r.active), controlled: !!navigator.serviceWorker.controller };
})()`);
check('service worker installed for offline use', swState.controlled || swState.active, JSON.stringify(swState));

cdp.close();
chrome.kill();
await sleep(600);
// Chrome can still be releasing the profile directory when it exits
try {
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 });
} catch (err) {
  console.log(`  (could not delete the temporary browser folder: ${err.code ?? err.message})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (consoleErrors.length) {
  console.log('\nConsole errors seen in the browser:');
  for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log('  ! ' + e.slice(0, 220));
}
if (failed.length) {
  console.log('\nFailed:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), results, consoleErrors: [...new Set(consoleErrors)] }, null, 2));
process.exit(failed.length || consoleErrors.length ? 1 : 0);
