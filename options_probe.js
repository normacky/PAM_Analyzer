/* ============================================================================
 * options_probe.js — v3. Which Alpaca options routes actually work on this key?
 * ----------------------------------------------------------------------------
 * WHAT THE FIRST TWO ROUNDS ESTABLISHED
 *   v1: expired contracts are NOT listed by /v2/options/contracts (HTTP 200,
 *       empty list). So enumeration of a past chain is out.
 *   v2: constructed OCC symbols returned 404 on /v1beta1/options/quotes and an
 *       empty 200 on /v1beta1/options/bars. Ambiguous — that is what you would
 *       see if the SYMBOLS were wrong, and also what you would see if the ROUTE
 *       or the ENTITLEMENT were missing. The v2 control test never ran, because
 *       its spot lookup asked for same-day SIP data, which the Basic plan blocks
 *       (403 "subscription does not permit querying recent SIP data") — that is
 *       a stock-data limit, nothing to do with options.
 *
 * WHAT THIS ROUND DOES
 * The nightly scanner pulls option chains successfully every night from
 * /v1beta1/options/snapshots/ on feed=indicative. So we start there, take REAL
 * contract symbols straight out of that response, and ask every historical route
 * for those exact symbols. Whatever fails now cannot be blamed on a bad symbol.
 *
 * The decisive question: do historical BARS work for a live contract over the
 * last 30 days? If yes, historical options data exists on this key and the
 * backtest can be built on it. If no, it does not, and the backtest moves to
 * marketdata.app. Everything else here is route mapping for that build.
 *
 * Writes nothing except the log (the workflow tees it to probe_result.txt).
 * ========================================================================== */

const KEY    = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.error('Missing ALPACA_KEY / ALPACA_SECRET.'); process.exit(1); }

const DATA_API = 'https://data.alpaca.markets';
const HEADERS  = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
const FEED     = process.env.PAM_OPT_FEED || 'indicative';   // what the working scanner uses
const SYM      = 'SPY';

const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => iso(new Date(Date.now() - n * 86400000));
const daysAhead = n => iso(new Date(Date.now() + n * 86400000));

async function get(url) {
  try {
    const r = await fetch(url, { headers: HEADERS });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, json, text: text.replace(/\s+/g, ' ').slice(0, 200) };
  } catch (e) { return { ok: false, status: 0, json: null, text: 'network: ' + e.message }; }
}

// Compact one-line verdict for a route: status + how much came back.
function line(label, r, count, note) {
  const verdict = !r.ok ? `HTTP ${r.status}` : (count ? 'ok' : 'HTTP 200 but EMPTY');
  console.log(`  ${label.padEnd(34)} ${verdict.padEnd(20)} ${note || (r.ok ? '' : r.text)}`);
  return r.ok && !!count;
}

