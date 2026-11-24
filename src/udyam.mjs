// Udyam number handling and the statutory MSME size classification.
import { toPaise } from './db.mjs';

// Revised definition, effective 1 April 2025 (manufacturing and services merged).
// Investment excludes land and building. Rupees, not paise.
export const SIZE_BANDS = [
  { id: 'micro', maxInvestment: 2_50_00_000, maxTurnover: 10_00_00_000 },
  { id: 'small', maxInvestment: 25_00_00_000, maxTurnover: 100_00_00_000 },
  { id: 'medium', maxInvestment: 125_00_00_000, maxTurnover: 500_00_00_000 },
];

const DIGITS = (s) => String(s ?? '').replace(/\D/g, '');

/**
 * Udyam numbers appear in the wild as UM-27000012345678, UM27000012345678,
 * UDYAM-UM-..., with stray spaces from copy-paste, and sometimes as just the
 * digits because the certificate prints "UM" in a separate box.
 *
 * A strict regex here is exactly what locks a real owner out of registration, so
 * an unusual-but-plausible shape produces a warning and a saved record, never a
 * refusal. Gibberish is still refused - and it must never be rewritten into a
 * plausible-looking number, or two unrelated owners collide on the same key.
 */
export function normalizeUdyam(input) {
  const raw = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return { ok: false, fatal: 'missing', value: '', canonical: '', warnings: ['missing'], needsReview: false };

  const official = /^(?:UDYAM[-/]?)?([A-Z]{2})-?(\d{2})-?(\d{7})$/.exec(raw);
  if (official && !['UM','UA'].includes(official[1])) {
    const canonical = 'UDYAM-' + official.slice(1).join('-');
    return {ok:true, canonical, value:canonical, warnings:[], needsReview:false};
  }
  const body = raw.replace(/^UDYAM[-/]?/, '');
  const prefix = /^UM-?\d/.test(body) ? 'UM' : /^UAM-?\d/.test(body) ? 'UAM' : '';
  const digits = body.replace(/^(UM|UAM)-?/, '').replace(/\D/g, '');

  if (digits.length < 6) {
    return { ok: false, fatal: 'no-digits', value: raw, canonical: '', warnings: ['too-short'], needsReview: false };
  }
  if (!prefix) {
    if (digits.length < 10) {
      return { ok: true, value: body, canonical: body, warnings: ['no-UM-prefix', 'needs-review'], needsReview: true };
    }
    // a bare 10+ digit run is a Udyam number whose "UM" sat in a separate box on
    // the certificate, so restore the prefix instead of storing two spellings
    const canonical = `UM-${digits}`;
    return { ok: true, value: canonical, canonical, warnings: ['no-UM-prefix', 'needs-review'], needsReview: true };
  }
  const canonical = `${prefix}-${digits}`;
  if (digits.length > 16) {
    return { ok: true, value: canonical, canonical, warnings: ['too-long', 'needs-review'], needsReview: true };
  }
  if (digits.length < 10) {
    return { ok: true, value: canonical, canonical, warnings: ['too-short', 'needs-review'], needsReview: true };
  }
  return { ok: true, value: canonical, canonical, warnings: [], needsReview: false };
}

export function normalizePhone(input) {
  const digits = DIGITS(input).replace(/^0+/, '').replace(/^91(?=\d{10}$)/, '');
  if (digits.length !== 10) return { ok: false, value: digits, reason: 'ten-digits' };
  if (!/^[6-9]/.test(digits)) return { ok: false, value: digits, reason: 'starts-6-9' };
  return { ok: true, value: digits, reason: null };
}

/**
 * Investment and turnover are judged separately and the higher band wins —
 * ₹8 crore investment with ₹60 crore turnover is a Small enterprise, not Micro.
 */
export function classify({ investmentRupees, turnoverRupees }) {
  const inv = Number.isFinite(investmentRupees) ? investmentRupees : 0;
  const tur = Number.isFinite(turnoverRupees) ? turnoverRupees : 0;
  const bandFor = (value, key) => {
    const i = SIZE_BANDS.findIndex((b) => value <= b[key]);
    return i === -1 ? SIZE_BANDS.length : i;
  };
  const byInvestment = bandFor(inv, 'maxInvestment');
  const byTurnover = bandFor(tur, 'maxTurnover');
  const rank = Math.max(byInvestment, byTurnover);
  const size = rank >= SIZE_BANDS.length ? null : SIZE_BANDS[rank].id;
  const drivers = [];
  if (byInvestment > byTurnover) drivers.push('investment');
  if (byTurnover > byInvestment) drivers.push('turnover');
  if (byInvestment === byTurnover && rank < SIZE_BANDS.length) drivers.push('investment', 'turnover');
  return {
    size,
    beyondMsme: size === null,
    drivers,
    limits: size ? SIZE_BANDS.find((b) => b.id === size) : SIZE_BANDS.at(-1),
    nextCeiling: size === null ? null : SIZE_BANDS.at(-1),
  };
}

export function readMoneyFields(body) {
  const investment = toPaise(body.investment);
  const turnover = toPaise(body.turnover);
  const errors = [];
  if (body.investment != null && body.investment !== '' && investment == null) errors.push('investment');
  if (body.turnover != null && body.turnover !== '' && turnover == null) errors.push('turnover');
  return {
    errors,
    investmentPaise: investment ?? 0,
    turnoverPaise: turnover ?? 0,
    investmentRupees: (investment ?? 0) / 100,
    turnoverRupees: (turnover ?? 0) / 100,
  };
}
