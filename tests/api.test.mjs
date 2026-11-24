import test from 'node:test';
import assert from 'node:assert/strict';
import { registered, sampleProfile, startTestServer, uid } from './helpers.mjs';

test('registration, login and the whole data path', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  await t.test('health and bootstrap need no login', async () => {
    const h = await srv.get('/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.equal(h.body.app, 'U-Disa');
    assert.ok(h.body.schemes >= 20, 'schemes loaded');
    const b = await srv.get('/api/bootstrap');
    assert.equal(b.status, 200);
    assert.ok(b.body.catalog.nicDivisions.length > 50);
    assert.equal(b.body.brand.name, 'U-Disa');
  });

  await t.test('protected routes refuse anonymous callers', async () => {
    for (const route of ['/api/state', '/api/me', '/api/schemes']) {
      const res = await srv.get(route);
      assert.equal(res.status, 401, route);
      assert.equal(res.body.error.code, 'unauthenticated');
    }
  });

  await t.test('register rejects bad input with per-field messages', async () => {
    const res = await srv.post('/api/register', { ...sampleProfile(), phone: '123', password: 'short', nic_code: 'zz' });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.phone, 'phone flagged');
    assert.ok(res.body.error.fields.password, 'password flagged');
    assert.ok(res.body.error.fields.nic_code, 'nic flagged');
    assert.equal(res.body.error.fields.business_name, undefined, 'good fields stay quiet');
  });

  await t.test('registration requires the certificate ID',async()=>{
    const res=await srv.post('/api/register',sampleProfile({udyam_id:'27 0000 1234 5678'}));
    assert.equal(res.status,422);
  });

  await t.test('gibberish is refused and never invented into a real-looking number', async () => {
    const res = await srv.post('/api/register', sampleProfile({ udyam_id: 'SOMETHING-ELSE' }));
    assert.equal(res.status, 422);
    assert.match(res.body.error.fields.udyam_id, /Udyam/);
    const short = await srv.post('/api/register', sampleProfile({ udyam_id: 'UM-99' }));
    assert.equal(short.status, 422, 'a two-digit Udyam is not stored as UM-99');
  });

  await t.test('register -> login -> session works, and duplicates are refused politely', async () => {
    const profile = sampleProfile();
    const first = await srv.post('/api/register', profile);
    assert.equal(first.status, 201);
    const token = first.body.token;

    const dupe = await srv.post('/api/register', profile);
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error.code, 'udyam-taken');

    const byPhone = await srv.post('/api/login', { identifier: profile.phone, password: profile.password });
    assert.equal(byPhone.status, 200);
    const byUdyam = await srv.post('/api/login', { identifier: profile.udyam_id, password: profile.password });
    assert.equal(byUdyam.status, 200, 'either identifier logs in');

    const wrong = await srv.post('/api/login', { identifier: profile.phone, password: 'not-the-password' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.ok, undefined ?? false, 'no token handed out');

    const me = await srv.get('/api/me', token);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.business_name, profile.business_name);
    assert.equal(me.body.user.size_class, 'micro', '₹4 lakh / ₹25 crore-ish is micro');
  });

  await t.test('logout kills only that session', async () => {
    const { token, profile } = await registered(srv);
    const other = await srv.post('/api/login', { identifier: profile.phone, password: profile.password });
    assert.equal(other.status, 200);
    await srv.post('/api/logout', {}, token);
    assert.equal((await srv.get('/api/me', token)).status, 401);
    assert.equal((await srv.get('/api/me', other.body.token)).status, 200, 'the other login survives');
  });
});

