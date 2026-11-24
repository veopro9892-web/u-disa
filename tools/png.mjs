// Minimal PNG codec (8-bit, non-interlaced) using only node:zlib.
// Supports colour types 0,2,3,4,6 on decode; writes type 2 (RGB) and 6 (RGBA).

import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function decodePng(buf) {
  if (buf.compare(SIG, 0, 8, 0, 8) !== 0) throw new Error('not a PNG file');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG missing IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bit depth ${ihdr.bitDepth}`);
  if (ihdr.interlace) throw new Error('interlaced PNG not supported');

  const chanOf = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = chanOf[ihdr.colorType];
  if (!channels) throw new Error(`unsupported colour type ${ihdr.colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const out = Buffer.alloc(stride * ihdr.height);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`bad filter type ${filter}`);
      cur[x] = v & 255;
    }
  }

  // normalise everything to RGBA so callers never branch on colour type
  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4);
  for (let i = 0, p = 0; i < ihdr.width * ihdr.height; i++) {
    if (ihdr.colorType === 3) {
      const idx = out[i];
      rgba[p++] = palette[idx * 3];
      rgba[p++] = palette[idx * 3 + 1];
      rgba[p++] = palette[idx * 3 + 2];
      rgba[p++] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (channels === 1) {
      const g = out[i];
      rgba[p++] = g; rgba[p++] = g; rgba[p++] = g;
      rgba[p++] = trns && g === trns.readUInt16BE(0) ? 0 : 255;
    } else if (channels === 2) {
      const g = out[i * 2];
      rgba[p++] = g; rgba[p++] = g; rgba[p++] = g;
      rgba[p++] = out[i * 2 + 1];
    } else if (channels === 3) {
      rgba[p++] = out[i * 3]; rgba[p++] = out[i * 3 + 1]; rgba[p++] = out[i * 3 + 2];
      rgba[p++] = 255;
    } else {
      rgba[p++] = out[i * 4]; rgba[p++] = out[i * 4 + 1]; rgba[p++] = out[i * 4 + 2]; rgba[p++] = out[i * 4 + 3];
    }
  }
  return { width: ihdr.width, height: ihdr.height, data: rgba };
}

export function encodePng({ width, height, data, alpha = true }) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (stride + 1) + 1 + x * channels;
      raw[d] = data[s];
      raw[d + 1] = data[s + 1];
      raw[d + 2] = data[s + 2];
      if (alpha) raw[d + 3] = data[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function blank(width, height, rgba = [0, 0, 0, 0]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0]; data[i * 4 + 1] = rgba[1]; data[i * 4 + 2] = rgba[2]; data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

export function crop(img, x0, y0, w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.data.copy(data, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
  }
  return { width: w, height: h, data };
}

export function resize(img, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = img.data[(y0 * img.width + x0) * 4 + c];
        const p10 = img.data[(y0 * img.width + x1) * 4 + c];
        const p01 = img.data[(y1 * img.width + x0) * 4 + c];
        const p11 = img.data[(y1 * img.width + x1) * 4 + c];
        out[o + c] = Math.round((p00 * (1 - wx) + p10 * wx) * (1 - wy) + (p01 * (1 - wx) + p11 * wx) * wy);
      }
    }
  }
  return { width: w, height: h, data: out };
}

// Downsample with an alpha-weighted average so logos with soft edges stay clean.
export function shrink(img, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * img.width + xx) * 4;
          const al = img.data[s + 3] / 255;
          r += img.data[s] * al; g += img.data[s + 1] * al; b += img.data[s + 2] * al;
          a += img.data[s + 3];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      const av = a / n;
      if (av > 0) {
        const k = n * (av / 255) || 1;
        out[o] = Math.round(r / k); out[o + 1] = Math.round(g / k); out[o + 2] = Math.round(b / k);
      }
      out[o + 3] = Math.round(av);
    }
  }
  return { width: w, height: h, data: out };
}

export function flattenOnto(img, [r, g, b]) {
  const data = Buffer.from(img.data);
  for (let i = 0; i < img.width * img.height; i++) {
    const a = data[i * 4 + 3] / 255;
    data[i * 4] = Math.round(data[i * 4] * a + r * (1 - a));
    data[i * 4 + 1] = Math.round(data[i * 4 + 1] * a + g * (1 - a));
    data[i * 4 + 2] = Math.round(data[i * 4 + 2] * a + b * (1 - a));
    data[i * 4 + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

// Windows .ico carrying a PNG payload (Vista+ supports embedded PNG entries).
export function toIco(pngBuf, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size >= 256 ? 0 : size;
  header[7] = size >= 256 ? 0 : size;
  header[8] = 0; header[9] = 0;
  header.writeUInt16LE(32, 10);
  header.writeUInt16LE(1, 12);
  header.writeUInt32LE(pngBuf.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngBuf]);
}
