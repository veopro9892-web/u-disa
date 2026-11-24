import { classify } from './udyam.mjs';
// SQLite via node:sqlite — no native build step, so the app cannot arrive
// half-installed on somebody's machine.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  udyam_id      TEXT NOT NULL UNIQUE,
  owner_name    TEXT NOT NULL,
  business_name TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  org_type      TEXT NOT NULL,
  activity      TEXT NOT NULL,
  nic_code      TEXT NOT NULL,
  nic_input     TEXT NOT NULL DEFAULT '',
  state_code    TEXT NOT NULL,
  district      TEXT NOT NULL DEFAULT '',
  size_class    TEXT NOT NULL DEFAULT '',
  investment    INTEGER NOT NULL DEFAULT 0,
  turnover      INTEGER NOT NULL DEFAULT 0,
  lang          TEXT NOT NULL DEFAULT 'en',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  device     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS parties (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  gstin      TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT '',
  purchase_paise INTEGER NOT NULL DEFAULT 0,
  sale_paise    INTEGER NOT NULL DEFAULT 0,
  reorder_qty   REAL NOT NULL DEFAULT 0,
  lead_days     INTEGER NOT NULL DEFAULT 0,
  opening_qty   REAL NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

-- movements carry a signed quantity: stock in is positive, stock out is negative.
-- The sign lives in the row so an offline replay cannot flip it.
CREATE TABLE IF NOT EXISTS movements (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty         REAL NOT NULL,
  unit_paise  INTEGER NOT NULL DEFAULT 0,
  party_id    TEXT,
  note        TEXT NOT NULL DEFAULT '',
  occurred_on TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_movements_item ON movements(user_id, item_id);
CREATE INDEX IF NOT EXISTS ix_movements_date ON movements(user_id, occurred_on);

CREATE TABLE IF NOT EXISTS ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  category    TEXT NOT NULL,
  mode        TEXT NOT NULL,
  party_id    TEXT,
  note        TEXT NOT NULL DEFAULT '',
  occurred_on TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_ledger_date ON ledger(user_id, occurred_on);

CREATE TABLE IF NOT EXISTS saved_schemes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheme_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'saved',
  checklist  TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scheme_id)
);

-- every write lands here so the audit trail survives a bad sync
CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  detail     TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL
);
`;

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 4000');
  db.exec(SCHEMA);
  ensureColumns(db);
  const updateSize = db.prepare('UPDATE users SET size_class = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const u of db.prepare('SELECT id, investment, turnover, size_class FROM users').all()) {
      const size = (u.investment || u.turnover) ? (classify({investmentRupees:u.investment/100, turnoverRupees:u.turnover/100}).size ?? '') : '';
      if (size !== u.size_class) updateSize.run(size, u.id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return db;
}

// CREATE TABLE IF NOT EXISTS never changes a table that already exists, so an
// older database file would keep failing every write with "no column named".
const REQUIRED_COLUMNS = {
  movements: { kind: "TEXT NOT NULL DEFAULT 'legacy'", sale_link: "TEXT", updated_at: 'TEXT NOT NULL DEFAULT \'\'' },
  ledger: { sale_link: 'TEXT', updated_at: 'TEXT NOT NULL DEFAULT \'\'' },
  users: { recovery_hash: "TEXT", nic_input: "TEXT NOT NULL DEFAULT ''", district: "TEXT NOT NULL DEFAULT ''", size_class: "TEXT NOT NULL DEFAULT ''" },
};

function ensureColumns(db) {
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = new Set(db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => r.name));
    for (const [name, def] of Object.entries(cols)) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }
}

export const nowIso = () => new Date().toISOString();

// Money is stored in paise so a float never eats a shopkeeper's rupee.
export const PAISE_MAX = 1_00_00_00_00_00_00; // ₹1,00,00,00,00,000

export function toPaise(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[,\s_]/g, '')) : Number(value);
  if (!Number.isFinite(n)) return null;
  const paise = Math.round(n * 100);
  if (paise < 0 || paise > PAISE_MAX) return null;
  return paise;
}

export function fromPaise(paise) {
  return (paise ?? 0) / 100;
}

export function toQty(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) return null;
  return Math.round(n * 1000) / 1000;
}

export function audit(db, { user_id, action, entity, entity_id = null, detail = '' }) {
  db.prepare('INSERT INTO audit (user_id, action, entity, entity_id, detail, at) VALUES (?,?,?,?,?,?)')
    .run(user_id ?? null, action, entity, entity_id, String(detail).slice(0, 400), nowIso());
}
