#!/usr/bin/env node
/* ============================================================================
 * breadth_backtest.js — sector "trigger breadth" history rebuild (one-off)
 *
 * WHAT IT DOES
 *   Rebuilds, for every trading day of the last N years (default 3), how many
 *   BULLISH vs BEARISH PAM + Turtle triggers fired in each SECTOR — the raw
 *   material for the sector-rotation breadth study. The nightly scan only
 *   keeps the last 2 bars, but the engine is deterministic, so running it
 *   over historical bars reproduces exactly what the scanner would have
 *   flagged on every day in the window — all under ONE engine version.
 *
 * HOW IT WORKS (nothing is re-implemented)
 *   require('./pam_scan.js') and reuse its exports:
 *     - loadEngine()        lifts the engine out of pam_analyzer.html at runtime
 *     - seriesFromAlpaca()  shapes Alpaca bars for the engine
 *     - fetchBars()         the same batched / paginated / rate-paced Alpaca pull
 *   So there is only ever ONE copy of the engine and of the data plumbing.
 *
 * UNIVERSE
 *   Every ticker in enrichment_cache.json whose Finnhub industry maps to a
 *   sector in SECTOR_OF below (~5,400 names). Tickers with no industry or
 *   'N/A' are skipped — they are the micro-caps Finnhub's free tier does not
 *   profile. Daily (1-Day) timeframe only for this study.
 *
 * OUTPUT (both committed back to the repo by the workflow)
 *   breadth_history.json  full detail: per date x sector x trigger counts,
 *                         sector sizes, the mapping used, engine version, and
 *                         daily closes for the benchmark sector ETFs (so the
 *                         analysis step needs NO further market-data access)
 *   breadth_history.csv   one row per date x sector: pam_bull, pam_bear,
 *                         tt_long, rtt_short, bull, bear, net, sector_size,
 *                         net_pct — easy to eyeball in Excel
 *
 * RUN IT (the workflow does this for you)
 *   ALPACA_KEY=xxx ALPACA_SECRET=yyy node breadth_backtest.js
 *
 * ENV KNOBS (all optional)
 *   PAM_HTML         analyzer HTML to lift the engine from (default pam_analyzer.html)
 *   PAM_LIMIT        only scan the first N tickers — use e.g. 200 for a quick
 *                    first test, then 0 (default) for the full universe
 *   BT_YEARS         years of breadth history to build      (default 3)
 *   BT_WARMUP_DAYS   extra calendar days of bars pulled BEFORE the window so
 *                    the 50-SMA / LP levels are mature by day 1 (default 420
 *                    ~ 285 trading bars); triggers inside the warm-up are
 *                    computed but NOT counted
 *   BT_CHUNK         tickers fetched + processed per memory chunk (default 500)
 *   BT_TT_ADDS       '1' = also count Turtle/reverse-Turtle pyramid adds
 *                    (units 2-4). Default: entries only (unit 1), so each
 *                    stock's move is ONE breadth vote, not four
 *   BT_ETFS          benchmark ETF list (default SPY + the 11 SPDR sectors + SMH + IGV)
 *   BT_OUT / BT_CSV  output filenames
 *
 * JUDGMENT CALLS, DOCUMENTED
 *   - Bull/bear is classified by trigger LABEL (table below), which matches
 *     the engine's own direction field; the script cross-checks the two and
 *     warns on any mismatch rather than failing.
 *   - Stocks are pulled with the scanner's exact settings (SIP feed, SPLIT
 *     adjustment) so triggers match production. The benchmark ETFs are pulled
 *     with adjustment=ALL (dividends included) because they measure RETURNS,
 *     and sector ETFs pay dividends quarterly.
 *   - The denominator for net_pct is the number of tickers actually scanned
 *     in that sector (had enough bars), which uses TODAY's listings — so the
 *     study has survivorship bias (delisted names missing). Flagged, accepted.
 * ========================================================================== */

const fs   = require('fs');
const path = require('path');
const scan = require(path.join(__dirname, 'pam_scan.js'));   // loadEngine, seriesFromAlpaca, fetchBars, CFG

