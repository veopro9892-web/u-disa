import { businessDay } from '../public/js/day.js';
import { addBookRoutes, checkBook, checkedWrite } from './books.mjs';
import { audit, fromPaise, nowIso, toPaise, toQty } from './db.mjs';
import { classify, normalizePhone, normalizeUdyam } from './udyam.mjs';
import { attempts, clearAttempts, hashPassword, hashToken, newId, newToken, penalise, sessionExpiry, strength, validUuid, verifyPassword } from './auth.mjs';
import { filterSchemes } from './schemes.mjs';
import { healthSignals, moneySummary, monthlySeries, partyBalances, stockTable } from './analytics.mjs';

const ERR = (status, code, message, fields = {}) => ({ status, body: { ok: false, error: { code, message, fields } } });
const OK = (body, status = 200) => ({ status, body: { ok: true, ...body } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const isDate = (v) => DATE_RE.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().startsWith(v);

const parseChecklist = (text) => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function futureLimit(days = 1) {
  const d = new Date(Date.now() + days * 86400_000);
  return businessDay(d);
}

export function createApi({ db, catalog, schemes, meta, brand, version }) {
  const sets = {
    orgTypes: new Set(catalog.organisationTypes.map((x) => x.id)),
    activities: new Set(catalog.activities.map((x) => x.id)),
    nic: new Map(catalog.nicDivisions.map((x) => [x.code, x])),
    states: new Set(catalog.states.map((x) => x.code)),
    units: new Set(catalog.units.map((x) => x.id)),
    langs: new Set(catalog.languages.map((x) => x.id)),
    expense: new Set(catalog.expenseCategories.map((x) => x.id)),
    income: new Set(catalog.incomeCategories.map((x) => x.id)),
    modes: new Set(catalog.paymentModes.map((x) => x.id)),
    sizes: new Set(['micro', 'small', 'medium']),
  };

  const publicUser = (u) => ({
    id: u.id,
    udyam_id: u.udyam_id,
    owner_name: u.owner_name,
    business_name: u.business_name,
    phone: u.phone,
    org_type: u.org_type,
    activity: u.activity,
    nic_code: u.nic_code,
    nic_input: u.nic_input,
    nic_title: sets.nic.get(u.nic_code)?.en ?? '',
    nic_title_hi: sets.nic.get(u.nic_code)?.hi ?? '',
    state_code: u.state_code,
    state_name: catalog.states.find((s) => s.code === u.state_code)?.en ?? '',
    district: u.district,
    size_class: u.size_class,
    investment: fromPaise(u.investment),
    turnover: fromPaise(u.turnover),
    lang: u.lang,
    created_at: u.created_at,
  });

  function sessionFor(token) {
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT s.token_hash, s.expires_at, s.user_id, u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(hashToken(token));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    // sliding expiry: a 30-day gap in the middle of data entry is data loss
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?')
      .run(nowIso(), sessionExpiry(), row.token_hash);
    const { token_hash, expires_at, ...user } = row;
    return user;
  }

  function issueSession(userId, device) {
    const token = newToken();
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, device) VALUES (?,?,?,?,?,?)')
      .run(hashToken(token), userId, nowIso(), sessionExpiry(), nowIso(), String(device ?? '').slice(0, 120));
    return token;
  }

  // ---------------------------------------------------------------- validation

  function validateRegistration(b) {
    const f = {};
    const udyam = normalizeUdyam(b.udyam_id);
    if (!udyam.ok || !/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(udyam.canonical || '') || !/^UDYAM/i.test(String(b.udyam_id).trim())) f.udyam_id = udyam.fatal === 'missing' ? 'Udyam number is required' : 'That does not look like a Udyam number';
    const phone = normalizePhone(b.phone);
    if (!phone.ok) f.phone = phone.reason === 'starts-6-9' ? 'Indian mobile numbers start with 6-9' : 'Enter the 10-digit mobile number';
    const owner_name = clean(b.owner_name, 80);
    if (owner_name.length < 2) f.owner_name = 'Enter the owner name';
    const business_name = clean(b.business_name, 100);
    if (business_name.length < 2) f.business_name = 'Enter the business name';
    if (!sets.orgTypes.has(b.org_type)) f.org_type = 'Choose the type of organisation';
    if (!sets.activities.has(b.activity)) f.activity = 'Choose what the business does';
    const nic = sets.nic.get(clean(b.nic_code, 4));
    if (!nic) f.nic_code = 'Choose the main activity from the list';
    if (!sets.states.has(clean(b.state_code, 3))) f.state_code = 'Choose the state';
    if (!strength(b.password).ok) f.password = 'Password needs at least 8 characters with a letter and a number';
    const lang = sets.langs.has(b.lang) ? b.lang : 'en';
    const district = clean(b.district, 60);
    const money = {
      investment: b.investment == null || b.investment === '' ? 0 : toPaise(b.investment),
      turnover: b.turnover == null || b.turnover === '' ? 0 : toPaise(b.turnover),
    };
    if (money.investment == null) f.investment = 'Investment amount is not a valid number';
    if (money.turnover == null) f.turnover = 'Turnover amount is not a valid number';
    return { f, udyam, phone, owner_name, business_name, nic, district, lang, money };
  }

  const COLLECT = {
    parties: {
      table: 'parties',
      fields: {
        name: (v) => (clean(v, 80).length >= 2 ? clean(v, 80) : { err: 'Enter the name' }),
        kind: (v) => (['customer', 'supplier', 'both'].includes(v) ? v : { err: 'Choose customer or supplier' }),
        phone: (v) => {
          const p = normalizePhone(v);
          return !clean(v).length ? '' : p.ok ? p.value : { err: 'Enter a valid 10-digit mobile number' };
        },
        gstin: (v) => {
          const g = clean(v, 15).toUpperCase();
          if (!g) return '';
          return /^[0-9A-Z]{15}$/.test(g) ? g : { err: 'GSTIN is 15 characters' };
        },
        note: (v) => clean(v, 200),
      },
    },
    items: {
      table: 'items',
      fields: {
        name: (v) => (clean(v, 80).length >= 2 ? clean(v, 80) : { err: 'Enter the item name' }),
        unit: (v) => (sets.units.has(clean(v, 12)) ? clean(v, 12) : { err: 'Choose the unit' }),
        category: (v) => clean(v, 40),
        purchase: (v) => (v == null || v === '' ? 0 : toPaise(v) ?? { err: 'Not a valid amount' }),
        sale: (v) => (v == null || v === '' ? 0 : toPaise(v) ?? { err: 'Not a valid amount' }),
        reorder_qty: (v) => (v == null || v === '' ? 0 : (toQty(v) ?? { err: 'Not a valid quantity' })),
        lead_days: (v) => {
          const n = Number(v ?? 0);
          return Number.isFinite(n) && n >= 0 && n <= 3650 ? Math.round(n) : { err: 'Supplier days must be 0-3650' };
        },
        opening_qty: (v) => (v == null || v === '' ? 0 : (toQty(v) ?? { err: 'Not a valid quantity' })),
        note: (v) => clean(v, 200),
      },
    },
    movements: {
      table: 'movements',
      fields: {
        kind: v => ['sale','purchase','damage','correction','legacy'].includes(v) ? v : {err:'Choose the movement type'},
        item_id: (v, ctx) => {
          if (!validUuid(clean(v, 40))) return { err: 'Choose the item' };
          const row = ctx.db.prepare('SELECT id, name FROM items WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(v, ctx.userId);
          return row ? v : { err: 'That item no longer exists' };
        },
        qty: (v) => {
          const q = toQty(v);
          if (q == null) return { err: 'Enter the quantity' };
          if (q === 0) return { err: 'Quantity cannot be zero' };
          return q;
        },
        rate: (v) => (v == null || v === '' ? 0 : toPaise(v) ?? { err: 'Not a valid rate' }),
        party_id: (v, ctx) => {
          if (!clean(v).length || v == null) return null;
          if (!validUuid(v)) return { err: 'Choose a valid party' };
          const row = ctx.db.prepare('SELECT id FROM parties WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(v, ctx.userId);
          return row ? v : { err: 'That party no longer exists' };
        },
        note: (v) => clean(v, 200),
        occurred_on: (v) => {
          const d = clean(v, 10) || businessDay();
          if (!isDate(d)) return { err: 'Choose a date' };
          if (d > futureLimit(0)) return { err: 'Date cannot be in the future' };
          return d;
        },
      },
    },
    ledger: {
      table: 'ledger',
      fields: {
        direction: (v) => (v === 'in' || v === 'out' ? v : { err: 'Choose money in or money out' }),
        amount: (v) => {
          const p = toPaise(v);
          if (p == null) return { err: 'Enter the amount' };
          if (p <= 0) return { err: 'Amount must be more than zero' };
          return p;
        },
        category: (v, ctx) => {
          const c = clean(v, 40);
          if (c === 'credit-received' || c === 'credit-paid') return c;
          const direction = ctx.body?.direction;
          const ok = direction === 'in' ? sets.income.has(c) : direction === 'out' ? sets.expense.has(c) : sets.income.has(c) || sets.expense.has(c);
          return ok ? c : { err: 'Choose the category' };
        },
        mode: (v) => (sets.modes.has(clean(v, 20)) ? clean(v, 20) : { err: 'Choose how it was paid' }),
        party_id: (v, ctx) => {
          if (!clean(v).length || v == null) return null;
          if (!validUuid(v)) return { err: 'Choose a valid party' };
          const row = ctx.db.prepare('SELECT id FROM parties WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(v, ctx.userId);
          return row ? v : { err: 'That party no longer exists' };
        },
        note: (v) => clean(v, 200),
        occurred_on: (v) => {
          const d = clean(v, 10) || businessDay();
          if (!isDate(d)) return { err: 'Choose a date' };
          if (d > futureLimit(0)) return { err: 'Date cannot be in the future' };
          return d;
        },
      },
      // column name differs from the API field name
      map: { purchase: 'purchase_paise', sale: 'sale_paise', rate: 'unit_paise', amount: 'amount_paise' },
    },
  };
  for (const k of ['parties', 'items', 'movements']) COLLECT[k].map = { purchase: 'purchase_paise', sale: 'sale_paise', rate: 'unit_paise' };

  function shapeRow(table, row) {
    if (!row) return null;
    const out = { ...row };
    if ('purchase_paise' in out) { out.purchase = fromPaise(out.purchase_paise); delete out.purchase_paise; }
    if ('sale_paise' in out) { out.sale = fromPaise(out.sale_paise); delete out.sale_paise; }
    if ('unit_paise' in out) { out.rate = fromPaise(out.unit_paise); delete out.unit_paise; }
    if ('amount_paise' in out) { out.amount = fromPaise(out.amount_paise); delete out.amount_paise; }
    if (table === 'movements') {
      const item = db.prepare('SELECT name, unit FROM items WHERE id = ?').get(out.item_id);
      out.item_name = item?.name ?? '';
      out.item_unit = item?.unit ?? '';
      out.total = Math.round(Math.abs((out.qty ?? 0) * (out.rate ?? 0)) * 100) / 100;
    }
    if (out.party_id) {
      const p = db.prepare('SELECT name FROM parties WHERE id = ?').get(out.party_id);
      out.party_name = p?.name ?? '';
    }
    return out;
  }

  // ------------------------------------------------------------------- routes

  const routes = [];
  const on = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, pattern, handler, auth });

  on('GET', /^\/health$/, async () => {
    const probe = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    return OK({
      app: brand.name,
      version,
      time: nowIso(),
      users: probe.n,
      schemes: schemes.length,
      catalog: { nicDivisions: catalog.nicDivisions.length, states: catalog.states.length },
      dataFiles: { lastVerified: meta.lastVerified ?? null },
    });
  }, { auth: false });

  on('GET', /^\/bootstrap$/, async () => OK({ brand, catalog, version, lastVerified: meta.lastVerified ?? null }), { auth: false });

  on('POST', /^\/register$/, async ({ body, ip, ua }) => {
    const key = `register:${ip}`;
    const REG_WINDOW = 30 * 60_000;
    const gate = attempts(key, { limit: 20, windowMs: REG_WINDOW });
    if (!gate.allowed) return ERR(429, 'too-many', 'Too many attempts from this device. Try again later.');
    const v = validateRegistration(body);
    if (Object.keys(v.f).length) {
      // an honest typo is not an attack; only a taken identity is counted
      return ERR(422, 'invalid', 'Please check the highlighted details', v.f);
    }
    const takenUdyam = db.prepare('SELECT id FROM users WHERE udyam_id = ?').get(v.udyam.canonical);
    if (takenUdyam || db.prepare('SELECT id FROM users WHERE udyam_id = ?').get(v.udyam.canonical.replace(/^UDYAM-/, ''))) {
      penalise(key, REG_WINDOW);
      return ERR(409, 'udyam-taken', 'This Udyam number is already registered on U-Disa. Please use Login.', { udyam_id: 'already registered' });
    }
    const takenPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(v.phone.value);
    if (takenPhone) {
      penalise(key, REG_WINDOW);
      return ERR(409, 'phone-taken', 'This mobile number is already registered. Please use Login.', { phone: 'already registered' });
    }
    clearAttempts(key);
    const cls = classify({ investmentRupees: v.money.investment / 100, turnoverRupees: v.money.turnover / 100 });
    const id = newId();
    const ts = nowIso();
    db.prepare(
      `INSERT INTO users (id, udyam_id, owner_name, business_name, phone, password_hash, org_type, activity, nic_code,
        nic_input, state_code, district, size_class, investment, turnover, lang, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, v.udyam.canonical, v.owner_name, v.business_name, v.phone.value, hashPassword(String(body.password)),
      body.org_type, body.activity, v.nic.code, clean(v.nic.en, 120), clean(body.state_code, 3), v.district,
      (v.money.investment || v.money.turnover) ? cls.size ?? '' : '', v.money.investment, v.money.turnover, v.lang, ts, ts
    );
    audit(db, { user_id: id, action: 'register', entity: 'user', entity_id: id, detail: v.udyam.canonical });
    return OK({ token: issueSession(id, ua), user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), warnings: v.udyam.warnings }, 201);
  }, { auth: false });

  on('POST', /^\/login$/, async ({ body, ip, ua }) => {
    const LOGIN_WINDOW = 10 * 60_000;
    const ident = clean(body.identifier ?? body.phone ?? body.udyam_id, 40);
    // two buckets: a shared computer must not let one tired owner lock out the
    // whole household, and one account must not be guessable at speed
    const byIp = attempts(`login:${ip}`, { limit: 30, windowMs: LOGIN_WINDOW });
    const byId = attempts(`login:${ident.toLowerCase()}`, { limit: 8, windowMs: LOGIN_WINDOW });
    const blocked = !byIp.allowed ? byIp : !byId.allowed ? byId : null;
    if (blocked) {
      return ERR(429, 'too-many', `Too many attempts. Try again in ${Math.max(1, Math.ceil(blocked.retryAfterSec / 60))} minute(s).`);
    }
    if (!ident) return ERR(422, 'invalid', 'Enter your mobile number or Udyam number', { identifier: 'required' });
    const phone = normalizePhone(ident);
    const udyam = normalizeUdyam(ident);
    const user =
      (!/[a-z]/i.test(ident) && phone.ok && db.prepare('SELECT * FROM users WHERE phone = ?').get(phone.value)) ||
      (udyam.ok && db.prepare('SELECT * FROM users WHERE udyam_id = ?').get(udyam.canonical)) ||
      (udyam.ok && db.prepare('SELECT * FROM users WHERE udyam_id = ?').get(udyam.canonical.replace(/^UDYAM-/, ''))) ||
      null;
    if (!user || !verifyPassword(String(body.password ?? ''), user.password_hash)) {
      penalise(`login:${ip}`, LOGIN_WINDOW);
      penalise(`login:${ident.toLowerCase()}`, LOGIN_WINDOW);
      return ERR(401, 'bad-credentials', 'Details do not match. Check the number and password, then try again.');
    }
    clearAttempts(`login:${ident.toLowerCase()}`);
    return OK({ token: issueSession(user.id, ua), user: publicUser(user) });
  }, { auth: false });

  on('POST', /^\/logout$/, async ({ token, user }) => {
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return OK({ done: true });
  });

  on('GET', /^\/me$/, async ({ user }) => {
    const cls = classify({ investmentRupees: user.investment / 100, turnoverRupees: user.turnover / 100 });
    const udyam = normalizeUdyam(user.udyam_id);
    return OK({ user: publicUser(user), classification: cls, udyamWarnings: udyam.warnings });
  });

  on('PATCH', /^\/me$/, async ({ user, body }) => {
    const f = {};
    const patch = {};
    if (body.owner_name != null) { const n = clean(body.owner_name, 80); if (n.length < 2) f.owner_name = 'Enter the owner name'; else patch.owner_name = n; }
    if (body.business_name != null) { const n = clean(body.business_name, 100); if (n.length < 2) f.business_name = 'Enter the business name'; else patch.business_name = n; }
    if (body.district != null) patch.district = clean(body.district, 60);
    if (body.lang != null) { if (!sets.langs.has(body.lang)) f.lang = 'Unknown language'; else patch.lang = body.lang; }
    if (body.org_type != null) { if (!sets.orgTypes.has(body.org_type)) f.org_type = 'Choose the type of organisation'; else patch.org_type = body.org_type; }
    if (body.activity != null) { if (!sets.activities.has(body.activity)) f.activity = 'Choose what the business does'; else patch.activity = body.activity; }
    if (body.nic_code != null) { const n = sets.nic.get(clean(body.nic_code, 4)); if (!n) f.nic_code = 'Choose the main activity'; else { patch.nic_code = n.code; patch.nic_input = clean(n.en, 120); } }
    if (body.state_code != null) { if (!sets.states.has(clean(body.state_code, 3))) f.state_code = 'Choose the state'; else patch.state_code = clean(body.state_code, 3); }
    if (body.investment != null && body.investment !== '') { const p = toPaise(body.investment); if (p == null) f.investment = 'Not a valid amount'; else patch.investment = p; }
    if (body.turnover != null && body.turnover !== '') { const p = toPaise(body.turnover); if (p == null) f.turnover = 'Not a valid amount'; else patch.turnover = p; }
    if (Object.keys(f).length) return ERR(422, 'invalid', 'Please check the highlighted details', f);

    const merged = { ...user, ...patch };
    const cls = classify({ investmentRupees: merged.investment / 100, turnoverRupees: merged.turnover / 100 });
    patch.size_class = (merged.investment || merged.turnover) ? cls.size ?? '' : '';
    patch.updated_at = nowIso();
    const cols = Object.keys(patch);
    db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c]), user.id);
    audit(db, { user_id: user.id, action: 'profile-update', entity: 'user', entity_id: user.id, detail: cols.join(',') });
    return OK({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)), classification: cls });
  });

  on('GET', /^\/state$/, async ({ user, query }) => {
    const asOf = isDate(query.as_of) ? query.as_of : businessDay();
    const list = (table, order = 'lower(name)') =>
      db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND deleted_at IS NULL ORDER BY ${order}`).all(user.id).map((r) => shapeRow(table, r));
    const stock = stockTable(db, user.id, { asOf });
    const money = moneySummary(db, user.id, {});
    const cash = db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_paise ELSE 0 END),0) AS received, COALESCE(SUM(CASE WHEN direction='out' THEN amount_paise ELSE 0 END),0) AS paid FROM ledger WHERE user_id=? AND mode<>'credit' AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?").get(user.id,asOf.slice(0,7)+'-01',asOf);
    const months = monthlySeries(db, user.id, 6);
    return OK({
      cash,
      parties: list('parties'),
      items: list('items'),
      movements: db.prepare('SELECT * FROM movements WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_on DESC, created_at DESC LIMIT 500').all(user.id).map((r) => shapeRow('movements', r)),
      ledger: db.prepare('SELECT * FROM ledger WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_on DESC, created_at DESC LIMIT 500').all(user.id).map((r) => shapeRow('ledger', r)),
      saved: db.prepare('SELECT scheme_id, status, checklist, updated_at FROM saved_schemes WHERE user_id = ?').all(user.id)
        .map((r) => ({ ...r, checklist: parseChecklist(r.checklist) })),
      stock,
      money,
      months,
      parties_balance: partyBalances(db, user.id),
      signals: healthSignals({ stock, money, months }),
    });
  });

  addBookRoutes({db,on,OK,ERR,sets,isDate});
  const COLLECT_NAMES = { parties: 'party', items: 'item', movements: 'movement', ledger: 'entry' };
  for (const [key, spec] of Object.entries(COLLECT)) {
    const columnsFor = (input, ctx) => {
      const fields = {};
      const errors = {};
      for (const [name, fn] of Object.entries(spec.fields)) {
        if (!(name in input)) continue;
        const val = fn(input[name], ctx);
        if (val && typeof val === 'object' && 'err' in val) { errors[name] = val.err; continue; }
        fields[spec.map?.[name] ?? name] = val;
      }
      return { fields, errors };
    };
    const one = COLLECT_NAMES[key];

    on('POST', new RegExp(`^\\/${key}$`), async ({ user, body }) => {
      const ctx = { db, userId: user.id, body };
      const { fields, errors } = columnsFor(body, ctx);
      if (Object.keys(errors).length) return ERR(422, 'invalid', 'Please check the highlighted details', errors);
      if (!Object.keys(fields).length) return ERR(422, 'empty', 'Nothing to save was sent');

      const id = validUuid(body.id) ? body.id : newId();
      const existing = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ? AND user_id = ?`).get(id, user.id);
      if (existing?.deleted_at) {
        // a deleted row's id stays spent; silently reviving it would resurrect
        // something the owner removed on purpose
        return ERR(409, 'id-reused', 'That entry was already deleted. Please add it again.');
      }
      if (existing) {
        // same client-generated id arriving twice is a retry, not a duplicate
        return OK({ [one]: shapeRow(spec.table, existing), replayed: true });
      }
      const message = checkBook(key,fields);
      if (message) return ERR(422,'invalid-entry',message);
      const required = {ledger:['amount_paise','direction','category','mode'],movements:['qty','item_id'],items:['unit','name'],parties:['kind','name']}[key];
      if (required.some(k => fields[k] == null)) return ERR(422,'missing','Please fill in the required fields.');
      if (key === 'ledger' || key === 'movements') fields.occurred_on ??= businessDay();
      if (key==='ledger' && ['credit-paid','credit-received'].includes(fields.category)) {
        const party=partyBalances(db,user.id).find(p=>p.id===fields.party_id);
        const due=fields.category==='credit-paid'?party?.you_owe_paise:party?.owed_to_you_paise;
        if (fields.amount_paise>(due || 0)) return ERR(422,'overpayment','This payment exceeds the outstanding balance.');
      }
      const ts = nowIso();
      const cols = ['id', 'user_id', ...Object.keys(fields), 'created_at', 'updated_at'];
      const vals = [id, user.id, ...Object.values(fields), ts, ts];
      const problem = checkedWrite(db, () => db.prepare(`INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals), [fields.item_id]);
      if (problem) return ERR(422,"stock",problem);
      audit(db, { user_id: user.id, action: 'add', entity: spec.table, entity_id: id });
      return OK({ [one]: shapeRow(spec.table, db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id)) }, 201);
    });

    on('PUT', new RegExp(`^\\/${key}\\/([\\w-]+)$`), async ({ user, body, params }) => {
      const id = params[0];
      if (!validUuid(id)) return ERR(400, 'bad-id', 'That record id is not valid');
      const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ? AND user_id = ?`).get(id, user.id);
      if (!row || row.deleted_at) return ERR(404, 'not-found', 'That record is no longer here');
      const ctx = { db, userId: user.id, body: { ...row, ...body } };
      const { fields, errors } = columnsFor(body, ctx);
      if (Object.keys(errors).length) return ERR(422, 'invalid', 'Please check the highlighted details', errors);
      const message = checkBook(key,{...row,...fields},row);
      if (message) return ERR(422,'invalid-entry',message);
      const cols = Object.keys(fields);
      if (!cols.length) return OK({ [one]: shapeRow(spec.table, row), changed: false });
      cols.push('updated_at');
      const problem = checkedWrite(db, () => db.prepare(`UPDATE ${spec.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
        .run(...cols.map((c) => (c === 'updated_at' ? nowIso() : fields[c])), id, user.id), [row.item_id, fields.item_id, key === 'items' ? id : null]);
      if (problem) return ERR(422,'stock',problem);
      audit(db, { user_id: user.id, action: 'edit', entity: spec.table, entity_id: id });
      return OK({ [one]: shapeRow(spec.table, db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id)) });
    });

    on('DELETE', new RegExp(`^\\/${key}\\/([\\w-]+)$`), async ({ user, params }) => {
      const id = params[0];
      if (!validUuid(id)) return ERR(400, 'bad-id', 'That record id is not valid');
      const row = db.prepare('SELECT * FROM '+spec.table+' WHERE id=? AND user_id=? AND deleted_at IS NULL').get(id,user.id);
      if (!row) return ERR(404,'not-found','Already removed');
      if (row.sale_link) return ERR(409,'linked','Cancel the complete sale from Accounts.');
      if (key === 'parties' && db.prepare('SELECT id FROM ledger WHERE party_id=? AND deleted_at IS NULL LIMIT 1').get(id)) return ERR(409,'linked','This contact has ledger history.');
      const problem = checkedWrite(db, () => db.prepare(`UPDATE ${spec.table} SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
        .run(nowIso(), id, user.id), [row.item_id]);
      if (problem) return ERR(422,'stock',problem);
      audit(db, { user_id: user.id, action: 'remove', entity: spec.table, entity_id: id });
      return OK({ removed: id });
    });
  }

  on('GET', /^\/schemes$/, async ({ user, query }) => {
    const filtered = filterSchemes(schemes, {
      q: query.q, size: sets.sizes.has(query.size) ? query.size : null,
      kind: query.kind, tag: query.tag, status: query.status,
    });
    return OK({lastVerified:meta.lastVerified,list:filtered});
  });

  on('GET', /^\/schemes\/([\w-]+)$/, async ({ user, params }) => {
    const s = schemes.find((x) => x.id === params[0]);
    if (!s) return ERR(404, 'not-found', 'That scheme is not in the reference list');
    const savedRow = db.prepare('SELECT * FROM saved_schemes WHERE user_id = ? AND scheme_id = ?').get(user.id, s.id);
    const saved = savedRow ? { ...savedRow, checklist: parseChecklist(savedRow.checklist) } : null;
    return OK({ scheme: s, saved, safeguards: meta.safeguards ?? [] });
  });

  on('PUT', /^\/schemes\/([\w-]+)\/save$/, async ({ user, params, body }) => {
    const id = params[0];
    if (!schemes.some((s) => s.id === id)) return ERR(404, 'not-found', 'That scheme is not in the reference list');
    const status = ['saved', 'applied', 'sanctioned', 'declined', 'not-applicable'].includes(body.status) ? body.status : 'saved';
    const checklist = Array.isArray(body.checklist)
      ? JSON.stringify(body.checklist.map((x) => clean(x, 120)).filter(Boolean).slice(0, 40))
      : '[]';
    db.prepare(
      `INSERT INTO saved_schemes (user_id, scheme_id, status, checklist, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, scheme_id) DO UPDATE SET status = excluded.status, checklist = excluded.checklist, updated_at = excluded.updated_at`
    ).run(user.id, id, status, checklist, nowIso());
    return OK({ saved: { scheme_id: id, status, checklist: JSON.parse(checklist) } });
  });

  on('DELETE', /^\/schemes\/([\w-]+)\/save$/, async ({ user, params }) => {
    db.prepare('DELETE FROM saved_schemes WHERE user_id = ? AND scheme_id = ?').run(user.id, params[0]);
    return OK({ removed: params[0] });
  });

  on('DELETE', /^\/me$/, async ({ user, body }) => {
    // erasing is irreversible, so it costs the account password
    if (!verifyPassword(String(body.password ?? ''), user.password_hash)) {
      return ERR(403, 'bad-credentials', 'Password does not match. Nothing was erased.');
    }
    checkedWrite(db,()=>{
    for (const table of ['movements', 'ledger', 'items', 'parties', 'saved_schemes', 'audit', 'sessions']) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    });
    return OK({ erased: true });
  });

  on('GET', /^\/export\.(csv|json)$/, async ({ user, params }) => {
    if (params[0] === 'json') {
      const dump = (t) => db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(user.id);
      const text = JSON.stringify(
        {
          app: brand.name,
          exported: nowIso(),
          user: publicUser(user),
          parties: dump('parties'),
          items: dump('items'),
          movements: dump('movements'),
          ledger: dump('ledger'),
          saved: dump('saved_schemes'),
        },
        null,
        2
      );
      return { status: 200, file: { name: 'udisa-backup.json', type: 'application/json', text } };
    }
    const rows = db
      .prepare('SELECT occurred_on, direction, amount_paise, category, mode, note, party_id FROM ledger WHERE user_id = ? AND deleted_at IS NULL ORDER BY occurred_on')
      .all(user.id);
    const names = new Map(db.prepare('SELECT id, name FROM parties WHERE user_id = ?').all(user.id).map((p) => [p.id, p.name]));
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['date', 'direction', 'amount_rupees', 'category', 'mode', 'party', 'note'].join(',')];
    for (const r of rows) {
      lines.push([r.occurred_on, r.direction, fromPaise(r.amount_paise).toFixed(2), r.category, r.mode, names.get(r.party_id) ?? '', r.note].map(esc).join(','));
    }
    return { status: 200, file: { name: 'udisa-ledger.csv', type: 'text/csv', text: lines.join('\r\n') + '\r\n' } };
  });

  return {
    /** Resolves a bearer token or session cookie into the owner's row. */
    userFor: (token) => sessionFor(token),
    handle(req) {
      const { method, path: rawPath } = req;
      const pathOnly = rawPath.replace(/^\/api/, '') || '/';
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(pathOnly);
        if (!m) continue;
        const user = r.auth ? req.user : req.user ?? null;
        if (r.auth && !user) return ERR(401, 'unauthenticated', 'Please register or log in again.');
        return r.handler({ ...req, user, params: m.slice(1) });
      }
      return ERR(404, 'no-route', `No API route for ${method} ${pathOnly}`);
    },
  };
}
