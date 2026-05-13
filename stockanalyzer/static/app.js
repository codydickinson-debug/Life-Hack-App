const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ============ View switching ============
$$(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    $$(".nav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    $$(".view").forEach(v => v.classList.remove("active"));
    $(`.view-${view}`).classList.add("active");

    if (view === "scan" && btn.dataset.universe) {
      switchMarket(btn);
    }
    if (view === "housing") {
      ensureHousingLoaded();
    }
    if (view === "home") {
      ensureHomeLoaded();
    }
    if (view === "news") {
      ensureNewsLoaded();
    }
  });
});

// Feature cards on the home view route to other views by clicking
// the matching sidebar nav button.
$$(".feature-card").forEach(card => {
  card.addEventListener("click", () => {
    const view = card.dataset.goView;
    const universe = card.dataset.goUniverse;
    let target = null;
    if (universe) {
      target = document.querySelector(`.nav-btn[data-universe="${universe}"]`);
    } else if (view) {
      target = document.querySelector(`.nav-btn[data-view="${view}"]:not([data-universe])`);
    }
    if (target) target.click();
  });
});

function switchMarket(btn) {
  // Cancel any in-flight scan from the previous market.
  if (scanState.scanning && scanState.source) {
    scanState.source.close();
  }
  scanState.scanning = false;
  scanState.universe = btn.dataset.universe;
  scanState.results = [];
  scanState.errors = [];

  const label = btn.dataset.label || "Market";
  const lower = label.toLowerCase();
  const accent = btn.dataset.accent || "#4f8dff";
  const icon = btn.dataset.icon || "📊";

  // Update market chip (the colored pill near the title).
  const chip = $("#market-chip");
  if (chip) {
    chip.style.setProperty("--market-accent", accent);
    $("#market-chip-icon").textContent = icon;
    $("#market-chip-label").textContent = label;
  }

  // Update view header copy.
  $("#scan-title").textContent = `${label} Scan`;
  $("#scan-lede").textContent = btn.dataset.lede || "";
  $("#scan-note").textContent = btn.dataset.tagline || "";
  $("#empty-title").textContent = `Ready to scan ${lower}`;
  $("#empty-body").innerHTML =
    `Click <strong>Scan Market</strong> to evaluate ${btn.dataset.size} ${lower}. ` +
    `Results stream in live as each ticker completes.`;

  // Default the period dropdown to whatever this market reads best at.
  if (btn.dataset.period) {
    const sel = $("#scan-period");
    if (sel && [...sel.options].some(o => o.value === btn.dataset.period)) {
      sel.value = btn.dataset.period;
    }
  }

  // Reset scan UI.
  scanBtn.querySelector(".btn-label").textContent = "Scan Market";
  progressEl.classList.add("hidden");
  summaryEl.classList.add("hidden");
  filtersEl.classList.add("hidden");
  leaderboardEl.querySelectorAll(".row, .error-card, .scan-errors").forEach(n => n.remove());
  emptyEl.classList.remove("hidden");
}

