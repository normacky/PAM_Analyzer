#!/usr/bin/env node
/* ============================================================================
 * trade_audit.js — attribute every real trade to the PAM/Turtle triggers that
 *                  were (or were not) present when it was opened.
 *
 * WHY THIS EXISTS
 *   scan_results.json only goes back to the repo's first commit (2026-06-21),
 *   which covers ~30 of 212 logged trades. The engine is deterministic, so
 *   replaying it over historical Alpaca bars reproduces exactly what the
 *   scanner WOULD have printed on any earlier date — under ONE engine version.
 *   Same trick breadth_backtest.js uses, but keeping the TICKERS instead of
 *   aggregating them away into sector counts.
 *
 * HOW IT WORKS (nothing is re-implemented)
 *   require('./pam_scan.js') and reuse its exports:
 *     - loadEngine()        lifts the engine out of pam_analyzer.html at runtime
 *     - seriesFromAlpaca()  shapes Alpaca bars for the engine
 *     - fetchBars()         the same batched / paginated / rate-paced pull
 *   pam_analyzer.html is READ ONLY here. Nothing in this script moves or
 *   alters the engine extraction boundaries.
 *
 * INPUT
 *   trade_list.json — array of:
 *     { "no":175, "ticker":"DIS", "entry":"2026-06-10", "exit":"2026-07-08",
 *       "side":"long"|"short"|"neutral", "strategy":"BEAR PUT / SPREAD",
 *       "pl":542.5, "cost":3540.1 }
 *   Only ticker + entry + side are required. exit/pl/cost enable the
 *   exit-signal and P/L-split sections.
 *
 * OUTPUT (committed back by the workflow)
 *   trade_audit.json — per trade: aligned triggers before entry, opposing
 *                      triggers before entry, entry lag, the first opposing
 *                      trigger DURING the hold (the exit-signal candidate),
 *                      plus a summary block
 *   trade_audit.csv  — one row per trade, opens straight in Excel
 *
 * RUN IT (the workflow does this for you)
 *   ALPACA_KEY=xxx ALPACA_SECRET=yyy node trade_audit.js
 *
 * ENV KNOBS (all optional)
 *   PAM_HTML        analyzer HTML to lift the engine from (default pam_analyzer.html)
 *   TA_LIST         input file                             (default trade_list.json)
 *   TA_OUT / TA_CSV output filenames
 *   TA_LOOKBACK     calendar days before entry a trigger still "counts"   (default 10)
 *   TA_WARMUP_DAYS  extra calendar days of bars pulled before the earliest
 *                   entry so the 50-SMA / 55-channel / LP levels are mature
 *                   (default 420 ~ 285 trading bars)
 *   TA_TFS          timeframes to replay, comma separated  (default 1,2,W)
 *   TA_CHUNK        tickers fetched per memory chunk       (default 100)
 *
 * JUDGMENT CALLS, DOCUMENTED
 *   - "Aligned" = a trigger whose direction equals the trade's side. For
 *     side:"neutral" (calendars, condors) NOTHING is aligned and nothing is
 *     opposing; those trades are reported with their surrounding triggers
 *     listed but excluded from the supported/unsupported split, because a
 *     direction-neutral structure has no direction to agree with.
 *   - Bull/bear is read from the engine's own dir field, with the label table
 *     used only as a cross-check (mismatches are counted and warned, not
 *     failed) — same convention as breadth_backtest.js.
 *   - Bars are pulled with the scanner's exact settings (SIP feed, SPLIT
 *     adjustment) so replayed triggers match production. Prices in the tracker
 *     are NOT split-adjusted, but this script never compares prices — only
 *     dates — so a split inside a holding period cannot corrupt the match.
 *   - LOOKBACK is calendar days, not trading days, so a Monday entry can still
 *     see the prior Friday's trigger. A 10-day window spans ~7 trading bars.
 *   - SURVIVORSHIP: any ticker Alpaca no longer serves (delisted, acquired,
 *     renamed) returns no bars and is reported as "no_data", not as
 *     "no trigger". Check that list before reading the summary.
 * ========================================================================== */

const fs   = require('fs');
const path = require('path');
const scan = require(path.join(__dirname, 'pam_scan.js'));   // loadEngine, seriesFromAlpaca, fetchBars, CFG