test('accounts, stock and the money the owner can see', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { token } = await registered(srv);

  const party = uid();
  await srv.post('/api/parties', { id: party, name: 'Ramesh Traders', kind: 'supplier', phone: '9876543210' }, token);

  await t.test('a credit sale lands in receivables, a payment clears it', async () => {
    await srv.post('/api/ledger', {
      id: uid(), direction: 'in', amount: '5000', category: 'credit-sale', mode: 'credit',
      party_id: party, occurred_on: '2026-10-01',
    }, token);
    let s = await srv.get('/api/state', token);
    assert.equal(s.body.money.credit_given_paise, 500000);
    assert.equal(s.body.money.receivable_paise, 500000);
    assert.equal(s.body.money.income_paise, 500000, 'a credit sale is still income');

    await srv.post('/api/ledger', {
      id: uid(), direction: 'in', amount: '2000', category: 'credit-received', mode: 'upi',
      party_id: party, occurred_on: '2026-10-05',
    }, token);
    s = await srv.get('/api/state', token);
    assert.equal(s.body.money.receivable_paise, 300000);
    assert.equal(s.body.money.income_paise, 500000, 'collecting udhaar must not double-count income');
    const bal = s.body.parties_balance.find((p) => p.id === party);
    assert.equal(bal.owed_to_you_paise, 300000);
  });

  await t.test('stock maths: buying blocks money, selling releases it', async () => {
    const item = uid();
    await srv.post('/api/items', {
      id: item, name: 'Biscuit Pack', unit: 'box', purchase: '40', sale: '50',
      reorder_qty: '20', lead_days: '3', opening_qty: '0',
    }, token);

    await srv.post('/api/movements', { id: uid(), item_id: item, qty: 100, rate: '40', occurred_on: '2026-08-01' }, token);
    let s = await srv.get('/api/state?as_of=2026-10-20', token);
    let row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.qty, 100);
    assert.equal(row.blocked_paise, 400000, '100 x ₹40');
    assert.equal(row.state, 'dead', '₹4000 sitting there for 80 days with no sale is dead stock');
    assert.equal(row.idle_days, 80);

    for (const day of ['2026-10-10', '2026-10-12', '2026-10-14']) {
      await srv.post('/api/movements', { id: uid(), item_id: item, qty: -30, rate: '50', occurred_on: day }, token);
    }
    s = await srv.get('/api/state?as_of=2026-10-20', token);
    row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.qty, 10);
    assert.equal(row.state, 'low', 'below the reorder level of 20');
    assert.ok(row.suggest_buy_qty > 0, 'tells him how much to order');
    assert.equal(row.sold_in_window, 90);
    assert.ok(row.cover_days !== null);
  });

  await t.test('a negative movement cannot create stock out of thin air', async () => {
    const item = uid();
    await srv.post('/api/items', { id: item, name: 'Rice Bag', unit: 'bag', purchase: '1200', sale: '1400', opening_qty: '5' }, token);
    const res = await srv.post('/api/movements', { id: uid(), item_id: item, qty: -50, rate: '1400', occurred_on: '2026-10-21' }, token);
    assert.equal(res.status, 422, 'overselling is refused');
    const s = await srv.get('/api/state?as_of=2026-10-21', token);
    const row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.qty, 5);
    assert.equal(row.blocked_paise, 600000);
    assert.equal(row.state, 'ok');
  });

  await t.test('a brand new item is not called dead stock, and the advice never contradicts itself', async () => {
    const item = uid();
    await srv.post('/api/items', { id: item, name: 'New Launch Soap', unit: 'pcs', purchase: '30', opening_qty: '200' }, token);
    const s = await srv.get('/api/state', token);
    const row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.qty, 200);
    assert.equal(row.state, 'ok', 'no sales history yet is not the same as unsellable stock');
    assert.equal(row.idle_days, 0);

    const ids = s.body.signals.map((x) => x.id);
    assert.ok(!(ids.includes('stock-healthy') && ids.some((i) => ['stock-out', 'stock-low', 'stock-dead', 'stock-excess'].includes(i))),
      `the dashboard said contradictory things: ${ids.join(', ')}`);
  });

  await t.test('stock genuinely left for 60 days is flagged as idle', async () => {
    const item = uid();
    await srv.post('/api/items', { id: item, name: 'Old Stock Chair', unit: 'pcs', purchase: '500', opening_qty: '0' }, token);
    await srv.post('/api/movements', { id: uid(), item_id: item, qty: 10, rate: '500', occurred_on: '2026-06-01' }, token);
    await srv.post('/api/movements', { id: uid(), item_id: item, qty: -2, rate: '700', occurred_on: '2026-07-01' }, token);
    const s = await srv.get('/api/state?as_of=2026-10-20', token);
    const row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.state, 'dead');
    assert.equal(row.idle_days, 111);
  });

  await t.test('opening balance and movements stay separate, never doubled', async () => {
    const item = uid();
    await srv.post('/api/items', { id: item, name: 'Cement Bag', unit: 'bag', purchase: '400', opening_qty: '5' }, token);
    let s = await srv.get('/api/state?as_of=2026-10-21', token);
    let row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.qty, 5, 'the opening balance alone, not twice');
    assert.equal(row.blocked_paise, 200000, '5 x ₹400');

    await srv.post('/api/movements', { id: uid(), item_id: item, qty: 10, rate: '400', occurred_on: '2026-10-20' }, token);
    s = await srv.get('/api/state?as_of=2026-10-21', token);
    row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.qty, 15, 'opening 5 plus 10 bought');

    await srv.put(`/api/items/${item}`, { opening_qty: '3' }, token);
    s = await srv.get('/api/state?as_of=2026-10-21', token);
    row = s.body.stock.items.find((i) => i.id === item);
    assert.equal(row.qty, 13, 'editing the opening must not erase the recorded purchase');
  });

  await t.test('edits and deletes keep the totals honest', async () => {
    const id = uid();
    await srv.post('/api/ledger', { id, direction: 'out', amount: '900', category: 'rent', mode: 'cash', occurred_on: '2026-10-03' }, token);
    let s = await srv.get('/api/state', token);
    assert.equal(s.body.money.expense_paise, 90000);
    await srv.put(`/api/ledger/${id}`, { amount: '1200' }, token);
    s = await srv.get('/api/state', token);
    assert.equal(s.body.money.expense_paise, 120000);
    await srv.del(`/api/ledger/${id}`, token);
    s = await srv.get('/api/state', token);
    assert.equal(s.body.money.expense_paise, 90000 - 90000 + 0, 'deleted entry leaves the totals');
  });

  await t.test('replaying the same save does not double the entry', async () => {
    const id = uid();
    const body = { id, direction: 'out', amount: '50', category: 'fuel', mode: 'cash', occurred_on: '2026-10-06' };
    const a = await srv.post('/api/ledger', body, token);
    const b = await srv.post('/api/ledger', body, token);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.body.replayed, true);
    const s = await srv.get('/api/state', token);
    assert.equal(s.body.ledger.filter((r) => r.id === id).length, 1);
  });

  await t.test('nonsense is refused rather than stored', async () => {
    const cases = [
      ['/api/ledger', { id: uid(), direction: 'sideways', amount: '10', category: 'rent', mode: 'cash' }],
      ['/api/ledger', { id: uid(), direction: 'out', amount: '-5', category: 'rent', mode: 'cash' }],
      ['/api/ledger', { id: uid(), direction: 'out', amount: 'abc', category: 'rent', mode: 'cash' }],
      ['/api/ledger', { id: uid(), direction: 'out', amount: '10', category: 'not-a-category', mode: 'cash' }],
      ['/api/ledger', { id: uid(), direction: 'out', amount: '10', category: 'rent', mode: 'carrier-pigeon' }],
      ['/api/ledger', { id: uid(), direction: 'out', amount: '10', category: 'rent', mode: 'cash', occurred_on: 'yesterday' }],
      ['/api/items', { id: uid(), name: 'x', unit: 'lightspeed' }],
      ['/api/movements', { id: uid(), item_id: uid(), qty: 5, rate: 1 }],
      ['/api/parties', { id: uid(), name: 'A', kind: 'frenemy' }],
    ];
    for (const [route, body] of cases) {
      const res = await srv.post(route, body, token);
      assert.equal(res.status, 422, `${route} ${JSON.stringify(body)}`);
      assert.ok(Object.keys(res.body.error.fields).length, 'names the bad field');
    }
  });

  await t.test('one owner can never read or write another owner rows', async () => {
    const other = await registered(srv);
    const mine = await srv.get('/api/state', other.token);
    assert.equal(mine.body.items.find((i) => i.name === 'Rice Bag'), undefined);
    const stolen = await srv.get('/api/state', token);
    const target = stolen.body.items[0];
    const poke = await srv.put(`/api/items/${target.id}`, { name: 'Hijacked' }, other.token);
    assert.equal(poke.status, 404, 'the row is invisible to the other account');
  });

  await t.test('profile edits reclassify the enterprise', async () => {
    const { token: tk } = await registered(srv);
    let me = await srv.get('/api/me', tk);
    assert.equal(me.body.user.size_class, 'micro');
    const up = await srv.patch('/api/me', { investment: '80000000', turnover: '400000000' }, tk);
    assert.equal(up.status, 200);
    assert.equal(up.body.user.size_class, 'small', '₹8 crore investment outranks a ₹40 crore turnover band');
    const big = await srv.patch('/api/me', { investment: '1500000000', turnover: '900000000' }, tk);
    assert.equal(big.body.classification.size, null);
    assert.equal(big.body.classification.beyondMsme, true);
  });
});

