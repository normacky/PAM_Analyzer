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
 *
 * NEW — options enrichment (runs AFTER the market scan, on fired tickers only):
 *   pulls each fired ticker's option chain from Alpaca's free "indicative" feed,
 *   pre-computes the four vertical spreads (Bull Put / Bear Call credit spreads,
 *   Bull Call / Bear Put debit spreads) per the Options Master Ruleset, flags every
 *   precondition as met/not-met WITHOUT filtering anything, and appends each
 *   ticker's ATM IV to iv_history.json (the IV history accumulator).
 *   PAM_OPT             set to 0 to disable the options step entirely
 *   PAM_OPT_DTE_MIN/MAX expiry window in days              (default 30 / 45)
 *   PAM_IV_HIGH         absolute ATM IV "high" threshold   (default 0.35)
 *   PAM_IV_LOW          absolute ATM IV "low" threshold    (default 0.30)
 *   PAM_OPT_SPREAD_MAX  max per-leg bid/ask spread in $    (default 0.50)
 *   PAM_OPT_MIN_MC      market-cap floor for enrichment    (default 2e9 = $2bn)
 *   PAM_IV_HIST         IV history file                    (default iv_history.json)
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
  adxPeriod:   parseInt(process.env.PAM_ADX_PERIOD || '14', 10),  // Wilder ADX lookback (standard 14). Low ADX = rangebound (Iron Condor gate); high = trending.
  batch:       parseInt(process.env.PAM_BATCH    || '100', 10), // symbols per request
  reqPerMin:   parseInt(process.env.PAM_RPM      || '180', 10), // stay under Alpaca's 200/min
  feed:        process.env.PAM_FEED     || 'sip',               // EOD free tier = delayed SIP
  adjustment:  process.env.PAM_ADJ      || 'split',
  exchanges:  (process.env.PAM_EXCH || 'NYSE,NASDAQ,ARCA,AMEX,BATS').split(','),
  limit:       parseInt(process.env.PAM_LIMIT    || '0', 10),   // 0 = whole market
  fundGapMs:   parseInt(process.env.FUND_GAP_MS  || '1100', 10),  // pause between fundamentals calls (~55/min, under Finnhub's 60/min)
  fundTimeout: parseInt(process.env.FUND_TIMEOUT || '15000', 10), // per-request timeout (ms)
  /* ---- options enrichment (vertical-spread candidates for fired tickers) ---- */
  optEnable:   process.env.PAM_OPT !== '0',                        // PAM_OPT=0 turns the whole options step off
  optFeed:     process.env.PAM_OPT_FEED || 'indicative',           // Alpaca's free options feed (Basic plan)
  optDteMin:   parseInt(process.env.PAM_OPT_DTE_MIN || '30', 10),  // ruleset: credit verticals 30-45 DTE
  optDteMax:   parseInt(process.env.PAM_OPT_DTE_MAX || '45', 10),
  ivHigh:      parseFloat(process.env.PAM_IV_HIGH  || '0.35'),     // per Kam's call: ABSOLUTE ATM IV > 35% = "high IV" (credit side favoured)
  ivLow:       parseFloat(process.env.PAM_IV_LOW   || '0.30'),     // ruleset: buy premium when IV < 30 (debit side favoured)
  optSpreadMax:parseFloat(process.env.PAM_OPT_SPREAD_MAX || '0.50'),// ruleset liquidity: per-leg bid/ask spread <= $0.40-0.50 — using the loose end
  optMinMc:    parseFloat(process.env.PAM_OPT_MIN_MC || '2e9'),    // only enrich fired tickers with market cap >= this (USD). Keeps runtime sane —
                                                                   // thousands fire daily but most are optionless small caps. Tickers below the floor
                                                                   // still appear in the trigger list; they just skip the options step.
  ivHistFile:  process.env.PAM_IV_HIST || 'iv_history.json',       // the IV history accumulator file (committed back to the repo)
  ivHistKeep:  parseInt(process.env.PAM_IV_HIST_KEEP || '300', 10),// keep up to ~300 daily IV readings per symbol (~14 months)
  /* ---- market-cap enrichment cache + daily split adjustment ---- */
  fundCacheFile:     process.env.PAM_FUND_CACHE       || 'enrichment_cache.json', // shares-outstanding + industry cache, committed back to the repo
  fundCacheDays:     parseInt(process.env.PAM_FUND_CACHE_DAYS || '30', 10),       // re-pull a ticker from Finnhub only when its cached snapshot is older than this
  splitLookbackDays: parseInt(process.env.PAM_SPLIT_LOOKBACK   || '40', 10),      // how far back to ask Alpaca for splits each run — MUST exceed fundCacheDays so no split is missed within a cache cycle
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

