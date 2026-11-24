// Resolution-independent rebuild of the brand mark (the "U" + gear).
// The full lion artwork turns to mud below ~64px, so small icons and the inline
// SVG fallback are generated from one shared polygon definition. PNG and SVG can
// therefore never drift apart, and the header logo cannot depend on a file load.
import { blank } from './png.mjs';

export const GEO = {
  cx: 0.5,
  armTop: 0.16,
  cy: 0.6,
  R: 0.34,
  T: 0.185,
  gear: { cx: 0.5, cy: 0.465, root: 0.152, tip: 0.203, hole: 0.076, teeth: 8, duty: 0.52 },
};

const arc = (cx, cy, r, a0, a1, steps) => {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
};

export function markPolygons(g = GEO) {
  const { cx, armTop, cy, R, T } = g;
  const u = [
    [cx - R, armTop],
    [cx - R, cy],
    ...arc(cx, cy, R, 180, 0, 64),
    [cx + R, armTop],
    [cx + R - T, armTop],
    [cx + R - T, cy],
    ...arc(cx, cy, R - T, 0, 180, 64),
    [cx - R + T, armTop],
  ];

  const { gear: t } = g;
  const teeth = [];
  const steps = t.teeth * 8;
  for (let i = 0; i < steps; i++) {
    const phase = (i / steps) * t.teeth;
    const frac = phase - Math.floor(phase);
    const r = frac < t.duty ? t.tip : t.root;
    const a = (i / steps) * Math.PI * 2;
    teeth.push([t.cx + r * Math.cos(a), t.cy + r * Math.sin(a)]);
  }
  // square off the tooth flanks: keep only the corner transitions
  const gearPoly = teeth.filter((p, i) => {
    const prev = teeth[(i - 1 + teeth.length) % teeth.length];
    return Math.abs(Math.hypot(p[0] - prev[0], p[1] - prev[1])) > 1e-9;
  });

  const hole = arc(t.cx, t.cy, t.hole, 0, 360, 24).slice(0, -1);
  return { u, gear: gearPoly, hole };
}

const inside = (poly, x, y) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgbHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

const bbox = (poly) => {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

export function simpleMarkPng(size, colors) {
  // point-in-polygon is O(edges); beyond this the SVG is the right tool
  if (size > 96) throw new Error(`simpleMarkPng is capped at 96px (got ${size}) — use simpleMarkSvg for large sizes`);
  const { u, gear, hole } = markPolygons();
  const boxes = { u: bbox(u), gear: bbox(gear), hole: bbox(hole) };
  const inBox = ([x0, y0, x1, y1], x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const navy = hexRgb(colors.navy);
  const top = hexRgb(colors.orange);
  const bottom = hexRgb(colors.orangeDeep);
  const SS = 4;
  const { data } = blank(size * SS, size * SS);
  const inv = 1 / (size * SS);

  for (let py = 0; py < size * SS; py++) {
    for (let px = 0; px < size * SS; px++) {
      let uCov = 0, gCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + sx / SS) * inv;
          const y = (py + sy / SS) * inv;
          if (inBox(boxes.u, x, y) && inside(u, x, y)) uCov++;
          if (inBox(boxes.gear, x, y) && inside(gear, x, y) && !(inBox(boxes.hole, x, y) && inside(hole, x, y))) gCov++;
        }
      }
      const n = SS * SS;
      const o = (py * size * SS + px) * 4;
      if (!uCov && !gCov) continue;
      let r, g, b, a;
      if (gCov >= uCov) {
        [r, g, b] = navy;
        a = gCov;
      } else {
        [r, g, b] = mix(top, bottom, Math.min(1, Math.max(0, (py / SS / size - 0.1) / 0.85)));
        a = uCov;
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = Math.min(255, Math.round((a / n) * 255));
    }
  }
  // box-filter the supersampled grid down to the requested size
  const out = blank(size, size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((py * SS + sy) * size * SS + px * SS + sx) * 4;
          r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3];
        }
      }
      const o = (py * size + px) * 4;
      const k = SS * SS;
      out.data[o] = Math.round(r / k);
      out.data[o + 1] = Math.round(g / k);
      out.data[o + 2] = Math.round(b / k);
      out.data[o + 3] = Math.round(a / k);
    }
  }
  return out;
}

const toPath = (poly, scale = 512) =>
  poly.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * scale).toFixed(2)} ${(y * scale).toFixed(2)}`).join('') + 'Z';

export function simpleMarkSvg(colors, size = 512) {
  const { u, gear, hole } = markPolygons();
  const s = (v) => (v * size).toFixed(2);
  const uPath =
    `M${s(GEO.cx - GEO.R)} ${s(GEO.armTop)}L${s(GEO.cx - GEO.R)} ${s(GEO.cy)}` +
    `A${s(GEO.R)} ${s(GEO.R)} 0 0 0 ${s(GEO.cx + GEO.R)} ${s(GEO.cy)}` +
    `L${s(GEO.cx + GEO.R)} ${s(GEO.armTop)}L${s(GEO.cx + GEO.R - GEO.T)} ${s(GEO.armTop)}` +
    `L${s(GEO.cx + GEO.R - GEO.T)} ${s(GEO.cy)}` +
    `A${s(GEO.R - GEO.T)} ${s(GEO.R - GEO.T)} 0 0 1 ${s(GEO.cx - GEO.R + GEO.T)} ${s(GEO.cy)}` +
    `L${s(GEO.cx - GEO.R + GEO.T)} ${s(GEO.armTop)}Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="U-Disa">
<defs><linearGradient id="udisa-u" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${colors.orange}"/><stop offset="1" stop-color="${colors.orangeDeep}"/>
</linearGradient></defs>
<path d="${uPath}" fill="url(#udisa-u)"/>
<path fill-rule="evenodd" fill="${colors.navy}" d="${toPath(gear, size)}${toPath(hole, size)}"/>
</svg>`;
}

export { rgbHex, mix, hexRgb };
