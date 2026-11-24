import { translator, LANGS } from './i18n.js';
import * as net from './api.js';
import {
  h, $, fill, money, rupees, groupIndian, parseNum, qtyText, today, thisMonth, monthOf, monthName,
  dayLabel, uid, logoMark, toast, sheet, confirmSheet, emptyBox, badge, picker, makeForm, clearDrafts, speak,
} from './ui.js';

const state = {
  brand: null,
  catalog: null,
  version: '',
  online: navigator.onLine,
  queued: 0,
  lastVerified: null,
  user: null,
  data: null,
  lang: 'en',
  t: translator('en'),
  schemeCache: new Map(),
};

const t = (key, params) => state.t(key, params);
const say = (en,hi) => state.lang === 'hi' ? hi : en;
const cat = (name) => state.catalog?.[name] ?? [];
const plural = (n, one, many) => t(n === 1 ? one : many, { n });
const L = (name, id) => {
  const list = name === 'nicDivisions' ? cat('nicDivisions') : cat(name);
  const e = list.find((x) => (x.id ?? x.code) === id);
  if (!e) return id ?? '';
  return state.lang === 'hi' && e.hi ? e.hi : e.en;
};
const short = (e) => (state.lang === 'hi' && e.hi ? e.hi : e.en);

function setLang(lang) {
  state.lang = LANGS.includes(lang) ? lang : 'en';
  state.t = translator(state.lang);
  document.documentElement.lang = state.lang;
  try { localStorage.setItem('udisa.lang', state.lang); } catch {}
}

// ------------------------------------------------------------------ transport

const VERBS = { GET: net.get, POST: net.post, PUT: net.put, PATCH: net.patch, DELETE: net.del };

async function api(method, path, body, { quiet = false } = {}) {
  // an unlisted verb must never quietly become something destructive
  const send = VERBS[method];
  if (!send) throw new Error(`unknown HTTP method ${method}`);
  try {
    const out = method === 'GET' ? await send(path) : await send(path, body);
    if (out?.queued && !quiet) toast(t, t('err.offline-queue'), 'bad');
    return out;
  } catch (err) {
    const hasFieldErrors = err.fields && Object.keys(err.fields).length > 0;
    if (!quiet && !hasFieldErrors) {
      toast(t, err.code === 'network' ? t('err.network') : err.code === 'too-many' ? t('err.too-many') : (err.message || t('err.server')), 'bad');
    }
    throw err;
  }
}

async function refresh() {
  try {
    state.data = await api('GET', '/state', null, { quiet: true });
    try { sessionStorage.setItem('udisa.view', JSON.stringify({token:net.getToken(),user:state.user,data:state.data})); } catch {}
  } catch (error) {
    if (error.code !== 'network' || !state.data) throw error;
    state.online = false;
  }
  render();
}

// -------------------------------------------------------------------- routing

const TABS = [
  { id: 'home', icon: '🏠', key: 'tab.home' },
  { id: 'money', icon: '💰', key: 'tab.money' },
  { id: 'stock', icon: '📦', key: 'tab.stock' },
  { id: 'govt', icon: '🏛️', key: 'tab.govt' },
  { id: 'me', icon: '👤', key: 'tab.me' },
];

function current() {
  const m = /^#\/([\w-]+)(?:\/([^/]+))?$/.exec(location.hash || '');
  if (!m) return { route: 'home', arg: null };
  return { route: m[1], arg: m[2] ? decodeURIComponent(m[2]) : null };
}

function go(route, arg) {
  const next = `#/${route}${arg != null ? `/${encodeURIComponent(arg)}` : ''}`;
  if (location.hash !== next) location.hash = next;
  else render();
}

function render() {
  const root = $('#app');
  if (!root) return;
  fill(root, state.user ? shell() : authScreen());
  root.hidden = false;
  const boot = $('#boot');
  if (boot) boot.hidden = true;
  document.title = state.brand?.name ?? 'U-Disa';
}

function shell() {
  const { route } = current();
  const screen = { home, money: moneyScreen, stock: stockScreen, govt: govtScreen, me: meScreen }[route] ?? home;
  return h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('button', { class: 'brand', style: 'background:none;border:0;padding:0;cursor:pointer', onclick: () => go('home'), title: state.brand.name },
        logoMark(34, state.brand.name),
        h('div', { style: 'text-align:left' }, h('b', null, state.brand.name), h('small', null, t('app.tagline')))),
      h('div', { class: 'top-spacer' }),
      state.queued ? h('button', { class: 'lang-btn', title: t('err.offline-queue'), onclick: () => go('me') }, `⏳ ${state.queued}`) : null,
      h('span', { class: `net-dot ${state.online ? '' : 'off'}`, title: state.online ? 'online' : 'offline' }),
      h('button', { class: 'lang-btn', onclick: () => { setLang(state.lang === 'en' ? 'hi' : 'en'); void api('PATCH', '/me', { lang: state.lang }, { quiet: true }).catch(() => {}); render(); } },
        state.lang === 'en' ? 'हिंदी' : 'English')
    ),
    state.online ? null : h('p', { class: 'sig warn', style: 'margin:12px 14px 0' }, t('net.offline')),
    h('main', {}, screen()),
    h('nav', { class: 'tabs' }, TABS.map((tab) => h('button', {
      'aria-label':t(tab.key), 'aria-current': route === tab.id ? 'page' : null,
      onclick: () => go(tab.id),
    }, h('span', { class: 'nav-symbol','aria-hidden':'true' }, {home:'⌂',money:'₹',stock:'▤',govt:'▥',me:'○'}[tab.id]), h('span', null, t(tab.key)))))
  );
}

// ----------------------------------------------------------------------- auth

function authScreen() {
  const mode = location.hash.startsWith('#/login') ? 'login' : location.hash.startsWith('#/register') ? 'register' : 'choose';
  const body = mode === 'login' ? loginForm() : mode === 'register' ? registerForm() : welcome();
  return h('div', { class: 'shell' },
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, logoMark(34, state.brand?.name ?? 'U-Disa'), h('div', null, h('b', null, state.brand?.name ?? 'U-Disa'), h('small', null, t('app.tagline')))),
      h('div', { class: 'top-spacer' }),
      h('button', { class: 'lang-btn', onclick: () => { setLang(state.lang === 'en' ? 'hi' : 'en'); render(); } }, state.lang === 'en' ? 'हिंदी' : 'English')
    ),
    h('main', {}, body)
  );
}

function welcome() {
  return h('div',{class:'welcome card'},
    logoMark(72,state.brand.name),h('h1',null,t('auth.welcome')),
    h('p',{class:'muted'},say('Keep track of sales, stock and udhaar in your business book.','अपनी बिक्री, स्टॉक और उधार का हिसाब एक जगह रखें।')),
    h('button',{class:'btn btn-primary btn-lg btn-block',onclick:()=>go('register')},t('auth.newAccount')),
    h('button',{class:'btn btn-lg btn-block',onclick:()=>go('login')},t('auth.haveAccount')));
}

function loginForm() {
  const form = makeForm([
    { name: 'identifier', label: t('auth.identifier'), required: true, inputmode: 'text', autocomplete: 'username', draftKey: 'login-id' },
    { name: 'password', label: t('auth.password'), inputType: 'password', required: true, autocomplete: 'current-password' },
  ]);
  const submit = async (e) => {
    e?.preventDefault();
    const v = form.get();
    const btn = e.target.closest('form')?.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      const out = await api('POST', '/login', v, { quiet: true });
      net.setToken(out.token);
      state.user = out.user;
      net.setOwner(out.user.id);
      state.queued = net.queueSize();
      await net.flushQueue();
      clearDrafts('reg-');
      history.replaceState(null,'','#/home');
      await refresh();
      toast(t, `${t('auth.welcome')} ${out.user.business_name}`, 'good');
    } catch (err) {
      if (err.fields && Object.keys(err.fields).length) form.showErrors(err.fields);
      else toast(t, err.code === 'too-many' ? t('err.too-many') : t('auth.login') + ' - ' + (err.message || t('common.retryLater')), 'bad');
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('h1', { style: 'font-size:23px;font-weight:800;margin-bottom:10px' }, t('auth.loginTitle')),
      h('form', { onsubmit: submit }, form.node,
        h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, t('auth.login'))),
      h('p', { class: 'help', style: 'margin-top:12px' }, h('button',{class:'btn btn-ghost',onclick:()=>recovery(false)},t('auth.forgot')))
    ),
    h('button', { class: 'btn btn-ghost', onclick: () => go('choose') }, '← ', t('common.back'))
  );
}

const REG_STEPS = 3;
const REG_KEY = 'udisa.reg';

function readReg() {
  try { return JSON.parse(localStorage.getItem(REG_KEY) || '{}'); } catch { return {}; }
}
function writeReg(patch) {
  try { localStorage.setItem(REG_KEY, JSON.stringify({ ...readReg(), ...patch, password:undefined, password2:undefined })); } catch {}
}

/**
 * Three independent forms, one per step. A shared form is where the old build
 * lost values between steps; here each step owns its fields and its own errors,
 * and the whole answer set is mirrored to localStorage after every step so a
 * crash or an accidental reload does not send the owner back to the start.
 */
