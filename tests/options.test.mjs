// "Har option nahi chal raha hai" - every selectable option in the app is saved
// and read back here, so a dead entry fails the build instead of an owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registered, startTestServer, uid } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog.json'), 'utf8'));
catalog.nicDivisions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/nic-divisions.json'), 'utf8'));
const schemes = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schemes.json'), 'utf8'));

test('the option lists are complete enough to be trusted', () => {
  assert.ok(catalog.organisationTypes.length >= 8, 'Udyam organisation types');
  assert.equal(catalog.nicSections.length, 21, 'NIC sections A-U');
  assert.ok(catalog.nicDivisions.length >= 80, `${catalog.nicDivisions.length} NIC divisions`);
  assert.equal(catalog.states.length, 36, '28 states + 8 union territories');
  assert.ok(catalog.units.length >= 16);
  assert.ok(catalog.expenseCategories.length >= 14);
  assert.equal(catalog.enterpriseSizes.length, 3);

  const sections = new Set(catalog.nicSections.map((s) => s.code));
  for (const d of catalog.nicDivisions) {
    assert.ok(sections.has(d.section), `${d.code} points at section ${d.section}`);
    assert.ok(['manufacturing', 'services', 'trading'].includes(d.activity), `${d.code} activity`);
    assert.ok(d.keywords.length >= 4, `${d.code} needs search words`);
  }
  // every activity a owner can pick must actually lead somewhere
  for (const a of catalog.activities) {
    if (a.id === 'both-manufacturing-and-services') continue;
    assert.ok(catalog.nicDivisions.some((d) => d.activity === a.id), `no activities for ${a.id}`);
  }
  // the April 2025 thresholds are the legal ones, checked against the statute not the file
  const [micro, small, medium] = catalog.enterpriseSizes;
  assert.deepEqual([micro.maxInvestment, micro.maxTurnover], [2.5e7, 1e8]);
  assert.deepEqual([small.maxInvestment, small.maxTurnover], [2.5e8, 1e9]);
  assert.deepEqual([medium.maxInvestment, medium.maxTurnover], [1.25e9, 5e9]);
});

test('the scheme reference is faithful to the source document', () => {
  const list = schemes.filter((s) => s.num);
  assert.equal(list.length, 20, 'the PDF holds twenty products');
  assert.deepEqual(list.map((s) => s.num), Array.from({ length: 20 }, (_, i) => i + 1));
  const ids = new Set();
  for (const s of list) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name && s.shortName && s.purpose, `${s.id} is described`);
    assert.ok(['loan', 'guarantee', 'subsidy', 'invoice-financing', 'bank-product'].includes(s.kind), `${s.id} kind`);
    assert.ok(['open', 'announced', 'confirm'].includes(s.status), `${s.id} status`);
    assert.ok(s.categories.length && s.categories.every((c) => ['micro', 'small', 'medium'].includes(c)), `${s.id} categories`);
    assert.ok(s.documents.length >= 2, `${s.id} documents`);
    assert.ok(s.process.length >= 3, `${s.id} steps`);
    assert.ok(s.caution, `${s.id} carries its caveat`);
    assert.ok(!/n\d/.test(JSON.stringify(s)), `${s.id} still has the corrupted rupee sign`);
    if (s.maxAmountValue != null) assert.ok(s.maxAmountValue > 0);
  }
  // the distinction the source document keeps insisting on
  for (const id of ['cgtmse', 'mcgs-msme', 'cgss', 'cgse']) {
    assert.equal(list.find((s) => s.id === id).kind, 'guarantee', `${id} is a guarantee to the bank, not cash`);
  }
  assert.equal(list.find((s) => s.id === 'micro-enterprise-credit-card').status, 'announced');
  assert.ok(schemes.find((s) => s.id === '_meta').safeguards.length >= 3);
});

test('every option saves and reads back through the real API', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { token } = await registered(srv);
  const party_id=uid();
  await srv.post('/api/parties',{id:party_id,name:'Sample contact',kind:'both'},token);

  await t.test('all 8 organisation types', async () => {
    for (const o of catalog.organisationTypes) {
      const res = await srv.patch('/api/me', { org_type: o.id }, token);
      assert.equal(res.status, 200, o.id);
      assert.equal(res.body.user.org_type, o.id);
    }
  });

  await t.test('all 4 activity types', async () => {
    for (const a of catalog.activities) {
      const res = await srv.patch('/api/me', { activity: a.id }, token);
      assert.equal(res.status, 200, a.id);
      assert.equal(res.body.user.activity, a.id);
    }
  });

  await t.test(`all ${catalog.nicDivisions.length} business activities`, async () => {
    for (const d of catalog.nicDivisions) {
      const res = await srv.patch('/api/me', { nic_code: d.code }, token);
      assert.equal(res.status, 200, `NIC ${d.code} ${d.en}`);
      assert.equal(res.body.user.nic_code, d.code);
      assert.equal(res.body.user.nic_title, d.en, 'the label comes back with it');
    }
  });

  await t.test(`all ${catalog.states.length} states and union territories`, async () => {
    for (const s of catalog.states) {
      const res = await srv.patch('/api/me', { state_code: s.code }, token);
      assert.equal(res.status, 200, s.code);
      assert.equal(res.body.user.state_name, s.en);
    }
  });

  await t.test(`all ${catalog.units.length} units`, async () => {
    for (const u of catalog.units) {
      const res = await srv.post('/api/items', { id: uid(), name: 'Test Item', unit: u.id, purchase: '10', sale: '15' }, token);
      assert.equal(res.status, 201, u.id);
      assert.equal(res.body.item.unit, u.id, `${u.id} came back changed`);
    }
  });

  await t.test('every income and expense category', async () => {
    for(const [direction,category] of [['in','credit-sale'],['out','misc']]) await srv.post('/api/ledger',{direction,category,amount:200,mode:'credit',party_id},token);
    for (const c of [...catalog.incomeCategories, ...catalog.expenseCategories]) {
      const direction = catalog.incomeCategories.includes(c) ? 'in' : 'out';
      const res = await srv.post('/api/ledger', {
        party_id, id: uid(), direction, amount: '100', category: c.id, mode: 'cash', occurred_on: '2026-10-09',
      }, token);
      assert.equal(res.status, 201, `${c.id} (${direction})`);
      assert.equal(res.body.entry.category, c.id);
    }
  });

  await t.test('every payment mode', async () => {
    for (const m of catalog.paymentModes) {
      const res = await srv.post('/api/ledger', {
        party_id, id: uid(), direction: 'out', amount: '50', category: 'misc', mode: m.id, occurred_on: '2026-10-09',
      }, token);
      assert.equal(res.status, 201, m.id);
      assert.equal(res.body.entry.mode, m.id);
    }
  });

  await t.test('each enterprise size classifies from real thresholds', async () => {
    const cases = [
      ['micro', 500000, 2000000],
      ['micro', 9900000, 49000000],
      ['small', 50000000, 49000000, 'turnover still micro-sized but investment is small'],
      ['small', 5000000, 400000000],
      ['medium', 300000000, 100000000],
      ['medium', 5000000, 2000000000],
      [null, 1600000000, 100000000, 'past the medium investment ceiling'],
      [null, 1000000, 6000000000, 'past the medium turnover ceiling'],
    ];
    for (const [want, investment, turnover, why = ''] of cases) {
      const res = await srv.patch('/api/me', { investment: String(investment), turnover: String(turnover) }, token);
      assert.equal(res.status, 200, `${investment}/${turnover}`);
      assert.equal(res.body.user.size_class, want ?? '', `${investment}/${turnover} -> ${want} ${why}`);
    }
  });
});