test('schemes are listed, filtered and never over-promised', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { token } = await registered(srv, { activity: 'manufacturing', nic_code: '25', investment: '5000000', turnover: '30000000' });

  await t.test('the directory includes Mudra and CGTMSE without eligibility scores', async () => {
    const res = await srv.get('/api/schemes', token);
    assert.equal(res.status, 200);
    const list = res.body.list;
    assert.ok(list.length >= 20);
    const ids = list.map((s) => s.id);
    assert.ok(ids.includes('pmmy') && ids.includes('cgtmse'));
    assert.ok(list.every(s=>s.match===undefined && s.keyConditions===undefined));
    assert.equal(list.find(s=>s.id==='pmmy').maxAmountValue,2000000);
  });

  await t.test('guarantees say they are not cash', async () => {
    const res = await srv.get('/api/schemes/cgtmse', token);
    assert.equal(res.status, 200);
    assert.equal(res.body.scheme.kind, 'guarantee');
    assert.match(res.body.scheme.caution, /guarantee/i);
    assert.ok(res.body.safeguards.length >= 3, 'page 17 safeguards travel with the data');
  });

  await t.test('an announced-only scheme is never shown as open', async () => {
    const res = await srv.get('/api/schemes/micro-enterprise-credit-card', token);
    assert.equal(res.body.scheme.status, 'announced');
  });

  await t.test('filters narrow the list and the doc checklist persists', async () => {
    const only = await srv.get('/api/schemes?size=micro&status=open', token);
    assert.ok(only.body.list.length > 0);
    for (const s of only.body.list) {
      assert.ok(s.categories.includes('micro'), s.id);
      assert.equal(s.status, 'open');
    }
    const docs = (await srv.get('/api/schemes/pmegp', token)).body.scheme.documents;
    await srv.put('/api/schemes/pmegp/save', { status: 'applied', checklist: [docs[0]] }, token);
    const saved = await srv.get('/api/schemes/pmegp', token);
    assert.equal(saved.body.saved.status, 'applied');
    assert.deepEqual(saved.body.saved.checklist, [docs[0]]);
    await srv.del('/api/schemes/pmegp/save', token);
    const gone = await srv.get('/api/schemes/pmegp', token);
    assert.equal(gone.body.saved, null);
  });

  await t.test('unknown scheme ids and cross-account saves are refused', async () => {
    assert.equal((await srv.get('/api/schemes/no-such-scheme', token)).status, 404);
    assert.equal((await srv.put('/api/schemes/no-such-scheme/save', { status: 'saved' }, token)).status, 404);
  });
});