function registerForm() {
  const saved = readReg();
  let step = Math.min(REG_STEPS, Math.max(1, Number(sessionStorage.getItem('udisa.regstep') || 1)));
  const nicState = { code: saved.nic_code || '', query: '' };

  const formA = makeForm([
    { name: 'business_name', label: t('auth.businessName'), required: true, value: saved.business_name ?? '', autocomplete: 'organization' },
    { name: 'owner_name', label: t('auth.ownerName'), required: true, value: saved.owner_name ?? '', autocomplete: 'name' },
    { name: 'phone', label: t('auth.phone'), required: true, inputmode: 'numeric', value: saved.phone ?? '', help: t('auth.phoneHelp'), autocomplete: 'tel' },
    { name: 'udyam_id', label: t('auth.udyam'), required: true, value: saved.udyam_id ?? '', help: t('auth.udyamHelp'), autocomplete: 'off' },
  ]);
  const formC = makeForm([
    { name: 'password', label: t('auth.password'), inputType: 'password', required: true, help: t('auth.passwordHelp'), autocomplete: 'new-password' },
    { name: 'password2', label: t('auth.passwordAgain'), inputType: 'password', required: true, autocomplete: 'new-password' },
    { name: 'investment', label: t('auth.investment'), inputmode: 'decimal', value: saved.investment ?? '', help: t('auth.sizeAuto') },
    { name: 'turnover', label: t('auth.turnover'), inputmode: 'decimal', value: saved.turnover ?? '' },
    { name: 'district', label: `${t('auth.district')} (${t('common.optional')})`, value: saved.district ?? '' },
  ]);

  const orgPick = picker({
    name: 'org_type', options: cat('organisationTypes'), value: saved.org_type ?? null, label: t('auth.orgType'),
    labelOf: short, columns: true, onPick: (v) => writeReg({ org_type: v }),
  });
  const actPick = picker({
    name: 'activity', options: cat('activities'), value: saved.activity ?? null, label: t('auth.activity'),
    labelOf: short, onPick: (v) => { nicState.code=''; writeReg({ activity:v,nic_code:'' }); renderNic(); },
  });
  const statePick = picker({
    name: 'state_code', options: cat('states'), value: saved.state_code ?? null, label: t('auth.state'),
    labelOf: short, onPick: (v) => writeReg({ state_code: v }),
  });
  const langPick = picker({
    name: 'lang', options: cat('languages').filter((l) => LANGS.includes(l.id)), value: state.lang,
    label: t('me.lang'), labelOf: (o) => `${o.en} / ${o.hi}`, onPick: (v) => { setLang(v); writeReg({ lang: v }); },
  });

  const nicBox = h('div', { class: 'stack' });
  const results = h('div', {class:'stack activity-results'});
  const search = h('input',{type:'search',placeholder:t('auth.nicHelp'),oninput:e=>{nicState.query=e.target.value;renderNic();}});
  nicBox.append(h('label',{class:'f'},h('span',null,t('auth.nic')),search), results);
  function renderNic() {
    const q = nicState.query.trim().toLowerCase();
    const all = cat('nicDivisions');
    const activity = actPick.get();
    const pool = q
      ? all.filter((d) => `${d.code} ${d.en} ${d.hi} ${(d.keywords ?? []).join(' ')}`.toLowerCase().includes(q))
      : activity && activity !== 'both-manufacturing-and-services'
        ? all.filter((d) => d.activity === activity)
        : all;
    const shown = pool;
    const pick = picker({
      name: 'nic_code', options: shown, value: nicState.code || null, label: t('auth.nic'), columns: true,
      labelOf: (o) => `${o.code} · ${state.lang === 'hi' && o.hi ? o.hi : o.en}`,
      onPick: (v) => { nicState.code = v; writeReg({ nic_code: v }); renderNic(); },
    });
    fill(results,
      shown.length ? pick.node : h('p', { class: 'err' }, t('common.notFound')),
      nicState.code
        ? h('p', { class: 'sig good' }, h('span', { class: 'ico' }, '✅'),
          h('div', null, `${nicState.code} · ${(cat('nicDivisions').find((d) => d.code === nicState.code) ?? {}).en ?? ''}`))
        : null
    );
  }
  renderNic();

  const wrap = (label, node, name) => h('div', { dataset: { name } },
    h('label', { class: 'f' }, h('span', null, `${label} *`), node),
    h('span', { class: 'err', hidden: true }));

  const stepNodes = [
    () => formA.node,
    () => h('div', {},
      wrap(t('auth.orgType'), orgPick.node, 'org_type'),
      wrap(t('auth.activity'), actPick.node, 'activity'),
      h('div', { dataset: { name: 'nic_code' } }, nicBox, h('span', { class: 'err', hidden: true })),
      wrap(t('auth.state'), statePick.node, 'state_code')),
    () => h('div', {}, formC.node, h('div', { dataset: { name: 'lang' } }, langPick.node)),
  ];

  const body = h('div', { class: 'stack' });

  function validate(n) {
    const errs = {};
    if (n === 1) {
      const v = formA.get();
      if ((v.business_name ?? '').trim().length < 2) errs.business_name = t('auth.businessName');
      if ((v.owner_name ?? '').trim().length < 2) errs.owner_name = t('auth.ownerName');
      const p = String(v.phone ?? '').replace(/\D/g, '');
      if (!/^(?:91)?[6-9]\d{9}$/.test(p)) errs.phone = t('auth.phoneHelp');
      if (!/^UDYAM-?[A-Z]{2}-?\d{2}-?\d{7}$/.test(String(v.udyam_id ?? '').trim().toUpperCase().replace(/\s+/g,''))) errs.udyam_id = t('auth.udyamHelp');
    }
    if (n === 2) {
      if (!orgPick.get()) errs.org_type = t('auth.orgType');
      if (!actPick.get()) errs.activity = t('auth.activity');
      if (!nicState.code) errs.nic_code = t('auth.nicHelp');
      if (!statePick.get()) errs.state_code = t('auth.state');
    }
    if (n === 3) {
      const v = formC.get();
      const pw = v.password ?? '';
      if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) errs.password = t('auth.passwordHelp');
      else if (pw !== v.password2) errs.password2 = t('auth.passwordMismatch');
      for (const k of ['investment', 'turnover']) {
        if (String(v[k] ?? '').trim() && parseNum(v[k]) == null) errs[k] = t('common.amount');
      }
    }
    return errs;
  }

  function markStepErrors(n, errs) {
    if (n === 1) formA.showErrors(errs);
    if (n === 3) formC.showErrors(errs);
    if (n !== 2) return;
    for (const [name, msg] of Object.entries(errs)) {
      const holder = body.querySelector(`[data-name="${name}"]`);
      const note = holder?.querySelector('.err');
      if (note) { note.textContent = msg ?? ''; note.hidden = !msg; }
    }
  }

  function showStep(n) {
    step = n;
    sessionStorage.setItem('udisa.regstep', String(n));
    fill(body, 
      h('h1', { style: 'font-size:23px;font-weight:800' }, t('auth.registerTitle')),
      h('div', { class: 'bar' }, [1, 2, 3].map((i) => h('span', { style: `flex:1;background:${i <= n ? 'var(--orange)' : '#e2e6ee'}` }))),
      h('p', { class: 'muted' }, t('auth.step', { n })),
      stepNodes[n - 1](),
      h('div', { class: 'sheet-actions' },
        n > 1 ? h('button', { class: 'btn btn-ghost', onclick: () => { collect(); showStep(n - 1); } }, '← ', t('common.back')) : null,
        n < REG_STEPS
          ? h('button', { class: 'btn btn-primary', onclick: () => {
            const errs = validate(n);
            if (Object.keys(errs).length) { markStepErrors(n, errs); toast(t, t('common.errName'), 'bad'); return; }
            collect();
            showStep(n + 1);
          } }, t('auth.next'), ' →')
          : h('button', { class: 'btn btn-primary', onclick: () => submit() }, '✓ ', t('auth.register'))
      )
    );
  }

  formA.node.addEventListener('input',()=>writeReg(formA.get()));
  formC.node.addEventListener('input',()=>{const {investment,turnover,district}=formC.get();writeReg({investment,turnover,district});});
  function collect() {
    const {investment,turnover,district} = formC.get();
    writeReg({ ...formA.get(), investment,turnover,district,nic_code:nicState.code });
  }

  async function submit() {
    for (const n of [1, 2, 3]) {
      const errs = validate(n);
      if (Object.keys(errs).length) {
        showStep(n);
        markStepErrors(n, errs);
        toast(t, t('common.errName'), 'bad');
        return;
      }
    }
    collect();
    const v = readReg();
    const payload = {
      business_name: v.business_name, owner_name: v.owner_name, phone: v.phone, udyam_id: v.udyam_id,
      password: formC.get().password, investment: v.investment || '', turnover: v.turnover || '', district: v.district || '',
      org_type: v.org_type, activity: v.activity, nic_code: v.nic_code, state_code: v.state_code, lang: v.lang || state.lang,
    };
    const btn = [...body.querySelectorAll('button')].pop();
    if (btn) btn.disabled = true;
    try {
      const out = await api('POST', '/register', payload, { quiet: true });
      net.setToken(out.token);
      state.user = out.user;
      net.setOwner(out.user.id);
      state.queued = net.queueSize();
      await net.flushQueue();
      localStorage.removeItem(REG_KEY);
      sessionStorage.removeItem('udisa.regstep');
      clearDrafts('reg-');
      history.replaceState(null,'','#/home');
      await refresh();
      recovery(true);
      toast(t, out.warnings?.length ? t('auth.udyamWarn') : t('common.saved'), out.warnings?.length ? 'bad' : 'good');
    } catch (err) {
      if (btn) btn.disabled = false;
      const fields = err.fields ?? {};
      const keys = Object.keys(fields);
      if (keys.length) {
        const onStepA = keys.some((k) => ['business_name', 'owner_name', 'phone', 'udyam_id'].includes(k));
        showStep(onStepA ? 1 : keys.some((k) => ['org_type', 'activity', 'nic_code', 'state_code'].includes(k)) ? 2 : 3);
        markStepErrors(step, fields);
        toast(t, err.message || t('common.errName'), 'bad');
      } else {
        toast(t, err.code === 'too-many' ? t('err.too-many') : (err.message || t('common.retryLater')), 'bad');
      }
    }
  }

  showStep(step);
  return h('div', { class: 'stack' }, body,
    h('button', { class: 'btn btn-ghost', onclick: () => go('choose') }, '← ', t('common.back')),
    null);
}

