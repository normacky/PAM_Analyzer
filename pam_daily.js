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
 */
const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
const H  = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
const todayISO = () => new Date().toISOString().slice(0, 10);
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
async function quote(occ, token) {
  const url = 'https://api.marketdata.app/v1/options/quotes/' + encodeURIComponent(occ) + '/?token=' + encodeURIComponent(token);
  for (let attempt = 0; attempt < 3; attempt++) {
    let r; try { r = await fetch(url); } catch (e) { await sleep(1500); continue; }
    if (r.status === 429) { await sleep(4000); continue; }        // rate limited - back off
    if (r.status !== 200 && r.status !== 203) return null;        // 203 = cached tier, body identical
    const j = await r.json().catch(() => null);
    if (!j || j.s !== 'ok') return null;
    const bid = (j.bid && j.bid[0]) || 0, ask = (j.ask && j.ask[0]) || 0;
    let mid = (j.mid && j.mid[0]) || 0;
    if (!(mid > 0) && bid > 0 && ask > 0) mid = (bid + ask) / 2;
    if (!(mid > 0)) return null;                                   // no zero/one-sided marks
    return { bid: bid || null, ask: ask || null, mid,
      delta: (j.delta && j.delta[0] != null) ? +j.delta[0] : null,
      iv: (j.iv && j.iv[0] != null) ? +j.iv[0] : null,
      spot: (j.underlyingPrice && j.underlyingPrice[0]) || null };
  }
  return null;
}
async function stepMark() {
  need(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'MD_TOKEN']);
  const cap = +(process.env.MD_MAX_CREDITS || 90), day = todayISO();
  const trades = await sbGet('trades?status=eq.open&select=id,user_id,underlying');
  if (!trades.length) { console.log('no open trades - nothing to mark'); return; }
  const byTrade = Object.fromEntries(trades.map(t => [t.id, t]));
  const legs = await sbGet('trade_legs?status=eq.open&trade_id=in.(' + trades.map(t => t.id).join(',') + ')&select=occ_symbol,trade_id');

  const owner = {};
  legs.forEach(l => { if (l.occ_symbol && !owner[l.occ_symbol]) owner[l.occ_symbol] = byTrade[l.trade_id]?.user_id; });
  const occs = Object.keys(owner).filter(o => owner[o]);
  console.log(occs.length + ' open legs to mark (cap ' + cap + ')');
  if (occs.length > cap) { console.error('leg count exceeds MD_MAX_CREDITS - raise the cap deliberately'); process.exit(1); }

  const rows = []; let ok = 0, miss = 0;
  for (const occ of occs) {
    const q = await quote(occ, process.env.MD_TOKEN);
    if (!q) { miss++; continue; }
    ok++;
    rows.push({ user_id: owner[occ], occ_symbol: occ, mark_date: day,
      bid: q.bid, ask: q.ask, mid: Math.round(q.mid * 10000) / 10000,
      delta: q.delta, iv: q.iv, spot: q.spot,
      source: 'marketdata', updated_at: new Date().toISOString() });
    await sleep(120);
  }
  for (let i = 0; i < rows.length; i += 200)
    await sbUpsert('eod_marks', rows.slice(i, i + 200), 'user_id,occ_symbol,mark_date');
  console.log('marked ' + ok + ' / ' + occs.length + ' (' + miss + ' without a usable quote), credits ~' + occs.length);
  if (ok === 0 && occs.length) { console.error('no usable quotes - market holiday, or token/plan problem'); process.exit(1); }
}

/* ==================== entry ==================== */
(async () => {
  const step = (process.argv[2] || 'all').toLowerCase();
  if (step === 'banksync' || step === 'all') { console.log('--- banksync ---'); await stepBanksync(); }
  if (step === 'mark'     || step === 'all') { console.log('--- mark ---');     await stepMark(); }
  if (!['banksync', 'mark', 'all'].includes(step)) { console.error('usage: node pam_daily.js [banksync|mark|all]'); process.exit(1); }
})().catch(e => { console.error(e.message); process.exit(1); });
