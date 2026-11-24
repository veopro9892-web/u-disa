// Network layer. Two failure modes caused most of the old "kabhi kaam nahi karta"
// reports: a dropped connection eating the entry, and a phone WebView refusing
// cookies. Both are handled here - the token is sent as a header as well as a
// cookie, and writes that cannot leave the device are queued instead of lost.

const TOKEN_KEY = 'udisa.token';
const QUEUE_KEY = 'udisa.queue';
const DRAFT_KEY = 'udisa.drafts';

export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};
export const setToken = (t) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
};

export class ApiError extends Error {
  constructor(code, message, fields = {}, status = 400) {
    super(message || code);
    this.code = code;
    this.fields = fields;
    this.status = status;
  }
}

const listeners = new Set();
export const onNetwork = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (state) => { for (const fn of listeners) try { fn(state); } catch {} };

let owner = '';
export function setOwner(id) { owner = id || ''; }
const prefix = () => 'udisa.pending.' + owner + '.';
export function readQueue() {
  if (!owner) return [];
  return Object.keys(localStorage).filter(k => k.startsWith(prefix())).sort().map(k => ({...JSON.parse(localStorage.getItem(k)), key:k}));
}
export const queueSize = () => readQueue().length;
export function forget(key) {
  if (owner && key.startsWith(prefix())) localStorage.removeItem(key);
}
export function legacyQueue() {
  return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
}

export function saveDraft(name, value) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    if (value == null || value === '') delete all[name];
    else all[name] = value;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch {}
}
export function loadDraft(name, fallback = '') {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')[name] ?? fallback; } catch { return fallback; }
}
export function clearDrafts() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

async function raw(method, path, body, expectedOwner = owner) {
  const token = getToken();
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (expectedOwner) headers['X-Udisa-Owner'] = expectedOwner;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: { code: 'bad-response', message: text.slice(0, 120) } }; }
  return { res, data };
}

/**
 * Returns the parsed payload, or throws ApiError.
 * `queue` marks a write as safe to retry later (it must carry a client id).
 */
export async function call(method, path, body, { queue = false } = {}) {
  queue = queue && !!owner && /^(?:\/(?:items|ledger|movements|parties|sales)(?:\/|$))/.test(path) && (method !== 'POST' || !!body?.id);
  if (queue && queueSize()) {
    const result = enqueue({ method, path, body });
    if (navigator.onLine) void flushQueue();
    return result;
  }
  if (!navigator.onLine && queue) return enqueue({ method, path, body });
  let res, data;
  try {
    ({ res, data } = await raw(method, path, body));
  } catch (err) {
    if (queue) return enqueue({ method, path, body });
    emit({ online: false, queued: queueSize() });
    throw new ApiError('network', 'err.network');
  }
  emit({ online: true, queued: queueSize() });
  if (data?.ok) return data;
  const e = data?.error ?? {};
  throw new ApiError(e.code ?? 'unknown', e.message ?? 'err.server', e.fields ?? {}, res.status);
}

let sequence = 0;
function enqueue(entry) {
  const suffix = String(Date.now()).padStart(14,'0') + '.' + String(sequence++).padStart(8,'0') + '.' + Math.random().toString(36).slice(2);
  try { localStorage.setItem(prefix()+suffix, JSON.stringify(entry)); }
  catch { throw new ApiError('storage','Device storage is full. Keep this form open and retry online.'); }
  emit({online:navigator.onLine, queued:queueSize()});
  return {ok:true,queued:true,id:entry.body?.id};
}
let running;
export function flushQueue() {
  if (!owner) return Promise.resolve(0);
  if (running) return running;
  const original = owner;
  async function replay() {
    for (const item of readQueue()) {
      if (original !== owner) break;
      try {
        const {res,data} = await raw(item.method,item.path,item.body,original);
        if (data?.ok || (res.status===404 && item.method==='DELETE')) {
          localStorage.removeItem(item.key);
        } else {
          localStorage.setItem(item.key,JSON.stringify({...item,lastError:data?.error?.message || 'Please sign in again.'}));
          break;
        }
      } catch { break; }
    }
    emit({online:navigator.onLine,queued:queueSize()});
    return queueSize();
  }
  const job = navigator.locks ? navigator.locks.request('udisa-replay-'+original,replay) : replay();
  running = job.finally(() => { running = null; });
  return running;
}

export const get = (path) => call('GET', path);
export const post = (path, body) => call('POST', path, body, { queue: true });
export const put = (path, body) => call('PUT', path, body, { queue: true });
export const patch = (path, body) => call('PATCH', path, body, { queue: true });
export const del = (path, body) => call('DELETE', path, body ?? {}, { queue: true });

window.addEventListener('online', () => { emit({ online: true, queued: queueSize() }); void flushQueue(); });
window.addEventListener('offline', () => emit({ online: false, queued: queueSize() }));
