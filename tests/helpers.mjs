import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createServer } from '../server.mjs';

export function tmpDb(name = 'test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `udisa-${name}-`));
  return path.join(dir, 'udisa.db');
}

export async function startTestServer({ dbFile = tmpDb() } = {}) {
  const { server, db } = createServer({ dbFile, quiet: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  let closed = false;

  const client = async (method, route, { body, token } = {}) => {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + route.replace(/^\//, ''), {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers };
  };

  return {
    base,
    db,
    server,
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      try { db.close(); } catch {}
      const done = () => resolve();
      server.close(done);
      setTimeout(done, 400).unref(); // keep-alive sockets would otherwise hang the run
    }),
    get: (route, token) => client('GET', route, { token }),
    post: (route, body, token) => client('POST', route, { body, token }),
    put: (route, body, token) => client('PUT', route, { body, token }),
    patch: (route, body, token) => client('PATCH', route, { body, token }),
    del: (route, token) => client('DELETE', route, { token }),
  };
}

let counter = 0;
export function sampleProfile(over = {}) {
  counter += 1;
  return {
    udyam_id: 'UDYAM-MH-01-'+String(counter).padStart(7,'0'),
    owner_name: 'Vinayak Kumar',
    business_name: `Shree Kirana Store ${counter}`,
    phone: `9${String(800000000 + counter).slice(0, 9)}`,
    password: 'stock1234',
    org_type: 'proprietorship',
    activity: 'trading',
    nic_code: '47',
    state_code: 'UP',
    district: 'Lucknow',
    investment: '400000',
    turnover: '2500000',
    lang: 'en',
    ...over,
  };
}

export async function registered(srv, over) {
  const profile = sampleProfile(over);
  const res = await srv.post('/api/register', profile);
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, user: res.body.user, profile };
}

export const uid = () => crypto.randomUUID();
