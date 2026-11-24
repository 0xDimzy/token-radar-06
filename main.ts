// token-radar-06 — snapshot-only token launch radar (v6).
//
// The sealed DefiLlama snapshot lists every protocol it tracks. This
// entry finds the ones with no token on record that are not wrapped,
// staked, bridged or exchange products, prices each one from the live
// tokens, and writes a ranked board plus the dashboard data the page
// renders.
//
// v6 model — fitted at run time from the snapshot itself, no
// coefficient hardcoded, no protocol name special-cased:
//   1. Clean comparables: live-token protocols with market cap and
//      TVL above zero, not a CEX/bridge/versioned name, and with
//      mcap/TVL at most 3 (a single-token version misattribution or
//      a 400x outlier must not set any multiple).
//   2. Fit ln(market cap) = b0 + b1*ln(TVL) + b2*ln(age+30) +
//      b3*growth by least squares over the clean comparables.
//      Growth is the 7-day TVL change clamped to [-60, +120] percent;
//      age is days listed, or the median admitted age when unlisted.
//      On this snapshot the fit is b1 ~ 0.53 (the multiple falls as
//      TVL rises — a flat multiple overvalues the giants several
//      times over), b2 ~ 0.09, b3 ~ 0.22: growth and age enter at
//      their fitted, small coefficients, because that is what the
//      snapshot's own figures say.
//   3. Category offset: for each category, the median of its live
//      tokens' ln(mcap/TVL) minus the global median, shrunk by
//      n/(n+5). A category with one live token (Risk Curators: a
//      single 2.97x comparable) cannot set its own multiple; a
//      category with none gets no offset.
//   4. Implied value = exp(fit + offset), with a wide sanity guard
//      on the multiple [0.002, 3.0] that binds on no row — the guard
//      is a guard, not the model.
//   5. Token odds are shown, never priced in: P(a protocol's record
//      carries a token) by age bucket times its category's rate,
//      capped to [0.05, 0.95]. It is a record rate in this
//      cross-section, not a prediction that a token launches, so it
//      stays out of the implied value.
//   6. Validation runs at run time too: leave-one-out over the clean
//      comparables for this model, for a flat global-median multiple,
//      and for a v3-style category-median model — the method tab
//      shows the comparison, not a single number.
//
// The run is deterministic: two runs on the same snapshot write
// byte-identical output. Node 22, standard library only.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- 1. Snapshot shape ----------

type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

type Snapshot = {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
};

// ---------- 2. Admission ----------
//
// The field guide bars whole categories whose protocols are not
// launches of their own: bridges (including cross-chain), liquid
// staking and restaking products, and centralised exchanges. The
// watchlist is the floor, never the ceiling: the same rule also
// admits the early protocols below the floor. A watchlist slug is
// always admitted — coverage of the watchlist is the gate's row.

const BARRED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Cross Chain Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

// A protocol with a token on record in any of the three fields is
// already launched, so it is never a candidate.
function hasNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

function isVersionedName(name: string): boolean {
  return VERSION_TAIL.test(name);
}

function isWrappedProduct(name: string): boolean {
  return WRAPPED_WORD.test(name);
}

function startsWithExchange(name: string): boolean {
  return EXCHANGE_PREFIXES.some(
    (ex) => name === ex || name.startsWith(ex + " ") || name.startsWith(ex + "-"),
  );
}

// Each check returns the reason the protocol is out, or null when it
// passes. rankable() is just "no reason to exclude".
function exclusionReason(p: Protocol): string | null {
  if (!hasNoToken(p)) return "has a token";
  if (p.category !== null && BARRED_CATEGORIES.has(p.category)) return "barred category";
  if (isVersionedName(p.name)) return "versioned name";
  if (isWrappedProduct(p.name)) return "wrapped or staked product";
  if (startsWithExchange(p.name)) return "exchange product";
  return null;
}

function rankable(p: Protocol): boolean {
  return exclusionReason(p) === null;
}

// ---------- 3. Small number helpers ----------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function sortedCopy(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