// ----------------------------------------------------------------------- home

function home() {
  const d = state.data;
  if (!d) return h('div', { class: 'stack' }, h('div', { class: 'spinner' }));
  const u = state.user;
  const m = thisMonth();
  const inMonth = dir => (dir==='in' ? d.cash?.received : d.cash?.paid) ?? 0;
  const netMonth = inMonth('in') - inMonth('out');

  return h('div', { class: 'stack dashboard' },
    h('div', { class: 'card dashboard-totals' },
      h('div', { class: 'row between' },
        h('div', null,
          h('h1', { style: 'font-size:22px;font-weight:800' }, t('dash.hello', { name: u.owner_name.split(' ')[0] })),
          h('p', { class: 'muted' }, u.business_name+' · '+monthName(m,state.lang))),
        badge(u.size_class ? t(`me.sizes.${u.size_class}`) : t('dash.sizeUnknown'), u.size_class ? 'ok' : 'warn')
      ),
      h('div', { class: 'money-grid', style: 'margin-top:12px' },
        cell(say('Money received','मिली रकम'), money(inMonth('in'), { compact: true }), 'pos'),
        cell(say('Money paid','दी गई रकम'), money(inMonth('out'), { compact: true }), 'neg'),
        cell(say('Net cash flow','शुद्ध नकदी प्रवाह'), money(netMonth, { compact: true }), netMonth >= 0 ? 'pos' : 'neg'),
        cell(t('dash.stockWorth'), money(d.stock.totals.blocked, { compact: true }), 'neutral')
      )
    ),

    h('div', { class: 'card' },
      h('h2', null, t('dash.quick')),
      h('button',{class:'btn btn-primary btn-block sale-action',onclick:saleSheet},say('Record a sale','बिक्री दर्ज करें')),
      h('div', { class: 'quick' },
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => entrySheet('in') }, h('span', { class: 'ico' }, '➕'), t('dash.qIn')),
        h('button', { class: 'btn btn-navy btn-lg', onclick: () => entrySheet('out') }, h('span', { class: 'ico' }, '➖'), t('dash.qOut')),
        h('button', { class: 'btn btn-lg', onclick: () => movementSheet('in') }, h('span', { class: 'ico' }, '📥'), t('dash.qStockIn')),
        h('button', { class: 'btn btn-lg', onclick: () => movementSheet('out') }, h('span', { class: 'ico' }, '📤'), t('dash.qStockOut'))
      )
    ),

    d.signals.length ? h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, t('dash.alerts')), speakButton(d.signals.map((s) => t(`sig.${s.id}`, s.amount_paise != null ? { ...s, amount: groupIndian(rupees(s.amount_paise)) } : s)).join('. '))),
      h('div', { class: 'stack' }, d.signals.map((s) => {
        const tone = { bad: 'bad', warn: 'warn', good: 'good' }[s.tone] ?? '';
        const icon = { bad: '⛔', warn: '⚠️', good: '✅' }[s.tone] ?? 'ℹ️';
        const params = s.amount_paise != null ? { ...s, amount: groupIndian(rupees(s.amount_paise)) } : s;
        return h('div', { class: `sig ${tone}` },
          h('span', { class: 'ico' }, icon),
          h('div', null, t(`sig.${s.id}`, params)));
      }))
    ) : null,

    h('div', { class: 'card' },
      h('h2', null, t('dash.recent')),
      d.ledger.length ? h('ul', { class: 'list' }, d.ledger.slice(0, 6).map(ledgerRow)) : emptyBox('🧾', t('dash.noRecent'))
    ),

    d.months.length ? h('div', { class: 'card' }, h('h2', null, t('dash.months')), barChart(d.months)) : null
  );
}

function cell(label, value, cls) {
  return h('div', { class: 'money-cell' }, h('div', { class: 'lbl' }, label), h('div', { class: `val ${cls}` }, value));
}

/** Many owners read slowly but follow spoken numbers well; this uses the phone's own voice. */
function speakButton(text) {
  if (!('speechSynthesis' in window)) return null;
  return h('button', {
    class: 'btn btn-ghost',
    style: 'min-height:40px;padding:0 12px',
    title: text,
    onclick: (e) => {
      const playing = e.currentTarget.dataset.on === '1';
      if (playing) {
        window.speechSynthesis.cancel();
        e.currentTarget.dataset.on = '0';
        e.currentTarget.textContent = '🔊';
        return;
      }
      e.currentTarget.dataset.on = '1';
      e.currentTarget.textContent = '⏹';
      speak(text, state.lang);
      setTimeout(() => { if (e.currentTarget) e.currentTarget.textContent = '🔊'; }, Math.min(20000, 900 + text.length * 70));
    },
  }, '🔊');
}

function barChart(months) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.income_paise, m.expense_paise)));
  return h('div', {}, months.map((mo) => h('div', { class: 'row', style: 'gap:8px;margin:6px 0' },
    h('span', { class: 'tiny', style: 'width:56px;flex:none' }, monthName(mo.month, state.lang)),
    h('div', { style: 'flex:1;display:grid;gap:3px' },
      h('div', { style: `height:11px;border-radius:6px;background:#0a7d43;width:${Math.max(2, (mo.income_paise / max) * 100)}%` }),
      h('div', { style: `height:11px;border-radius:6px;background:#c62b00;width:${Math.max(2, (mo.expense_paise / max) * 100)}%` })),
    h('span', { class: 'tiny', style: 'width:74px;text-align:right;flex:none' }, money(mo.net_paise)))
  ));
}

// ---------------------------------------------------------------------- money

function moneyScreen() {
  const d = state.data;
  if (!d) return h('div', { class: 'spinner' });
  const m = thisMonth();
  const rows = d.ledger.filter((r) => monthOf(r.occurred_on) === m);
  const inSum = rows.filter((r) => r.direction === 'in' && !isSettle(r.category)).reduce((s, r) => s + Math.round(r.amount * 100), 0);
  const outSum = rows.filter((r) => r.direction === 'out' && !isSettle(r.category)).reduce((s, r) => s + Math.round(r.amount * 100), 0);
  const byCat = {};
  for (const r of rows) {
    if (r.direction !== 'out' || isSettle(r.category)) continue;
    byCat[r.category] = (byCat[r.category] ?? 0) + r.amount;
  }
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCat = Math.max(1, ...top.map(([, v]) => v));

  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('h2', null, t('money.title')),
      h('div', { class: 'quick' },
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => entrySheet('in') }, '➕ ', t('money.addIn')),
        h('button', { class: 'btn btn-navy btn-lg', onclick: () => entrySheet('out') }, '➖ ', t('money.addOut'))),
      h('div', { class: 'row between', style: 'margin-top:12px' },
        h('span', { class: 'pos' }, t('money.inThisMonth', { amount: groupIndian(rupees(inSum)) })),
        h('span', { class: 'neg' }, t('money.outThisMonth', { amount: groupIndian(rupees(outSum)) })))
    ),

    top.length ? h('div', { class: 'card' },
      h('h2', null, t('money.byCategory')),
      top.map(([c, amt]) => h('div', { style: 'margin:8px 0' },
        h('div', { class: 'row between' }, h('span', { class: 'tiny' }, L('expenseCategories', c)), h('span', { class: 'tiny' }, money(Math.round(amt * 100)))),
        h('div', { class: 'meter' }, h('i', { style: `width:${Math.max(3, (amt / maxCat) * 100)}%;background:var(--orange-deep)` }))))
    ) : null,

    h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', { style: 'margin:0' }, t('money.udhaar')),
        h('button', { class: 'btn btn-ghost', style: 'min-height:40px;padding:0 12px', onclick: () => partySheet() }, '➕ ', t('money.addParty'))),
      h('p', { class: 'help' }, t('money.udhaarHelp')),
      d.parties_balance.length ? h('ul', { class: 'list' }, d.parties_balance
        .filter((p) => p.owed_to_you_paise > 0 || p.you_owe_paise > 0)
        .sort((a, b) => b.owed_to_you_paise - a.owed_to_you_paise || b.you_owe_paise - a.you_owe_paise)
        .map(partyRow)) : emptyBox('🤝', t('money.udhaarHelp'))
    ),

    h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', { style: 'margin:0' }, plural(d.ledger.length, 'money.entries.one', 'money.entries.many')),
        h('a', { class: 'btn btn-ghost', style: 'min-height:40px;padding:0 12px', href: '/api/export.csv', download: '' }, '⬇ ', t('money.export'))),
      d.ledger.length ? h('ul', { class: 'list' }, d.ledger.map(ledgerRow)) : emptyBox('🧾', t('dash.noRecent'))
    )
  );
}