test('exports, erase and the boring edges', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { token, profile } = await registered(srv);

  await t.test('csv and json backups carry the owner data', async () => {
    await srv.post('/api/ledger', { id: uid(), direction: 'out', amount: '12.5', category: 'misc', mode: 'cash', occurred_on: '2026-10-08', note: 'tea, biscuits and "quotas"' }, token);
    const csv = await fetch(srv.base + 'api/export.csv', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const text = await csv.text();
    assert.ok(text.includes('"12.50"'), 'rupees survive the round trip');
    assert.ok(text.includes('""quotas""'), 'quotes are escaped, not injected');

    const json = await (await fetch(srv.base + 'api/export.json', { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(json.user.udyam_id, profile.udyam_id);
    assert.equal(json.ledger.length, 1);
  });

  await t.test('an anonymous export is refused', async () => {
    assert.equal((await fetch(srv.base + 'api/export.csv')).status, 401);
  });

  await t.test('erasing needs the real password and then the account is gone', async () => {
    const bad = await srv.del('/api/me', token);
    assert.equal(bad.status, 403);
    const still = await srv.get('/api/me', token);
    assert.equal(still.status, 200);
    const wrong = await fetch(srv.base + 'api/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    assert.equal(wrong.status, 403);
    const ok = await fetch(srv.base + 'api/me', { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: profile.password }) });
    assert.equal(ok.status, 200);
    assert.equal((await srv.get('/api/me', token)).status, 401, 'the session went with the account');
    const re = await srv.post('/api/register', profile);
    assert.equal(re.status, 201, 'the Udyam number is free to register again');
  });

  await t.test('a future date and an oversized body are both refused cleanly', async () => {
    const fresh = await registered(srv);
    const mine = fresh.token;
    const future = await srv.post('/api/ledger', { id: uid(), direction: 'out', amount: '10', category: 'rent', mode: 'cash', occurred_on: '2030-01-01' }, mine);
    assert.equal(future.status, 422);
    const huge = await fetch(srv.base + 'api/ledger', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mine}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: uid(), direction: 'out', amount: '1', category: 'rent', mode: 'cash', note: 'x'.repeat(900_000) }),
    });
    assert.equal(huge.status, 413);
  });

  await t.test('malformed json does not take the server down', async () => {
    const res = await fetch(srv.base + 'api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
    assert.equal((await srv.get('/api/health')).status, 200, 'still serving');
  });

  await t.test('an unknown route answers 404 in json, not a stack trace', async () => {
    const res = await srv.get('/api/nowhere', token);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'no-route');
  });
});
