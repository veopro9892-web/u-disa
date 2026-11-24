import {businessDay} from '../public/js/day.js';
// The two numbers that decide whether a small business survives: money stuck in
// stock, and money owed to/by others. Computed from the ledger, never typed in.

const DEAD_DAYS = 45;
const EXCESS_DAYS = 60;

export const SETTLEMENT_CATEGORIES = new Set(['credit-received', 'credit-paid']);

const dayDiff = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 86400_000));

export function stockTable(db, userId, { asOf = businessDay(), windowDays = 30 } = {}) {
  const items = db
    .prepare("SELECT * FROM items WHERE user_id = ? AND deleted_at IS NULL ORDER BY lower(name)")
    .all(userId);
  const agg = db.prepare(
    `SELECT item_id,
            SUM(qty) AS net_qty,
            SUM(CASE WHEN qty < 0 AND kind IN ('sale', 'legacy') THEN -qty ELSE 0 END) AS out_qty,
            SUM(qty * unit_paise) AS value_paise,
            MAX(CASE WHEN qty < 0 AND kind IN ('sale', 'legacy') THEN occurred_on END) AS last_out,
            MIN(occurred_on) AS first_any, MAX(occurred_on) AS last_any
     FROM movements WHERE user_id = ? AND deleted_at IS NULL AND occurred_on <= ?
     GROUP BY item_id`
  ).all(userId, asOf);
  const byItem = new Map(agg.map((r) => [r.item_id, r]));

  const since = new Date(new Date(asOf).getTime() - (windowDays - 1) * 86400_000).toISOString().slice(0, 10);
  const recent = db
    .prepare(
      `SELECT item_id, SUM(CASE WHEN qty < 0 AND kind IN ('sale', 'legacy') THEN -qty ELSE 0 END) AS sold
       FROM movements WHERE user_id = ? AND deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
       GROUP BY item_id`
    )
    .all(userId, since, asOf);
  const soldMap = new Map(recent.map((r) => [r.item_id, r.sold]));

  const rows = items.map((item) => {
    const a = byItem.get(item.id) ?? {};
    const qty = Math.round(((item.opening_qty ?? 0) + (a.net_qty ?? 0)) * 1000) / 1000;
    const blocked = Math.max(0, Math.round(qty * item.purchase_paise));
    const sold = soldMap.get(item.id) ?? 0;
    const perDay = sold / windowDays;
    const coverDays = perDay > 0 ? qty / perDay : null;
    // a fresh restock must not reset the "nobody is buying this" clock, so idle
    // days are counted from the last sale and only fall back to the last movement
    // for items that have never sold at all
    const idleFrom = a.last_out ?? a.first_any ?? item.created_at?.slice(0, 10) ?? null;
    const idleDays = idleFrom ? dayDiff(idleFrom, asOf) : null;

    const reorderPoint=Math.max(item.reorder_qty,Math.ceil(perDay*item.lead_days));
    let state = 'ok';
    if (qty <= 0) state = 'out';
    else if (reorderPoint > 0 && qty <= reorderPoint) state = 'low';
    // an item that has simply never moved yet is not dead stock - that label is
    // reserved for something that has genuinely sat unsold
    else if (idleDays !== null && idleDays >= DEAD_DAYS && sold === 0) state = 'dead';
    else if (coverDays !== null && coverDays > EXCESS_DAYS) state = 'excess';

    const target = reorderPoint > 0 ? reorderPoint * 2 : null;
    return {
      id: item.id,
      name: item.name,
      unit: item.unit,
      category: item.category,
      qty,
      purchase_paise: item.purchase_paise,
      sale_paise: item.sale_paise,
      reorder_qty: item.reorder_qty,
      lead_days: item.lead_days,
      blocked_paise: blocked,
      sale_value_paise: Math.max(0, Math.round(qty * item.sale_paise)),
      sold_in_window: sold,
      per_day: perDay,
      cover_days: coverDays === null ? null : Math.round(coverDays * 10) / 10,
      idle_days: idleDays,
      state,
      suggest_buy_qty: state === 'low' || state === 'out' ? Math.round(((target ?? item.reorder_qty ?? 0) - qty) * 1000) / 1000 : 0,
    };
  });

  const totals = rows.reduce(
    (t, r) => {
      t.blocked += r.blocked_paise;
      t.sale_value += r.sale_value_paise;
      if (r.state === 'low') t.low++;
      if (r.state === 'out') t.out++;
      if (r.state === 'dead') t.dead++;
      if (r.state === 'excess') t.excess++;
      return t;
    },
    { blocked: 0, sale_value: 0, low: 0, out: 0, dead: 0, excess: 0, count: rows.length }
  );
  totals.margin_paise = totals.sale_value - totals.blocked;
  return { as_of: asOf, window_days: windowDays, items: rows, totals };
}