// ============ Helpers ============
function fmtUSD(n, decimals = 2) {
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
function fmtPct(n, decimals = 1) {
  return (n >= 0 ? "+" : "") + n.toFixed(decimals) + "%";
}
function verdictClass(v) { return v.toLowerCase().replace(/\s+/g, "-"); }

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ============ Scanner state ============
const scanState = {
  results: [],
  errors: [],
  filter: "all",
  sort: "composite",
  scanning: false,
  source: null,
  universe: "stocks",
};

const scanBtn = $("#scan-btn");
const progressEl = $("#scan-progress");
const progressFill = $("#progress-fill");
const progressText = $("#progress-text");
const summaryEl = $("#summary");
const filtersEl = $("#filters");
const leaderboardEl = $("#leaderboard");
const emptyEl = $("#empty-state");

scanBtn.addEventListener("click", () => {
  if (scanState.scanning) {
    if (scanState.source) scanState.source.close();
    scanState.scanning = false;
    scanBtn.querySelector(".btn-label").textContent = "Scan Market";
    return;
  }
  startScan();
});

function startScan() {
  const account = parseFloat($("#scan-account").value) || 10000;
  const period = $("#scan-period").value;

  scanState.results = [];
  scanState.errors = [];
  scanState.scanning = true;
  scanBtn.querySelector(".btn-label").textContent = "Stop Scan";
  emptyEl.classList.add("hidden");
  progressEl.classList.remove("hidden");
  summaryEl.classList.add("hidden");
  filtersEl.classList.add("hidden");
  leaderboardEl.querySelectorAll(".row, .error-card, .scan-errors").forEach(n => n.remove());
  progressFill.style.width = "0%";
  progressText.textContent = "Starting scan…";

  const url = `/api/scan?account=${account}&period=${encodeURIComponent(period)}&universe=${encodeURIComponent(scanState.universe)}`;
  const source = new EventSource(url);
  scanState.source = source;

  source.addEventListener("start", e => {
    const d = JSON.parse(e.data);
    progressText.textContent = `0 / ${d.total} analyzed`;
  });

  source.addEventListener("result", e => {
    const r = JSON.parse(e.data);
    if (r.error) {
      scanState.errors.push({ ticker: r.ticker, error: r.error });
    } else {
      scanState.results.push(r.decision);
    }
    renderLeaderboard();
    updateSummary();
    renderScanErrors();
  });

  source.addEventListener("progress", e => {
    const d = JSON.parse(e.data);
    const pct = (d.completed / d.total) * 100;
    progressFill.style.width = pct + "%";
    const errStr = scanState.errors.length ? ` · ${scanState.errors.length} failed` : "";
    progressText.textContent = `${d.completed} / ${d.total} analyzed · ${scanState.results.length} successful${errStr}`;
    if (scanState.results.length > 0 || scanState.errors.length > 0) {
      summaryEl.classList.remove("hidden");
      filtersEl.classList.remove("hidden");
    }
  });

  source.addEventListener("done", e => {
    const d = JSON.parse(e.data);
    progressText.textContent = `Scan complete · ${scanState.results.length} of ${d.total} analyzed`
      + (scanState.errors.length ? ` · ${scanState.errors.length} failed to fetch` : "");
    scanState.scanning = false;
    scanBtn.querySelector(".btn-label").textContent = "Scan Again";
    source.close();
    renderLeaderboard();
    renderScanErrors();
    updateSummary();
  });

  source.onerror = () => {
    scanState.scanning = false;
    scanBtn.querySelector(".btn-label").textContent = "Scan Market";
    progressText.textContent = "Connection ended.";
    source.close();
  };
}

function renderScanErrors() {
  leaderboardEl.querySelectorAll(".scan-errors").forEach(n => n.remove());
  if (scanState.errors.length === 0) return;
  const tickers = scanState.errors.map(e => e.ticker).join(", ");
  const el = document.createElement("div");
  el.className = "scan-errors";
  el.innerHTML = `<strong>${scanState.errors.length} couldn't be fetched:</strong> <code>${tickers}</code>`;
  leaderboardEl.insertBefore(el, leaderboardEl.firstChild);
}

// ============ Filters & Sort ============
$$('.chip[data-filter]').forEach(c => c.addEventListener('click', () => {
  $$('.chip[data-filter]').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  scanState.filter = c.dataset.filter;
  renderLeaderboard();
}));
$$('.chip[data-sort]').forEach(c => c.addEventListener('click', () => {
  $$('.chip[data-sort]').forEach(x => x.classList.remove('active'));
  c.classList.add('active');
  scanState.sort = c.dataset.sort;
  renderLeaderboard();
}));

function passesFilter(d) {
  switch (scanState.filter) {
    case "buy": return d.verdict === "BUY" || d.verdict === "STRONG BUY";
    case "strong-buy": return d.verdict === "STRONG BUY";
    case "sell": return d.verdict === "SELL" || d.verdict === "STRONG SELL";
    default: return true;
  }
}

function sortKey(d) {
  switch (scanState.sort) {
    case "rr": return -(d.risk_reward || 0);
    case "sharpe": return -(d.backtest?.sharpe ?? -10);
    default: return -d.composite;
  }
}

function updateSummary() {
  const counts = { "STRONG BUY": 0, "BUY": 0, "HOLD": 0, "SELL": 0, "STRONG SELL": 0 };
  for (const d of scanState.results) counts[d.verdict] = (counts[d.verdict] || 0) + 1;
  $("#sum-strong-buy").textContent = counts["STRONG BUY"];
  $("#sum-buy").textContent = counts["BUY"];
  $("#sum-hold").textContent = counts["HOLD"];
  $("#sum-sell").textContent = (counts["SELL"] || 0) + (counts["STRONG SELL"] || 0);
}

// ============ Leaderboard render ============
function renderLeaderboard() {
  leaderboardEl.querySelectorAll(".row, .error-card").forEach(n => n.remove());
  emptyEl.classList.toggle("hidden", scanState.results.length > 0);

  const items = scanState.results.filter(passesFilter);
  items.sort((a, b) => sortKey(a) - sortKey(b));

  let rank = 1;
  for (const d of items) {
    try {
      leaderboardEl.appendChild(buildRow(d, rank++));
    } catch (err) {
      console.error(`Failed to render row for ${d?.ticker}:`, err);
      const errEl = document.createElement("div");
      errEl.className = "error-card";
      errEl.innerHTML = `<strong>${d?.ticker || "?"}</strong> — render error: ${err.message}`;
      leaderboardEl.appendChild(errEl);
    }
  }
}

function buildRow(d, rank) {
  const tpl = $("#row-tpl");
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector(".row");

  row.classList.add("is-" + verdictClass(d.verdict));
  $(".row-rank", row).textContent = "#" + rank;
  $(".row-ticker", row).textContent = d.ticker;
  $(".row-sector", row).textContent = d.fundamentals?.sector || "";
  const v = $(".verdict", row);
  v.textContent = d.verdict;
  v.classList.add(verdictClass(d.verdict));

  for (const key of ["quality", "value", "trend", "momentum"]) {
    const score = d.pillars[key];
    const bar = $(`.mini-bar[data-key="${key}"] .b`, row);
    const fill = document.createElement("div");
    fill.className = "fill";
    if (score > 0) {
      fill.classList.add("pos");
      fill.style.width = `${(score / 3) * 50}%`;
    } else if (score < 0) {
      fill.classList.add("neg");
      fill.style.width = `${(Math.abs(score) / 3) * 50}%`;
    }
    bar.appendChild(fill);
  }

  $(".row-price", row).textContent = fmtUSD(d.price);
  const compEl = $(".row-composite", row);
  compEl.textContent = (d.composite >= 0 ? "+" : "") + d.composite;
  if (d.composite > 0) compEl.classList.add("pos");
  else if (d.composite < 0) compEl.classList.add("neg");

  $(".row-rr", row).textContent = `${d.risk_reward.toFixed(1)}:1`;
  const sh = d.backtest?.sharpe;
  const shEl = $(".row-sharpe", row);
  if (sh != null && !isNaN(sh)) {
    shEl.textContent = sh.toFixed(2);
    if (sh > 0.5) shEl.classList.add("pos");
    else if (sh < 0) shEl.classList.add("neg");
  } else {
    shEl.textContent = "—";
  }

  const detailEl = $(".row-detail", row);
  const expandBtn = $(".expand-btn", row);
  expandBtn.addEventListener("click", () => {
    if (detailEl.classList.contains("hidden")) {
      if (!detailEl.dataset.built) {
        detailEl.appendChild(buildDetailCard(d));
        detailEl.dataset.built = "1";
      }
      detailEl.classList.remove("hidden");
      expandBtn.textContent = "Details ↑";
    } else {
      detailEl.classList.add("hidden");
      expandBtn.textContent = "Details ↓";
    }
  });

  return row;
}

// ============ Detail card ============
function buildDetailCard(d) {
  const tpl = $("#card-tpl");
  const frag = tpl.content.cloneNode(true);
  const card = frag.querySelector(".card");

  $(".ticker", card).textContent = d.ticker;
  $(".sector", card).textContent = d.fundamentals?.sector || "";
  $(".price", card).textContent = fmtUSD(d.price);
  const v = $(".verdict", card);
  v.textContent = d.verdict;
  v.classList.add(verdictClass(d.verdict));

  for (const key of ["quality", "value", "trend", "momentum"]) {
    const score = d.pillars[key];
    const pillar = $(`.pillar[data-key="${key}"]`, card);
    const bar = $(".bar", pillar);
    const num = $(".num", pillar);
    const fill = document.createElement("div");
    fill.className = "fill";
    if (score > 0) { fill.classList.add("pos"); fill.style.width = `${(score / 3) * 50}%`; num.classList.add("pos"); }
    else if (score < 0) { fill.classList.add("neg"); fill.style.width = `${(Math.abs(score) / 3) * 50}%`; num.classList.add("neg"); }
    else num.classList.add("zero");
    bar.appendChild(fill);
    num.textContent = (score >= 0 ? "+" : "") + score;
  }

  const fillList = (cls, items) => {
    const ul = $("." + cls, card);
    ul.innerHTML = "";
    for (const it of items || []) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.appendChild(li);
    }
  };
  fillList("quality_notes", d.pillars.quality_notes);
  fillList("value_notes", d.pillars.value_notes);
  fillList("trend_notes", d.pillars.trend_notes);
  fillList("momentum_notes", d.pillars.momentum_notes);

  if (d.pillars.warnings?.length) {
    const w = $(".warnings", card);
    w.classList.remove("hidden");
    const ul = $("ul", w);
    for (const it of d.pillars.warnings) {
      const li = document.createElement("li");
      li.textContent = it;
      ul.appendChild(li);
    }
  }

  // Action plan
  const actBody = $(".action-body", card);
  const isBuy = d.verdict === "BUY" || d.verdict === "STRONG BUY";
  const isSell = d.verdict === "SELL" || d.verdict === "STRONG SELL";
  const stopPct = (d.stop_loss / d.price - 1) * 100;
  const tpPct = (d.take_profit / d.price - 1) * 100;

  const row = (k, vv, cls = "") => {
    const dt = document.createElement("div");
    dt.className = "k";
    dt.textContent = k;
    const dd = document.createElement("div");
    dd.className = "v " + cls;
    dd.textContent = vv;
    actBody.appendChild(dt);
    actBody.appendChild(dd);
  };

  if (isBuy) {
    row("Buy zone", `${fmtUSD(d.entry_zone[0])} – ${fmtUSD(d.entry_zone[1])}`);
    row("Stop loss", `${fmtUSD(d.stop_loss)}  (${fmtPct(stopPct)})`, "red");
    row("Take profit", `${fmtUSD(d.take_profit)}  (${fmtPct(tpPct)})`, "green");
    row("Reward:Risk", `${d.risk_reward.toFixed(1)}:1`);
    row("Position", `${d.shares_to_buy} shares  (~${fmtUSD(d.shares_to_buy * d.price, 0)}, risking ${fmtUSD(d.dollar_risk, 0)})`);
    row("Sell triggers", "stop hit · MACD↓ · RSI > 75 · close below 50d SMA");
  } else if (isSell) {
    row("Action", "Exit if holding");
    row("Re-enter long when", "price reclaims 200d SMA + MACD↑ + RSI 30–55");
  } else {
    row("Action", "Wait — no edge right now");
    row("Buy when", "trend score turns positive + MACD↑ + RSI 30–55");
    row("Sell when", "trend score turns negative + MACD↓ + RSI > 70");
  }

  // P&L projection
  renderProjection(card, d);

  // Chart
  renderChart(card, d);

  // Position breakdown
  renderPosition(card, d);

  // Backtest
  const bt = d.backtest || {};
  const btEl = $(".bt-grid", card);
  if (bt.error) {
    btEl.innerHTML = `<div class="stat">Backtest unavailable.</div>`;
  } else {
    $(".bt-period", card).textContent = `(${bt.years.toFixed(1)}y, after 10bps costs)`;
    const stat = (label, val, cls = "") => {
      const div = document.createElement("div");
      div.className = "stat";
      div.innerHTML = `<label>${label}</label><div class="v ${cls}">${val}</div>`;
      return div;
    };
    btEl.appendChild(stat("Strategy", fmtPct(bt.strategy_return * 100), bt.strategy_return >= 0 ? "green" : "red"));
    btEl.appendChild(stat("Buy & hold", fmtPct(bt.buyhold_return * 100), bt.buyhold_return >= 0 ? "green" : "red"));
    btEl.appendChild(stat("Sharpe", bt.sharpe.toFixed(2), bt.sharpe > 1 ? "green" : (bt.sharpe < 0.5 ? "red" : "")));
    btEl.appendChild(stat("Max drawdown", fmtPct(bt.max_drawdown * 100), "red"));
    btEl.appendChild(stat("Win rate", `${(bt.win_rate * 100).toFixed(0)}%`));
    btEl.appendChild(stat("Trades", String(bt.num_trades)));
    const edge = bt.strategy_return - bt.buyhold_return;
    const edgeEl = document.createElement("div");
    edgeEl.className = "edge " + (edge >= 0 ? "win" : "lose");
    edgeEl.textContent = edge >= 0
      ? `✓ Strategy beat buy-and-hold by ${fmtPct(edge * 100)} on this name.`
      : `✗ Buy-and-hold beat the strategy by ${fmtPct(Math.abs(edge) * 100)} on this name.`;
    btEl.appendChild(edgeEl);
  }

  return card;
}

