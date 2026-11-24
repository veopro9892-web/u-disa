// Waits for the app to answer, then runs the browser walkthrough.
import { spawnSync } from 'node:child_process';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let up = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(base + 'api/health', { signal: AbortSignal.timeout(1500) });
    if (r.ok) { up = true; break; }
  } catch {}
  await sleep(300);
}
if (!up) {
  console.error('the app is not answering at ' + base);
  process.exit(1);
}
console.log('app is up at', base);

const portFlag = process.argv[3] ?? '--port=9399';
const res = spawnSync(process.execPath, ['tools/browser-shots.mjs', portFlag], { stdio: 'inherit' });
process.exit(res.status ?? 1);
