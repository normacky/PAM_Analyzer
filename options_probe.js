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

/* STEP A — rebuild the strike ladder WITHOUT the enumeration endpoint.
   Expired contracts are not listed by /v2/options/contracts (proven by probe v1:
   HTTP 200 with an empty list), so we construct OCC symbols directly instead.
   The format is deterministic: root + YYMMDD + C/P + strike x1000, zero-padded
   to 8 digits — exactly what the scanner's own parseOcc() decodes. We build a
   grid of plausible strikes around spot; the ones that really existed come back
   with data, the ones that never existed come back empty. No lookup needed. */
function occFor(sym, expiry, type, strike) {
  const d = expiry.slice(2, 4) + expiry.slice(5, 7) + expiry.slice(8, 10);
  const k = String(Math.round(strike * 1000)).padStart(8, '0');
  return sym + d + type + k;
}

// Strikes around spot on the given increment, as a clean multiple of that increment.
// The band widens automatically until the ladder holds at least `minN` strikes, so a
// low-priced name doesn't end up with two strikes at a fixed percentage band.
function strikeLadder(spot, inc, pctBand, minN) {
  minN = minN || 9;
  let band = pctBand, out = [];
  for (let guard = 0; guard < 12; guard++) {
    const lo = Math.ceil((spot * (1 - band)) / inc) * inc;
    const hi = Math.floor((spot * (1 + band)) / inc) * inc;
    out = [];
    for (let k = lo; k <= hi + 1e-9; k += inc) out.push(+k.toFixed(2));
    if (out.length >= minN) break;
    band *= 1.5;
  }
  return out;
}

/* STEP B — historical bid/ask for a whole ladder in ONE request.
   The quotes endpoint takes a comma-separated symbol list, so an entire chain
   costs a single call. We only care whether any contract returns a usable
   bid AND ask, since the scanner prices every leg at the mid. */
async function quotesFor(occs, dateISO, feed) {
  const next = iso(new Date(new Date(dateISO).getTime() + 86400000));
  const u = `${DATA_API}/v1beta1/options/quotes?symbols=${encodeURIComponent(occs.join(','))}` +
            `&start=${dateISO}T14:30:00Z&end=${next}T00:00:00Z&feed=${feed}&limit=2000`;
  const r = await get(u);
  if (!r.ok) return { got: 0, why: `HTTP ${r.status} ${r.text}` };
  const q = (r.json && r.json.quotes) || {};
  const keys = Object.keys(q);
  if (!keys.length) return { got: 0, why: 'HTTP 200 but no quotes for any strike' };
  let usable = 0, sample = '';
  for (const k of keys) {
    const hit = (q[k] || []).find(x => x.bp > 0 && x.ap > 0);
    if (hit) { usable++; if (!sample) sample = `${k} bid ${hit.bp} / ask ${hit.ap}`; }
  }
  return { got: usable,
           why: usable ? `${usable}/${occs.length} strikes priced — e.g. ${sample}`
                       : `${keys.length} strikes returned rows but none with both bid and ask > 0` };
}

/* STEP C — daily trade bars for the same ladder. Not sufficient on its own
   (illiquid strikes never trade) but a second signal about how far back the
   options history physically goes. */
async function barsFor(occs, dateISO) {
  const next = iso(new Date(new Date(dateISO).getTime() + 4 * 86400000));
  const u = `${DATA_API}/v1beta1/options/bars?symbols=${encodeURIComponent(occs.join(','))}` +
            `&timeframe=1Day&start=${dateISO}&end=${next}&limit=2000`;
  const r = await get(u);
  if (!r.ok) return { got: 0, why: `HTTP ${r.status} ${r.text}` };
  const b = (r.json && r.json.bars) || {};
  const n = Object.keys(b).length;
  return { got: n, why: n ? `${n}/${occs.length} strikes traded` : 'no strike traded in the window' };
}

/* CONTROL — the same test on a LIVE, near-future expiry. This separates two very
   different failures: if the control works and the historical test does not, the
   wall is data DEPTH. If the control fails too, the account simply lacks options
   data entitlement and no depth is available at all. */