// ============ P&L projection ============
function renderProjection(card, d) {
  const proj = d.projections;
  const section = card.querySelector('.projection-section');
  if (!section) return;
  if (!proj || Object.keys(proj).length === 0) {
    section.style.display = "none";
    return;
  }

  const inv = section.querySelector('.proj-investment');
  const investment = d.shares_to_buy * d.price;
  if (d.shares_to_buy > 0) {
    inv.innerHTML = `Position: <strong>${fmtUSD(investment, 0)}</strong> · ${d.shares_to_buy} shares × ${fmtUSD(d.price)}`;
  } else {
    inv.innerHTML = `Hypothetical position: <strong>1 share × ${fmtUSD(d.price)}</strong> (account too small to risk-size)`;
  }

  const tabs = section.querySelectorAll('.proj-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderProjectionContent(section, proj[tab.dataset.h]);
    });
  });

  // Initial: 30d
  renderProjectionContent(section, proj['30d']);
}

function renderProjectionContent(section, p) {
  if (!p) return;
  const content = section.querySelector('.proj-content');
  content.innerHTML = "";

  const medColor = p.median_pnl > 0 ? "green" : p.median_pnl < 0 ? "red" : "";
  const medSign = p.median_pnl >= 0 ? "+" : "−";
  const medAbs = Math.abs(p.median_pnl);

  // Median block
  const medBlock = document.createElement("div");
  medBlock.className = "proj-block proj-median";
  medBlock.innerHTML = `
    <label>Median outcome at ${p.horizon_days} days</label>
    <div class="median-amount ${medColor}">${medSign}${fmtUSD(medAbs, 0)}<span class="median-pct">(${fmtPct(p.median_pnl_pct, 1)})</span></div>
    <div class="median-meta">Implied price ${fmtUSD(p.median_price, 2)} · ${p.shares} shares</div>
  `;
  content.appendChild(medBlock);

  // Ranges block
  const rangeBlock = document.createElement("div");
  rangeBlock.className = "proj-block proj-ranges";
  rangeBlock.innerHTML = `
    <label>Confidence ranges (P&L $)</label>
    <div class="range-row">
      <span class="rlbl">50%</span>
      <span class="range-vals">
        <span class="range-lo">${fmtSigned(p.lo50_pnl)}</span>
        <span class="range-track"></span>
        <span class="range-hi">${fmtSigned(p.hi50_pnl)}</span>
      </span>
    </div>
    <div class="range-row">
      <span class="rlbl">80%</span>
      <span class="range-vals">
        <span class="range-lo">${fmtSigned(p.lo80_pnl)}</span>
        <span class="range-track"></span>
        <span class="range-hi">${fmtSigned(p.hi80_pnl)}</span>
      </span>
    </div>
  `;
  content.appendChild(rangeBlock);

  // Probabilities block (full width)
  const probBlock = document.createElement("div");
  probBlock.className = "proj-block proj-probs";
  const tpPct = (p.p_hit_tp_first * 100).toFixed(0);
  const slPct = (p.p_hit_sl_first * 100).toFixed(0);
  const nthPct = (p.p_neither * 100).toFixed(0);
  const profitPct = (p.p_profit * 100).toFixed(0);
  const profitClass = p.p_profit > 0.5 ? "pos" : "neg";

  probBlock.innerHTML = `
    <label>Probability of outcomes within ${p.horizon_days} days</label>
    <div class="prob-bar">
      <div class="prob-seg tp" style="width:${p.p_hit_tp_first * 100}%">${tpPct > 5 ? `${tpPct}% hits TP first` : ""}</div>
      <div class="prob-seg sl" style="width:${p.p_hit_sl_first * 100}%">${slPct > 5 ? `${slPct}% hits SL first` : ""}</div>
      <div class="prob-seg neither" style="width:${p.p_neither * 100}%">${nthPct > 5 ? `${nthPct}% no hit` : ""}</div>
    </div>
    <div class="prob-detail">
      <span>P(profit at ${p.horizon_days}d): <strong class="${profitClass}">${profitPct}%</strong></span>
      <span>Hits TP first: <strong class="pos">${tpPct}%</strong></span>
      <span>Hits SL first: <strong class="neg">${slPct}%</strong></span>
      <span>Neither: <strong>${nthPct}%</strong></span>
    </div>
  `;
  content.appendChild(probBlock);
}

function fmtSigned(n) {
  const sign = n >= 0 ? "+" : "−";
  return sign + fmtUSD(Math.abs(n), 0);
}

// ============ Position breakdown bar ============
function renderPosition(card, d) {
  const account = (() => {
    // Pull from the active view's account input
    const fromScan = parseFloat($("#scan-account")?.value);
    const fromLookup = parseFloat($("#account")?.value);
    return (isFinite(fromScan) && fromScan > 0) ? fromScan
         : (isFinite(fromLookup) && fromLookup > 0) ? fromLookup
         : 10000;
  })();

  const positionDollars = d.shares_to_buy * d.price;
  const riskDollars = d.dollar_risk;
  const cashDollars = Math.max(0, account - positionDollars);

  const bar = card.querySelector('.position-bar');
  bar.innerHTML = "";

  // Build segments
  const positionPct = Math.min(100, (positionDollars / account) * 100);
  const riskPct = Math.min(100, (riskDollars / account) * 100);
  const cashPct = Math.max(0, 100 - positionPct);

  const posSeg = document.createElement('div');
  posSeg.className = 'seg position';
  posSeg.style.width = positionPct + '%';
  if (positionPct > 8) posSeg.textContent = `Position ${positionPct.toFixed(1)}%`;
  bar.appendChild(posSeg);

  const cashSeg = document.createElement('div');
  cashSeg.className = 'seg cash';
  cashSeg.style.width = cashPct + '%';
  if (cashPct > 12) cashSeg.textContent = `Cash ${cashPct.toFixed(1)}%`;
  bar.appendChild(cashSeg);

  const stats = card.querySelector('.position-stats');
  stats.innerHTML = "";
  const stat = (label, val) => {
    const ps = document.createElement('div');
    ps.className = 'ps';
    ps.innerHTML = `<label>${label}</label><span>${val}</span>`;
    return ps;
  };
  stats.appendChild(stat("Shares to buy", String(d.shares_to_buy)));
  stats.appendChild(stat("Cost", fmtUSD(positionDollars, 0)));
  stats.appendChild(stat("At risk", fmtUSD(riskDollars, 0) + ` (${riskPct.toFixed(1)}%)`));
  stats.appendChild(stat("Account", fmtUSD(account, 0)));
}