const isSettle = (c) => c === 'credit-received' || c === 'credit-paid';

function ledgerRow(r) {
  const t2 = state.t;
  return h('li', { style: 'cursor:pointer', onclick: () => entrySheet(r.direction, r) },
    h('span', { class: 'ico', style: 'font-size:22px' }, findInList('incomeCategories', r.category)?.icon ?? findInList('expenseCategories', r.category)?.icon ?? '🧾'),
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, L(r.direction === 'in' ? 'incomeCategories' : 'expenseCategories', r.category)),
      h('div', { class: 'sub' }, `${dayLabel(r.occurred_on, state.lang)} · ${L('paymentModes', r.mode)}${r.party_name ? ` · ${r.party_name}` : ''}${r.note ? ` · ${r.note}` : ''}`)),
    h('span', { class: `amt ${r.direction === 'in' ? 'pos' : 'neg'}` }, `${r.direction === 'in' ? '+' : '-'}${money(Math.round(r.amount * 100))}`)
  );
}

function findInList(name, id) {
  return cat(name).find((x) => x.id === id);
}

function partyRow(p) {
  return h('li', {},
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, p.name),
      h('div', { class: 'sub' }, `${p.kind === 'customer' ? t('money.kind.customer') : p.kind === 'supplier' ? t('money.kind.supplier') : t('money.kind.both')}${p.phone ? ` · ${p.phone}` : ''}`),
      h('div', { class: 'row', style: 'gap:14px;margin-top:4px' },
        p.owed_to_you_paise > 0 ? h('span', { class: 'badge b-warn' }, `${t('money.owesYou')} ${money(p.owed_to_you_paise)}`) : null,
        p.you_owe_paise > 0 ? h('span', { class: 'badge b-info' }, `${t('money.youOwe')} ${money(p.you_owe_paise)}`) : null)),
    h('div', { style: 'display:grid;gap:6px' },
      p.owed_to_you_paise > 0 ? h('button', { class: 'btn btn-primary', style: 'min-height:44px;padding:0 12px', onclick: () => settleSheet(p, 'in') }, t('money.receive')) : null,
      p.you_owe_paise > 0 ? h('button', { class: 'btn', style: 'min-height:44px;padding:0 12px', onclick: () => settleSheet(p, 'out') }, t('money.pay')) : null)
  );
}

function entrySheet(direction, existing) {
  if (existing?.sale_link) return linkedSale(existing);
  const d = state.data;
  const listName = direction === 'in' ? 'incomeCategories' : 'expenseCategories';
  const cats = cat(listName);
  const form = makeForm([
    { name: 'amount', label: t('common.amount'), required: true, inputmode: 'decimal', value: existing?.amount ?? '' },
    { name: 'category', label: t('money.category'), kind: 'picker', required: true, options: () => cats, value: existing?.category ?? cats[0]?.id, labelOf: short, columns: true },
    { name: 'mode', label: t('money.mode'), kind: 'picker', required: true, options: () => cat('paymentModes'), value: existing?.mode ?? 'cash', labelOf: short },
    { name: 'party_id', label: t('money.party'), kind: 'picker', options: () => [{ id: '', en: t('money.noparty'), icon: '➖' }, ...d.parties.map((p) => ({ id: p.id, en: p.name }))], value: existing?.party_id ?? '', labelOf: (o) => o.en },
    { name:'new_party',label:direction === 'in' ? say('New customer name (optional)','नए ग्राहक का नाम (वैकल्पिक)') : say('New supplier name (optional)','नए सप्लायर का नाम (वैकल्पिक)') },
    { name: 'occurred_on', label: t('common.date'), inputType:'date', value: existing?.occurred_on ?? today(), inputmode: 'numeric', help: 'YYYY-MM-DD' },
    { name: 'note', label: `${t('common.note')} (${t('common.optional')})`, kind: 'textarea', value: existing?.note ?? '' },
  ]);
  const id = existing?.id ?? uid();
  const newPartyId=uid();
  const s = sheet(
    existing ? t('common.edit') : direction === 'in' ? t('money.addIn') : t('money.addOut'),
    form.node,
    [
      h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, t('common.cancel')),
      existing ? h('button', { class: 'btn btn-danger', onclick: async () => { if (await confirmSheet(t('common.deleteQ'), t('common.deleteWarn'), t('common.delete'))) { await api('DELETE', `/ledger/${id}`); s.close(); await refresh(); } } }, t('common.delete')) : null,
      h('button', { class: 'btn btn-primary', onclick: async (e) => {
        const v = form.get();
        const amt = parseNum(v.amount);
        const errs = {};
        if (v.mode === 'credit' && !v.party_id && v.new_party.trim().length<2) errs.party_id = say('Choose a customer or supplier for udhaar.','उधार के लिए ग्राहक या सप्लायर चुनें।');
        if (amt == null || amt <= 0) errs.amount = t('common.amount');
        if (v.occurred_on && !/^\d{4}-\d{2}-\d{2}$/.test(v.occurred_on)) errs.occurred_on = t('common.date');
        if (Object.keys(errs).length) { form.showErrors(errs); return; }
        e.target.disabled = true;
        const payload = { id, direction, amount: amt.toFixed(2), category: v.category, mode: v.mode, party_id: v.party_id || '', note: v.note, occurred_on: v.occurred_on };
        try {
          if (!payload.party_id && v.new_party.trim()) {
            await api('POST','/parties',{id:newPartyId,name:v.new_party.trim(),kind:direction==='in'?'customer':'supplier'});
            payload.party_id=newPartyId;
          }
          if (payload.category==='cash-sale' && payload.mode==='credit') payload.category='credit-sale';
          await api(existing ? 'PUT' : 'POST', existing ? `/ledger/${id}` : '/ledger', payload);
          s.close();
          clearDrafts('entry-');
          await refresh();
          toast(t,net.queueSize()?say('Saved on this device · waiting to sync','डिवाइस पर सहेजा · सिंक बाकी है'):t('common.saved'), 'good');
        } catch (err) {
          form.showErrors(err.fields ?? {});
          e.target.disabled = false;
        }
      } }, existing ? t('common.save') : t('common.add'))
    ].filter(Boolean)
  );
}

function settleSheet(party, direction) {
  const form = makeForm([
    { name: 'amount', label: t('common.amount'), required: true, inputmode: 'decimal' },
    { name: 'mode', label: t('money.mode'), kind: 'picker', options: () => cat('paymentModes').filter((m) => m.id !== 'credit'), value: 'cash', labelOf: short },
    { name: 'occurred_on', label: t('common.date'), inputType:'date', value: today() },
  ]);
  const id = uid();
  const s = sheet(`${party.name} · ${direction === 'in' ? t('money.receive') : t('money.pay')}`, form.node, [
    h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, t('common.cancel')),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      const v = form.get();
      const amt = parseNum(v.amount);
      if (amt == null || amt <= 0) { form.showErrors({ amount: t('common.amount') }); return; }
      await api('POST', '/ledger', {
        id, direction, amount: amt.toFixed(2),
        category: direction === 'in' ? 'credit-received' : 'credit-paid',
        mode: v.mode, party_id: party.id, occurred_on: v.occurred_on, note: '',
      });
      s.close();
      await refresh();
      toast(t,net.queueSize()?say('Saved on this device · waiting to sync','डिवाइस पर सहेजा · सिंक बाकी है'):t('common.saved'), 'good');
    } }, t('common.save')),
  ]);
}

function partySheet() {
  const form = makeForm([
    { name: 'name', label: t('money.partyName'), required: true, draftKey: 'party-name' },
    { name: 'kind', label: t('money.partyKind'), kind: 'picker', value: 'customer', labelOf: short, options: () => [
      { id: 'customer', en: t('money.kind.customer'), hi: 'ग्राहक', icon: '🧑' },
      { id: 'supplier', en: t('money.kind.supplier'), hi: 'सप्लायर', icon: '🚚' },
      { id: 'both', en: t('money.kind.both'), hi: 'दोनों', icon: '🔄' },
    ] },
    { name: 'phone', label: t('auth.phone'), inputmode: 'numeric' },
    { name: 'gstin', label: 'GSTIN' },
  ]);
  const id = uid();
  const s = sheet(t('money.addParty'), form.node, [
    h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, t('common.cancel')),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      const v = form.get();
      if ((v.name ?? '').trim().length < 2) { form.showErrors({ name: t('money.partyName') }); return; }
      await api('POST', '/parties', { id, ...v });
      s.close();
      clearDrafts('party-');
      await refresh();
      toast(t,net.queueSize()?say('Saved on this device · waiting to sync','डिवाइस पर सहेजा · सिंक बाकी है'):t('common.saved'), 'good');
    } }, t('common.add')),
  ]);
}

