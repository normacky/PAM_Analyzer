#!/usr/bin/env node
/* ============================================================================
 * pam_scan.js  —  whole-US-market "reverse scan" precompute (multi-timeframe)
 *
 * For every active US stock it pulls bars from Alpaca, runs the EXACT PAM/Turtle
 * engine lifted out of pam_analyzer.html, and records which tickers fired which
 * trigger on the last 2 bars — on THREE timeframes:
 *     1-Day   (daily bars)
 *     2-Day   (pairs of daily bars aggregated in the engine, exactly like the chart)
 *     Weekly  (native Alpaca 1Week bars, exactly like the chart's weekly view)
 * It does this with two pulls only: one daily pull feeds both 1-Day and 2-Day, and
 * a separate, lightweight native-weekly pull feeds the weekly timeframe. It writes
 * scan_results.json, which the analyzer's "Scan by trigger" panel reads; the panel's
 * 1 / 2 / W selector switches between the three timeframes.
 *
 *   The engine is NOT re-implemented here — it is extracted from the HTML at
 *   runtime, so there is only ever ONE copy of the logic and the scan can never
 *   drift from what the tool shows.
 *
 * Run it:
 *   ALPACA_KEY=xxxx ALPACA_SECRET=yyyy node pam_scan.js
 *
 * Handy env knobs (all optional):
 *   PAM_HTML         path to the analyzer HTML    (default pam_analyzer_v8.html)
 *   PAM_OUT          output file                   (default scan_results.json)
 *   PAM_LIMIT        only scan the first N tickers — use a small number (e.g. 200)
 *                    for your FIRST live test, then remove it for the full market
 *   PAM_FRESH        a trigger counts if it fired within the last N bars (default 2)
 *   PAM_DAILY_DAYS   calendar days of daily bars to pull   (default 500 — covers 2-Day)
 *   PAM_WEEKLY_DAYS  calendar days of weekly bars to pull  (default 1400 ≈ 200 weeks)
 *   PAM_FEED         alpaca feed                   (default sip)
 *   PAM_ADJ          price adjustment              (default split)
 * ========================================================================== */

const fs = require('fs');

const CFG = {
  htmlPath:    process.env.PAM_HTML     || 'pam_analyzer_v8.html',
  out:         process.env.PAM_OUT      || 'scan_results.json',
  aggMult:     parseInt(process.env.PAM_AGG      || '1', 10),   // 1 = daily bars (per-timeframe value is set at scan time)
  lookback:    parseInt(process.env.PAM_LOOKBACK || '160', 10), // 55-ch + 50-SMA + buffer (target bars IN the timeframe)
  dailyDays:   parseInt(process.env.PAM_DAILY_DAYS  || '500',  10), // calendar days of daily bars to pull — covers 2-Day's 160-bar lookback (~345 trading bars)
  weeklyDays:  parseInt(process.env.PAM_WEEKLY_DAYS || '1400', 10), // calendar days of native weekly bars to pull (~200 weeks)
  freshWithin: parseInt(process.env.PAM_FRESH    || '2', 10),   // "last 2 candles" — IN whatever timeframe is being scanned
  batch:       parseInt(process.env.PAM_BATCH    || '100', 10), // symbols per request
  reqPerMin:   parseInt(process.env.PAM_RPM      || '180', 10), // stay under Alpaca's 200/min
  feed:        process.env.PAM_FEED     || 'sip',               // EOD free tier = delayed SIP
  adjustment:  process.env.PAM_ADJ      || 'split',
  exchanges:  (process.env.PAM_EXCH || 'NYSE,NASDAQ,ARCA,AMEX,BATS').split(','),
  limit:       parseInt(process.env.PAM_LIMIT    || '0', 10),   // 0 = whole market
  fundGapMs:   parseInt(process.env.FUND_GAP_MS  || '1100', 10),  // pause between fundamentals calls (~55/min, under Finnhub's 60/min)
  fundTimeout: parseInt(process.env.FUND_TIMEOUT || '15000', 10), // per-request timeout (ms)
};

const FINNHUB_KEY = process.env.FINNHUB_KEY;   // free key from finnhub.io — adds market cap + industry