export function moneySummary(db, userId, { from, to } = {}) {
  const where = 'user_id = ? AND deleted_at IS NULL';
  const args = [userId];
  let range = '';
  if (from) { range += ' AND occurred_on >= ?'; args.push(from); }
  if (to) { range += ' AND occurred_on <= ?'; args.push(to); }

  const rows = db.prepare(`SELECT direction, category, mode, amount_paise FROM ledger WHERE ${where}${range}`).all(...args);
  const out = {
    income_paise: 0,
    expense_paise: 0,
    net_paise: 0,
    credit_given_paise: 0,
    credit_taken_paise: 0,
    collected_paise: 0,
    paid_paise: 0,
    by_category: {},
    by_mode: {},
    entries: rows.length,
  };
  for (const r of rows) {
    const settle = SETTLEMENT_CATEGORIES.has(r.category);
    if (!settle) {
      if (r.direction === 'in') out.income_paise += r.amount_paise;
      else out.expense_paise += r.amount_paise;
      out.by_category[r.category] = (out.by_category[r.category] ?? 0) + r.amount_paise;
    }
    out.by_mode[r.mode] = (out.by_mode[r.mode] ?? 0) + r.amount_paise;
    if (r.mode === 'credit' && !settle) {
      if (r.direction === 'in') out.credit_given_paise += r.amount_paise;
      else out.credit_taken_paise += r.amount_paise;
    }
    if (r.category === 'credit-received') out.collected_paise += r.amount_paise;
    if (r.category === 'credit-paid') out.paid_paise += r.amount_paise;
  }
  out.net_paise = out.income_paise - out.expense_paise;
  out.receivable_paise = Math.max(0, out.credit_given_paise - out.collected_paise);
  out.payable_paise = Math.max(0, out.credit_taken_paise - out.paid_paise);
  return out;
}

export function partyBalances(db, userId) {
  const parties = db
    .prepare('SELECT id, name, kind, phone FROM parties WHERE user_id = ? AND deleted_at IS NULL ORDER BY lower(name)')
    .all(userId);
  const credit = db
    .prepare(
      `SELECT party_id, direction, SUM(amount_paise) AS amt FROM ledger
       WHERE user_id = ? AND deleted_at IS NULL AND mode = 'credit' AND party_id IS NOT NULL
       GROUP BY party_id, direction`
    )
    .all(userId);
  const settled = db
    .prepare(
      `SELECT party_id, category, SUM(amount_paise) AS amt FROM ledger
       WHERE user_id = ? AND deleted_at IS NULL AND category IN ('credit-received','credit-paid') AND party_id IS NOT NULL
       GROUP BY party_id, category`
    )
    .all(userId);

  const map = new Map();
  const touch = (id) => {
    if (!map.has(id)) map.set(id, { owed_to_you_paise: 0, you_owe_paise: 0 });
    return map.get(id);
  };
  for (const r of credit) {
    const m = touch(r.party_id);
    if (r.direction === 'in') m.owed_to_you_paise += r.amt;
    else m.you_owe_paise += r.amt;
  }
  for (const r of settled) {
    const m = touch(r.party_id);
    if (r.category === 'credit-received') m.owed_to_you_paise -= r.amt;
    else m.you_owe_paise -= r.amt;
  }
  return parties.map((p) => {
    const m = map.get(p.id) ?? { owed_to_you_paise: 0, you_owe_paise: 0 };
    return {
      ...p,
      owed_to_you_paise: Math.max(0, Math.round(m.owed_to_you_paise)),
      you_owe_paise: Math.max(0, Math.round(m.you_owe_paise)),
      net_paise: Math.round(m.owed_to_you_paise - m.you_owe_paise),
    };
  });
}