// ---------------------------------------------------------------------- stock

function stockScreen() {
  const d = state.data;
  if (!d) return h('div', { class: 'spinner' });
  const st = d.stock;
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('h2', null, t('stock.title')),
      h('div', { class: 'money-grid' },
        cell(t('stock.blocked'), money(st.totals.blocked, { compact: true }), 'neutral'),
        cell(t('stock.worth'), money(st.totals.sale_value, { compact: true }), 'pos'),
        cell(t('stock.margin'), money(st.totals.margin_paise, { compact: true }), st.totals.margin_paise >= 0 ? 'pos' : 'neg'),
        cell(plural(st.totals.count, 'stock.count.one', 'stock.count.many'), '', 'neutral')
      ),
      h('div', { class: 'quick', style: 'margin-top:12px' },
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => movementSheet('in') }, '📥 ', t('stock.in')),
        h('button', { class: 'btn btn-navy btn-lg', onclick: () => movementSheet('out') }, '📤 ', t('stock.out')),
        h('button', { class: 'btn btn-lg', onclick: () => itemSheet() }, '➕ ', t('stock.add')),
        h('button', { class: 'btn btn-lg', onclick: () => movementSheet('adjust') }, '✏️ ', t('stock.adjust'))
      )
    ),

    stockAlertsCard(),

    h('div', { class: 'card' },
      h('h2', null, t('stock.item')),
      st.items.length ? h('ul', { class: 'list' }, st.items.map(stockRow)) : emptyBox('📦', t('stock.empty'),
        h('button', { class: 'btn btn-primary', onclick: () => itemSheet() }, t('stock.add')))
    ),

    h('div', { class: 'card' },
      h('h2', null, t('stock.history')),
      d.movements.length ? h('ul', { class: 'list' }, d.movements.slice(0, 25).map(movementRow)) : emptyBox('🗒️', t('common.none'))
    )
  );
}

function stockAlertText(i) {
  const p = {
    name: i.name,
    qty: groupIndian(i.qty, { decimals: !Number.isInteger(i.qty) }),
    unit: L('units', i.unit),
    reorder: i.reorder_qty,
    // "not selling" counts idle days, "too much" counts days of cover - they are
    // different questions and reading the wrong one prints "0 days"
    days: i.state === 'excess' ? Math.round(i.cover_days ?? 0) : (i.idle_days ?? 0),
    amount: groupIndian(rupees(i.blocked_paise)),
  };
  const key = { out: 'stock.alertFinished', low: 'stock.alertLow', dead: 'stock.alertDead', excess: 'stock.alertExcess' }[i.state];
  return key ? t(key, p) : '';
}

function stockAlertsCard() {
  const items = (state.data?.stock.items ?? []).filter((i) => i.state !== 'ok').slice(0, 8);
  if (!items.length) return null;
  return h('div', { class: 'card' },
    h('h2', null, t('dash.alerts')),
    items.map((i) => {
      const icon = i.state === 'out' ? '⛔' : i.state === 'excess' ? '💰' : '⚠️';
      const buy = i.suggest_buy_qty > 0
        ? h('button', {
          class: 'btn btn-primary',
          style: 'min-height:42px;margin-top:6px;padding:0 12px',
          onclick: () => movementSheet('in', i),
        }, t('stock.buyQty', {
          qty: groupIndian(i.suggest_buy_qty, { decimals: !Number.isInteger(i.suggest_buy_qty) }),
          unit: L('units', i.unit),
        }))
        : null;
      return h('div', { class: `sig ${i.state === 'out' ? 'bad' : 'warn'}` },
        h('span', { class: 'ico' }, icon),
        h('div', null, stockAlertText(i), buy));
    })
  );
}

function stockRow(i) {
  const pct = i.reorder_qty > 0 ? Math.min(100, (i.qty / (i.reorder_qty * 3)) * 100) : 60;
  return h('li', { style: 'cursor:pointer;display:block', onclick: () => itemSheet(i) },
    h('div', { class: 'row between' },
      h('div', { class: 'name' }, i.name),
      badge(t(`stock.states.${i.state}`), i.state === 'ok' ? 'ok' : i.state === 'excess' || i.state === 'dead' ? 'info' : 'bad')),
    h('div', { class: 'row between', style: 'margin-top:2px' },
      h('span', { class: 'sub' }, `${qtyText(i.qty, L('units', i.unit))} · ${money(i.blocked_paise)}`),
      h('span', { class: 'sub' }, i.cover_days != null ? t('stock.daysLeft', { n: Math.round(i.cover_days) }) : t('stock.noDays'))),
    h('div', { class: `meter ${i.state === 'low' || i.state === 'out' ? 'low' : i.state === 'dead' ? 'dead' : ''}` },
      h('i', { style: `width:${Math.max(3, pct)}%` }))
  );
}

function movementRow(r) {
  return h('li', { style: 'cursor:pointer', onclick: () => movementSheet(null, null, r) },
    h('span', { class: 'ico', style: 'font-size:22px' }, r.qty > 0 ? '📥' : '📤'),
    h('div', { class: 'grow' },
      h('div', { class: 'name' }, r.item_name || t('stock.item')),
      h('div', { class: 'sub' }, [dayLabel(r.occurred_on, state.lang), r.note, r.party_name].filter(Boolean).join(' · '))),
    h('span', { class: `amt ${r.qty > 0 ? '' : 'neg'}` }, `${r.qty > 0 ? '+' : ''}${groupIndian(r.qty, { decimals: !Number.isInteger(r.qty) })}`)
  );
}

function itemSheet(existing) {
  const d = state.data;
  // stock rows carry the *current* quantity; the opening balance is on the item
  // itself, and editing must not quietly rewrite it and double-count movements
  const item = existing ? (d.items.find((i) => i.id === existing.id) ?? existing) : null;
  const form = makeForm([
    { name: 'name', label: t('stock.name'), required: true, value: item?.name ?? '', draftKey: 'item-name' },
    { name: 'unit', label: t('stock.unit'), kind: 'picker', required: true, options: () => cat('units'), value: item?.unit ?? 'pcs', labelOf: short },
    { name: 'purchase', label: t('stock.buyPrice'), inputmode: 'decimal', value: item?.purchase ?? '' },
    { name: 'sale', label: t('stock.sellPrice'), inputmode: 'decimal', value: item?.sale ?? '' },
    { name: 'opening_qty', label: t('stock.opening'), inputmode: 'decimal', value: item?.opening_qty ?? '', help: existing ? t('stock.adjust') : '' },
    { name: 'reorder_qty', label: t('stock.reorder'), inputmode: 'decimal', value: item?.reorder_qty ?? '' },
    { name: 'lead_days', label: t('stock.lead'), inputmode: 'numeric', value: item?.lead_days ?? '' },
  ]);
  const id = item?.id ?? uid();
  const s = sheet(existing ? t('common.edit') : t('stock.add'), form.node, [
    existing ? h('button', { class: 'btn btn-danger', onclick: async () => {
      if (await confirmSheet(t('common.deleteQ'), t('common.deleteWarn'), t('common.delete'))) {
        await api('DELETE', `/items/${id}`);
        s.close();
        await refresh();
      }
    } }, t('common.delete')) : h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, t('common.cancel')),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      const v = form.get();
      const errs = {};
      if ((v.name ?? '').trim().length < 2) errs.name = t('stock.name');
      for (const k of ['purchase', 'sale', 'opening_qty', 'reorder_qty']) if (v[k] && parseNum(v[k]) == null) errs[k] = t('common.amount');
      if (Object.keys(errs).length) { form.showErrors(errs); return; }
      // opening_qty is the starting balance itself; adding a movement on top of it
      // would count the same stock twice
      const payload = { id, ...v };
      await api(existing ? 'PUT' : 'POST', existing ? `/items/${id}` : '/items', payload);
      s.close();
      clearDrafts('item-');
      await refresh();
      toast(t,net.queueSize()?say('Saved on this device · waiting to sync','डिवाइस पर सहेजा · सिंक बाकी है'):t('common.saved'), 'good');
    } }, t('common.save')),
  ]);
}

