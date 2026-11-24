import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expect = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expect.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return got.length === expect.length && crypto.timingSafeEqual(got, expect);
  } catch {
    return false;
  }
}

export function strength(password) {
  const s = String(password ?? '');
  const problems = [];
  if (s.length < 8) problems.push('atleast-8');
  if (s.length > 512) problems.push('too-long');
  if (!/[0-9]/.test(s)) problems.push('needs-digit');
  if (!/[a-zA-Z]/.test(s)) problems.push('needs-letter');
  return { ok: problems.length === 0, problems };
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function sessionExpiry(from = Date.now()) {
  return new Date(from + SESSION_DAYS * 86400_000).toISOString();
}

export const newId = () => crypto.randomUUID();

export function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? ''));
}

// Brute-force protection that does not punish honest typos. Attempts are only
// counted when they look like guessing; a successful login clears the slate, and
// a form the owner filled in wrongly is never counted at all.
const ATTEMPTS = new Map();

const prune = (list, windowMs) => {
  const cutoff = Date.now() - windowMs;
  return list.filter((t) => t > cutoff);
};

export function attempts(key, { limit, windowMs = 15 * 60_000 } = {}) {
  const list = prune(ATTEMPTS.get(key) ?? [], windowMs);
  if (list.length) ATTEMPTS.set(key, list);
  if (list.length >= limit) {
    return { allowed: false, retryAfterSec: Math.ceil((windowMs - (Date.now() - list[0])) / 1000), count: list.length };
  }
  return { allowed: true, remaining: limit - list.length };
}

export function penalise(key, windowMs = 15 * 60_000) {
  const list = prune(ATTEMPTS.get(key) ?? [], windowMs);
  list.push(Date.now());
  ATTEMPTS.set(key, list);
  if (ATTEMPTS.size > 5000) {
    for (const [k, v] of ATTEMPTS) if (!prune(v, windowMs).length) ATTEMPTS.delete(k);
  }
}

export function clearAttempts(key) {
  ATTEMPTS.delete(key);
}