// ============ SVG chart ============
function renderChart(card, d) {
  const c = d.chart;
  const container = card.querySelector('.chart-container');
  const meta = card.querySelector('.chart-meta');
  if (!c || !c.dates || c.dates.length === 0) {
    meta.textContent = "Chart unavailable.";
    return;
  }

  meta.textContent =
    `Last 60d drift ${fmtPct(c.annual_drift_pct, 1)}/yr · vol ${c.annual_vol_pct.toFixed(0)}%/yr · projection cone shows ` +
    `where price could land in 60 days at 50% / 80% confidence (geometric Brownian motion from recent returns — not a forecast)`;

  // Build unified timeline of {date, ...values}
  const histN = c.dates.length;
  const projN = c.proj_dates.length;
  const xs = [...c.dates, ...c.proj_dates];

  // Y range across all series
  const allYs = [
    ...c.close.filter(v => v != null),
    ...c.sma20.filter(v => v != null),
    ...c.sma50.filter(v => v != null),
    ...c.sma200.filter(v => v != null),
    ...c.proj_lo80,
    ...c.proj_hi80,
    c.stop_loss, c.take_profit, c.entry_lo, c.entry_hi,
  ];
  const yMin = Math.min(...allYs) * 0.97;
  const yMax = Math.max(...allYs) * 1.03;

  // Render
  const W = 760, H = 320;
  const pad = { l: 56, r: 16, t: 16, b: 28 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const xScale = (i) => pad.l + (i / (xs.length - 1)) * innerW;
  const yScale = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * innerH;

  container.innerHTML = "";
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
  });

  // Gridlines & y-axis labels
  const yTicks = 5;
  for (let k = 0; k <= yTicks; k++) {
    const yv = yMin + (k / yTicks) * (yMax - yMin);
    const py = yScale(yv);
    svg.appendChild(svgEl("line", {
      x1: pad.l, x2: W - pad.r, y1: py, y2: py,
      stroke: "#e6eaf2", "stroke-width": 1,
    }));
    const t = svgEl("text", {
      x: pad.l - 8, y: py + 4,
      "text-anchor": "end",
      fill: "#6b7385",
      "font-family": "JetBrains Mono, monospace",
      "font-size": 10,
    });
    t.textContent = "$" + yv.toFixed(yv < 10 ? 2 : 0);
    svg.appendChild(t);
  }

  // X-axis labels: ~6 evenly spaced
  const xTicks = 6;
  for (let k = 0; k <= xTicks; k++) {
    const idx = Math.round((k / xTicks) * (xs.length - 1));
    const px = xScale(idx);
    const t = svgEl("text", {
      x: px, y: H - pad.b + 16,
      "text-anchor": "middle",
      fill: "#6b7385",
      "font-family": "JetBrains Mono, monospace",
      "font-size": 10,
    });
    const dt = xs[idx];
    // Compact: YYYY-MM
    t.textContent = dt.substring(0, 7);
    svg.appendChild(t);
  }

  // History/projection divider
  const dividerX = xScale(histN - 1);
  svg.appendChild(svgEl("line", {
    x1: dividerX, x2: dividerX, y1: pad.t, y2: H - pad.b,
    stroke: "#a8b0bf", "stroke-width": 1, "stroke-dasharray": "2 4",
  }));
  const dt = svgEl("text", {
    x: dividerX + 4, y: pad.t + 12,
    fill: "#6b7385",
    "font-family": "JetBrains Mono, monospace",
    "font-size": 10,
  });
  dt.textContent = "← actual · projected →";
  svg.appendChild(dt);

  // Helper: build a path string from values aligned to a starting index
  function pathFrom(values, startIdx) {
    let dStr = "";
    let pen = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null || isNaN(v)) { pen = false; continue; }
      const px = xScale(startIdx + i);
      const py = yScale(v);
      dStr += (pen ? " L " : " M ") + px.toFixed(1) + " " + py.toFixed(1);
      pen = true;
    }
    return dStr.trim();
  }

  // Reference horizontal lines
  const refLines = [
    { y: c.entry_lo, color: "rgba(31, 216, 122, 0.5)", dash: "3 3", label: "Entry low" },
    { y: c.entry_hi, color: "rgba(31, 216, 122, 0.5)", dash: "3 3", label: "Entry high" },
    { y: c.take_profit, color: "#1fd87a", dash: "5 4", label: "TP" },
    { y: c.stop_loss, color: "#ff526e", dash: "5 4", label: "SL" },
  ];
  // Entry-zone band
  if (c.entry_lo && c.entry_hi) {
    const yLo = Math.min(c.entry_lo, c.entry_hi);
    const yHi = Math.max(c.entry_lo, c.entry_hi);
    svg.appendChild(svgEl("rect", {
      x: pad.l,
      y: yScale(yHi),
      width: innerW,
      height: yScale(yLo) - yScale(yHi),
      fill: "rgba(31, 216, 122, 0.08)",
    }));
  }
  for (const r of refLines.slice(2)) {
    const py = yScale(r.y);
    svg.appendChild(svgEl("line", {
      x1: pad.l, x2: W - pad.r, y1: py, y2: py,
      stroke: r.color, "stroke-width": 1.5,
      "stroke-dasharray": r.dash,
    }));
    const lbl = svgEl("text", {
      x: W - pad.r - 4, y: py - 4,
      "text-anchor": "end",
      fill: r.color,
      "font-family": "JetBrains Mono, monospace",
      "font-size": 10,
      "font-weight": 600,
    });
    lbl.textContent = `${r.label} ${fmtUSD(r.y, 2)}`;
    svg.appendChild(lbl);
  }

  // Projection cone — 80% band (outer)
  const projStartIdx = histN;
  const lastClose = c.close[c.close.length - 1];
  const cone80Top = [lastClose, ...c.proj_hi80];
  const cone80Bot = [lastClose, ...c.proj_lo80];
  const cone50Top = [lastClose, ...c.proj_hi50];
  const cone50Bot = [lastClose, ...c.proj_lo50];

  function buildPolygon(top, bot, startIdx) {
    let pts = [];
    for (let i = 0; i < top.length; i++) {
      pts.push(xScale(startIdx - 1 + i).toFixed(1) + "," + yScale(top[i]).toFixed(1));
    }
    for (let i = bot.length - 1; i >= 0; i--) {
      pts.push(xScale(startIdx - 1 + i).toFixed(1) + "," + yScale(bot[i]).toFixed(1));
    }
    return pts.join(" ");
  }

  svg.appendChild(svgEl("polygon", {
    points: buildPolygon(cone80Top, cone80Bot, projStartIdx),
    fill: "rgba(31, 216, 122, 0.10)",
    stroke: "none",
  }));
  svg.appendChild(svgEl("polygon", {
    points: buildPolygon(cone50Top, cone50Bot, projStartIdx),
    fill: "rgba(31, 216, 122, 0.18)",
    stroke: "none",
  }));

  // SMAs (drawn behind close)
  const smaSpec = [
    { name: "sma200", color: "#aa66ff", width: 1.2 },
    { name: "sma50", color: "#ff8844", width: 1.2 },
    { name: "sma20", color: "#ffcc44", width: 1.2 },
  ];
  for (const s of smaSpec) {
    svg.appendChild(svgEl("path", {
      d: pathFrom(c[s.name], 0),
      stroke: s.color, "stroke-width": s.width, fill: "none",
      opacity: 0.85,
    }));
  }

  // Close price (front)
  svg.appendChild(svgEl("path", {
    d: pathFrom(c.close, 0),
    stroke: "#4f8dff", "stroke-width": 2, fill: "none",
  }));

  // Projection median (dashed)
  svg.appendChild(svgEl("path", {
    d: pathFrom([lastClose, ...c.proj_mid], histN - 1),
    stroke: "#1fd87a", "stroke-width": 2, fill: "none",
    "stroke-dasharray": "4 4",
  }));

  // Hover tooltip
  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  container.appendChild(tip);
  const hoverLine = svgEl("line", {
    x1: 0, x2: 0, y1: pad.t, y2: H - pad.b,
    stroke: "#4f8dff", "stroke-width": 1, opacity: 0,
  });
  svg.appendChild(hoverLine);
  const hoverDot = svgEl("circle", {
    cx: 0, cy: 0, r: 4, fill: "#4f8dff", opacity: 0,
  });
  svg.appendChild(hoverDot);

  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < pad.l || px > W - pad.r) {
      tip.classList.remove("show");
      hoverLine.setAttribute("opacity", 0);
      hoverDot.setAttribute("opacity", 0);
      return;
    }
    // Find nearest data index
    const frac = (px - pad.l) / innerW;
    const idx = Math.round(frac * (xs.length - 1));
    const xPx = xScale(idx);
    let val = null, label = "";
    if (idx < histN) {
      val = c.close[idx];
      label = `${xs[idx]}: ${fmtUSD(val, 2)}`;
    } else {
      const j = idx - histN;
      val = c.proj_mid[j];
      const lo = c.proj_lo80[j], hi = c.proj_hi80[j];
      label = `${xs[idx]}: median ${fmtUSD(val, 2)}<br>80%: ${fmtUSD(lo, 2)} – ${fmtUSD(hi, 2)}`;
    }
    if (val == null) return;
    hoverLine.setAttribute("x1", xPx);
    hoverLine.setAttribute("x2", xPx);
    hoverLine.setAttribute("opacity", 0.6);
    hoverDot.setAttribute("cx", xPx);
    hoverDot.setAttribute("cy", yScale(val));
    hoverDot.setAttribute("opacity", 1);
    tip.innerHTML = label;
    tip.classList.add("show");
    const tipLeft = Math.min(rect.width - 160, Math.max(8, e.clientX - rect.left + 12));
    const tipTop = Math.max(4, e.clientY - rect.top - 30);
    tip.style.left = tipLeft + "px";
    tip.style.top = tipTop + "px";
  });
  svg.addEventListener("mouseleave", () => {
    tip.classList.remove("show");
    hoverLine.setAttribute("opacity", 0);
    hoverDot.setAttribute("opacity", 0);
  });

  container.appendChild(svg);
}