/* ---- settings --------------------------------------------------------------- */
const BT = {
  htmlPath:   process.env.PAM_HTML       || 'pam_analyzer.html',
  cacheFile:  process.env.PAM_FUND_CACHE || 'enrichment_cache.json',
  outJson:    process.env.BT_OUT         || 'breadth_history.json',
  outCsv:     process.env.BT_CSV         || 'breadth_history.csv',
  years:      parseFloat(process.env.BT_YEARS       || '3'),
  warmupDays: parseInt(process.env.BT_WARMUP_DAYS   || '420', 10),
  limit:      parseInt(process.env.PAM_LIMIT        || '0',   10),
  chunk:      parseInt(process.env.BT_CHUNK         || '500', 10),
  ttAdds:     process.env.BT_TT_ADDS === '1',
  etfs:      (process.env.BT_ETFS ||
              'SPY,XLK,XLF,XLV,XLE,XLI,XLY,XLP,XLU,XLB,XLRE,XLC,SMH,IGV').split(',').map(s => s.trim()).filter(Boolean),
};

/* ---- Finnhub industry -> sector mapping (edit freely; one line per label) ----
 * Every non-'N/A' industry label currently in enrichment_cache.json is listed.
 * A label not found here is logged once and its tickers are skipped, so adding
 * future Finnhub labels is just adding a line. */
const SECTOR_OF = {
  /* Technology — Finnhub has NO "Software" label: software, hardware and IT
   * services all sit under 'Technology'. Semiconductors is its own clean
   * bucket, so semis-vs-rest-of-tech rotation IS separable. */
  'Semiconductors':                    'Semiconductors',
  'Technology':                        'Technology ex-Semis',
  /* Communication / Media */
  'Media':                             'Communication/Media',
  'Telecommunication':                 'Communication/Media',
  'Communications':                    'Communication/Media',
  /* Healthcare */
  'Biotechnology':                     'Healthcare',
  'Health Care':                       'Healthcare',
  'Pharmaceuticals':                   'Healthcare',
  'Life Sciences Tools & Services':    'Healthcare',
  /* Financials */
  'Financial Services':                'Financials',
  'Banking':                           'Financials',
  'Insurance':                         'Financials',
  /* Real Estate / Energy / Utilities */
  'Real Estate':                       'Real Estate',
  'Energy':                            'Energy',
  'Utilities':                         'Utilities',
  /* Industrials */
  'Electrical Equipment':              'Industrials',
  'Machinery':                         'Industrials',
  'Professional Services':             'Industrials',
  'Commercial Services & Supplies':    'Industrials',
  'Aerospace & Defense':               'Industrials',
  'Construction':                      'Industrials',
  'Trading Companies & Distributors':  'Industrials',
  'Road & Rail':                       'Industrials',
  'Building':                          'Industrials',
  'Marine':                            'Industrials',
  'Logistics & Transportation':        'Industrials',
  'Airlines':                          'Industrials',
  'Transportation Infrastructure':     'Industrials',
  'Industrial Conglomerates':          'Industrials',
  /* Consumer Discretionary */
  'Retail':                            'Consumer Discretionary',
  'Hotels, Restaurants & Leisure':     'Consumer Discretionary',
  'Diversified Consumer Services':     'Consumer Discretionary',
  'Textiles, Apparel & Luxury Goods':  'Consumer Discretionary',
  'Auto Components':                   'Consumer Discretionary',
  'Automobiles':                       'Consumer Discretionary',
  'Leisure Products':                  'Consumer Discretionary',
  'Distributors':                      'Consumer Discretionary',
  /* Consumer Staples */
  'Consumer products':                 'Consumer Staples',
  'Food Products':                     'Consumer Staples',
  'Beverages':                         'Consumer Staples',
  'Tobacco':                           'Consumer Staples',
  /* Materials */
  'Metals & Mining':                   'Materials',
  'Chemicals':                         'Materials',
  'Packaging':                         'Materials',
  'Paper & Forest':                    'Materials',
};

/* ---- bull / bear by trigger label (matches the engine's own direction) ------
 * Bullish:  Bull-FS, up-continuations, DOWN-reversals (reverse UP), Turtle longs
 * Bearish:  Bear-FS, down-continuations, UP-reversals (reverse DOWN), reverse-Turtle shorts */
const BULL = new Set(['Bull-FS', 'UC1', 'UC2', 'DR1', 'DR2', 'S1',  'S2']);
const BEAR = new Set(['Bear-FS', 'DC1', 'DC2', 'UR1', 'UR2', 'S1s', 'S2s']);
const PAM_TRIGS = new Set(['Bull-FS', 'UC1', 'UC2', 'DR1', 'DR2', 'Bear-FS', 'DC1', 'DC2', 'UR1', 'UR2']);

const isoDay = d => d.toISOString().slice(0, 10);

