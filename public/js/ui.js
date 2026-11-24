import {businessDay} from './day.js';
// Small DOM toolkit. Everything goes through h() and text nodes, so a shop name
// typed by an owner can never be read back as markup.

export const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false || (v === '' && k !== 'value')) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv; }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

export const $ = (sel) => document.querySelector(sel);

/**
 * replaceChildren() turns an array into the literal text "[object HTMLDivElement]",
 * which is an easy mistake to make when rendering a list. This flattens first.
 */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(9).filter((k) => k != null && k !== false && k !== ''));
  return el;
}

export function groupIndian(n, { decimals = true } = {}) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  const neg = num < 0;
  const fixed = Math.abs(num).toFixed(decimals ? 2 : 0);
  const [int, dec] = fixed.split('.');
  let s = int;
  if (s.length > 3) {
    const last3 = s.slice(-3);
    s = `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  return `${neg ? '-' : ''}${s}${dec && decimals ? `.${dec}` : ''}`;
}

export function lakhCrore(rupees) {
  const a = Math.abs(rupees);
  if (a >= 1e7) return `${(rupees / 1e7).toFixed(2).replace(/\.?0+$/, '')} crore`;
  if (a >= 1e5) return `${(rupees / 1e5).toFixed(2).replace(/\.?0+$/, '')} lakh`;
  return null;
}

export const money = (paise, { compact = false } = {}) => {
  const r = (Number(paise) || 0) / 100;
  const main = `₹${groupIndian(r)}`;
  if (!compact) return main;
  const lc = lakhCrore(r);
  return lc ? `${main} (${lc})` : main;
};

export const rupees = (paise) => (Number(paise) || 0) / 100;

export function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[,\s₹]/g, '');
  if (!s) return null;
  if (!/^-?\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const qtyText = (q, unit) => `${groupIndian(q, { decimals: !Number.isInteger(Number(q)) })} ${unit ?? ''}`.trim();

export const today = businessDay;
export const thisMonth = () => today().slice(0, 7);
export const monthOf = (d) => String(d ?? '').slice(0, 7);

export const MONTHS_HI = ['जन', 'फर', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुला', 'अग', 'सित', 'अक्टू', 'नव', 'दिस'];
export const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthName(ym, lang) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ''));
  if (!m) return String(ym ?? '');
  const names = lang === 'hi' ? MONTHS_HI : MONTHS_EN;
  return `${names[Number(m[2]) - 1]} ${m[1]}`;
}

export function dayLabel(iso, lang) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const t = today();
  if (iso === t) return lang === 'hi' ? 'आज' : 'Today';
  const y = businessDay(new Date(Date.now() - 86400_000));
  if (iso === y) return lang === 'hi' ? 'कल' : 'Yesterday';
  return `${String(d.getDate()).padStart(2, '0')} ${monthName(iso.slice(0, 7), lang)}`;
}

export const uid = () => crypto.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = crypto.getRandomValues(new Uint8Array(1))[0] & 15; return (c === 'x' ? n : (n & 3) | 8).toString(16); });

const MARK_PATHS = `<defs><linearGradient id="udisa-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fc5c0c"/><stop offset="1" stop-color="#ec3000"/></linearGradient></defs>
<path d="M81.92 81.92L81.92 307.20A174.08 174.08 0 0 0 430.08 307.20L430.08 81.92L335.36 81.92L335.36 307.20A79.36 79.36 0 0 1 176.64 307.20L176.64 81.92Z" fill="url(#udisa-grad)"/>
<path fill-rule="evenodd" fill="#04346c" d="M359.94 238.08L359.44 248.27L357.94 258.36L355.46 268.25L352.02 277.85L324.63 274.77L320.71 281.32L316.16 287.45L329.49 311.57L321.94 318.42L313.74 324.50L305.00 329.74L295.77 334.10L278.59 312.55L271.18 314.41L263.63 315.53L256.00 342.02L245.81 341.52L235.72 340.02L225.83 337.54L216.23 334.10L219.31 306.71L212.76 302.79L206.63 298.24L182.51 311.57L175.66 304.02L169.58 295.82L164.34 287.08L159.98 277.85L181.53 260.67L179.67 253.26L178.55 245.71L152.06 238.08L152.56 227.89L154.06 217.80L156.54 207.91L159.98 198.31L187.37 201.39L191.29 194.84L195.84 188.71L182.51 164.59L190.06 157.74L198.26 151.66L207.00 146.42L216.23 142.06L233.41 163.61L240.82 161.75L248.37 160.63L256.00 134.14L266.19 134.64L276.28 136.14L286.17 138.62L295.77 142.06L292.69 169.45L299.24 173.37L305.37 177.92L329.49 164.59L336.34 172.14L342.42 180.34L347.66 189.08L352.02 198.31L330.47 215.49L332.33 222.90L333.45 230.45ZM294.91 238.08L293.59 248.15L289.70 257.54L283.51 265.59L275.46 271.78L266.07 275.67L256.00 276.99L245.93 275.67L236.54 271.78L228.49 265.59L222.30 257.54L218.41 248.15L217.09 238.08L218.41 228.01L222.30 218.62L228.49 210.57L236.54 204.38L245.93 200.49L256.00 199.17L266.07 200.49L275.46 204.38L283.51 210.57L289.70 218.62L293.59 228.01Z"/>`;

export function logoMark(size, name = 'U-Disa') {
  // inline SVG: the brand cannot vanish because one image request failed
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 512 512');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', name);
  // Parse in SVG context so paths become paintable SVGPathElement nodes.
  svg.innerHTML = MARK_PATHS;
  return svg;
}

export function speak(text, lang = 'en') {
  if (!('speechSynthesis' in window)) return false;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/[₹]/g, ' rupees '));
    u.lang = lang === 'hi' ? 'hi-IN' : 'en-IN';
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

let toastTimer;
export function toast(t, msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

export function sheet(title, body, actions) {
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'grab' }),
    h('h2', null, title),
    body,
    actions ? h('div', { class: 'sheet-actions' }, actions) : null
  );
  const bg = h('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) close(); } }, card);
  document.body.append(bg);
  document.addEventListener('keydown', onKey);
  setTimeout(() => card.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 60);
  return { close, card };
}

export function confirmSheet(title, message, confirmLabel, danger = true) {
  return new Promise((resolve) => {
    let out = false;
    const s = sheet(title, h('p', { class: 'muted' }, message), [
      h('button', { class: 'btn btn-ghost', onclick: () => { out = false; s.close(); } }, '✕'),
      h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { out = true; s.close(); } }, confirmLabel),
    ]);
    const watch = setInterval(() => {
      if (!s.card.isConnected) { clearInterval(watch); resolve(out); }
    }, 40);
  });
}

export function emptyBox(icon, text, ...extra) {
  return h('div', { class: 'empty' }, h('div', { class: 'ico' }, icon), h('p', null, text), ...extra);
}

export function badge(text, kind = 'info') {
  return h('span', { class: `badge b-${kind}` }, text);
}

/**
 * Options render through here only, so no list can quietly grow a dead entry.
 */
export function picker({ name, options, value, multiple = false, columns = false, label, onPick, labelOf }) {
  const inputs = new Map();
  const read = () => (multiple
    ? [...inputs].filter(([, i]) => i.checked).map(([k]) => k)
    : ([...inputs].find(([, i]) => i.checked)?.[0] ?? null));
  const wrap = h('div', { class: columns ? 'chips chip-col' : 'chips', role: multiple ? 'group' : 'radiogroup', 'aria-label': label ?? name });
  for (const o of options) {
    const id = o.id ?? o.code;
    const input = h('input', {
      type: multiple ? 'checkbox' : 'radio', name, value: id,
      checked: multiple ? (value ?? []).includes(id) : id === value,
    });
    inputs.set(id, input);
    input.addEventListener('change', () => { if (onPick) onPick(read()); });
    wrap.append(h('label', { class: 'chip' },
      input,
      o.icon ? h('span', { class: 'ico' }, o.icon) : null,
      h('span', null, labelOf ? labelOf(o) : (o.en ?? id)),
      o.short ? h('small', null, o.short) : null
    ));
  }
  if (!options.length) wrap.append(h('p', { class: 'err' }, '—'));
  return { node: wrap, get: read, set: (v) => { const i = inputs.get(v); if (i) i.checked = true; } };
}

/**
 * Declarative form. `kind: 'picker'` fields keep the same get/set surface as
 * inputs, so a screen cannot forget to read one of them.
 */
export function makeForm(specs) {
  const fields = new Map();
  const nodes = specs.map((s) => {
    const err = h('span', { class: 'err', hidden: true });
    const setErr = (m) => {
      err.hidden = !m;
      err.textContent = m ?? '';
      const f = fields.get(s.name);
      if (f?.anchor) f.anchor.setAttribute('aria-invalid', m ? 'true' : 'false');
    };
    let control;
    let anchor;
    if (s.kind === 'picker' || s.kind === 'picker-multi') {
      const p = picker({
        name: s.name,
        options: typeof s.options === 'function' ? s.options() : s.options,
        value: s.kind === 'picker-multi' ? s.value : (s.value ?? null),
        multiple: s.kind === 'picker-multi',
        columns: s.columns,
        label: s.label,
        onPick: s.onChange,
        labelOf: s.labelOf,
      });
      control = p.node;
      anchor = p.node;
      fields.set(s.name, { get: p.get, set: p.set, setErr, anchor });
    } else if (s.kind === 'select') {
      const sel = h('select', { name: s.name, id: `f-${s.name}` });
      for (const o of (typeof s.options === 'function' ? s.options() : s.options) ?? []) {
        sel.append(h('option', { value: o.id ?? o.code, selected: (o.id ?? o.code) === s.value },
          `${o.icon ? `${o.icon} ` : ''}${s.labelOf ? s.labelOf(o) : (o.en ?? '')}`));
      }
      control = sel;
      anchor = sel;
      fields.set(s.name, { get: () => sel.value, set: (v) => { sel.value = v; }, setErr, anchor });
    } else if (s.kind === 'textarea') {
      const ta = h('textarea', { name: s.name, id: `f-${s.name}`, placeholder: s.placeholder });
      ta.value = s.value ?? '';
      control = ta;
      anchor = ta;
      fields.set(s.name, { get: () => ta.value, set: (v) => { ta.value = v ?? ''; }, setErr, anchor });
    } else {
      const input = h('input', {
        name: s.name, id: `f-${s.name}`, type: s.inputType ?? 'text',
        inputmode: s.inputmode, autocomplete: s.autocomplete, placeholder: s.placeholder,
        value: s.value ?? '',
      });
      if (s.onInput) input.addEventListener('input', () => s.onInput(input.value));
      if (s.draftKey) {
        const saved = readDraft(s.draftKey);
        if (saved != null && !s.value) input.value = saved;
        input.addEventListener('blur', () => writeDraft(s.draftKey, input.value));
      }
      control = input;
      anchor = input;
      fields.set(s.name, {
        get: () => input.value,
        set: (v) => { input.value = v ?? ''; },
        setErr,
        anchor,
        focus: () => input.focus(),
      });
    }
    const help = s.help ? h('span', { class: 'help' }, s.help) : null;
    const label = s.label
      ? h('label', { class: 'f', for: s.kind?.startsWith('picker') ? undefined : `f-${s.name}` },
        h('span', null, `${s.label}${s.required ? ' *' : ''}`), control, help)
      : h('div', { class: 'f' }, control, help);
    return h('div', {}, label, err);
  });

  return {
    node: h('div', {}, ...nodes),
    get: () => Object.fromEntries([...fields].map(([k, f]) => [k, f.get()])),
    set(name, v) { fields.get(name)?.set(v); },
    showErrors(map = {}) {
      for (const [k, f] of fields) f.setErr(map[k] ?? '');
      const first = Object.keys(map)[0];
      if (first) fields.get(first)?.anchor?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    focusFirst() { for (const f of fields.values()) if (f.focus) { f.focus(); break; } },
    fields,
  };
}

const DRAFT_KEY = 'udisa.drafts';
function readAllDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}
function readDraft(key) {
  return readAllDrafts()[key] ?? null;
}
export function writeDraft(key, value) {
  try {
    const all = readAllDrafts();
    if (value === '' || value == null) delete all[key];
    else all[key] = value;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {}
}
export function clearDrafts(prefix = '') {
  try {
    const all = readAllDrafts();
    for (const k of Object.keys(all)) if (!prefix || k.startsWith(prefix)) delete all[k];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {}
}