// ============ Manual lookup view ============
const lookupForm = $("#lookup-form");
const lookupStatus = $("#lookup-status");
const lookupResults = $("#lookup-results");
const goBtn = $("#go");

lookupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tickers = $("#tickers").value.trim();
  const account = parseFloat($("#account").value) || 10000;
  const period = $("#period").value;
  if (!tickers) { lookupStatus.textContent = "Enter at least one ticker."; return; }

  goBtn.disabled = true;
  goBtn.textContent = "Analyzing…";
  lookupStatus.textContent = `Fetching data for ${tickers.split(/\s+/).length} ticker(s)…`;
  lookupResults.innerHTML = "";

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers, account, period }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const r of data.results) {
      if (r.error) {
        const el = document.createElement("div");
        el.className = "error-card";
        el.innerHTML = `<strong>${r.ticker}</strong> — ${r.error}`;
        lookupResults.appendChild(el);
      } else {
        lookupResults.appendChild(buildDetailCard(r.decision));
      }
    }
    lookupStatus.textContent = `Done. ${data.results.length} ticker(s) analyzed.`;
  } catch (err) {
    lookupStatus.textContent = `Error: ${err.message}`;
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = "Analyze";
  }
});

// ============ Housing market view ============

const housingState = {
  loadedNational: false,
  loadedMetros: false,
  loadedMortgage: false,
  metroSort: "hot",
};

const VERDICT_TONE = {
  "STRONG SELLER": { color: "#ff526e", label: "Strong Seller's Market", emoji: "🔥" },
  "SELLER":        { color: "#ff8a4c", label: "Seller's Market",        emoji: "📈" },
  "BALANCED":      { color: "#a3a8b3", label: "Balanced",               emoji: "⚖️" },
  "BUYER":         { color: "#5dade2", label: "Buyer's Market",         emoji: "📉" },
  "STRONG BUYER":  { color: "#1fd87a", label: "Strong Buyer's Market",  emoji: "❄️" },
};

function ensureHousingLoaded() {
  if (!housingState.loadedNational) {
    loadNational();
    housingState.loadedNational = true;
  }
  if (!housingState.loadedMetros) {
    loadMetros(housingState.metroSort);
    housingState.loadedMetros = true;
  }
  if (!housingState.loadedMortgage) {
    loadMortgageRates();
    loadRateHistory(5);
    housingState.loadedMortgage = true;
  }
}

async function loadNational() {
  const loading = $("#national-loading");
  const body = $("#national-body");
  try {
    const res = await fetch("/api/housing/national");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    body.innerHTML = renderHousingSnapshot(snap);
    body.hidden = false;
    loading.hidden = true;
    $("#national-asof").textContent = formatMonth(snap.as_of);
  } catch (err) {
    loading.textContent = `Failed to load national data: ${err.message}`;
  }
}

async function loadMetros(sort) {
  housingState.metroSort = sort;
  const loading = $("#metros-loading");
  const list = $("#metros-list");
  loading.hidden = false;
  loading.textContent = "Loading metros…";
  list.hidden = true;
  list.innerHTML = "";
  try {
    const res = await fetch(`/api/housing/metros?sort=${sort}&limit=12`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const m of data.metros) {
      list.appendChild(buildMetroRow(m));
    }
    list.hidden = false;
    loading.hidden = true;
  } catch (err) {
    loading.textContent = `Failed: ${err.message}`;
  }
}

$$(".metro-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    $$(".metro-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    loadMetros(tab.dataset.sort);
  });
});

const zipForm = $("#zip-form");
if (zipForm) {
  zipForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const zip = $("#zip-input").value.trim();
    if (!/^\d{5}$/.test(zip)) return;
    const status = $("#zip-status");
    const body = $("#zip-body");
    status.textContent = `Looking up ${zip}…`;
    status.hidden = false;
    body.hidden = true;
    body.innerHTML = "";
    try {
      const res = await fetch(`/api/housing/zip/${zip}`);
      if (res.status === 404) {
        status.textContent = `No housing data for ZIP ${zip} (Realtor.com coverage is partial — try a more populous ZIP nearby).`;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = await res.json();
      body.innerHTML = renderHousingSnapshot(snap);
      body.hidden = false;
      status.hidden = true;
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });
}