/* ---- settings --------------------------------------------------------------- */
const TA = {
  htmlPath:   process.env.PAM_HTML        || 'pam_analyzer.html',
  listFile:   process.env.TA_LIST         || 'trade_list.json',
  outJson:    process.env.TA_OUT          || 'trade_audit.json',
  outCsv:     process.env.TA_CSV          || 'trade_audit.csv',
  lookback:   parseInt(process.env.TA_LOOKBACK     || '10',  10),
  warmupDays: parseInt(process.env.TA_WARMUP_DAYS  || '420', 10),
  chunk:      parseInt(process.env.TA_CHUNK        || '100', 10),
  tfs:       (process.env.TA_TFS || '1,2,W').split(',').map(s => s.trim()).filter(Boolean),
};

/* bull / bear by trigger label — cross-check only (same table as breadth_backtest.js) */
const BULL = new Set(['Bull-FS', 'UC1', 'UC2', 'DR1', 'DR2', 'S1',  'S2']);
const BEAR = new Set(['Bear-FS', 'DC1', 'DC2', 'UR1', 'UR2', 'S1s', 'S2s']);

const isoDay   = d => d.toISOString().slice(0, 10);
const addDays  = (iso, n) => isoDay(new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000));
const daysDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

/* ---- every trigger in a ticker's whole history, on one timeframe -------------
 * Same engine calls as the scanner's detectFresh(), minus the "last 2 bars"
 * freshness filter. Turtle pyramid adds (units 2-4) are NOT collected: an entry
 * signal is what a trade is opened on. */
function collectTriggers(eng, series, tf) {
  const aggMult = (tf === '2') ? 2 : 1;
  if (!series || !series.close || series.close.length < 60 * aggMult) return [];
  let bars;
  try { bars = eng.enrich(eng.aggregate(series, aggMult)); }
  catch (e) { return []; }
  if (!bars || bars.length < 2) return [];
  const rows = [];
  for (const t of eng.scan(bars)) rows.push({ date: t.date, trig: t.label, dir: t.dir, tf });
  for (const b of bars) {
    if (b.ttUnit === 1) rows.push({ date: b.date, trig: 'S' + (b.ttSys === 'S2' ? 2 : 1),       dir: 'long',  tf });
    if (b.rtUnit === 1) rows.push({ date: b.date, trig: 'S' + (b.rtSys === 'S2' ? 2 : 1) + 's', dir: 'short', tf });
  }
  return rows;
}

/* ---- the matching logic (pure — unit-testable without Alpaca) ---------------- */
function auditTrade(trade, triggers, lookback) {
  const opposite = { long: 'short', short: 'long' }[trade.side] || null;
  const winStart = addDays(trade.entry, -lookback);
  const before   = triggers.filter(r => r.date <= trade.entry && r.date >= winStart)
                           .sort((a, b) => a.date < b.date ? -1 : 1);
  const aligned  = opposite ? before.filter(r => r.dir === trade.side) : [];
  const opposing = opposite ? before.filter(r => r.dir === opposite)   : [];

  /* first opposing trigger DURING the hold — the "exit on a reversal" candidate */
  let exitSig = null;
  if (opposite && trade.exit) {
    const during = triggers.filter(r => r.date > trade.entry && r.date <= trade.exit && r.dir === opposite)
                           .sort((a, b) => a.date < b.date ? -1 : 1);
    if (during.length) exitSig = { date: during[0].date, trig: during[0].trig, tf: during[0].tf,
                                   days_after_entry: daysDiff(during[0].date, trade.entry),
                                   days_before_your_exit: daysDiff(trade.exit, during[0].date) };
  }

  const lastAligned = aligned.length ? aligned[aligned.length - 1] : null;
  let verdict;
  if (trade.side === 'neutral')      verdict = 'neutral_structure';
  else if (aligned.length)           verdict = 'supported';
  else if (opposing.length)          verdict = 'against_signal';
  else                               verdict = 'no_signal';

  return {
    ...trade,
    verdict,
    aligned:  aligned .map(r => ({ date: r.date, trig: r.trig, tf: r.tf })),
    opposing: opposing.map(r => ({ date: r.date, trig: r.trig, tf: r.tf })),
    context:  (trade.side === 'neutral') ? before.map(r => ({ date: r.date, trig: r.trig, tf: r.tf, dir: r.dir })) : undefined,
    entry_lag_days: lastAligned ? daysDiff(trade.entry, lastAligned.date) : null,
    entry_trigger:  lastAligned ? lastAligned.trig : null,
    entry_trigger_tf: lastAligned ? lastAligned.tf : null,
    exit_signal: exitSig,
  };
}

