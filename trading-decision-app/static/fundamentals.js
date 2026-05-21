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
  let tableState = { sortKey: "score", sortDir: "desc", text: "", classFilter: "", expanded: new Set() };

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
    const r = await fetch(API_BASE + "/api/fundamentals/_overview");
    if (!r.ok) throw new Error("overview http " + r.status);
    overviewData = await r.json();
    return overviewData;
  }
  async function fetchSector(id, opts) {
    opts = opts || {};
    if (!opts.force && cache[id]) return cache[id];
    const r = await fetch(API_BASE + "/api/fundamentals/" + encodeURIComponent(id));
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
    const filtered = rows.filter(r => {
      const mQ = !q ||
        (r.ticker || "").toLowerCase().includes(q) ||
        (r.name || "").toLowerCase().includes(q) ||
        (r.industry || "").toLowerCase().includes(q) ||
        (r.sector || "").toLowerCase().includes(q);
      const mC = !cf || r.score_class === cf;
      return mQ && mC;
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
        const exTd = el("td", { class: "fund2-row-ex-td", colspan: "11" });
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
    const cf = document.getElementById("fund2-class-filter");
    if (cf) cf.onchange = () => { tableState.classFilter = cf.value; applyTable(payload); };
  }

  // ─────────── sector switch + orchestration ───────────
  async function selectSector(id) {
    currentSector = id;
    renderMacro();
    const hint = document.getElementById("fund2-deep-hint");

    const card = document.getElementById("fund2-sector-card");
    if (card) card.innerHTML = '<div class="fund2-skel">加载 ' + id + ' 板块数据…</div>';
    if (hint) hint.textContent = "加载中…";
    document.getElementById("fund2-top").innerHTML = "";
    document.getElementById("fund2-bot").innerHTML = "";
    document.getElementById("fund2-tbody").innerHTML =
      '<tr><td colspan="11" class="muted" style="text-align:center;padding:32px;">加载中…</td></tr>';

    try {
      const payload = await fetchSector(id);
      if (payload && payload.error) throw new Error(payload.error);
      tableState.expanded.clear();
      renderSectorCard(payload);
      renderDistribution(payload);
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
        if (currentSector) await selectSector(currentSector);
      } finally {
        refreshBtn.textContent = "↻ 刷新全部";
        refreshBtn.disabled = false;
      }
    };

    try {
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

  function hookTab() {
    const btn = document.querySelector('nav.tabs button[data-tab="fundamentals"]');
    if (!btn) return;
    btn.addEventListener("click", () => setTimeout(init, 0));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hookTab);
  } else {
    hookTab();
  }
})();