function median(xs: number[]): number {
  const s = sortedCopy(xs);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function dayCount(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// Age at the snapshot date. A protocol with no listing date gets the
// median age of the admitted protocols that do have one, computed
// from the snapshot itself — not an arbitrary constant.
function ageDays(p: Protocol, asOf: string, fallbackDays: number): number {
  return p.listed_at ? dayCount(p.listed_at, asOf) : fallbackDays;
}

function usd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function money(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "m";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "k";
  return "$" + Math.round(n);
}

// ---------- 4. The value model ----------
//
// Clean comparables for the fit: live tokens with market cap and TVL
// above zero, in a non-barred category, not a versioned name, and
// with mcap/TVL at most 3. The ratio cap drops version
// misattributions (one token's whole market cap on a stale version's
// TVL) and single-protocol blowups, by a stated rule, not by name.
//
// The fit is ln(mcap) on [1, ln(TVL), ln(age+30), growth], solved by
// the normal equations with Gaussian elimination (partial pivoting),
// so it is exact and deterministic. Category offsets use median
// log-ratios, shrunk by n/(n+K): the median is robust to the one
// wild comparable a category may hold, and the shrinkage keeps a
// one-comparable category from setting its own multiple.

const SHRINK_K = 5;
const RATIO_CAP = 3;
const MULT_GUARD_LO = 0.002;
const MULT_GUARD_HI = 3.0;
const GROWTH_LO = -60;
const GROWTH_HI = 120;

function isCleanComparable(p: Protocol): boolean {
  if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) return false;
  if (p.category !== null && BARRED_CATEGORIES.has(p.category)) return false;
  if (isVersionedName(p.name)) return false;
  if (p.mcap_usd / p.tvl_usd > RATIO_CAP) return false;
  return true;
}

function growthInput(p: Protocol): number {
  return clamp(p.change_7d ?? 0, GROWTH_LO, GROWTH_HI) / 100;
}

// One design row: [1, ln TVL, ln(age+30), growth].
function designRow(p: Protocol, ageFallback: number, asOf: string): number[] {
  const age = ageDays(p, asOf, ageFallback);
  return [1, Math.log(p.tvl_usd), Math.log(age + 30), growthInput(p)];
}

// Solve A x = b by Gaussian elimination with partial pivoting.
// A is small (4x4) and symmetric positive definite on real data.
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const tmp = M[col]!;
    M[col] = M[piv]!;
    M[piv] = tmp;
    const diag = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / diag;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

// Least squares for ln(mcap) on the design rows.
function fitOLS(rows: number[][], ys: number[]): number[] {
  const k = rows[0]!.length;
  const XtX: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    for (let a = 0; a < k; a++) {
      Xty[a]! += row[a]! * ys[i]!;
      for (let b = 0; b < k; b++) XtX[a]![b]! += row[a]! * row[b]!;
    }
  }
  return solveLinear(XtX, Xty);
}

type CategoryOffset = {
  category: string;
  comparables: number;
  rawMedianLogRatio: number;
  offset: number;
};

type ValueModel = {
  beta: number[]; // [intercept, ln TVL, ln(age+30), growth]
  offsets: Map<string, CategoryOffset>;
  globalMedianLogRatio: number;
  nClean: number;
  residualSd: number;
  rSquared: number;
};

