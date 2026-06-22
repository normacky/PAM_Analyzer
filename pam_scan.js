#!/usr/bin/env node
/* ============================================================================
 * pam_scan.js  —  whole-US-market "reverse scan" precompute
 *
 * For every active US stock it pulls ~160 daily bars from Alpaca, runs the
 * EXACT PAM/Turtle engine lifted out of pam_analyzer_v8.html, and records which
 * tickers fired which trigger on the last 2 daily bars. It writes a small file,
 * scan_results.json, that the analyzer's "Scan by trigger" panel will read.
 *
 *   The engine is NOT re-implemented here — it is extracted from the HTML at
 *   runtime, so there is only ever ONE copy of the logic and the scan can never
 *   drift from what the tool shows.
 *
 * Run it:
 *   ALPACA_KEY=xxxx ALPACA_SECRET=yyyy node pam_scan.js
 *
 * Handy env knobs (all optional):
 *   PAM_HTML     path to the analyzer HTML        (default pam_analyzer_v8.html)
 *   PAM_OUT      output file                       (default scan_results.json)
 *   PAM_LIMIT    only scan the first N tickers — use a small number (e.g. 200)
 *                for your FIRST live test, then remove it for the full market
 *   PAM_FRESH    a trigger counts if it fired within the last N bars (default 2)
 *   PAM_LOOKBACK daily bars to pull per ticker      (default 160)
 *   PAM_FEED     alpaca feed                         (default sip)
 *   PAM_ADJ      price adjustment                    (default split)
 * ========================================================================== */

const fs = require('fs');

const CFG = {
  htmlPath:    process.env.PAM_HTML     || 'pam_analyzer_v8.html',
  out:         process.env.PAM_OUT      || 'scan_results.json',
  aggMult:     parseInt(process.env.PAM_AGG      || '1', 10),   // 1 = daily bars
  lookback:    parseInt(process.env.PAM_LOOKBACK || '160', 10), // 55-ch + 50-SMA + buffer
  freshWithin: parseInt(process.env.PAM_FRESH    || '2', 10),   // "last 2 candles"
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
  if (!series || !series.close || series.close.length < 60) return [];   // scan() needs 50+ to warm up
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

async function fetchBars(symbols, cfg) {
  const end   = new Date(Date.now() - 20 * 60 * 1000).toISOString();              // >15 min old → free SIP allowed
  const start = new Date(Date.now() - 300 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const gap = Math.ceil(60000 / cfg.reqPerMin);
  const out = {};
  for (let i = 0; i < symbols.length; i += cfg.batch) {
    const batch = symbols.slice(i, i + cfg.batch);
    let pageToken = null;
    do {
      const u = new URL(DATA_API + '/v2/stocks/bars');
      u.searchParams.set('symbols', batch.join(','));
      u.searchParams.set('timeframe', '1Day');
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
    process.stderr.write(`  bars ${Math.min(i + cfg.batch, symbols.length)}/${symbols.length}\r`);
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
  console.error(`Universe: ${syms.length} symbols. Pulling ~${CFG.lookback} daily bars each…`);
  const barsBySym = await fetchBars(syms, CFG);

  let scanned = 0, asof = '';
  const rows = [];
  const meta = {};   // ticker -> { name, px, mc, sector, industry } — only for tickers that fired
  for (const sym of syms) {
    const arr = barsBySym[sym];
    if (!arr || arr.length < 60) continue;
    const series = seriesFromAlpaca(arr);
    scanned++;
    const lastDate = series.time[series.time.length - 1];
    if (lastDate > asof) asof = lastDate;
    const fired = detectFresh(sym, series, eng, CFG);
    if (fired.length) {
      rows.push(...fired);
      meta[sym] = { name: names[sym] || '', px: +series.close[series.close.length - 1] };
    }
  }

  await addFundamentals(meta, CFG);   // adds mc / sector / industry to each fired ticker (no-op without FMP_KEY)

  const counts = {};
  for (const r of rows) counts[r.trig] = (counts[r.trig] || 0) + 1;
  rows.sort((a, b) => a.trig < b.trig ? -1 : a.trig > b.trig ? 1 : (a.t < b.t ? -1 : 1));

  const result = {
    asof, timeframe: '1day', agg_mult: CFG.aggMult, fresh_within: CFG.freshWithin,
    generated_at: new Date().toISOString(), provider: 'alpaca', feed: CFG.feed, adjustment: CFG.adjustment,
    fundamentals: FINNHUB_KEY ? 'finnhub' : 'none',
    universe: syms.length, scanned, fired: Object.keys(meta).length,
    trigger_types: TRIGGER_TYPES, counts, rows, meta,
  };
  fs.writeFileSync(CFG.out, JSON.stringify(result, null, 1));
  console.error(`Done — ${rows.length} fresh triggers across ${Object.keys(meta).length} counters (of ${scanned} scanned, asof ${asof}). Wrote ${CFG.out}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { loadEngine, detectFresh, seriesFromAlpaca, fetchUniverse, fetchBars, addFundamentals };