function renderHousingSnapshot(snap) {
  const v = snap.verdict || {};
  const tone = VERDICT_TONE[v.label] || VERDICT_TONE["BALANCED"];
  const m = snap.metrics || {};

  const fmt$ = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
  const fmtN = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
  const fmtPct = (n, d = 1) => (n == null ? "—" : (n >= 0 ? "+" : "") + (n * 100).toFixed(d) + "%");
  const fmtPctNoSign = (n, d = 0) => (n == null ? "—" : (n * 100).toFixed(d) + "%");

  const reasonsHTML = (v.reasons || [])
    .map(r => `<li>${r}</li>`).join("");

  const yyClass = (n) => (n == null ? "" : (n >= 0 ? "pos" : "neg"));

  // The tone color is applied via CSS variable so cards adapt fluidly.
  return `
    <div class="snap-head" style="--tone: ${tone.color}">
      <div class="snap-region">
        <div class="snap-region-name">${snap.region_name || snap.region}</div>
        <div class="snap-region-sub">${snap.region}</div>
      </div>
      <div class="snap-verdict" style="--tone: ${tone.color}">
        <span class="snap-verdict-emoji">${tone.emoji}</span>
        <span class="snap-verdict-label">${tone.label}</span>
        <span class="snap-verdict-score">score ${v.score >= 0 ? "+" : ""}${v.score}</span>
      </div>
    </div>

    <div class="snap-metrics">
      <div class="snap-metric snap-metric-hero">
        <label>Median list price</label>
        <div class="value">${fmt$(m.median_listing_price)}</div>
        <div class="yy ${yyClass(m.median_listing_price_yy)}">${fmtPct(m.median_listing_price_yy)} YoY</div>
      </div>
      <div class="snap-metric">
        <label>Days on market</label>
        <div class="value">${m.median_dom == null ? "—" : Math.round(m.median_dom) + "d"}</div>
        <div class="yy ${yyClass(-1 * (m.median_dom_yy ?? 0))}">${fmtPct(m.median_dom_yy)} YoY</div>
      </div>
      <div class="snap-metric">
        <label>Pending ratio</label>
        <div class="value">${fmtPctNoSign(m.pending_ratio, 0)}</div>
        <div class="yy muted">pending vs active</div>
      </div>
      <div class="snap-metric">
        <label>Price reductions</label>
        <div class="value">${fmtPctNoSign(m.price_reduced_share, 0)}</div>
        <div class="yy muted">share of listings cut</div>
      </div>
      <div class="snap-metric">
        <label>Inventory</label>
        <div class="value">${fmtN(m.active_listings)}</div>
        <div class="yy ${yyClass(-1 * (m.active_listings_yy ?? 0))}">${fmtPct(m.active_listings_yy)} YoY</div>
      </div>
      <div class="snap-metric">
        <label>Median price / sqft</label>
        <div class="value">${fmt$(m.median_ppsf)}</div>
        <div class="yy ${yyClass(m.median_ppsf_yy)}">${fmtPct(m.median_ppsf_yy)} YoY</div>
      </div>
    </div>

    ${reasonsHTML ? `
    <div class="snap-reasons">
      <h4>Why ${tone.label.toLowerCase()}?</h4>
      <ul>${reasonsHTML}</ul>
    </div>
    ` : ""}
  `;
}

function buildMetroRow(snap) {
  const v = snap.verdict || {};
  const tone = VERDICT_TONE[v.label] || VERDICT_TONE["BALANCED"];
  const m = snap.metrics || {};
  const fmt$ = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
  const yy = m.median_listing_price_yy;
  const yyText = yy == null ? "" : (yy >= 0 ? "+" : "") + (yy * 100).toFixed(1) + "% YoY";
  const yyClass = yy == null ? "" : (yy >= 0 ? "pos" : "neg");

  const row = document.createElement("div");
  row.className = "metro-row";
  row.style.setProperty("--tone", tone.color);
  row.innerHTML = `
    <div class="metro-name">${snap.region_name || snap.region}</div>
    <div class="metro-verdict">
      <span class="metro-verdict-emoji">${tone.emoji}</span>
      <span class="metro-verdict-label">${tone.label}</span>
    </div>
    <div class="metro-metric">
      <label>Median list</label>
      <div>${fmt$(m.median_listing_price)} <span class="${yyClass}">${yyText}</span></div>
    </div>
    <div class="metro-metric">
      <label>DOM</label>
      <div>${m.median_dom == null ? "—" : Math.round(m.median_dom) + "d"}</div>
    </div>
    <div class="metro-score">${v.score >= 0 ? "+" : ""}${v.score}</div>
  `;
  return row;
}

function formatMonth(yyyymm) {
  if (!yyyymm) return "";
  const s = String(yyyymm);
  if (s.length !== 6) return s;
  const yr = s.slice(0, 4);
  const mo = parseInt(s.slice(4, 6), 10);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `as of ${names[mo - 1] || mo} ${yr}`;
}

// ============ Home view ============

const homeState = { loaded: false };

function ensureHomeLoaded() {
  if (homeState.loaded) return;
  homeState.loaded = true;
  loadHomeTiles();
}

async function loadHomeTiles() {
  const setTile = (id, value, meta, changeClass) => {
    const tile = document.querySelector(`.stat-tile[data-tile="${id}"]`);
    if (!tile) return;
    tile.querySelector(".stat-value").textContent = value;
    const metaEl = tile.querySelector(".stat-meta");
    metaEl.textContent = meta;
    metaEl.className = "stat-meta" + (changeClass ? " " + changeClass : "");
  };

  // S&P 500 (SPY)
  fetch("/api/quote/SPY").then(r => r.ok ? r.json() : null).then(d => {
    if (!d) return;
    const sign = d.change_pct >= 0 ? "+" : "";
    const cls = d.change_pct >= 0 ? "pos" : "neg";
    setTile("spy", "$" + d.price.toFixed(2),
      `${sign}${(d.change_pct * 100).toFixed(2)}% · ${d.as_of}`, cls);
  }).catch(() => setTile("spy", "—", "Unavailable", ""));

  // Bitcoin
  fetch("/api/quote/BTC-USD").then(r => r.ok ? r.json() : null).then(d => {
    if (!d) return;
    const sign = d.change_pct >= 0 ? "+" : "";
    const cls = d.change_pct >= 0 ? "pos" : "neg";
    setTile("btc", "$" + Math.round(d.price).toLocaleString(),
      `${sign}${(d.change_pct * 100).toFixed(2)}% · ${d.as_of}`, cls);
  }).catch(() => setTile("btc", "—", "Unavailable", ""));

  // 30y mortgage
  fetch("/api/mortgage/current").then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d["30y"]) return;
    setTile("rate", d["30y"].rate.toFixed(2) + "%", "Freddie Mac PMMS · " + d["30y"].date, "");
  }).catch(() => setTile("rate", "—", "Unavailable", ""));

  // National housing verdict
  fetch("/api/housing/national").then(r => r.ok ? r.json() : null).then(d => {
    if (!d) return;
    const v = d.verdict || {};
    const tone = VERDICT_TONE[v.label] || VERDICT_TONE["BALANCED"];
    setTile("housing", `${tone.emoji} ${tone.label}`,
      `Score ${v.score >= 0 ? "+" : ""}${v.score} · ${formatMonth(d.as_of)}`, "");
  }).catch(() => setTile("housing", "—", "Unavailable", ""));
}

// ============ News view ============

const newsState = {
  loaded: false,
  source: "all",     // 'all' | source_id
  items: [],
  sources: [],
  fetchedAt: 0,
};

function ensureNewsLoaded() {
  if (!newsState.loaded) {
    loadNews(false);
    newsState.loaded = true;
  }
}

