# v0.24 — Continuation family realigned to the UC/DC decks and transcripts · 09 Aug 2026

Owner supplied the slides and video transcripts for Lesson 16 (UC1/DC1, two parts), Lesson 17
(UC2/DC2) and Lesson 18 (Divergence for Continuation Structures). Built on the GitHub-committed
v0.23 (SHA256 verified byte-identical to `main` before patching).

This is **Build A** of a two-part plan: it contains only changes that live inside the continuation
path. Routing changes (force strike as a UC/DC EXE, the re-entry rule, decoupling the UC branch
from `findForce`) are deferred to Build B.

## The derived logic

The decisive finding is that **UC1 and UC2 carry identical rule text — the letters are shifted by
one place**, and the same for DC1/DC2. Three structural points do all the work:

| Role | UC1 / DC1 | UC2 / DC2 |
|---|---|---|
| First peak — the flush check happens here | A | B |
| The LP line the EXE reclaims | B | C |
| The point the EXE must stay short of | C | D |

`contWalk()`'s `first` / `line` / `second` already expressed exactly this from v0.21, and
`contTier()`'s "second peak beyond the first" discriminator is confirmed by the slide drawings.
**Nothing in these lessons overturns the v0.21 continuation architecture** — unlike Lessons 9/19,
which forced the v0.22→v0.23 reversal rework. The changes below are all corrections at the edges.

## Changes

- **Item 2 — `nearSMA()` scope widened to the whole structure.** v0.23 looked at a fixed 5-bar
  window ending at the EXE bar, so a structure whose only SMA contact happened back at point B or
  C failed the gate. L16 @11:59 is explicit: "as long as the entire ABCD structure, any parts of
  the ABCD structure touch or is near to the 20 or 50 SMA is good to go." Now scans from the
  structure's leftmost pivot. Callers passing no `from` keep the old behaviour.
- **Item 3 — UC2/DC2 A-line substitution.** When the pullback runs past the C line and only turns
  at the A line, the trainer re-anchors the setup to A (L17 @20:19 for DC2/GE, @22:29 for UC2).
  Two of his six worked examples are this shape. `contWalk()` now walks back one further pivot to
  supply `aLine`; the fallback is restricted to the "2" tier, which is where he demonstrates it and
  the only lettering in which a point A sits beyond the LP. Surfaced in `why` and as `aSub`.
- **Item 7 — flush window now excludes the pivot bar.** The deck says "3 preceding bars leading to
  point A" and the DC1 walkthrough counts them explicitly as the three bars *before* the pivot
  (L16 Pt1 @15:36). v0.23 checked `p1-2..p1` inclusive; now `p1-3..p1-1`.
- **Item 8 — deck bar counting at the LP line (`reclaimAt()`).** Bar 1 is the first bar that
  crosses or breaches the line whether or not it closes through (L16 @08:11); by bar 5 an EXE must
  close back across it. v0.23 used a rolling "did any of the last 5 bars pierce" test, which let a
  false break that dragged on for 8+ bars still fire on a late reclaim. This is the only item in
  Build A that removes triggers.
- **Item 1 — divergence (Lesson 18), as a FLAG not a filter.** A UC structure is divergent when a
  prior swing HIGH on its left sits at a level strictly inside the band spanned by its two peaks;
  DC uses a swing LOW. The deck states this as "between A and C" for UC1/DC1 and "between B and D"
  for UC2/DC2 — the same two points in both cases, because the letterings are the same structure
  shifted one place, so a single test covers all four labels. Strict inequality: the SQ (@14:21)
  and BAM (@15:27) examples both turn on a swing high sitting *below* point C and are ruled
  convergent. No-man's-land needs no special case — with nothing on the left there is no swing to
  find. Applies to UC/DC only, never UR/DR (@03:39). The trainer treats it as his own preference
  rather than a rule, so it annotates and never gates.