/* ---- 4b. market cap + industry for the fired tickers (cached; split-adjusted daily) ----
 * Market cap = shares-outstanding x latest close. Only the price half moves daily, and the
 * scanner already holds the split-adjusted latest close in meta[t].px, so we cache the slow
 * half (shares-outstanding + industry) from Finnhub and recompute cap fresh every run.
 *
 *   - The cache (enrichment_cache.json, committed back to the repo) stores, per ticker:
 *       { shares, industry, name, ts }  where ts = the day Finnhub was last asked.
 *   - A ticker is re-pulled from Finnhub ONLY when it is missing from the cache or its ts is
 *     older than cfg.fundCacheDays (default 30). A normal daily run therefore calls Finnhub only
 *     for names that fired for the first time in the last month; the old ~55/min crawl is gone.
 *   - Splits are the one thing that cannot wait a month: a 4-for-1 (e.g. CRWD, ex-date
 *     2026-07-02) quarters the price the same day, so cached pre-split shares would read a
 *     quarter of the true cap. Every run we ask Alpaca's corporate-actions endpoint for the
 *     splits in the last cfg.splitLookbackDays and multiply cached shares by new_rate/old_rate
 *     for any split whose ex-date is AFTER that ticker's snapshot (older splits are already
 *     baked into what Finnhub told us). No per-symbol Finnhub call is needed to catch them.
 *
 * Judgment calls, documented:
 *   - shares-outstanding comes from Finnhub profile2 (reported in MILLIONS). If that field is
 *     absent we derive shares from Finnhub's own market cap / today's price so cap still updates daily.
 *   - Split cut-off is strict "ex-date AFTER snapshot" (never double-counts). The only miss is a
 *     split you happen to refresh Finnhub on the very same day it goes ex, if Finnhub has not yet
 *     updated its share count that morning: that one name reads low for one day until the next run.
 *   - splitLookbackDays (40) must stay > fundCacheDays (30) so every post-snapshot split is inside the window.
 */

// whole calendar days between two 'YYYY-MM-DD' strings (b - a)
function daysBetweenISO(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
const isoDay = d => d.toISOString().slice(0, 10);

// multiply cached shares by every split whose ex-date is AFTER the cache snapshot (older splits already baked in)
function splitAdjustedShares(cachedShares, cacheTs, splitList) {
  let m = 1;
  for (const sp of (splitList || [])) if (!cacheTs || sp.ex > cacheTs) m *= sp.mult;
  return cachedShares * m;
}

// Alpaca corporate-actions -> { SYM: [ { ex:'YYYY-MM-DD', mult:Number }, ... ] } for forward + reverse splits
// in [today-splitLookbackDays, today]. Queried in symbol batches (the fired set is small), so it never
// depends on a market-wide pull being allowed. Uses the same Alpaca keys as the rest of the scan.
async function fetchSplitsFor(symbols, cfg) {
  const out = {};
  if (!symbols.length) return out;
  const today = isoDay(new Date());
  const start = isoDay(new Date(Date.now() - cfg.splitLookbackDays * 86400000));
  const push = (sym, ex, mult) => {
    if (!sym || !ex || !(mult > 0) || mult === 1) return;
    (out[sym] = out[sym] || []).push({ ex: String(ex).slice(0, 10), mult });
  };
  for (let i = 0; i < symbols.length; i += 40) {              // ~40 tickers per request keeps the URL short
    const batch = symbols.slice(i, i + 40).join(',');
    let pageToken = '';
    do {
      const url = DATA_API + '/v1/corporate-actions?types=forward_split,reverse_split'
        + '&symbols=' + encodeURIComponent(batch)
        + '&start=' + start + '&end=' + today + '&limit=1000'
        + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
      let j;
      try { j = await alpacaGet(url); }
      catch (e) { console.error('  corporate-actions lookup failed (' + e.message + ') - cap uses un-split-adjusted shares this run.'); return out; }
      const ca = (j && j.corporate_actions) || {};
      for (const s of (ca.forward_splits || [])) push(s.symbol, s.ex_date || s.process_date, (+s.new_rate) / (+s.old_rate));
      for (const s of (ca.reverse_splits || [])) push(s.symbol, s.ex_date || s.process_date, (+s.new_rate) / (+s.old_rate));
      pageToken = (j && j.next_page_token) || '';
    } while (pageToken);
  }
  return out;
}

async function addFundamentals(meta, cfg) {
  const tickers = Object.keys(meta);
  if (!tickers.length) return;
  const today = isoDay(new Date());

  // load the shares/industry cache (committed back to the repo; empty {} on the first ever run)
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cfg.fundCacheFile, 'utf8')) || {}; } catch (e) { cache = {}; }

  // catch splits for every fired ticker in one batched sweep (cheap, no Finnhub involved)
  const splits = await fetchSplitsFor(tickers, cfg);

  // which fired tickers need a fresh Finnhub pull? (missing, or snapshot older than fundCacheDays)
  const stale = t => !cache[t] || cache[t].shares == null || !cache[t].ts || daysBetweenISO(cache[t].ts, today) >= cfg.fundCacheDays;
  const toPull = FINNHUB_KEY ? tickers.filter(stale) : [];
  if (!FINNHUB_KEY) console.error("No FINNHUB_KEY set - using cached shares/industry only (cap still recomputed from cached shares x today's price).");

  if (toPull.length) {
    const mins = Math.ceil(toPull.length * cfg.fundGapMs / 60000);
    console.error(`Finnhub refresh for ${toPull.length} of ${tickers.length} fired counters (the rest are cached) - ~${mins} min at ~${Math.round(60000 / cfg.fundGapMs)}/min...`);
  } else if (FINNHUB_KEY) {
    console.error(`All ${tickers.length} fired counters served from cache - no Finnhub calls this run.`);
  }

  let pulled = 0, err = 0;
  for (let i = 0; i < toPull.length; i++) {
    const t = toPull[i];
    try {
      const r = await fetch('https://finnhub.io/api/v1/stock/profile2?symbol=' + encodeURIComponent(t) + '&token=' + FINNHUB_KEY,
        { signal: AbortSignal.timeout(cfg.fundTimeout) });
      if (r.status === 429) { await sleep(2000); err++; }         // throttled - leave cache as-is, retry next run
      else if (!r.ok) { if (err < 8) console.error('  Finnhub ' + r.status + ' on ' + t); err++; }
      else {
        const p = await r.json();
        if (p) {
          // shareOutstanding is in MILLIONS of shares -> actual count. Fall back to deriving it from
          // Finnhub's own market cap / today's price when the share-count field is absent.
          const shares = (p.shareOutstanding != null) ? p.shareOutstanding * 1e6
                       : (p.marketCapitalization != null && meta[t].px > 0) ? (p.marketCapitalization * 1e6) / meta[t].px
                       : null;
          const entry = cache[t] || {};
          if (shares != null) entry.shares = shares;
          if (p.finnhubIndustry) entry.industry = p.finnhubIndustry;
          if (p.name) entry.name = p.name;
          entry.ts = today;                                        // snapshot date - anchors the 30-day refresh AND the split cut-off
          cache[t] = entry;
          pulled++;
        }
      }
    } catch (e) { if (err < 8) console.error('  Finnhub error on ' + t + ': ' + e.message); err++; }
    await sleep(cfg.fundGapMs);
    if (i % 100 === 0) process.stderr.write(`  fundamentals ${i}/${toPull.length}\r`);
  }
  if (toPull.length) process.stderr.write('\n');

  // fold cache + daily split adjustment into meta: cap = (split-adjusted cached shares) x latest close
  let priced = 0, splitAdj = 0, unknown = 0;
  for (const t of tickers) {
    const c = cache[t];
    if (c && c.industry) meta[t].industry = c.industry;
    if (c && !meta[t].name && c.name) meta[t].name = c.name;
    if (!c || c.shares == null) { unknown++; continue; }          // no share count yet -> leave mc undefined (unchanged behaviour)
    const shares = splitAdjustedShares(c.shares, c.ts, splits[t]);
    if (shares !== c.shares) splitAdj++;
    if (meta[t].px > 0) { meta[t].mc = shares * meta[t].px; priced++; } else unknown++;
  }

  try { fs.writeFileSync(cfg.fundCacheFile, JSON.stringify(cache, null, 0)); }
  catch (e) { console.error('  could not write ' + cfg.fundCacheFile + ': ' + e.message); }
  console.error(`Fundamentals: ${priced} priced (${splitAdj} split-adjusted), ${pulled} freshly pulled, ${err} misses, ${unknown} without a share count, of ${tickers.length} counters.`);
}