async function control(sym) {
  const today = iso(new Date());
  const expiry = expiryFor(today);
  const s = await spotOn(sym, today);
  if (s.spot == null) return `spot lookup failed: ${s.why}`;
  const inc = s.spot > 100 ? 5 : 1;
  const occs = strikeLadder(s.spot, inc, 0.06).map(k => occFor(sym, expiry, 'C', k));
  for (const feed of FEEDS) {
    const q = await quotesFor(occs, iso(new Date(Date.now() - 3 * 86400000)), feed);
    if (q.got) return `WORKS on feed=${feed} — ${q.why}`;
  }
  return 'no quotes even on a live expiry';
}

async function probeOne(sym, months) {
  const date   = monthsAgo(months);
  const expiry = expiryFor(date);
  const dte    = Math.round((new Date(expiry) - new Date(date)) / 86400000);
  console.log(`\n--- ${sym} @ ${months}mo back (${date}, expiry ${expiry}, ${dte} DTE) ---`);

  const s = await spotOn(sym, date);
  if (s.spot == null) { console.log(`  spot          FAIL  ${s.why}`); return { sym, months, ok: false }; }
  console.log(`  spot          ok    ${sym} closed ${s.spot.toFixed(2)}`);

  const inc  = s.spot > 100 ? 5 : 1;                 // $5 ladder on big names, $1 on small
  const ks   = strikeLadder(s.spot, inc, 0.10);      // +/-10% around spot
  const occs = ks.map(k => occFor(sym, expiry, 'C', k));
  console.log(`  A ladder      ok    ${occs.length} constructed calls, ${ks[0]}-${ks[ks.length-1]} (${inc} wide), e.g. ${occs[0]}`);

  let quoteOk = false, feedUsed = '';
  for (const feed of FEEDS) {
    const q = await quotesFor(occs, date, feed);
    console.log(`  B quotes:${feed.padEnd(10)} ${q.got ? 'ok   ' : 'FAIL '} ${q.why}`);
    if (q.got) { quoteOk = true; feedUsed = feed; break; }
    await sleep(400);
  }

  const bars = await barsFor(occs, date);
  console.log(`  C bars        ${bars.got ? 'ok   ' : 'FAIL '} ${bars.why}`);

  return { sym, months, date, ok: quoteOk, feed: feedUsed, barOk: !!bars.got };
}

(async () => {
  console.log('Alpaca historical options probe (v2 — constructed OCC ladders, no enumeration)');
  console.log('Key type: ' + (KEY.startsWith('PK') ? 'paper' : 'live') + '  ·  trade API: ' + TRADE_API);
  console.log('Probe v1 showed expired contracts are not listed by /v2/options/contracts, so this');
  console.log('version builds OCC symbols directly and asks for the whole ladder in one request.');

  console.log('\n### CONTROL: does options quote data work at all, on a live expiry? ###');
  for (const sym of SYMS) console.log(`  ${sym}: ${await control(sym)}`);

  const results = [];
  for (const months of MONTHS_BACK) {
    let anyOk = false;
    for (const sym of SYMS) {
      const r = await probeOne(sym, months);
      results.push(r);
      anyOk = anyOk || r.ok;
      await sleep(600);
    }
    if (!anyOk) { console.log(`\nBoth symbols failed at ${months} months back — stopping the walk here.`); break; }
  }

  const good = results.filter(r => r.ok);
  console.log('\n================ VERDICT ================');
  if (!good.length) {
    console.log('No historical option quotes at any depth tested.');
    console.log('Read the CONTROL line above to tell which problem this is:');
    console.log('  control WORKS  -> live data is fine, history is the wall. Backtest must');
    console.log('                    move to marketdata.app historical chains (~15 tickers,');
    console.log('                    scoped to the 100-credit daily budget).');
    console.log('  control FAILS  -> the account has no options quote entitlement at all;');
    console.log('                    the nightly scanner is running on snapshots only.');
  } else {
    const deepest = Math.max(...good.map(r => r.months));
    const feed = good.find(r => r.months === deepest).feed;
    console.log(`Historical quotes WORK via constructed OCC ladders on feed=${feed}.`);
    console.log(`Deepest confirmed reach: ${deepest} months back.`);
    console.log(`-> The options backtest can run entirely in GitHub Actions on the existing`);
    console.log(`   Alpaca secrets, over roughly the last ${deepest} months, with no credit budget.`);
    console.log(`   Chain rebuild costs ONE quotes call per (symbol, trigger date).`);
  }
  console.log('=========================================');
})();
