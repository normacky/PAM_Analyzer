/* ============================================================================
 * options_probe.js — can we backtest the options layer on Alpaca data?
 * ----------------------------------------------------------------------------
 * This script CHANGES NOTHING. It writes no files, commits nothing, and does not
 * touch the engine, the scanner, or scan_results.json. It only asks Alpaca a
 * series of questions and prints the answers in plain English to the Actions log.
 *
 * WHY IT EXISTS
 * The nightly scanner prices spreads from /v1beta1/options/snapshots/, which is a
 * LIVE endpoint — it tells you the chain as it is right now, with no way to ask
 * "what did this chain look like on 12 March?". To backtest the options rules we
 * need three things Alpaca may or may not give us on this key:
 *
 *   A. ENUMERATION — list the contracts that existed for an expiry that has
 *      already passed. Without this we can't rebuild a chain at all.
 *   B. QUOTES — the historical bid/ask for one of those contracts on a past day.
 *      The scanner prices every leg at the MID, so bid/ask is the thing that
 *      matters; trade bars alone are not enough (many strikes never trade).
 *   C. REACH — how far back A and B keep working. Alpaca's options history is
 *      much younger than its stock history, so there is a wall somewhere.
 *
 * The probe walks back through time (3, 6, 12, 18, 24, 30 months) and reports
 * the oldest date where everything still works. That single number decides
 * whether the backtest runs here on Alpaca or has to move to marketdata.app.
 *
 * HOW TO RUN
 * Commit this file plus .github/workflows/options_probe.yml, then open the
 * Actions tab, pick "Options data probe", and press "Run workflow". Read the log.
 * Takes about a minute. Uses the ALPACA_KEY / ALPACA_SECRET secrets already set
 * up for the nightly scan.
 * ========================================================================== */

const KEY    = process.env.ALPACA_KEY;
const SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.error('Missing ALPACA_KEY / ALPACA_SECRET.'); process.exit(1); }

const DATA_API  = 'https://data.alpaca.markets';
const TRADE_API = process.env.PAM_TRADE_BASE ||
  (KEY.startsWith('PK') ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
const HEADERS = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };

// Symbols to test. SPY is the most liquid option in the world, so if anything
// works it works here; AAPL is a normal single name, which is what the scan
// actually fires on. Testing both separates "no data" from "no data for SPY".
const SYMS = ['SPY', 'AAPL'];
// How far back to walk, in months. Stops early once a rung fails on both symbols.
const MONTHS_BACK = [3, 6, 12, 18, 24, 30];
// Feeds to try for the quote pull. 'opra' is the real consolidated feed and may
// need a paid subscription; 'indicative' is the free stand-in.
const FEEDS = ['opra', 'indicative'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* A thin wrapper that never throws — every probe step wants to report a failure
   in plain English rather than crash the run, so we hand back status + body. */
async function get(url) {
  try {
    const r = await fetch(url, { headers: HEADERS });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, json, text: text.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: 'network: ' + e.message };
  }
}

const iso = d => d.toISOString().slice(0, 10);

// A date N months before today, as YYYY-MM-DD.
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return iso(d);
}

// The standard monthly expiry (3rd Friday) of a given month offset from the date.
function thirdFridayOfMonthAfter(dateISO, offset) {
  const d = new Date(dateISO + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + offset, 1);       // 1st of that month
  // day 0 = Sunday ... 5 = Friday. Walk forward to the first Friday, then +14 days.
  const firstFri = 1 + ((5 - d.getUTCDay()) + 7) % 7;
  d.setUTCDate(firstFri + 14);
  return iso(d);
}

// The monthly expiry closest to 37 days out — the same anchor the scanner uses.
// A test date late in the month makes next month's expiry only ~18 days away,
// so we check one and two months forward and keep whichever sits nearer 37 DTE.
function expiryFor(dateISO) {
  const dteOf = e => Math.round((new Date(e) - new Date(dateISO)) / 86400000);
  const cands = [1, 2].map(o => thirdFridayOfMonthAfter(dateISO, o));
  cands.sort((a, b) => Math.abs(dteOf(a) - 37) - Math.abs(dteOf(b) - 37));
  return cands[0];
}

/* The underlying's closing price on (or just before) the test date — we need it
   to know which strike was at-the-money back then. Stock history is deep and
   reliable on every Alpaca tier, so this part is expected to always work. */
async function spotOn(sym, dateISO) {
  const from = iso(new Date(new Date(dateISO).getTime() - 10 * 86400000));
  const u = `${DATA_API}/v2/stocks/${encodeURIComponent(sym)}/bars` +
            `?timeframe=1Day&start=${from}&end=${dateISO}&adjustment=raw&feed=sip&limit=20`;
  const r = await get(u);
  const bars = r.json && r.json.bars;
  if (!r.ok || !bars || !bars.length) return { spot: null, why: `HTTP ${r.status} ${r.text}` };
  return { spot: bars[bars.length - 1].c, why: '' };
}

/* STEP A — can we list contracts for an expiry that has already passed?
   Expired contracts are hidden by default; Alpaca exposes them behind
   status=inactive, so we ask for both and report which one answered. */
async function enumerate(sym, expiry, spot) {
  const lo = (spot * 0.85).toFixed(2), hi = (spot * 1.15).toFixed(2);
  for (const status of ['inactive', 'active']) {
    const u = `${TRADE_API}/v2/options/contracts?underlying_symbols=${encodeURIComponent(sym)}` +
              `&expiration_date=${expiry}&status=${status}` +
              `&strike_price_gte=${lo}&strike_price_lte=${hi}&limit=200`;
    const r = await get(u);
    const list = r.json && r.json.option_contracts;
    if (r.ok && list && list.length) return { list, status, why: '' };
    if (!r.ok) return { list: null, status, why: `HTTP ${r.status} ${r.text}` };
  }
  return { list: null, status: '-', why: 'empty response on both status=inactive and status=active' };
}