/* ---- every trigger in a ticker's WHOLE daily history ------------------------
 * Same engine calls as the scanner's detectFresh(), minus the "last 2 bars"
 * freshness filter, and Turtle adds are optional (entries only by default). */
function collectTriggers(eng, series, opts) {
  if (!series || !series.close || series.close.length < 60) return [];
  let bars;
  try { bars = eng.enrich(eng.aggregate(series, 1)); }   // 1 = daily timeframe
  catch (e) { return []; }
  if (!bars || bars.length < 2) return [];
  const rows = [];
  for (const t of eng.scan(bars)) {                      // PAM setups, full history
    rows.push({ date: t.date, trig: t.label, dir: t.dir });
  }
  for (const b of bars) {                                // Turtle long + reverse-Turtle short
    if (b.ttUnit && (opts.ttAdds || b.ttUnit === 1))
      rows.push({ date: b.date, trig: 'S' + (b.ttSys === 'S2' ? 2 : 1),       dir: 'long'  });
    if (b.rtUnit && (opts.ttAdds || b.rtUnit === 1))
      rows.push({ date: b.date, trig: 'S' + (b.rtSys === 'S2' ? 2 : 1) + 's', dir: 'short' });
  }
  return rows;
}

/* ---- orchestrate ------------------------------------------------------------ */
async function main() {
  if (!process.env.ALPACA_KEY || !process.env.ALPACA_SECRET) {
    console.error('Set ALPACA_KEY and ALPACA_SECRET in the environment first.'); process.exit(1);
  }

  /* engine + its version stamp (for the output's meta block) */
  const eng  = scan.loadEngine(BT.htmlPath);
  const html = fs.readFileSync(BT.htmlPath, 'utf8');
  const vm   = html.match(/ENGINE_VERSION\s*=\s*['"]([^'"]+)/);
  const engineVersion = vm ? vm[1] : 'unknown';
  console.error(`Engine ${engineVersion} loaded from ${BT.htmlPath}.`);

  /* universe: cache tickers whose industry maps to a sector */
  const cache = JSON.parse(fs.readFileSync(BT.cacheFile, 'utf8'));
  const sectorOfTicker = {};
  const unmapped = new Set();
  for (const t of Object.keys(cache)) {
    const ind = cache[t] && cache[t].industry;
    if (!ind || ind === 'N/A') continue;
    const sec = SECTOR_OF[ind];
    if (!sec) { unmapped.add(ind); continue; }
    sectorOfTicker[t] = sec;
  }
  if (unmapped.size) console.error('Unmapped industry labels (tickers skipped): ' + [...unmapped].join(' | '));
  let syms = Object.keys(sectorOfTicker).sort();
  if (BT.limit) syms = syms.slice(0, BT.limit);
  console.error(`Universe: ${syms.length} tickers with a sector tag (of ${Object.keys(cache).length} in ${BT.cacheFile}).`);

  /* the window: count triggers on [historyStart .. today]; pull warm-up bars before it */
  const historyEnd   = isoDay(new Date());
  const historyStart = isoDay(new Date(Date.now() - BT.years * 365.25 * 86400000));
  const fetchDays    = Math.ceil(BT.years * 365.25 + BT.warmupDays);
  console.error(`Window: ${historyStart} .. ${historyEnd}  (pulling ~${fetchDays} calendar days incl. ${BT.warmupDays}d warm-up).`);

  /* pull settings: stocks exactly like the scanner (SIP + split) */
  const pullCfg = { batch: scan.CFG.batch, reqPerMin: scan.CFG.reqPerMin, feed: scan.CFG.feed, adjustment: scan.CFG.adjustment };

  /* accumulators */
  const days = {};                 // 'YYYY-MM-DD' -> sector -> trigger -> count
  const sectorScanned  = {};       // sector -> tickers that actually had enough bars (the net_pct denominator)
  const sectorUniverse = {};       // sector -> tickers attempted
  for (const t of syms) sectorUniverse[sectorOfTicker[t]] = (sectorUniverse[sectorOfTicker[t]] || 0) + 1;
  let totalTrigs = 0, dirMismatch = 0;

  /* chunked fetch + scan (keeps memory flat on the full universe) */
  for (let i = 0; i < syms.length; i += BT.chunk) {
    const chunk = syms.slice(i, i + BT.chunk);
    console.error(`Chunk ${Math.floor(i / BT.chunk) + 1}/${Math.ceil(syms.length / BT.chunk)} — ${chunk.length} tickers…`);
    const bars = await scan.fetchBars(chunk, pullCfg, '1Day', fetchDays);
    for (const sym of chunk) {
      const arr = bars[sym];
      if (!arr || arr.length < 60) { delete bars[sym]; continue; }
      const sec = sectorOfTicker[sym];
      sectorScanned[sec] = (sectorScanned[sec] || 0) + 1;
      for (const r of collectTriggers(eng, scan.seriesFromAlpaca(arr), BT)) {
        if (r.date < historyStart) continue;                       // warm-up: computed, not counted
        const isBull = BULL.has(r.trig), isBear = BEAR.has(r.trig);
        if (!isBull && !isBear) continue;                          // unknown label — ignore quietly
        if ((isBull && r.dir === 'short') || (isBear && r.dir === 'long')) dirMismatch++;   // cross-check only
        const d = days[r.date] = days[r.date] || {};
        const s = d[sec]       = d[sec]       || {};
        s[r.trig] = (s[r.trig] || 0) + 1;
        totalTrigs++;
      }
      delete bars[sym];                                            // free as we go
    }
  }
  if (dirMismatch) console.error(`NOTE: ${dirMismatch} triggers had a label/direction mismatch (label table used).`);

  /* benchmark ETF closes over the same window — adjustment=all (dividends in),
   * because these measure returns, not price action */
  console.error(`Pulling ${BT.etfs.length} benchmark ETFs (adjustment=all)…`);
  const etfBars = await scan.fetchBars(BT.etfs, { ...pullCfg, adjustment: 'all' }, '1Day', fetchDays);
  const etf_close = {};
  for (const sym of BT.etfs) {
    etf_close[sym] = {};
    for (const b of (etfBars[sym] || [])) {
      const dt = b.t.slice(0, 10);
      if (dt >= historyStart) etf_close[sym][dt] = b.c;
    }
  }

  /* ---- write breadth_history.json ---- */
  const result = {
    meta: {
      generated_at: new Date().toISOString(), engine_version: engineVersion,
      history_start: historyStart, history_end: historyEnd, years: BT.years,
      warmup_days: BT.warmupDays, timeframe: '1day', provider: 'alpaca',
      stock_feed: pullCfg.feed, stock_adjustment: pullCfg.adjustment, etf_adjustment: 'all',
      turtle_pyramid_adds_counted: BT.ttAdds, universe: syms.length,
      total_triggers: totalTrigs,
      bull_triggers: [...BULL], bear_triggers: [...BEAR],
    },
    sector_of_industry: SECTOR_OF,
    sectors: sectorScanned,            // the net_pct denominators
    sectors_universe: sectorUniverse,  // attempted (incl. tickers with too little history)
    days,                              // date -> sector -> trigger -> count
    etf_close,                         // ETF -> date -> close (dividend-adjusted)
  };
  fs.writeFileSync(BT.outJson, JSON.stringify(result, null, 1));

  /* ---- write breadth_history.csv (one row per date x sector) ---- */
  const secNames = Object.keys(sectorScanned).sort();
  const lines = ['date,sector,pam_bull,pam_bear,tt_long,rtt_short,bull,bear,net,sector_size,net_pct'];
  for (const dt of Object.keys(days).sort()) {
    for (const sec of secNames) {
      const s = days[dt][sec]; if (!s) continue;
      let pamB = 0, pamR = 0, ttL = 0, rtS = 0;
      for (const trig in s) {
        const n = s[trig];
        if (PAM_TRIGS.has(trig)) { if (BULL.has(trig)) pamB += n; else pamR += n; }
        else                     { if (BULL.has(trig)) ttL  += n; else rtS  += n; }
      }
      const bull = pamB + ttL, bear = pamR + rtS, size = sectorScanned[sec] || 0;
      const netPct = size ? (100 * (bull - bear) / size).toFixed(2) : '0';
      lines.push([dt, JSON.stringify(sec), pamB, pamR, ttL, rtS, bull, bear, bull - bear, size, netPct].join(','));
    }
  }
  fs.writeFileSync(BT.outCsv, lines.join('\n') + '\n');

  const nDays = Object.keys(days).length;
  console.error(`Done — ${totalTrigs} triggers across ${nDays} trading days, ${secNames.length} sectors. Wrote ${BT.outJson} + ${BT.outCsv}`);
  console.error('Sector sizes (scanned): ' + secNames.map(s => `${s}:${sectorScanned[s]}`).join('  '));
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main, collectTriggers, SECTOR_OF, BULL, BEAR, BT };