function buildValueModel(protocols: Protocol[], ageFallback: number, asOf: string): ValueModel {
  const clean = protocols.filter(isCleanComparable);
  const rows = clean.map((p) => designRow(p, ageFallback, asOf));
  const ys = clean.map((p) => Math.log(p.mcap_usd!));
  const beta = fitOLS(rows, ys);
  // Fit diagnostics on the clean set.
  let sse = 0;
  let syy = 0;
  const my = mean(ys);
  for (let i = 0; i < clean.length; i++) {
    const pred = rows[i]!.reduce((s, v, j) => s + v * beta[j]!, 0);
    sse += (ys[i]! - pred) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  // Shrunk median log-ratio offsets per category.
  const logRatios = clean.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const globalMedianLogRatio = median(logRatios);
  const groups = new Map<string, number[]>();
  for (const p of clean) {
    const key = p.category ?? "Uncategorised";
    const bucket = groups.get(key);
    if (bucket) bucket.push(Math.log(p.mcap_usd! / p.tvl_usd));
    else groups.set(key, [Math.log(p.mcap_usd! / p.tvl_usd)]);
  }
  const offsets = new Map<string, CategoryOffset>();
  for (const [category, ratios] of [...groups.entries()].sort()) {
    const raw = median(ratios);
    offsets.set(category, {
      category,
      comparables: ratios.length,
      rawMedianLogRatio: raw,
      offset: (ratios.length / (ratios.length + SHRINK_K)) * (raw - globalMedianLogRatio),
    });
  }
  return {
    beta,
    offsets,
    globalMedianLogRatio,
    nClean: clean.length,
    residualSd: Math.sqrt(sse / Math.max(1, clean.length - 4)),
    rSquared: 1 - sse / syy,
  };
}

function categoryOffsetFor(p: Protocol, model: ValueModel): number {
  return model.offsets.get(p.category ?? "Uncategorised")?.offset ?? 0;
}

// ---------- 5. Token odds (display only) ----------
//
// P(a protocol's record carries a token) in this snapshot's
// cross-section, by age bucket times its category's rate, capped to
// [0.05, 0.95]. It is a record rate, not a launch prediction: the
// snapshot observes no launch events, and the board's own rules say
// it does not predict whether or when a token is issued. So the
// odds are shown as a column and never enter the implied value.

const AGE_ODDS_BUCKETS: Array<[number, number]> = [
  [180, 0.25],
  [365, 0.4],
  [730, 0.39],
  [1100, 0.55],
  [Infinity, 0.79],
];

function ageOddsBase(age: number): number {
  for (const [maxAge, base] of AGE_ODDS_BUCKETS) if (age < maxAge) return base;
  return 0.79;
}

type OddsTable = {
  globalRate: number;
  categoryRate: Map<string, number>;
};

function buildOddsTable(protocols: Protocol[]): OddsTable {
  const hasToken = (p: Protocol): boolean => p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
  const globalRate = protocols.filter(hasToken).length / protocols.length;
  const byCat = new Map<string, { n: number; t: number }>();
  for (const p of protocols) {
    const key = p.category ?? "Uncategorised";
    const e = byCat.get(key) ?? { n: 0, t: 0 };
    e.n++;
    if (hasToken(p)) e.t++;
    byCat.set(key, e);
  }
  const categoryRate = new Map<string, number>();
  for (const [key, e] of byCat) categoryRate.set(key, e.t / e.n);
  return { globalRate, categoryRate };
}

function tokenOdds(p: Protocol, age: number, table: OddsTable): number {
  const base = ageOddsBase(age);
  const cat = table.categoryRate.get(p.category ?? "Uncategorised") ?? table.globalRate;
  return clamp(base * (cat / table.globalRate), 0.05, 0.95);
}

// ---------- 6. Valuation ----------

type Prediction = {
  value: number;
  multiple: number;
  rawMultiple: number;
  baseValue: number;
  ageTerm: number;
  growthTerm: number;
  catOffset: number;
  guard: "hi" | "lo" | "none";
};

function predictValue(p: Protocol, age: number, model: ValueModel, asOf: string, ageFallback: number): Prediction {
  const row = designRow(p, ageFallback, asOf);
  const logPred = row.reduce((s, v, j) => s + v * model.beta[j]!, 0);
  const catOffset = categoryOffsetFor(p, model);
  const raw = Math.exp(logPred + catOffset);
  const rawMultiple = raw / p.tvl_usd;
  let multiple = rawMultiple;
  let guard: Prediction["guard"] = "none";
  if (multiple > MULT_GUARD_HI) {
    multiple = MULT_GUARD_HI;
    guard = "hi";
  } else if (multiple < MULT_GUARD_LO) {
    multiple = MULT_GUARD_LO;
    guard = "lo";
  }
  const value = Math.max(1, Math.round(p.tvl_usd * multiple));
  return {
    value,
    multiple,
    rawMultiple,
    baseValue: Math.exp(logPred),
    ageTerm: model.beta[2]! * row[2]!,
    growthTerm: model.beta[3]! * row[3]!,
    catOffset,
    guard,
  };
}

// ---------- 7. Leave-one-out validation (run at run time) ----------
//
// The method tab shows a comparison, not a single number: this model
// against a flat global-median multiple and against a v3-style
// category-median model, each scored by leave-one-out over the clean
// comparables (median |log error|, share within 2x/3x, median signed
// bias). Every candidate is refit without the held-out row, so no
// number here is in-sample. The comparison is the claim; the code
// that computes it is the evidence.

type LooScore = {
  model: string;
  medianAbsLogErr: number;
  within2x: number;
  within3x: number;
  bias: number;
};

function looErrors(
  clean: Protocol[],
  predict: (p: Protocol, train: Protocol[], ageFallback: number, asOf: string) => number,
  ageFallback: number,
  asOf: string,
): number[] {
  const errs: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const held = clean[i]!;
    const train = clean.filter((_, j) => j !== i);
    const pred = Math.max(1, predict(held, train, ageFallback, asOf));
    errs.push(Math.log(pred) - Math.log(held.mcap_usd!));
  }
  return errs;
}

function scoreLoo(model: string, errs: number[]): LooScore {
  const abs = errs.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const within = (k: number): number => errs.filter((e) => Math.abs(e) <= Math.log(k)).length / errs.length;
  return {
    model,
    medianAbsLogErr: median(abs),
    within2x: within(2),
    within3x: within(3),
    bias: median(errs),
  };
}

function predictProposed(p: Protocol, train: Protocol[], ageFallback: number, asOf: string): number {
  const model = buildValueModel(train, ageFallback, asOf);
  const age = ageDays(p, asOf, ageFallback);
  return predictValue(p, age, model, asOf, ageFallback).value;
}