export function monthlySeries(db, userId, months = 6) {
  const since = new Date(businessDay());
  since.setUTCDate(1);
  since.setUTCMonth(since.getUTCMonth() - (months - 1));
  const from = since.toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT substr(occurred_on,1,7) AS month, direction, category, SUM(amount_paise) AS amt
       FROM ledger WHERE user_id = ? AND deleted_at IS NULL AND occurred_on >= ?
       GROUP BY month, direction, category`
    )
    .all(userId, from);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.month)) out.set(r.month, { month: r.month, income_paise: 0, expense_paise: 0 });
    const m = out.get(r.month);
    if (SETTLEMENT_CATEGORIES.has(r.category)) continue;
    if (r.direction === 'in') m.income_paise += r.amt;
    else m.expense_paise += r.amt;
  }
  const list = [...out.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const m of list) m.net_paise = m.income_paise - m.expense_paise;
  return list;
}

/**
 * Plain-language advisories. The server returns a stable id plus numbers and the
 * client renders the sentence in the owner's language, so a wording change never
 * needs a redeploy and no half-translated string can reach the screen.
 */
export function healthSignals({ stock, money, months }) {
  const out = [];
  const last = months.at(-1);
  const avgExpense = months.length ? months.reduce((s, m) => s + m.expense_paise, 0) / months.length : 0;

  if (stock.totals.count === 0) {
    out.push({ id: 'no-stock', tone: 'info' });
  } else {
    if (stock.totals.out > 0) out.push({ id: 'stock-out', tone: 'bad', n: stock.totals.out });
    if (stock.totals.low > 0) out.push({ id: 'stock-low', tone: 'warn', n: stock.totals.low });
    if (stock.totals.dead > 0) {
      const dead = stock.items.filter((i) => i.state === 'dead').reduce((s, i) => s + i.blocked_paise, 0);
      out.push({ id: 'stock-dead', tone: 'warn', n: stock.totals.dead, amount_paise: dead });
    }
    if (avgExpense > 0 && stock.totals.blocked > avgExpense * 2) {
      out.push({ id: 'stock-excess', tone: 'warn', amount_paise: stock.totals.blocked });
    }
    if (stock.totals.out === 0 && stock.totals.low === 0 && stock.totals.dead === 0 && stock.totals.excess === 0 && stock.totals.count > 0) {
      out.push({ id: 'stock-healthy', tone: 'good' });
    }
  }

  if (money.receivable_paise > 0) out.push({ id: 'receivable', tone: 'warn', amount_paise: money.receivable_paise });
  if (money.payable_paise > 0) out.push({ id: 'payable', tone: 'info', amount_paise: money.payable_paise });
  if (last && last.expense_paise > last.income_paise && last.expense_paise > 0) {
    out.push({ id: 'loss-month', tone: 'bad', amount_paise: last.expense_paise - last.income_paise });
  } else if (last && last.net_paise > 0) {
    out.push({ id: 'profit-month', tone: 'good', amount_paise: last.net_paise });
  }
  if (money.entries === 0) out.push({ id: 'no-ledger', tone: 'info' });
  return out;
}
