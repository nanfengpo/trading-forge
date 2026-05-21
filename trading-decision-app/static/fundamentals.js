/* ============================================================
 *  基本面看板 (Fundamentals Dashboard)
 *
 *  Sub-tab driven page that renders per-sector composite scoring.
 *  Talks to two backend endpoints:
 *    GET /api/fundamentals             → sector index (sub-tab strip)
 *    GET /api/fundamentals/{sector_id} → scored rows + KPIs + picks
 *
 *  Composite score and weights are computed server-side; this module
 *  is purely presentation + sort/filter.
 * ============================================================ */
(function() {
  "use strict";

  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";

  // Per-sector cache so flipping between sub-tabs is instant.
  const cache = {};
  let currentSector = null;
  let sectors = [];
  let metricsMeta = {};
  let initialised = false;

  // ─────────── helpers ───────────

  function fmtNum(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    const n = Number(v);
    if (Math.abs(n) >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
    if (Math.abs(n) >= 1e9)  return "$" + (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6)  return "$" + (n / 1e6).toFixed(0) + "M";
    return n.toFixed(2);
  }
  function fmtPe(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toFixed(1);
  }
  function fmtPct(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toFixed(1) + "%";
  }
  function fmtScore(v) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toFixed(1);
  }
  function scoreClass(c) {
    return "fund-score-" + (c || "na");
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
      if (k === null || k === undefined) continue;
      e.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
    }
    return e;
  }

  // ─────────── network ───────────

  async function fetchSectorIndex() {
    const r = await fetch(API_BASE + "/api/fundamentals");
    if (!r.ok) throw new Error("sector index http " + r.status);
    return r.json();
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

  // ─────────── sub-tab strip ───────────

  function renderSubtabs() {
    const wrap = document.getElementById("fund-subtabs");
    if (!wrap) return;
    wrap.innerHTML = "";
    sectors.forEach(s => {
      const btn = el("button", {
        class: "fund-subtab" + (s.id === currentSector ? " active" : ""),
        "data-sector": s.id,
        title: s.desc || "",
        onclick: () => selectSector(s.id),
      });
      btn.appendChild(el("span", { class: "fund-subtab-icon" }, s.icon || "📊"));
      btn.appendChild(el("span", { class: "fund-subtab-name" }, s.name));
      btn.appendChild(el("span", { class: "fund-subtab-count" }, "(" + s.ticker_count + ")"));
      wrap.appendChild(btn);
    });
  }

  // ─────────── sector context (desc + weights) ───────────

  function renderContext(payload) {
    const wrap = document.getElementById("fund-context");
    if (!wrap) return;
    const sector = payload.sector || {};
    const weights = sector.weights || {};
    wrap.innerHTML = "";

    const descBox = el("div", { class: "fund-context-desc" });
    descBox.appendChild(el("div", { class: "fund-context-title" },
      (sector.icon || "📊") + " " + (sector.name || "")
    ));
    descBox.appendChild(el("p", { class: "muted", style: "margin:4px 0 8px;" }, sector.desc || ""));
    descBox.appendChild(el("div", { class: "fund-weight-rationale" },
      "📌 权重逻辑：" + (sector.weight_rationale || "")
    ));
    wrap.appendChild(descBox);

    const wbox = el("div", { class: "fund-weights" });
    wbox.appendChild(el("div", { class: "fund-weights-title" }, "本板块的指标权重 (%)"));
    const list = el("div", { class: "fund-weight-list" });
    const order = ["pe", "pe_fwd", "peg_av", "peg_fwd", "rev_growth", "eps_growth"];
    order.forEach(k => {
      const w = weights[k] || 0;
      const meta = metricsMeta[k] || { label: k };
      const row = el("div", { class: "fund-weight-row" });
      row.appendChild(el("span", { class: "fund-weight-label" }, meta.label));
      const barWrap = el("div", { class: "fund-weight-bar-wrap" });
      const bar = el("div", { class: "fund-weight-bar", style: "width:" + (w * 2) + "%;" });
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
      row.appendChild(el("span", { class: "fund-weight-val" }, w + "%"));
      list.appendChild(row);
    });
    wbox.appendChild(list);
    wrap.appendChild(wbox);
  }

  // ─────────── KPI strip ───────────

  function renderKpis(payload) {
    const wrap = document.getElementById("fund-kpis");
    if (!wrap) return;
    const s = payload.stats || {};
    const sector = payload.sector || {};
    wrap.innerHTML = "";

    const kpis = [
      { label: "覆盖股票", value: s.total || 0, cls: "" },
      { label: "中位综合分", value: s.median_score == null ? "—" : s.median_score, cls: "" },
      { label: "优秀 (≥70)", value: s.good || 0, cls: "kpi-good" },
      { label: "中性 (45-70)", value: s.mid || 0, cls: "kpi-mid" },
      { label: "弱势 (<45)", value: s.high || 0, cls: "kpi-high" },
      { label: "权重逻辑", value: sector.weight_rationale ? "已定制" : "默认", cls: "" },
    ];
    kpis.forEach(k => {
      const box = el("div", { class: "fund-kpi " + k.cls });
      box.appendChild(el("div", { class: "fund-kpi-label" }, k.label));
      box.appendChild(el("div", { class: "fund-kpi-value" }, String(k.value)));
      wrap.appendChild(box);
    });

    const updated = document.getElementById("fund-updated");
    if (updated) {
      updated.textContent =
        "生成时间: " + (payload.generated_at || "") +
        (payload.data_source === "no_api_key" ? " · ⚠ 后端未配置 ALPHA_VANTAGE_API_KEY" : "");
    }
  }

  // ─────────── pick card ───────────

  function pickCard(row, mode) {
    const cls = "fund-pick fund-pick-" + (mode === "top" ? "good" : "high");
    const card = el("div", { class: cls });
    card.appendChild(el("div", { class: "fund-pick-rank" }, "#" + row.rank));
    card.appendChild(el("div", { class: "fund-pick-ticker" }, row.ticker || ""));
    card.appendChild(el("div", { class: "fund-pick-name" }, row.name || ""));
    const scoreRow = el("div", { class: "fund-pick-score-row" });
    scoreRow.appendChild(el("span", { class: "fund-pick-label" }, "综合分"));
    scoreRow.appendChild(el("span", { class: "fund-pick-score " + scoreClass(row.score_class) },
      fmtScore(row.score)
    ));
    card.appendChild(scoreRow);
    const metrics = el("div", { class: "fund-pick-metrics" });
    [
      ["PE", fmtPe(row.pe)],
      ["Fwd PE", fmtPe(row.pe_fwd)],
      ["PEG-Fwd", fmtPe(row.peg_fwd)],
      ["利润 YoY", fmtPct(row.eps_growth)],
    ].forEach(pair => {
      const m = el("div", { class: "fund-pick-metric" });
      m.appendChild(el("span", { class: "fund-pick-metric-label" }, pair[0]));
      m.appendChild(el("span", { class: "fund-pick-metric-val" }, pair[1]));
      metrics.appendChild(m);
    });
    card.appendChild(metrics);
    return card;
  }

  function renderPicks(payload) {
    const top = document.getElementById("fund-top-picks");
    const bot = document.getElementById("fund-bottom-picks");
    if (top) {
      top.innerHTML = "";
      (payload.top_picks || []).forEach(r => top.appendChild(pickCard(r, "top")));
    }
    if (bot) {
      bot.innerHTML = "";
      (payload.bottom_picks || []).forEach(r => bot.appendChild(pickCard(r, "bottom")));
    }
  }

  // ─────────── table ───────────

  let tableRows = [];
  let sortKey = "score";
  let sortDir = "desc";
  let textFilter = "";
  let classFilter = "";

  const NUMERIC_KEYS = new Set([
    "score","rank","pe","pe_fwd","peg_av","peg_fwd",
    "rev_growth","eps_growth","market_cap",
  ]);

  function applyTable() {
    const tbody = document.getElementById("fund-tbody");
    if (!tbody) return;
    const q = textFilter.toLowerCase().trim();
    const cls = classFilter;
    const filtered = tableRows.filter(r => {
      const matchQ = !q ||
        (r.ticker || "").toLowerCase().includes(q) ||
        (r.name || "").toLowerCase().includes(q) ||
        (r.industry || "").toLowerCase().includes(q) ||
        (r.sector || "").toLowerCase().includes(q);
      const matchC = !cls || r.score_class === cls;
      return matchQ && matchC;
    });
    filtered.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (NUMERIC_KEYS.has(sortKey)) {
        if (va === null || va === undefined || isNaN(va)) va = sortDir === "asc" ?  Infinity : -Infinity;
        if (vb === null || vb === undefined || isNaN(vb)) vb = sortDir === "asc" ?  Infinity : -Infinity;
        return sortDir === "asc" ? va - vb : vb - va;
      }
      va = String(va || ""); vb = String(vb || "");
      return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    tbody.innerHTML = "";
    filtered.forEach(r => {
      const tr = el("tr", { class: "fund-row fund-row-" + (r.score_class || "na") });
      tr.appendChild(el("td", { class: "fund-cell-rank" }, "#" + r.rank));
      tr.appendChild(el("td", { class: "fund-cell-ticker" }, r.ticker || ""));
      tr.appendChild(el("td", { class: "fund-cell-name" }, r.name || ""));
      const scoreCell = el("td", { class: "fund-cell-score num" });
      scoreCell.appendChild(el("span", { class: "fund-score-pill " + scoreClass(r.score_class) },
        fmtScore(r.score)
      ));
      tr.appendChild(scoreCell);
      tr.appendChild(el("td", { class: "num" }, fmtPe(r.pe)));
      tr.appendChild(el("td", { class: "num" }, fmtPe(r.pe_fwd)));
      tr.appendChild(el("td", { class: "num" }, fmtPe(r.peg_av)));
      tr.appendChild(el("td", { class: "num" }, fmtPe(r.peg_fwd)));
      tr.appendChild(el("td", { class: "num pct" }, fmtPct(r.rev_growth)));
      tr.appendChild(el("td", { class: "num pct" }, fmtPct(r.eps_growth)));
      tr.appendChild(el("td", { class: "num" }, fmtNum(r.market_cap)));
      tbody.appendChild(tr);
    });
  }

  function renderTable(payload) {
    tableRows = payload.rows || [];
    document.querySelectorAll("#fund-table th").forEach(th => {
      th.textContent = th.textContent.replace(/[▲▼]/g, "").trim();
    });
    const th = document.querySelector('#fund-table th[data-sort="' + sortKey + '"]');
    if (th) th.textContent = th.textContent.trim() + (sortDir === "asc" ? " ▲" : " ▼");
    applyTable();
  }

  function bindTableEvents() {
    if (bindTableEvents._bound) return;
    bindTableEvents._bound = true;
    document.querySelectorAll("#fund-table th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const k = th.getAttribute("data-sort");
        if (sortKey === k) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = k;
          sortDir = (k === "ticker" || k === "name") ? "asc" : "desc";
        }
        document.querySelectorAll("#fund-table th").forEach(t => {
          t.textContent = t.textContent.replace(/[▲▼]/g, "").trim();
        });
        th.textContent = th.textContent.trim() + (sortDir === "asc" ? " ▲" : " ▼");
        applyTable();
      });
    });
    const search = document.getElementById("fund-search");
    if (search) search.addEventListener("input", () => {
      textFilter = search.value;
      applyTable();
    });
    const cf = document.getElementById("fund-class-filter");
    if (cf) cf.addEventListener("change", () => {
      classFilter = cf.value;
      applyTable();
    });
    const refresh = document.getElementById("fund-refresh");
    if (refresh) refresh.addEventListener("click", async () => {
      if (!currentSector) return;
      refresh.textContent = "刷新中…";
      refresh.disabled = true;
      try {
        await selectSector(currentSector, { force: true });
      } finally {
        refresh.textContent = "↻ 刷新";
        refresh.disabled = false;
      }
    });
  }

  // ─────────── sector switching ───────────

  function setLoading() {
    const ctx = document.getElementById("fund-context");
    const kp  = document.getElementById("fund-kpis");
    const top = document.getElementById("fund-top-picks");
    const bot = document.getElementById("fund-bottom-picks");
    const tbody = document.getElementById("fund-tbody");
    if (ctx) ctx.innerHTML = '<div class="muted" style="padding:18px;">加载板块基本面数据…</div>';
    if (kp) kp.innerHTML = "";
    if (top) top.innerHTML = "";
    if (bot) bot.innerHTML = "";
    if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center; padding:24px;">加载中…</td></tr>';
  }

  function renderError(msg) {
    const ctx = document.getElementById("fund-context");
    if (ctx) ctx.innerHTML =
      '<div class="callout warn" style="margin:8px 0;"><strong>加载失败</strong>：' + msg + '</div>';
  }

  async function selectSector(id, opts) {
    currentSector = id;
    renderSubtabs();
    setLoading();
    try {
      const payload = await fetchSector(id, opts);
      if (payload && payload.error) throw new Error(payload.error);
      renderContext(payload);
      renderKpis(payload);
      renderPicks(payload);
      renderTable(payload);
    } catch (e) {
      console.error("[fund] sector " + id + " failed:", e);
      renderError(e.message || String(e));
    }
  }

  // ─────────── init ───────────

  async function init() {
    if (initialised) return;
    initialised = true;
    try {
      const idx = await fetchSectorIndex();
      sectors = idx.sectors || [];
      metricsMeta = idx.metrics_meta || {};
      currentSector = sectors[0] && sectors[0].id;
      bindTableEvents();
      renderSubtabs();
      if (currentSector) await selectSector(currentSector);
    } catch (e) {
      console.error("[fund] init failed:", e);
      const wrap = document.getElementById("fund-subtabs");
      if (wrap) wrap.innerHTML =
        '<div class="callout warn"><strong>无法加载基本面看板</strong>：' + (e.message || e) + '</div>';
    }
  }

  // Lazy-init only when the user first opens the tab — saves API quota
  // on page load for users who never visit this page.
  function hookTab() {
    const btn = document.querySelector('nav.tabs button[data-tab="fundamentals"]');
    if (!btn) return;
    btn.addEventListener("click", () => {
      setTimeout(init, 0);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hookTab);
  } else {
    hookTab();
  }
})();