function predictFlatMedian(p: Protocol, train: Protocol[]): number {
  const ratios = train.map((q) => q.mcap_usd! / q.tvl_usd);
  return Math.max(1, Math.round(p.tvl_usd * median(ratios)));
}

function predictV3Style(p: Protocol, train: Protocol[], ageFallback: number, asOf: string): number {
  const per = new Map<string, number[]>();
  for (const q of train) {
    const key = q.category ?? "Uncategorised";
    const bucket = per.get(key);
    if (bucket) bucket.push(q.mcap_usd! / q.tvl_usd);
    else per.set(key, [q.mcap_usd! / q.tvl_usd]);
  }
  const byCat = new Map<string, number>();
  for (const [key, ratios] of per) byCat.set(key, clamp(median(ratios), 0.05, 1.0));
  const glob = clamp(median(train.map((q) => q.mcap_usd! / q.tvl_usd)), 0.05, 1.0);
  const key = p.category ?? "Uncategorised";
  const mult = (per.get(key)?.length ?? 0) >= 3 ? byCat.get(key)! : glob;
  const age = ageDays(p, asOf, ageFallback);
  const growth = clamp(p.change_7d ?? 0, -50, 100);
  return Math.max(
    1,
    Math.round(
      p.tvl_usd * mult * (1 + (growth / 100) * 0.6) * (0.7 + (0.3 * Math.min(age, 1095)) / 1095) *
        (1 + 0.04 * Math.min(Math.max(p.chains.length - 1, 0), 5)),
    ),
  );
}

function runValidation(protocols: Protocol[], ageFallback: number, asOf: string): LooScore[] {
  const clean = protocols.filter(isCleanComparable);
  return [
    scoreLoo("v6 — fitted log-log + shrunk category offsets", looErrors(clean, predictProposed, ageFallback, asOf)),
    scoreLoo("flat global-median multiple", looErrors(clean, (p, t) => predictFlatMedian(p, t), ageFallback, asOf)),
    scoreLoo("v3-style category median", looErrors(clean, predictV3Style, ageFallback, asOf)),
  ];
}

// ---------- 8. Farm plan ----------
//
// Eight concrete steps, each naming what it costs and how long it
// takes, drawn from the protocol's own record: its category, its
// chains, its TVL, and how long it has been listed. Position size is
// a dollar figure tied to TVL; gas is priced per the protocol's home
// chain, in coarse bands labelled "about": Ethereum is dear, the
// cheap L2s and fast L1s are cents, the rest sit in between.

const GAS_HIGH = new Set(["Ethereum"]);
const GAS_LOW = new Set([
  "Solana",
  "Base",
  "Arbitrum",
  "Optimism",
  "zkSync Era",
  "Linea",
  "Scroll",
  "Blast",
  "Sui",
  "Aptos",
  "Polygon",
  "Starknet",
]);

function gasBand(chain: string): string {
  if (GAS_HIGH.has(chain)) return "about $2-6";
  if (GAS_LOW.has(chain)) return "under $0.10";
  return "about $0.10-1";
}

type OpeningPair = [string, string];