`div` and `aSub` are also carried as machine-readable fields on the trigger object so the nightly
scanner can surface the divergence flag in the Scan tab later. **`pam_scan.js` currently drops
`why` and does not read these fields**, so today the flag is visible only in the app's chart panel
and trigger log, not in the nightly Scan tab. Surfacing it there is a scanner-side change.

## Explicitly NOT changed

- **Item 5 (a "clear uptrend" trend-quality gate) was dropped.** The deck says "clear uptrend price
  movement" and never defines it mechanically; writing one means inventing a threshold the course
  does not give. That is precisely how v0.22's `sideways()` gate happened — it killed 12 of 13
  valid reversals and was fully reverted the next day. Flow remains the single close-vs-50-SMA test.

## Validation

Harness reproduces `pam_scan.js`'s `loadEngine()` extraction contract exactly. 60 synthetic series
across 5 regimes (bull, bear, chop, high-vol, grind), each also mirrored about its mean so the
bearish path runs on real geometry rather than reflected assertions. 25,200 bars.

The generator was corrected mid-build: the first version produced **zero flush bars**, which left
item 7 and the whole `noFlush` gate vacuously true. Impulse bars (~5%, body filling most of a
3-5× range) were added; the corrected data exercises the item-7 branch 2,622 times.

```
variant                       UC1  UC2  DC1  DC2  DR1  DR2  UR1  UR2  Bull-FS  Bear-FS  total  tErr
v0.23 base                     52   42   52   42  177   95  177   95      354      354   1440     0
scaffold only (all reverted)   52   42   52   42  177   95  177   95      354      354   1440     0
+ item 2                       53   45   53   45  176   95  176   95      354      354   1446     0
+ item 3                       52   66   52   66  159   95  159   95      354      354   1452     0
+ item 7                       55   42   55   42  175   95  175   95      354      354   1442     0
+ item 8                       50   40   50   40  178   95  178   95      354      354   1434     0
v0.24 all                      54   67   54   67  157   95  157   95      354      354   1454     0
```

- **Scaffold is behaviour-neutral** — with all five items reverted, the restructured `contGates`,
  the new `p0` walk and the new helpers reproduce v0.23 counts exactly. The new code adds nothing
  on its own.
- **Every directional prediction held.** Item 2 up-only; item 3 up-only and UC2/DC2-only with
  UC1/DC1 untouched; item 7 up-only; item 8 down-only. Effects are **exactly additive**
  (UC2: 42 +3 +24 +0 −2 = 67; DR1: 177 −1 −18 −2 +1 = 157).
- **Item 1 invariant proven, not assumed.** A variant with `divergence()` forced to always return
  false produces a byte-identical label sequence. It fires on 70 of 242 UC/DC triggers, so it is
  discriminating rather than dead.
- **UR2 / DR2 / Bull-FS / Bear-FS never move in any variant.** Build A does not touch those
  families.
- **Mirror symmetry exact in every variant** (UC≡DC, UR≡DR, FS≡FS).
- **Bar-level accounting vs v0.23:** 1,380 unchanged, 48 relabelled, 26 new, 12 dropped. The
  relabels are dominated by DR1→UC2 (19 per side) — the A-line substitution reclaiming bars that
  v0.23 was calling reversals. The 12 drops are item 8 expiring dragged-out false breaks.
- `node --check` passes on both script blocks and the extracted engine. Extraction boundary intact
  (`function aggregate(` and `STATE + RENDER` each exactly once, ordered). `loadEngine` reproduced
  and exports `aggregate, enrich, scan, buildTrade`. `buildTrade()` clean over all 1,454 triggers
  in every variant. 130 element ids, all unique. `legsInPullback()` still definition-only.

## Ground-truth attempt — blocked on data reach

The planned pass against the trainer's named charts (NXPI, SQ, BAM for divergence) **could not be
run**. Recorded here so it is not re-attempted the same way:

- **IBKR MCP cannot reach the window.** `get_price_history` caps at `period=FIVE_YEARS` (back to
  ~Aug 2021) and `step_count=1000` bars (~Aug 2022). All three deck charts end 07 May 2021 on a
  1-year 2-Day window, i.e. May 2020 - May 2021. Both limits fall short. Weekly bars via
  `step_count=1000` do reach back ~19 years, so **weekly-chart examples remain testable** — Lesson
  17's Morgan Stanley UC2 is on a weekly chart and is the obvious candidate for a future pass.
