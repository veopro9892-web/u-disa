import fs from 'node:fs';
import { main,openBrowser } from '../server.mjs';

const runtime = new URL('../data/runtime.json',import.meta.url);
let running;
try {
  const saved=JSON.parse(fs.readFileSync(runtime,'utf8'));
  const url=new URL(saved.url);
  if (['localhost','127.0.0.1'].includes(url.hostname) && url.protocol==='http:') {
    const health=await fetch(new URL('/api/health',url),{signal:AbortSignal.timeout(1500)});
    if ((await health.json()).app==='U-Disa') running=url.origin+'/';
  }
} catch {}
if (running) {
  console.log('U-Disa is running at '+running);
  if (!process.argv.includes('--no-browser')) openBrowser(running);
} else {
  await main();
}