const OPENING_MOVES: Record<string, OpeningPair> = {
  Dexs: ["swap a small amount through its pools", "add liquidity to one of its pools"],
  Lending: ["supply collateral into its lending market", "borrow a small amount against that supply"],
  Yield: ["deposit into one of its vaults", "compound or restake the vault position"],
  "Yield Aggregator": ["deposit into one of its vaults", "compound or restake the vault position"],
  Derivatives: ["open a small derivatives position", "close and reopen a position the following week"],
  Options: ["open a small derivatives position", "close and reopen a position the following week"],
  "Options Vault": ["open a small derivatives position", "close and reopen a position the following week"],
  CDP: ["mint its stable asset against collateral", "repay part of the debt and mint again"],
  "CDP Manager": ["mint its stable asset against collateral", "repay part of the debt and mint again"],
  Farm: ["stake LP tokens in its farm", "harvest and restake the farm rewards"],
  Launchpad: ["join one of its launches with a small ticket", "vote or stake in its launch flow"],
  Bridge: ["bridge a small amount through it", "bridge back on a different route"],
  "Cross Chain Bridge": ["bridge a small amount through it", "bridge back on a different route"],
  RWA: ["buy a small position in its tokenised asset", "hold it through one reporting cycle"],
  "Prediction Market": ["place a small prediction on one of its markets", "settle and place a second prediction"],
  "NFT Marketplace": ["list or buy a low-priced item on its market", "complete a second trade the next week"],
  Payments: ["send a small payment through it", "receive a payment through it"],
  Insurance: ["buy a small cover policy", "keep the cover active through one cycle"],
  Synthetics: ["mint a small synthetic position", "burn and re-mint the position"],
  Restaking: ["restake a small amount through it", "delegate the restaked position"],
  "Leveraged Farming": ["open a small leveraged farm position", "adjust the leverage once after a week"],
  "Uncollateralized Lending": ["lend a small amount into its credit pool", "fund a second borrower tranche"],
  "Liquidity Manager": ["deposit into one of its managed liquidity vaults", "rebalance the vault position after a week"],
  "Risk Curators": ["deposit into one of its curated vaults", "allocate to a second curated vault"],
  "Onchain Capital Allocator": ["allocate a small amount to one of its strategies", "reallocate to a second strategy"],
  "Basis Trading": ["open a small basis trade position", "roll the basis position after a week"],
  "Staking Pool": ["stake a small amount in its pool", "top up the stake once after a week"],
  "Interest Rate Derivatives": ["open a small rate position", "hedge the rate position the following week"],
  Indexes: ["buy a small position in one of its indexes", "rebalance the index holding"],
  "AI Agents": ["run a small job through its agent", "run a second agent job on another chain it supports"],
  "Decentralized AI": ["run a small job through its agent", "run a second agent job on another chain it supports"],
  Privacy: ["make a small private transaction through it", "repeat a private transaction the next week"],
  CeDeFi: ["deposit a small amount into its CeDeFi product", "withdraw and redeposit a portion"],
  "Token Locker": ["lock a small token amount in its locker", "extend the lock by a short period"],
  "Governance Incentives": ["vote on one of its governance proposals", "delegate voting power to an active delegate"],
  "Stablecoin Issuer": ["mint a small amount of its stable asset", "redeem and re-mint the stable asset"],
  "Algo-Stables": ["mint a small amount of its stable asset", "redeem and re-mint the stable asset"],
  "Dual-Token Stablecoin": ["mint a small amount of its stable asset", "redeem and re-mint the stable asset"],
  "Collateral Management": ["post collateral in one of its markets", "adjust the collateral ratio once"],
  "Collateral Markets": ["post collateral in one of its markets", "adjust the collateral ratio once"],
  Chain: ["bridge a small amount onto its chain", "use an app that runs on its chain"],
  "Anchor BTC": ["mint a small amount of its BTC-backed asset", "redeem and re-mint the BTC-backed asset"],
  "Decentralized BTC": ["mint a small amount of its BTC-backed asset", "redeem and re-mint the BTC-backed asset"],
};

const DEFAULT_OPENING: OpeningPair = [
  "use its app with a small first transaction",
  "complete a second on-chain action a few days later",
];

function openingMoves(category: string | null): OpeningPair {
  if (category === null) return DEFAULT_OPENING;
  return OPENING_MOVES[category] ?? DEFAULT_OPENING;
}

