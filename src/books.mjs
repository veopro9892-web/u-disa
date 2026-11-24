import { audit, nowIso, toPaise, toQty } from './db.mjs';
import { hashPassword, hashToken, newId, newToken, strength, validUuid, verifyPassword } from './auth.mjs';
import { businessDay } from '../public/js/day.js';

export function checkBook(key, row, previous = {}) {
  if (previous.sale_link) return 'This entry belongs to a sale. Cancel it from Accounts to reverse both records.';
  if (key === 'ledger') {
    const settlement = ['credit-paid','credit-received'].includes(row.category);
    if ((row.mode === 'credit' || settlement) && !row.party_id) return 'Choose the customer or supplier for this credit entry.';
    if (settlement && (row.mode === 'credit' || row.direction !== (row.category === 'credit-paid' ? 'out' : 'in'))) return 'Check the payment direction and method.';
  }
  if (key === 'items' && (row.opening_qty < 0 || row.reorder_qty < 0)) return 'Opening stock and reorder level must be zero or more.';
  return null;
}

function creditDue(db,userId,party) {
  return db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='in' AND mode='credit' THEN amount_paise WHEN category='credit-received' THEN -amount_paise ELSE 0 END),0) AS due FROM ledger WHERE user_id=? AND party_id=? AND deleted_at IS NULL").get(userId,party).due;
}
export function checkedWrite(db, action, itemIds = []) {
  db.exec('BEGIN IMMEDIATE');
  try {
    action();
    for (const id of new Set(itemIds.filter(Boolean))) {
      let qty = db.prepare('SELECT opening_qty FROM items WHERE id=?').get(id).opening_qty;
      for (const day of db.prepare('SELECT SUM(qty) AS change FROM movements WHERE item_id=? AND deleted_at IS NULL GROUP BY occurred_on ORDER BY occurred_on').all(id)) {
        qty = Math.round((qty + day.change) * 1000) / 1000;
        if (qty < 0) {
          db.exec('ROLLBACK');
          return 'There is not enough stock for this entry on that date.';
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return null;
}

export function addBookRoutes({db,on,OK,ERR,sets,isDate}) {
  on('POST', /^\/sales$/, async ({user,body}) => {
    const {id,item_id,mode,occurred_on} = body;
    if (!validUuid(id)) return ERR(422,'invalid','Invalid sale reference.');
    if (db.prepare('SELECT id FROM ledger WHERE user_id=? AND sale_link=?').get(user.id,id)) return OK({id,replayed:true});
    const item = db.prepare('SELECT * FROM items WHERE user_id=? AND id=? AND deleted_at IS NULL').get(user.id,item_id ?? '');
    const qty = toQty(body.qty), rate = toPaise(body.rate);
    const amount = Math.round(qty * rate);
    if (!item || !(qty>0) || !(rate>0) || !Number.isSafeInteger(amount) || amount<1 || toPaise(amount/100) === null || !sets.modes.has(mode) || !isDate(occurred_on) || occurred_on > businessDay()) return ERR(422,'invalid','Check the item, quantity, selling price, payment method and date.');
    let party = body.party_id || null;
    if (party && !db.prepare("SELECT id FROM parties WHERE user_id=? AND id=? AND deleted_at IS NULL AND kind IN ('customer','both')").get(user.id,party)) return ERR(422,'invalid','Choose a customer.');
    const name = String(body.customer ?? '').trim().slice(0,80);
    if (!party && mode === 'credit' && name.length < 2) return ERR(422,'invalid','Choose a customer or enter their name for udhaar.');
    const ts = nowIso();
    const problem = checkedWrite(db, () => {
      if (!party && name) {
        party = newId();
        db.prepare("INSERT INTO parties(id,user_id,name,kind,created_at,updated_at) VALUES(?,?,?,'customer',?,?)").run(party,user.id,name,ts,ts);
      }
      db.prepare("INSERT INTO movements(id,user_id,item_id,qty,unit_paise,party_id,occurred_on,kind,sale_link,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'sale',?,?,?)").run(newId(),user.id,item_id,-qty,rate,party,occurred_on,id,ts,ts);
      db.prepare("INSERT INTO ledger(id,user_id,direction,category,mode,amount_paise,party_id,occurred_on,sale_link,created_at,updated_at,note) VALUES(?,?,'in',?,?,?,?,?,?,?,?,?)").run(id,user.id,mode==='credit'?'credit-sale':'cash-sale',mode,amount,party,occurred_on,id,ts,ts,item.name);
      audit(db,{user_id:user.id,action:'sale',entity:'ledger',entity_id:id});
    },[item_id]);
    return problem ? ERR(422,'stock',problem) : OK({id},201);
  });
  on('DELETE', /^\/sales\/([\w-]+)$/, async ({user,params}) => {
    const id=params[0], ts=nowIso();
    const original=db.prepare('SELECT * FROM ledger WHERE user_id=? AND sale_link=?').get(user.id,id);
    if (!original) return ERR(404,'missing','Sale not found.');
    if (original.deleted_at) return OK({id});
    if (original.mode==='credit' && creditDue(db,user.id,original.party_id)<original.amount_paise) return ERR(409,'settled','Review the customer payment before cancelling this credit sale.');
    checkedWrite(db, () => {
      for (const table of ['movements','ledger']) db.prepare('UPDATE '+table+' SET deleted_at=?,updated_at=? WHERE user_id=? AND sale_link=? AND deleted_at IS NULL').run(ts,ts,user.id,id);
      audit(db,{user_id:user.id,action:'cancel-sale',entity:'ledger',entity_id:id});
    });
    return OK({id});
  });
  on('POST', /^\/recovery-key$/, async ({user,body}) => {
    if (!verifyPassword(String(body.password ?? ''),user.password_hash)) return ERR(403,'invalid','Enter your current password.');
    const key = newToken();
    db.prepare('UPDATE users SET recovery_hash=? WHERE id=?').run(hashToken(key),user.id);
    return OK({key});
  });
  on('POST', /^\/recover$/, async ({body}) => {
    if (!strength(body.password).ok) return ERR(422,'invalid','Use eight or more characters including a letter and number.');
    const owner=db.prepare('SELECT id FROM users WHERE recovery_hash=?').get(hashToken(String(body.key ?? '').trim()));
    if (!owner) return ERR(403,'invalid','That recovery key is invalid or has been used.');
    checkedWrite(db, () => {
      db.prepare('UPDATE users SET password_hash=?, recovery_hash=NULL WHERE id=?').run(hashPassword(body.password),owner.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(owner.id);
    });
    return OK({done:true});
  },{auth:false});
}