/* ---- 4c. options enrichment — vertical-spread candidates for FIRED tickers only ----
 * For every ticker that fired a trigger (any timeframe) this pulls its option chain
 * from Alpaca's free "indicative" feed and pre-computes the four vertical spreads
 * from the Options Master Ruleset (Cards 17-20):
 *   bps       Bull Put Spread   (credit, bullish)  short put  ~0.20-0.25 delta, long 1 strike below
 *   bcs       Bear Call Spread  (credit, bearish)  short call ~0.20-0.25 delta, long 1 strike above
 *   bull_call Bull Call Spread  (debit,  bullish)  long call  ~0.50-0.60 delta, short at +1SD (and >= $5 above long, per the card)
 *   bear_put  Bear Put Spread   (debit,  bearish)  long put   ~0.50-0.60 delta, short at -1SD
 * NOTHING IS FILTERED OUT. Every ruleset precondition is reported as a met/not-met
 * flag (IV level, earnings inside expiry, per-leg liquidity, max-loss<=4x-credit,
 * R:R>=1:2, SPY regime) and the go/no-go decision stays with the trader.
 *
 * Judgment calls, documented:
 *   - EVERY expiry inside the 30-45 DTE window is evaluated (the chain pull already covers
 *     the whole window in one request, so this costs no extra API calls). Each strategy
 *     independently keeps its best candidate — the Bull Put Spread can sit on the 31-DTE
 *     expiry while the Bull Call Spread sits on the 38-DTE one.
 *   - Ranking, per strategy (best first):
 *       credit verticals  most ruleset checks passed (max-loss<=4x credit, per-leg liquidity,
 *                         no earnings inside THAT expiry) → highest credit/max-loss (ROI)
 *                         → nearest 37 DTE. Cards 19/20 allow the whole 30-45 range.
 *       debit verticals   most checks passed (R:R>=1:2, liquidity) → nearest 30 DTE
 *                         (Cards 17/18: "~30 days ideal") → highest max-profit/debit.
 *       iron condor       most checks passed (credit>=$0.90/side, liquidity, no earnings
 *                         inside) → highest credit/max-loss → nearest 37 DTE (Card 8: 30-45).
 *     Highlight-not-filter still holds: if no expiry passes everything, the least-bad
 *     candidate is reported with its flags and the decision stays with the trader.
 *     Degenerate quotes are the one exception (credit >= width, or debit <= 0) — those are
 *     arithmetic impossibilities from junk mid prices and are dropped.
 *   - Earnings stays ONE Finnhub call per symbol (today → last expiry in the window);
 *     "inside" is decided per expiry locally, so a shorter expiry that dodges a late-window
 *     earnings date now outranks one that sits on top of it (credit cards: "Earnings not
 *     within Expiration date").
 *   - If the 30-45 window has no contracts at all, it widens once to 25-60 and flags dte_off_window.
 *   - Strike query is bounded to spot ±35% to keep the chain pull to one page for most names.
 *   - "Long leg 1-2 strikes further OTM" (credit cards) → implemented as the ADJACENT strike (1 strike).
 *   - Legs are priced at the MID (bid+ask)/2 — the standard broker mark; the per-leg
 *     liquidity flag remains the warning that a wide market makes the mid hard to fill.
 *   - ATM IV is computed PER EXPIRY (call+put IV averaged at the strike nearest spot); the
 *     1SD debit-spread target = spot × that expiry's ATM-IV × sqrt(its DTE/365). The
 *     symbol-level ATM IV (flags + iv_history.json) stays anchored to the expiry nearest
 *     37 DTE, so the accumulated IV time series is unaffected by this change.
 */