function movementSheet(kind, presetItem, existing) {
  if (existing?.sale_link) return linkedSale(existing);
  const d = state.data;
  const stock = d.stock.items;
  if (!stock.length) {
    const s = sheet(t('stock.empty'), emptyBox('📦', t('stock.empty')), [h('button', { class: 'btn btn-primary', onclick: () => { s.close(); itemSheet(); } }, t('stock.add'))]);
    return;
  }
  const dir = existing ? (existing.qty > 0 ? 'in' : 'out') : kind;
  const form = makeForm([
    { name: 'item_id', label: t('stock.item'), kind: 'picker', required: true, columns: true, value: existing?.item_id ?? presetItem?.id ?? stock[0].id, options: () => stock.map((i) => ({ id: i.id, en: `${i.name} · ${qtyText(i.qty, L('units', i.unit))}`, icon: i.state === 'out' ? '⛔' : i.state === 'low' ? '⚠️' : '📦' })), labelOf: (o) => o.en },
    ...(dir === 'out' || dir === 'adjust' ? [{name:'kind',kind:'select',label:say('Reason','कारण'), value:existing?.kind === 'legacy' ? 'sale' : existing?.kind || (dir === 'out' ? 'sale' : 'correction'),options:(dir === 'out' ? [['sale','Sold','बिक्री'],['damage','Damaged','खराब'],['correction','Count correction','गिनती सुधार']] : [['correction','Count correction','गिनती सुधार']]).map(([id,en,hi])=>({id,en:say(en,hi)}))}] : []),
    { name: 'qty', label: `${t('stock.qty')}${dir === 'adjust' ? ` (${t('stock.adjustHelp')})` : ''}`, required: true, inputmode: 'decimal', value: existing ? Math.abs(existing.qty) : '' },
    { name: 'rate', label: t('stock.rate'), inputmode: 'decimal', value: existing?.rate ?? ((dir === 'out' ? rupees(presetItem?.sale_paise) : rupees(presetItem?.purchase_paise)) || '') },
    { name: 'occurred_on', label: t('common.date'), inputType:'date', value: existing?.occurred_on ?? today() },
    { name: 'note', label: `${t('common.note')} (${t('common.optional')})`, kind: 'textarea', value: existing?.note ?? '' },
  ]);
  const id = existing?.id ?? uid();
  const s = sheet(existing ? t('common.edit') : dir === 'in' ? t('stock.in') : dir === 'out' ? t('stock.out') : t('stock.adjust'), form.node, [
    existing ? h('button', { class: 'btn btn-danger', onclick: async () => {
      if (await confirmSheet(t('common.deleteQ'), t('common.deleteWarn'), t('common.delete'))) { await api('DELETE', `/movements/${id}`); s.close(); await refresh(); }
    } }, t('common.delete')) : h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, t('common.cancel')),
    h('button', { class: 'btn btn-primary', onclick: async () => {
      const v = form.get();
      const q = parseNum(v.qty);
      const errs = {};
      if (q == null || q === 0) errs.qty = t('stock.qty');
      if (v.occurred_on && !/^\d{4}-\d{2}-\d{2}$/.test(v.occurred_on)) errs.occurred_on = t('common.date');
      if (Object.keys(errs).length) { form.showErrors(errs); return; }
      const signed = dir === 'out' ? -Math.abs(q) : dir === 'adjust' ? q : Math.abs(q);
      const payload = {
        id, kind: v.kind || (dir === 'out' ? 'sale' : dir === 'adjust' ? 'correction' : 'purchase'), item_id: v.item_id, qty: signed, rate: parseNum(v.rate) ?? 0,
        occurred_on: v.occurred_on, note: v.note, party_id: '',
      };
      await api(existing ? 'PUT' : 'POST', existing ? `/movements/${id}` : '/movements', payload);
      s.close();
      await refresh();
      toast(t,net.queueSize()?say('Saved on this device · waiting to sync','डिवाइस पर सहेजा · सिंक बाकी है'):t('common.saved'), 'good');
    } }, t('common.save')),
  ]);
}

// ---------------------------------------------------------------- govt/scheme

function saleSheet() {
  const items=state.data?.stock.items || [];
  if (!items.length) { toast(t,say('Add your first stock item.','पहले स्टॉक का सामान जोड़ें।')); return itemSheet(); }
  const id=uid();
  const form=makeForm([
    {name:'item_id',kind:'select',label:t('stock.item'),options:items.map(i=>({id:i.id,en:i.name})),value:items[0].id},
    {name:'qty',label:t('stock.qty'),inputmode:'decimal',value:'1'},
    {name:'rate',label:say('Selling price per unit (₹)','प्रति इकाई बिक्री मूल्य (₹)'),inputmode:'decimal',value:rupees(items[0].sale_paise)},
    {name:'mode',kind:'select',label:t('money.mode'),options:cat('paymentModes'),labelOf:short,value:'cash'},
    {name:'party_id',kind:'select',label:say('Customer','ग्राहक'),options:[{id:'',en:say('Walk-in or new customer','सामान्य या नया ग्राहक')},...state.data.parties.filter(p=>p.kind!=='supplier').map(p=>({id:p.id,en:p.name}))]},
    {name:'customer',label:say('New customer name (for udhaar)','नए ग्राहक का नाम (उधार के लिए)')},
    {name:'occurred_on',label:t('common.date'),inputType:'date',value:today()}
  ]);
  form.fields.get('item_id').anchor.onchange=()=>form.set('rate',rupees(items.find(i=>i.id===form.get().item_id)?.sale_paise));
  const total=h('strong',{class:'sale-total','aria-live':'polite'});
  function updateTotal(){const v=form.get();total.textContent=say('Sale total · ','बिक्री कुल · ')+money(Math.round((parseNum(v.qty)||0)*(parseNum(v.rate)||0)*100));}
  form.node.addEventListener('input',updateTotal);form.node.addEventListener('change',updateTotal);updateTotal();
  const error=h('p',{role:'alert',class:'err'});
  const dialog=sheet(say('Record a sale','बिक्री दर्ज करें'),h('div',{},form.node,total,error),[
    h('button',{class:'btn',onclick:()=>dialog.close()},t('common.cancel')),
    h('button',{class:'btn btn-primary',onclick:async e=>{
      const btn=e.currentTarget;btn.disabled=true;
      const v=form.get();
      try {
        if (!(parseNum(v.qty)>0 && parseNum(v.rate)>0)) throw Error(say('Enter quantity and selling price.','मात्रा और बिक्री मूल्य दर्ज करें।'));
        if (v.mode==='credit'&&!v.party_id&&v.customer.trim().length<2) throw Error(say('Enter the customer name for udhaar.','उधार के लिए ग्राहक का नाम दर्ज करें।'));
        const result=await api('POST','/sales',{...v,id});
        dialog.close();await refresh();
        toast(t,result.queued?say('Saved on this device · waiting to sync','डिवाइस पर सहेजा · सिंक बाकी है'):say('Sale recorded','बिक्री दर्ज हुई'),'good');
      } catch(err){error.textContent=err.message;btn.disabled=false;}
    }},t('common.save'))]);
}
function linkedSale(row) {
  const dialog=sheet(say('Recorded sale','दर्ज बिक्री'),h('p',null,say('Cancelling reverses the accounts entry and stock movement together.','रद्द करने पर खाता और स्टॉक दोनों वापस होंगे।')),[
    h('button',{class:'btn',onclick:()=>dialog.close()},t('common.back')),
    h('button',{class:'btn btn-danger',onclick:async()=>{await api('DELETE','/sales/'+row.sale_link);dialog.close();await refresh();}},say('Cancel this sale','यह बिक्री रद्द करें'))]);
}
function recovery(create) {
  const title=create?say('Create a recovery key','रिकवरी कुंजी बनाएँ'):say('Reset your password','पासवर्ड बदलें');
  const form=makeForm([...(create?[]:[{name:'key',label:say('Saved one-time recovery key','सहेजी गई रिकवरी कुंजी')}]),
    {name:'password',inputType:'password',autocomplete:create?'current-password':'new-password',label:create?t('auth.password'):say('New password','नया पासवर्ड')}]);
  const output=h('div',{role:'status',class:'recovery-result'});
  const dialog=sheet(title,h('div',{},form.node,output),[h('button',{class:'btn',onclick:()=>dialog.close()},t('common.back')),
    h('button',{class:'btn btn-primary',onclick:async e=>{
      const button=e.currentTarget;button.disabled=true;
      try {
        const result=await net.call('POST',create?'/recovery-key':'/recover',form.get());
        if (create) fill(output,h('p',null,say('Save this one-time key privately before closing.','बंद करने से पहले यह कुंजी सुरक्षित रखें।')),h('code',null,result.key));
        else {dialog.close();toast(t,say('Password updated. Sign in again.','पासवर्ड बदल गया। फिर लॉग इन करें।'),'good');}
      }catch(err){output.textContent=err.message;button.disabled=false;}
    }},title)]);
}
function pendingPanel() {
  const entries=net.readQueue(),old=net.legacyQueue();
  if (!entries.length && !old.length) return null;
  const download=rows=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(rows,null,2)],{type:'application/json'}));
    const a=h('a',{href:url,download:'udisa-pending-entries.json'});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return h('div',{class:'stack'},h('h3',null,say('Waiting to sync','सिंक बाकी है')),
    entries.map(e=>h('div',{},h('p',null,[e.path,e.body?.occurred_on,e.body?.amount,e.lastError].filter(Boolean).join(' · ')),
      e.lastError?h('button',{class:'btn',onclick:async()=>{if(await confirmSheet(t('common.deleteQ'),t('common.deleteWarn'),t('common.delete'))){net.forget(e.key);state.queued=net.queueSize();render();}}},t('common.delete')):null)),
    entries.length?h('button',{class:'btn',onclick:async()=>{await net.flushQueue();await refresh();}},say('Retry sync','फिर सिंक करें')):null,
    entries.length?h('button',{class:'btn',onclick:()=>download(entries)},say('Download pending entries','बाकी प्रविष्टियाँ डाउनलोड करें')):null,
    old.length?h('p',null,say('An older device queue needs review by the PC owner before it can be imported.','पुरानी प्रविष्टियों को जाँचकर दर्ज करें।')):null,
    null);
}
function govtScreen() {
  const {arg}=current();
  if (arg) return schemeDetail(arg);
  const box=h('div',{class:'scheme-list'});
  const input=h('input',{type:'search',placeholder:t('govt.search'),'aria-label':t('govt.search')});
  const draw=list=>{
    const term=input.value.trim().toLowerCase();
    const matches=list.filter(s=>[s.name,s.shortName,s.kind,s.purpose].some(x=>x?.toLowerCase().includes(term)));
    fill(box,...matches.map(s=>h('button',{class:'card scheme-link',onclick:()=>go('govt',s.id)},
      h('small',null,t(['govt','kinds',s.kind].join('.'))),h('h3',null,s.shortName || s.name),h('p',null,s.purpose),h('strong',null,s.maxAmountText || t('govt.specific')))));
    if (!matches.length) fill(box,emptyBox('⌕',t('govt.none')));
  };
  api('GET','/schemes',null,{quiet:true}).then(out=>{draw(out.list);input.oninput=()=>draw(out.list);}).catch(()=>fill(box,h('p',null,t('net.offline'))));
  return h('div',{class:'stack'},h('div',{class:'card'},h('h1',null,t('govt.title')),
    h('p',{class:'muted'},say('Loan and credit reference · FY 2025–26. Confirm current terms with the lender.','ऋण संदर्भ · 2025–26। वर्तमान शर्तें ऋणदाता से जाँचें।')),
    h('label',{class:'f'},h('span',null,t('govt.search')),input),
    h('a',{href:'https://www.myscheme.gov.in/',target:'_blank',rel:'noopener noreferrer'},say('Browse central and state benefits on myScheme ↗','myScheme पर केंद्र और राज्य की योजनाएँ देखें ↗'))),box);
}