async function loadNews(forceRefresh) {
  const list = $("#news-list");
  const meta = $("#news-meta");
  if (forceRefresh) list.innerHTML = `<div class="housing-loading">Refreshing…</div>`;
  try {
    const url = "/api/news?limit=80" + (forceRefresh ? "&refresh=1" : "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    newsState.items = data.items || [];
    newsState.sources = data.sources || [];
    newsState.fetchedAt = data.fetched_at || (Date.now() / 1000);
    renderSourceChips();
    renderNewsList();
    renderNewsMeta(data);
  } catch (err) {
    list.innerHTML = `<div class="housing-loading">Failed to load: ${err.message}</div>`;
  }
}

function renderSourceChips() {
  const filters = $("#news-filters");
  // Keep the first ("All sources") chip; rebuild the rest.
  filters.querySelectorAll(".news-chip:not([data-source='all'])").forEach(n => n.remove());
  for (const s of newsState.sources) {
    const btn = document.createElement("button");
    btn.className = "news-chip";
    btn.dataset.source = s.id;
    btn.style.setProperty("--chip-tone", s.color);
    btn.innerHTML = `<span class="dot"></span>${s.name}`;
    btn.addEventListener("click", () => {
      newsState.source = s.id;
      $$(".news-chip").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      renderNewsList();
    });
    filters.appendChild(btn);
  }
  // Wire the "All" chip if not already
  const allBtn = filters.querySelector(".news-chip[data-source='all']");
  if (allBtn && !allBtn.dataset.bound) {
    allBtn.dataset.bound = "1";
    allBtn.addEventListener("click", () => {
      newsState.source = "all";
      $$(".news-chip").forEach(c => c.classList.remove("active"));
      allBtn.classList.add("active");
      renderNewsList();
    });
  }
}

function renderNewsList() {
  const list = $("#news-list");
  list.innerHTML = "";
  const items = newsState.source === "all"
    ? newsState.items
    : newsState.items.filter(it => it.source_id === newsState.source);
  if (!items.length) {
    list.innerHTML = `<div class="housing-loading">No headlines for this source right now.</div>`;
    return;
  }
  for (const it of items) {
    list.appendChild(buildNewsRow(it));
  }
}

function buildNewsRow(it) {
  const article = document.createElement("article");
  article.className = "news-item";
  article.style.setProperty("--news-tone", it.source_color || "#3776e6");

  const ageStr = relativeTime(it.timestamp);
  const summary = it.summary ? `<p class="news-summary">${escapeHtml(it.summary)}</p>` : "";
  const img = it.image
    ? `<a class="news-thumb" href="${escapeAttr(it.link)}" target="_blank" rel="noopener"><img src="${escapeAttr(it.image)}" loading="lazy" alt=""></a>`
    : "";

  article.innerHTML = `
    ${img}
    <div class="news-body">
      <div class="news-line">
        <span class="news-source" style="--news-tone: ${it.source_color || '#3776e6'}">${escapeHtml(it.source_name)}</span>
        <span class="news-age">${ageStr}</span>
      </div>
      <h3 class="news-title"><a href="${escapeAttr(it.link)}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a></h3>
      ${summary}
    </div>
  `;
  return article;
}

function renderNewsMeta(data) {
  const meta = $("#news-meta");
  if (!meta) return;
  const ago = relativeTime(data.fetched_at);
  const errStr = (data.errors && data.errors.length)
    ? ` · <span class="neg">${data.errors.length} source(s) failed</span>` : "";
  const total = (newsState.items || []).length;
  meta.innerHTML = `<span>${total} headlines · cached ${ago}${errStr}</span>`;
}

const newsRefreshBtn = $("#news-refresh");
if (newsRefreshBtn) {
  newsRefreshBtn.addEventListener("click", () => {
    newsRefreshBtn.disabled = true;
    newsRefreshBtn.classList.add("spinning");
    loadNews(true).finally(() => {
      newsRefreshBtn.disabled = false;
      newsRefreshBtn.classList.remove("spinning");
    });
  });
}

function relativeTime(unixSec) {
  if (!unixSec) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ============ Mortgage rates + calculator ============

async function loadMortgageRates() {
  try {
    const res = await fetch("/api/mortgage/current");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    if (r["30y"]) { $("#rate-30y").textContent = r["30y"].rate.toFixed(2) + "%"; $("#rate-30y-date").textContent = "as of " + r["30y"].date; }
    if (r["15y"]) { $("#rate-15y").textContent = r["15y"].rate.toFixed(2) + "%"; $("#rate-15y-date").textContent = "as of " + r["15y"].date; }
    if (r["fed"]) { $("#rate-fed").textContent = r["fed"].rate.toFixed(2) + "%"; $("#rate-fed-date").textContent = "as of " + r["fed"].date; }
  } catch (err) {
    console.error("Mortgage rates failed:", err);
  }
}

async function loadRateHistory(years) {
  const meta = $("#rate-chart-meta");
  const cont = $("#rate-chart");
  meta.textContent = "Loading…";
  try {
    const res = await fetch(`/api/mortgage/history?years=${years}&series=30y`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.data || data.data.length === 0) {
      meta.textContent = "No history available.";
      return;
    }
    const points = data.data;
    const last = points[points.length - 1];
    const first = points[0];
    const change = last.rate - first.rate;
    const min = Math.min(...points.map(p => p.rate));
    const max = Math.max(...points.map(p => p.rate));
    const minPt = points.find(p => p.rate === min);
    const maxPt = points.find(p => p.rate === max);
    const sign = change >= 0 ? "+" : "";
    const cls = change >= 0 ? "neg" : "pos";  // rising rates = bad for buyers
    meta.innerHTML =
      `<span>Latest <strong>${last.rate.toFixed(2)}%</strong> (${last.date})</span> ` +
      `<span class="${cls}">${sign}${change.toFixed(2)}pp over ${years}y</span> ` +
      `<span>Range <strong>${min.toFixed(2)}%</strong> (${minPt.date}) – <strong>${max.toFixed(2)}%</strong> (${maxPt.date})</span>`;
    drawRateChart(cont, points, last.rate, min, max);
  } catch (err) {
    meta.textContent = `Failed: ${err.message}`;
  }
}

$$('.rate-tab').forEach(t => {
  t.addEventListener('click', () => {
    $$('.rate-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    loadRateHistory(parseInt(t.dataset.years, 10));
  });
});

function drawRateChart(container, points, latestRate, yMin, yMax) {
  container.innerHTML = "";
  const W = 760, H = 240;
  const pad = { l: 50, r: 16, t: 14, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  // Pad y-range a bit
  const yLo = Math.max(0, Math.floor(yMin * 2) / 2 - 0.25);
  const yHi = Math.ceil(yMax * 2) / 2 + 0.25;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });

  const xScale = (i) => pad.l + (i / (points.length - 1)) * innerW;
  const yScale = (v) => pad.t + (1 - (v - yLo) / (yHi - yLo)) * innerH;

  // Grid + y-axis labels
  const yTicks = 5;
  for (let k = 0; k <= yTicks; k++) {
    const yv = yLo + (k / yTicks) * (yHi - yLo);
    const py = yScale(yv);
    svg.appendChild(svgEl("line", {
      x1: pad.l, x2: W - pad.r, y1: py, y2: py,
      stroke: "#e6eaf2", "stroke-width": 1,
    }));
    const t = svgEl("text", {
      x: pad.l - 8, y: py + 4,
      "text-anchor": "end",
      fill: "#6b7385",
      "font-family": "JetBrains Mono, monospace",
      "font-size": 10,
    });
    t.textContent = yv.toFixed(2) + "%";
    svg.appendChild(t);
  }

  // X-axis labels (~6 evenly spaced)
  const xTicks = 6;
  for (let k = 0; k <= xTicks; k++) {
    const idx = Math.round((k / xTicks) * (points.length - 1));
    const px = xScale(idx);
    const t = svgEl("text", {
      x: px, y: H - pad.b + 14,
      "text-anchor": "middle",
      fill: "#6b7385",
      "font-family": "JetBrains Mono, monospace",
      "font-size": 10,
    });
    t.textContent = points[idx].date.substring(0, 7);
    svg.appendChild(t);
  }

  // Latest rate horizontal reference
  const lastY = yScale(latestRate);
  svg.appendChild(svgEl("line", {
    x1: pad.l, x2: W - pad.r, y1: lastY, y2: lastY,
    stroke: "#ff7a59", "stroke-width": 1, "stroke-dasharray": "3 4", opacity: 0.5,
  }));

  // Path
  let dStr = "";
  for (let i = 0; i < points.length; i++) {
    const px = xScale(i).toFixed(1);
    const py = yScale(points[i].rate).toFixed(1);
    dStr += (i === 0 ? "M " : " L ") + px + " " + py;
  }
  // Filled area under the curve
  let areaStr = `M ${xScale(0).toFixed(1)} ${yScale(yLo).toFixed(1)} `;
  for (let i = 0; i < points.length; i++) {
    areaStr += `L ${xScale(i).toFixed(1)} ${yScale(points[i].rate).toFixed(1)} `;
  }
  areaStr += `L ${xScale(points.length - 1).toFixed(1)} ${yScale(yLo).toFixed(1)} Z`;
  svg.appendChild(svgEl("path", {
    d: areaStr, fill: "rgba(255, 122, 89, 0.10)", stroke: "none",
  }));
  svg.appendChild(svgEl("path", {
    d: dStr, fill: "none", stroke: "#ff7a59", "stroke-width": 2,
  }));

  // Hover
  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  container.appendChild(tip);
  const hoverLine = svgEl("line", {
    x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, stroke: "#ff7a59", "stroke-width": 1, opacity: 0,
  });
  svg.appendChild(hoverLine);
  const hoverDot = svgEl("circle", { cx: 0, cy: 0, r: 4, fill: "#ff7a59", opacity: 0 });
  svg.appendChild(hoverDot);

  svg.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < pad.l || px > W - pad.r) {
      tip.classList.remove("show");
      hoverLine.setAttribute("opacity", 0);
      hoverDot.setAttribute("opacity", 0);
      return;
    }
    const frac = (px - pad.l) / innerW;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(frac * (points.length - 1))));
    const p = points[idx];
    const xPx = xScale(idx);
    hoverLine.setAttribute("x1", xPx);
    hoverLine.setAttribute("x2", xPx);
    hoverLine.setAttribute("opacity", 0.6);
    hoverDot.setAttribute("cx", xPx);
    hoverDot.setAttribute("cy", yScale(p.rate));
    hoverDot.setAttribute("opacity", 1);
    tip.innerHTML = `${p.date}: <strong>${p.rate.toFixed(2)}%</strong>`;
    tip.classList.add("show");
    const tipLeft = Math.min(rect.width - 140, Math.max(8, e.clientX - rect.left + 12));
    const tipTop = Math.max(4, e.clientY - rect.top - 28);
    tip.style.left = tipLeft + "px";
    tip.style.top = tipTop + "px";
  });
  svg.addEventListener("mouseleave", () => {
    tip.classList.remove("show");
    hoverLine.setAttribute("opacity", 0);
    hoverDot.setAttribute("opacity", 0);
  });

  container.appendChild(svg);
}

