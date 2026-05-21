/* ============================================================
 *  基本面看板 v2 — full redesign
 *
 *  Sections (top → bottom):
 *    1. Hero + last-updated
 *    2. MACRO row — all 5 sectors as compact cards w/ histogram
 *    3. DEEP DIVE — sector identity + weights + KPI grid | score
 *       distribution dot-strip (Chart.js scatter)
 *    4. PICKS — top 5 / bottom 5 cards with 6-bar sub-score breakdown
 *    5. LEDGER — sortable + filterable table with inline score bar +
 *       click-to-expand sub-score breakdown row
 *
 *  Backend endpoints:
 *    GET /api/fundamentals/_overview     — all sectors aggregate
 *    GET /api/fundamentals/{sector_id}   — full scored payload
 * ============================================================ */
(function() {
  "use strict";

  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";

  // Metric order in pick-card breakdown bars — the "core 6" for stocks
  // (the headline fundamentals investors check first).
  const PICK_METRICS_STOCK = ["pe", "pe_fwd", "peg_fwd", "rev_growth", "eps_growth", "roe"];
  const PICK_METRICS_CRYPTO = ["market_cap", "vol_to_mcap", "mom_7d", "mom_30d", "ath_dist", "volatility"];

  // For "lower-is-better" vs "higher-is-better" arrow in expanded row.
  const LOWER_BETTER_METRICS = new Set([
    "pe", "pe_fwd", "peg_av", "peg_fwd", "ps", "pb", "ev_ebitda",
    "de", "beta", "volatility",
  ]);
  const PCT_METRICS = new Set([
    "rev_growth", "eps_growth", "roe", "roic", "gross_margin", "op_margin",
    "fcf_yield", "div_yield", "buyback_yield",
    "mom_7d", "mom_30d", "ath_dist", "volatility", "vol_to_mcap",
  ]);

  // State
  const cache = {};
  let currentSector = null;
  let overviewData = null;
  let initialised = false;
  let distChart = null;
  let subsecChart = null;
  let scatterChart = null;
  let tableState = {
    sortKey: "score", sortDir: "desc",
    text: "", classFilter: "", subsecFilter: "",
    expanded: new Set(),
  };

  // ─────────── format helpers ───────────
  const isNum = v => v !== null && v !== undefined && !isNaN(Number(v));
  function fmtNum(v) {
    if (!isNum(v)) return "—";
    const n = Number(v);
    if (Math.abs(n) >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
    if (Math.abs(n) >= 1e9)  return "$" + (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6)  return "$" + (n / 1e6).toFixed(0) + "M";
    return n.toFixed(2);
  }
  function fmt1(v) { return isNum(v) ? Number(v).toFixed(1) : "—"; }
  function fmt2(v) { return isNum(v) ? Number(v).toFixed(2) : "—"; }
  function fmtPct(v) { return isNum(v) ? Number(v).toFixed(1) + "%" : "—"; }
  function fmtScore(v) { return isNum(v) ? Number(v).toFixed(1) : "—"; }
  function classOf(s) {
    if (!isNum(s)) return "na";
    if (s >= 70) return "good";
    if (s >= 45) return "mid";
    return "high";
  }

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "class") e.className = props[k];
      else if (k === "style") e.setAttribute("style", props[k]);
      else if (k === "html") e.innerHTML = props[k];
      else if (k.startsWith("on") && typeof props[k] === "function") e[k] = props[k];
      else if (props[k] !== undefined && props[k] !== null) e.setAttribute(k, props[k]);
    }
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      e.appendChild(typeof k === "string" || typeof k === "number" ? document.createTextNode(k) : k);
    }
    return e;
  }

  // ─────────── network ───────────
  async function fetchOverview(force) {
    if (!force && overviewData) return overviewData;
    const url = API_BASE + "/api/fundamentals/_overview" + (force ? "?force=true" : "");
    const r = await fetch(url);
    if (!r.ok) throw new Error("overview http " + r.status);
    overviewData = await r.json();
    return overviewData;
  }
  async function fetchSector(id, opts) {
    opts = opts || {};
    if (!opts.force && cache[id]) return cache[id];
    const url = API_BASE + "/api/fundamentals/" + encodeURIComponent(id)
      + (opts.force ? "?force=true" : "");
    const r = await fetch(url);
    if (!r.ok) throw new Error("sector " + id + " http " + r.status);
    const j = await r.json();
    cache[id] = j;
    return j;
  }

  // ─────────── MACRO row ───────────
  function renderMacro() {
    const wrap = document.getElementById("fund2-macro");
    if (!wrap || !overviewData) return;
    wrap.innerHTML = "";

    const sectors = overviewData.sectors || [];
    sectors.forEach(s => {
      const total = (s.good || 0) + (s.mid || 0) + (s.high || 0);
      const goodPct = total ? (s.good / total) * 100 : 0;
      const midPct  = total ? (s.mid  / total) * 100 : 0;
      const highPct = total ? (s.high / total) * 100 : 0;

      const card = el("button", {
        class: "fund2-macro-card" + (s.id === currentSector ? " active" : ""),
        "data-sector": s.id,
        onclick: () => selectSector(s.id),
      });

      // header row: icon + name + ticker count
      card.appendChild(el("div", { class: "fund2-mc-head" },
        el("span", { class: "fund2-mc-icon" }, s.icon || "📊"),
        el("span", { class: "fund2-mc-name" }, s.name || ""),
        el("span", { class: "fund2-mc-tcount" }, "n=" + (s.ticker_count || 0))
      ));

      // big median score
      const scoreCls = classOf(s.median_score);
      card.appendChild(el("div", { class: "fund2-mc-score-row" },
        el("div", { class: "fund2-mc-score-label" }, "中位综合分"),
        el("div", { class: "fund2-mc-score fund2-c-" + scoreCls },
          isNum(s.median_score) ? Number(s.median_score).toFixed(0) : "—"),
      ));

      // distribution histogram (stacked horizontal bar)
      const histWrap = el("div", { class: "fund2-mc-hist" });
      if (total > 0) {
        if (goodPct > 0) histWrap.appendChild(el("span", {
          class: "fund2-mc-hist-seg fund2-c-bg-good",
          style: "width:" + goodPct + "%;",
          title: "优秀 (≥70): " + s.good,
        }));
        if (midPct > 0) histWrap.appendChild(el("span", {
          class: "fund2-mc-hist-seg fund2-c-bg-mid",
          style: "width:" + midPct + "%;",
          title: "中性 (45–70): " + s.mid,
        }));
        if (highPct > 0) histWrap.appendChild(el("span", {
          class: "fund2-mc-hist-seg fund2-c-bg-high",
          style: "width:" + highPct + "%;",
          title: "弱势 (<45): " + s.high,
        }));
      } else {
        histWrap.appendChild(el("span", { class: "fund2-mc-hist-empty" }, "暂无评分"));
      }
      card.appendChild(histWrap);

      // count breakdown legend
      card.appendChild(el("div", { class: "fund2-mc-counts" },
        el("span", { class: "fund2-c-good" }, "✓ " + (s.good || 0)),
        el("span", { class: "fund2-c-mid" },  "· " + (s.mid || 0)),
        el("span", { class: "fund2-c-high" }, "✗ " + (s.high || 0)),
      ));

      // top / bottom 1 line
      const tt = s.top_ticker, bt = s.bottom_ticker;
      card.appendChild(el("div", { class: "fund2-mc-foot" },
        el("span", { class: "fund2-mc-foot-label" }, "Top"),
        el("span", { class: "fund2-mc-foot-val fund2-c-good" },
          tt ? (tt + " " + (isNum(s.top_score) ? Math.round(s.top_score) : "—")) : "—"),
        el("span", { class: "fund2-mc-foot-sep" }, "·"),
        el("span", { class: "fund2-mc-foot-label" }, "Bot"),
        el("span", { class: "fund2-mc-foot-val fund2-c-high" },
          bt ? (bt + " " + (isNum(s.bottom_score) ? Math.round(s.bottom_score) : "—")) : "—"),
      ));

      wrap.appendChild(card);
    });

    // stamp updated time
    const upd = document.getElementById("fund2-updated");
    if (upd) {
      upd.textContent = (overviewData.generated_at || "—")
        + (overviewData.data_source === "no_api_key" ? "  ⚠ 缺 ALPHA_VANTAGE_API_KEY" : "");
    }
  }

  // ─────────── SECTOR CARD (deep-dive left) ───────────
  function renderSectorCard(payload) {
    const card = document.getElementById("fund2-sector-card");
    if (!card) return;
    card.innerHTML = "";

    const sector = payload.sector || {};
    const stats = payload.stats || {};
    const weights = sector.weights || {};

    // Sector identity
    card.appendChild(el("div", { class: "fund2-sc-id" },
      el("span", { class: "fund2-sc-icon" }, sector.icon || "📊"),
      el("div", { class: "fund2-sc-text" },
        el("div", { class: "fund2-sc-name" }, sector.name || ""),
        el("div", { class: "fund2-sc-desc" }, sector.desc || ""),
      ),
    ));

    // Weight rationale strip
    if (sector.weight_rationale) {
      card.appendChild(el("div", { class: "fund2-sc-rationale" },
        el("span", { class: "fund2-sc-rationale-key" }, "权重逻辑"),
        sector.weight_rationale,
      ));
    }

    // Weight bars (compact horizontal) — show only metrics with weight > 0,
    // sorted by weight desc so the dominant signals are at the top.
    const wWrap = el("div", { class: "fund2-sc-weights" });
    wWrap.appendChild(el("div", { class: "fund2-sc-section-h" }, "指标权重 · METRIC WEIGHTS"));
    const wList = el("div", { class: "fund2-sc-w-list" });
    const meta = payload.metrics_meta || {};
    const wEntries = Object.entries(weights)
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const maxW = wEntries.length ? wEntries[0][1] : 1;
    wEntries.forEach(([k, w]) => {
      const label = (meta[k] && meta[k].label) || k;
      const row = el("div", { class: "fund2-sc-w-row" });
      row.appendChild(el("span", { class: "fund2-sc-w-label" }, label));
      const barTrack = el("div", { class: "fund2-sc-w-track" });
      // scale bar by ratio to max weight so the dominant signal is full-bar
      const fill = el("div", { class: "fund2-sc-w-fill",
        style: "width:" + (w / maxW * 100) + "%;" });
      barTrack.appendChild(fill);
      row.appendChild(barTrack);
      row.appendChild(el("span", { class: "fund2-sc-w-pct" }, w + "%"));
      wList.appendChild(row);
    });
    wWrap.appendChild(wList);
    card.appendChild(wWrap);

    // KPI grid (3×2)
    const kpiWrap = el("div", { class: "fund2-sc-kpis" });
    kpiWrap.appendChild(el("div", { class: "fund2-sc-section-h" }, "评分概览 · STATS"));
    const grid = el("div", { class: "fund2-sc-kpi-grid" });
    const kpis = [
      { label: "覆盖股票", value: stats.total || 0 },
      { label: "有评分",   value: stats.with_score || 0 },
      { label: "中位分", value: isNum(stats.median_score) ? Number(stats.median_score).toFixed(1) : "—",
        cls: "fund2-c-" + classOf(stats.median_score) },
      { label: "优秀 ≥70", value: stats.good || 0, cls: "fund2-c-good" },
      { label: "中性",     value: stats.mid || 0,  cls: "fund2-c-mid" },
      { label: "弱势 <45", value: stats.high || 0, cls: "fund2-c-high" },
    ];
    kpis.forEach(k => {
      grid.appendChild(el("div", { class: "fund2-sc-kpi" },
        el("div", { class: "fund2-sc-kpi-label" }, k.label),
        el("div", { class: "fund2-sc-kpi-value " + (k.cls || "") }, String(k.value)),
      ));
    });
    kpiWrap.appendChild(grid);
    card.appendChild(kpiWrap);
  }

  // ─────────── SCORE DISTRIBUTION (Chart.js scatter / strip) ───────────
  function renderDistribution(payload) {
    const canvas = document.getElementById("fund2-dist-canvas");
    if (!canvas) return;
    if (!window.Chart) {
      canvas.parentElement.innerHTML =
        '<div class="muted" style="padding:24px;text-align:center;">Chart.js 加载失败</div>';
      return;
    }

    const rows = (payload.rows || []).filter(r => isNum(r.score));
    // Assign each ticker a small vertical jitter so dots don't fully stack.
    const buckets = {};
    rows.forEach(r => {
      const b = Math.round(r.score);
      (buckets[b] = buckets[b] || []).push(r);
    });
    const points = [];
    Object.entries(buckets).forEach(([scoreStr, arr]) => {
      const s = Number(scoreStr);
      arr.forEach((r, i) => {
        const n = arr.length;
        const y = n === 1 ? 0 : (-1 + (2 * i) / (n - 1));
        points.push({ x: s, y, ticker: r.ticker, name: r.name, score: r.score, cls: r.score_class });
      });
    });

    const styles = getComputedStyle(document.documentElement);
    const mutedCol = styles.getPropertyValue("--text-muted").trim() || "#807a72";
    const borderCol = styles.getPropertyValue("--border").trim() || "#e5dfd0";
    const goodCol = styles.getPropertyValue("--success").trim() || "#2d6b3e";
    const midCol  = styles.getPropertyValue("--accent-3").trim() || "#b8860b";
    const highCol = styles.getPropertyValue("--danger").trim() || "#a83232";

    const ds = (cls, color) => ({
      label: cls === "good" ? "优秀 ≥70" : cls === "mid" ? "中性 45-70" : "弱势 <45",
      data: points.filter(p => p.cls === cls).map(p => ({ x: p.x, y: p.y, ticker: p.ticker, name: p.name, score: p.score })),
      backgroundColor: color + "cc",
      borderColor: color,
      borderWidth: 1,
      pointRadius: 6, pointHoverRadius: 9,
    });

    if (distChart) distChart.destroy();
    distChart = new Chart(canvas, {
      type: "scatter",
      data: { datasets: [ds("good", goodCol), ds("mid", midCol), ds("high", highCol)] },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = ctx.raw;
                return r.ticker + " (" + (r.name || "") + ") · score " + Number(r.score).toFixed(1);
              },
              title: () => "",
            },
          },
        },
        scales: {
          x: {
            type: "linear", min: 0, max: 100,
            grid: { color: borderCol, drawBorder: false },
            ticks: { color: mutedCol, font: { size: 11 }, stepSize: 10 },
            title: { display: true, text: "综合分 (0-100)", color: mutedCol, font: { size: 11 } },
          },
          y: {
            min: -1.5, max: 1.5,
            grid: { display: false }, ticks: { display: false }, border: { display: false },
            title: { display: false },
          },
        },
      },
      plugins: [{
        id: "thresholds",
        afterDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          if (!chartArea) return;
          [45, 70].forEach((thr, idx) => {
            const x = scales.x.getPixelForValue(thr);
            ctx.save();
            ctx.strokeStyle = idx === 0 ? midCol : goodCol;
            ctx.globalAlpha = 0.4;
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = idx === 0 ? midCol : goodCol;
            ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
            ctx.fillText(thr.toString(), x + 3, chartArea.top + 11);
            ctx.restore();
          });
        },
      }],
    });
  }

  // ─────────── COMMENTARY (核心结论与解读) ───────────
  function renderCommentary(payload) {
    const wrap = document.getElementById("fund2-commentary");
    const hint = document.getElementById("fund2-commentary-hint");
    if (!wrap) return;
    const items = payload.commentary || [];
    wrap.innerHTML = "";
    if (items.length === 0) {
      wrap.innerHTML = '<div class="muted" style="padding:18px;">暂无解读。请刷新或稍后重试。</div>';
      return;
    }
    items.forEach((p, idx) => {
      const card = el("div", { class: "fund2-com-card" });
      card.appendChild(el("div", { class: "fund2-com-num" }, "0" + (idx + 1)));
      const body = el("div", { class: "fund2-com-body" });
      body.appendChild(el("div", { class: "fund2-com-title" }, p.title || ""));
      const para = el("p", { class: "fund2-com-text", html: p.body || "" });
      body.appendChild(para);
      card.appendChild(body);
      wrap.appendChild(card);
    });
    if (hint) hint.textContent = (payload.sector && payload.sector.name)
      ? `当前板块：${payload.sector.name}`
      : "—";
  }

  // ─────────── SUB-SECTOR RANKING (horizontal bars) ───────────
  function renderSubsecChart(payload) {
    const canvas = document.getElementById("fund2-subsec-canvas");
    if (!canvas || !window.Chart) return;
    const subs = (payload.sub_sector_stats || []).slice();
    // Sort by median desc, push null-median sub-sectors to the end.
    subs.sort((a, b) => {
      const av = isNum(a.median_score) ? a.median_score : -1;
      const bv = isNum(b.median_score) ? b.median_score : -1;
      return bv - av;
    });

    const styles = getComputedStyle(document.documentElement);
    const mutedCol = styles.getPropertyValue("--text-muted").trim() || "#807a72";
    const borderCol = styles.getPropertyValue("--border").trim() || "#e5dfd0";
    const goodCol = styles.getPropertyValue("--success").trim() || "#2d6b3e";
    const midCol  = styles.getPropertyValue("--accent-3").trim() || "#b8860b";
    const highCol = styles.getPropertyValue("--danger").trim() || "#a83232";
    const naCol   = styles.getPropertyValue("--border-strong").trim() || "#c8c0ad";

    const labels = subs.map(s => s.name);
    const data = subs.map(s => isNum(s.median_score) ? s.median_score : 0);
    const colors = subs.map(s => {
      if (!isNum(s.median_score)) return naCol;
      if (s.median_score >= 70) return goodCol;
      if (s.median_score >= 45) return midCol;
      return highCol;
    });

    if (subsecChart) subsecChart.destroy();
    subsecChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "子板块中位综合分",
          data,
          backgroundColor: colors.map(c => c + "cc"),
          borderColor: colors,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const s = subs[ctx.dataIndex];
                return `中位分 ${isNum(s.median_score) ? s.median_score.toFixed(1) : "—"} · ` +
                  `已评分 ${s.with_score}/${s.ticker_count} · ` +
                  `✓${s.good} ·${s.mid} ✗${s.high}`;
              },
              title: ctx => subs[ctx[0].dataIndex].name,
            },
          },
        },
        scales: {
          x: {
            min: 0, max: 100,
            grid: { color: borderCol, drawBorder: false },
            ticks: { color: mutedCol, font: { size: 11 }, stepSize: 25 },
            title: { display: true, text: "中位综合分 (0-100)", color: mutedCol, font: { size: 11 } },
          },
          y: {
            grid: { display: false },
            ticks: { color: mutedCol, font: { size: 12 } },
          },
        },
      },
      plugins: [{
        id: "subsec-thresholds",
        afterDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          if (!chartArea) return;
          [45, 70].forEach((thr, idx) => {
            const x = scales.x.getPixelForValue(thr);
            ctx.save();
            ctx.strokeStyle = idx === 0 ? midCol : goodCol;
            ctx.globalAlpha = 0.35;
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.restore();
          });
        },
      }],
    });
  }

  // ─────────── Fwd PE × EPS YoY SCATTER ───────────
  function renderScatterChart(payload) {
    const canvas = document.getElementById("fund2-scatter-canvas");
    if (!canvas || !window.Chart) return;

    const isCrypto = payload.sector && payload.sector.metric_set === "crypto";
    // Update title/subtitle dynamically so crypto's axes make sense.
    const titleEl = document.querySelector('.fund2-viz-card:nth-child(2) .fund2-viz-title');
    const subEl   = document.querySelector('.fund2-viz-card:nth-child(2) .fund2-viz-sub');
    if (titleEl) titleEl.textContent = isCrypto
      ? "30d 动量 × 距 ATH 散点图"
      : "Fwd PE × EPS YoY 散点图";
    if (subEl) subEl.textContent = isCrypto
      ? "x = 30d 涨跌 · y = 距 ATH% · 颜色 = 综合分等级"
      : "x = Fwd PE · y = EPS YoY% · 颜色 = 综合分等级";

    if (isCrypto) return renderCryptoScatter(payload);

    const rows = (payload.rows || []).filter(r =>
      isNum(r.pe_fwd) && isNum(r.eps_growth)
    );

    const styles = getComputedStyle(document.documentElement);
    const mutedCol = styles.getPropertyValue("--text-muted").trim() || "#807a72";
    const borderCol = styles.getPropertyValue("--border").trim() || "#e5dfd0";
    const goodCol = styles.getPropertyValue("--success").trim() || "#2d6b3e";
    const midCol  = styles.getPropertyValue("--accent-3").trim() || "#b8860b";
    const highCol = styles.getPropertyValue("--danger").trim() || "#a83232";

    // Cap axes so outliers don't compress the meaningful region.
    // Most stocks live in PE 0-80, EPS YoY -50% to +150%. Truncate further
    // outliers visually (they cluster at the edge); hover tooltip still
    // shows the real value, and they get a 🚀 ⬆ marker so the user knows.
    const peCap = 120;
    const epsCap = 300;
    const epsFloor = -100;
    const clampX = v => Math.min(peCap, Math.max(0, v));
    const clampY = v => Math.min(epsCap, Math.max(epsFloor, v));

    const ds = (cls, color) => ({
      label: cls === "good" ? "优秀 ≥70" : cls === "mid" ? "中性 45-70" : "弱势 <45",
      data: rows
        .filter(r => r.score_class === cls)
        .map(r => ({
          x: clampX(r.pe_fwd),
          y: clampY(r.eps_growth),
          // Keep original values on the datapoint so tooltip + outlier
          // detection can report the real numbers.
          xReal: r.pe_fwd,
          yReal: r.eps_growth,
          clamped: (r.pe_fwd > peCap) || (r.eps_growth > epsCap) || (r.eps_growth < epsFloor),
          ticker: r.ticker, name: r.name,
          score: r.score, sub_sector: r.sub_sector,
        })),
      backgroundColor: color + "cc",
      borderColor: color,
      borderWidth: 1,
      pointRadius: 7, pointHoverRadius: 11,
    });

    if (scatterChart) scatterChart.destroy();
    scatterChart = new Chart(canvas, {
      type: "scatter",
      data: { datasets: [ds("good", goodCol), ds("mid", midCol), ds("high", highCol)] },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: true,
            labels: { color: mutedCol, font: { size: 11 }, boxWidth: 10 } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = ctx.raw;
                const peStr = isNum(r.xReal) ? r.xReal.toFixed(1) : "—";
                const epsStr = isNum(r.yReal) ? r.yReal.toFixed(1) + "%" : "—";
                const out = [
                  `${r.ticker}  ${r.name || ""}`,
                  `子板块: ${r.sub_sector || "—"}`,
                  `Fwd PE: ${peStr}  ·  EPS YoY: ${epsStr}`,
                  `综合分: ${isNum(r.score) ? r.score.toFixed(1) : "—"}`,
                ];
                if (r.clamped) out.push("⚠ 该点超出坐标轴范围，已贴边显示");
                return out;
              },
              title: () => "",
            },
          },
        },
        scales: {
          x: {
            min: 0, max: peCap,
            grid: { color: borderCol, drawBorder: false },
            ticks: { color: mutedCol, font: { size: 11 } },
            title: { display: true, text: "Fwd PE (越低越便宜，>" + peCap + " 贴边)",
                     color: mutedCol, font: { size: 11 } },
          },
          y: {
            min: epsFloor, max: epsCap,
            grid: { color: borderCol, drawBorder: false },
            ticks: { color: mutedCol, font: { size: 11 },
              callback: v => v + "%" },
            title: { display: true, text: "EPS YoY % (越高越成长，>" + epsCap + "% 贴边)",
                     color: mutedCol, font: { size: 11 } },
          },
        },
      },
      plugins: [{
        id: "scatter-quadrants",
        afterDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          if (!chartArea) return;
          // Vertical line at PE=20 (commonly "growth vs value" divider)
          const xLine = scales.x.getPixelForValue(20);
          // Horizontal line at EPS YoY=20 (commonly "real growth" cutoff)
          const yLine = scales.y.getPixelForValue(20);
          ctx.save();
          ctx.strokeStyle = mutedCol;
          ctx.globalAlpha = 0.30;
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(xLine, chartArea.top); ctx.lineTo(xLine, chartArea.bottom);
          ctx.moveTo(chartArea.left, yLine); ctx.lineTo(chartArea.right, yLine);
          ctx.stroke();
          ctx.restore();
          // Quadrant labels
          ctx.save();
          ctx.fillStyle = mutedCol;
          ctx.globalAlpha = 0.55;
          ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillText("便宜+成长", chartArea.left + 8, yLine - 6);
          ctx.fillText("贵+成长",  xLine + 8,         yLine - 6);
          ctx.fillText("便宜+乏力", chartArea.left + 8, yLine + 14);
          ctx.fillText("贵+乏力",   xLine + 8,         yLine + 14);
          ctx.restore();
        },
      }],
    });
  }

  // ─────────── Crypto scatter (30d mom × ATH dist, dot size = mcap) ───────────
  function renderCryptoScatter(payload) {
    const canvas = document.getElementById("fund2-scatter-canvas");
    if (!canvas || !window.Chart) return;
    const rows = (payload.rows || []).filter(r =>
      isNum(r.mom_30d) && isNum(r.ath_dist)
    );

    const styles = getComputedStyle(document.documentElement);
    const mutedCol = styles.getPropertyValue("--text-muted").trim() || "#807a72";
    const borderCol = styles.getPropertyValue("--border").trim() || "#e5dfd0";
    const goodCol = styles.getPropertyValue("--success").trim() || "#2d6b3e";
    const midCol  = styles.getPropertyValue("--accent-3").trim() || "#b8860b";
    const highCol = styles.getPropertyValue("--danger").trim() || "#a83232";

    // Scale dot size by market cap (log scale so BTC doesn't dominate)
    const maxMcap = Math.max(...rows.map(r => r.market_cap || 1));
    const dotSize = mcap => {
      if (!isNum(mcap) || mcap <= 0) return 7;
      const logRatio = Math.log(mcap) / Math.log(maxMcap);
      return Math.max(7, Math.min(18, 7 + 11 * logRatio));
    };

    const ds = (cls, color) => ({
      label: cls === "good" ? "优秀 ≥70" : cls === "mid" ? "中性 45-70" : "弱势 <45",
      data: rows
        .filter(r => r.score_class === cls)
        .map(r => ({
          x: r.mom_30d,
          y: r.ath_dist,
          ticker: r.ticker, name: r.name,
          score: r.score, sub_sector: r.sub_sector,
          mcap: r.market_cap,
        })),
      backgroundColor: color + "cc",
      borderColor: color,
      borderWidth: 1,
      pointRadius: function(ctx) { return dotSize(ctx.raw && ctx.raw.mcap); },
      pointHoverRadius: function(ctx) { return dotSize(ctx.raw && ctx.raw.mcap) + 4; },
    });

    if (scatterChart) scatterChart.destroy();
    scatterChart = new Chart(canvas, {
      type: "scatter",
      data: { datasets: [ds("good", goodCol), ds("mid", midCol), ds("high", highCol)] },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: true,
            labels: { color: mutedCol, font: { size: 11 }, boxWidth: 10 } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const r = ctx.raw;
                const mcapStr = isNum(r.mcap) ? "$" + (r.mcap / 1e9).toFixed(1) + "B" : "—";
                return [
                  `${r.ticker}  ${r.name || ""}`,
                  `子板块: ${r.sub_sector || "—"}`,
                  `30d 动量: ${r.x.toFixed(1)}%  ·  距 ATH: ${r.y.toFixed(1)}%`,
                  `市值: ${mcapStr}  ·  综合分: ${isNum(r.score) ? r.score.toFixed(1) : "—"}`,
                ];
              },
              title: () => "",
            },
          },
        },
        scales: {
          x: {
            grid: { color: borderCol, drawBorder: false },
            ticks: { color: mutedCol, font: { size: 11 }, callback: v => v + "%" },
            title: { display: true, text: "30d 涨跌 % (右侧 = 上涨)",
                     color: mutedCol, font: { size: 11 } },
          },
          y: {
            min: 0,
            grid: { color: borderCol, drawBorder: false },
            ticks: { color: mutedCol, font: { size: 11 }, callback: v => v + "%" },
            title: { display: true, text: "距 ATH % (越高 = 折价越深，潜在空间越大)",
                     color: mutedCol, font: { size: 11 } },
          },
        },
      },
      plugins: [{
        id: "crypto-zero-line",
        afterDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          if (!chartArea) return;
          const xZero = scales.x.getPixelForValue(0);
          ctx.save();
          ctx.strokeStyle = mutedCol;
          ctx.globalAlpha = 0.35;
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(xZero, chartArea.top); ctx.lineTo(xZero, chartArea.bottom);
          ctx.stroke();
          ctx.restore();
          ctx.save();
          ctx.fillStyle = mutedCol;
          ctx.globalAlpha = 0.6;
          ctx.font = "10px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillText("下跌区", chartArea.left + 8, chartArea.top + 14);
          ctx.fillText("上涨区", xZero + 8, chartArea.top + 14);
          ctx.restore();
        },
      }],
    });
  }

  // ─────────── PICK CARDS ───────────
  function pickCard(row, mode, ctx) {
    // ctx: { isCrypto, meta } — supplied by caller via closure
    const meta = (ctx && ctx.meta) || {};
    const isCrypto = !!(ctx && ctx.isCrypto);
    const pickMetrics = isCrypto ? PICK_METRICS_CRYPTO : PICK_METRICS_STOCK;

    const card = el("div", { class: "fund2-pick fund2-pick--" + mode });

    card.appendChild(el("div", { class: "fund2-pick-head" },
      el("span", { class: "fund2-pick-rank" }, "#" + row.rank),
      el("span", { class: "fund2-pick-ticker fund2-c-" + (row.score_class || "na") }, row.ticker || ""),
      el("span", { class: "fund2-pick-name muted" }, (row.name || "").slice(0, 22)),
    ));

    const scoreWrap = el("div", { class: "fund2-pick-score-wrap" });
    scoreWrap.appendChild(el("div", { class: "fund2-pick-score-val fund2-c-" + (row.score_class || "na") },
      fmtScore(row.score)));
    const scoreTrack = el("div", { class: "fund2-pick-score-track" });
    if (isNum(row.score)) {
      scoreTrack.appendChild(el("div", {
        class: "fund2-pick-score-fill fund2-c-bg-" + (row.score_class || "na"),
        style: "width:" + Math.max(0, Math.min(100, row.score)) + "%;",
      }));
    }
    scoreWrap.appendChild(scoreTrack);
    card.appendChild(scoreWrap);

    const breakdown = el("div", { class: "fund2-pick-breakdown" });
    const subs = row.sub_scores || {};
    pickMetrics.forEach(k => {
      const sub = subs[k];
      const raw = row[k];
      const subCls = classOf(sub);
      const r = el("div", { class: "fund2-pick-br-row" });
      const label = (meta[k] && meta[k].label) || k;
      r.appendChild(el("span", { class: "fund2-pick-br-label" }, label));
      const track = el("div", { class: "fund2-pick-br-track" });
      if (isNum(sub)) {
        track.appendChild(el("div", {
          class: "fund2-pick-br-fill fund2-c-bg-" + subCls,
          style: "width:" + Math.max(0, Math.min(100, sub)) + "%;",
        }));
      }
      r.appendChild(track);
      r.appendChild(el("span", { class: "fund2-pick-br-raw " + (PCT_METRICS.has(k) ? "pct" : "") },
        formatMetricValue(k, raw)));
      breakdown.appendChild(r);
    });
    card.appendChild(breakdown);

    // strongest / weakest tags — pulled from ALL sub-scores (not just the visible 6)
    const subEntries = Object.keys(meta).map(k => ({ k, s: subs[k] })).filter(e => isNum(e.s));
    if (subEntries.length > 0) {
      subEntries.sort((a, b) => b.s - a.s);
      const strongest = subEntries[0];
      const weakest = subEntries[subEntries.length - 1];
      const labelOf = k => (meta[k] && meta[k].label) || k;
      const tags = el("div", { class: "fund2-pick-tags" });
      tags.appendChild(el("span", { class: "fund2-pick-tag fund2-pick-tag--up" },
        "强 ", el("strong", null, labelOf(strongest.k)), " " + Math.round(strongest.s)));
      tags.appendChild(el("span", { class: "fund2-pick-tag fund2-pick-tag--down" },
        "弱 ", el("strong", null, labelOf(weakest.k)), " " + Math.round(weakest.s)));
      card.appendChild(tags);
    }

    return card;
  }

  // Per-metric formatter: mcap as $X.YB, percents as %, ratios as N.NN.
  function formatMetricValue(metric, v) {
    if (!isNum(v)) return "—";
    if (metric === "market_cap") return fmtNum(v);
    if (PCT_METRICS.has(metric)) return fmtPct(v);
    return fmt2(v);
  }

  // ─────────── EXPANDED ROW (21-metric breakdown) ───────────
  //
  // Tile-grid redesign. Each metric is a square tile where:
  //   - tile SIZE encodes weight (heavy metrics get larger tiles)
  //   - tile COLOR encodes sub-score via heatmap (red→amber→green)
  //   - LABEL has direction arrow baked in (↑ / ↓)
  //   - VALUE shown prominently in centre
  //   - Sub-score badge top-right, weight badge bottom-right
  //
  // Group header shows a weighted-average score for the entire category
  // so the user can scan groups (estimated 5 secs) before diving in.

  // Returns CSS color string interpolated red→amber→green by sub-score 0-100.
  function heatColor(sub) {
    if (!isNum(sub)) return null;
    const s = Math.max(0, Math.min(100, sub));
    // Hue: 0 = red, 50 = amber, 70+ = green. Linear interp 0→100 → 0→130 deg.
    // Tweaked endpoints: <45 red zone (hue 0-40), 45-70 amber (40-70 hue),
    // ≥70 green (70-130 hue).
    let hue;
    if (s < 45)      hue = 0  + (s / 45) * 30;          // 0  → 30   (red → orange)
    else if (s < 70) hue = 30 + ((s - 45) / 25) * 40;   // 30 → 70   (orange → yellow-green)
    else             hue = 70 + ((s - 70) / 30) * 50;   // 70 → 120  (yellow-green → green)
    return `hsl(${Math.round(hue)}, 55%, 38%)`;
  }
  function heatTint(sub, alpha) {
    if (!isNum(sub)) return null;
    const s = Math.max(0, Math.min(100, sub));
    let hue;
    if (s < 45)      hue = 0  + (s / 45) * 30;
    else if (s < 70) hue = 30 + ((s - 45) / 25) * 40;
    else             hue = 70 + ((s - 70) / 30) * 50;
    return `hsla(${Math.round(hue)}, 55%, 45%, ${alpha})`;
  }

  function buildBreakdownPanel(row, payload) {
    const meta = payload.metrics_meta || {};
    const groups = payload.metric_groups || {};
    const weights = (payload.sector && payload.sector.weights) || {};
    const subs = row.sub_scores || {};
    const metricCount = Object.keys(meta).length;
    const sectorMetricSet = payload.sector && payload.sector.metric_set;

    const panel = el("div", { class: "fund2-bk-panel" });

    // Header — ticker, name, overall score chip
    panel.appendChild(el("div", { class: "fund2-bk-head" },
      el("span", { class: "fund2-bk-head-icon" }, "🔬"),
      el("span", { class: "fund2-bk-head-title" },
        metricCount + " 维度评分构成"),
      el("span", { class: "fund2-bk-head-ticker" }, row.ticker || ""),
      el("span", { class: "fund2-bk-head-name muted" }, (row.name || "")),
      el("span", { class: "fund2-bk-head-spacer" }),
      el("span", { class: "fund2-bk-head-score fund2-c-" + (row.score_class || "na") },
        fmtScore(row.score)),
      el("span", { class: "fund2-bk-head-score-lbl muted" }, "综合分"),
    ));

    // Legend (color scale + arrow guide) — orients new users.
    const legend = el("div", { class: "fund2-bk-legend" });
    legend.appendChild(el("span", { class: "fund2-bk-legend-label" }, "子分配色"));
    [
      { label: "<45 弱", val: 22 },
      { label: "45-60",  val: 52 },
      { label: "60-70",  val: 65 },
      { label: "70-85",  val: 78 },
      { label: "≥85 强", val: 92 },
    ].forEach(s => {
      legend.appendChild(el("span", {
        class: "fund2-bk-legend-swatch",
        style: "background:" + heatColor(s.val) + ";",
      }, s.label));
    });
    legend.appendChild(el("span", { class: "fund2-bk-legend-spacer" }));
    legend.appendChild(el("span", { class: "fund2-bk-legend-label" }, "方向"));
    legend.appendChild(el("span", { class: "fund2-bk-legend-arrow" }, "↑ 越高越好"));
    legend.appendChild(el("span", { class: "fund2-bk-legend-arrow" }, "↓ 越低越好"));
    legend.appendChild(el("span", { class: "fund2-bk-legend-label" }, "瓦片大小"));
    legend.appendChild(el("span", { class: "fund2-bk-legend-note" }, "= 权重"));
    panel.appendChild(legend);

    // Group by category
    const byGroup = {};
    Object.entries(meta).forEach(([k, cfg]) => {
      const g = cfg.group || "other";
      (byGroup[g] = byGroup[g] || []).push(k);
    });

    const groupGrid = el("div", { class: "fund2-bk-groups" });

    Object.keys(groups).forEach(g => {
      const metricsInGroup = byGroup[g];
      if (!metricsInGroup || metricsInGroup.length === 0) return;

      // Total weight in this group → drives whether the group occupies
      // a "wide" or "narrow" column. Visualises which categories the
      // sector cares about most.
      const groupWeight = metricsInGroup.reduce((sum, k) => sum + (weights[k] || 0), 0);
      // Weighted-average sub-score for the group (skipping missing).
      let wSum = 0, scoreSum = 0;
      metricsInGroup.forEach(k => {
        const s = subs[k];
        const w = weights[k] || 0;
        if (isNum(s) && w > 0) {
          wSum += w; scoreSum += s * w;
        }
      });
      const groupScore = wSum > 0 ? Math.round(scoreSum / wSum) : null;

      const card = el("div", { class: "fund2-bk-group" });
      // Group header: name + total weight + weighted avg sub-score
      const header = el("div", { class: "fund2-bk-group-head" });
      header.appendChild(el("span", { class: "fund2-bk-group-name" }, groups[g]));
      header.appendChild(el("span", { class: "fund2-bk-group-weight muted" },
        "板块权重 " + groupWeight + "%"));
      if (isNum(groupScore)) {
        const groupCls = classOf(groupScore);
        const pill = el("span", { class: "fund2-bk-group-score fund2-c-" + groupCls,
          style: "border-color:" + heatTint(groupScore, 0.7) + ";"
               + "background:" + heatTint(groupScore, 0.15) + ";" },
          String(groupScore));
        header.appendChild(pill);
      }
      card.appendChild(header);

      // Tile grid — each metric is a tile sized by weight
      const tiles = el("div", { class: "fund2-bk-tiles" });
      metricsInGroup.forEach(k => {
        const cfg = meta[k];
        const sub = subs[k];
        const raw = row[k];
        const w = weights[k] || 0;
        const dirArrow = LOWER_BETTER_METRICS.has(k) ? "↓" : "↑";
        const hasData = isNum(sub) || isNum(raw);
        // Tile size class: 'lg' (weight ≥ 15), 'md' (≥ 8), 'sm' (else)
        const sizeCls = w >= 15 ? "lg" : (w >= 8 ? "md" : "sm");
        const colorCls = "fund2-bk-tile--" + (hasData ? classOf(sub) : "na");
        const tile = el("div", {
          class: "fund2-bk-tile " + colorCls + " fund2-bk-tile-" + sizeCls,
          style: hasData && isNum(sub)
            ? "background:" + heatTint(sub, 0.18) + ";"
            + "border-color:" + heatTint(sub, 0.55) + ";"
            : "",
        });
        // Top row: arrow + label + sub-score pill
        const top = el("div", { class: "fund2-bk-tile-top" });
        top.appendChild(el("span", {
          class: "fund2-bk-tile-arrow",
          title: LOWER_BETTER_METRICS.has(k) ? "越低越好" : "越高越好",
        }, dirArrow));
        top.appendChild(el("span", { class: "fund2-bk-tile-label" }, cfg.label || k));
        if (isNum(sub)) {
          top.appendChild(el("span", {
            class: "fund2-bk-tile-sub",
            style: "background:" + heatColor(sub) + ";",
          }, String(Math.round(sub))));
        }
        tile.appendChild(top);
        // Centre: raw value (large) or em-dash for missing
        const valWrap = el("div", { class: "fund2-bk-tile-val" + (hasData ? "" : " na") },
          hasData ? formatMetricValue(k, raw) : "—");
        tile.appendChild(valWrap);
        // Bottom row: weight badge (small)
        tile.appendChild(el("div", { class: "fund2-bk-tile-foot muted" },
          w > 0 ? ("权重 " + w + "%") : "未参与评分"));
        tiles.appendChild(tile);
      });
      card.appendChild(tiles);

      groupGrid.appendChild(card);
    });

    panel.appendChild(groupGrid);

    // Sources strip — diagnostic showing which vendor filled each metric.
    // Compact, only shows when we have source data.
    const src = row._sources || {};
    if (Object.keys(src).length > 0) {
      const counts = {};
      Object.values(src).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      const labels = { fh: "Finnhub", yf: "yfinance", av: "Alpha Vantage", derived: "derived" };
      const srcLine = el("div", { class: "fund2-bk-sources muted" });
      srcLine.appendChild(el("span", null, "数据来源："));
      Object.entries(counts).forEach(([k, c], idx) => {
        if (idx > 0) srcLine.appendChild(el("span", { class: "fund2-bk-src-sep" }, "·"));
        srcLine.appendChild(el("span", { class: "fund2-bk-src-tag" },
          (labels[k] || k) + " " + c));
      });
      panel.appendChild(srcLine);
    }

    return panel;
  }

  function renderPicks(payload) {
    const top = document.getElementById("fund2-top");
    const bot = document.getElementById("fund2-bot");
    const ctx = {
      isCrypto: payload.sector && payload.sector.metric_set === "crypto",
      meta: payload.metrics_meta || {},
    };
    if (top) {
      top.innerHTML = "";
      (payload.top_picks || []).forEach(r => top.appendChild(pickCard(r, "good", ctx)));
    }
    if (bot) {
      bot.innerHTML = "";
      (payload.bottom_picks || []).forEach(r => bot.appendChild(pickCard(r, "high", ctx)));
    }
  }

  // ─────────── LEDGER TABLE ───────────

  // Per-sector trailing-column spec. The first 6 columns (#, Code, Name,
  // Sub-sector, Score, Price) are fixed; the trailing 7 vary by sector.
  function tableColumnsFor(payload) {
    const isCrypto = payload.sector && payload.sector.metric_set === "crypto";
    if (isCrypto) {
      return [
        { key: "market_cap",  label: "市值",      fmt: fmtNum,                  pct: false },
        { key: "vol_to_mcap", label: "Vol/MCap", fmt: fmtPct,                  pct: true  },
        { key: "mom_7d",      label: "7d 涨跌",   fmt: fmtPct,                  pct: true  },
        { key: "mom_30d",     label: "30d 涨跌",  fmt: fmtPct,                  pct: true  },
        { key: "ath_dist",    label: "距 ATH",    fmt: fmtPct,                  pct: true  },
        { key: "volatility",  label: "1y 区间",   fmt: fmtPct,                  pct: true  },
        { key: "analyst_target", label: "ATH",   fmt: v => isNum(v) ? "$" + v.toFixed(2) : "—" },
      ];
    }
    return [
      { key: "pe",          label: "PE",         fmt: fmt1 },
      { key: "pe_fwd",      label: "Fwd PE",     fmt: fmt1 },
      { key: "peg_av",      label: "PEG (AV)",   fmt: fmt2 },
      { key: "peg_fwd",     label: "PEG (Fwd)",  fmt: fmt2 },
      { key: "rev_growth",  label: "营收 YoY",   fmt: fmtPct, pct: true },
      { key: "eps_growth",  label: "利润 YoY",   fmt: fmtPct, pct: true },
      { key: "market_cap",  label: "市值",       fmt: fmtNum },
    ];
  }

  function rebuildTableHead(payload) {
    const thead = document.querySelector("#fund2-table thead tr");
    if (!thead) return;
    thead.innerHTML = "";
    // Fixed leading columns
    [
      { key: "rank",       label: "#",      cls: "fund2-th-rank",  type: "num"  },
      { key: "ticker",     label: "代码",                                 type: "text" },
      { key: "name",       label: "公司",                                 type: "text" },
      { key: "sub_sector", label: "子板块",                              type: "text" },
      { key: "score",      label: "综合分",  cls: "fund2-th-score", type: "num"  },
      { key: "price",      label: "现价",                                 type: "num"  },
    ].forEach(c => {
      const th = el("th", { class: c.cls || "", "data-sort": c.key, "data-type": c.type },
                    c.label);
      thead.appendChild(th);
    });
    tableColumnsFor(payload).forEach(c => {
      thead.appendChild(el("th", { "data-sort": c.key, "data-type": "num" }, c.label));
    });
  }

  const NUM_KEYS = new Set([
    "score", "rank", "price",
    // 20-metric stock framework
    "pe", "pe_fwd", "peg_av", "peg_fwd", "ps", "pb", "ev_ebitda",
    "eps", "roe", "roic", "gross_margin", "op_margin",
    "rev_growth", "eps_growth", "fcf_yield",
    "de", "interest_cov", "current_ratio",
    "div_yield", "buyback_yield", "beta",
    "market_cap", "analyst_target",
    // Crypto metrics
    "vol_to_mcap", "mom_7d", "mom_30d", "ath_dist", "volatility",
  ]);

  function applyTable(payload) {
    const tbody = document.getElementById("fund2-tbody");
    const countEl = document.getElementById("fund2-table-count");
    if (!tbody) return;
    const rows = payload.rows || [];
    const q = tableState.text.toLowerCase().trim();
    const cf = tableState.classFilter;
    const sf = tableState.subsecFilter;
    const filtered = rows.filter(r => {
      const mQ = !q ||
        (r.ticker || "").toLowerCase().includes(q) ||
        (r.name || "").toLowerCase().includes(q) ||
        (r.industry || "").toLowerCase().includes(q) ||
        (r.sector || "").toLowerCase().includes(q) ||
        (r.sub_sector || "").toLowerCase().includes(q);
      const mC = !cf || r.score_class === cf;
      const mS = !sf || r.sub_sector === sf;
      return mQ && mC && mS;
    });
    filtered.sort((a, b) => {
      let va = a[tableState.sortKey], vb = b[tableState.sortKey];
      if (NUM_KEYS.has(tableState.sortKey)) {
        if (!isNum(va)) va = tableState.sortDir === "asc" ?  Infinity : -Infinity;
        if (!isNum(vb)) vb = tableState.sortDir === "asc" ?  Infinity : -Infinity;
        return tableState.sortDir === "asc" ? va - vb : vb - va;
      }
      va = String(va || ""); vb = String(vb || "");
      return tableState.sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    tbody.innerHTML = "";
    filtered.forEach(r => {
      const isExp = tableState.expanded.has(r.ticker);
      const tr = el("tr", {
        class: "fund2-row fund2-row--" + (r.score_class || "na") + (isExp ? " expanded" : ""),
        "data-ticker": r.ticker,
        onclick: (e) => {
          if (e.target.tagName === "A" || e.target.tagName === "INPUT") return;
          if (tableState.expanded.has(r.ticker)) tableState.expanded.delete(r.ticker);
          else tableState.expanded.add(r.ticker);
          applyTable(payload);
        },
      });
      tr.appendChild(el("td", { class: "fund2-td-rank" }, "#" + r.rank));
      tr.appendChild(el("td", { class: "fund2-td-ticker" }, r.ticker || ""));
      tr.appendChild(el("td", { class: "fund2-td-name muted" }, (r.name || "").slice(0, 28)));
      // 子板块 cell — chip-style label
      const subTd = el("td", { class: "fund2-td-subsec" });
      if (r.sub_sector) subTd.appendChild(el("span", { class: "fund2-subsec-chip" }, r.sub_sector));
      else subTd.appendChild(el("span", { class: "muted" }, "—"));
      tr.appendChild(subTd);

      const scoreTd = el("td", { class: "fund2-td-score" });
      const scoreBar = el("div", { class: "fund2-td-score-wrap" });
      const track = el("div", { class: "fund2-td-score-track" });
      if (isNum(r.score)) {
        track.appendChild(el("div", {
          class: "fund2-td-score-fill fund2-c-bg-" + (r.score_class || "na"),
          style: "width:" + Math.max(0, Math.min(100, r.score)) + "%;",
        }));
      }
      scoreBar.appendChild(track);
      scoreBar.appendChild(el("span", { class: "fund2-td-score-val fund2-c-" + (r.score_class || "na") },
        fmtScore(r.score)));
      scoreTd.appendChild(scoreBar);
      tr.appendChild(scoreTd);

      // Live price + day change %
      const priceTd = el("td", { class: "fund2-td-price num" });
      if (isNum(r.price)) {
        priceTd.appendChild(el("span", { class: "fund2-td-price-val" }, "$" + r.price.toFixed(2)));
        if (isNum(r.change_pct)) {
          const cls = r.change_pct >= 0 ? "fund2-chg-pos" : "fund2-chg-neg";
          const sign = r.change_pct >= 0 ? "+" : "";
          priceTd.appendChild(el("span", { class: "fund2-td-chg " + cls },
            " " + sign + r.change_pct.toFixed(1) + "%"));
        }
      } else {
        priceTd.appendChild(el("span", { class: "muted" }, "—"));
      }
      tr.appendChild(priceTd);

      // Trailing columns are sector-specific. tableColumnsFor(payload) returns
      // the list; same list drives the <thead> rebuild in applyTable.
      tableColumnsFor(payload).forEach(col => {
        tr.appendChild(el("td", { class: col.cls || "num" + (col.pct ? " pct" : "") },
          col.fmt(r[col.key])));
      });
      tbody.appendChild(tr);

      if (isExp) {
        const exTr = el("tr", { class: "fund2-row-ex" });
        const exTd = el("td", { class: "fund2-row-ex-td", colspan: "13" });
        exTd.appendChild(buildBreakdownPanel(r, payload));
        exTr.appendChild(exTd);
        tbody.appendChild(exTr);
      }
    });

    if (countEl) countEl.textContent = `${filtered.length} / ${rows.length} 只`;
  }

  function bindTableEvents(payload) {
    // Rebuild thead based on sector type (stock cols vs crypto cols).
    rebuildTableHead(payload);
    // Reset score sort indicator
    const scoreTh = document.querySelector('#fund2-table th[data-sort="score"]');
    if (scoreTh) scoreTh.textContent = scoreTh.textContent.trim() + " ▼";

    document.querySelectorAll("#fund2-table th[data-sort]").forEach(th => {
      th.onclick = () => {
        const k = th.getAttribute("data-sort");
        if (tableState.sortKey === k) {
          tableState.sortDir = tableState.sortDir === "asc" ? "desc" : "asc";
        } else {
          tableState.sortKey = k;
          tableState.sortDir = (k === "ticker" || k === "name" || k === "sub_sector") ? "asc" : "desc";
        }
        document.querySelectorAll("#fund2-table th").forEach(t => {
          t.textContent = t.textContent.replace(/\s[▲▼]$/, "");
        });
        th.textContent = th.textContent + (tableState.sortDir === "asc" ? " ▲" : " ▼");
        applyTable(payload);
      };
    });
    const s = document.getElementById("fund2-search");
    if (s) s.oninput = () => { tableState.text = s.value; applyTable(payload); };
    // Populate sub-sector dropdown (keep "全部子板块" + payload-derived list)
    const sf = document.getElementById("fund2-subsec-filter");
    if (sf) {
      const subs = (payload.sector && payload.sector.sub_sectors) || [];
      sf.innerHTML = '<option value="">全部子板块</option>'
        + subs.map(name => `<option value="${name}">${name}</option>`).join("");
      sf.value = tableState.subsecFilter || "";
      sf.onchange = () => { tableState.subsecFilter = sf.value; applyTable(payload); };
    }
    const cf = document.getElementById("fund2-class-filter");
    if (cf) cf.onchange = () => { tableState.classFilter = cf.value; applyTable(payload); };
  }

  // ─────────── sector switch + orchestration ───────────
  async function selectSector(id, opts) {
    opts = opts || {};
    currentSector = id;
    renderMacro();
    const hint = document.getElementById("fund2-deep-hint");

    const card = document.getElementById("fund2-sector-card");
    if (card) card.innerHTML = '<div class="fund2-skel">加载 ' + id + ' 板块数据…</div>';
    if (hint) hint.textContent = "加载中…";
    const top = document.getElementById("fund2-top");
    const bot = document.getElementById("fund2-bot");
    const tbody = document.getElementById("fund2-tbody");
    const com = document.getElementById("fund2-commentary");
    if (top) top.innerHTML = "";
    if (bot) bot.innerHTML = "";
    if (com) com.innerHTML = '<div class="fund2-skel">加载中…</div>';
    if (tbody) tbody.innerHTML =
      '<tr><td colspan="13" class="muted" style="text-align:center;padding:32px;">加载中…</td></tr>';

    try {
      const payload = await fetchSector(id, opts);
      if (payload && payload.error) throw new Error(payload.error);
      // reset table state when switching sectors
      tableState.expanded.clear();
      tableState.subsecFilter = "";
      renderCommentary(payload);
      renderSectorCard(payload);
      renderDistribution(payload);
      renderSubsecChart(payload);
      renderScatterChart(payload);
      renderPicks(payload);
      bindTableEvents(payload);
      applyTable(payload);
      if (hint) hint.textContent = (payload.sector && payload.sector.name) || id;
    } catch (e) {
      console.error("[fund] sector " + id + " failed:", e);
      if (card) card.innerHTML =
        '<div class="callout warn"><strong>加载失败</strong>：' + (e.message || e) + '</div>';
      if (hint) hint.textContent = "加载失败";
    }
  }

  // ─────────── init ───────────
  async function init() {
    if (initialised) return;
    initialised = true;

    const refreshBtn = document.getElementById("fund2-refresh");
    if (refreshBtn) refreshBtn.onclick = async () => {
      refreshBtn.textContent = "刷新中…";
      refreshBtn.disabled = true;
      try {
        Object.keys(cache).forEach(k => delete cache[k]);
        overviewData = null;
        await fetchOverview(true);
        renderMacro();
        if (currentSector) await selectSector(currentSector, { force: true });
      } finally {
        refreshBtn.textContent = "↻ 刷新全部";
        refreshBtn.disabled = false;
      }
    };

    try {
      // First mount: also force the cache to behave like a refresh — the user
      // wants "每次进入页面或者手动点击刷新时更新最新数据".
      const ov = await fetchOverview();
      currentSector = (ov.sectors && ov.sectors[0] && ov.sectors[0].id) || "ai";
      renderMacro();
      await selectSector(currentSector);
    } catch (e) {
      console.error("[fund] init failed:", e);
      const macro = document.getElementById("fund2-macro");
      if (macro) macro.innerHTML =
        '<div class="callout warn" style="margin:8px;"><strong>无法加载基本面看板</strong>：'
        + (e.message || e) + '</div>';
    }
  }

  // Track when the last refresh happened — re-mounting the tab within 60s
  // reuses the existing payload; outside that window we re-fetch so the
  // page always shows fresh data when the user comes back.
  let lastRefreshAt = 0;
  const REVISIT_TTL_MS = 60 * 1000;

  async function onTabOpen() {
    if (!initialised) {
      await init();
      lastRefreshAt = Date.now();
      return;
    }
    // Re-mount: if it's been more than 60s, refresh quietly.
    if (Date.now() - lastRefreshAt > REVISIT_TTL_MS) {
      try {
        overviewData = null;
        Object.keys(cache).forEach(k => delete cache[k]);
        await fetchOverview();
        renderMacro();
        if (currentSector) await selectSector(currentSector);
        lastRefreshAt = Date.now();
      } catch (e) {
        console.warn("[fund] silent refresh failed:", e);
      }
    }
  }

  function hookTab() {
    const btn = document.querySelector('nav.tabs button[data-tab="fundamentals"]');
    if (!btn) return;
    btn.addEventListener("click", () => setTimeout(onTabOpen, 0));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hookTab);
  } else {
    hookTab();
  }
})();