function schemeDetail(id) {
  const box = h('div', { class: 'stack' }, h('div', { class: 'spinner' }));
  api('GET', `/schemes/${id}`, null, { quiet: true }).then((out) => {
    const s = out.scheme;
    const saved = out.saved;
    const checklist = new Set(saved?.checklist ?? []);
    const progress = h('span', null, '');
    const docList = h('div', {}, (s.documents ?? []).map((doc) => {
      const cb = h('input', { type: 'checkbox', checked: checklist.has(doc) });
      const row = h('label', { class: `check ${checklist.has(doc) ? 'done' : ''}` }, cb, h('span', null, doc));
      cb.addEventListener('change', () => {
        cb.checked ? checklist.add(doc) : checklist.delete(doc);
        row.className = `check ${cb.checked ? 'done' : ''}`;
        progress.textContent = t('govt.docsDone', { n: checklist.size, total: (s.documents ?? []).length });
        void api('PUT', `/schemes/${id}/save`, { status: saved?.status ?? 'saved', checklist: [...checklist] }, { quiet: true }).catch(err=>{cb.checked=!cb.checked;if(cb.checked)checklist.add(doc);else checklist.delete(doc);row.classList.toggle('done',cb.checked);progress.textContent=t('govt.docsDone',{n:checklist.size,total:s.documents.length});toast(t,err.message,'bad');});
      });
      return row;
    }));
    fill(box, 
      h('button', { class: 'btn btn-ghost', onclick: () => go('govt') }, '← ', t('common.back')),
      h('div', { class:'card scheme' },
        h('h1', { style: 'font-size:22px;font-weight:800' }, s.name),
        h('span',{class:'pill'},t(['govt','kinds',s.kind].join('.'))),
        h('p', { style: 'margin-top:10px' }, h('b', null, `${t('govt.max')}: `), s.maxAmountText ?? t('govt.specific')),
        h('p', { class: 'muted' }, s.purpose),

      ),
      h('div', { class: 'card' }, h('h2', null, t('govt.docs')), progress, docList),
      h('div', { class: 'card' }, h('h2', null, t('govt.steps')), h('ol', { style: 'margin:0;padding-left:22px' }, (s.process ?? []).map((p) => h('li', { style: 'margin:6px 0' }, p)))),
      s.caution ? h('p', { class: 'sig warn' }, h('span', { class: 'ico' }, '⚠️'), h('div', null, s.caution)) : null,
      s.statusNote ? h('p', { class: 'sig' }, h('span', { class: 'ico' }, 'ℹ️'), h('div', null, s.statusNote)) : null,
      s.portal ? h('a', { class: 'btn btn-navy btn-block btn-lg', href: s.portal, target: '_blank', rel: 'noopener noreferrer' }, '🔗 ', t('govt.openPortal')) : (s.portalNote ? h('p', { class: 'muted' }, s.portalNote) : null),
      h('div', { class: 'card' },
        h('h2', null, t('govt.progress')),
        h('div', { class: 'chips' }, [['saved', '★'], ['applied', '📨'], ['sanctioned', '✅'], ['declined', '❌'], ['not-applicable', '➖']].map(([st, icon]) => h('button', {
          class: `btn ${saved?.status === st ? 'btn-navy' : ''}`, style: 'min-height:46px',
          onclick: async () => {
            if (st === 'saved' && saved?.status === 'saved') { await api('DELETE', `/schemes/${id}/save`); }
            else await api('PUT', `/schemes/${id}/save`, { status: st, checklist: [...checklist] });
            await refresh();
            toast(t,net.queueSize()?say('Saved on this device · waiting to sync','डिवाइस पर सहेजा · सिंक बाकी है'):t('common.saved'), 'good');
            go('govt', id);
          },
        }, icon, ' ', t({ saved: 'govt.save', applied: 'govt.markApplied', sanctioned: 'govt.markSanctioned', declined: 'govt.markDeclined', 'not-applicable': 'govt.markNa' }[st])))))
    );
  }).catch(() => fill(box, emptyBox('⚠️', t('err.server'))));
  return h('div', { class: 'stack' }, box);
}

// ------------------------------------------------------------------- profile

function meScreen() {
  const u = state.user;
  const d = state.data;
  return h('div', { class: 'stack' },
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'gap:12px' }, logoMark(56, state.brand.name),
        h('div', null, h('h1', { style: 'font-size:20px;font-weight:800' }, u.business_name), h('p', { class: 'muted' }, u.owner_name))),
      h('dl', { style: 'margin:12px 0 0;display:grid;gap:6px' },
        line(t('me.udyam'), u.udyam_id),
        line(t('me.business'), `${L('organisationTypes', u.org_type)} · ${L('activities', u.activity)}`),
        line(t('auth.nic'), `${u.nic_code} · ${state.lang === 'hi' ? u.nic_title_hi : u.nic_title}`),
        line(t('auth.state'), `${u.state_name}${u.district ? ` · ${u.district}` : ''}`),
        line(t('common.amount'), `${t('auth.investment')}: ${money(Math.round(u.investment * 100))} · ${t('auth.turnover')}: ${money(Math.round(u.turnover * 100))}`)
      )
    ),

    h('div', { class: 'card' },
      h('h2', null, t('me.size')),
      u.size_class
        ? h('p', { class: 'sig good' }, h('span', { class: 'ico' }, '🏷️'), h('div', null, t('me.sizeIs', { size: L('enterpriseSizes', u.size_class) })))
        : h('p', { class: 'sig warn' }, h('span', { class: 'ico' }, '❔'), h('div', null, t('govt.why.size-unknown'))),
      cat('enterpriseSizes').map((b) => h('p', { class: 'tiny muted' }, `${short(b)}: ${b.explain}`)),
      h('p', { class: 'help' }, state.catalog.sizeNote)),

    h('div', { class: 'card' },
      h('h2', null, t('me.lang')),
      picker({
        name: 'lang', options: cat('languages').filter(l=>LANGS.includes(l.id)), value: state.lang, labelOf: (o) => `${o.icon ?? ''} ${o.en} / ${o.hi}${LANGS.includes(o.id) ? '' : ` (${t('me.langSoon')})`}`,
        onPick: async (v) => {
          if (!LANGS.includes(v)) { toast(t, `${t('me.langSoon')}`, 'bad'); return; }
          setLang(v);
          await api('PATCH', '/me', { lang: v });
          await refresh();
        },
      }).node),

    h('div', { class: 'card' },
      h('h2', null, t('me.data')),
      h('button',{class:'btn',onclick:()=>recovery(true)},say('Create a recovery key','रिकवरी कुंजी बनाएँ')),
      pendingPanel(),
      h('p', { class: 'muted' }, t('me.exportHelp')),
      h('div', { class: 'stack', style: 'margin-top:8px' },
        h('a', { class: 'btn btn-navy btn-block', href: '/api/export.json', download: '' }, '💾 ', t('me.backup')),
        h('a', { class: 'btn btn-block', href: '/api/export.csv', download: '' }, '📄 ', t('money.export')))),

    h('div', { class: 'card' },
      h('h2', null, t('me.health')),
      healthPanel()),

    h('div', { class: 'card' },
      h('h2', null, t('me.about')),
      h('p', { class: 'muted' }, t('me.version', { v: state.version })),

      h('button', { class: 'btn btn-block', onclick: async () => { try { await net.call('POST','/logout',{}); }
        catch { toast(t,say('Connect to finish signing out.','लॉग आउट करने के लिए कनेक्ट करें।'),'bad'); return; }
        sessionStorage.removeItem('udisa.view'); clearDrafts(); net.setToken(''); net.setOwner(''); state.user=null; state.data=null; state.queued=0; location.hash=''; render(); } }, t('auth.logout')),
      h('hr'),
      h('h2', null, t('me.danger')),
      h('p', { class: 'tiny muted' }, t('me.dangerHelp')),
      h('button', { class: 'btn btn-danger btn-block', onclick: () => dangerZone() }, '🗑️ ', t('me.danger')))
  );
}