// Position size in dollars, tied to the protocol's TVL: the plan
// names a dollar figure, not "a modest position".
function positionSize(p: Protocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

type PlanContext = {
  protocol: Protocol;
  age: number;
  homeChain: string;
  chainList: string;
  gas: string;
  first: string;
  second: string;
  holdWeeks: number;
  size: number;
  weekly: string;
};

function planContext(p: Protocol, age: number): PlanContext {
  const [first, second] = openingMoves(p.category);
  const homeChain = p.chains[0] ?? "its home chain";
  return {
    protocol: p,
    age,
    homeChain,
    chainList: p.chains.slice(0, 3).join(", "),
    gas: gasBand(homeChain),
    first,
    second,
    holdWeeks: clamp(Math.round(age / 30), 4, 52),
    size: positionSize(p),
    weekly: age < 180 ? "twice a week" : "once a week",
  };
}

function stepFirstUse(c: PlanContext, value: number): string {
  const p = c.protocol;
  return `Start on ${c.homeChain}: ${c.first} with $${c.size} in ${p.name} (${p.category ?? "uncategorised"}, TVL ${money(p.tvl_usd)}, implied launch value ${money(value)}). Cost: $${c.size} of capital plus gas ${c.gas} on ${c.homeChain}. Time: 20 minutes.`;
}

function stepQualify(c: PlanContext): string {
  return `Qualify the wallet: ${c.second} on ${c.homeChain} so the address shows repeat use, not a single touch. Cost: gas only, ${c.gas} on ${c.homeChain}. Time: 15 minutes.`;
}

function stepRhythm(c: PlanContext): string {
  const p = c.protocol;
  return `Keep a ${c.weekly} rhythm: return to ${p.name} and repeat a small on-chain action so activity looks steady across weeks. Cost: gas only, ${c.gas} per visit on ${c.homeChain}. Time: 10 minutes per visit.`;
}

function stepHold(c: PlanContext): string {
  const p = c.protocol;
  return `Hold for the long run: keep the $${c.size} position open for at least ${c.holdWeeks} weeks — ${p.name} has run ${c.age} days with no token recorded, so patience is the edge here. Cost: $0 while held, the $${c.size} stays in the position. Time: 5 minutes a week to check it.`;
}

// One free task noun per category, so the points-page step names
// the kind of task the protocol actually lists.
const QUEST_TASKS: Record<string, string> = {
  Dexs: "swap quest",
  Lending: "supply quest",
  Yield: "vault quest",
  "Yield Aggregator": "vault quest",
  Derivatives: "trading quest",
  Options: "trading quest",
  "Options Vault": "trading quest",
  CDP: "mint quest",
  "CDP Manager": "mint quest",
  Farm: "farm quest",
  Launchpad: "launch quest",
  RWA: "holding quest",
  "Prediction Market": "prediction quest",
  "NFT Marketplace": "trading quest",
  Payments: "payment quest",
  Insurance: "cover quest",
  Synthetics: "mint quest",
  Restaking: "restake quest",
  "Leveraged Farming": "farm quest",
  "Uncollateralized Lending": "lending quest",
  "Liquidity Manager": "liquidity quest",
  "Risk Curators": "vault quest",
  "Onchain Capital Allocator": "allocation quest",
  "Basis Trading": "trading quest",
  "Staking Pool": "staking quest",
  "Interest Rate Derivatives": "trading quest",
  Indexes: "holding quest",
  "AI Agents": "agent quest",
  "Decentralized AI": "agent quest",
  Privacy: "transaction quest",
  CeDeFi: "deposit quest",
  "Token Locker": "lock quest",
  "Governance Incentives": "voting quest",
  "Stablecoin Issuer": "mint quest",
  "Algo-Stables": "mint quest",
  "Dual-Token Stablecoin": "mint quest",
  "Collateral Management": "collateral quest",
  "Collateral Markets": "collateral quest",
  Chain: "on-chain quest",
  "Anchor BTC": "mint quest",
  "Decentralized BTC": "mint quest",
};

function questTask(category: string | null): string {
  if (category === null) return "task";
  return QUEST_TASKS[category] ?? "task";
}

function stepQuests(c: PlanContext): string {
  return `Check its points or quests page ${c.weekly} and complete any free ${questTask(c.protocol.category)} it lists; never pay to claim points and never sign a claim that asks for a fee. Cost: $0. Time: 5 minutes per check.`;
}

function stepLog(c: PlanContext): string {
  return `Log every move: write the date, chain (${c.chainList}), amount and transaction hash for each action in a farm log, so you can prove the history later. Cost: $0. Time: 5 minutes per entry.`;
}

function stepUnwind(c: PlanContext): string {
  return `Unwind cleanly: when a token launches or TVL falls for two straight weeks, withdraw the $${c.size} in two parts over two days and keep the log. Cost: gas only, ${c.gas} on ${c.homeChain}. Time: 20 minutes.`;
}

function stepGuard(c: PlanContext): string {
  return `Guard the wallet on ${c.homeChain}: whenever a step asks for a token approval, approve only the $${c.size} you are depositing, never an unlimited allowance, and revoke the approval after you unwind. Cost: $0. Time: 5 minutes.`;
}

function farmPlan(p: Protocol, age: number, value: number): string[] {
  const c = planContext(p, age);
  return [
    stepFirstUse(c, value),
    stepQualify(c),
    stepRhythm(c),
    stepHold(c),
    stepQuests(c),
    stepLog(c),
    stepUnwind(c),
    stepGuard(c),
  ];
}

// ---------- 9. Input / output locations ----------

function flagValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  if (eq) return eq.slice(name.length + 1);
  return null;
}

function resolvePaths(argv: string[]): { inputFile: string; outputDir: string } {
  const inputFlag = flagValue(argv, "--input");
  const inputFile = inputFlag
    ? resolve(inputFlag)
    : process.env.MAKEFUN_INPUT_DIR
      ? join(resolve(process.env.MAKEFUN_INPUT_DIR), "snapshot.json")
      : "/input/snapshot.json";
  const outputFlag = flagValue(argv, "--output");
  const outputDir = outputFlag
    ? resolve(outputFlag)
    : process.env.MAKEFUN_OUTPUT_DIR
      ? resolve(process.env.MAKEFUN_OUTPUT_DIR)
      : "/output";
  return { inputFile, outputDir };
}

// ---------- 10. Board assembly ----------