/* ---- summary blocks ---------------------------------------------------------- */
function summarise(rows) {
  const withPl = rows.filter(r => typeof r.pl === 'number');
  const agg = list => ({
    n: list.length,
    net_pl: +list.reduce((s, r) => s + r.pl, 0).toFixed(2),
    win_rate: list.length ? +(100 * list.filter(r => r.pl > 0).length / list.length).toFixed(1) : null,
    median_pl: list.length ? +[...list].map(r => r.pl).sort((a, b) => a - b)[Math.floor(list.length / 2)].toFixed(2) : null,
  });
  const by = k => {
    const o = {};
    for (const r of withPl) (o[r[k]] = o[r[k]] || []).push(r);
    const out = {}; for (const key in o) out[key] = agg(o[key]); return out;
  };
  const lagged = withPl.filter(r => r.entry_lag_days !== null);
  return {
    by_verdict: by('verdict'),
    entry_lag: {
      fresh_0_1_days: agg(lagged.filter(r => r.entry_lag_days <= 1)),
      stale_2_plus_days: agg(lagged.filter(r => r.entry_lag_days >= 2)),
      note: 'Split is descriptive, not a test. A difference here is a HYPOTHESIS to be tested on the full sample, and is confounded with whatever made you act quickly on some names and slowly on others.',
    },
    /* neutral structures can never register an opposing trigger, so they are
     * excluded from both buckets rather than padding the "absent" side */
    exit_signal_present: agg(withPl.filter(r => r.exit_signal)),
    exit_signal_absent:  agg(withPl.filter(r => r.exit && r.side !== 'neutral' && !r.exit_signal)),
    by_timeframe_of_entry_trigger: by('entry_trigger_tf'),
    by_entry_trigger: by('entry_trigger'),
  };
}