function line(k, v) {
  return h('div', { class: 'row between', style: 'gap:12px' },
    h('dt', { class: 'tiny muted', style: 'flex:none' }, k),
    h('dd', { style: 'margin:0;text-align:right;font-weight:600' }, v));
}

const HEALTH_ASSETS = [
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png', '/icons/favicon-16.png', '/favicon.ico', '/img/mark.svg', '/css/brand.css', '/manifest.webmanifest',
];

async function runHealth() {
  const results = [];
  const push = (id, ok, detail) => results.push({ id, ok, detail: detail ?? '' });

  let health = null;
  try {
    const r = await fetch('/api/health');
    health = await r.json();
    push('server', health.ok === true, `${health.app} v${health.version}`);
  } catch (e) { push('server', false, String(e.message ?? e)); }

  const bad = [];
  for (const url of HEALTH_ASSETS) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (!r.ok) bad.push(`${url} ${r.status}`);
    } catch { bad.push(url); }
  }
  push('assets', bad.length === 0, bad.length ? bad.join(', ') : `${HEALTH_ASSETS.length} files ok`);

  try {
    const me = await api('GET', '/me', null, { quiet: true });
    push('session', !!me.user?.udyam_id, me.user?.udyam_id);
  } catch (e) { push('session', false, e.code ?? String(e)); }

  try {
    localStorage.setItem('udisa.probe', '1');
    const ok = localStorage.getItem('udisa.probe') === '1';
    localStorage.removeItem('udisa.probe');
    push('storage', ok, ok ? 'readable and writable' : 'cannot write');
  } catch (e) { push('storage', false, String(e.message ?? e)); }

  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  push('offline', Boolean(reg?.active), reg?.active ? 'cached shell, opens without internet' : 'not installed - open needs the server');

  const divisions = cat('nicDivisions');
  const activities = cat('activities');
  const missing = activities.filter((a) => a.id !== 'both-manufacturing-and-services' && !divisions.some((x) => x.activity === a.id));
  const dupCodes = divisions.length - new Set(divisions.map((x) => x.code)).size;
  push('catalog', divisions.length > 50 && !missing.length && dupCodes === 0,
    `${divisions.length} options, ${cat('states').length} states, ${cat('units').length} units${missing.length ? ` | no options for ${missing.map((m) => m.id)}` : ''}${dupCodes ? ` | ${dupCodes} duplicates` : ''}`);

  push('schemes', Boolean(health?.schemes), `${health?.schemes ?? 0} schemes, checked ${health?.dataFiles?.lastVerified ?? '—'}`);
  return results;
}

function healthPanel() {
  const box = h('div', { class: 'stack', id: 'health-results' });
  const run = async () => {
    fill(box, h('div', { class: 'row', style: 'gap:10px' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, t('common.loading'))));
    const results = await runHealth();
    const failed = results.filter((r) => !r.ok);
    fill(box, 
      h('p', { class: `sig ${failed.length ? 'bad' : 'good'}` }, h('span', { class: 'ico' }, failed.length ? '⚠️' : '✅'),
        h('div', null, failed.length ? t('me.healthBad', { n: failed.length }) : t('me.healthOk'))),
      results.map((r) => h('div', { class: 'row between', style: 'padding:6px 0;border-bottom:1px solid #eef1f6' },
        h('div', null, h('div', { style: 'font-weight:700' }, `${r.ok ? '✅' : '❌'} ${t(`health.${r.id}`)}`),
          r.detail ? h('div', { class: 'tiny muted' }, r.detail) : null))),
      h('button', { class: 'btn btn-ghost btn-block', onclick: () => run() }, '🔄 ', t('boot.retry'))
    );
  };
  const btn = h('button', { class: 'btn btn-navy btn-block', onclick: () => run() }, '🩺 ', t('me.health'));
  return h('div', {}, btn, box);
}

function dangerZone() {
  const form = makeForm([
    { name: 'password', label: t('auth.password'), inputType: 'password', required: true, autocomplete: 'current-password' },
    { name: 'word', label: t('me.dangerConfirm'), autocomplete: 'off' },
  ]);
  const s = sheet(t('me.danger'), h('div', {}, h('p', { class: 'muted' }, t('me.dangerHelp')), form.node), [
    h('button', { class: 'btn btn-ghost', onclick: () => s.close() }, t('common.cancel')),
    h('button', { class: 'btn btn-danger', onclick: async (e) => {
      const v = form.get();
      if (v.word !== 'DELETE') { form.showErrors({ word: t('me.dangerBad') }); return; }
      e.target.disabled = true;
      try {
        await api('DELETE', '/me', { password: v.password });
      } catch (err) {
        form.showErrors({ password: err.message || t('me.dangerBad') });
        e.target.disabled = false;
        return;
      }
      net.setToken('');
      for (const row of net.readQueue()) net.forget(row.key);
      clearDrafts(); sessionStorage.removeItem('udisa.view'); net.setOwner('');
      location.href = '/';
      location.reload();
    } }, t('me.danger')),
  ]);
}

// ----------------------------------------------------------------------- boot

async function boot() {
  const line = $('#boot-line');
  try {
    const out = await net.get('/bootstrap');
    state.brand = out.brand;
    state.catalog = { ...out.catalog, nicDivisions: out.catalog.nicDivisions ?? [] };
    state.version = out.version;
    state.lastVerified = out.lastVerified;
    document.title = out.brand.name;
    setLang(tryLocal('udisa.lang') ?? 'en');

    if (net.getToken()) {
      try {
        const me = await api('GET', '/me', null, { quiet: true });
        state.user = me.user;
        net.setOwner(me.user.id);
        await net.flushQueue();
        state.queued = net.queueSize();
        setLang(me.user.lang || state.lang);
        await refresh();
      } catch (err) {
        const cached = JSON.parse(sessionStorage.getItem('udisa.view') || 'null');
        if (err.code === 'network' && cached?.token === net.getToken()) {
          state.user=cached.user; state.data=cached.data; setLang(state.user.lang); net.setOwner(state.user.id); state.online=false; state.queued=net.queueSize();
        } else {
          if (err.code === 'unauthenticated') net.setToken('');
          state.user=null; state.data=null; net.setOwner('');
        }
      }
    }
    render();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    net.onNetwork(({ online, queued }) => {
      if (state.online === online && state.queued === queued) return;
      const finished = state.queued > 0 && queued === 0;
      const wasOffline = !state.online;
      state.online = online;
      state.queued = queued;
      if (state.user) {
        render();
        if (finished && online) toast(t,say('All pending entries synced','सभी प्रविष्टियाँ सिंक हो गईं'),'good');
        if ((wasOffline || finished) && online && queued === 0) void refresh().catch(() => {});
      }
    });
    window.addEventListener('focus',()=>{if(state.user && navigator.onLine && net.queueSize()) void net.flushQueue();});
    window.addEventListener('hashchange', () => render());
  } catch (err) {
    const boot = $('#boot');
    boot?.classList.add('is-error');
    if (line) line.textContent = navigator.onLine ? t('boot.failed') : t('boot.offline');
    const retry = $('#boot-retry');
    if (retry) {
      retry.hidden = false;
      // a stale service-worker cache is the usual reason this screen appears at
      // all, so recovery drops the cache before reloading
      retry.onclick = async () => {
        retry.disabled = true;
        try {
          const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
          await Promise.all(regs.map((r) => r.unregister()));
          const keys = await caches?.keys?.() ?? [];
          await Promise.all(keys.map((k) => caches.delete(k)));
        } catch {}
        location.reload();
      };
    }
    console.error('boot failed', err);
  }
}

function tryLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

window.addEventListener('storage',e=>{
  if (e.key === 'udisa.token' && e.oldValue !== e.newValue) {
    sessionStorage.removeItem('udisa.view'); location.reload();
  }
});
if (readReg().password || readReg().password2) writeReg({});
boot();

export { state, render, go, api, refresh, setLang, runHealth, HEALTH_ASSETS };