const KEY    = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
const DATA_API  = 'https://data.alpaca.markets';
// paper keys start with "PK" and must hit paper-api; live keys ("AK") hit api. Override with PAM_TRADE_BASE.
const TRADE_API = process.env.PAM_TRADE_BASE ||
  ((KEY || '').startsWith('PK') ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
const HEADERS = { 'APCA-API-KEY-ID': KEY || '', 'APCA-API-SECRET-KEY': SECRET || '' };
const TRIGGER_TYPES = ['Bull-FS','UC1','UC2','DR1','DR2','Bear-FS','DC1','DC2','UR1','UR2','S1','S2','S1s','S2s'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- 1. lift the engine straight out of the HTML --------------------------- */
function loadEngine(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('function aggregate(');
  const stateMarker = html.indexOf('STATE + RENDER', start);  // first thing after the engine
  if (start < 0 || stateMarker < 0) throw new Error('Could not locate the engine block in ' + htmlPath);
  let block = html.slice(start, stateMarker);
  block = block.slice(0, block.lastIndexOf('}') + 1);          // trim back to analyse()'s closing brace
  // scan() calls fmt() only to build a cosmetic "why" string — give it a tiny stand-in.
  const fmtDef = 'function fmt(x,d){return x==null?"-":Number(x).toFixed(d==null?2:d);}\n';
  const factory = new Function(fmtDef + block + '\nreturn { aggregate, enrich, scan, buildTrade };');
  return factory();   // isolated scope, no globals, no DOM
}

/* ---- 2. shape an Alpaca bar array into what aggregate() expects ------------- */
function seriesFromAlpaca(arr) {
  const s = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const b of arr) {
    s.time.push(b.t.slice(0, 10)); s.open.push(b.o); s.high.push(b.h);
    s.low.push(b.l); s.close.push(b.c); s.volume.push(b.v);
  }
  return s;
}

/* ---- 3. the heart of it: which triggers fired on the last N bars? ----------- */
function detectFresh(sym, series, eng, cfg) {
  // need ~60 bars IN the aggregated timeframe to warm scan(); 2-Day eats 2 daily bars each, so require 60*aggMult raw bars
  if (!series || !series.close || series.close.length < 60 * (cfg.aggMult || 1)) return [];
  let bars;
  try { bars = eng.enrich(eng.aggregate(series, cfg.aggMult)); }
  catch (e) { return []; }
  if (!bars || bars.length < 2) return [];

  const last = bars.length - 1;
  const fresh = i => (last - i) < cfg.freshWithin;   // within the last `freshWithin` bars (ago 0..N-1)
  const rows = [];

  // PAM setups (Bull-FS / UC1·2 / DR1·2 / Bear-FS / DC1·2 / UR1·2)
  for (const t of eng.scan(bars)) {
    if (!fresh(t.i)) continue;
    let smelly = false;
    try { smelly = !!eng.buildTrade(bars, t).smelly; } catch (e) {}   // price already ran >=1R past entry
    rows.push({ t: sym, trig: t.label, dir: t.dir, bar: t.date, ago: last - t.i, smelly });
  }
  // Turtle long (S1/S2) + reverse-short (S1s/S2s): entries (unit 1) AND pyramid adds (units 2-4) inside the fresh window
  for (let k = last; k >= 0 && (last - k) < cfg.freshWithin; k--) {
    const b = bars[k];
    if (b.ttUnit) {                                    // long: unit 1 = entry, 2/3/4 = pyramid add
      const sys = b.ttSys === 'S2' ? 2 : 1;
      rows.push({ t: sym, trig: 'S' + sys, dir: 'long', bar: b.date, ago: last - k, sys, unit: b.ttUnit });
    }
    if (b.rtUnit) {                                    // reverse-short: unit 1 = entry, 2/3/4 = pyramid add
      const sys = b.rtSys === 'S2' ? 2 : 1;
      rows.push({ t: sym, trig: 'S' + sys + 's', dir: 'short', bar: b.date, ago: last - k, sys, unit: b.rtUnit });
    }
  }
  return rows;
}

/* ---- 4. Alpaca calls (universe + batched, paginated, paced bar pulls) ------- */
async function alpacaGet(url, tries = 0) {
  const r = await fetch(url, { headers: HEADERS });
  if (r.status === 429 && tries < 6) { await sleep(2000); return alpacaGet(url, tries + 1); }  // rate-limited → wait
  if (!r.ok) throw new Error('Alpaca ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function fetchUniverse(cfg) {
  const assets = await alpacaGet(TRADE_API + '/v2/assets?status=active&asset_class=us_equity');
  const ex = new Set(cfg.exchanges);
  let list = assets.filter(a => a.tradable && a.status === 'active' && ex.has(a.exchange) && /^[A-Z]{1,5}$/.test(a.symbol));
  list.sort((a, b) => a.symbol < b.symbol ? -1 : 1);
  if (cfg.limit) list = list.slice(0, cfg.limit);
  const names = {};
  for (const a of list) names[a.symbol] = a.name || '';
  return { syms: list.map(a => a.symbol), names };
}

/* ---- 4b. market cap + sector + industry for the fired tickers (FMP, optional) ---- */
async function addFundamentals(meta, cfg) {
  const tickers = Object.keys(meta);
  if (!FINNHUB_KEY) { console.error('No FINNHUB_KEY set — skipping market cap / industry (rows still carry name + price).'); return; }
  if (!tickers.length) return;
  const mins = Math.ceil(tickers.length * cfg.fundGapMs / 60000);
  console.error(`Looking up market cap + industry for ${tickers.length} counters via Finnhub (~${mins} min at ~${Math.round(60000 / cfg.fundGapMs)}/min)…`);
  let ok = 0, err = 0;
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    try {
      const r = await fetch('https://finnhub.io/api/v1/stock/profile2?symbol=' + encodeURIComponent(t) + '&token=' + FINNHUB_KEY,
        { signal: AbortSignal.timeout(cfg.fundTimeout) });
      if (r.status === 429) { await sleep(2000); err++; continue; }   // throttled this one — pause and move on
      if (!r.ok) { if (err < 8) console.error('  Finnhub ' + r.status + ' on ' + t); err++; }
      else {
        const p = await r.json();
        if (p && (p.marketCapitalization != null || p.finnhubIndustry)) {
          if (p.marketCapitalization != null) meta[t].mc = p.marketCapitalization * 1e6;   // Finnhub reports millions → USD
          if (p.finnhubIndustry) meta[t].industry = p.finnhubIndustry;
          if (!meta[t].name && p.name) meta[t].name = p.name;
          ok++;
        }
      }
    } catch (e) { if (err < 8) console.error('  Finnhub error on ' + t + ': ' + e.message); err++; }
    await sleep(cfg.fundGapMs);
    if (i % 100 === 0) process.stderr.write(`  fundamentals ${i}/${tickers.length}\r`);
  }
  process.stderr.write('\n');
  console.error(`Fundamentals done: ${ok} enriched, ${err} misses, of ${tickers.length} counters.`);
}

async function fetchBars(symbols, cfg, timeframe, startDays) {
  timeframe = timeframe || '1Day';
  startDays = startDays || cfg.dailyDays || 500;
  const end   = new Date(Date.now() - 20 * 60 * 1000).toISOString();              // >15 min old → free SIP allowed
  const start = new Date(Date.now() - startDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const gap = Math.ceil(60000 / cfg.reqPerMin);
  const out = {};
  for (let i = 0; i < symbols.length; i += cfg.batch) {
    const batch = symbols.slice(i, i + cfg.batch);
    let pageToken = null;
    do {
      const u = new URL(DATA_API + '/v2/stocks/bars');
      u.searchParams.set('symbols', batch.join(','));
      u.searchParams.set('timeframe', timeframe);
      u.searchParams.set('start', start);
      u.searchParams.set('end', end);
      u.searchParams.set('feed', cfg.feed);
      u.searchParams.set('adjustment', cfg.adjustment);
      u.searchParams.set('limit', '10000');
      if (pageToken) u.searchParams.set('page_token', pageToken);
      const j = await alpacaGet(u.toString());
      const bars = j.bars || {};
      for (const sym in bars) (out[sym] = out[sym] || []).push(...bars[sym]);
      pageToken = j.next_page_token || null;
      await sleep(gap);
    } while (pageToken);
    process.stderr.write(`  ${timeframe} bars ${Math.min(i + cfg.batch, symbols.length)}/${symbols.length}\r`);
  }
  process.stderr.write('\n');
  return out;
}

/* ---- 5. orchestrate ------------------------------------------------------- */
async function main() {
  if (!KEY || !SECRET) { console.error('Set ALPACA_KEY and ALPACA_SECRET in the environment first.'); process.exit(1); }
  const eng = loadEngine(CFG.htmlPath);
  console.error('Engine loaded from ' + CFG.htmlPath + '. Fetching universe…');
  const { syms, names } = await fetchUniverse(CFG);

  const meta = {};   // ticker -> { name, px, mc, industry } — shared across ALL timeframes (any ticker firing in any tf)
  // one accumulator per timeframe: '1' = daily, '2' = 2-Day (daily aggregated x2), 'W' = native weekly
  const acc = {
    '1': { tf: '1', aggMult: 1, rows: [], scanned: 0, asof: '' },
    '2': { tf: '2', aggMult: 2, rows: [], scanned: 0, asof: '' },
    'W': { tf: 'W', aggMult: 1, rows: [], scanned: 0, asof: '' },
  };
  const noteFire = (sym, series) => { meta[sym] = meta[sym] || { name: names[sym] || '', px: +series.close[series.close.length - 1] }; };

  /* ---- Phase 1: one DAILY pull feeds BOTH the 1-Day and 2-Day scans ---- */
  console.error(`Universe: ${syms.length} symbols. Phase 1/2 — pulling daily bars (~${CFG.dailyDays} calendar days) for the 1-Day + 2-Day timeframes…`);
  let daily = await fetchBars(syms, CFG, '1Day', CFG.dailyDays);
  for (const sym of syms) {
    const arr = daily[sym];
    if (arr && arr.length >= 60) {
      const series = seriesFromAlpaca(arr);
      const lastDate = series.time[series.time.length - 1];
      for (const tf of ['1', '2']) {
        const a = acc[tf];
        if (series.close.length < 60 * a.aggMult) continue;   // not enough daily bars for this timeframe
        a.scanned++;
        if (lastDate > a.asof) a.asof = lastDate;
        const fired = detectFresh(sym, series, eng, { ...CFG, aggMult: a.aggMult });
        if (fired.length) { for (const r of fired) r.tf = tf; a.rows.push(...fired); noteFire(sym, series); }
      }
    }
    delete daily[sym];   // free each ticker as we finish with it
  }
  daily = null;

  /* ---- Phase 2: a separate NATIVE WEEKLY pull (Alpaca 1Week) for the weekly timeframe ---- */
  console.error(`Phase 2/2 — pulling native weekly bars (~${Math.round(CFG.weeklyDays / 7)} weeks) for the weekly timeframe…`);
  let weekly = await fetchBars(syms, CFG, '1Week', CFG.weeklyDays);
  for (const sym of syms) {
    const arr = weekly[sym];
    if (arr && arr.length >= 60) {
      const series = seriesFromAlpaca(arr);
      const lastDate = series.time[series.time.length - 1];
      const a = acc['W'];
      a.scanned++;
      if (lastDate > a.asof) a.asof = lastDate;
      const fired = detectFresh(sym, series, eng, { ...CFG, aggMult: 1 });   // weekly bars are already the base timeframe
      if (fired.length) { for (const r of fired) r.tf = 'W'; a.rows.push(...fired); noteFire(sym, series); }
    }
    delete weekly[sym];
  }
  weekly = null;

  await addFundamentals(meta, CFG);   // market cap / industry for every fired ticker, across all timeframes (no-op without FINNHUB_KEY)

  // per-timeframe counts, stable sort, and distinct-ticker count
  for (const tf of ['1', '2', 'W']) {
    const a = acc[tf];
    a.counts = {};
    for (const r of a.rows) a.counts[r.trig] = (a.counts[r.trig] || 0) + 1;
    a.rows.sort((x, y) => x.trig < y.trig ? -1 : x.trig > y.trig ? 1 : (x.t < y.t ? -1 : 1));
    a.firedCount = new Set(a.rows.map(r => r.t)).size;
  }

  const result = {
    // ---- top level === the 1-Day view (back-compatible with the old single-timeframe file) ----
    asof: acc['1'].asof, timeframe: '1day', agg_mult: 1, fresh_within: CFG.freshWithin,
    generated_at: new Date().toISOString(), provider: 'alpaca', feed: CFG.feed, adjustment: CFG.adjustment,
    fundamentals: FINNHUB_KEY ? 'finnhub' : 'none',
    universe: syms.length, scanned: acc['1'].scanned, fired: acc['1'].firedCount,
    trigger_types: TRIGGER_TYPES, counts: acc['1'].counts, rows: acc['1'].rows, meta,
    // ---- NEW: the extra timeframes; the panel reads '1' from the top level and '2'/'W' from here ----
    timeframes: ['1', '2', 'W'],
    tf: {
      '2': { timeframe: '2day',  agg_mult: 2, fresh_within: CFG.freshWithin, asof: acc['2'].asof,
             scanned: acc['2'].scanned, fired: acc['2'].firedCount, counts: acc['2'].counts, rows: acc['2'].rows },
      'W': { timeframe: '1week', agg_mult: 1, fresh_within: CFG.freshWithin, asof: acc['W'].asof,
             scanned: acc['W'].scanned, fired: acc['W'].firedCount, counts: acc['W'].counts, rows: acc['W'].rows },
    },
  };
  fs.writeFileSync(CFG.out, JSON.stringify(result, null, 1));
  const r1 = acc['1'].rows.length, r2 = acc['2'].rows.length, rw = acc['W'].rows.length;
  console.error(`Done — ${r1 + r2 + rw} fresh triggers (1d:${r1}  2d:${r2}  wk:${rw}) across ${Object.keys(meta).length} counters. Wrote ${CFG.out}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { loadEngine, detectFresh, seriesFromAlpaca, fetchUniverse, fetchBars, addFundamentals };