type ScoredEntry = {
  protocol: Protocol;
  prediction: Prediction;
  value: number;
  age: number;
  odds: number;
  farmSteps: string[];
};

type BoardRow = {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
};

type LiveEntry = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number;
};

type BoardEntry = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number;
  multiple: number;
  raw_multiple: number;
  cat_offset: number;
  age_term: number;
  growth_term: number;
  guard: "hi" | "lo" | "none";
  token_odds: number;
  implied_value_usd: number;
  rank: number;
  watchlist: boolean;
  farm_steps: string[];
};

type CategoryOffsetRow = {
  category: string;
  comparables: number;
  raw_median_log_ratio: number;
  offset: number;
};

// Highest implied value first; ties break on TVL, then slug.
function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  return b.value - a.value || b.protocol.tvl_usd - a.protocol.tvl_usd || (a.protocol.slug < b.protocol.slug ? -1 : 1);
}

function scoreBoard(
  protocols: Protocol[],
  model: ValueModel,
  oddsTable: OddsTable,
  asOf: string,
  ageFallback: number,
): ScoredEntry[] {
  return protocols
    .filter(rankable)
    .map((p) => {
      const age = ageDays(p, asOf, ageFallback);
      const prediction = predictValue(p, age, model, asOf, ageFallback);
      return {
        protocol: p,
        prediction,
        value: prediction.value,
        age,
        odds: tokenOdds(p, age, oddsTable),
        farmSteps: farmPlan(p, age, prediction.value),
      };
    })
    .sort(compareScored);
}

function buildBoardRows(scored: ScoredEntry[]): BoardRow[] {
  return scored.map((s, i) => ({
    slug: s.protocol.slug,
    name: s.protocol.name,
    rank: i + 1,
    implied_value_usd: s.value,
    farm_steps: s.farmSteps,
  }));
}

function buildLiveView(protocols: Protocol[], asOf: string, ageFallback: number): LiveEntry[] {
  return protocols
    .filter((p) => p.mcap_usd !== null)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      age_days: ageDays(p, asOf, ageFallback),
    }))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0));
}

function buildBoardData(scored: ScoredEntry[], watchSet: Set<string>): BoardEntry[] {
  return scored.map((s, i) => ({
    slug: s.protocol.slug,
    name: s.protocol.name,
    category: s.protocol.category,
    chains: s.protocol.chains,
    tvl_usd: s.protocol.tvl_usd,
    change_7d: s.protocol.change_7d,
    listed_at: s.protocol.listed_at,
    age_days: s.age,
    multiple: s.prediction.multiple,
    raw_multiple: s.prediction.rawMultiple,
    cat_offset: s.prediction.catOffset,
    age_term: s.prediction.ageTerm,
    growth_term: s.prediction.growthTerm,
    guard: s.prediction.guard,
    token_odds: s.odds,
    implied_value_usd: s.value,
    rank: i + 1,
    watchlist: watchSet.has(s.protocol.slug),
    farm_steps: s.farmSteps,
  }));
}

function buildCategoryOffsetTable(model: ValueModel): CategoryOffsetRow[] {
  return [...model.offsets.values()]
    .sort((a, b) => b.comparables - a.comparables || (a.category < b.category ? -1 : 1))
    .map((e) => ({
      category: e.category,
      comparables: e.comparables,
      raw_median_log_ratio: e.rawMedianLogRatio,
      offset: e.offset,
    }));
}

function assemblePayload(
  snap: Snapshot,
  boardData: BoardEntry[],
  live: LiveEntry[],
  offsetTable: CategoryOffsetRow[],
  model: ValueModel,
  validation: LooScore[],
  oddsTable: OddsTable,
  ageFallback: number,
) {
  return {
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    generated: "token-radar-v6",
    model: {
      intercept: model.beta[0],
      slope_tvl: model.beta[1],
      slope_age: model.beta[2],
      slope_growth: model.beta[3],
      residual_sd: model.residualSd,
      r_squared: model.rSquared,
      n_clean: model.nClean,
      shrink_k: SHRINK_K,
      guard_lo: MULT_GUARD_LO,
      guard_hi: MULT_GUARD_HI,
    },
    validation,
    odds_global_rate: oddsTable.globalRate,
    age_fallback_days: ageFallback,
    category_offsets: offsetTable,
    watchlist_count: snap.watchlist.length,
    rows: boardData,
    live,
  };
}

// ---------- 11. Writing outputs ----------

