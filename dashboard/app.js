// Token Radar dashboard: renders window.RADAR (written by main.ts as
// ../data.js, beside this page). No network: every number on the page
// comes from the snapshot payload.
//
// Structure of this file:
//   1. Snapshot guard
//   2. DOM and text helpers
//   3. Valuation model (mirrors main.ts, so the detail view can
//      recompute a row and check it against the board)
//   4. UI state and the shareable URL
//   5. Filter controls and the header stats
//   6. Filtering and sorting (board and live views)
//   7. Row builders (one function per table row shape)
//   8. View renderers
//   9. Tabs and navigation
//  10. Event wiring
//  11. Startup
(function () {
  "use strict";

  // ---------------------------------------------------------------
  // 1. Snapshot guard
  // ---------------------------------------------------------------
  var snapshot = window.RADAR;
  if (!snapshot) {
    document.body.innerHTML = "<p style='padding:30px'>Dashboard data (data.js) did not load.</p>";
    return;
  }

  // ---------------------------------------------------------------
  // 2. DOM and text helpers
  // ---------------------------------------------------------------
  function byId(id) { return document.getElementById(id); }

  function fmtUsd(n) { return "$" + Math.round(n).toLocaleString("en-US"); }

  function fmtTvl(n) {
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "b";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "m";
    return "$" + Math.round(n / 1e3) + "k";
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function watchBadge() { return "<span class='badge'>WATCHLIST</span>"; }

  function mutedSlug(slug) {
    return "<span style='color:var(--mut);font-size:12px'>" + esc(slug) + "</span>";
  }

  function fmtPct(x) { return (x * 100).toFixed(0) + "%"; }

  // ---------------------------------------------------------------
  // 3. Valuation model — the same formula main.ts uses, so the
  //    detail view can recompute a row and check it against the
  //    board. The regression coefficients come from the payload
  //    (fit at run time on the snapshot's clean live tokens), never
  //    from a hardcoded constant in this file.
  // ---------------------------------------------------------------
  function growthInput(row) {
    return clamp(row.change_7d === null ? 0 : row.change_7d, -60, 120) / 100;
  }

  function logPred(row) {
    var m = snapshot.model;
    return m.intercept + m.slope_tvl * Math.log(row.tvl_usd) +
      m.slope_age * Math.log(row.age_days + 30) + m.slope_growth * growthInput(row);
  }

  function rawMultiple(row) {
    return Math.exp(logPred(row) + row.cat_offset) / row.tvl_usd;
  }

  function guardedMultiple(row) {
    return clamp(rawMultiple(row), snapshot.model.guard_lo, snapshot.model.guard_hi);
  }

  function recompute(row) {
    return Math.max(1, Math.round(row.tvl_usd * guardedMultiple(row)));
  }

  function fmtLog(x) {
    return (x >= 0 ? "+" : "") + x.toFixed(3);
  }

  // ---------------------------------------------------------------
  // 4. UI state and the shareable URL
  // ---------------------------------------------------------------
  var ui = {
    q: "", cat: "", chain: "", watch: false,
    tab: "pre", sort: "rank", dir: 1,
    liveSort: "mcap_usd", liveDir: -1, slug: null
  };

  function readParams() {
    var params = new URLSearchParams(location.search);
    if (params.get("q")) ui.q = params.get("q");
    if (params.get("category")) ui.cat = params.get("category");
    if (params.get("chain")) ui.chain = params.get("chain");
    if (params.get("watchlist") === "1") ui.watch = true;
    if (params.get("tab") === "live") ui.tab = "live";
    if (params.get("tab") === "method") ui.tab = "method";
    if (params.get("slug")) ui.slug = params.get("slug");
  }

  function buildQuery() {
    var p = new URLSearchParams();
    if (ui.q) p.set("q", ui.q);
    if (ui.cat) p.set("category", ui.cat);
    if (ui.chain) p.set("chain", ui.chain);
    if (ui.watch) p.set("watchlist", "1");
    if (ui.tab === "live") p.set("tab", "live");
    if (ui.tab === "method") p.set("tab", "method");
    if (ui.slug) p.set("slug", ui.slug);
    return p.toString();
  }

  function syncUrl() {
    var qs = buildQuery();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }

  // ---------------------------------------------------------------
  // 5. Filter controls and the header stats
  // ---------------------------------------------------------------
  function distinctCategories() {
    var seen = {};
    snapshot.rows.forEach(function (r) { seen[r.category || "Uncategorised"] = true; });
    return Object.keys(seen).sort();
  }

  function distinctChains() {
    var seen = {};
    snapshot.rows.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = true; }); });
    snapshot.live.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  function fillSelect(el, values) {
    values.forEach(function (v) {
      var o = document.createElement("option");
      o.value = v; o.textContent = v; el.appendChild(o);
    });
  }

  function populateFilters() {
    fillSelect(byId("cat"), distinctCategories());
    fillSelect(byId("chain"), distinctChains());
  }

  function applyControlValues() {
    byId("q").value = ui.q;
    byId("cat").value = ui.cat;
    byId("chain").value = ui.chain;
    byId("watchonly").checked = ui.watch;
  }

  function renderStats() {
    var top = snapshot.rows[0];
    var tenth = snapshot.rows[9];
    byId("stats").innerHTML =
      "<div><b>" + snapshot.rows.length + "</b><span>pre-token ranked</span></div>" +
      "<div><b>" + snapshot.watchlist_count + "</b><span>watchlist covered</span></div>" +
      "<div><b>" + fmtTvl(top.implied_value_usd) + "</b><span>top implied value</span></div>" +
      "<div><b>" + (top.implied_value_usd / tenth.implied_value_usd).toFixed(1) + "×</b><span>#1 / #10 spread</span></div>" +
      "<div><b>" + snapshot.live.length + "</b><span>live-token comparables</span></div>";
    byId("asof").textContent = snapshot.as_of;
    byId("footcount").textContent = snapshot.rows.length + " ranked, " + snapshot.watchlist_count + " of them on the watchlist";
  }

  // ---------------------------------------------------------------
  // 6. Filtering and sorting (board and live views share the
  //    search / category / chain controls; the watchlist toggle
  //    applies to the board only, since live rows are never on it)
  // ---------------------------------------------------------------
  function matchesSearch(row, q) {
    if (!q) return true;
    var needle = q.trim().toLowerCase();
    return row.name.toLowerCase().indexOf(needle) !== -1 ||
      row.slug.toLowerCase().indexOf(needle) !== -1;
  }

  function passesFilters(row, boardOnly) {
    if (boardOnly && ui.watch && !row.watchlist) return false;
    if (ui.cat && (row.category || "Uncategorised") !== ui.cat) return false;
    if (ui.chain && row.chains.indexOf(ui.chain) === -1) return false;
    return matchesSearch(row, ui.q);
  }

  function filteredRows() {
    return snapshot.rows.filter(function (r) { return passesFilters(r, true); });
  }

  function filteredLive() {
    return snapshot.live.filter(function (r) { return passesFilters(r, false); });
  }

  function sortValue(row, key) {
    if (key === "chains") return row.chains.length;
    if (key === "ratio") return row.tvl_usd > 0 ? (row.mcap_usd || 0) / row.tvl_usd : -Infinity;
    return row[key];
  }

  function compareRows(a, b) {
    var va = sortValue(a, ui.sort), vb = sortValue(b, ui.sort);
    if (typeof va === "string") return ui.dir * va.localeCompare(vb);
    return ui.dir * ((va === null || va === undefined ? -Infinity : va) - (vb === null || vb === undefined ? -Infinity : vb));
  }

  function compareLive(a, b) {
    var va = sortValue(a, ui.liveSort), vb = sortValue(b, ui.liveSort);
    if (typeof va === "string") return ui.liveDir * va.localeCompare(vb);
    return ui.liveDir * ((va === null || va === undefined ? -Infinity : va) - (vb === null || vb === undefined ? -Infinity : vb));
  }

  function sortRows(list) {
    return list.slice().sort(compareRows);
  }

  function sortLive(list) {
    return list.slice().sort(compareLive);
  }

  // ---------------------------------------------------------------
  // 7. Row builders — one function per table row shape, so each view
  //    renderer just maps its rows through its builder.
  // ---------------------------------------------------------------
  function changeLabel(row) {
    if (row.change_7d === null) return "—";
    return (row.change_7d >= 0 ? "+" : "") + row.change_7d.toFixed(1) + "%";
  }

  function changeClass(row) {
    if (row.change_7d === null) return "";
    return row.change_7d >= 0 ? "pos" : "neg";
  }

  function chainPills(chains) {
    return chains.slice(0, 3).map(function (c) {
      return "<span class='pill'>" + esc(c) + "</span>";
    }).join("");
  }

  function planSummary(row) {
    var size = row.farm_steps[0].match(/\$(\d+) in /);
    var hold = row.farm_steps[3].match(/at least (\d+) weeks/);
    return "<b>" + row.farm_steps.length + " steps</b> · $" + (size ? size[1] : "?") +
      " · hold " + (hold ? hold[1] : "?") + " wks";
  }

  function boardRow(r) {
    var guard = r.guard === "none" ? "" : " <span class='src'>(" + r.guard + " guard)</span>";
    var top = r.rank <= 3 ? " class='top3'" : "";
    return "<tr data-slug='" + esc(r.slug) + "'" + top + "><td class='num'>#" + r.rank + "</td>" +
      "<td><b>" + esc(r.name) + "</b>" + (r.watchlist ? watchBadge() : "") +
      "<br>" + mutedSlug(r.slug) + "</td>" +
      "<td>" + esc(r.category || "—") + "</td>" +
      "<td>" + chainPills(r.chains) + "</td>" +
      "<td class='num'>" + fmtTvl(r.tvl_usd) + "</td>" +
      "<td class='num " + changeClass(r) + "'>" + changeLabel(r) + "</td>" +
      "<td class='num'>" + r.age_days + "d</td>" +
      "<td class='num'>" + r.multiple.toFixed(3) + "×" + guard + "</td>" +
      "<td class='num'><b>" + fmtUsd(r.implied_value_usd) + "</b></td>" +
      "<td class='num'>" + fmtPct(r.token_odds) + "</td>" +
      "<td>" + planSummary(r) + "</td></tr>";
  }

  function liveRow(r) {
    var ratio = r.tvl_usd > 0 ? (r.mcap_usd / r.tvl_usd).toFixed(2) + "×" : "—";
    return "<tr><td><b>" + esc(r.name) + "</b><br>" + mutedSlug(r.slug) + "</td>" +
      "<td>" + esc(r.category || "—") + "</td>" +
      "<td class='num'>" + fmtTvl(r.tvl_usd) + "</td>" +
      "<td class='num'><b>" + fmtUsd(r.mcap_usd) + "</b></td>" +
      "<td class='num'>" + ratio + "</td>" +
      "<td class='num'>" + r.age_days + "d</td></tr>";
  }

  // The category-offset table: raw median log ratio of the category's
  // live tokens, and the shrunken offset the board actually uses.
  function offsetMiniRow(b) {
    return "<tr><td>" + esc(b.category) + "</td><td class='num'>" + b.comparables + "</td>" +
      "<td class='num'>" + fmtLog(b.raw_median_log_ratio) + "</td><td class='num'>" + fmtLog(b.offset) + "</td></tr>";
  }

  function offsetFullRow(b) {
    return offsetMiniRow(b);
  }

  function looRow(v) {
    return "<tr><td><b>" + esc(v.model) + "</b></td>" +
      "<td class='num'>" + v.medianAbsLogErr.toFixed(3) + " (×" + Math.exp(v.medianAbsLogErr).toFixed(2) + ")</td>" +
      "<td class='num'>" + (v.within2x * 100).toFixed(1) + "%</td>" +
      "<td class='num'>" + (v.within3x * 100).toFixed(1) + "%</td>" +
      "<td class='num'>" + (v.bias >= 0 ? "+" : "") + v.bias.toFixed(3) + "</td></tr>";
  }

  function modelSummaryRow() {
    var m = snapshot.model;
    return "<tr><td><b>Regression (all clean live tokens)</b></td><td class='num'>" + m.n_clean + "</td>" +
      "<td class='num'>ln(mcap) = " + m.intercept.toFixed(2) + " + " + m.slope_tvl.toFixed(2) + " · ln(TVL) + " +
      m.slope_age.toFixed(2) + " · ln(age+30) + " + m.slope_growth.toFixed(2) + " · growth</td>" +
      "<td class='num'>residual sd " + m.residual_sd.toFixed(2) + ", R² " + m.r_squared.toFixed(2) + "</td></tr>";
  }

  // ---------------------------------------------------------------
  // 8. View renderers
  // ---------------------------------------------------------------
  function renderBoard() {
    var list = sortRows(filteredRows());
    byId("count").textContent = list.length + " of " + snapshot.rows.length + " protocols";
    byId("rows").innerHTML = list.map(boardRow).join("");
  }

  function renderLive() {
    var list = sortLive(filteredLive());
    byId("count").textContent = list.length + " of " + snapshot.live.length + " live tokens";
    byId("liverows").innerHTML = list.map(liveRow).join("");
  }

  function renderTopChart() {
    var top = snapshot.rows.slice(0, 10);
    var max = top[0].implied_value_usd;
    byId("topchart").innerHTML = top.map(function (r) {
      var w = Math.max(2, Math.round((r.implied_value_usd / max) * 100));
      return "<div class='bar-row'><span class='bar-rank'>#" + r.rank + "</span>" +
        "<span class='bar-name'>" + esc(r.name) + "</span>" +
        "<span class='bar-track'><span class='bar-fill' style='width:" + w + "%'></span></span>" +
        "<span class='bar-val'>" + fmtUsd(r.implied_value_usd) + "</span></div>";
    }).join("");
  }

  // The offset strip on the board: the eight categories with the most
  // live-token comparables, so the pricing basis is visible without
  // opening the method tab.
  function renderBenchMini() {
    byId("benchminirows").innerHTML = snapshot.category_offsets.slice(0, 8).map(offsetMiniRow).join("");
  }

  // The full offset table in the method tab, plus the leave-one-out
  // comparison and the fitted coefficients.
  function renderComps() {
    var rows = snapshot.category_offsets.map(offsetFullRow);
    rows.push(modelSummaryRow());
    byId("compsrows").innerHTML = rows.join("");
    byId("loorows").innerHTML = snapshot.validation.map(looRow).join("");
    byId("agefallback").textContent = snapshot.age_fallback_days + " days";
    byId("ols-intercept").textContent = snapshot.model.intercept.toFixed(3);
    byId("ols-slope-tvl").textContent = snapshot.model.slope_tvl.toFixed(3);
    byId("ols-slope-age").textContent = snapshot.model.slope_age.toFixed(3);
    byId("ols-slope-growth").textContent = snapshot.model.slope_growth.toFixed(3);
    byId("ols-n").textContent = snapshot.model.n_clean;
    byId("ols-sd").textContent = snapshot.model.residual_sd.toFixed(3);
    byId("ols-r2").textContent = snapshot.model.r_squared.toFixed(3);
  }

  function growthLabel(row) {
    if (row.change_7d === null) return "not reported";
    return (row.change_7d >= 0 ? "+" : "") + row.change_7d.toFixed(2) + "%";
  }

  function modelSentence(row) {
    var m = snapshot.model;
    var s = "ln(market cap) = " + m.intercept.toFixed(2) + " + " + m.slope_tvl.toFixed(2) +
      " · ln(TVL) + " + m.slope_age.toFixed(2) + " · ln(age + 30) + " + m.slope_growth.toFixed(2) +
      " · growth, shifted " + fmtLog(row.cat_offset) + " by its category offset";
    if (row.guard === "none") {
      s += ". The implied multiple sits inside the [" + m.guard_lo.toFixed(3) + ", " +
        m.guard_hi.toFixed(1) + "] guard, so no bound binds.";
    } else {
      s += ". The implied multiple hit the " + row.guard + " guard of [" + m.guard_lo.toFixed(3) +
        ", " + m.guard_hi.toFixed(1) + "] and was held there.";
    }
    return s;
  }

  // The factor breakdown: every number that goes into the implied
  // value, so the detail view shows the multiplication the board was
  // ranked on instead of just stating the result.
  function factorRows(row) {
    var m = snapshot.model;
    var logTvl = Math.log(row.tvl_usd);
    var base = Math.exp(logPred(row));
    var rawMult = rawMultiple(row);
    var f = [
      ["TVL", fmtTvl(row.tvl_usd), "the protocol's locked value at the snapshot"],
      ["ln(TVL)", logTvl.toFixed(3), "the regression's input: the log of locked value"],
      ["Regression base", fmtUsd(base), "exp(" + m.intercept.toFixed(2) + " + " + m.slope_tvl.toFixed(2) + " · ln(TVL) + " + m.slope_age.toFixed(2) + " · ln(age+30) + " + m.slope_growth.toFixed(2) + " · growth) — the prediction before any category offset"],
      ["Age term", fmtLog(row.age_term), "the fitted age coefficient times ln(age + 30), inside the regression base above"],
      ["Growth term", fmtLog(row.growth_term), "the fitted growth coefficient times the clamped 7-day change, inside the regression base above"],
      ["Category offset", fmtLog(row.cat_offset), "the shrunken median log-ratio offset of " + (row.category || "its category") + ", added in log space"]
    ];
    // When no guard binds the raw and used multiples are the same
    // number, so one row says it; when a guard binds, both rows
    // appear so the clamping is visible.
    if (row.guard === "none") {
      f.push(["Implied multiple", row.multiple.toFixed(3) + "×", "predicted market cap ÷ TVL, inside the [" + m.guard_lo.toFixed(3) + ", " + m.guard_hi.toFixed(1) + "] guard — no bound binds"]);
    } else {
      f.push(["Implied multiple (raw)", rawMult.toFixed(3) + "×", "predicted market cap ÷ TVL, before the guard"]);
      f.push(["Implied multiple (used)", row.multiple.toFixed(3) + "× (" + row.guard + " guard)", "the raw multiple inside the [" + m.guard_lo.toFixed(3) + ", " + m.guard_hi.toFixed(1) + "] guard"]);
    }
    f.push(["Token odds", fmtPct(row.token_odds), "record rate, shown only — it never enters the implied value"]);
    f.push(["Implied value", fmtUsd(row.implied_value_usd), "TVL × multiple used"]);
    return f.map(function (r) {
      return "<tr><td>" + esc(r[0]) + "</td><td class='num'><b>" + esc(r[1]) + "</b></td><td>" + esc(r[2]) + "</td></tr>";
    }).join("");
  }

  function detailStats(row) {
    return "<div class='kv'>" +
      "<div><b>#" + row.rank + "</b><span>rank of " + snapshot.rows.length + "</span></div>" +
      "<div><b>" + fmtUsd(row.implied_value_usd) + "</b><span>implied value</span></div>" +
      "<div><b>" + fmtTvl(row.tvl_usd) + "</b><span>TVL</span></div>" +
      "<div><b>" + growthLabel(row) + "</b><span>7-day TVL change</span></div>" +
      "<div><b>" + row.multiple.toFixed(3) + "×</b><span>implied multiple</span></div>" +
      "<div><b>" + fmtPct(row.token_odds) + "</b><span>token odds (record rate)</span></div>" +
      "<div><b>" + row.age_days + " days</b><span>age at snapshot</span></div></div>";
  }

  function detailCheckBanner(row, again, ok) {
    var text = ok
      ? "✓ Recomputed in this page: " + fmtUsd(again) + " — matches the board's " + fmtUsd(row.implied_value_usd) + "."
      : "✗ Recomputed in this page: " + fmtUsd(again) + " — does NOT match the board's " + fmtUsd(row.implied_value_usd) + ".";
    return "<div class='check " + (ok ? "ok" : "bad") + "'>" + text + "</div>";
  }

  function detailHeader(row) {
    return "<div class='detail-card'><h2>" + esc(row.name) + (row.watchlist ? watchBadge() : "") + "</h2>" +
      "<p style='color:var(--mut);margin:0'>" + esc(row.slug) + " · " + esc(row.category || "Uncategorised") + " · " +
      row.chains.map(esc).join(", ") + " · listed " + esc(row.listed_at || "date not recorded") + "</p>";
  }

  function detailCardHtml(row) {
    var again = recompute(row);
    var ok = again === row.implied_value_usd;
    return detailHeader(row) +
      detailStats(row) +
      "<p>Model: " + fmtTvl(row.tvl_usd) + " TVL through " + modelSentence(row) +
      " Token odds " + fmtPct(row.token_odds) + " is the record rate for its age and category, shown only." +
      " The record shows no token — market cap, CoinGecko id and symbol are all null.</p>" +
      detailCheckBanner(row, again, ok) +
      "<h3>How the value is built</h3><table class='factors'><thead><tr><th>Factor</th><th>Value</th><th>Where it comes from</th></tr></thead><tbody>" +
      factorRows(row) + "</tbody></table>" +
      "<h3>Farm plan — 8 steps</h3><ol class='steps'>" +
      row.farm_steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol></div>";
  }

  function renderDetail(slug) {
    var row = snapshot.rows.find(function (x) { return x.slug === slug; });
    if (!row) { showTab("pre"); return; }
    byId("detail").innerHTML = detailCardHtml(row);
  }

  // ---------------------------------------------------------------
  // 9. Tabs and navigation
  // ---------------------------------------------------------------
  function setTabButtons(tab) {
    byId("tab-pre").classList.toggle("active", tab === "pre");
    byId("tab-live").classList.toggle("active", tab === "live");
    byId("tab-method").classList.toggle("active", tab === "method");
  }

  function setViewVisibility(tab) {
    byId("view-board").hidden = tab !== "pre" || !!ui.slug;
    byId("view-live").hidden = tab !== "live";
    byId("view-method").hidden = tab !== "method";
    byId("view-detail").hidden = !ui.slug;
    // The search and filter controls serve the board and the live
    // view; the method tab and the detail view hide them.
    byId("controls").style.display = (tab === "pre" || tab === "live") && !ui.slug ? "" : "none";
  }

  function renderActiveView(tab) {
    if (tab === "pre" && !ui.slug) { renderTopChart(); renderBenchMini(); renderBoard(); }
    if (tab === "live") renderLive();
    if (tab === "method") renderComps();
    if (ui.slug) renderDetail(ui.slug);
  }

  function showTab(tab) {
    ui.tab = tab;
    setTabButtons(tab);
    setViewVisibility(tab);
    renderActiveView(tab);
    syncUrl();
  }

  function openDetail(slug) {
    ui.slug = slug;
    showTab("pre");
  }

  function closeDetail() {
    ui.slug = null;
    showTab("pre");
  }

  // ---------------------------------------------------------------
  // 10. Event wiring
  // ---------------------------------------------------------------
  function onFilterChange() {
    if (ui.tab === "live") renderLive();
    else renderBoard();
    syncUrl();
  }

  function onSortHeaderClick(th) {
    var key = th.getAttribute("data-sort");
    if (ui.sort === key) {
      ui.dir = -ui.dir;
    } else {
      ui.sort = key;
      ui.dir = key === "name" ? 1 : -1;
    }
    renderBoard();
  }

  function onLiveSortHeaderClick(th) {
    var key = th.getAttribute("data-sort");
    if (ui.liveSort === key) {
      ui.liveDir = -ui.liveDir;
    } else {
      ui.liveSort = key;
      ui.liveDir = key === "name" ? 1 : -1;
    }
    renderLive();
  }

  function onBoardRowClick(e) {
    var tr = e.target.closest("tr[data-slug]");
    if (tr) openDetail(tr.getAttribute("data-slug"));
  }

  function bindEvents() {
    byId("tab-pre").addEventListener("click", closeDetail);
    byId("tab-live").addEventListener("click", function () { ui.slug = null; showTab("live"); });
    byId("tab-method").addEventListener("click", function () { ui.slug = null; showTab("method"); });
    byId("back").addEventListener("click", closeDetail);
    byId("q").addEventListener("input", function (e) { ui.q = e.target.value; onFilterChange(); });
    byId("cat").addEventListener("change", function (e) { ui.cat = e.target.value; onFilterChange(); });
    byId("chain").addEventListener("change", function (e) { ui.chain = e.target.value; onFilterChange(); });
    byId("watchonly").addEventListener("change", function (e) { ui.watch = e.target.checked; onFilterChange(); });
    byId("rows").addEventListener("click", onBoardRowClick);
    document.querySelectorAll("#board th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () { onSortHeaderClick(th); });
    });
    document.querySelectorAll("#livetab th[data-sort]").forEach(function (th) {
      th.addEventListener("click", function () { onLiveSortHeaderClick(th); });
    });
  }

  // ---------------------------------------------------------------
  // 11. Startup
  // ---------------------------------------------------------------
  readParams();
  populateFilters();
  applyControlValues();
  renderStats();
  bindEvents();
  if (ui.slug) {
    showTab("pre");
  } else if (ui.tab === "live") {
    showTab("live");
  } else if (ui.tab === "method") {
    showTab("method");
  } else {
    showTab("pre");
  }
})();
