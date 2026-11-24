// Derives every app icon and the brand palette from assets/brand/logo-source.png.
// The supplied artwork still carries the retired "U-DISHA" wordmark, so we crop
// above it and let the UI render the current name as text — no stale spelling can
// then survive anywhere in the build.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, crop, shrink, blank, flattenOnto, toIco } from './png.mjs';
import { simpleMarkPng, simpleMarkSvg } from './simple-mark.mjs';

const root = path.resolve(import.meta.dirname, '..');
const SRC = path.join(root, 'assets', 'brand', 'logo-source.png');
const OUT = path.join(root, 'public', 'icons');

const img = decodePng(fs.readFileSync(SRC));
const { width, height, data } = img;

const paper = [data[0], data[1], data[2]];
const isFg = (i) => Math.abs(data[i] - paper[0]) + Math.abs(data[i + 1] - paper[1]) + Math.abs(data[i + 2] - paper[2]) > 24;

const rowInk = Array.from({ length: height }, (_, y) => {
  let n = 0;
  for (let x = 0; x < width; x++) if (isFg((y * width + x) * 4)) n++;
  return n;
});
const colInk = Array.from({ length: width }, (_, x) => {
  let n = 0;
  for (let y = 0; y < height; y++) if (isFg((y * width + x) * 4)) n++;
  return n;
});

const inkRows = rowInk.map((n, y) => (n > 2 ? y : -1)).filter((y) => y >= 0);
const inkCols = colInk.map((n, x) => (n > 2 ? x : -1)).filter((x) => x >= 0);
const box = { top: inkRows[0], bottom: inkRows.at(-1), left: inkCols[0], right: inkCols.at(-1) };

// widest empty horizontal band inside the artwork = divider above the wordmark
let gap = { len: 0, from: 0, to: 0 };
for (let run = 0, start = 0, y = box.top; y <= box.bottom; y++) {
  if (rowInk[y] <= 2) {
    if (!run) start = y;
    run++;
    if (run > gap.len) gap = { len: run, from: start, to: y };
  } else run = 0;
}
if (gap.len < 8) throw new Error('no wordmark divider found — refusing to crop blindly');
if (gap.from < height * 0.4) throw new Error('divider sits too high to be a wordmark gap');

const markBox = { top: box.top, bottom: gap.from - 1, left: box.left, right: box.right };
const mark = crop(img, markBox.left, markBox.top, markBox.right - markBox.left + 1, markBox.bottom - markBox.top + 1);

function square(source, side, padRatio = 0.06) {
  const canvas = blank(side, side, [0, 0, 0, 0]);
  const usable = Math.floor(side * (1 - padRatio * 2));
  const scale = Math.min(usable / source.width, usable / source.height);
  const w = Math.round(source.width * scale);
  const h = Math.round(source.height * scale);
  const sized = shrink(source, w, h);
  const ox = Math.floor((side - w) / 2);
  const oy = Math.floor((side - h) / 2);
  for (let y = 0; y < h; y++) sized.data.copy(canvas.data, ((y + oy) * side + ox) * 4, y * w * 4, (y + 1) * w * 4);
  return { width: side, height: side, data: canvas.data };
}

// dominant hues straight out of the artwork
const tally = new Map();
for (let i = 0; i < data.length; i += 4) {
  if (!isFg(i)) continue;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const warm = r > 180 && r - b > 60;
  const cool = b > 60 && b - r > 20;
  if (!warm && !cool) continue;
  const key = (warm ? 'w' : 'c') + ((r >> 3) << 10 | (g >> 3) << 5 | (b >> 3));
  tally.set(key, (tally.get(key) || 0) + 1);
}
const hex = (v) => '#' + v.map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
const pick = (prefix) => {
  const best = [...tally.entries()].filter(([k]) => k[0] === prefix).sort((a, b) => b[1] - a[1])[0];
  if (!best) throw new Error(`no ${prefix}-family colour in the logo`);
  const p = Number(best[0].slice(1));
  return [((p >> 10) & 31) * 8 + 4, ((p >> 5) & 31) * 8 + 4, (p & 31) * 8 + 4];
};
const darken = (c, [dr, dg, db]) => c.map((v, i) => v - [dr, dg, db][i]);

const navy = hex(pick('c'));
const orange = hex(pick('w'));
const orangeDeep = hex(darken(pick('w'), [16, 44, 12]));
const navyInk = hex(darken(pick('c'), [4, 12, 18]));
const paperHex = hex(paper);
const colors = { navy, orange, orangeDeep, navyInk, paper: paperHex };

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(root, 'public', 'img'), { recursive: true });
fs.mkdirSync(path.join(root, 'public', 'css'), { recursive: true });

const detailed = [
  ['icon-512.png', square(mark, 512), true],
  ['icon-192.png', square(mark, 192), true],
  ['icon-152.png', square(mark, 152), true],
  ['logo-mark.png', square(mark, 256, 0.02), true],
  ['apple-touch-icon.png', flattenOnto(square(mark, 180, 0.08), paper), false],
  ['maskable-512.png', flattenOnto(square(mark, 512, 0.22), paper), false],
  ['maskable-192.png', flattenOnto(square(mark, 192, 0.22), paper), false],
];
// below ~64px the lion detail collapses, so favicons use the rebuilt geometry
const simple = [['favicon-16.png', 16], ['favicon-32.png', 32], ['favicon-48.png', 48]];

const written = [];
for (const [name, im, alpha] of detailed) {
  fs.writeFileSync(path.join(OUT, name), encodePng({ ...im, alpha }));
  written.push(`icons/${name}`);
}
for (const [name, size] of simple) {
  fs.writeFileSync(path.join(OUT, name), encodePng(simpleMarkPng(size, colors)));
  written.push(`icons/${name}`);
}
fs.writeFileSync(path.join(OUT, 'mark-simple-96.png'), encodePng(simpleMarkPng(96, colors)));
fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), toIco(encodePng(simpleMarkPng(32, colors)), 32));
fs.writeFileSync(path.join(root, 'public', 'img', 'mark.svg'), simpleMarkSvg(colors) + '\n');

const brand = {
  name: 'U-Disa',
  retiredNames: ['U-Disha'],
  colors,
  markBox,
  wordmarkDivider: gap,
  sourcePixels: { width, height },
};
fs.writeFileSync(path.join(root, 'public', 'brand.json'), JSON.stringify(brand, null, 2) + '\n');

fs.writeFileSync(
  path.join(root, 'public', 'css', 'brand.css'),
  `/* Generated by tools/make-icons.mjs from assets/brand/logo-source.png — do not hand-edit. */
:root{
  --navy:${navy};
  --navy-ink:${navyInk};
  --orange:${orange};
  --orange-deep:${orangeDeep};
  --paper:${paperHex};
  --paper-shade:${hex(darken(paper, [6, 6, 8]))};
}\n`
);

console.log(JSON.stringify({ brand, written: ['favicon.ico', 'img/mark.svg', 'css/brand.css', ...written] }, null, 2));
