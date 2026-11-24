// Wipes the local data. Deliberately awkward to run by accident.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const files = ['udisa.db', 'udisa.db-wal', 'udisa.db-shm', 'runtime.json'];
const dbFile = path.join(ROOT, 'data', 'udisa.db');

if (!process.argv.includes('--yes')) {
  console.log('This deletes every account, stock item and ledger entry on this computer.');
  console.log('Run it again with --yes if you really mean it:');
  console.log('  node tools/reset-data.mjs --yes');
  process.exit(1);
}

function emptyThroughSql() {
  const db = new DatabaseSync(dbFile);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of tables) db.exec(`DELETE FROM "${t.replace(/"/g, '""')}"`);
    db.exec('DELETE FROM sqlite_sequence');
    db.exec('VACUUM');
    return tables.length;
  } finally {
    db.close();
  }
}

let removed = 0;
let busy = [];
for (const f of files) {
  const p = path.join(ROOT, 'data', f);
  try {
    fs.unlinkSync(p);
    removed += 1;
    console.log('  removed', `data/${f}`);
  } catch (err) {
    if (err.code === 'ENOENT') continue;
    if (err.code === 'EBUSY' || err.code === 'EPERM') { busy.push(f); continue; }
    throw err;
  }
}

if (busy.length) {
  // the app is holding the file open, so empty the tables instead of deleting it
  try {
    const n = emptyThroughSql();
    console.log(`\n  data/udisa.db is in use, so the ${n} tables were emptied instead.`);
    console.log('  The file itself stays; U-Disa will reuse it.');
  } catch (err) {
    console.log('\n  Could not delete: ' + busy.join(', '));
    console.log('  and could not empty the tables either: ' + (err.message ?? err));
    console.log('  Close the U-Disa window (or press Ctrl+C in it), then run this again.');
    process.exit(1);
  }
} else {
  console.log(removed ? `\nDone. ${removed} file(s) removed.` : 'Nothing to remove - the database was already empty.');
}
