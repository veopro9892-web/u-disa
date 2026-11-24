// Turns the reference document into "can this business actually apply, and what
// should they bring". The source is emphatic that a guarantee ceiling is not a
// loan offer, so nothing here may promise an amount.
import fs from 'node:fs';

export function loadSchemes(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const meta = raw.find((r) => r.id === '_meta') ?? { safeguards: [], lastVerified: null };
  const schemes = raw.filter((r) => r.id !== '_meta');
  const ids = new Set();
  for (const s of schemes) {
    if (ids.has(s.id)) throw new Error(`duplicate scheme id ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.categories) || !s.categories.length) throw new Error(`${s.id} has no enterprise categories`);
  }
  return { schemes, meta };
}

/**
 * Score is deliberately coarse: it orders a list, it does not decide anything.
 * `reasons` carries the why so the screen can show it instead of a bare number.
 */
export function filterSchemes(schemes, { q, size, kind, tag, status }) {
  const needle = (q ?? '').trim().toLowerCase();
  return schemes.filter((s) => {
    if (needle) {
      const hay = `${s.name} ${s.shortName} ${s.purpose} ${(s.purposeTags ?? []).join(' ')} ${(s.keyConditions ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (size && !s.categories.includes(size)) return false;
    if (kind && s.kind !== kind) return false;
    if (tag && !(s.purposeTags ?? []).includes(tag)) return false;
    if (status && s.status !== status) return false;
    return true;
  });
}