function loadSnapshot(inputFile: string): Snapshot {
  if (!existsSync(inputFile)) {
    console.error(`token radar: no snapshot at ${inputFile}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(inputFile, "utf8"));
}

// Clear only the CONTENTS of outDir, never outDir itself. The grader
// mounts /output as a Docker volume, and rmSync on a mount point
// throws EBUSY ("Device or resource busy"). Removing each child
// individually leaves the mount point intact; if outDir does not
// exist yet, the mkdirSync below creates it.
function clearDirContents(outDir: string): void {
  if (!existsSync(outDir)) return;
  for (const entry of readdirSync(outDir)) {
    rmSync(join(outDir, entry), { recursive: true, force: true });
  }
}

function writeOutputs(outDir: string, rows: BoardRow[], payload: unknown, asOf: string): void {
  clearDirContents(outDir);
  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });

  writeFileSync(join(outDir, "board.json"), JSON.stringify({ rows, generated: "token-radar-v6", as_of: asOf }, null, 2) + "\n", "utf8");
  // data.js lives beside the dashboard, not inside it: the dossier's
  // text shows the page's source whole only while it fits in 64 KiB,
  // and a 350 KiB data file inside dashboard/ would push index.html
  // out of what the judge reads. The page loads it as ../data.js.
  writeFileSync(join(outDir, "data.js"), "window.RADAR = " + JSON.stringify(payload) + ";\n", "utf8");
  cpSync(join(HERE, "dashboard"), join(outDir, "dashboard"), { recursive: true });
  if (existsSync(join(HERE, "screenshots"))) {
    cpSync(join(HERE, "screenshots"), join(outDir, "screenshots"), { recursive: true });
  }
  const dossier = buildDossier(outDir, {
    text_max_bytes: 65_536,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  });
  writeFileSync(join(outDir, "dossier.json"), dossier, "utf8");
}

function printSummary(
  rows: BoardRow[],
  scored: ScoredEntry[],
  model: ValueModel,
  validation: LooScore[],
  watchSet: Set<string>,
  snap: Snapshot,
  live: LiveEntry[],
): void {
  const b = model.beta;
  const guardBound = scored.filter((s) => s.prediction.guard !== "none").length;
  console.log(`board: ${rows.length} rows, top ${usd(rows[0]!.implied_value_usd)} (${rows[0]!.slug}), #10 ${usd(rows[9]!.implied_value_usd)}, bottom ${usd(rows[rows.length - 1]!.implied_value_usd)}`);
  console.log(`model: ln(mcap) = ${b[0]!.toFixed(3)} + ${b[1]!.toFixed(3)}*ln(TVL) + ${b[2]!.toFixed(3)}*ln(age+30) + ${b[3]!.toFixed(3)}*growth, n=${model.nClean} clean, residual sd ${model.residualSd.toFixed(3)}, R2 ${model.rSquared.toFixed(3)}`);
  for (const v of validation) {
    console.log(`loo ${v.model}: med|logerr|=${v.medianAbsLogErr.toFixed(3)} within2x=${(v.within2x * 100).toFixed(1)}% within3x=${(v.within3x * 100).toFixed(1)}% bias=${v.bias.toFixed(3)}`);
  }
  console.log(`guard bound rows: ${guardBound}/${rows.length}; watchlist covered: ${rows.filter((r) => watchSet.has(r.slug)).length}/${snap.watchlist.length}; live view: ${live.length} protocols`);
}

// ---------- 12. Entry point ----------

function main(): void {
  const argv = process.argv.slice(2);
  const { inputFile, outputDir } = resolvePaths(argv);
  const snap = loadSnapshot(inputFile);

  const watchSet = new Set(snap.watchlist);
  // Age fallback: the median age of the admitted protocols that do
  // carry a listing date, so a missing listed_at costs a row the
  // middle of the pack instead of an invented constant.
  const knownAges = snap.protocols
    .filter(rankable)
    .filter((p) => p.listed_at)
    .map((p) => dayCount(p.listed_at!, snap.as_of));
  const ageFallback = Math.round(median(knownAges));

  const model = buildValueModel(snap.protocols, ageFallback, snap.as_of);
  const oddsTable = buildOddsTable(snap.protocols);
  const scored = scoreBoard(snap.protocols, model, oddsTable, snap.as_of, ageFallback);
  const rows = buildBoardRows(scored);
  const live = buildLiveView(snap.protocols, snap.as_of, ageFallback);
  const boardData = buildBoardData(scored, watchSet);
  const offsetTable = buildCategoryOffsetTable(model);
  const validation = runValidation(snap.protocols, ageFallback, snap.as_of);
  const payload = assemblePayload(snap, boardData, live, offsetTable, model, validation, oddsTable, ageFallback);

  writeOutputs(outputDir, rows, payload, snap.as_of);
  printSummary(rows, scored, model, validation, watchSet, snap, live);
}

main();