// OCC option symbol → { expiry:'YYYY-MM-DD', type:'C'|'P', strike:Number } (e.g. AAPL240315C00172500)
function parseOcc(occ, underlying) {
  const rest = occ.slice(underlying.length);
  const m = /^(\d{6})([CP])(\d{8})$/.exec(rest);
  if (!m) return null;
  return { expiry: '20' + m[1].slice(0, 2) + '-' + m[1].slice(2, 4) + '-' + m[1].slice(4, 6),
           type: m[2], strike: parseInt(m[3], 10) / 1000 };
}

async function fetchOptionChain(sym, spot, cfg, dteMin, dteMax) {
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const contracts = [];
  let pageToken = null;
  do {
    const u = new URL(DATA_API + '/v1beta1/options/snapshots/' + encodeURIComponent(sym));
    u.searchParams.set('feed', cfg.optFeed);
    u.searchParams.set('limit', '1000');
    u.searchParams.set('expiration_date_gte', d(dteMin));
    u.searchParams.set('expiration_date_lte', d(dteMax));
    u.searchParams.set('strike_price_gte', (spot * 0.65).toFixed(2));
    u.searchParams.set('strike_price_lte', (spot * 1.35).toFixed(2));
    if (pageToken) u.searchParams.set('page_token', pageToken);
    const j = await alpacaGet(u.toString());
    const snaps = j.snapshots || {};
    for (const occ in snaps) {
      const p = parseOcc(occ, sym); if (!p) continue;
      const s = snaps[occ] || {};
      contracts.push({
        expiry: p.expiry, type: p.type, k: p.strike,
        bid: s.latestQuote && s.latestQuote.bp != null ? s.latestQuote.bp : null,
        ask: s.latestQuote && s.latestQuote.ap != null ? s.latestQuote.ap : null,
        delta: s.greeks && s.greeks.delta != null ? s.greeks.delta : null,
        iv: s.impliedVolatility != null ? s.impliedVolatility : null,
      });
    }
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return contracts;
}

// group the pulled contracts by expiry → [{ expiry, dte, calls, puts, atmIV }], sorted nearest-first.
// Every group is a full mini-chain, so every expiry in the window can be evaluated independently.
function groupExpiries(contracts, spot) {
  const today = new Date().toISOString().slice(0, 10);
  const dteOf = exp => Math.round((new Date(exp) - new Date(today)) / 86400000);
  const by = {};
  for (const c of contracts) (by[c.expiry] = by[c.expiry] || []).push(c);
  return Object.keys(by).sort().map(expiry => {
    const inExp = by[expiry];
    const calls = inExp.filter(c => c.type === 'C').sort((a, b) => a.k - b.k);
    const puts  = inExp.filter(c => c.type === 'P').sort((a, b) => a.k - b.k);
    return { expiry, dte: dteOf(expiry), calls, puts, atmIV: atmIvOf(calls, puts, spot) };
  });
}
// the "anchor" expiry = nearest 37 DTE (mid-window). Used for the symbol-level ATM IV,
// the IV-history record, and the symbol-level flags — same choice the old single-expiry
// picker made, so the accumulated IV series stays continuous.
const anchorGroup = groups => groups.length
  ? groups.reduce((a, g) => Math.abs(g.dte - 37) < Math.abs(a.dte - 37) ? g : a)
  : null;

const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const legLiquid = (leg, maxSpread) => leg && leg.bid != null && leg.ask != null && leg.bid > 0 && (leg.ask - leg.bid) <= maxSpread;
// per-leg MID price — matches the broker mark (e.g. the ToS order ticket). Judgment call CHANGED from
// touch pricing after a live DIS check: on wide chains the touch produced a negative "credit" (sell at
// bid, buy at ask) while ToS showed +$0.20 at the mid. Mid is the standard mark for evaluating spreads;
// the per-leg liquidity flag stays as the warning that a wide market makes the mid hard to fill.
const legMid = c => (c && c.bid != null && c.ask != null && c.ask > 0) ? (c.bid + c.ask) / 2 : null;

// contract whose delta is closest to `target` (must land within ±0.10 of it)
function byDelta(list, target) {
  let best = null, bestD = 0.10;
  for (const c of list) {
    if (c.delta == null) continue;
    const d = Math.abs(c.delta - target);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// ATM IV = mean of call+put IV at the strike nearest spot
function atmIvOf(calls, puts, spot) {
  const nearest = list => list.reduce((a, c) => (a == null || Math.abs(c.k - spot) < Math.abs(a.k - spot)) ? c : a, null);
  const ivs = [nearest(calls), nearest(puts)].filter(c => c && c.iv != null).map(c => c.iv);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
}

// builds the five strategies on ONE expiry's mini-chain (unchanged math from the old
// single-expiry version) — bestSpreads() below runs this per expiry and keeps the winners.
function buildSpreadsForExpiry(spot, atmIV, dte, calls, puts, cfg) {
  const S = {};
  const oneSD = atmIV != null ? spot * atmIV * Math.sqrt(Math.max(dte, 1) / 365) : null;

  // ---- Bull Put Spread (credit): sell put 0.20-0.25 delta, buy the adjacent strike below
  {
    const sp = byDelta(puts, -0.225);
    const below = sp ? puts.filter(p => p.k < sp.k) : [];
    const lp = below.length ? below[below.length - 1] : null;   // adjacent strike below
    const msP = legMid(sp), mlP = legMid(lp);
    if (sp && lp && msP != null && mlP != null) {
      const credit = r2(msP - mlP), width = r2(sp.k - lp.k), maxLoss = r2(width - credit);
      S.bps = { short_k: sp.k, long_k: lp.k, short_delta: r2(sp.delta), credit, width, max_loss: maxLoss,
                breakeven: r2(sp.k - credit),
                ok: { credit_4x: credit > 0 && maxLoss <= 4 * credit,
                      liquidity: legLiquid(sp, cfg.optSpreadMax) && legLiquid(lp, cfg.optSpreadMax) } };
    }
  }
  // ---- Bear Call Spread (credit): sell call 0.20-0.25 delta, buy the adjacent strike above
  {
    const sc = byDelta(calls, 0.225);
    const above = sc ? calls.filter(c => c.k > sc.k) : [];
    const lc = above.length ? above[0] : null;                  // adjacent strike above
    const msC = legMid(sc), mlC = legMid(lc);
    if (sc && lc && msC != null && mlC != null) {
      const credit = r2(msC - mlC), width = r2(lc.k - sc.k), maxLoss = r2(width - credit);
      S.bcs = { short_k: sc.k, long_k: lc.k, short_delta: r2(sc.delta), credit, width, max_loss: maxLoss,
                breakeven: r2(sc.k + credit),
                ok: { credit_4x: credit > 0 && maxLoss <= 4 * credit,
                      liquidity: legLiquid(sc, cfg.optSpreadMax) && legLiquid(lc, cfg.optSpreadMax) } };
    }
  }
  // ---- Bull Call Spread (debit): buy call 0.50-0.60 delta; short at the +1SD target, and >= $5 above the long (per Card 17)
  if (oneSD != null) {
    const lc = byDelta(calls, 0.55);
    if (lc) {
      const target = spot + oneSD, minK = lc.k + 5;
      const cands = calls.filter(c => c.k >= minK);
      const sc = cands.length ? cands.reduce((a, c) => Math.abs(c.k - target) < Math.abs(a.k - target) ? c : a) : null;
      const mLong = legMid(lc), mShort = legMid(sc);
      if (sc && mLong != null && mShort != null) {
        const debit = r2(mLong - mShort), width = r2(sc.k - lc.k), maxProfit = r2(width - debit);
        S.bull_call = { long_k: lc.k, short_k: sc.k, long_delta: r2(lc.delta), debit, width, max_profit: maxProfit,
                        breakeven: r2(lc.k + debit),
                        ok: { rr_1to2: debit > 0 && maxProfit >= 2 * debit,
                              liquidity: legLiquid(lc, cfg.optSpreadMax) && legLiquid(sc, cfg.optSpreadMax) } };
      }
    }
  }
  // ---- Bear Put Spread (debit): buy put 0.50-0.60 delta; short at the -1SD target (no $5 rule on the card — nearest strike below the long)
  if (oneSD != null) {
    const lp = byDelta(puts, -0.55);
    if (lp) {
      const target = spot - oneSD;
      const cands = puts.filter(p => p.k < lp.k);
      const sp = cands.length ? cands.reduce((a, p) => Math.abs(p.k - target) < Math.abs(a.k - target) ? p : a) : null;
      const mLongP = legMid(lp), mShortP = legMid(sp);
      if (sp && mLongP != null && mShortP != null) {
        const debit = r2(mLongP - mShortP), width = r2(lp.k - sp.k), maxProfit = r2(width - debit);
        S.bear_put = { long_k: lp.k, short_k: sp.k, long_delta: r2(lp.delta), debit, width, max_profit: maxProfit,
                       breakeven: r2(lp.k - debit),
                       ok: { rr_1to2: debit > 0 && maxProfit >= 2 * debit,
                             liquidity: legLiquid(lp, cfg.optSpreadMax) && legLiquid(sp, cfg.optSpreadMax) } };
      }
    }
  }
  // ---- Short Iron Condor (Card 8): Bull Put Spread + Bear Call Spread sold together, same expiry.
  // Card parameters differ from the single credit spreads: short strikes at 0.23-0.28 delta
  // (target 0.255 here), wings $5 beyond each short strike (implemented as the strike nearest
  // to $5 beyond — documented judgment for chains without exact $5 spacing), credit >= $0.90
  // PER SIDE as the quality bar, max loss = wider wing - total credit, two breakevens.
  // Neutral strategy — computed for every ticker regardless of trigger direction.
  {
    const sp = byDelta(puts, -0.255), sc = byDelta(calls, 0.255);
    if (sp && sc && sc.k > sp.k) {
      const pWing = puts.filter(p => p.k < sp.k);
      const cWing = calls.filter(c => c.k > sc.k);
      const lp = pWing.length ? pWing.reduce((a, p) => Math.abs(p.k - (sp.k - 5)) < Math.abs(a.k - (sp.k - 5)) ? p : a) : null;
      const lc = cWing.length ? cWing.reduce((a, c) => Math.abs(c.k - (sc.k + 5)) < Math.abs(a.k - (sc.k + 5)) ? c : a) : null;
      const mSp = legMid(sp), mLp = legMid(lp), mSc = legMid(sc), mLc = legMid(lc);
      if (lp && lc && mSp != null && mLp != null && mSc != null && mLc != null) {
        const putCredit = r2(mSp - mLp), callCredit = r2(mSc - mLc), credit = r2(putCredit + callCredit);
        const widthPut = r2(sp.k - lp.k), widthCall = r2(lc.k - sc.k);
        const maxLoss = r2(Math.max(widthPut, widthCall) - credit);
        S.condor = { put_short_k: sp.k, put_long_k: lp.k, call_short_k: sc.k, call_long_k: lc.k,
                     short_put_delta: r2(sp.delta), short_call_delta: r2(sc.delta),
                     put_credit: putCredit, call_credit: callCredit, credit,
                     width_put: widthPut, width_call: widthCall, max_loss: maxLoss,
                     be_low: r2(sp.k - credit), be_high: r2(sc.k + credit),
                     ok: { credit_each: putCredit >= 0.90 && callCredit >= 0.90,   // Card 8: >= $0.90-1.00 each side
                           liquidity: legLiquid(sp, cfg.optSpreadMax) && legLiquid(lp, cfg.optSpreadMax) &&
                                      legLiquid(sc, cfg.optSpreadMax) && legLiquid(lc, cfg.optSpreadMax) } };
      }
    }
  }
  return S;
}

/* Evaluate every expiry in the window and keep, per strategy, the best candidate.
 * groups = groupExpiries() output; earn = earningsNext() result (null = could not check,
 * { date } = next earnings date between today and the window end, date null = none found).
 * Each winning spread carries its own expiry/dte, and credit spreads + condor carry
 * earnings_inside for THEIR expiry (a 31-DTE expiry can dodge a day-40 earnings report). */
function bestSpreads(spot, groups, earn, cfg) {
  const passes = arr => arr.reduce((n, f) => n + (f === true ? 1 : 0), 0);
  const cand = { bps: [], bcs: [], bull_call: [], bear_put: [], condor: [] };
  for (const g of groups) {
    const S = buildSpreadsForExpiry(spot, g.atmIV, g.dte, g.calls, g.puts, cfg);
    const ei = earn ? (earn.date != null && earn.date <= g.expiry) : null;   // earnings inside THIS expiry
    for (const k in S) {
      const sp = S[k];
      sp.expiry = g.expiry; sp.dte = g.dte;
      if (k === 'bps' || k === 'bcs' || k === 'condor') sp.earnings_inside = ei;
      cand[k].push(sp);
    }
  }
  // sort helper: highest score first, then two tie-breakers (each returns <0 when a should rank first)
  const best = (list, score, tie1, tie2) => {
    if (!list.length) return undefined;
    list.sort((a, b) => (score(b) - score(a)) || tie1(a, b) || tie2(a, b));
    return list[0];
  };
  const out = {};
  // credit verticals — checks passed → ROI (credit/max-loss, the card's own yardstick) → nearest 37 DTE
  for (const k of ['bps', 'bcs']) {
    const usable = cand[k].filter(sp => sp.max_loss > 0);            // credit >= width = junk quote data, drop
    const b = best(usable,
      sp => passes([sp.ok.credit_4x, sp.ok.liquidity, sp.earnings_inside === false]),
      (a, b2) => (b2.credit / b2.max_loss) - (a.credit / a.max_loss),
      (a, b2) => Math.abs(a.dte - 37) - Math.abs(b2.dte - 37));
    if (b) out[k] = b;
  }
  // debit verticals — checks passed → nearest 30 DTE (Cards 17/18: "~30 days ideal") → max-profit/debit
  for (const k of ['bull_call', 'bear_put']) {
    const usable = cand[k].filter(sp => sp.debit > 0);               // debit <= 0 = junk quote data, drop
    const b = best(usable,
      sp => passes([sp.ok.rr_1to2, sp.ok.liquidity]),
      (a, b2) => Math.abs(a.dte - 30) - Math.abs(b2.dte - 30),
      (a, b2) => (b2.max_profit / b2.debit) - (a.max_profit / a.debit));
    if (b) out[k] = b;
  }
  // iron condor — checks passed → credit/max-loss → nearest 37 DTE (Card 8: 30-45)
  {
    const usable = cand.condor.filter(sp => sp.max_loss > 0);
    const b = best(usable,
      sp => passes([sp.ok.credit_each, sp.ok.liquidity, sp.earnings_inside === false]),
      (a, b2) => (b2.credit / b2.max_loss) - (a.credit / a.max_loss),
      (a, b2) => Math.abs(a.dte - 37) - Math.abs(b2.dte - 37));
    if (b) out.condor = b;
  }
  return out;
}

// next earnings date between today and `toISO` — ONE Finnhub call per symbol, covering the
// whole expiry window; per-expiry "inside" checks are then done locally for free.
// Returns { date: 'YYYY-MM-DD' | null }, or null if the check could not run.
async function earningsNext(sym, toISO, cfg) {
  if (!FINNHUB_KEY) return null;
  try {
    const from = new Date().toISOString().slice(0, 10);
    const r = await fetch('https://finnhub.io/api/v1/calendar/earnings?from=' + from + '&to=' + toISO +
      '&symbol=' + encodeURIComponent(sym) + '&token=' + FINNHUB_KEY, { signal: AbortSignal.timeout(cfg.fundTimeout) });
    if (!r.ok) return null;
    const j = await r.json();
    const dates = ((j && j.earningsCalendar) || []).map(e => e.date).filter(Boolean).sort();
    return { date: dates.length ? dates[0] : null };
  } catch (e) { return null; }
}

// SPY regime for the awareness flag on bearish spreads (Card 20 precondition: 50MA < 150MA)
async function fetchSpyRegime(cfg) {
  const bars = await fetchBars(['SPY'], { ...cfg, batch: 1 }, '1Day', 300);
  const closes = (bars.SPY || []).map(b => b.c);
  if (closes.length < 150) return null;
  const sma = n => closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  const s50 = sma(50), s150 = sma(150);
  return { sma50: r2(s50), sma150: r2(s150), bear: s50 < s150 };
}

/* ---- 4d. IV history accumulator ----
 * Appends each enriched ticker's ATM IV to iv_history.json (committed back to the
 * repo by the workflow) so a TRUE IV-percentile becomes computable later with zero
 * rework. Shape: { "SYM": [["YYYY-MM-DD", 0.4123], ...] }, capped at ivHistKeep
 * entries per symbol. Once a symbol has >= 60 readings, iv_pctl is reported too. */
function loadIvHistory(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { return {}; }
}
function recordIv(hist, sym, date, iv, keep) {
  const a = hist[sym] = hist[sym] || [];
  if (a.length && a[a.length - 1][0] === date) a[a.length - 1][1] = +iv.toFixed(4);  // same-day rerun → overwrite
  else a.push([date, +iv.toFixed(4)]);
  if (a.length > keep) hist[sym] = a.slice(-keep);
}
function ivPercentile(hist, sym, iv) {
  const a = (hist[sym] || []).map(e => e[1]);
  if (a.length < 60) return null;                                // not enough history yet — panel shows "building"
  return Math.round(100 * a.filter(v => v < iv).length / a.length);
}

// daily SMA-20 vs SMA-50 trend for a stock (Bull Put Spread card: stock must be in an uptrend).
// Uses the tool's own 20/50 SMAs so the pill matches what the chart draws. up = 20-SMA above 50-SMA.
// Wilder's ADX over `period` bars from daily high/low/close arrays. Returns the latest ADX value
// (0-100), or null if there aren't enough bars. This is a trend-STRENGTH gauge, direction-agnostic:
// a low reading (~below 20) means price is NOT making net directional progress = rangebound, which is
// exactly the condition the Iron Condor wants; a high reading (~above 25) means a real trend is in force.
function adxLatest(high, low, close, period) {
  period = period || 14;
  const n = close ? close.length : 0;
  if (!high || !low || n < period * 2 + 1) return null;   // need ~2 periods to warm the DI smoothing then the ADX
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];       // today's high vs yesterday's
    const dn = low[i - 1] - low[i];         // yesterday's low vs today's
    plusDM.push((up > dn && up > 0) ? up : 0);
    minusDM.push((dn > up && dn > 0) ? dn : 0);
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  // Wilder smoothing (seed = sum of the first `period`, then smooth). Using the running sums keeps the
  // +DI / -DI ratio identical to averaging, with less arithmetic.
  const smooth = arr => {
    const out = []; let s = 0;
    for (let i = 0; i < period; i++) s += arr[i];
    out.push(s);
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const pdi = trS[i] === 0 ? 0 : 100 * pS[i] / trS[i];
    const mdi = trS[i] === 0 ? 0 : 100 * mS[i] / trS[i];
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }
  if (dx.length < period) return null;
  // ADX = Wilder average of DX: seed with the mean of the first `period` DX values, then smooth.
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dx[i];
  adx /= period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return Math.round(adx * 10) / 10;
}

function dailySmaTrend(closes) {
  if (!closes || closes.length < 50) return null;
  const mean = n => { let s = 0; for (let i = closes.length - n; i < closes.length; i++) s += closes[i]; return s / n; };
  const s20 = mean(20), s50 = mean(50);
  return { sma20: Math.round(s20 * 100) / 100, sma50: Math.round(s50 * 100) / 100, up: s20 > s50 };
}

async function enrichOptions(meta, cfg, stockTrend) {
  stockTrend = stockTrend || {};
  if (!cfg.optEnable) { console.error('Options enrichment disabled (PAM_OPT=0).'); return null; }
  // Market-cap gate: only enrich fired tickers at/above the floor (default $2bn, PAM_OPT_MIN_MC).
  // Judgment call: tickers with UNKNOWN market cap (Finnhub miss / no key) are skipped too —
  // they are overwhelmingly tiny or optionless names, and each would still burn an API call.
  const all = Object.keys(meta);
  const syms = all.filter(s => (meta[s].mc || 0) >= cfg.optMinMc).sort();
  const skipped = all.length - syms.length;
  if (skipped) console.error(`Options enrichment: skipping ${skipped} fired tickers below the $${(cfg.optMinMc / 1e9).toFixed(1)}bn market-cap floor (PAM_OPT_MIN_MC).`);
  if (!syms.length) return null;
  const hist = loadIvHistory(cfg.ivHistFile);
  let spy = null;
  try { spy = await fetchSpyRegime(cfg); } catch (e) { console.error('SPY regime lookup failed: ' + e.message); }
  const gap = Math.ceil(60000 / cfg.reqPerMin);
  const today = new Date().toISOString().slice(0, 10);
  const out = { iv_high_threshold: cfg.ivHigh, iv_low_threshold: cfg.ivLow, leg_spread_max: cfg.optSpreadMax,
                dte_window: [cfg.optDteMin, cfg.optDteMax], spy, symbols: {} };
  const est = Math.ceil(syms.length * (gap + (FINNHUB_KEY ? cfg.fundGapMs : 0)) / 60000);
  console.error(`Options enrichment: ${syms.length} fired tickers (~${est} min)…`);
  let done = 0, withOpts = 0;
  for (const sym of syms) {
    const spot = meta[sym].px;
    let contracts = [];
    try { contracts = await fetchOptionChain(sym, spot, cfg, cfg.optDteMin, cfg.optDteMax); }
    catch (e) { out.symbols[sym] = { has_options: false, error: e.message.slice(0, 80) }; done++; await sleep(gap); continue; }
    await sleep(gap);
    let dteOff = false;
    if (!contracts.length) {   // thin chain — widen the window once (25-60 DTE) before giving up
      try { contracts = await fetchOptionChain(sym, spot, cfg, 25, 60); dteOff = true; } catch (e) {}
      await sleep(gap);
    }
    const groups = contracts.length ? groupExpiries(contracts, spot) : [];
    if (!groups.length) { out.symbols[sym] = { has_options: false }; done++; continue; }
    const anchor = anchorGroup(groups);                                       // expiry nearest 37 DTE — symbol-level IV/flags only
    const atmIV = anchor.atmIV;
    const earn = await earningsNext(sym, groups[groups.length - 1].expiry, cfg);   // one call covers the WHOLE window
    if (FINNHUB_KEY) await sleep(cfg.fundGapMs);
    if (atmIV != null) recordIv(hist, sym, today, atmIV, cfg.ivHistKeep);
    out.symbols[sym] = {
      has_options: true, px: spot, expiry: anchor.expiry, dte: anchor.dte, dte_off_window: dteOff || undefined,
      expiries: groups.map(g => [g.expiry, g.dte]),                 // every expiry evaluated this run (panel shows the window)
      atm_iv: atmIV != null ? +atmIV.toFixed(4) : null,
      iv_pctl: atmIV != null ? ivPercentile(hist, sym, atmIV) : null,
      iv_obs: (hist[sym] || []).length,
      flags: {
        iv_high: atmIV != null ? atmIV > cfg.ivHigh : null,       // met → credit spreads (BPS/BCS) favoured
        iv_low:  atmIV != null ? atmIV < cfg.ivLow  : null,       // met → debit spreads (Bull Call/Bear Put) favoured
        earnings_inside: earn ? (earn.date != null && earn.date <= anchor.expiry) : null,   // vs the ANCHOR expiry (back-compat); each credit spread carries its own per-expiry value
        earnings_date:   earn ? earn.date   : null,               // next earnings between today and the window end (null = none found)
        mc_20b: (meta[sym].mc || 0) >= 2e10,                      // credit cards' "ideally large cap > $20bn" — informational
        spy_bear: spy ? spy.bear : null,                          // market-regime flag: S&P 500 50MA<150MA (BPS card's "S&P in a bull market" check)
        stock_sma20: (stockTrend[sym] || {}).sma20 != null ? stockTrend[sym].sma20 : null,   // stock's own daily SMAs (tool's 20/50)
        stock_sma50: (stockTrend[sym] || {}).sma50 != null ? stockTrend[sym].sma50 : null,
        stock_trend_up: (stockTrend[sym] || {}).up != null ? stockTrend[sym].up : null,       // met (up) = daily 20-SMA > 50-SMA — BPS card's "stock in an uptrend"
        stock_adx: (stockTrend[sym] || {}).adx != null ? stockTrend[sym].adx : null,          // Wilder ADX(14): < ~20 = rangebound (Iron Condor gate); > ~25 = trending
      },
      spreads: bestSpreads(spot, groups, earn, cfg),
    };
    withOpts++; done++;
    if (done % 25 === 0) process.stderr.write(`  options ${done}/${syms.length}\r`);
  }
  process.stderr.write('\n');
  try { fs.writeFileSync(cfg.ivHistFile, JSON.stringify(hist)); } catch (e) { console.error('Could not write ' + cfg.ivHistFile + ': ' + e.message); }
  console.error(`Options enrichment done: ${withOpts}/${syms.length} tickers had usable chains. IV history → ${cfg.ivHistFile}`);
  return out;
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
  const stockTrend = {};   // sym -> { sma20, sma50, up } daily trend, computed in Phase 1, consumed by the options enrichment

  /* ---- Phase 1: one DAILY pull feeds BOTH the 1-Day and 2-Day scans ---- */
  console.error(`Universe: ${syms.length} symbols. Phase 1/2 — pulling daily bars (~${CFG.dailyDays} calendar days) for the 1-Day + 2-Day timeframes…`);
  let daily = await fetchBars(syms, CFG, '1Day', CFG.dailyDays);
  for (const sym of syms) {
    const arr = daily[sym];
    if (arr && arr.length >= 60) {
      const series = seriesFromAlpaca(arr);
      stockTrend[sym] = dailySmaTrend(series.close);   // stock's daily 20/50 SMA trend for the options card's stock-uptrend check
      stockTrend[sym].adx = adxLatest(series.high, series.low, series.close, CFG.adxPeriod);   // trend strength for the Iron Condor's rangebound gate
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

  // options enrichment: vertical-spread candidates + IV flags for every fired ticker (PAM_OPT=0 to skip)
  let opt = null;
  try { opt = await enrichOptions(meta, CFG, stockTrend); }
  catch (e) { console.error('Options enrichment failed (scan results are still complete): ' + e.message); }

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
    // ---- NEW: options block — vertical-spread candidates keyed by ticker; the panel ignores unknown keys, so this is back-compatible ----
    opt,
  };
  fs.writeFileSync(CFG.out, JSON.stringify(result, null, 1));
  const r1 = acc['1'].rows.length, r2 = acc['2'].rows.length, rw = acc['W'].rows.length;
  console.error(`Done — ${r1 + r2 + rw} fresh triggers (1d:${r1}  2d:${r2}  wk:${rw}) across ${Object.keys(meta).length} counters. Wrote ${CFG.out}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { loadEngine, detectFresh, seriesFromAlpaca, fetchUniverse, fetchBars, addFundamentals, splitAdjustedShares, fetchSplitsFor, daysBetweenISO,
                   parseOcc, groupExpiries, anchorGroup, byDelta, atmIvOf, buildSpreadsForExpiry, bestSpreads, earningsNext, fetchSpyRegime, adxLatest, dailySmaTrend,
                   loadIvHistory, recordIv, ivPercentile, enrichOptions, CFG };
