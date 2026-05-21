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

  // Metric order — used everywhere for consistency.
  const METRIC_ORDER = ["pe", "pe_fwd", "peg_av", "peg_fwd", "rev_growth", "eps_growth"];
  const METRIC_LABEL = {
    pe: "PE", pe_fwd: "Fwd PE", peg_av: "PEG-AV", peg_fwd: "PEG-Fwd",
    rev_growth: "营收 YoY", eps_growth: "利润 YoY",
  };
  const METRIC_DIRECTION = {
    pe: "lower", pe_fwd: "lower", peg_av: "lower", peg_fwd: "lower",
    rev_growth: "higher", eps_growth: "higher",
  };

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

    // Weight bars (compact horizontal)
    const wWrap = el("div", { class: "fund2-sc-weights" });
    wWrap.appendChild(el("div", { class: "fund2-sc-section-h" }, "指标权重 · METRIC WEIGHTS"));
    const wList = el("div", { class: "fund2-sc-w-list" });
    METRIC_ORDER.forEach(k => {
      const w = weights[k] || 0;
      const row = el("div", { class: "fund2-sc-w-row" });
      row.appendChild(el("span", { class: "fund2-sc-w-label" }, METRIC_LABEL[k]));
      const barTrack = el("div", { class: "fund2-sc-w-track" });
      const fill = el("div", { class: "fund2-sc-w-fill", style: "width:" + (w * 2) + "%;" });
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

  // ─────────── PICK CARDS ───────────
  function pickCard(row, mode) {
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
    METRIC_ORDER.forEach(k => {
      const sub = subs[k];
      const raw = row[k];
      const subCls = classOf(sub);
      const r = el("div", { class: "fund2-pick-br-row" });
      r.appendChild(el("span", { class: "fund2-pick-br-label" }, METRIC_LABEL[k]));
      const track = el("div", { class: "fund2-pick-br-track" });
      if (isNum(sub)) {
        track.appendChild(el("div", {
          class: "fund2-pick-br-fill fund2-c-bg-" + subCls,
          style: "width:" + Math.max(0, Math.min(100, sub)) + "%;",
        }));
      }
      r.appendChild(track);
      const isPct = (k === "rev_growth" || k === "eps_growth");
      r.appendChild(el("span", { class: "fund2-pick-br-raw " + (isPct ? "pct" : "") },
        isPct ? fmtPct(raw) : fmt2(raw)));
      breakdown.appendChild(r);
    });
    card.appendChild(breakdown);

    const subEntries = METRIC_ORDER.map(k => ({ k, s: subs[k] })).filter(e => isNum(e.s));
    if (subEntries.length > 0) {
      subEntries.sort((a, b) => b.s - a.s);
      const strongest = subEntries[0];
      const weakest = subEntries[subEntries.length - 1];
      const tags = el("div", { class: "fund2-pick-tags" });
      tags.appendChild(el("span", { class: "fund2-pick-tag fund2-pick-tag--up" },
        "强 ", el("strong", null, METRIC_LABEL[strongest.k]), " " + Math.round(strongest.s)));
      tags.appendChild(el("span", { class: "fund2-pick-tag fund2-pick-tag--down" },
        "弱 ", el("strong", null, METRIC_LABEL[weakest.k]), " " + Math.round(weakest.s)));
      card.appendChild(tags);
    }

    return card;
  }

  function renderPicks(payload) {
    const top = document.getElementById("fund2-top");
    const bot = document.getElementById("fund2-bot");
    if (top) {
      top.innerHTML = "";
      (payload.top_picks || []).forEach(r => top.appendChild(pickCard(r, "good")));
    }
    if (bot) {
      bot.innerHTML = "";
      (payload.bottom_picks || []).forEach(r => bot.appendChild(pickCard(r, "high")));
    }
  }

  // ─────────── LEDGER TABLE ───────────
  const NUM_KEYS = new Set([
    "score", "rank", "pe", "pe_fwd", "peg_av", "peg_fwd",
    "rev_growth", "eps_growth", "market_cap",
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

      tr.appendChild(el("td", { class: "num" }, fmt1(r.pe)));
      tr.appendChild(el("td", { class: "num" }, fmt1(r.pe_fwd)));
      tr.appendChild(el("td", { class: "num" }, fmt2(r.peg_av)));
      tr.appendChild(el("td", { class: "num" }, fmt2(r.peg_fwd)));
      tr.appendChild(el("td", { class: "num pct" }, fmtPct(r.rev_growth)));
      tr.appendChild(el("td", { class: "num pct" }, fmtPct(r.eps_growth)));
      tr.appendChild(el("td", { class: "num" }, fmtNum(r.market_cap)));
      tbody.appendChild(tr);

      if (isExp) {
        const exTr = el("tr", { class: "fund2-row-ex" });
        const exTd = el("td", { class: "fund2-row-ex-td", colspan: "13" });
        const grid = el("div", { class: "fund2-ex-grid" });
        grid.appendChild(el("div", { class: "fund2-ex-head" },
          "🔬 6 维度评分构成 · ", el("span", { class: "muted" }, r.ticker || "")));
        const bars = el("div", { class: "fund2-ex-bars" });
        const subs = r.sub_scores || {};
        METRIC_ORDER.forEach(k => {
          const sub = subs[k];
          const raw = r[k];
          const w = (payload.sector && payload.sector.weights && payload.sector.weights[k]) || 0;
          const isPct = (k === "rev_growth" || k === "eps_growth");
          const dirArrow = METRIC_DIRECTION[k] === "lower" ? "↓越低越好" : "↑越高越好";
          const block = el("div", { class: "fund2-ex-block" });
          block.appendChild(el("div", { class: "fund2-ex-b-label" },
            METRIC_LABEL[k],
            el("span", { class: "fund2-ex-b-dir muted" }, " · " + dirArrow),
          ));
          const track = el("div", { class: "fund2-ex-b-track" });
          if (isNum(sub)) {
            track.appendChild(el("div", {
              class: "fund2-ex-b-fill fund2-c-bg-" + classOf(sub),
              style: "width:" + Math.max(0, Math.min(100, sub)) + "%;",
            }));
          }
          block.appendChild(track);
          block.appendChild(el("div", { class: "fund2-ex-b-foot" },
            el("span", { class: "fund2-ex-b-raw" }, "原值 " + (isPct ? fmtPct(raw) : fmt2(raw))),
            el("span", { class: "fund2-ex-b-sub fund2-c-" + classOf(sub) },
              "子分 " + (isNum(sub) ? Math.round(sub) : "—")),
            el("span", { class: "fund2-ex-b-w muted" }, "权重 " + w + "%"),
          ));
          bars.appendChild(block);
        });
        grid.appendChild(bars);
        exTd.appendChild(grid);
        exTr.appendChild(exTd);
        tbody.appendChild(exTr);
      }
    });

    if (countEl) countEl.textContent = `${filtered.length} / ${rows.length} 只`;
  }

  function bindTableEvents(payload) {
    document.querySelectorAll("#fund2-table th[data-sort]").forEach(th => {
      th.onclick = () => {
        const k = th.getAttribute("data-sort");
        if (tableState.sortKey === k) {
          tableState.sortDir = tableState.sortDir === "asc" ? "desc" : "asc";
        } else {
          tableState.sortKey = k;
          tableState.sortDir = (k === "ticker" || k === "name") ? "asc" : "desc";
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
