#!/usr/bin/env node
/* PAM daily job - one file, two steps.
 *
 *   node pam_daily.js banksync   BankSync Google Sheet -> Supabase bank_fills
 *   node pam_daily.js mark       quote every open leg  -> Supabase eod_marks
 *   node pam_daily.js all        both, in that order
 *
 * Interpretation of fills into trades stays in PAM Analyzer (it shows you what it did and lets you
 * override); this job only moves data in and prices out.
 *
 * Secrets used:
 *   banksync : BANKSYNC_URL, BANKSYNC_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, FEED_TOKEN
 *   mark     : SUPABASE_URL, SUPABASE_SERVICE_KEY, MD_TOKEN   (optional MD_MAX_CREDITS, default 90)
 *
 * The mark step shares one 100/day marketdata.app allowance with the browser app, so it quotes only
 * the legs that genuinely need a fresh quote and reprices the rest from stored IV (same rules as
 * mdPlan/mdModel in pam_analyzer.html). It also records what it spent in md_credits.
 */
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const H  = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
/* Singapore calendar date. The workflow fires at 21:30 UTC = 05:30 SGT the NEXT day, so a plain
   UTC stamp lands a day behind what pam_analyzer.html calls "today". The app then treats every
   nightly mark as stale: no TP/SL alerts, and it re-quotes legs the job already paid for. */