/* ---- orchestrate ------------------------------------------------------------- */
async function main() {
  if (!process.env.ALPACA_KEY || !process.env.ALPACA_SECRET) {
    console.error('Set ALPACA_KEY and ALPACA_SECRET in the environment first.'); process.exit(1);
  }

  const trades = JSON.parse(fs.readFileSync(TA.listFile, 'utf8'));
  if (!Array.isArray(trades) || !trades.length) throw new Error(TA.listFile + ' is empty or not an array.');
  for (const t of trades) {
    if (!t.ticker || !t.entry) throw new Error('Every trade needs ticker + entry: ' + JSON.stringify(t));
    if (!['long', 'short', 'neutral'].includes(t.side)) throw new Error('side must be long/short/neutral: ' + JSON.stringify(t));
  }
  const syms = [...new Set(trades.map(t => t.ticker))].sort();
  const earliest = trades.map(t => t.entry).sort()[0];
  console.error(`${trades.length} trades, ${syms.length} tickers, earliest entry ${earliest}.`);

  const eng  = scan.loadEngine(TA.htmlPath);
  const html = fs.readFileSync(TA.htmlPath, 'utf8');
  const vm   = html.match(/ENGINE_VERSION\s*=\s*['"]([^'"]+)/);
  const engineVersion = vm ? vm[1] : 'unknown';
  console.error(`Engine ${engineVersion} loaded from ${TA.htmlPath}.`);

  /* pull enough history: back to the earliest entry, plus warm-up */
  const spanDays  = Math.max(0, Math.round((Date.now() - Date.parse(earliest + 'T00:00:00Z')) / 86400000));
  const dailyDays = spanDays + TA.warmupDays;
  const weekDays  = spanDays + TA.warmupDays * 5;   // weekly bars need ~5x the calendar reach for the same bar count
  console.error(`Pulling ~${dailyDays} calendar days of daily bars (incl. ${TA.warmupDays}d warm-up)` +
                (TA.tfs.includes('W') ? ` and ~${weekDays} days of weekly bars.` : '.'));

  const pullCfg = { batch: scan.CFG.batch, reqPerMin: scan.CFG.reqPerMin, feed: scan.CFG.feed, adjustment: scan.CFG.adjustment };

  const trigsBySym = {};   // ticker -> [{date,trig,dir,tf}]
  const noData = [];
  let dirMismatch = 0;

  for (let i = 0; i < syms.length; i += TA.chunk) {
    const chunk = syms.slice(i, i + TA.chunk);
    console.error(`Chunk ${Math.floor(i / TA.chunk) + 1}/${Math.ceil(syms.length / TA.chunk)} — ${chunk.length} tickers…`);

    const daily = (TA.tfs.includes('1') || TA.tfs.includes('2'))
      ? await scan.fetchBars(chunk, pullCfg, '1Day', dailyDays) : {};
    const weekly = TA.tfs.includes('W')
      ? await scan.fetchBars(chunk, pullCfg, '1Week', weekDays) : {};

    for (const sym of chunk) {
      const rows = [];
      for (const tf of TA.tfs) {
        const arr = (tf === 'W') ? weekly[sym] : daily[sym];
        if (!arr || arr.length < 60) continue;
        rows.push(...collectTriggers(eng, scan.seriesFromAlpaca(arr), tf));
      }
      for (const r of rows) {
        const isBull = BULL.has(r.trig), isBear = BEAR.has(r.trig);
        if ((isBull && r.dir === 'short') || (isBear && r.dir === 'long')) dirMismatch++;
      }
      if (!rows.length && !(daily[sym] || weekly[sym])) noData.push(sym);
      trigsBySym[sym] = rows;
      delete daily[sym]; delete weekly[sym];
    }
  }
  if (dirMismatch) console.error(`NOTE: ${dirMismatch} triggers had a label/direction mismatch (engine dir field used).`);
  if (noData.length) console.error(`NO BARS for ${noData.length} tickers (delisted / renamed / not on Alpaca): ${noData.join(' ')}`);

  const audited = trades.map(t => auditTrade(t, trigsBySym[t.ticker] || [], TA.lookback))
                        .map(r => ({ ...r, no_data: noData.includes(r.ticker) || undefined }));

  const result = {
    meta: {
      generated_at: new Date().toISOString(), engine_version: engineVersion,
      trades: trades.length, tickers: syms.length, earliest_entry: earliest,
      lookback_calendar_days: TA.lookback, warmup_days: TA.warmupDays,
      timeframes: TA.tfs, provider: 'alpaca', feed: pullCfg.feed, adjustment: pullCfg.adjustment,
      no_data_tickers: noData,
      caveat: 'Replayed triggers, not a record of what you saw. Tickers with no bars are excluded from every conclusion.',
    },
    summary: summarise(audited.filter(r => !r.no_data)),
    trades: audited,
  };
  fs.writeFileSync(TA.outJson, JSON.stringify(result, null, 1));

  const esc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = ['no,ticker,entry,exit,side,strategy,pl,cost,verdict,entry_trigger,entry_trigger_tf,entry_lag_days,aligned_count,opposing_count,exit_signal_date,exit_signal_trig,exit_signal_days_after_entry,exit_signal_days_before_your_exit,no_data'];
  for (const r of audited) lines.push([
    r.no, r.ticker, r.entry, r.exit || '', r.side, esc(r.strategy), r.pl == null ? '' : r.pl, r.cost == null ? '' : r.cost,
    r.verdict, r.entry_trigger || '', r.entry_trigger_tf || '', r.entry_lag_days == null ? '' : r.entry_lag_days,
    r.aligned.length, r.opposing.length,
    r.exit_signal ? r.exit_signal.date : '', r.exit_signal ? r.exit_signal.trig : '',
    r.exit_signal ? r.exit_signal.days_after_entry : '', r.exit_signal ? r.exit_signal.days_before_your_exit : '',
    r.no_data ? '1' : '',
  ].join(','));
  fs.writeFileSync(TA.outCsv, lines.join('\n') + '\n');

  const s = result.summary.by_verdict;
  console.error(`Done — wrote ${TA.outJson} + ${TA.outCsv}`);
  for (const k in s) console.error(`  ${k}: n=${s[k].n} net=${s[k].net_pl} win=${s[k].win_rate}%`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { main, collectTriggers, auditTrade, summarise, BULL, BEAR, TA };
