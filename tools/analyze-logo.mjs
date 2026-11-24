import fs from 'node:fs';
import { decodePng } from './png.mjs';

const src = process.argv[2];
const img = decodePng(fs.readFileSync(src));
const { width, height, data } = img;

const bg = [data[0], data[1], data[2]];
const isFg = (i) => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 24;

const rows = [];
for (let y = 0; y < height; y++) {
  let n = 0;
  for (let x = 0; x < width; x++) if (isFg((y * width + x) * 4)) n++;
  rows.push(n);
}
const cols = [];
for (let x = 0; x < width; x++) {
  let n = 0;
  for (let y = 0; y < height; y++) if (isFg((y * width + x) * 4)) n++;
  cols.push(n);
}

const filled = rows.map((n, y) => (n > 2 ? y : -1)).filter((y) => y >= 0);
const top = filled[0];
const bottom = filled[filled.length - 1];
const left = cols.map((n, x) => (n > 2 ? x : -1)).filter((x) => x >= 0)[0];
const right = cols.map((n, x) => (n > 2 ? x : -1)).filter((x) => x >= 0).pop();

// largest empty horizontal band inside the inked area = mark / wordmark divider
let best = { gap: 0, from: 0, to: 0 };
let run = 0, start = 0;
for (let y = top; y <= bottom; y++) {
  if (rows[y] <= 2) { if (!run) start = y; run++; if (run > best.gap) best = { gap: run, from: start, to: y }; }
  else run = 0;
}

const counts = new Map();
for (let i = 0; i < data.length; i += 4) {
  if (!isFg(i)) continue;
  const key = `${data[i] >> 4 << 4},${data[i + 1] >> 4 << 4},${data[i + 2] >> 4 << 4}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}
const palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

console.log(JSON.stringify({
  width, height,
  background: bg.map((v) => v.toString(16).padStart(2, '0')).join(''),
  inkBox: { top, bottom, left, right },
  largestInnerGap: best,
  palette: palette.map(([k, n]) => ({
    hex: k.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join(''),
    pct: +(n / [...counts.values()].reduce((a, b) => a + b, 0) * 100).toFixed(1),
  })),
}, null, 2));