// ---------- Calculator ----------

const FICO_TIERS = [
  { min: 780, label: "Excellent" },
  { min: 740, label: "Very Good" },
  { min: 700, label: "Good" },
  { min: 660, label: "Fair" },
  { min: 620, label: "Subprime conventional" },
  { min: 0,   label: "Likely non-conforming" },
];

function ficoTier(score) {
  for (const t of FICO_TIERS) if (score >= t.min) return t.label;
  return "";
}

function syncDownPct() {
  const price = parseFloat($("#m-price").value) || 0;
  const down = parseFloat($("#m-down").value) || 0;
  const pct = price > 0 ? (down / price) * 100 : 0;
  $("#m-down-pct").textContent = pct.toFixed(1) + "%";
  // Highlight matching quick chip
  $$(".quick[data-down-pct]").forEach(q => {
    const target = parseFloat(q.dataset.downPct);
    q.classList.toggle("active", Math.abs(target - pct) < 0.5);
  });
}

function syncFico() {
  const v = parseInt($("#m-fico").value, 10);
  $("#m-fico-readout").textContent = v;
  $("#m-fico-tier").textContent = ficoTier(v);
}

// Wire up form bindings on first housing view (form might not be in DOM yet at script load,
// but it is rendered server-side so this should always find them).
const mForm = $("#mortgage-form");
if (mForm) {
  $("#m-price").addEventListener("input", syncDownPct);
  $("#m-down").addEventListener("input", syncDownPct);
  $("#m-fico").addEventListener("input", syncFico);
  syncDownPct();
  syncFico();

  $$(".quick[data-down-pct]").forEach(q => {
    q.addEventListener("click", () => {
      const pct = parseFloat(q.dataset.downPct);
      const price = parseFloat($("#m-price").value) || 0;
      $("#m-down").value = Math.round(price * pct / 100);
      syncDownPct();
    });
  });

  mForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      home_price: parseFloat($("#m-price").value),
      down_payment: parseFloat($("#m-down").value),
      fico: parseInt($("#m-fico").value, 10),
      term: parseInt($("#m-term").value, 10),
      property_tax_pct: parseFloat($("#m-tax").value),
      insurance_pct: parseFloat($("#m-ins").value),
      hoa_monthly: parseFloat($("#m-hoa").value),
    };
    const resBox = $("#mortgage-result");
    resBox.hidden = false;
    resBox.innerHTML = `<div class="housing-loading">Calculating…</div>`;
    try {
      const r = await fetch("/api/mortgage/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      resBox.innerHTML = renderMortgageResult(data);
    } catch (err) {
      resBox.innerHTML = `<div class="housing-loading">Error: ${err.message}</div>`;
    }
  });
}

function renderMortgageResult(d) {
  const fmt$ = (n, dec = 0) => "$" + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  });
  const mo = d.monthly;
  const li = d.lifetime;
  const aff = d.affordability;
  const adj = (d.rate_estimate?.adjustments || []);

  const adjHTML = adj.length === 0
    ? `<li>Top-tier credit + low LTV — base PMMS rate applies.</li>`
    : adj.map(a => `<li>
        <span class="adj-bps ${a.bps > 0 ? 'neg' : 'pos'}">
          ${a.bps > 0 ? '+' : ''}${a.bps.toFixed(3)}%
        </span>
        ${a.label}
      </li>`).join("");

  // Stacked bar segments — represent the monthly breakdown visually
  const total = mo.total || 1;
  const seg = (label, val, cls) => {
    const pct = (val / total) * 100;
    return pct < 0.5 ? "" : `<div class="pay-seg ${cls}" style="width:${pct}%" title="${label}: ${fmt$(val)}">${pct > 9 ? label : ""}</div>`;
  };

  return `
    <div class="mres-headline">
      <div>
        <div class="mres-eyebrow">Estimated monthly PITI</div>
        <div class="mres-total">${fmt$(mo.total)}<span>/mo</span></div>
      </div>
      <div class="mres-rate">
        <div class="mres-eyebrow">Your estimated rate</div>
        <div class="mres-ratenum">${d.rate.toFixed(3)}%</div>
        <div class="mres-ratebase">base PMMS ${d.rate_estimate.base_rate.toFixed(2)}% · ${d.term}y</div>
      </div>
    </div>

    <div class="pay-bar">
      ${seg("P&I", mo.principal_interest, "pi")}
      ${seg("Tax", mo.property_tax, "tax")}
      ${seg("Ins", mo.insurance, "ins")}
      ${seg("PMI", mo.pmi, "pmi")}
      ${seg("HOA", mo.hoa, "hoa")}
    </div>

    <div class="pay-grid">
      <div class="pay-row pi"><span>Principal &amp; interest</span><strong>${fmt$(mo.principal_interest)}</strong></div>
      <div class="pay-row tax"><span>Property tax</span><strong>${fmt$(mo.property_tax)}</strong></div>
      <div class="pay-row ins"><span>Homeowners insurance</span><strong>${fmt$(mo.insurance)}</strong></div>
      ${mo.pmi > 0 ? `<div class="pay-row pmi"><span>PMI ${d.pmi_drops_at_loan_balance ? `(drops at $${Math.round(d.pmi_drops_at_loan_balance).toLocaleString()} balance)` : ""}</span><strong>${fmt$(mo.pmi)}</strong></div>` : ""}
      ${mo.hoa > 0 ? `<div class="pay-row hoa"><span>HOA</span><strong>${fmt$(mo.hoa)}</strong></div>` : ""}
    </div>

    <div class="rate-adjustments">
      <h4>Rate adjustments applied</h4>
      <ul>${adjHTML}</ul>
    </div>

    <div class="lifetime-grid">
      <div class="lt-cell">
        <label>Loan amount</label>
        <strong>${fmt$(d.loan_amount)}</strong>
        <span class="muted">${(d.ltv * 100).toFixed(1)}% LTV</span>
      </div>
      <div class="lt-cell">
        <label>Total interest paid</label>
        <strong>${fmt$(li.total_interest)}</strong>
        <span class="muted">over ${li.n_months} months</span>
      </div>
      <div class="lt-cell">
        <label>Income at 28% rule</label>
        <strong>${fmt$(aff.gross_income_at_28)}</strong>
        <span class="muted">conservative</span>
      </div>
      <div class="lt-cell">
        <label>Income at 36% rule</label>
        <strong>${fmt$(aff.gross_income_at_36)}</strong>
        <span class="muted">stretched</span>
      </div>
    </div>
  `;
}
