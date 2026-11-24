import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {createApi} from '../src/api.mjs';
import {loadAssets} from '../server.mjs';
import {sampleProfile} from './helpers.mjs';
import {businessDay} from '../public/js/day.js';

test('sale, replay, stock adjustment, collection, recovery and logout',async t=>{
  const db=openDb(':memory:');t.after(()=>db.close());
  const api=createApi({db,...loadAssets(),version:'test'});
  let token='';
  const request=(method,path,body={})=>api.handle({method,path,body,user:api.userFor(token),token,ip:'local',ua:'test',query:{}});
  const profile=sampleProfile({udyam_id:'UDYAM-MH-01-2345678'});
  const owner=await request('POST','/register',profile);assert.equal(owner.status,201);token=owner.body.token;
  const item=await request('POST','/items',{name:'Notebook',unit:'pcs',purchase:20,sale:40,opening_qty:5});
  const item_id=item.body.item.id, occurred_on=businessDay();
  const sale={id:crypto.randomUUID(),item_id,occurred_on,qty:2,rate:40,mode:'credit',customer:'Test Customer'};
  assert.equal((await request('POST','/sales',sale)).status,201);
  assert.equal((await request('POST','/sales',sale)).body.replayed,true);
  assert.equal((await request('POST','/sales',{...sale,customer:'Another customer',qty:4,id:crypto.randomUUID()})).status,422);
  assert.equal((await request('POST','/movements',{item_id,kind:'damage',qty:-1,occurred_on})).status,201);
  let state=(await request('GET','/state')).body;
  assert.equal(state.stock.items[0].qty,2);assert.equal(state.stock.items[0].sold_in_window,2);
  assert.equal(state.money.receivable_paise,8000);assert.equal(state.parties.length,1);
  const entry={direction:'in',mode:'credit',category:'credit-sale',amount:50,occurred_on};
  assert.equal((await request('POST','/ledger',entry)).status,422);
  assert.equal((await request('POST','/ledger',{...entry,category:'credit-received',mode:'upi',party_id:state.parties[0].id})).status,201);
  state=(await request('GET','/state')).body;
  assert.equal(state.money.receivable_paise,3000);assert.equal(state.money.income_paise,8000);
  const cashSale={...sale,id:crypto.randomUUID(),qty:1,mode:'cash',customer:''};
  await request('POST','/sales',cashSale);
  await request('DELETE','/sales/'+cashSale.id);
  assert.equal((await request('GET','/state')).body.stock.items[0].qty,2);
  const key=(await request('POST','/recovery-key',{password:profile.password})).body.key;
  assert.equal((await request('POST','/logout')).status,200);assert.equal((await request('GET','/me')).status,401);
  assert.equal((await request('POST','/recover',{key,password:'NewBook123'})).status,200);
  assert.equal((await request('POST','/recover',{key,password:'Another123'})).status,403);
  assert.equal((await request('POST','/login',{identifier:profile.udyam_id,password:'NewBook123'})).status,200);
  assert.equal(businessDay(new Date('2026-11-23T19:00:00Z')),'2026-11-24');
});

test('interrupted replay keeps unacknowledged entries and isolates business queues',async()=>{
  const storage={};
  Object.defineProperties(storage,{
    getItem:{value:k=>storage[k]??null},setItem:{value:(k,v)=>{storage[k]=String(v);}},removeItem:{value:k=>{delete storage[k];}}
  });
  globalThis.localStorage=storage;globalThis.window={addEventListener(){}};
  Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});
  const net=await import('../public/js/api.js');
  net.setOwner('shop-a');
  for(let i=0;i<3;i++) await net.post('/ledger',{id:crypto.randomUUID()});
  net.setOwner('shop-b');assert.equal(net.queueSize(),0);
  net.setOwner('shop-a');assert.equal(net.queueSize(),3);
  let n=0;globalThis.fetch=async(_url,opts)=>{
    assert.equal(opts.headers['X-Udisa-Owner'],'shop-a');
    if(++n>1)throw Error('offline');
    return new Response('{"ok":true}',{status:200});
  };
  assert.equal(await net.flushQueue(),2);
  globalThis.fetch=async()=>new Response('{"ok":true}',{status:200});
  assert.equal(await net.flushQueue(),0);
});
