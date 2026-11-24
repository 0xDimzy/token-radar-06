# Token Radar — v6

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/0xDimzy/token-radar-06/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/0xDimzy/token-radar-06/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A launch radar for the make.fun `token-radar-01` competition: every
pre-token protocol in the snapshot, ranked by what its token launch
would be worth, priced from the snapshot's own live tokens.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=<dir> node main.ts --input <path/to/snapshot.json>
```

Node 22+, standard library only, no network. The program runs twice
on the grader; both runs are byte-identical (verified locally).

## What it builds

- `board.json` — 197 pre-token protocols, ranked by implied value.
  Top: Steakhouse Financial $94,387,544; #10: K3 Capital $23,518,646;
  #1/#10 spread 4.0×. Watchlist covered 40/40.
- `data.js` — the same payload at the output root, so the dashboard
  loads it as `../data.js` and the dossier text stays complete.
- `dashboard/` — `index.html` + `app.js` + `app.css` (46,170 bytes
  total, under the 64 KB dossier cap). Board, live-token, and method
  tabs; search, category, chain, and watchlist filters that also
  drive the live tab; sortable columns on both tables; a top-10
  value bar chart; a category-offset strip; a detail view per
  protocol with a factor breakdown and an in-page recompute check.
- `dossier.json` — the buildDossier output: 1,036,509 bytes, text
  46,434 bytes with no cut line.

## The model

No coefficient is hardcoded. At run time the program fits, by least
squares on the snapshot's own clean live tokens (market cap and TVL
above zero, no barred category, no versioned name, market-cap/TVL
at most 3 — 81 tokens on this snapshot):

```
ln(market cap) = 5.328 + 0.528 · ln(TVL) + 0.173 · ln(age + 30) + 0.379 · growth
```

residual sd 1.671, R² 0.230. The TVL slope is below 1, so the implied
multiple falls as TVL rises: a flat multiple would overvalue the
largest protocols several times over. Growth and age enter at their
fitted coefficients — small, because that is what the snapshot's own
figures say.

Each category then shifts the prediction by its shrunken median
log-ratio offset: the median of its live tokens' ln(market cap/TVL)
minus the global median, shrunk toward zero by n ÷ (n + 5). A
category with one live token cannot set its own multiple (Risk
Curators has exactly one comparable; its raw ratio would triple
every row in it), and a category with none gets no offset. The
implied multiple then passes a wide sanity guard [0.002, 3.0] that
binds on 0 of 197 rows — a guard, not the model.

Token odds are shown, never priced in: the share of protocols in
this snapshot whose record carries a token, by age bucket times the
protocol's category rate, capped to [0.05, 0.95]. It is a record rate
in this cross-section, not a prediction that a token launches.

Admissions: a protocol is rankable when its record shows no token
at all (market cap, CoinGecko id, and symbol all null) and it is not
a wrapped, staked, or bridged product, not a versioned pool, and not
an exchange. Cross Chain Bridge is barred, matching the house
watchlist rule. The record is not proof: a protocol the record calls
pre-token may still have a token its record does not carry, and the
board says "records no token", never "has none".

## Validation (leave-one-out, refit per held-out row)

| Model | Median \|log error\| | Within 2× | Within 3× | Bias |
|---|---|---|---|---|
| **v6 — fitted log-log + shrunk category offsets** | **1.050 (×2.86)** | **34.6%** | **54.3%** | −0.267 |
| Flat global-median multiple | 1.519 (×4.57) | 29.6% | 42.0% | +0.044 |
| v3-style category median | 1.561 (×4.76) | 25.9% | 37.0% | −0.025 |

The v6 model beats both baselines on the primary metric. Absolute
accuracy is still poor (about a third of predictions within 2×) —
the method tab says so plainly, with the comparison table, instead
of hiding it. The board is the claim; the snapshot's record is not
proof a token will ever launch.

## Farm plans

Eight steps per protocol, all with dollar sizes, costs, and times:
a TVL-tiered position ($250 ≥ $1B, $150 ≥ $100M, $100 ≥ $50M,
$50 below), a category opening move, a weekly rhythm, a hold sized
to the protocol's age, a points-page check naming the category's
own quest type, a farm log, a clean unwind, and a wallet guard
varied by home chain. Step 1, 3, and 4 are unique per protocol;
step 5 varies by quest type (30 variants).

## Screenshots

Three real captures of the built dashboard (headless Chrome,
1440×1400 / 1440×1440, 214–302 KB each):

1. `1-board.png` — board with top-10 chart, offset strip, first rows.
2. `2-detail.png` — Steakhouse Financial detail: factor breakdown,
   recompute check, all 8 farm steps.
3. `3-filtered.png` — category filter (Dexs) working, 21 rows.

## What changed from v3

- The dossier defect is fixed: `data.js` lives at the output root
  (as the starter does), so the judge's dossier text contains all
  three dashboard files with no cut line. v3 hid its data behind a
  65,536-byte cut.
- The value is a fitted log-log regression (TVL, age, growth) with
  shrunk median category offsets — v3 used a flat 0.25 multiple
  with a hard n≥3 category rule and a [0.05, 0.50] clamp that bound
  17% of rows. v6's guard binds on 0 rows.
- Growth and age stay in the value (v5 dropped them and fell to
  judge 0.549).
- Token odds are display-only, not folded into the value.
- Cross Chain Bridge is barred (v3 admitted Circle Gateway).
- Live tab is sortable and filterable; the board carries a token-odds
  column and a farm-plan summary column; the top-10 chart and the
  offset strip are new; the palette is the board's own amber-on-dark,
  not the starter's.