(async () => {
  console.log('Alpaca options route map (v3 — real symbols from the live snapshot)');
  console.log(`feed=${FEED}  ·  key type: ${KEY.startsWith('PK') ? 'paper' : 'live'}`);

  /* -- 0. The route the scanner already uses. If this fails, something has broken
        in the nightly scan too, and that is a much bigger deal than the backtest. */
  console.log('\n### 0. LIVE SNAPSHOT — the route the nightly scanner runs on ###');
  const snapUrl = `${DATA_API}/v1beta1/options/snapshots/${SYM}` +
                  `?feed=${FEED}&limit=200` +
                  `&expiration_date_gte=${daysAhead(25)}&expiration_date_lte=${daysAhead(50)}`;
  const snap = await get(snapUrl);
  const snaps = (snap.json && snap.json.snapshots) || {};
  const occs = Object.keys(snaps);
  const okSnap = line('GET /options/snapshots/' + SYM, snap, occs.length,
                      occs.length ? `${occs.length} live contracts returned` : '');
  if (!okSnap) {
    console.log('\n  The scanner\'s own chain route is not answering. Stop here — this needs');
    console.log('  fixing before anything about a backtest matters.');
    console.log('\n================ VERDICT ================');
    console.log('Live options chain route FAILED. Investigate the nightly scan first.');
    console.log('=========================================');
    return;
  }

  // Pick the most liquid-looking contracts: those with a real two-sided market.
  const withQuote = occs.filter(o => {
    const q = snaps[o] && snaps[o].latestQuote;
    return q && q.bp > 0 && q.ap > 0;
  });
  console.log(`  ${'of those, two-sided'.padEnd(34)} ${String(withQuote.length).padEnd(20)} contracts with bid AND ask > 0`);
  const test = (withQuote.length ? withQuote : occs).slice(0, 5);
  console.log(`  test symbols: ${test.join(', ')}`);

  /* -- 1. Historical BARS for those same real contracts. THE DECIDING TEST. -- */
  console.log('\n### 1. HISTORICAL routes, asked for those exact real symbols ###');
  const syms = encodeURIComponent(test.join(','));
  const start30 = daysAgo(30), end3 = daysAgo(3);   // end 3 days back to dodge the delayed-data window

  const barsR = await get(`${DATA_API}/v1beta1/options/bars?symbols=${syms}&timeframe=1Day&start=${start30}&end=${end3}&limit=1000`);
  const barsN = Object.keys((barsR.json && barsR.json.bars) || {}).length;
  const barsOk = line('GET /options/bars (30d back)', barsR, barsN, barsN ? `${barsN}/${test.length} contracts have daily bars` : '');

  const tradesR = await get(`${DATA_API}/v1beta1/options/trades?symbols=${syms}&start=${start30}&end=${end3}&limit=100`);
  const tradesN = Object.keys((tradesR.json && tradesR.json.trades) || {}).length;
  line('GET /options/trades (30d back)', tradesR, tradesN, tradesN ? `${tradesN}/${test.length} contracts have trades` : '');

  // Does a historical quotes route exist at all? A 404 here means the route does
  // not exist on this API version, which is different from an empty result.
  const qHistR = await get(`${DATA_API}/v1beta1/options/quotes?symbols=${syms}&start=${start30}&end=${end3}&feed=${FEED}&limit=100`);
  const qHistN = Object.keys((qHistR.json && qHistR.json.quotes) || {}).length;
  const qHistOk = line('GET /options/quotes (30d back)', qHistR, qHistN, qHistN ? `${qHistN}/${test.length} contracts have quote history` : '');

  const qLatestR = await get(`${DATA_API}/v1beta1/options/quotes/latest?symbols=${syms}&feed=${FEED}`);
  const qLatestN = Object.keys((qLatestR.json && qLatestR.json.quotes) || {}).length;
  line('GET /options/quotes/latest', qLatestR, qLatestN, qLatestN ? `${qLatestN}/${test.length} quoted now` : '');

  /* -- 2. If bars work live, do they also work for an EXPIRED contract? ------- */
  if (barsOk) {
    console.log('\n### 2. Historical bars work. Do they reach an EXPIRED contract? ###');
    // Reuse a symbol shape we know is valid, but on an expiry that has passed.
    const past = ['2026-06-19', '2026-03-20', '2025-12-19', '2025-06-20'];
    for (const exp of past) {
      const d = exp.slice(2, 4) + exp.slice(5, 7) + exp.slice(8, 10);
      // Spot on a date ~40 days before that expiry, so the strike is near the money.
      const before = iso(new Date(new Date(exp).getTime() - 40 * 86400000));
      const sb = await get(`${DATA_API}/v2/stocks/${SYM}/bars?timeframe=1Day&start=${iso(new Date(new Date(before).getTime() - 10 * 86400000))}&end=${before}&adjustment=raw&feed=sip&limit=20`);
      const bars = (sb.json && sb.json.bars) || [];
      if (!bars.length) { console.log(`  ${exp}  skipped — no underlying price (${sb.status})`); continue; }
      const spot = bars[bars.length - 1].c;
      const k = Math.round(spot / 5) * 5;
      const occ = `${SYM}${d}C${String(k * 1000).padStart(8, '0')}`;
      const r = await get(`${DATA_API}/v1beta1/options/bars?symbols=${encodeURIComponent(occ)}&timeframe=1Day&start=${before}&end=${exp}&limit=100`);
      const n = ((r.json && r.json.bars && r.json.bars[occ]) || []).length;
      console.log(`  ${exp}  ${occ.padEnd(22)} ${(r.ok ? (n ? 'ok' : 'empty') : 'HTTP ' + r.status).padEnd(10)} ${n ? n + ' daily bars' : r.text}`);
    }
  }

  /* -- 3. Verdict ------------------------------------------------------------ */
  console.log('\n================ VERDICT ================');
  if (!barsOk && !qHistOk) {
    console.log('No historical options data on this key — real symbols, working feed, still nothing.');
    console.log('The live snapshot route works (the scanner is fine), but history is not included');
    console.log('in the Basic plan. An options backtest cannot be built on Alpaca.');
    console.log('-> Move to marketdata.app historical chains, scoped to ~15 tickers to fit');
    console.log('   the 100-credit daily budget, run from download_option_chains.py locally.');
  } else if (barsOk && !qHistOk) {
    console.log('Historical BARS work; historical QUOTES do not (no bid/ask history).');
    console.log('That is a real constraint, not a blocker: spreads would have to be priced from');
    console.log('trade closes rather than the mid, which is less accurate for illiquid strikes');
    console.log('and cannot reproduce the liquidity flag. Section 2 above shows how far back');
    console.log('bars reach. Worth doing as a rough first pass; marketdata.app stays the');
    console.log('accurate option.');
  } else {
    console.log('Historical quotes AND bars are available. The backtest can be built entirely');
    console.log('on Alpaca in GitHub Actions, priced at the mid exactly like the live scanner.');
    console.log('Section 2 above shows the reach for expired contracts.');
  }
  console.log('=========================================');
})();