/* STEP B — historical bid/ask for one contract on the test date.
   We ask for a one-day window of quotes and only care whether anything comes
   back with a usable bid AND ask, since the scanner prices legs at the mid. */
async function quoteOn(occ, dateISO, feed) {
  const next = iso(new Date(new Date(dateISO).getTime() + 86400000));
  const u = `${DATA_API}/v1beta1/options/quotes?symbols=${encodeURIComponent(occ)}` +
            `&start=${dateISO}T14:30:00Z&end=${next}T00:00:00Z&feed=${feed}&limit=50`;
  const r = await get(u);
  const q = r.json && r.json.quotes && r.json.quotes[occ];
  if (!r.ok) return { got: false, why: `HTTP ${r.status} ${r.text}` };
  if (!q || !q.length) return { got: false, why: 'empty (no quotes returned)' };
  const usable = q.find(x => x.bp > 0 && x.ap > 0);
  if (!usable) return { got: false, why: `${q.length} quotes but none with both bid and ask > 0` };
  return { got: true, why: `bid ${usable.bp} / ask ${usable.ap}, ${q.length} quotes in the window` };
}

/* STEP C — daily trade bars for the same contract. Not sufficient on its own
   (illiquid strikes never trade) but a useful second signal about reach. */
async function barOn(occ, dateISO) {
  const next = iso(new Date(new Date(dateISO).getTime() + 4 * 86400000));
  const u = `${DATA_API}/v1beta1/options/bars?symbols=${encodeURIComponent(occ)}` +
            `&timeframe=1Day&start=${dateISO}&end=${next}&limit=10`;
  const r = await get(u);
  const b = r.json && r.json.bars && r.json.bars[occ];
  if (!r.ok) return { got: false, why: `HTTP ${r.status} ${r.text}` };
  if (!b || !b.length) return { got: false, why: 'empty (contract never traded in the window)' };
  return { got: true, why: `close ${b[0].c}, volume ${b[0].v}` };
}

async function probeOne(sym, months) {
  const date   = monthsAgo(months);
  const expiry = expiryFor(date);
  const dte    = Math.round((new Date(expiry) - new Date(date)) / 86400000);
  const tag    = `${sym} @ ${months}mo back (${date}, expiry ${expiry}, ${dte} DTE)`;
  console.log(`\n--- ${tag} ---`);

  const s = await spotOn(sym, date);
  if (s.spot == null) { console.log(`  spot          FAIL  ${s.why}`); return { sym, months, ok: false }; }
  console.log(`  spot          ok    ${sym} closed ${s.spot.toFixed(2)}`);

  const e = await enumerate(sym, expiry, s.spot);
  if (!e.list) { console.log(`  A enumerate   FAIL  ${e.why}`); return { sym, months, ok: false }; }
  console.log(`  A enumerate   ok    ${e.list.length} contracts via status=${e.status}`);

  // Nearest-to-the-money call, which is what the ATM IV read is anchored on.
  const calls = e.list.filter(c => c.type === 'call')
                      .sort((a, b) => Math.abs(a.strike_price - s.spot) - Math.abs(b.strike_price - s.spot));
  if (!calls.length) { console.log('  A enumerate   FAIL  contracts returned but no calls among them'); return { sym, months, ok: false }; }
  const occ = calls[0].symbol;
  console.log(`  test contract       ${occ} (strike ${calls[0].strike_price})`);

  let quoteOk = false;
  for (const feed of FEEDS) {
    const q = await quoteOn(occ, date, feed);
    console.log(`  B quotes:${feed.padEnd(10)} ${q.got ? 'ok   ' : 'FAIL '} ${q.why}`);
    if (q.got) { quoteOk = true; break; }          // one working feed is enough
    await sleep(400);
  }

  const bar = await barOn(occ, date);
  console.log(`  C bars        ${bar.got ? 'ok   ' : 'FAIL '} ${bar.why}`);

  return { sym, months, date, ok: quoteOk, barOk: bar.got };
}

(async () => {
  console.log('Alpaca historical options probe');
  console.log('Key type: ' + (KEY.startsWith('PK') ? 'paper' : 'live') + '  ·  trade API: ' + TRADE_API);
  console.log('Testing whether a past option chain can be rebuilt with bid/ask, and how far back it reaches.');

  const results = [];
  for (const months of MONTHS_BACK) {
    let anyOk = false;
    for (const sym of SYMS) {
      const r = await probeOne(sym, months);
      results.push(r);
      anyOk = anyOk || r.ok;
      await sleep(600);                             // stay polite; this is a tiny number of calls
    }
    if (!anyOk) { console.log(`\nBoth symbols failed at ${months} months back — stopping the walk here.`); break; }
  }

  const good = results.filter(r => r.ok);
  console.log('\n================ VERDICT ================');
  if (!good.length) {
    console.log('No historical option quotes available on this key, at any depth tested.');
    console.log('→ The options backtest cannot run on Alpaca. Next option is marketdata.app');
    console.log('  historical chains, scoped to ~15 tickers to fit the 100-credit daily budget.');
  } else {
    const deepest = Math.max(...good.map(r => r.months));
    console.log(`Historical quotes WORK. Deepest confirmed reach: ${deepest} months back.`);
    console.log(`→ The options backtest can run entirely in GitHub Actions on the existing`);
    console.log(`  Alpaca secrets, over roughly the last ${deepest} months, with no credit budget.`);
    if (deepest < Math.max(...MONTHS_BACK)) {
      console.log(`  (The walk stopped at ${deepest}mo, so that is the wall — or close to it.)`);
    }
  }
  console.log('=========================================');
})();