const todayISO = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
/* marketdata.app's credit day rolls at 21:30 SGT = 13:30 UTC. Same formula the app uses. */
const creditDay = () => new Date(Date.now() - 13.5 * 3600e3).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function need(names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) { console.error('missing secret(s): ' + missing.join(', ')); process.exit(1); }
}
async function sbGet(path) {
  const r = await fetch(SB + '/rest/v1/' + path, { headers: H });
  if (!r.ok) throw new Error('GET ' + path + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function sbUpsert(table, rows, onConflict) {
  const r = await fetch(SB + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows) });
  if (!r.ok) throw new Error('upsert ' + table + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
}

/* ==================== step 1: banksync ==================== */
const OCC = /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/;
const clean = s => String(s == null ? '' : s).replace(/[$,\s]/g, '');

/* BankSync has no open/close column. Schwab puts it in the description text; IBKR rows have none, so
   those campaigns queue for review in the app - same as today. Subtype does flag exercise/assignment. */
function describe(r) {
  let d = String(r.description || '').trim();
  const sub = String(r.subtype || '').toLowerCase();
  if (/exercise/.test(sub) && !/EXERCISED|ASSIGNED/i.test(d)) d = 'EXERCISED - ' + d;
  else if (/assign/.test(sub) && !/ASSIGNED/i.test(d))       d = 'ASSIGNED - ' + d;
  else if (/expir/.test(sub)  && !/EXPIRED/i.test(d))        d = 'EXPIRED - ' + d;
  return d;
}
function toRow(r) {
  const ticker = String(r.ticker || '').replace(/\s/g, '').toUpperCase();
  if (!OCC.test(ticker) || !r.id) return null;              // options only; stocks wait for that phase
  const qty = parseFloat(clean(r.quantity)); if (!isFinite(qty)) return null;
  const px = parseFloat(clean(r.price));
  return { id: String(r.id), bank: String(r.bank || ''), security: String(r.security || ''), ticker,
    type: String(r.type || ''), quantity: qty, currency: String(r.currency || 'USD'),
    price: isFinite(px) ? px : 0, date: String(r.date || ''),
    amount: parseFloat(clean(r.amount)) || 0, fees: parseFloat(clean(r.fees)) || 0,
    description: describe(r) };
}
async function stepBanksync() {
  need(['BANKSYNC_URL', 'BANKSYNC_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'FEED_TOKEN']);
  const url = process.env.BANKSYNC_URL, days = +(process.env.BANKSYNC_DAYS || 120);
  const res = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(process.env.BANKSYNC_TOKEN), { redirect: 'follow' });
  if (!res.ok) throw new Error('banksync fetch -> ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error('banksync: ' + j.error);
  console.log('sheet tab "' + j.tab + '" returned ' + j.count + ' rows');

  const rows = (j.rows || []).map(toRow).filter(Boolean).filter(row => {
    if (!days) return true;
    const t = Date.parse(row.date);
    return !isFinite(t) || (Date.now() - t) / 864e5 <= days;   // unparseable dates go through; the RPC decides
  });
  console.log(rows.length + ' option rows within ' + days + ' days');
  if (!rows.length) { console.log('nothing to push'); return; }

  let ins = 0, dup = 0, skip = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(SB + '/rest/v1/rpc/push_bank_fills', { method: 'POST', headers: H,
      body: JSON.stringify({ p_token: process.env.FEED_TOKEN, p_rows: rows.slice(i, i + 500) }) });
    if (!r.ok) throw new Error('push_bank_fills -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const out = await r.json();
    ins += out.inserted || 0; dup += out.duplicates || 0; skip += out.skipped_non_option || 0;
  }
  console.log('pushed: inserted ' + ins + ', duplicates ' + dup + ', skipped ' + skip);
  if (ins) console.log('note: new fills become positions when PAM Analyzer next opens (auto-apply)');
}

/* ==================== step 2: mark ==================== */
/* Black-Scholes, identical to pam_analyzer.html so job marks and app marks agree. */
function erf1(x){const s=x<0?-1:1;x=Math.abs(x);
  const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;
  const t=1/(1+p*x),y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return s*y;}
const nrm = x => 0.5 * (1 + erf1(x / Math.SQRT2));
function bsPrice(cp,S,K,T,sig,r){r=(r==null?0.04:r);
  if(!(T>0)||!(sig>0))return Math.max(0,cp==='C'?S-K:K-S);
  const d1=(Math.log(S/K)+(r+sig*sig/2)*T)/(sig*Math.sqrt(T)),d2=d1-sig*Math.sqrt(T);
  return cp==='C'?S*nrm(d1)-K*Math.exp(-r*T)*nrm(d2):K*Math.exp(-r*T)*nrm(-d2)-S*nrm(-d1);}
function bsDelta(cp,S,K,T,sig,r){r=(r==null?0.04:r);
  if(!(T>0)||!(sig>0))return cp==='C'?(S>K?1:0):(S<K?-1:0);
  const d1=(Math.log(S/K)+(r+sig*sig/2)*T)/(sig*Math.sqrt(T));
  return cp==='C'?nrm(d1):nrm(d1)-1;}

/* OCC symbol -> {und, expiry, cp, strike} */
function parseOCC(occ){
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
  if (!m) return null;
  return { und: m[1], expiry: '20' + m[2] + '-' + m[3] + '-' + m[4],
           cp: m[5], strike: +m[6] / 1000 };
}

/* Returns {ok,reason,...}. The reason is what tells us WHY a leg failed - the old version
   swallowed it and every failure looked identical in the log. */
async function quote(occ, token) {
  const url = 'https://api.marketdata.app/v1/options/quotes/' + encodeURIComponent(occ) + '/?token=' + encodeURIComponent(token);
  let last = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    let r; try { r = await fetch(url); } catch (e) { last = 'network'; await sleep(1500); continue; }
    if (r.status === 429) { last = 'rate limited (429)'; await sleep(4000); continue; }
    if (r.status === 401 || r.status === 402 || r.status === 403)
      return { ok: false, reason: 'auth/plan (' + r.status + ')', fatal: true };
    if (r.status !== 200 && r.status !== 203) return { ok: false, reason: 'http ' + r.status };
    const j = await r.json().catch(() => null);
    if (!j) return { ok: false, reason: 'bad json' };
    if (j.s !== 'ok') return { ok: false, reason: 'api says "' + (j.s || '?') + '"' + (j.errmsg ? ': ' + String(j.errmsg).slice(0, 80) : ''),
                               fatal: /limit|credit|quota|plan/i.test(String(j.errmsg || '') + String(j.s || '')) };
    const bid = (j.bid && j.bid[0]) || 0, ask = (j.ask && j.ask[0]) || 0;
    let mid = (j.mid && j.mid[0]) || 0;
    if (!(mid > 0) && bid > 0 && ask > 0) mid = (bid + ask) / 2;
    if (!(mid > 0)) return { ok: false, reason: 'no two-sided quote' };
    return { ok: true, bid: bid || null, ask: ask || null, mid,
      delta: (j.delta && j.delta[0] != null) ? +j.delta[0] : null,
      iv: (j.iv && j.iv[0] != null) ? +j.iv[0] : null,
      spot: (j.underlyingPrice && j.underlyingPrice[0]) || null };
  }
  return { ok: false, reason: last };
}

/* How many credits the browser app has already spent in this credit day. */
async function creditsUsed() {
  try {
    const rows = await sbGet('md_credits?credit_day=eq.' + creditDay() + '&select=used');
    return rows.reduce((a, r) => a + (+r.used || 0), 0);
  } catch (e) { console.error('  could not read md_credits: ' + e.message); return 0; }
}
async function creditsAdd(userId, n) {
  if (!userId || !n) return;
  const day = creditDay();
  const rows = await sbGet('md_credits?credit_day=eq.' + day + '&user_id=eq.' + userId + '&select=used');
  const used = (rows.length ? +rows[0].used || 0 : 0) + n;
  await sbUpsert('md_credits', [{ user_id: userId, credit_day: day, used, updated_at: new Date().toISOString() }],
                 'user_id,credit_day');
  console.log('md_credits for ' + day + ' now reads ' + used);
}

async function stepMark() {
  need(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'MD_TOKEN']);
  const hardCap = +(process.env.MD_MAX_CREDITS || 90), day = todayISO();
  console.log('mark_date=' + day + ' (SGT), credit_day=' + creditDay() + ', now ' + new Date().toISOString() + ' UTC');

  const trades = await sbGet('trades?status=eq.open&select=id,user_id,underlying');
  if (!trades.length) { console.log('no open trades - nothing to mark'); return; }
  const byTrade = Object.fromEntries(trades.map(t => [t.id, t]));
  const legs = await sbGet('trade_legs?status=eq.open&trade_id=in.(' + trades.map(t => t.id).join(',') + ')&select=occ_symbol,trade_id');

  const owner = {};
  legs.forEach(l => { if (l.occ_symbol && !owner[l.occ_symbol]) owner[l.occ_symbol] = byTrade[l.trade_id]?.user_id; });
  const occs = Object.keys(owner).filter(o => owner[o]);
  if (!occs.length) { console.log('no open legs with an owner - nothing to mark'); return; }

  /* last known mark per leg: gives us the IV to reprice from, and the last spot as a fallback */
  const prev = {}, lastSpot = {};
  try {
    const hist = await sbGet('eod_marks?occ_symbol=in.(' + occs.join(',') + ')&select=occ_symbol,mid,delta,iv,spot,mark_date&order=mark_date.desc&limit=2000');
    hist.forEach(r => {
      if (!prev[r.occ_symbol]) prev[r.occ_symbol] = r;
      const p = parseOCC(r.occ_symbol);
      if (p && +r.spot > 0 && !lastSpot[p.und]) lastSpot[p.und] = +r.spot;
    });
  } catch (e) { console.error('  could not read prior marks: ' + e.message); }

  /* --- plan: who needs a real quote, who can be repriced from stored IV --- */
  const rows = occs.map(o => {
    const p = parseOCC(o) || {};
    const k = prev[o], S = lastSpot[p.und] || 0;
    const dte = p.expiry ? Math.round((new Date(p.expiry + 'T00:00:00Z') - new Date(day + 'T00:00:00Z')) / 864e5) : null;
    const noBase = !k || !(+k.iv > 0) || !(S > 0);
    const stale  = k && k.mark_date && ((new Date(day) - new Date(k.mark_date)) / 864e5 > 7);
    const near   = S > 0 && p.strike && Math.abs(S - p.strike) / S <= 0.08;
    const deep   = k && k.delta != null && Math.abs(+k.delta) >= 0.70;
    const soon   = dte != null && dte <= 21;
    /* rank: lower = quote me first when the budget is tight */
    const rank = noBase ? 0 : soon ? 1 : near ? 2 : deep ? 3 : stale ? 4 : 9;
    return { occ: o, ...p, dte, rank, k, S };
  });

  /* one leg per underlying must be quoted, otherwise we have no fresh spot to model the others off */
  const anchor = {};
  rows.forEach(r => { const a = anchor[r.und];
    if (!a || (r.dte != null && a.dte != null && r.dte < a.dte)) anchor[r.und] = r; });
  Object.values(anchor).forEach(r => { r.rank = Math.min(r.rank, 1); r.isAnchor = true; });

  const used = await creditsUsed();
  const budget = Math.max(0, Math.min(hardCap, 100 - used));
  const wanted = rows.filter(r => r.rank < 9).sort((a, b) => a.rank - b.rank || (a.dte ?? 999) - (b.dte ?? 999));
  const toQuote = wanted.slice(0, budget);
  const toModel = rows.filter(r => !toQuote.includes(r));
  console.log(occs.length + ' open legs - app already used ' + used + ' credits today, budget ' + budget +
              '; quoting ' + toQuote.length + ', modelling ' + toModel.length);
  if (wanted.length > budget)
    console.error('  budget short by ' + (wanted.length - budget) + ' legs - the lowest-priority ones fall back to the model');

  /* --- quote --- */
  const spot = { ...lastSpot }, out = [], why = {};
  let ok = 0, spent = 0, fatal = null;
  for (const r of toQuote) {
    if (fatal) { why[fatal] = (why[fatal] || 0) + 1; continue; }
    const q = await quote(r.occ, process.env.MD_TOKEN);
    spent++;
    if (!q.ok) {
      why[q.reason] = (why[q.reason] || 0) + 1;
      if (q.fatal) { fatal = q.reason; console.error('  stopping quotes: ' + q.reason); }
      continue;
    }
    ok++;
    if (+q.spot > 0) spot[r.und] = +q.spot;
    if (+q.iv > 0) r.freshIV = +q.iv;
    out.push({ user_id: owner[r.occ], occ_symbol: r.occ, mark_date: day,
      bid: q.bid, ask: q.ask, mid: Math.round(q.mid * 10000) / 10000,
      delta: q.delta, iv: q.iv, spot: q.spot,
      source: 'marketdata', updated_at: new Date().toISOString() });
    await sleep(150);
  }

  /* --- model the rest from stored IV + the spot we just refreshed --- */
  let modelled = 0, skipped = 0;
  for (const r of toModel) {
    const iv = r.k ? +r.k.iv : 0, S = spot[r.und] || 0;
    if (!(iv > 0) || !(S > 0) || !r.strike || !r.expiry) { skipped++; continue; }
    const T = Math.max(1, (new Date(r.expiry + 'T00:00:00Z') - new Date(day + 'T00:00:00Z')) / 864e5) / 365;
    const mid = bsPrice(r.cp, S, r.strike, T, iv, 0.04);
    if (!(mid >= 0)) { skipped++; continue; }
    modelled++;
    out.push({ user_id: owner[r.occ], occ_symbol: r.occ, mark_date: day,
      bid: null, ask: null, mid: Math.round(mid * 10000) / 10000,
      delta: Math.round(bsDelta(r.cp, S, r.strike, T, iv, 0.04) * 1e4) / 1e4,
      iv, spot: S, source: 'model', updated_at: new Date().toISOString() });
  }

  for (let i = 0; i < out.length; i += 200)
    await sbUpsert('eod_marks', out.slice(i, i + 200), 'user_id,occ_symbol,mark_date');

  if (spent) await creditsAdd(owner[occs[0]], spent);

  console.log('marked ' + out.length + ' / ' + occs.length +
              ' (' + ok + ' quoted, ' + modelled + ' modelled, ' + skipped + ' skipped), credits spent ' + spent);
  const reasons = Object.entries(why).sort((a, b) => b[1] - a[1]);
  if (reasons.length) { console.log('quote failures:'); reasons.forEach(([r, n]) => console.log('  ' + n + ' x ' + r)); }
  if (!out.length && occs.length) { console.error('nothing marked at all - market holiday, or token/plan problem'); process.exit(1); }
}

/* ==================== entry ==================== */
(async () => {
  const step = (process.argv[2] || 'all').toLowerCase();
  if (step === 'banksync' || step === 'all') { console.log('--- banksync ---'); await stepBanksync(); }
  if (step === 'mark'     || step === 'all') { console.log('--- mark ---');     await stepMark(); }
  if (!['banksync', 'mark', 'all'].includes(step)) { console.error('usage: node pam_daily.js [banksync|mark|all]'); process.exit(1); }
})().catch(e => { console.error(e.message); process.exit(1); });