- **No alternative source is reachable.** Stooq returns ROBOTS_DISALLOWED; the container's egress
  allowlist covers package registries and GitHub only.
- **Two of the three names also have identity breaks**, independent of reach: Square is now Block
  under ticker XYZ (history continuous, so still usable), and BAM is not: the 2022 Brookfield
  restructuring left the old entity as BN and gave the BAM ticker to a new company, so the deck's
  Sep 2016 - Dec 2017 BAM chart cannot be reconciled against either ticker's present adjusted
  history.

To do this properly the bars have to come in from outside — a CSV export from Thinkorswim or IBKR
desktop for NXPI 2020-01 to 2021-06 would be enough. The NXPI slide prints its final bar's OHLC
(07 May 2021: O 195, H 198.50, L 193.33, C 198.22), which gives a free integrity check on whatever
source is used.

## Divergence boundary test (`divergence_boundary_test.js`)

What the three blocked charts were meant to validate is the *inequality* at the edge of the
divergence band — SQ and BAM both turn on a swing high sitting just below point C. That rule was
instead tested on constructed geometry using the trainer's own NXPI numbers (A = 216.43,
C = 205.00, offending swing high = 209.59), with the prior swing high swept across the boundary:

```
prior swing high                          expect      engine      label
209.59  (trainer's NXPI value, inside)    DIVERGENT   DIVERGENT   UC1     PASS
204.00  (just below point C - SQ/BAM)     convergent  convergent  UC1     PASS
205.00  (exactly ON point C)              convergent  convergent  UC1     PASS
216.43  (exactly ON point A)              convergent  convergent  UC1     PASS
218.00  (above point A)                   convergent  convergent  UC1     PASS
205.01  (one cent inside the band)        DIVERGENT   DIVERGENT   UC1     PASS
```

6/6. `contWalk` resolved the structure to first peak 216.43 / LP 190.00 / second peak 205.00, the
tier discriminator returned UC1 (second peak below first, matching the slide), and **the label is
UC1 in all six cases** — confirming end-to-end that divergence annotates without filtering.

This is a unit test of the rule, not ground truth: it proves the inequality is implemented as the
lesson states, not that the engine finds the same structures on the trainer's real bars.

A fixture bug worth noting: the first version of this test emitted no label at all. The cause was
the test's own EXE bar, built with an 82% body and a wide range, which the engine correctly
classified `FLUSH-UP` and refused as an execution signal. The engine was right and the fixture was
wrong — but it is exactly the shape of failure that reads as "the build is broken" if the gate
components are not printed.

## Validation gap (carried, and important)

**All of the above is synthetic data.** It proves internal consistency, direction of effect, and
that nothing broke — it does not prove deck fidelity. The decks name a stock for nearly every
worked example (Boeing, Lockheed Martin and Digital Turbine for UC1; Morgan Stanley weekly and
Honeywell for UC2; General Electric for DC2; NXPI, Square, Brookfield, EC and OXY for divergence),
and none of them have been run. NXPI is the highest-value chart in the set — the trainer walks
three UC1 structures on it and calls two convergent and one divergent, giving a positive and a
negative control on the same bars. SQ and BAM are the boundary cases for the strict-inequality
edge of the divergence band. This ground-truth pass is outstanding.

The v0.23 down-side gap also persists: the bearish path is still exercised by mirroring only.

## Behavioural note

Items 2, 3 and 7 are under-trigger fixes and item 8 is an over-trigger fix, netting +14 triggers
(+1.0%) on the sample, with continuation up 50 and reversals down 40. Deck fidelity is the goal
here, not edge — and given the backtest history (PAM bearish triggers in a bull regime running
worse than a coin flip), more DC labels is not self-evidently a good outcome. Whether any of this
improves results is a separate question that only forward tracking answers.
