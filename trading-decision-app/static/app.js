/* =========================================================================
   Trading Decision App — frontend (v2)

   Modules:
     - Theme           dark / light toggle
     - Library         78-strategy filter UI
     - DecisionForm    inputs + provider/model dropdowns
     - DecisionWindow  one analysis run with its own DOM, state, SSE
     - WindowManager   tab strip + concurrent windows
     - History         localStorage persistence + restore
   ========================================================================= */

"use strict";

// =========================================================================
// Shared utilities
// =========================================================================
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

function mdLite(text) {
  if (!text) return "";
  // Some upstream LLMs (especially when forced through a JSON-mode wrapper)
  // emit literal "\n" / "\t" / '\"' instead of actual control chars. Unescape
  // those before HTML-escaping so paragraph breaks render correctly.
  let out = String(text)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"');
  out = escapeHtml(out);
  out = out.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  out = out.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  out = out.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/(\|.+\|\n\|[-: |]+\|\n(?:\|.+\|\n?)+)/g, block => {
    const lines = block.trim().split("\n");
    const head = lines[0].split("|").slice(1, -1).map(c => `<th>${c.trim()}</th>`).join("");
    const rows = lines.slice(2).map(l =>
      "<tr>" + l.split("|").slice(1, -1).map(c => `<td>${c.trim()}</td>`).join("") + "</tr>"
    ).join("");
    return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  out = out.replace(/(^|\n)(\s*[-*]\s+.+(?:\n\s*[-*]\s+.+)*)/g, (_, p, body) => {
    const items = body.trim().split(/\n/).map(l => `<li>${l.replace(/^\s*[-*]\s+/, "")}</li>`).join("");
    return `${p}<ul>${items}</ul>`;
  });
  out = out.replace(/\n{2,}/g, "</p><p>");
  return `<p>${out}</p>`;
}

function uid() { return "w" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

function isMostlyChinese(s) {
  if (!s) return true;
  let zh = 0, total = 0;
  for (const c of s) {
    if (/[一-鿿]/.test(c)) zh++;
    if (/[a-zA-Z一-鿿]/.test(c)) total++;
  }
  return total === 0 || zh / total >= 0.30;
}

// =========================================================================
// Theme manager (dark / light)
// =========================================================================
const Theme = {
  KEY: "tda:theme",
  init() {
    const saved = localStorage.getItem(this.KEY);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved || (prefersDark ? "dark" : "light");
    this.set(theme);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.addEventListener("click", () => this.toggle());
  },
  set(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(this.KEY, theme);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  },
  toggle() {
    const cur = document.documentElement.getAttribute("data-theme") || "light";
    this.set(cur === "dark" ? "light" : "dark");
  },
};

// =========================================================================
// Constants
// =========================================================================
const ANALYST_KEYS = ["market", "social", "news", "fundamentals"];
const CUSTOM_VALUE = "__custom__";

const AGENT_DISPLAY_ZH = {
  "Market Analyst": "市场分析师",
  "Social Analyst": "情绪分析师",
  "Sentiment Analyst": "情绪分析师",
  "News Analyst": "新闻分析师",
  "Fundamentals Analyst": "基本面分析师",
  "Bull Researcher": "牛市研究员",
  "Bear Researcher": "熊市研究员",
  "Research Manager": "研究经理",
  "Trader": "交易员",
  "Aggressive Analyst": "激进风险分析师",
  "Neutral Analyst": "中立风险分析师",
  "Conservative Analyst": "保守风险分析师",
  "Portfolio Manager": "投资组合经理",
};
const TEAM_ZH = {
  "Analyst Team": "数据分析团队",
  "Research Team": "投资研究团队",
  "Trading Team": "交易执行团队",
  "Risk Management": "风险管理团队",
  "Portfolio Management": "投资组合管理",
};
const REPORT_TITLE_ZH = {
  market_report: "市场技术分析",
  sentiment_report: "情绪分析",
  news_report: "新闻分析",
  fundamentals_report: "基本面分析",
  investment_plan: "研究经理 · 投资计划",
  trader_investment_plan: "交易员 · 交易提案",
  final_trade_decision: "投资组合经理 · 最终决策",
};

// =========================================================================
// Router — SPA URL routing
//
// Each top-level tab gets a clean URL. Clicking a tab pushes a new entry
// to history; back/forward use popstate; deep links work because CF Pages
// rewrites unknown paths to /index.html (see static/_redirects).
// =========================================================================
const Router = {
  // tab id → URL path (no trailing slash except "/")
  routes: {
    home:          "/",
    watchlist:     "/watchlist",
    decisions:     "/decisions",
    fundamentals: "/fundamentals",
    opportunities: "/opportunities",
    library:       "/library",
    favorites:     "/favorites",
    profile:       "/profile",
  },

  _tabFromPath(path) {
    const clean = (path || "/").replace(/\/+$/, "") || "/";
    for (const [tab, p] of Object.entries(this.routes)) {
      if (p === clean) return tab;
    }
    // Sub-routes under /watchlist (e.g. /watchlist/NVDA, /watchlist/NVDA/r/<id>)
    if (/^\/watchlist(\/|$)/.test(clean)) return "watchlist";
    return null;
  },

  /** Parse `/watchlist/NVDA/r/abc-uuid` → { ticker: "NVDA", reportId: "abc-uuid" }.
   *  Returns null on the bare `/watchlist` path. */
  parseWatchlistPath(path) {
    const m = (path || "").match(/^\/watchlist\/([^/]+)(?:\/r\/([^/]+))?\/?$/);
    if (!m) return null;
    return { ticker: decodeURIComponent(m[1]).toUpperCase(), reportId: m[2] ? decodeURIComponent(m[2]) : null };
  },

  /** Build a watchlist URL. ticker / reportId are optional. */
  watchlistPath(ticker, reportId) {
    let p = "/watchlist";
    if (ticker) p += "/" + encodeURIComponent(ticker);
    if (ticker && reportId) p += "/r/" + encodeURIComponent(reportId);
    return p;
  },

  /** Push (or replace) a watchlist sub-route — used by Watchlist row click +
   *  ComprehensiveReport.selectVersion. */
  goWatchlist(ticker, reportId, { push = true, replace = false } = {}) {
    const path = this.watchlistPath(ticker, reportId);
    if (push && location.pathname !== path) {
      if (replace) history.replaceState({ tab: "watchlist", ticker, reportId }, "", path);
      else         history.pushState({ tab: "watchlist", ticker, reportId }, "", path);
    }
    document.title = this._titleFor("watchlist", ticker, reportId);
  },

  _pathFromTab(tab) {
    return this.routes[tab] || "/";
  },

  go(tab, { push = true } = {}) {
    if (!tab || !this.routes[tab]) tab = "home";
    document.querySelectorAll("nav.tabs .tabs-left button").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll("section.tab-content").forEach(s => {
      s.classList.toggle("active", s.id === tab);
    });
    if (push) {
      const path = this._pathFromTab(tab);
      if (location.pathname !== path) {
        history.pushState({ tab }, "", path);
      }
    }
    document.title = this._titleFor(tab);
    // Scroll back to top whenever the user changes tabs.
    window.scrollTo({ top: 0, behavior: "instant" in document.documentElement.style ? "instant" : "auto" });
  },

  _titleFor(tab, ticker, reportId) {
    const labels = {
      home: "智策 TradingForge · 多智能体投研工作台",
      watchlist: "自选 · 智策 TradingForge",
      decisions: "决策 · 智策 TradingForge",
      fundamentals: "基本面看板 · 智策 TradingForge",
      opportunities: "24h 机会 · 智策 TradingForge",
      library: "策略库 · 智策 TradingForge",
      favorites: "我的收藏 · 智策 TradingForge",
      profile: "个人中心 · 智策 TradingForge",
    };
    if (tab === "watchlist" && ticker) {
      return reportId
        ? `${ticker} · 综合报告 · 自选 · 智策`
        : `${ticker} · 自选 · 智策`;
    }
    return labels[tab] || labels.home;
  },

  /** Apply a watchlist deep-link (ticker / reportId) AFTER `go("watchlist")`
   *  has switched panels. The Watchlist controller listens for the
   *  `wl-route-changed` event. */
  _emitWatchlistRoute(ticker, reportId) {
    // Update title so deep-link landings show "NVDA · 自选 · 智策" instead
    // of the bare "自选 · 智策".
    if (ticker) document.title = this._titleFor("watchlist", ticker, reportId);
    window.dispatchEvent(new CustomEvent("wl-route-changed", { detail: { ticker, reportId } }));
  },

  init() {
    document.querySelectorAll("nav.tabs .tabs-left button").forEach(btn => {
      btn.addEventListener("click", () => this.go(btn.dataset.tab));
    });
    // Any element on the page can declare data-go="tabid" and become a
    // deep-link routed through the router. Used by homepage CTAs +
    // module cards; safe to drop into any future page too.
    document.addEventListener("click", e => {
      const el = e.target.closest("[data-go]");
      if (!el) return;
      e.preventDefault();
      this.go(el.dataset.go);
    });
    window.addEventListener("popstate", () => {
      const tab = this._tabFromPath(location.pathname) || "home";
      this.go(tab, { push: false });
      if (tab === "watchlist") {
        const sub = this.parseWatchlistPath(location.pathname) || {};
        this._emitWatchlistRoute(sub.ticker || null, sub.reportId || null);
      }
    });
    // Initial paint — pick tab from URL.
    const initialTab = this._tabFromPath(location.pathname) || "home";
    this.go(initialTab, { push: false });
    if (initialTab === "watchlist") {
      const sub = this.parseWatchlistPath(location.pathname) || {};
      // Defer until Watchlist.init() has registered its listener.
      setTimeout(() => this._emitWatchlistRoute(sub.ticker || null, sub.reportId || null), 0);
    }
  },
};
// Expose for cross-script callers (comprehensive.js).
window.Router = Router;

// Legacy alias kept so older call sites (initLibrary, etc.) keep working.
function initTabs() { Router.init(); }

// =========================================================================
// Library (78 strategies — unchanged from v1)
// =========================================================================
const RISK_NAMES = { 1: "极低", 2: "较低", 3: "中等", 4: "较高", 5: "极高" };
const filterState = { cat: [], inst: [], tool: [], view: [], horizon: [], complexity: [], risk: [], search: "", favoritesOnly: false };

function initLibrary() {
  if (typeof STRATEGIES === "undefined") return;
  document.querySelectorAll("[data-filter]").forEach(chip => {
    chip.addEventListener("click", () => {
      const f = chip.dataset.filter, v = chip.dataset.value;
      if (f === "favorites") {
        filterState.favoritesOnly = !filterState.favoritesOnly;
        chip.classList.toggle("active", filterState.favoritesOnly);
        renderLibrary();
        return;
      }
      const arr = filterState[f];
      const i = arr.indexOf(v);
      if (i >= 0) { arr.splice(i, 1); chip.classList.remove("active"); }
      else { arr.push(v); chip.classList.add("active"); }
      renderLibrary();
    });
  });
  const searchEl = document.getElementById("search");
  if (searchEl) {
    searchEl.addEventListener("input", e => { filterState.search = e.target.value.trim().toLowerCase(); renderLibrary(); });
  }
  const clearBtn = document.getElementById("clear-filters");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      Object.keys(filterState).forEach(k => {
        if (k === "search") filterState[k] = "";
        else if (k === "favoritesOnly") filterState[k] = false;
        else filterState[k] = [];
      });
      document.querySelectorAll("[data-filter].active").forEach(c => c.classList.remove("active"));
      if (searchEl) searchEl.value = "";
      renderLibrary();
    });
  }
  const totalEl = document.getElementById("stat-total");
  if (totalEl) totalEl.textContent = STRATEGIES.length;
  renderLibrary();
}

function renderLibrary() {
  const list = document.getElementById("strategy-list");
  if (!list) return;
  const filtered = STRATEGIES.filter(s => {
    if (filterState.cat.length && !filterState.cat.includes(s.cat)) return false;
    if (filterState.inst.length && !filterState.inst.some(v => (s.inst || []).includes(v))) return false;
    if (filterState.tool.length && !filterState.tool.some(v => (s.tool || []).includes(v))) return false;
    if (filterState.view.length && !filterState.view.some(v => (s.view || []).includes(v))) return false;
    if (filterState.horizon.length && !filterState.horizon.some(v => (s.horizon || []).includes(v))) return false;
    if (filterState.complexity.length && !filterState.complexity.includes(String(s.complexity))) return false;
    if (filterState.risk.length && !filterState.risk.includes(String(s.risk))) return false;
    if (filterState.search) {
      const blob = (s.name + " " + s.en + " " + (s.desc || "")).toLowerCase();
      if (!blob.includes(filterState.search)) return false;
    }
    if (filterState.favoritesOnly) {
      if (typeof Favorites === "undefined" || !Favorites.isFavorited("strategy", s.id)) return false;
    }
    return true;
  });
  const countEl = document.getElementById("filter-count");
  if (countEl) countEl.textContent = `显示 ${filtered.length} / ${STRATEGIES.length} 条策略`;
  if (!filtered.length) {
    list.innerHTML = `<div class="no-results">没有匹配的策略。建议减少筛选条件，或点击"清空筛选"重置。</div>`;
    return;
  }
  list.innerHTML = filtered.map(s => `
    <div class="strategy-card" data-id="${s.id}">
      <div class="header">
        <div class="header-content">
          <div class="card-line-1">
            <span class="num">${s.num}</span>
            <span class="name-text">${s.name}</span>
            <span class="en">· ${s.en}</span>
            <button class="fav-btn ${typeof Favorites !== 'undefined' && Favorites.isFavorited('strategy', s.id) ? 'on' : ''}"
                    data-fav-strategy="${s.id}" title="收藏 / 取消收藏"
                    style="margin-left:auto;">${typeof Favorites !== 'undefined' && Favorites.isFavorited('strategy', s.id) ? '★' : '☆'}</button>
          </div>
          <div class="desc">${s.desc || ""}</div>
          <div class="card-tags">
            <span class="tag cat-${s.cat}">${CAT_NAMES[s.cat]}</span>
            <span class="tag-group">
              <span class="tag-label">观点</span>
              ${(s.view || []).map(v => `<span class="tag view-tag">${VIEW_NAMES[v] || v}</span>`).join("")}
            </span>
            <span class="tag-group">
              <span class="tag-label">周期</span>
              ${(s.horizon || []).map(h => `<span class="tag horizon-tag">${HORIZON_NAMES[h] || h}</span>`).join("")}
            </span>
            <span class="tag-group">
              <span class="tag-label">工具</span>
              ${(s.tool || []).map(t => `<span class="tag tool-tag">${TOOL_NAMES[t] || t}</span>`).join("")}
            </span>
          </div>
        </div>
        <div class="card-meta">
          <span class="metric complex">复杂度<span class="stars">${"★".repeat(s.complexity || 1)}</span></span>
          <span class="metric risk-${s.risk || 3}">风险<span class="stars">${"★".repeat(s.risk || 3)}</span></span>
        </div>
      </div>
      <div class="body">
        <div class="row">
          <div>
            <h4>什么时候用</h4><p>${s.when || ""}</p>
            <h4>怎么做</h4><p>${s.how || ""}</p>
          </div>
          <div>
            <h4>关键参数</h4>
            <table class="params-table">
              ${(s.params || []).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}
            </table>
          </div>
        </div>
        <div class="row" style="margin-top:14px;">
          <div><h4>好处</h4><ul>${(s.pros || []).map(x => `<li>${x}</li>`).join("")}</ul></div>
          <div><h4>代价</h4><ul>${(s.cons || []).map(x => `<li>${x}</li>`).join("")}</ul></div>
        </div>
        ${s.example ? `<h4>示例</h4><div class="example-box">${s.example}</div>` : ""}
      </div>
    </div>
  `).join("");
  list.querySelectorAll(".strategy-card .header").forEach(h => {
    h.addEventListener("click", (ev) => {
      // Don't toggle when clicking the favorite star.
      if (ev.target.closest("[data-fav-strategy]")) return;
      h.parentElement.classList.toggle("expanded");
    });
  });
  list.querySelectorAll("[data-fav-strategy]").forEach(btn => {
    btn.addEventListener("click", async ev => {
      ev.stopPropagation();
      const sid = btn.dataset.favStrategy;
      const s = STRATEGIES.find(x => x.id === sid);
      await Favorites.toggle("strategy", sid, s ? { name: s.name, en: s.en, desc: s.desc } : {});
      const isFav = Favorites.isFavorited("strategy", sid);
      btn.classList.toggle("on", isFav);
      btn.textContent = isFav ? "★" : "☆";
    });
  });
}

// =========================================================================
// Decision form (provider/model dropdowns + start handler)
// =========================================================================
let serverConfig = null;
let providerById = {};

function showDecisionForm(show, presetTicker) {
  const wrap = document.getElementById("decision-form-wrap");
  if (wrap) wrap.style.display = show ? "block" : "none";
  if (show) {
    if (presetTicker) {
      const el = document.getElementById("ticker");
      if (el) { el.value = presetTicker; }
    }
    setTimeout(() => document.getElementById("ticker")?.focus(), 50);
  }
}

/**
 * Open the unified 决策 tab and pre-fill the new-decision form with the
 * given ticker, then scroll the form into view. Called from Watchlist when
 * the user clicks "▶ 启动新决策" next to a tracked asset.
 */
function openDecisionFor(ticker) {
  document.querySelector('nav.tabs button[data-tab="decisions"]').click();
  showDecisionForm(true, ticker);
}
window.openDecisionFor = openDecisionFor;

function initDecisionForm() {
  const form = document.getElementById("decision-form");
  if (!form) return;

  const dateInput = document.getElementById("trade-date");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  document.querySelectorAll(".analyst-toggles input").forEach(box => {
    const lbl = box.parentElement;
    if (box.checked) lbl.classList.add("checked");
    box.addEventListener("change", () => lbl.classList.toggle("checked", box.checked));
  });

  // Form-collapse button (the launcher button lives inside DecisionsPage now,
  // wired up via DecisionsPage.init() → "decisions-new-btn").
  document.getElementById("decision-form-close")?.addEventListener("click", e => {
    e.preventDefault();
    showDecisionForm(false);
  });

  document.getElementById("decision-submit")?.addEventListener("click", e => {
    e.preventDefault();
    const params = readForm();
    if (!params.ticker || !params.trade_date) {
      alert("请填写股票代码和交易日期");
      return;
    }
    DecisionsPage.create(params);
    // Auto-collapse the form after launch — feels lighter that way
    showDecisionForm(false);
  });

  document.getElementById("llm-provider").addEventListener("change", e => {
    populateModelDropdowns(e.target.value);
    updateProviderBadge(e.target.value);
  });

  ["deep-llm", "quick-llm"].forEach(id => {
    const sel = document.getElementById(id);
    const custom = document.getElementById(`${id}-custom`);
    sel.addEventListener("change", () => {
      custom.style.display = sel.value === CUSTOM_VALUE ? "block" : "none";
      if (sel.value === CUSTOM_VALUE) custom.focus();
    });
  });

  document.querySelectorAll(".example-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const params = JSON.parse(chip.dataset.params);
      Object.entries(params).forEach(([k, v]) => {
        const el = document.getElementById(k);
        if (el) {
          if (el.type === "checkbox") el.checked = !!v;
          else el.value = v;
        }
      });
    });
  });

  loadServerConfig();
}

async function loadServerConfig() {
  try {
    const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
    const r = await fetch(`${apiBase}/api/config`);
    if (!r.ok) throw new Error(`config ${r.status}`);
    serverConfig = await r.json();
  } catch (err) {
    console.error("config load failed:", err);
    return;
  }
  providerById = {};
  serverConfig.providers.forEach(p => { providerById[p.id] = p; });
  const providerEl = document.getElementById("llm-provider");
  providerEl.innerHTML = serverConfig.providers.map(p => {
    const tag = p.key_present ? " · ✓ key" : " · ✗ no key";
    return `<option value="${p.id}">${p.label}${tag}</option>`;
  }).join("");
  const d = serverConfig.defaults || {};
  if (d.llm_provider) providerEl.value = d.llm_provider;
  populateModelDropdowns(providerEl.value, d.deep_think_llm, d.quick_think_llm);
  updateProviderBadge(providerEl.value);
  setIfPresent("ticker", d.ticker);
  setIfPresent("instrument", d.instrument_hint);
  setIfPresent("risk-tolerance", d.risk_tolerance ? String(d.risk_tolerance) : null);
  setIfPresent("depth", d.research_depth ? String(d.research_depth) : null);
  setIfPresent("language", d.output_language);
}

function setIfPresent(id, value) {
  if (!value) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (el.tagName === "SELECT") {
    if (Array.from(el.options).some(o => o.value === value)) el.value = value;
  } else {
    el.value = value;
  }
}

function populateModelDropdowns(providerId, presetDeep, presetQuick) {
  const provider = providerById[providerId];
  if (!provider) return;
  const deepSel = document.getElementById("deep-llm");
  const quickSel = document.getElementById("quick-llm");
  const deepCustom = document.getElementById("deep-llm-custom");
  const quickCustom = document.getElementById("quick-llm-custom");
  const renderOpts = (models) => {
    const std = (models || []).map(m =>
      `<option value="${m.value}">${m.label}</option>`
    ).join("");
    return std + `<option value="${CUSTOM_VALUE}">— 自定义模型 ID …</option>`;
  };
  deepSel.innerHTML = renderOpts(provider.models?.deep);
  quickSel.innerHTML = renderOpts(provider.models?.quick);
  const applyPreset = (sel, custom, val) => {
    if (!val) return;
    if (Array.from(sel.options).some(o => o.value === val)) {
      sel.value = val;
      custom.style.display = "none";
    } else {
      sel.value = CUSTOM_VALUE;
      custom.value = val;
      custom.style.display = "block";
    }
  };
  applyPreset(deepSel, deepCustom, presetDeep);
  applyPreset(quickSel, quickCustom, presetQuick);
}

function updateProviderBadge(providerId) {
  const provider = providerById[providerId];
  const badge = document.getElementById("provider-key-badge");
  const hint = document.getElementById("provider-hint");
  if (!badge || !provider) return;
  if (provider.key_present) {
    badge.className = "pill live";
    badge.textContent = "API KEY ✓";
    if (hint) hint.textContent = `已检测到 ${provider.key_env} — 可使用 LIVE 模式。`;
  } else {
    badge.className = "pill demo";
    badge.textContent = "无 KEY";
    if (hint) hint.textContent = `未检测到 ${provider.key_env} — 选 LIVE 会失败，建议改用 DEMO 或在 .env 里配置。`;
  }
}

function readSelectOrCustom(id) {
  const sel = document.getElementById(id);
  const custom = document.getElementById(`${id}-custom`);
  if (!sel) return "";
  if (sel.value === CUSTOM_VALUE) {
    return (custom && custom.value.trim()) || "";
  }
  return sel.value.trim();
}

function readForm() {
  return {
    ticker: document.getElementById("ticker").value.trim().toUpperCase(),
    trade_date: document.getElementById("trade-date").value,
    // Pinned defaults — UI no longer exposes these:
    analysts: ANALYST_KEYS,        // always all 4
    instrument_hint: "",           // always "不限"
    mode: "live",                  // always LIVE
    parallel_analysts: true,       // always on (faster + structured below)
    structured_reports: true,      // always on
    llm_provider: document.getElementById("llm-provider").value,
    deep_think_llm: readSelectOrCustom("deep-llm"),
    quick_think_llm: readSelectOrCustom("quick-llm"),
    research_depth: parseInt(document.getElementById("depth").value, 10) || 1,
    output_language: document.getElementById("language").value,
    risk_tolerance: parseInt(document.getElementById("risk-tolerance").value, 10) || 3,
  };
}

// =========================================================================
// Cockpit DOM template (per-window, classes only)
// =========================================================================
function buildCockpitDOM() {
  const root = document.createElement("div");
  root.className = "cockpit";
  root.innerHTML = `
    <div class="cockpit-toolbar">
      <h3 class="cockpit-ticker"></h3>
      <div class="toolbar-actions">
        <span class="mode-pill pill"></span>
        <span class="translation-pill pill" title="翻译层状态"></span>
        <span class="status-text muted" style="font-size:12px;"></span>
        <button class="btn danger cancel-run" style="display:none;">⏹ 终止</button>
        <button class="btn secondary download-md" disabled>⬇ Markdown</button>
        <button class="btn secondary download-json" disabled>⬇ JSON</button>
        <button class="btn secondary save-history" disabled>📌 保存到历史</button>
      </div>
    </div>

    <div class="cockpit-shell">
      <aside class="cockpit-sidebar">
        <div class="sidebar-section-title">导航</div>
        <ul class="sidebar-nav">
          <li data-section="progress" class="active">
            <span class="icon">📊</span><span class="label">智能体进度</span>
            <span class="badge" data-badge="progress">—</span>
          </li>
          <li data-section="logs">
            <span class="icon">📡</span><span class="label">事件流</span>
            <span class="badge" data-badge="logs">0</span>
          </li>
          <li data-section="past-context">
            <span class="icon">📝</span><span class="label">历史回顾</span>
            <span class="badge" data-badge="past-context">—</span>
          </li>
          <li class="sidebar-group">分析师报告</li>
          <li data-section="report-market_report">
            <span class="icon">📈</span><span class="label">市场技术</span>
            <span class="badge" data-badge="market_report">—</span>
          </li>
          <li data-section="report-sentiment_report">
            <span class="icon">💬</span><span class="label">情绪</span>
            <span class="badge" data-badge="sentiment_report">—</span>
          </li>
          <li data-section="report-news_report">
            <span class="icon">📰</span><span class="label">新闻</span>
            <span class="badge" data-badge="news_report">—</span>
          </li>
          <li data-section="report-fundamentals_report">
            <span class="icon">💼</span><span class="label">基本面</span>
            <span class="badge" data-badge="fundamentals_report">—</span>
          </li>
          <li class="sidebar-group">辩论与决策</li>
          <li data-section="debate">
            <span class="icon">🐂🐻</span><span class="label">投资辩论</span>
            <span class="badge" data-badge="debate">0</span>
          </li>
          <li data-section="report-investment_plan">
            <span class="icon">📋</span><span class="label">研究计划</span>
            <span class="badge" data-badge="investment_plan">—</span>
          </li>
          <li data-section="report-trader_investment_plan">
            <span class="icon">🧾</span><span class="label">交易提案</span>
            <span class="badge" data-badge="trader_investment_plan">—</span>
          </li>
          <li data-section="risk-debate">
            <span class="icon">⚖️</span><span class="label">风险辩论</span>
            <span class="badge" data-badge="risk-debate">0</span>
          </li>
          <li data-section="final">
            <span class="icon">🎯</span><span class="label">最终决策 + 策略</span>
            <span class="badge" data-badge="final">—</span>
          </li>
        </ul>
      </aside>

      <main class="cockpit-main">
        <section class="cockpit-section active" data-section="progress">
          <div class="panel"><div class="head">智能体执行进度</div>
            <div class="body agents-board"><div class="muted" style="font-size:12px;">等待启动…</div></div>
          </div>
        </section>
        <section class="cockpit-section" data-section="logs">
          <div class="panel"><div class="head">实时事件流</div>
            <div class="body" style="padding:10px;"><div class="log-stream"></div></div>
          </div>
        </section>
        <section class="cockpit-section" data-section="past-context">
          <div class="panel"><div class="head">📝 历史回顾 — 来自 TradingAgents 记忆库</div>
            <div class="body section-body past-context-body">
              <div class="muted">无历史数据 — 同标的第一次跑或 5 天内无回溯。</div>
            </div>
          </div>
        </section>
        ${[
          ["market_report", "市场技术分析报告"],
          ["sentiment_report", "情绪分析报告"],
          ["news_report", "新闻分析报告"],
          ["fundamentals_report", "基本面分析报告"],
          ["investment_plan", "研究经理 · 投资计划"],
          ["trader_investment_plan", "交易员 · 交易提案"],
        ].map(([k, t]) => `
          <section class="cockpit-section" data-section="report-${k}">
            <div class="panel"><div class="head">${t}</div>
              <div class="body section-body" data-section-key="${k}"><div class="muted">未生成。</div></div>
            </div>
          </section>
        `).join("")}
        <section class="cockpit-section" data-section="debate">
          <div class="panel"><div class="head">🐂 vs 🐻 投资观点辩论</div>
            <div class="body debate-area"></div>
          </div>
        </section>
        <section class="cockpit-section" data-section="risk-debate">
          <div class="panel"><div class="head">⚖️ 风险三方辩论</div>
            <div class="body risk-debate-area"></div>
          </div>
        </section>
        <section class="cockpit-section" data-section="final">
          <div class="panel"><div class="head">最终决策 + 策略库匹配</div>
            <div class="body final-card"><div class="muted">最终决策与策略推荐尚未就绪。</div></div>
          </div>
        </section>
      </main>
    </div>
  `;
  return root;
}

// =========================================================================
// DecisionWindow — one analysis run, isolated state + DOM
// =========================================================================
class DecisionWindow {
  constructor(params, opts = {}) {
    this.id = opts.id || uid();
    this.params = params;
    this.es = null;
    this.status = "idle";   // idle | running | done | error | restored
    this.startedAt = opts.startedAt || new Date().toISOString();
    this.completedAt = opts.completedAt || null;

    this.runState = opts.runState || {
      agents: {},
      events: [],
      reports: {},
      debate: { bull: [], bear: [] },
      riskDebate: { aggressive: [], neutral: [], conservative: [] },
      finalDecision: null,
      matchedStrategies: null,
      translation: null,
    };

    this.dom = buildCockpitDOM();
    this.dom.classList.add("window-instance");
    this.dom.dataset.windowId = this.id;
    this._wireDOM();
  }

  _wireDOM() {
    this.q = sel => this.dom.querySelector(sel);
    this.qa = sel => this.dom.querySelectorAll(sel);

    // sidebar nav
    this.qa(".sidebar-nav li[data-section]").forEach(li => {
      li.addEventListener("click", () => this.activateSection(li.dataset.section));
    });

    // toolbar buttons
    this.q(".download-md").addEventListener("click", () => this.download("md"));
    this.q(".download-json").addEventListener("click", () => this.download("json"));
    this.q(".save-history").addEventListener("click", async () => {
      await History.save(this);
      this.q(".save-history").textContent = "✓ 已保存";
      setTimeout(() => this.q(".save-history").textContent = "📌 保存到历史", 2000);
    });
    this.q(".cancel-run").addEventListener("click", () => {
      if (!confirm("确认终止本次决策？已生成的事件会保留。")) return;
      this.cancel();
    });
  }

  cancel() {
    if (this.es) { this.es.close(); this.es = null; }
    this.setStatusText("已终止");
    this.markStatus("cancelled");
  }

  activateSection(sectionId) {
    this.qa(".sidebar-nav li[data-section]").forEach(li => {
      li.classList.toggle("active", li.dataset.section === sectionId);
    });
    this.qa(".cockpit-section").forEach(s => {
      s.classList.toggle("active", s.dataset.section === sectionId);
    });
  }

  setBadge(key, value, state) {
    const el = this.q(`[data-badge="${key}"]`);
    if (!el) return;
    el.textContent = value;
    el.classList.remove("ready", "in-progress");
    if (state) el.classList.add(state);
  }

  setStatusText(s) { this.q(".status-text").textContent = s || ""; }

  setModePill(mode) {
    const pill = this.q(".mode-pill");
    pill.className = "mode-pill pill " + (mode || "");
    pill.textContent = mode === "live" ? "LIVE" : mode === "demo" ? "DEMO" : (mode || "").toUpperCase();
  }

  setTranslationPill(status) {
    const pill = this.q(".translation-pill");
    if (!status) { pill.className = "translation-pill pill"; pill.textContent = ""; return; }
    if (status.target?.toLowerCase() === "english") {
      pill.className = "translation-pill pill demo"; pill.textContent = "EN";
    } else if (status.available) {
      pill.className = "translation-pill pill live"; pill.textContent = `翻译 · ${status.provider}`;
    } else {
      pill.className = "translation-pill pill demo"; pill.textContent = "翻译未启用";
    }
  }

  // ---- start / stop / events ----------------------------------------

  /**
   * Read the signed-in user's API keys (LLM + data) from their Supabase
   * profile and merge into a single dict. Returns {} when not signed in
   * (single-tenant fallback uses backend .env keys).
   */
  /**
   * Bulk-insert the run's usage_events to the user's Supabase
   * `usage_events` table. RLS ensures each row attaches to auth.uid().
   * No-op when not signed in (data stays in localStorage via History).
   */
  async _flushUsageEvents() {
    const events = this.runState.usage_events || [];
    if (!events.length) return;
    if (!window.Auth?.isSignedIn() || !window.Auth.rawClient) return;
    const u = window.Auth.user();
    const rows = events.map(e => ({
      user_id: u.id,
      decision_id: this.id,
      ts: e.ts,
      kind: e.kind,
      provider: e.provider || null,
      model: e.model || null,
      tokens_in: e.tokens_in || 0,
      tokens_out: e.tokens_out || 0,
      tool_name: e.tool_name || null,
    }));
    const { error } = await window.Auth.rawClient().from("usage_events").insert(rows);
    if (error) console.warn("usage_events insert error:", error.message);
  }

  async _readUserKeys() {
    if (!window.Auth || !window.Auth.isSignedIn() || !window.Auth.rawClient) return {};
    try {
      const u = window.Auth.user();
      const { data, error } = await window.Auth.rawClient()
        .from("profiles")
        .select("llm_api_keys, custom_api_keys")
        .eq("id", u.id)
        .single();
      if (error) return {};
      return Object.assign({}, data?.llm_api_keys || {}, data?.custom_api_keys || {});
    } catch (e) {
      console.warn("readUserKeys", e);
      return {};
    }
  }

  async start() {
    this.markStatus("running");
    this.q(".cockpit-ticker").textContent = `${this.params.ticker} · ${this.params.trade_date}`;

    try {
      const headers = { "Content-Type": "application/json" };
      // Attach Supabase JWT when signed in — required if backend has
      // SUPABASE_JWT_SECRET set; harmless otherwise.
      const tok = window.Auth?.accessToken?.();
      if (tok) headers["Authorization"] = `Bearer ${tok}`;

      // Multi-tenant: pull this user's saved API keys from their Supabase
      // profile and attach them to the request body. The backend uses
      // KeyInjector to set them in env for the duration of graph
      // construction, then restores. Single-tenant deployments (no
      // signed-in user) skip this and the backend uses .env keys.
      const userKeys = await this._readUserKeys();

      const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
      const r = await fetch(`${apiBase}/api/analyze`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...this.params,
          api_keys: userKeys,
          user_id: window.Auth?.user?.()?.id || null,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { session_id } = await r.json();
      this.es = new EventSource(`${apiBase}/api/stream/${session_id}`);
      this.es.onmessage = ev => {
        try { this.handleEvent(JSON.parse(ev.data)); } catch (e) { console.warn("bad event", e); }
      };
      this.es.onerror = () => {
        this.setStatusText("连接中断");
        this.markStatus("error");
        if (this.es) { this.es.close(); this.es = null; }
      };
    } catch (err) {
      this.setStatusText(`无法启动会话：${err.message}`);
      this.markStatus("error");
    }
  }

  stop() {
    if (this.es) { this.es.close(); this.es = null; }
    this.markStatus("done");
  }

  markStatus(s) {
    this.status = s;
    if (s === "done" || s === "cancelled") this.completedAt = new Date().toISOString();
    WindowManager.renderTabs();
    const cancelBtn = this.q(".cancel-run");
    if (cancelBtn) cancelBtn.style.display = (s === "running" || s === "live" || s === "demo") ? "" : "none";
    if (s === "done" || s === "restored" || s === "cancelled") {
      this.q(".download-md").disabled = false;
      this.q(".download-json").disabled = false;
      this.q(".save-history").disabled = false;
    }
  }

  handleEvent(evt) {
    this.runState.events.push(evt);
    switch (evt.type) {
      case "ready": this.setStatusText("会话已建立"); break;
      case "init":
        this.runState.translation = evt.translation;
        this.setTranslationPill(evt.translation);
        this.renderAgentBoard(evt.agents, evt.selected_analysts);
        break;
      case "mode": this.setModePill(evt.mode); break;
      case "agent_status": this.updateAgentStatus(evt.agent_id, evt.status); this.bumpProgressBadge(); break;
      case "log": this.appendLog(evt); break;
      case "tool_call":
        this.appendLog({ kind: "tool", content: `→ ${evt.name}(${this.formatArgs(evt.args)})`, ts: evt.ts });
        break;
      case "report": this.renderReport(evt); break;
      case "debate": this.renderDebate(evt); break;
      case "risk_debate": this.renderRiskDebate(evt); break;
      case "final_decision": this.renderFinal(evt); break;
      case "translation": this.applyTranslationPatch(evt); break;
      case "usage": this.runState.usage = evt.stats; break;
      case "usage_event":
        (this.runState.usage_events ||= []).push(evt);
        break;
      case "past_context":
        this.runState.past_context = evt.content;
        this.renderPastContext();
        break;
      case "structured_reports":
        // Optional opt-in (#10). Stored alongside markdown reports —
        // History.save() persists this in decisions.run_state for SQL queries.
        this.runState.structured_reports = evt.reports;
        break;
      case "complete":
        this.setStatusText("分析完成 ✔");
        this.markStatus("done");
        if (this.es) { this.es.close(); this.es = null; }
        // Save decision FIRST so usage_events.decision_id FK has its target;
        // otherwise the FK constraint trips and tokens are never recorded.
        //
        // NB: the watchlist 综合报告 auto-trigger was REMOVED on 2026-05-22 —
        // the user now generates it manually via the button on the 自选 page.
        saveHistorySafely(this)
          .then(() => this._flushUsageEvents())
          .catch(e => console.warn("post-complete persistence", e));
        break;
      case "error":
        this.setStatusText(`错误：${evt.message}`);
        this.markStatus("error");
        break;
    }
  }

  formatArgs(args) {
    if (!args) return "";
    try {
      const s = typeof args === "string" ? args : JSON.stringify(args);
      return s.length > 90 ? s.slice(0, 90) + "…" : s;
    } catch { return String(args).slice(0, 90); }
  }

  // ---- render: agents / log / reports / debate / final ---------------

  renderAgentBoard(agents, selected) {
    this.runState.agents = {};
    agents.forEach(a => { this.runState.agents[a.id] = { ...a, status: "pending" }; });
    if (selected && selected.length) this.runState.agents[selected[0]].status = "in_progress";
    this.drawAgentBoard();
  }

  drawAgentBoard() {
    const teams = {};
    Object.values(this.runState.agents).forEach(a => { (teams[a.team] ||= []).push(a); });
    const board = this.q(".agents-board");
    const statusZh = s => ({ pending: "等待", in_progress: "进行中", completed: "完成" }[s] || s);
    board.innerHTML = Object.entries(teams).map(([team, members]) => `
      <div class="team-block">
        <div class="team-label">${TEAM_ZH[team] || team}</div>
        ${members.map(a => `
          <div class="agent-row ${a.status}" data-agent="${a.id}">
            <span class="dot"></span>
            <span class="name">${AGENT_DISPLAY_ZH[a.name] || a.name}</span>
            <span class="badge">${statusZh(a.status)}</span>
          </div>
        `).join("")}
      </div>
    `).join("");
  }

  updateAgentStatus(id, status) {
    if (!this.runState.agents[id]) return;
    this.runState.agents[id].status = status;
    const row = this.q(`.agent-row[data-agent="${id}"]`);
    if (!row) return;
    const statusZh = s => ({ pending: "等待", in_progress: "进行中", completed: "完成" }[s] || s);
    row.className = `agent-row ${status}`;
    row.querySelector(".badge").textContent = statusZh(status);
  }

  bumpProgressBadge() {
    const total = Object.keys(this.runState.agents).length;
    if (!total) return this.setBadge("progress", "—");
    const done = Object.values(this.runState.agents).filter(a => a.status === "completed").length;
    const inProgress = Object.values(this.runState.agents).some(a => a.status === "in_progress");
    this.setBadge("progress", `${done}/${total}`, inProgress ? "in-progress" : (done === total ? "ready" : ""));
  }

  appendLog(evt) {
    const stream = this.q(".log-stream");
    const line = document.createElement("div");
    line.className = "line";
    line.innerHTML = `
      <span class="ts">${evt.ts || ""}</span>
      <span class="kind ${evt.kind || "system"}">${(evt.kind || "system").toUpperCase()}</span>
      <span class="content">${escapeHtml(evt.content || "")}</span>
    `;
    stream.appendChild(line);
    stream.scrollTop = stream.scrollHeight;
    this.setBadge("logs", String(stream.querySelectorAll(".line").length));
  }

  /**
   * Render the past_context (TradingAgents memory log) into the cockpit's
   * "📝 历史回顾" section. Called when a `past_context` SSE event arrives.
   */
  renderPastContext() {
    const ctx = this.runState.past_context;
    const body = this.q(".past-context-body");
    if (!body) return;
    if (!ctx || !ctx.trim()) {
      body.innerHTML = `<div class="muted">无历史数据 — 同标的第一次跑或 5 天内无回溯。</div>`;
      this.setBadge("past-context", "—");
      return;
    }
    body.innerHTML = mdLite(ctx);
    // count entries roughly by counting "[YYYY-MM-DD" headers
    const matches = (ctx.match(/\[\d{4}-\d{2}-\d{2}/g) || []).length;
    this.setBadge("past-context", String(matches), "ready");
  }

  renderReport(evt) {
    const body = this.q(`.section-body[data-section-key="${evt.section}"]`);
    if (!body) return;
    body.dataset.msgId = evt.msg_id || "";
    body.innerHTML = mdLite(evt.content || "");
    if (this.runState.translation?.available && !isMostlyChinese(evt.content || "")) {
      const hint = document.createElement("div");
      hint.className = "pending-translation";
      hint.textContent = "🔄 中文翻译生成中…";
      body.prepend(hint);
    }
    this.runState.reports[evt.section] = {
      title: evt.title, msg_id: evt.msg_id,
      content_en: evt.content, content_zh: null,
      section: evt.section,
    };
    this.setBadge(evt.section, "✓", "ready");
  }

  renderDebate(evt) {
    const wrap = this.q(".debate-area");
    if (!wrap.dataset.init) {
      wrap.innerHTML = `
        <div class="debate-grid">
          <div class="debate-side bull"><div class="head">🐂 牛市研究员</div><div class="turns" data-side="bull"></div></div>
          <div class="debate-side bear"><div class="head">🐻 熊市研究员</div><div class="turns" data-side="bear"></div></div>
        </div>
      `;
      wrap.dataset.init = "1";
    }
    const target = wrap.querySelector(`.turns[data-side="${evt.side}"]`);
    if (!target) return;
    const turn = document.createElement("div");
    turn.className = "turn";
    turn.dataset.msgId = evt.msg_id || "";
    turn.dataset.ts = evt.ts || "";
    turn.innerHTML = `<div class="muted" style="font-size:11px;">${evt.ts || ""}</div>${mdLite(evt.content || "")}`;
    target.appendChild(turn);
    target.scrollTop = target.scrollHeight;
    this.runState.debate[evt.side].push({
      ts: evt.ts, msg_id: evt.msg_id,
      content_en: evt.content, content_zh: null,
    });
    this.setBadge("debate", String(this.runState.debate.bull.length + this.runState.debate.bear.length));
  }

  renderRiskDebate(evt) {
    const wrap = this.q(".risk-debate-area");
    if (!wrap.dataset.init) {
      wrap.innerHTML = `
        <div class="risk-grid">
          <div class="debate-side aggressive"><div class="head">🔥 激进</div><div class="turns" data-side="aggressive"></div></div>
          <div class="debate-side neutral"><div class="head">⚖️ 中立</div><div class="turns" data-side="neutral"></div></div>
          <div class="debate-side conservative"><div class="head">🛡️ 保守</div><div class="turns" data-side="conservative"></div></div>
        </div>
      `;
      wrap.dataset.init = "1";
    }
    const target = wrap.querySelector(`.turns[data-side="${evt.side}"]`);
    if (!target) return;
    const turn = document.createElement("div");
    turn.className = "turn";
    turn.dataset.msgId = evt.msg_id || "";
    turn.dataset.ts = evt.ts || "";
    turn.innerHTML = `<div class="muted" style="font-size:11px;">${evt.ts || ""}</div>${mdLite(evt.content || "")}`;
    target.appendChild(turn);
    target.scrollTop = target.scrollHeight;
    this.runState.riskDebate[evt.side].push({
      ts: evt.ts, msg_id: evt.msg_id,
      content_en: evt.content, content_zh: null,
    });
    const total = this.runState.riskDebate.aggressive.length + this.runState.riskDebate.neutral.length + this.runState.riskDebate.conservative.length;
    this.setBadge("risk-debate", String(total));
  }

  renderFinal(evt) {
    const dec = evt.decision || {};
    const matched = evt.matched_strategies || { items: [], parsed: {} };
    this.runState.finalDecision = {
      rating: dec.rating, confidence: dec.confidence, msg_id: evt.msg_id,
      raw_en: dec.raw, raw_zh: null,
      trader_plan_en: dec.trader_plan, trader_plan_zh: null,
      research_plan_en: dec.research_plan, research_plan_zh: null,
      parsed: matched.parsed,
    };
    this.runState.matchedStrategies = matched.items || [];
    // Multi-horizon plan: backend attaches `horizon_plan` to the final_decision
    // SSE event when the deep LLM successfully produced one. Falsy / missing
    // when the planner couldn't run (no key, JSON parse failure, etc.) — the
    // UI degrades to just the matched-strategy list in that case.
    this.runState.horizonPlan = evt.horizon_plan || null;
    this.rerenderFinalCard();
    this.setBadge("final", dec.rating || "✓", "ready");
    if (typeof DecisionsPage !== "undefined") DecisionsPage.render();
  }

  rerenderFinalCard() {
    if (!this.runState.finalDecision) return;
    const dec = this.runState.finalDecision;
    const matched = this.runState.matchedStrategies || [];
    const parsed = dec.parsed || {};
    const card = this.q(".final-card");
    const tags = [
      parsed.view && `<span class="tag view-tag">${VIEW_NAMES[parsed.view] || parsed.view}</span>`,
      parsed.horizon && `<span class="tag horizon-tag">${HORIZON_NAMES[parsed.horizon] || parsed.horizon}</span>`,
      parsed.volatility && `<span class="tag">${VIEW_NAMES[parsed.volatility] || parsed.volatility}</span>`,
    ].filter(Boolean).join("");

    const raw = dec.raw_zh || dec.raw_en || "";
    const transHint = (!dec.raw_zh && dec.raw_en && !isMostlyChinese(dec.raw_en) && this.runState.translation?.available)
      ? `<div class="pending-translation">🔄 中文翻译生成中…</div>` : "";

    // The flat "📚 来自策略库的匹配方案" panel was removed on 2026-05-22 —
    // all matched strategies are now inlined into each horizon's pane below
    // (see _renderHorizonPane → stratBlock).
    const planHtml = this._horizonPlanHtml(this.runState.horizonPlan, matched);

    card.innerHTML = `
      <div class="decision-card">
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <span class="decision-rating ${dec.rating || "Hold"}">${dec.rating || "Hold"}</span>
          ${dec.confidence ? `<span class="muted">信心：${dec.confidence}</span>` : ""}
        </div>
        <div class="parsed-tags">${tags}</div>
        ${transHint}
        <div style="margin-top:14px;">${mdLite(raw)}</div>
      </div>
      ${planHtml}
    `;
    this._wireHorizonTabs();
  }

  /**
   * Build the multi-horizon plan card. The deep model emits short / mid /
   * long horizons with target prices, scenarios, execution playbook, and
   * adjustment rules. We render them as a 3-tab card so each horizon is
   * an order-able playbook by itself, while the user can compare across.
   */
  _horizonPlanHtml(plan, matched) {
    if (!plan || !plan.horizons) {
      return `
        <div class="horizon-plan-card empty">
          <div class="horizon-plan-head">
            <h3 style="margin:0;">🗓 多周期目标价 + 执行策略</h3>
            <span class="muted" style="font-size:12px;">需要深思模型 API key — 未生成。</span>
          </div>
        </div>`;
    }

    const HORIZON_ORDER = ["short", "mid", "long"];
    const labels = plan.labels || { short: "短期 (1-2 个月)", mid: "中期 (3-6 个月)", long: "长期 (6 个月以上)" };
    const stratById = {};
    (matched || []).forEach(m => { if (m.id) stratById[m.id] = m; });

    // Bucket every matched strategy into a horizon based on its `.horizon`
    // field (short/swing/intraday → short, mid/medium → mid, long → long,
    // anything else → mid). This is the post-2026-05-22 merge: all matched
    // library entries flow into per-horizon panes instead of a flat bottom
    // panel. We mark which strategies the deep LLM explicitly picked vs
    // which are "auto-assigned" by category — both render with full detail.
    const assignedIds = new Set();
    HORIZON_ORDER.forEach(k => {
      const h = plan.horizons[k] || {};
      (h.strategies || []).forEach(sid => assignedIds.add(sid));
    });
    const _bucketFor = (mhz) => {
      const v = String(mhz || "").toLowerCase();
      if (v === "short" || v === "swing" || v === "intraday") return "short";
      if (v === "long") return "long";
      return "mid";
    };
    const autoAssigned = { short: [], mid: [], long: [] };
    (matched || []).forEach(m => {
      if (!m.id || assignedIds.has(m.id)) return;
      autoAssigned[_bucketFor(m.horizon)].push(m.id);
    });

    const cur = plan.current_price;
    const curStr = (cur != null && !isNaN(cur)) ? `当前价 $${Number(cur).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "";
    const provBadge = plan.model ? `<span class="pill" style="font-size:10px;">${escapeHtml(plan.model)}</span>` : "";

    const tabs = HORIZON_ORDER.map((k, i) => {
      const h = plan.horizons[k] || {};
      const ret = h.expected_return_pct;
      const retCls = ret == null ? "" : (ret > 0 ? "up" : ret < 0 ? "down" : "");
      const retTxt = ret == null ? "—" : (ret > 0 ? "+" : "") + Number(ret).toFixed(1) + "%";
      return `
        <button class="horizon-tab ${i === 0 ? "active" : ""}" data-horizon="${k}">
          <span class="horizon-tab-label">${labels[k] || k}</span>
          <span class="horizon-tab-meta">
            <span class="horizon-tab-target">${escapeHtml(h.target_price || "—")}</span>
            <span class="horizon-tab-ret ${retCls}">${retTxt}</span>
          </span>
        </button>`;
    }).join("");

    const panes = HORIZON_ORDER.map((k, i) => {
      const h = plan.horizons[k] || {};
      return `
        <div class="horizon-pane ${i === 0 ? "active" : ""}" data-horizon-pane="${k}">
          ${this._renderHorizonPane(k, h, labels[k] || k, stratById, autoAssigned[k] || [])}
        </div>`;
    }).join("");

    return `
      <div class="horizon-plan-card">
        <div class="horizon-plan-head">
          <h3 style="margin:0;">🗓 多周期目标价 + 执行策略</h3>
          <div class="horizon-plan-meta">
            ${curStr ? `<span class="muted">${escapeHtml(curStr)}${plan.quote_source ? ` · ${escapeHtml(plan.quote_source)}` : ""}</span>` : ""}
            ${provBadge}
          </div>
        </div>
        ${plan.summary ? `<div class="horizon-plan-summary">${escapeHtml(plan.summary)}</div>` : ""}
        <div class="horizon-tabs">${tabs}</div>
        <div class="horizon-panes">${panes}</div>
      </div>`;
  }

  /** Render the inside of one horizon pane (target / scenarios / execution / adjustments). */
  _renderHorizonPane(key, h, label, stratById, autoExtraIds = []) {
    const confEmoji = { high: "🟢 高把握", medium: "🟡 中等把握", low: "🟠 低把握" };
    const ret = h.expected_return_pct;
    const retCls = ret == null ? "" : (ret > 0 ? "up" : ret < 0 ? "down" : "");
    const retTxt = ret == null ? "—" : (ret > 0 ? "+" : "") + Number(ret).toFixed(1) + "%";

    // Top stats strip
    const stats = `
      <div class="horizon-stats">
        <div class="horizon-stat">
          <div class="label">目标价</div>
          <div class="value primary">${escapeHtml(h.target_price || "—")}</div>
        </div>
        <div class="horizon-stat">
          <div class="label">预期收益</div>
          <div class="value ${retCls}">${retTxt}</div>
        </div>
        <div class="horizon-stat">
          <div class="label">止损</div>
          <div class="value down">${escapeHtml(h.stop_loss || "—")}</div>
        </div>
        <div class="horizon-stat">
          <div class="label">把握度</div>
          <div class="value">${confEmoji[h.confidence] || "—"}</div>
        </div>
      </div>`;

    // Scenarios: 3 cards bull/base/bear with probability progress bars
    const SC_META = {
      bull: { label: "🐂 牛市情景", cls: "scen-bull" },
      base: { label: "🎯 基线情景", cls: "scen-base" },
      bear: { label: "🐻 熊市情景", cls: "scen-bear" },
    };
    const scenarios = (h.scenarios || []).map(s => {
      const m = SC_META[s.name] || { label: s.name, cls: "" };
      const probPct = Math.round((s.probability || 0) * 100);
      return `
        <div class="scenario-card ${m.cls}">
          <div class="scenario-head">
            <span class="scenario-name">${m.label}</span>
            <span class="scenario-prob">${probPct}%</span>
          </div>
          <div class="scenario-prob-bar"><div class="bar" style="width:${probPct}%;"></div></div>
          <div class="scenario-row"><span class="k">触发</span><span class="v">${escapeHtml(s.trigger || "—")}</span></div>
          <div class="scenario-row"><span class="k">目标价</span><span class="v target">${escapeHtml(s.target_price || "—")}</span></div>
          <div class="scenario-row"><span class="k">动作</span><span class="v">${escapeHtml(s.action || "—")}</span></div>
        </div>`;
    }).join("") || `<div class="muted">深思模型未给出情景分支。</div>`;

    // Execution playbook
    const ex = h.execution || {};
    const ladder = (ex.take_profit_ladder || []).map(x => `<li>${escapeHtml(x)}</li>`).join("");
    const mons = (ex.monitors || []).map(x => `<li>${escapeHtml(x)}</li>`).join("");
    const execBlock = `
      <div class="execution-block">
        <h4>📋 执行策略</h4>
        <div class="exec-grid">
          <div class="exec-cell"><span class="exec-label">入场</span><span class="exec-value">${escapeHtml(ex.entry || "—")}</span></div>
          <div class="exec-cell"><span class="exec-label">仓位</span><span class="exec-value">${escapeHtml(ex.size || "—")}</span></div>
          <div class="exec-cell"><span class="exec-label">止损</span><span class="exec-value">${escapeHtml(ex.stop || "—")}</span></div>
        </div>
        ${ladder ? `<div class="exec-sub"><strong>止盈梯度：</strong><ul>${ladder}</ul></div>` : ""}
        ${mons ? `<div class="exec-sub"><strong>盯盘信号：</strong><ul>${mons}</ul></div>` : ""}
      </div>`;

    // Strategy library matches for this horizon — merged from two sources:
    //   (1) IDs the deep LLM picked for this horizon (h.strategies)
    //   (2) Any matched library entry whose `.horizon` falls into this bucket
    //       but which the LLM didn't explicitly pick (the post-2026-05-22 merge
    //       — the flat "📚 来自策略库的匹配方案" panel at the bottom of the card
    //       was removed; its content lives here now).
    // We render each as a full card (description + reasons + concrete how /
    // params / pros / cons inside <details>) so the user has everything they
    // need to execute without leaving this horizon's tab.
    const picked = (h.strategies || []).map(sid => ({ sid, picked: true }));
    const autoExtras = (autoExtraIds || []).map(sid => ({ sid, picked: false }));
    const allStrats = [...picked, ...autoExtras];
    const stratCardsHtml = allStrats.map(({ sid, picked: isPicked }) => {
      const s = stratById[sid];
      if (!s) {
        return `
          <div class="strat-card-inline missing">
            <div class="strat-card-head">
              <span class="strat-card-name">${escapeHtml(sid)}</span>
              <span class="strat-card-badge">未找到</span>
            </div>
          </div>`;
      }
      const reasons = (s.reasons || []).map(r => `<span class="reason">${escapeHtml(r)}</span>`).join("");
      const paramRows = (s.concrete_params || s.params || []).map(([k, v]) =>
        `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`
      ).join("");
      const pros = (s.pros || []).map(x => `<li>${escapeHtml(x)}</li>`).join("");
      const cons = (s.cons || []).map(x => `<li>${escapeHtml(x)}</li>`).join("");
      const scoreBadge = s.score != null
        ? `<span class="strat-card-score" title="strategy-matcher 匹配分">匹配分 ${escapeHtml(String(s.score))}</span>`
        : "";
      const sourceBadge = isPicked
        ? `<span class="strat-card-source picked" title="深思模型为该周期挑选">🎯 深思精选</span>`
        : `<span class="strat-card-source auto" title="按周期自动归类">📂 自动归类</span>`;
      return `
        <div class="strat-card-inline">
          <div class="strat-card-head">
            <span class="strat-card-name">${escapeHtml(s.name || sid)}</span>
            ${s.en ? `<span class="strat-card-en">${escapeHtml(s.en)}</span>` : ""}
            ${s.cat ? `<span class="tag cat-${escapeHtml(s.cat)}">${escapeHtml(CAT_NAMES[s.cat] || s.cat)}</span>` : ""}
            ${sourceBadge}
            ${scoreBadge}
          </div>
          ${s.desc ? `<div class="strat-card-desc">${escapeHtml(s.desc)}</div>` : ""}
          ${reasons ? `<div class="strat-card-reasons">${reasons}</div>` : ""}
          <details class="strat-card-details">
            <summary>展开操作细节</summary>
            ${s.concrete_how
              ? `<p><strong>针对当前标的的具体操作：</strong>${escapeHtml(s.concrete_how)}</p>`
              : `<p><strong>怎么做：</strong>${escapeHtml(s.how || "—")}</p>`}
            ${paramRows ? `<table class="params-table">${paramRows}</table>` : ""}
            ${pros ? `<p><strong>好处：</strong></p><ul>${pros}</ul>` : ""}
            ${cons ? `<p><strong>代价：</strong></p><ul>${cons}</ul>` : ""}
            ${(!s.concrete_how && s.example)
              ? `<p class="muted" style="font-size:11px;"><strong>通用示例：</strong>${escapeHtml(s.example)}</p>`
              : ""}
          </details>
        </div>`;
    }).join("");
    const stratBlock = stratCardsHtml ? `
      <div class="execution-block strat-merged-block">
        <h4>📚 策略库匹配方案（按周期归类）</h4>
        <div class="strat-card-list">${stratCardsHtml}</div>
      </div>` : "";

    // Adjustment rules
    const adj = (h.adjustments || []).map(a => `
      <div class="adjust-row">
        <span class="adjust-if"><strong>若</strong> ${escapeHtml(a.if || "")}</span>
        <span class="adjust-then"><strong>则</strong> ${escapeHtml(a.then || "")}</span>
      </div>`).join("");
    const adjBlock = adj ? `
      <div class="execution-block">
        <h4>🛠 调整策略 (if / then)</h4>
        <div class="adjust-list">${adj}</div>
      </div>` : "";

    return stats + `
      <div class="horizon-section">
        <h4>📊 情景分析</h4>
        <div class="scenarios-grid">${scenarios}</div>
      </div>
      ${execBlock}
      ${stratBlock}
      ${adjBlock}`;
  }

  /** Wire the 3 horizon tabs inside the final-card. */
  _wireHorizonTabs() {
    const card = this.q(".final-card");
    if (!card) return;
    card.querySelectorAll(".horizon-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.horizon;
        card.querySelectorAll(".horizon-tab").forEach(b => b.classList.toggle("active", b === btn));
        card.querySelectorAll(".horizon-pane").forEach(p => p.classList.toggle("active", p.dataset.horizonPane === k));
      });
    });
  }

  applyTranslationPatch(evt) {
    const { msg_id, target, content } = evt;
    if (!msg_id || !content) return;
    const reportBody = this.q(`.section-body[data-msg-id="${msg_id}"]`);
    if (reportBody) {
      reportBody.innerHTML = mdLite(content);
      const key = reportBody.dataset.sectionKey;
      if (key && this.runState.reports[key]) this.runState.reports[key].content_zh = content;
      return;
    }
    const turn = this.dom.querySelector(`.turn[data-msg-id="${msg_id}"]`);
    if (turn) {
      const ts = turn.dataset.ts || "";
      turn.innerHTML = `<div class="muted" style="font-size:11px;">${ts}</div>${mdLite(content)}`;
      ["bull", "bear"].forEach(side => {
        const f = this.runState.debate[side].find(t => t.msg_id === msg_id);
        if (f) f.content_zh = content;
      });
      ["aggressive", "neutral", "conservative"].forEach(side => {
        const f = this.runState.riskDebate[side].find(t => t.msg_id === msg_id);
        if (f) f.content_zh = content;
      });
      return;
    }
    if (target?.startsWith("decision.") && this.runState.finalDecision) {
      const field = target.split(".")[1];
      this.runState.finalDecision[`${field}_zh`] = content;
      this.rerenderFinalCard();
    }
  }

  // ---- restore from history (replay state without SSE) -----------------

  static fromHistory(entry) {
    const w = new DecisionWindow(entry.params, {
      id: entry.id,
      runState: entry.runState,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    });
    w.status = "restored";
    // Replay state into the DOM
    w.q(".cockpit-ticker").textContent = `${entry.params.ticker} · ${entry.params.trade_date}`;
    w.setModePill("restored");
    w.q(".mode-pill").textContent = "RESTORED";
    w.setTranslationPill(entry.runState.translation);

    // agent board
    const agentArr = Object.values(entry.runState.agents || {});
    if (agentArr.length) {
      w.runState.agents = entry.runState.agents;
      w.drawAgentBoard();
      w.bumpProgressBadge();
    }

    // logs
    (entry.runState.events || []).forEach(e => {
      if (e.type === "log") w.appendLog(e);
      if (e.type === "tool_call") w.appendLog({ kind: "tool", content: `→ ${e.name}(${w.formatArgs(e.args)})`, ts: e.ts });
    });

    // reports
    Object.entries(entry.runState.reports || {}).forEach(([k, r]) => {
      const body = w.q(`.section-body[data-section-key="${k}"]`);
      if (!body) return;
      body.innerHTML = mdLite(r.content_zh || r.content_en || "");
      w.setBadge(k, "✓", "ready");
    });

    // debates
    ["bull", "bear"].forEach(side => {
      (entry.runState.debate?.[side] || []).forEach(t => {
        w.renderDebate({ side, content: t.content_zh || t.content_en, ts: t.ts, msg_id: t.msg_id });
      });
    });
    ["aggressive", "neutral", "conservative"].forEach(side => {
      (entry.runState.riskDebate?.[side] || []).forEach(t => {
        w.renderRiskDebate({ side, content: t.content_zh || t.content_en, ts: t.ts, msg_id: t.msg_id });
      });
    });

    // final + multi-horizon plan (persisted alongside the final decision)
    if (entry.runState.finalDecision) {
      w.runState.finalDecision = entry.runState.finalDecision;
      w.runState.matchedStrategies = entry.runState.matchedStrategies;
      w.runState.horizonPlan = entry.runState.horizonPlan || null;
      w.rerenderFinalCard();
      w.setBadge("final", entry.runState.finalDecision.rating || "✓", "ready");
    }

    // enable downloads / save
    w.q(".download-md").disabled = false;
    w.q(".download-json").disabled = false;
    w.q(".save-history").disabled = true;  // already in history
    w.q(".save-history").textContent = "已在历史";
    w.setStatusText(`回看：${new Date(entry.completedAt || entry.startedAt).toLocaleString()}`);
    return w;
  }

  // ---- download ------------------------------------------------------

  download(format) {
    const ticker = this.params.ticker;
    const date = this.params.trade_date;
    let blob, filename;
    if (format === "json") {
      const payload = {
        meta: {
          generated_at: new Date().toISOString(),
          window_id: this.id, ticker, trade_date: date,
          status: this.status, started_at: this.startedAt, completed_at: this.completedAt,
          params: this.params, translation: this.runState.translation,
        },
        reports: this.runState.reports,
        debate: this.runState.debate,
        risk_debate: this.runState.riskDebate,
        final_decision: this.runState.finalDecision,
        matched_strategies: this.runState.matchedStrategies,
        horizon_plan: this.runState.horizonPlan,
        events: this.runState.events,
      };
      blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      filename = `decision_${ticker}_${date}.json`;
    } else {
      blob = new Blob([this.buildMarkdownReport()], { type: "text/markdown;charset=utf-8" });
      filename = `decision_${ticker}_${date}.md`;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  buildMarkdownReport() {
    const p = this.params || {};
    const dec = this.runState.finalDecision || {};
    const parsed = dec.parsed || {};
    const usage = this.runState.usage || {};

    // ---- TOC + section visibility scan ---------------------------------
    // Determine which sections actually have content. The TOC is generated
    // dynamically so empty sections don't appear as broken anchors.
    const has = {
      decision: Boolean(dec.rating || dec.raw_zh || dec.raw_en),
      strategies: (this.runState.matchedStrategies || []).length > 0,
      reports: ["market_report","sentiment_report","news_report","fundamentals_report"]
                  .some(k => this.runState.reports[k]),
      debate: (this.runState.debate.bull.length + this.runState.debate.bear.length) > 0,
      risk: (this.runState.riskDebate.aggressive.length
             + this.runState.riskDebate.neutral.length
             + this.runState.riskDebate.conservative.length) > 0,
      research_plan: Boolean(this.runState.reports["investment_plan"]),
      trader_plan: Boolean(this.runState.reports["trader_investment_plan"]),
      usage: usage && (usage.tokens_in || usage.tokens_out || usage.llm_calls),
    };

    // Big rating badge in the header. Markdown viewers render bold + emoji
    // — and Markdown→HTML pipelines (gh, GitLab) keep the colour intent.
    const ratingEmoji = {
      Buy: "🟢", Overweight: "🟢",
      Hold: "⚪",
      Sell: "🔴", Underweight: "🔴",
    }[dec.rating] || "⚪";
    const ratingBadge = dec.rating
      ? `**${ratingEmoji} ${dec.rating}${dec.confidence ? `** · 信心 ${dec.confidence}` : "**"}`
      : "**⚪ 未生成**";

    const lines = [];

    // ---- HEADER ---------------------------------------------------------
    lines.push(`# 📊 智能交易决策报告 — ${p.ticker || ""}`);
    lines.push("");
    lines.push(`> ${ratingBadge}`);
    lines.push("");

    // metadata table for cleaner rendering
    lines.push("| 字段 | 值 |");
    lines.push("|---|---|");
    lines.push(`| 分析日期 | ${p.trade_date || "—"} |`);
    lines.push(`| 运行时间 | ${this.startedAt || "—"} → ${this.completedAt || "(进行中)"} |`);
    lines.push(`| LLM 提供商 | \`${p.llm_provider || "—"}\` |`);
    lines.push(`| 深思模型 | \`${p.deep_think_llm || "—"}\` |`);
    lines.push(`| 轻思模型 | \`${p.quick_think_llm || "—"}\` |`);
    lines.push(`| 研究深度 | ${p.research_depth || 1} 轮 |`);
    if (this.runState.translation) {
      const t = this.runState.translation;
      lines.push(`| 翻译层 | ${t.available ? `\`${t.provider}/${t.model}\`` : "未启用"} |`);
    }
    if (has.usage) {
      lines.push(`| Token 用量 | input ${usage.tokens_in || 0} · output ${usage.tokens_out || 0} · ${usage.llm_calls || 0} 次 LLM 调用 |`);
    }
    lines.push("");

    // ---- TABLE OF CONTENTS ---------------------------------------------
    lines.push("## 📑 目录");
    lines.push("");
    if (has.decision)      lines.push("- [🎯 最终决策](#最终决策)");
    if (has.strategies)    lines.push(`- [📚 策略库匹配 (${this.runState.matchedStrategies.length})](#策略库匹配)`);
    if (has.reports) {
      lines.push("- [📝 分析师报告](#分析师报告)");
      ["market_report","sentiment_report","news_report","fundamentals_report"].forEach(k => {
        if (!this.runState.reports[k]) return;
        const slug = k.replace(/_/g, "-");
        lines.push(`  - [${REPORT_TITLE_ZH[k] || k}](#${slug})`);
      });
    }
    if (has.debate)        lines.push("- [🐂 vs 🐻 投资观点辩论](#投资观点辩论)");
    if (has.risk)          lines.push("- [⚖️ 风险三方辩论](#风险三方辩论)");
    if (has.research_plan) lines.push("- [📋 研究经理 · 投资计划](#研究经理-投资计划)");
    if (has.trader_plan)   lines.push("- [🧾 交易员 · 交易提案](#交易员-交易提案)");
    lines.push("");
    lines.push("---");
    lines.push("");

    // ---- DECISION (anchor: 最终决策) -----------------------------------
    if (has.decision) {
      lines.push("## 🎯 最终决策");
      lines.push("");
      lines.push(`> ${ratingBadge}`);
      lines.push("");
      // Signal tags row
      const tags = [];
      if (parsed.view)       tags.push(`观点: \`${parsed.view}\``);
      if (parsed.horizon)    tags.push(`周期: \`${parsed.horizon}\``);
      if (parsed.volatility) tags.push(`波动: \`${parsed.volatility}\``);
      if (tags.length)       lines.push("**信号**: " + tags.join(" · "));
      lines.push("");
      lines.push(dec.raw_zh || dec.raw_en || "_(未生成)_");
      lines.push("");
    }

    // ---- MULTI-HORIZON PLAN (short / mid / long target prices + plans) ---
    const plan = this.runState.horizonPlan;
    if (plan && plan.horizons) {
      lines.push("## 🗓 多周期目标价 + 执行策略");
      lines.push("");
      if (plan.summary) { lines.push(`> ${plan.summary}`); lines.push(""); }
      lines.push("| 周期 | 目标价 | 预期收益 | 止损 | 把握度 |");
      lines.push("|---|---|---|---|---|");
      ["short", "mid", "long"].forEach(k => {
        const h = plan.horizons[k] || {};
        const lbl = (plan.labels && plan.labels[k]) || k;
        const ret = h.expected_return_pct == null ? "—" : `${h.expected_return_pct > 0 ? "+" : ""}${Number(h.expected_return_pct).toFixed(1)}%`;
        lines.push(`| ${lbl} | ${h.target_price || "—"} | ${ret} | ${h.stop_loss || "—"} | ${h.confidence || "—"} |`);
      });
      lines.push("");
      ["short", "mid", "long"].forEach(k => {
        const h = plan.horizons[k] || {};
        const lbl = (plan.labels && plan.labels[k]) || k;
        lines.push(`### ${lbl}`);
        lines.push("");
        if (h.scenarios?.length) {
          lines.push("**情景分析**");
          lines.push("");
          h.scenarios.forEach(s => {
            const name = { bull: "🐂 牛市", base: "🎯 基线", bear: "🐻 熊市" }[s.name] || s.name;
            lines.push(`- ${name} (概率 ${Math.round((s.probability || 0) * 100)}%): 目标 ${s.target_price || "—"}; 触发: ${s.trigger || "—"}; 动作: ${s.action || "—"}`);
          });
          lines.push("");
        }
        const ex = h.execution || {};
        if (ex.entry || ex.size || ex.stop) {
          lines.push("**执行策略**");
          lines.push("");
          if (ex.entry) lines.push(`- 入场: ${ex.entry}`);
          if (ex.size)  lines.push(`- 仓位: ${ex.size}`);
          if (ex.stop)  lines.push(`- 止损: ${ex.stop}`);
          if (ex.take_profit_ladder?.length) lines.push(`- 止盈: ${ex.take_profit_ladder.join("; ")}`);
          if (ex.monitors?.length) lines.push(`- 盯盘: ${ex.monitors.join("; ")}`);
          lines.push("");
        }
        if (h.adjustments?.length) {
          lines.push("**调整规则**");
          lines.push("");
          h.adjustments.forEach(a => lines.push(`- 若 ${a.if} → 则 ${a.then}`));
          lines.push("");
        }
      });
    }

    // ---- STRATEGY MATCHES (anchor: 策略库匹配) -------------------------
    if (has.strategies) {
      lines.push("## 📚 策略库匹配");
      lines.push("");
      // Compact summary table first
      lines.push("| # | 策略 | 类别 | 匹配分 |");
      lines.push("|---|---|---|---|");
      (this.runState.matchedStrategies || []).forEach((m, i) => {
        const cat = (typeof CAT_NAMES !== "undefined" && CAT_NAMES[m.cat]) || m.cat;
        lines.push(`| ${i + 1} | **${m.name}** _(${m.en || ""})_ | ${cat} | ${m.score} |`);
      });
      lines.push("");
      // Detailed cards
      (this.runState.matchedStrategies || []).forEach((m, i) => {
        lines.push(`### ${i + 1}. ${m.name} _(${m.en || ""})_`);
        lines.push("");
        lines.push(`- **类别**: ${(typeof CAT_NAMES !== "undefined" && CAT_NAMES[m.cat]) || m.cat}`);
        lines.push(`- **匹配分**: ${m.score}`);
        lines.push(`- **描述**: ${m.desc || ""}`);
        lines.push(`- **怎么做**: ${m.how || ""}`);
        if (m.params?.length) lines.push(`- **关键参数**: ${m.params.map(([k, v]) => `${k}=${v}`).join("; ")}`);
        lines.push(`- **匹配原因**: ${(m.reasons || []).join("； ")}`);
        if (m.example) lines.push(`- **示例**: ${m.example}`);
        lines.push("");
      });
    }

    // ---- ANALYST REPORTS (anchor: 分析师报告) --------------------------
    if (has.reports) {
      lines.push("## 📝 分析师报告");
      lines.push("");
      ["market_report", "sentiment_report", "news_report", "fundamentals_report"].forEach(k => {
        const r = this.runState.reports[k];
        if (!r) return;
        lines.push(`### ${REPORT_TITLE_ZH[k] || k}`);
        lines.push("");
        lines.push(r.content_zh || r.content_en || "_(未生成)_");
        lines.push("");
      });
    }

    // ---- DEBATE (anchor: 投资观点辩论) ---------------------------------
    if (has.debate) {
      lines.push("## 🐂 vs 🐻 投资观点辩论");
      lines.push("");
      ["bull", "bear"].forEach(side => {
        const arr = this.runState.debate[side];
        if (!arr.length) return;
        lines.push(`### ${side === "bull" ? "🐂 牛市研究员" : "🐻 熊市研究员"}`);
        lines.push("");
        arr.forEach((t, i) => {
          lines.push(`**回合 ${i + 1}** _(${t.ts || ""})_`);
          lines.push("");
          lines.push(t.content_zh || t.content_en || "");
          lines.push("");
        });
      });
    }

    // ---- RISK DEBATE (anchor: 风险三方辩论) ----------------------------
    if (has.risk) {
      lines.push("## ⚖️ 风险三方辩论");
      lines.push("");
      ["aggressive", "neutral", "conservative"].forEach(side => {
        const arr = this.runState.riskDebate[side];
        if (!arr.length) return;
        const label = { aggressive: "🔥 激进", neutral: "⚖️ 中立", conservative: "🛡️ 保守" }[side];
        lines.push(`### ${label}`);
        lines.push("");
        arr.forEach((t, i) => {
          lines.push(`**回合 ${i + 1}** _(${t.ts || ""})_`);
          lines.push("");
          lines.push(t.content_zh || t.content_en || "");
          lines.push("");
        });
      });
    }

    // ---- RESEARCH PLAN -------------------------------------------------
    if (has.research_plan) {
      lines.push("## 📋 研究经理 · 投资计划");
      lines.push("");
      const r = this.runState.reports["investment_plan"];
      lines.push(r.content_zh || r.content_en || "");
      lines.push("");
    }

    // ---- TRADER PLAN ---------------------------------------------------
    if (has.trader_plan) {
      lines.push("## 🧾 交易员 · 交易提案");
      lines.push("");
      const r = this.runState.reports["trader_investment_plan"];
      lines.push(r.content_zh || r.content_en || "");
      lines.push("");
    }

    // ---- FOOTER --------------------------------------------------------
    lines.push("---");
    lines.push("");
    lines.push("_本报告由 **TradingForge · 智策** 自动生成。教育目的，不构成投资建议。_");
    return lines.join("\n");
  }
}

// =========================================================================
// DecisionsPage — the unified 决策 page.
//
// Replaces the legacy WindowManager (running cockpits) + HistoryPage (saved
// decisions table). Everything lives in one screen:
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ KPI strip · 新建决策 · search · sort · filter chips               │
//   ├──────────────────┬───────────────────────────────────────────────┤
//   │  decisions-list  │  selected DecisionWindow cockpit               │
//   │  (sidebar)       │  + 多周期目标价 + 执行策略                       │
//   └──────────────────┴───────────────────────────────────────────────┘
//
// The list merges live windows (this.windows) with persisted History.cache;
// when the user picks a historical entry that has no live window we lazily
// create one via DecisionWindow.fromHistory and mount it in the main pane.
// =========================================================================
const DecisionsPage = {
  windows: new Map(),    // id → DecisionWindow (live + restored)
  activeId: null,        // currently selected decision id
  filters: {
    rating:     new Set(),
    instrument: new Set(),
    provider:   new Set(),
    depth:      new Set(),
    status:     new Set(),
    stars:      "all",
    pinned:     false,
    favorited:  false,
    dateRange:  "all",
    ticker:     new Set(),   // multi-select whitelist, empty = no filter
  },
  _tickerOpen: false,        // ticker-filter panel open state
  _tickerInited: false,      // whether default "全选" was applied on first watchlist load
  search: "",
  sort:   "time-desc",

  init() {
    this.listEl    = document.getElementById("decisions-list");
    this.emptyEl   = document.getElementById("decisions-list-empty");
    this.mainEl    = document.getElementById("decisions-main");
    this.mainEmpty = document.getElementById("decisions-main-empty");
    this.containerEl = document.getElementById("windows-container");
    this.filtersEl = document.getElementById("decisions-filters");
    this.kpiEl     = document.getElementById("decisions-kpi");
    this.searchEl  = document.getElementById("decisions-search");
    this.sortEl    = document.getElementById("decisions-sort");
    this.tickerWrapEl    = document.getElementById("decisions-ticker-filter");
    this.tickerTriggerEl = document.getElementById("ticker-filter-trigger");
    this.tickerLabelEl   = document.getElementById("ticker-filter-label");
    this.tickerPanelEl   = document.getElementById("ticker-filter-panel");
    this.tickerOptsEl    = document.getElementById("ticker-filter-options");
    if (!this.listEl) return;  // tab not in DOM (older index.html)

    // Same belt-and-suspenders anti-autofill stomp the old History tab used:
    // Chrome will sometimes write an email-shaped value into the search box
    // even with readonly + autocomplete=new-password. Wipe it on focus + a
    // few delays + when the user switches to the decisions tab.
    this._stompAutofill = () => {
      if (this.searchEl && /@/.test(this.searchEl.value || "")) {
        this.searchEl.value = "";
        this.search = "";
        this.render();
      }
    };
    requestAnimationFrame(this._stompAutofill);
    [100, 300, 800, 2000].forEach(ms => setTimeout(this._stompAutofill, ms));
    document.querySelector('nav.tabs button[data-tab="decisions"]')?.addEventListener("click", () => {
      [50, 200].forEach(ms => setTimeout(this._stompAutofill, ms));
    });

    this.searchEl.addEventListener("input", e => {
      this.search = e.target.value.trim().toLowerCase();
      this.render();
    });
    this.sortEl.addEventListener("change", e => { this.sort = e.target.value; this.render(); });
    this._bindTickerFilter();

    document.getElementById("decisions-new-btn").addEventListener("click", () => showDecisionForm(true));
    document.getElementById("decisions-clear-filters").addEventListener("click", () => this.clearFilters());
    document.getElementById("decisions-refresh").addEventListener("click", async () => {
      await History.refresh();
    });
    document.getElementById("decisions-clear-all").addEventListener("click", async () => {
      if (!confirm("确定要清空所有历史决策？此操作无法撤销。")) return;
      if (History._useRemote()) await window.Decisions.deleteAll();
      else localStorage.removeItem(History.LOCAL_KEY);
      await History.refresh();
    });

    this.render();
  },

  clearFilters() {
    this.filters.rating.clear();
    this.filters.instrument.clear();
    this.filters.provider.clear();
    this.filters.depth.clear();
    this.filters.status.clear();
    this.filters.stars = "all";
    this.filters.pinned = false;
    this.filters.favorited = false;
    this.filters.dateRange = "all";
    this.filters.ticker.clear();
    this.search = "";
    if (this.searchEl) this.searchEl.value = "";
    // Re-apply the "全选" default after a full filter reset.
    this._tickerInited = false;
    this._initTickerDefault();
    this.render();
  },

  // ---- mounting ---------------------------------------------------------

  /**
   * Launch a brand new decision: create a DecisionWindow, mount its cockpit
   * into the main pane, start the SSE stream, and select it in the sidebar.
   */
  create(params) {
    const w = new DecisionWindow(params);
    this.windows.set(w.id, w);
    this.containerEl.appendChild(w.dom);
    this.activate(w.id);
    w.start();
    this.render();
    return w;
  },

  /**
   * Mount (or re-activate) the cockpit for a historical decision entry.
   * Idempotent — clicking the same row repeatedly just re-selects.
   */
  openHistorical(entry) {
    if (this.windows.has(entry.id)) { this.activate(entry.id); return; }
    const w = DecisionWindow.fromHistory(entry);
    this.windows.set(w.id, w);
    this.containerEl.appendChild(w.dom);
    this.activate(w.id);
    this.render();
    return w;
  },

  /** Mark a decision active and show its cockpit; hide others. */
  activate(id) {
    this.activeId = id;
    this.windows.forEach((w, wid) => w.dom.classList.toggle("active", wid === id));
    if (this.mainEmpty) this.mainEmpty.style.display = id ? "none" : "";
    this.render();
  },

  /** Tear down a window. */
  close(id) {
    const w = this.windows.get(id);
    if (!w) return;
    if (w.es) w.es.close();
    w.dom.remove();
    this.windows.delete(id);
    if (this.activeId === id) {
      // Pick the next visible item from the list if any, else clear.
      const next = this._itemsForRender()[0];
      if (next) {
        if (this.windows.has(next.id)) this.activate(next.id);
        else this.openHistorical(next);
      } else {
        this.activeId = null;
        if (this.mainEmpty) this.mainEmpty.style.display = "";
      }
    }
    this.render();
  },

  // ---- list building / filter / sort ------------------------------------

  /**
   * Merge live windows + History.cache into one item array. Live windows
   * win on id collisions because they have the freshest runState.
   */
  _allItems() {
    const seen = new Set();
    const out = [];
    this.windows.forEach((w, wid) => {
      const dec = w.runState.finalDecision || {};
      out.push({
        id: wid,
        _window: w,
        ticker: w.params.ticker,
        trade_date: w.params.trade_date,
        rating: dec.rating || null,
        status: w.status,
        startedAt: w.startedAt,
        completedAt: w.completedAt,
        pinned: false,
        user_rating: 0,
        params: w.params,
        llm_provider:    w.params.llm_provider,
        deep_think_llm:  w.params.deep_think_llm,
        quick_think_llm: w.params.quick_think_llm,
        research_depth:  w.params.research_depth,
        mode:            w.params.mode,
      });
      seen.add(wid);
    });
    (History.cache || []).forEach(e => {
      if (seen.has(e.id)) return;
      out.push({ ...e, _window: null });
    });
    return out;
  },

  _instrument(e) {
    return (typeof History !== "undefined") ? History._instrument(e) : "stock";
  },

  _statusOf(e) {
    if (e._window) return e._window.status;
    return e.status || "done";
  },

  _filtered(items) {
    const f = this.filters;
    const now = Date.now();
    return items.filter(e => {
      if (f.rating.size && !f.rating.has(e.rating)) return false;
      if (f.instrument.size && !f.instrument.has(this._instrument(e))) return false;
      if (f.provider.size && !f.provider.has(e.llm_provider)) return false;
      if (f.depth.size && !f.depth.has(String(e.research_depth ?? ""))) return false;
      if (f.status.size && !f.status.has(this._statusOf(e))) return false;
      if (f.pinned && !e.pinned) return false;
      if (f.favorited) {
        if (typeof Favorites === "undefined" || !Favorites.isFavorited("decision", e.id)) return false;
      }
      if (f.stars !== "all") {
        const s = e.user_rating || 0;
        if (f.stars === "rated"   && s === 0) return false;
        if (f.stars === "unrated" && s !== 0) return false;
        if (/^\d+$/.test(f.stars) && s < parseInt(f.stars, 10)) return false;
      }
      if (f.dateRange !== "all") {
        const t = new Date(e.completedAt || e.startedAt || e.createdAt).getTime();
        const days = { "7d": 7, "30d": 30, "90d": 90 }[f.dateRange] || 0;
        if (now - t > days * 86400 * 1000) return false;
      }
      // Ticker filter (whitelist over the watchlist). A decision is hidden
      // only when its ticker is in the watchlist but unchecked here. Decisions
      // for non-watchlist tickers are never filtered out by this control.
      const wlSet = this._watchlistTickerSet();
      const tUpper = String(e.ticker || "").toUpperCase();
      if (wlSet.has(tUpper) && !f.ticker.has(tUpper)) return false;
      if (this.search) {
        const q = this.search;
        const hay = `${e.ticker} ${e.user_note || ""} ${e.llm_provider || ""} ${e.deep_think_llm || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  },

  _sorted(items) {
    const ts = e => new Date(e.completedAt || e.startedAt || e.createdAt || 0).getTime();
    const cmp = {
      "time-desc":  (a, b) => ts(b) - ts(a),
      "time-asc":   (a, b) => ts(a) - ts(b),
      "rating":     (a, b) => (b.user_rating || 0) - (a.user_rating || 0) || ts(b) - ts(a),
      "ticker":     (a, b) => (a.ticker || "").localeCompare(b.ticker || ""),
      "depth-desc": (a, b) => (b.research_depth || 0) - (a.research_depth || 0),
    }[this.sort] || ((a, b) => 0);
    // Always bubble running cockpits to the very top — easier to find what
    // is currently working without scrolling past finished ones.
    const order = s => s === "running" ? 0 : 1;
    return [...items].sort((a, b) => {
      const oa = order(this._statusOf(a)), ob = order(this._statusOf(b));
      if (oa !== ob) return oa - ob;
      return cmp(a, b);
    });
  },

  _itemsForRender() {
    return this._sorted(this._filtered(this._allItems()));
  },

  // ---- rendering --------------------------------------------------------

  render() {
    if (!this.listEl) return;
    this.renderKpi();
    this.renderTickerFilter();
    this.renderFilters();

    const items = this._itemsForRender();
    const total = this._allItems().length;

    if (!total) {
      this.listEl.innerHTML = "";
      this.emptyEl.innerHTML = History._loadError
        ? `<span style="color:var(--danger);">⚠ 加载失败：${escapeHtml(History._loadError)}</span><br><span style="font-size:11px;">检查 Supabase 是否跑过 schema.sql + 所有 migrations。</span>`
        : (History._useRemote()
            ? "云端无记录。点击 ▶ 新建决策 启动第一次分析。"
            : "暂无决策。点击 ▶ 新建决策 启动第一次分析。");
      this.updateNavBadge(0);
      return;
    }
    if (!items.length) {
      this.listEl.innerHTML = "";
      this.emptyEl.innerHTML = `<span class="muted">在 ${total} 条记录里没有匹配筛选条件的项。</span>`;
      this.updateNavBadge(total);
      return;
    }
    this.emptyEl.innerHTML = "";

    this.listEl.innerHTML = items.map(e => this._renderRow(e)).join("");
    this.listEl.querySelectorAll("li.decisions-row").forEach(li => {
      li.addEventListener("click", ev => {
        if (ev.target.closest("[data-act]") || ev.target.closest(".stars-rate")) return;
        const id = li.dataset.id;
        this._openItem(id);
      });
    });

    // Per-row action buttons (pin / fav / del)
    this.listEl.querySelectorAll("[data-act]").forEach(b => {
      b.addEventListener("click", async ev => {
        ev.stopPropagation();
        const id = b.closest("li").dataset.id;
        const entry = items.find(x => x.id === id);
        if (!entry) return;
        switch (b.dataset.act) {
          case "pin":
            await History.setPinned(id, !entry.pinned);
            break;
          case "fav":
            if (typeof Favorites === "undefined") return;
            await Favorites.toggle("decision", id, {
              ticker: entry.ticker, trade_date: entry.trade_date, rating: entry.rating,
            });
            this.render();
            break;
          case "del":
            if (!confirm(`确定删除 ${entry.ticker} @ ${entry.trade_date} 的决策？`)) return;
            // If it's a live window, close it first; if it's also in history, remove.
            if (this.windows.has(id)) this.close(id);
            await History.delete(id);
            break;
        }
      });
    });
    // Inline 5-star rate
    this.listEl.querySelectorAll(".stars-rate").forEach(group => {
      const stars = group.querySelectorAll(".star");
      stars.forEach((s, i) => {
        s.addEventListener("click", async ev => {
          ev.stopPropagation();
          const id = group.closest("li").dataset.id;
          const cur = items.find(e => e.id === id)?.user_rating || 0;
          const next = cur === i + 1 ? 0 : i + 1;
          await History.setRating(id, next);
        });
      });
    });
    this.updateNavBadge(total);

    // Keep the main pane in sync: if active is still in the list, keep it
    // selected and visible. If not, show the empty hint.
    if (this.activeId && items.some(x => x.id === this.activeId)) {
      if (this.mainEmpty) this.mainEmpty.style.display = "none";
      this.windows.forEach((w, wid) => w.dom.classList.toggle("active", wid === this.activeId));
    } else {
      if (this.mainEmpty) this.mainEmpty.style.display = "";
    }
  },

  _renderRow(e) {
    const status = this._statusOf(e);
    const statusCls = { running: "running", done: "done", restored: "restored", error: "error", cancelled: "cancelled" }[status] || "done";
    const ratingPill = e.rating
      ? `<span class="rating-pill ${e.rating}">${escapeHtml(e.rating)}</span>`
      : `<span class="rating-pill">${status === "running" ? "运行中" : "—"}</span>`;
    const ts = e.completedAt || e.startedAt;
    const tsTxt = ts ? new Date(ts).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const isFav = (typeof Favorites !== "undefined") && Favorites.isFavorited("decision", e.id);
    const userRating = e.user_rating || 0;
    const starsRate = `<span class="stars-rate">${
      [1,2,3,4,5].map(n => `<span class="star ${userRating >= n ? "on" : ""}">★</span>`).join("")
    }</span>`;
    const isActive = e.id === this.activeId;
    const llmBadge = e.llm_provider ? `<span class="badge">${escapeHtml(e.llm_provider)}</span>` : "";
    return `
      <li class="decisions-row ${statusCls} ${e.pinned ? "pinned" : ""} ${isActive ? "selected" : ""}" data-id="${e.id}">
        <div class="row-head">
          <span class="status-dot"></span>
          <span class="row-ticker">${escapeHtml(e.ticker || "")}</span>
          ${ratingPill}
          <span class="row-actions">
            <button data-act="pin" title="${e.pinned ? "取消置顶" : "置顶"}" class="${e.pinned ? "on" : ""}">${e.pinned ? "📌" : "📍"}</button>
            <button data-act="fav" title="${isFav ? "取消收藏" : "收藏"}" class="${isFav ? "on" : ""}">${isFav ? "★" : "☆"}</button>
            <button data-act="del" title="删除">🗑</button>
          </span>
        </div>
        <div class="row-meta">
          <span class="row-date">${escapeHtml(e.trade_date || "")}</span>
          ${llmBadge}
          ${e.research_depth ? `<span class="muted">${e.research_depth} 轮</span>` : ""}
          <span class="row-when muted">${tsTxt}</span>
        </div>
        <div class="row-foot">${starsRate}</div>
      </li>`;
  },

  /** Activate a row: reuse existing window or build from history entry. */
  async _openItem(id) {
    if (this.windows.has(id)) {
      this.activate(id);
      return;
    }
    // Need to fetch full entry (with runState) to restore the cockpit
    const entry = await History.getEntry(id);
    if (entry) this.openHistorical(entry);
  },

  /**
   * Bind events for the multi-select "标的" filter widget. Called once from
   * init(); the render layer (renderTickerFilter) only repaints option rows.
   */
  /**
   * Bind events for the multi-select "标的" filter widget. Only the
   * trigger toggle + outside-click + Esc are bound here; row + 全选 row
   * handlers are re-bound on every render inside _paintTickerOptions
   * because the option DOM is innerHTML-replaced.
   */
  /**
   * The widget root is a native <details> element — the browser handles
   * open/close when the user clicks the <summary>. We just:
   *  - mirror the open state into `_tickerOpen` via the "toggle" event,
   *  - close on outside-click and Esc,
   *  - stop clicks inside the panel from bubbling to body (so the page's
   *    other listeners don't accidentally close us).
   */
  _bindTickerFilter() {
    if (!this.tickerWrapEl) return;
    this.tickerWrapEl.addEventListener("toggle", () => {
      this._tickerOpen = !!this.tickerWrapEl.open;
    });
    this.tickerPanelEl?.addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", e => {
      if (!this.tickerWrapEl.open) return;
      if (!this.tickerWrapEl.contains(e.target)) this.tickerWrapEl.open = false;
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && this.tickerWrapEl.open) this.tickerWrapEl.open = false;
    });
  },

  _watchlistTickerSet() {
    const wlRows = (typeof Watchlist !== "undefined" && Array.isArray(Watchlist.cache)) ? Watchlist.cache : [];
    const s = new Set();
    wlRows.forEach(r => {
      const t = String(r.ticker || "").toUpperCase();
      if (t) s.add(t);
    });
    return s;
  },

  // Legacy shim — the <details> element handles its own open state now. Kept
  // because clearFilters() and a few callers in older code paths still call
  // it; safe to remove once we audit every callsite.
  _applyTickerOpenState() {
    if (!this.tickerWrapEl) return;
    this.tickerWrapEl.open = !!this._tickerOpen;
  },

  /**
   * One-shot initializer: when the watchlist first becomes non-empty,
   * pre-populate `filters.ticker` with every watchlist ticker so the
   * default visual state is "全部选中" (all checkboxes checked).
   */
  _initTickerDefault() {
    if (this._tickerInited) return;
    const wlRows = (typeof Watchlist !== "undefined" && Array.isArray(Watchlist.cache)) ? Watchlist.cache : [];
    if (!wlRows.length) return;       // wait until watchlist is loaded
    wlRows.forEach(r => {
      const t = String(r.ticker || "").toUpperCase();
      if (t) this.filters.ticker.add(t);
    });
    this._tickerInited = true;
  },

  /**
   * Render the "标的" multi-select widget: trigger label + 全选 row +
   * checkbox list. Watchlist tickers come first (with display names),
   * then any extra tickers that appear in history but aren't watchlisted.
   */
  renderTickerFilter() {
    if (!this.tickerOptsEl) return;
    this._initTickerDefault();

    const items = this._allItems();
    const historyCounts = new Map();
    items.forEach(e => {
      const t = String(e.ticker || "").toUpperCase();
      if (!t) return;
      historyCounts.set(t, (historyCounts.get(t) || 0) + 1);
    });

    const wlRows = (typeof Watchlist !== "undefined" && Array.isArray(Watchlist.cache)) ? Watchlist.cache : [];
    const wlSeen = new Set();
    const wlOpts = [];
    wlRows.forEach(r => {
      const t = String(r.ticker || "").toUpperCase();
      if (!t || wlSeen.has(t)) return;
      wlSeen.add(t);
      wlOpts.push({
        ticker: t,
        name: r.display_name || r.name || "",
        count: historyCounts.get(t) || 0,
      });
    });
    // Per spec: dropdown shows the 自选 list only. Decisions for tickers
    // outside the watchlist are NOT filtered out — they always pass through.
    this._tickerAllOpts = { wl: wlOpts, extra: [] };
    this._paintTickerOptions();
    this._paintTickerLabel();
  },

  _paintTickerLabel() {
    if (!this.tickerLabelEl) return;
    const sel = this.filters.ticker;
    const total = ((this._tickerAllOpts?.wl?.length) || 0) + ((this._tickerAllOpts?.extra?.length) || 0);
    if (!sel.size) {
      this.tickerLabelEl.textContent = "全部标的（未选）";
      this.tickerWrapEl?.classList.remove("has-selection");
      return;
    }
    if (sel.size === total && total > 0) {
      this.tickerLabelEl.textContent = `全部标的（${total}）`;
      this.tickerWrapEl?.classList.remove("has-selection");
      return;
    }
    const arr = [...sel];
    this.tickerWrapEl?.classList.add("has-selection");
    if (arr.length <= 2) this.tickerLabelEl.textContent = arr.join("、");
    else this.tickerLabelEl.textContent = `已选 ${arr.length} 个标的`;
  },

  _paintTickerOptions() {
    if (!this.tickerOptsEl || !this._tickerAllOpts) return;
    const { wl, extra } = this._tickerAllOpts;
    const sel = this.filters.ticker;
    const total = wl.length + extra.length;
    const allChecked = total > 0 && sel.size === total &&
      [...wl, ...extra].every(o => sel.has(o.ticker));

    const row = o => {
      const checked = sel.has(o.ticker);
      const sub = o.name ? `<span class="ticker-row-name">${escapeHtml(o.name)}</span>` : "";
      const meta = o.count
        ? `<span class="ticker-row-count">${o.count}</span>`
        : `<span class="ticker-row-count muted-count">0</span>`;
      return `
        <div class="ticker-row ${checked ? "checked" : ""}" data-ticker="${escapeHtml(o.ticker)}" role="option" aria-selected="${checked}">
          <span class="ticker-row-check ${checked ? "checked" : ""}" aria-hidden="true">${checked ? "✓" : ""}</span>
          <span class="ticker-row-tick">${escapeHtml(o.ticker)}</span>
          ${sub}
          ${meta}
        </div>`;
    };

    const parts = [];
    // "全选" toggle row — always at top of the panel.
    parts.push(`
      <div class="ticker-row ticker-row-all ${allChecked ? "checked" : ""}" data-act="toggle-all" role="option" aria-selected="${allChecked}">
        <span class="ticker-row-check ${allChecked ? "checked" : ""}" aria-hidden="true">${allChecked ? "✓" : ""}</span>
        <span class="ticker-row-tick">全选</span>
        <span class="ticker-row-count">${total}</span>
      </div>`);

    if (wl.length) {
      parts.push(`<div class="ticker-group-label">⭐ 自选</div>`);
      wl.forEach(o => parts.push(row(o)));
    }
    if (extra.length) {
      parts.push(`<div class="ticker-group-label">历史决策（未加自选）</div>`);
      extra.forEach(o => parts.push(row(o)));
    }
    if (!wl.length && !extra.length) {
      parts.push(`<div class="ticker-empty">自选列表为空。先在"自选"页加入标的，再来这里筛选。</div>`);
    }
    this.tickerOptsEl.innerHTML = parts.join("");

    // Re-bind row click handlers after innerHTML replacement.
    this.tickerOptsEl.querySelectorAll(".ticker-row").forEach(el => {
      el.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        if (el.dataset.act === "toggle-all") {
          // Toggle: if all checked → clear; otherwise → select all.
          const everyT = [...this._tickerAllOpts.wl, ...this._tickerAllOpts.extra].map(o => o.ticker);
          const isAll = everyT.length > 0 && everyT.every(t => this.filters.ticker.has(t));
          if (isAll) this.filters.ticker.clear();
          else everyT.forEach(t => this.filters.ticker.add(t));
        } else {
          const t = el.dataset.ticker;
          if (this.filters.ticker.has(t)) this.filters.ticker.delete(t);
          else this.filters.ticker.add(t);
        }
        this.render();
      });
    });
  },

  renderKpi() {
    if (!this.kpiEl) return;
    const items = this._allItems();
    const now = Date.now();
    const running  = items.filter(e => this._statusOf(e) === "running").length;
    const today    = items.filter(e => (e.completedAt || e.startedAt) && (now - new Date(e.completedAt || e.startedAt).getTime()) < 86400 * 1000).length;
    const bullish  = items.filter(e => e.rating === "Buy" || e.rating === "Overweight").length;
    const bearish  = items.filter(e => e.rating === "Sell" || e.rating === "Underweight").length;
    this.kpiEl.innerHTML = `
      <div class="kpi-cell"><div class="kpi-num">${items.length}</div><div class="kpi-label">总数</div></div>
      <div class="kpi-cell"><div class="kpi-num ${running ? "running" : ""}">${running}</div><div class="kpi-label">运行中</div></div>
      <div class="kpi-cell"><div class="kpi-num">${today}</div><div class="kpi-label">24h</div></div>
      <div class="kpi-cell"><div class="kpi-num bull">${bullish}</div><div class="kpi-label">🟢 看多</div></div>
      <div class="kpi-cell"><div class="kpi-num bear">${bearish}</div><div class="kpi-label">🔴 看空</div></div>
    `;
  },

  renderFilters() {
    if (!this.filtersEl) return;
    const f = this.filters;
    const all = this._allItems();
    const chip = (label, active, attrs, count) =>
      `<span class="filter-chip ${active ? "active" : ""}" ${attrs}>${label}${count != null ? `<span class="filter-chip-count">${count}</span>` : ""}</span>`;

    const ratingRow = `
      <div class="filter-group"><span class="filter-group-label">建议</span>
        ${["Buy","Overweight","Hold","Underweight","Sell"].map(r =>
          chip(r, f.rating.has(r), `data-toggle="rating" data-val="${r}"`,
            all.filter(e => e.rating === r).length)
        ).join("")}
      </div>`;

    const statusRow = `
      <div class="filter-group"><span class="filter-group-label">状态</span>
        ${[
          ["running", "🟡 运行中"],
          ["done",    "🟢 已完成"],
          ["restored","🔵 已回看"],
          ["error",   "🔴 失败"],
        ].map(([v, lbl]) =>
          chip(lbl, f.status.has(v), `data-toggle="status" data-val="${v}"`,
            all.filter(e => this._statusOf(e) === v).length)
        ).join("")}
      </div>`;

    const instRow = `
      <div class="filter-group"><span class="filter-group-label">品种</span>
        ${[
          ["stock","📈 股票"],["etf","🧺 ETF"],["crypto","₿ 加密"],
          ["commodity","🛢 商品"],["forex","💱 外汇"],
        ].map(([id, lbl]) =>
          chip(lbl, f.instrument.has(id), `data-toggle="instrument" data-val="${id}"`,
            all.filter(e => this._instrument(e) === id).length)
        ).join("")}
      </div>`;

    const providers = {};
    all.forEach(e => { if (e.llm_provider) providers[e.llm_provider] = (providers[e.llm_provider] || 0) + 1; });
    const provRow = Object.keys(providers).length ? `
      <div class="filter-group"><span class="filter-group-label">LLM</span>
        ${Object.entries(providers).sort((a, b) => b[1] - a[1]).map(([p, n]) =>
          chip(p, f.provider.has(p), `data-toggle="provider" data-val="${p}"`, n)
        ).join("")}
      </div>` : "";

    const dateRow = `
      <div class="filter-group"><span class="filter-group-label">时间</span>
        ${[["all","全部"],["7d","近 7 天"],["30d","近 30 天"],["90d","近 90 天"]].map(([v, lbl]) =>
          chip(lbl, f.dateRange === v, `data-toggle="dateRange" data-val="${v}"`)
        ).join("")}
      </div>`;

    const starsRow = `
      <div class="filter-group"><span class="filter-group-label">评分</span>
        ${[["all","全部"],["5","≥5★"],["4","≥4★"],["3","≥3★"],["rated","有评分"],["unrated","未评分"]].map(([v, lbl]) =>
          chip(lbl, f.stars === v, `data-toggle="stars" data-val="${v}"`)
        ).join("")}
      </div>`;

    const togglesRow = `
      <div class="filter-group"><span class="filter-group-label">其它</span>
        ${chip("📌 仅置顶", f.pinned, `data-toggle="pinned"`)}
        ${chip("⭐ 仅收藏", f.favorited, `data-toggle="favorited"`)}
      </div>`;

    this.filtersEl.innerHTML = ratingRow + statusRow + instRow + provRow + dateRow + starsRow + togglesRow;
    this.filtersEl.querySelectorAll(".filter-chip").forEach(el => {
      el.addEventListener("click", () => {
        const k = el.dataset.toggle;
        const v = el.dataset.val;
        if (k === "stars" || k === "dateRange") this.filters[k] = v;
        else if (k === "pinned" || k === "favorited") this.filters[k] = !this.filters[k];
        else {
          if (this.filters[k].has(v)) this.filters[k].delete(v);
          else this.filters[k].add(v);
        }
        this.render();
      });
    });
  },

  updateNavBadge(n) {
    const b = document.getElementById("decisions-nav-badge");
    if (!b) return;
    if (n > 0) { b.textContent = n; b.style.display = ""; } else b.style.display = "none";
  },
};

// Legacy alias — DecisionWindow.markStatus + renderFinal still bump the
// list via this. Old WindowManager.create / openHistorical call sites
// were updated to DecisionsPage directly, but we keep a thin shim so any
// older callers / extensions don't crash.
const WindowManager = {
  get windows() { return DecisionsPage.windows; },
  create(params)         { return DecisionsPage.create(params); },
  openHistorical(entry)  { return DecisionsPage.openHistorical(entry); },
  activate(id)           { return DecisionsPage.activate(id); },
  close(id)              { return DecisionsPage.close(id); },
  renderTabs()           { DecisionsPage.render(); },
  init() {},
};

// =========================================================================
// History — Supabase when signed in, localStorage fallback otherwise
// =========================================================================
const History = {
  LOCAL_KEY: "tda:history",
  LOCAL_MAX: 200,                   // bumped from 50 — pin/rate makes more entries valuable
  cache: [],

  async init() {
    // No more sidebar UI — History is now a pure data layer for HistoryPage.
    // Keep the auth subscription so we refresh when sign-in state changes.
    if (window.Auth) window.Auth.onChange(() => this.refresh());
    await this.refresh();
  },

  // ---- helpers ----------------------------------------------------------

  _direction(rating) {
    if (!rating) return "hold";
    const r = String(rating).toLowerCase();
    if (r === "buy" || r === "overweight") return "bull";
    if (r === "sell" || r === "underweight") return "bear";
    return "hold";
  },

  _instrument(entry) {
    const t = (entry.ticker || "").toUpperCase();
    if (entry.params?.instrument_hint) return entry.params.instrument_hint;
    if (t.endsWith("-USD") || t.endsWith("USDT") || t.startsWith("BTC") || t.startsWith("ETH")) return "crypto";
    if (/^(SPY|QQQ|DIA|IWM|VTI|VOO|XL[A-Z]|GLD|SLV|TLT|IEF|BND|AGG|HYG|EEM|VEA|VWO)$/.test(t)) return "etf";
    if (/^(GC|SI|CL|NG|HG|ZC|ZW)/.test(t)) return "commodity";
    if (/^[A-Z]{6}=X$|^USD|^EUR|^GBP|^JPY|^CNY/.test(t)) return "forex";
    return "stock";
  },

  _useRemote() {
    return Boolean(window.Decisions && window.Auth && window.Auth.isSignedIn());
  },

  async refresh() {
    this._loadError = null;
    if (this._useRemote()) {
      const { rows, error } = await window.Decisions.list();
      this._loadError = error;
      this.cache = (rows || []).map(r => ({
        id: r.id, ticker: r.ticker, trade_date: r.trade_date,
        rating: r.rating, status: r.status,
        startedAt: r.started_at, completedAt: r.completed_at,
        createdAt: r.created_at,
        pinned: !!r.pinned,
        user_rating: r.user_rating || 0,
        user_note: r.user_note || "",
        // Carry richer params — used by HistoryPage filters / detail drawer.
        params: r.params || {
          instrument_hint: r.instrument_hint,
          llm_provider:    r.llm_provider,
          deep_think_llm:  r.deep_think_llm,
          quick_think_llm: r.quick_think_llm,
          mode:            r.mode,
          output_language: r.output_language,
          research_depth:  r.research_depth,
        },
        // Top-level shortcuts for filtering speed
        llm_provider:    r.llm_provider    || r.params?.llm_provider,
        deep_think_llm:  r.deep_think_llm  || r.params?.deep_think_llm,
        quick_think_llm: r.quick_think_llm || r.params?.quick_think_llm,
        mode:            r.mode            || r.params?.mode,
        output_language: r.output_language || r.params?.output_language,
        research_depth:  r.research_depth  || r.params?.research_depth,
        _remote: true,
      }));
    } else {
      this.cache = this._readLocal().map(e => ({
        ...e,
        // Mirror the same flattened keys for local entries
        llm_provider:    e.params?.llm_provider,
        deep_think_llm:  e.params?.deep_think_llm,
        quick_think_llm: e.params?.quick_think_llm,
        mode:            e.params?.mode,
        output_language: e.params?.output_language,
        research_depth:  e.params?.research_depth,
      }));
    }
    if (typeof DecisionsPage !== "undefined") DecisionsPage.render();
  },

  async setPinned(id, pinned) {
    if (this._useRemote()) {
      await window.Auth.rawClient().from("decisions")
        .update({ pinned }).eq("id", id);
    } else {
      const all = this._readLocal();
      const e = all.find(x => x.id === id);
      if (e) { e.pinned = pinned; localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all)); }
    }
    await this.refresh();
  },

  async setRating(id, rating) {
    if (this._useRemote()) {
      await window.Auth.rawClient().from("decisions")
        .update({ user_rating: rating }).eq("id", id);
    } else {
      const all = this._readLocal();
      const e = all.find(x => x.id === id);
      if (e) { e.user_rating = rating; localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all)); }
    }
    await this.refresh();
  },

  _readLocal() {
    try { return JSON.parse(localStorage.getItem(this.LOCAL_KEY) || "[]"); }
    catch { return []; }
  },

  /**
   * Returns the full entry (with runState) by id. Local entries already have
   * everything; remote ones lazy-fetch run_state from Supabase.
   */
  async getEntry(id) {
    const stub = this.cache.find(e => e.id === id);
    if (!stub) return null;
    if (!stub._remote) return stub;  // local has full payload
    const row = await window.Decisions.get(id);
    if (!row) return null;
    return {
      id: row.id, ticker: row.ticker, trade_date: row.trade_date,
      rating: row.rating, status: row.status,
      startedAt: row.started_at, completedAt: row.completed_at,
      params: row.params, runState: row.run_state,
    };
  },

  async save(window_) {
    // Preserve any pin/rating already attached to an existing entry
    const existing = this.cache.find(e => e.id === window_.id) || {};
    const entry = {
      id: window_.id,
      ticker: window_.params.ticker,
      trade_date: window_.params.trade_date,
      rating: window_.runState.finalDecision?.rating || null,
      status: window_.status,
      startedAt: window_.startedAt,
      completedAt: window_.completedAt || new Date().toISOString(),
      pinned: existing.pinned || false,
      user_rating: existing.user_rating || 0,
      user_note: existing.user_note || "",
      params: window_.params,
      runState: window_.runState,
    };
    if (this._useRemote()) {
      await window.Decisions.upsert(entry);
    } else {
      const all = this._readLocal();
      const idx = all.findIndex(e => e.id === entry.id);
      if (idx >= 0) all[idx] = entry; else all.unshift(entry);
      const trimmed = all.slice(0, this.LOCAL_MAX);
      try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(trimmed)); }
      catch (e) {
        console.warn("history quota — pruning");
        try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(trimmed.slice(0, Math.floor(this.LOCAL_MAX / 2)))); }
        catch (e2) { console.error("history save failed:", e2); }
      }
    }
    await this.refresh();
  },

  async delete(id) {
    if (this._useRemote()) {
      await window.Decisions.delete(id);
    } else {
      const all = this._readLocal().filter(e => e.id !== id);
      localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all));
    }
    await this.refresh();
  },

  // History.render() is intentionally a no-op now: the dedicated 历史 tab
  // owns all rendering via HistoryPage. History.refresh() still calls
  // HistoryPage.render() so both layers stay in sync.
  render() {},
};
// Expose for cross-script access (comprehensive.js) — bare `History`
// otherwise collides with the browser's window.History global.
window._appHistory = History;

// =========================================================================
// Auth UI — login / signup / magic-link modal
// =========================================================================
const AuthUI = {
  mode: "signin",
  init() {
    this.modal = document.getElementById("auth-modal");
    this.titleEl = document.getElementById("auth-title");
    this.errEl = document.getElementById("auth-error");
    this.hintEl = document.getElementById("auth-hint");
    this.pwdField = document.querySelector(".auth-pwd-field");
    this.nameField = document.querySelector(".auth-name-field");
    this.submitBtn = document.getElementById("auth-submit");
    this.statusEl = document.getElementById("auth-status");
    this.btnEl = document.getElementById("auth-button");

    this.btnEl.addEventListener("click", () => this.toggle());
    document.getElementById("auth-close").addEventListener("click", () => this.close());
    this.modal.addEventListener("click", e => { if (e.target === this.modal) this.close(); });
    document.querySelectorAll(".auth-tab").forEach(t => {
      t.addEventListener("click", () => this.setMode(t.dataset.mode));
    });
    document.getElementById("auth-form").addEventListener("submit", e => { e.preventDefault(); this.submit(); });
    this.submitBtn.addEventListener("click", e => { e.preventDefault(); this.submit(); });

    // Reflect current auth state immediately + on changes
    if (window.Auth) {
      window.Auth.onChange(() => this.renderStatus());
    }
    this.renderStatus();
  },

  renderStatus() {
    const auth = window.Auth;
    if (!auth || !auth.isConfigured()) {
      this.btnEl.style.display = "none";
      this.statusEl.style.display = "inline";
      this.statusEl.innerHTML = `<span class="muted">本地模式 · 历史保存于浏览器</span>`;
      return;
    }
    if (auth.isSignedIn()) {
      const u = auth.user();
      const name = u?.user_metadata?.display_name || u?.email || "user";
      this.btnEl.textContent = "退出登录";
      this.btnEl.title = u?.email || "";
      this.statusEl.style.display = "inline";
      this.statusEl.innerHTML = `<span class="name">👤 ${escapeHtml(name)}</span>`;
    } else {
      this.btnEl.textContent = "👤 登录";
      this.btnEl.title = "登录 / 注册";
      this.statusEl.style.display = "none";
    }
  },

  toggle() {
    const auth = window.Auth;
    if (!auth || !auth.isConfigured()) return;
    if (auth.isSignedIn()) {
      auth.signOut();
      return;
    }
    this.open();
  },

  open() { this.modal.style.display = "flex"; this.errEl.textContent = ""; this.hintEl.textContent = ""; document.getElementById("auth-email").focus(); },
  close() { this.modal.style.display = "none"; },

  setMode(mode) {
    this.mode = mode;
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
    this.titleEl.textContent = ({ signin: "登录", signup: "注册", magic: "魔法链接登录" })[mode];
    this.submitBtn.textContent = ({ signin: "登录", signup: "创建账户", magic: "发送链接" })[mode];
    this.pwdField.style.display = mode === "magic" ? "none" : "flex";
    this.nameField.style.display = mode === "signup" ? "flex" : "none";
    this.errEl.textContent = "";
    this.hintEl.textContent = mode === "magic"
      ? "我们会发送一封含登录链接的邮件，无需记忆密码。"
      : "";
  },

  async submit() {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const displayName = document.getElementById("auth-display-name").value.trim();
    if (!email) { this.errEl.textContent = "请输入邮箱"; return; }
    if (this.mode !== "magic" && password.length < 6) { this.errEl.textContent = "密码至少 6 位"; return; }
    this.submitBtn.disabled = true;
    this.errEl.textContent = "";
    try {
      if (this.mode === "signin") {
        await window.Auth.signIn(email, password);
        this.hintEl.textContent = "登录成功。";
        setTimeout(() => this.close(), 600);
      } else if (this.mode === "signup") {
        await window.Auth.signUp(email, password, displayName);
        this.hintEl.textContent = "注册成功。请检查邮箱以确认账户（若已禁用邮箱确认则可直接登录）。";
      } else if (this.mode === "magic") {
        await window.Auth.signInWithMagicLink(email);
        this.hintEl.textContent = "登录链接已发送，请检查邮箱。";
      }
    } catch (e) {
      this.errEl.textContent = e.message || String(e);
    } finally {
      this.submitBtn.disabled = false;
    }
  },
};

// =========================================================================
// Opportunities — 24h trading-opportunity feed
// =========================================================================
const Opportunities = {
  pollInterval: 30000,
  cache: [],
  filterSev: "all",
  filterCat: "all",
  filterTrend: "all",
  _timer: null,

  // Backend tags every opportunity with one of these categories. Map keeps
  // emoji + zh label in one place so the KPI strip + cards stay consistent.
  CAT_META: {
    macro:    { icon: "🌐", zh: "宏观" },
    news:     { icon: "📰", zh: "自选新闻" },
    earnings: { icon: "📅", zh: "财报" },
    signal:   { icon: "📈", zh: "技术信号" },
    crypto:   { icon: "₿",  zh: "加密" },
    other:    { icon: "▫️", zh: "其它" },
  },
  TREND_META: {
    bullish: { icon: "🟢", zh: "看多", cls: "bullish" },
    bearish: { icon: "🔴", zh: "看空", cls: "bearish" },
    neutral: { icon: "⚪", zh: "中性", cls: "neutral" },
  },

  init() {
    this.listEl = document.getElementById("opps-list");
    this.statusEl = document.getElementById("opps-status");
    this.kpiEl = document.getElementById("opps-kpi");
    this.navBadgeEl = document.getElementById("opps-nav-badge");

    document.getElementById("opps-refresh").addEventListener("click", () => this.refresh());

    const bindFilter = (attr, key) => {
      document.querySelectorAll(`[data-${attr}]`).forEach(b => {
        b.addEventListener("click", () => {
          document.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.remove("active"));
          b.classList.add("active");
          this[key] = b.dataset[attr.replace(/-./g, m => m[1].toUpperCase())];
          this.render();
        });
      });
    };
    bindFilter("opps-sev",   "filterSev");
    bindFilter("opps-cat",   "filterCat");
    bindFilter("opps-trend", "filterTrend");

    this.refresh();
    this._timer = setInterval(() => this.refresh(), this.pollInterval);
  },

  // Instrument inference from ticker/type — kept on the frontend so we don't
  // need to backfill the backend payload for already-emitted opportunities.
  inferInstrument(opp) {
    const t = (opp.ticker || "").toUpperCase();
    const ty = (opp.type || "").toLowerCase();
    if (!t) return ty.includes("macro") ? "macro" : "macro";
    if (t.endsWith("-USD") || t.endsWith("USDT") || t.startsWith("BTC") || t.startsWith("ETH"))
      return "crypto";
    if (/^(SPY|QQQ|DIA|IWM|VTI|VOO|XL[A-Z]|GLD|SLV|TLT|IEF|BND|AGG|HYG|EEM|VEA|VWO)$/.test(t))
      return "etf";
    if (/^(GC|SI|CL|NG|HG|ZC|ZW)/.test(t)) return "commodity";
    if (/^[A-Z]{6}=X$|^USD|^EUR|^GBP|^JPY|^CNY/.test(t)) return "forex";
    return "stock";
  },

  async refresh() {
    try {
      const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
      const r = await fetch(`${apiBase}/api/opportunities?limit=50`);
      if (!r.ok) throw new Error(`opps ${r.status}`);
      const j = await r.json();
      const newCount = (j.items || []).length;
      const seenBefore = this.cache.length;
      this.cache = j.items || [];
      this.render();
      if (this.statusEl) this.statusEl.textContent = `共 ${newCount} 条 · 更新于 ${new Date().toLocaleTimeString()}`;
      // Show a red badge in nav when there are unseen high/critical items
      const urgent = this.cache.filter(o => o.severity === "high" || o.severity === "critical").length;
      if (this.navBadgeEl) {
        this.navBadgeEl.style.display = urgent > 0 ? "inline-block" : "none";
        this.navBadgeEl.textContent = urgent;
      }
    } catch (e) {
      if (this.statusEl) this.statusEl.textContent = `获取失败：${e.message}`;
    }
  },

  // Backward-compatible category derivation: prefer backend `category` if
  // present (v2.5+ detectors), else infer from the legacy `type` string.
  _categoryOf(opp) {
    if (opp.category) return opp.category;
    const ty = (opp.type || "").toLowerCase();
    if (ty.startsWith("macro_")) return "macro";
    if (ty.includes("earnings")) return "earnings";
    if (ty.includes("news"))     return "news";
    if (ty.includes("crypto") || ty === "btc_wick" || ty === "market_pulse") return "crypto";
    if (ty.includes("rsi") || ty.includes("cross") || ty.includes("momentum")) return "signal";
    return "other";
  },

  _trendOf(opp) {
    return opp.trend || "neutral";
  },

  renderKpi() {
    if (!this.kpiEl) return;
    const counts = { macro: 0, news: 0, earnings: 0, signal: 0, crypto: 0 };
    this.cache.forEach(o => {
      const c = this._categoryOf(o);
      if (counts[c] != null) counts[c]++;
    });
    const cells = Object.entries(counts).map(([cat, n]) => {
      const m = this.CAT_META[cat] || this.CAT_META.other;
      return `<div class="opps-kpi-cell ${n ? "" : "empty"}" data-go-cat="${cat}">
        <div class="num">${n}</div>
        <div class="lbl">${m.icon} ${m.zh}</div>
      </div>`;
    }).join("");
    this.kpiEl.innerHTML = cells;
    this.kpiEl.querySelectorAll("[data-go-cat]").forEach(el => {
      el.addEventListener("click", () => {
        const cat = el.dataset.goCat;
        document.querySelectorAll("[data-opps-cat]").forEach(b => {
          b.classList.toggle("active", b.dataset.oppsCat === cat);
        });
        this.filterCat = cat;
        this.render();
      });
    });
  },

  render() {
    this.renderKpi();
    let filtered = this.cache;
    if (this.filterSev   !== "all") filtered = filtered.filter(o => o.severity === this.filterSev);
    if (this.filterCat   !== "all") filtered = filtered.filter(o => this._categoryOf(o) === this.filterCat);
    if (this.filterTrend !== "all") filtered = filtered.filter(o => this._trendOf(o) === this.filterTrend);
    if (!filtered.length) {
      this.listEl.innerHTML = `<div class="muted" style="padding:32px; text-align:center;">该过滤条件下暂无机会。</div>`;
      return;
    }
    const sevEmoji = { critical: "🔴", high: "🟠", watch: "🟡", info: "⚪" };
    const stratNameById = (id) => (typeof STRATEGIES !== "undefined" && STRATEGIES.find(s => s.id === id)?.name) || id;

    this.listEl.innerHTML = filtered.map(o => {
      const ts = new Date(o.created_at);
      const ago = (Date.now() - ts.getTime()) / 60000;
      const agoStr = ago < 1 ? "刚刚" : ago < 60  ? `${Math.round(ago)}m 前` : `${Math.round(ago/60)}h 前`;
      const isFav = (typeof Favorites !== "undefined") && Favorites.isFavorited("opportunity", o.id);
      const cat = this._categoryOf(o);
      const catMeta = this.CAT_META[cat] || this.CAT_META.other;
      const trend = this._trendOf(o);
      const trendMeta = this.TREND_META[trend] || this.TREND_META.neutral;
      const urlBtn = o.url ? `<a class="opp-link" href="${escapeHtml(o.url)}" target="_blank" rel="noopener">来源 ↗</a>` : "";
      return `
        <div class="opp-card severity-${o.severity} cat-${cat} trend-${trendMeta.cls}">
          <div class="severity"></div>
          <div class="info">
            <div class="row1">
              <span class="cat-badge" title="类别">${catMeta.icon} ${catMeta.zh}</span>
              <span class="trend-pill ${trendMeta.cls}" title="趋势判断">${trendMeta.icon} ${trendMeta.zh}</span>
              <span class="sev-pill" title="重要度: ${o.severity}">${sevEmoji[o.severity] || "⚪"} ${o.severity}</span>
              ${o.ticker ? `<span class="ticker">${escapeHtml(o.ticker)}</span>` : ""}
              <span class="ts">${agoStr}</span>
            </div>
            <div class="headline">${escapeHtml(o.headline)}</div>
            ${o.body ? `<div class="body">${escapeHtml(o.body)}</div>` : ""}
            ${o.strategy_note ? `
              <div class="strategy-note">
                <span class="muted" style="font-size:11px;">💡 策略建议：</span>
                <span>${escapeHtml(o.strategy_note)}</span>
              </div>` : ""}
            ${(o.suggested_strategies && o.suggested_strategies.length) ? `
              <div class="strats">
                <span class="muted" style="font-size:11px;">推荐策略:</span>
                ${o.suggested_strategies.map(sid => `<span class="strat" data-strategy-id="${sid}">${escapeHtml(stratNameById(sid))}</span>`).join("")}
              </div>` : ""}
            ${urlBtn ? `<div class="opp-link-row">${urlBtn}</div>` : ""}
          </div>
          <div class="actions">
            <button class="star ${isFav ? "on" : ""}" data-opp-fav="${o.id}" title="收藏">${isFav ? "★" : "☆"}</button>
          </div>
        </div>
      `;
    }).join("");

    // strategy chip → jump to library tab
    this.listEl.querySelectorAll(".strat").forEach(el => {
      el.addEventListener("click", () => {
        document.querySelector('nav.tabs button[data-tab="library"]').click();
        setTimeout(() => {
          const card = document.querySelector(`.strategy-card[data-id="${el.dataset.strategyId}"]`);
          if (card) {
            card.scrollIntoView({ block: "center" });
            card.classList.add("expanded");
          }
        }, 100);
      });
    });
    // star → toggle favorite
    this.listEl.querySelectorAll("[data-opp-fav]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const oppId = btn.dataset.oppFav;
        const opp = this.cache.find(o => o.id === oppId);
        Favorites.toggle("opportunity", oppId, opp ? {
          headline: opp.headline, ticker: opp.ticker, severity: opp.severity, type: opp.type,
        } : {});
        this.render();
      });
    });
  },
};

// =========================================================================
// Watchlist — main entry point. Lists tracked tickers with live quotes,
// auto-grouped by market, expandable to show recent decisions per ticker.
// =========================================================================
const Watchlist = {
  LOCAL_KEY: "tda:watchlist",
  cache: [],          // [{id, ticker, display_name, market, custom_group, ...}]
  quotes: {},         // ticker → quote dict
  activeGroup: "all",
  selectedId: null,   // which asset is shown in the main panel
  _loadError: null,
  _decisionFullCache: {},  // id → full entry (with runState) loaded on demand

  MARKETS: [
    { id: "all",       label: "全部" },
    { id: "us",        label: "美股" },
    { id: "hk",        label: "港股" },
    { id: "cn",        label: "A 股" },
    { id: "crypto",    label: "加密" },
    { id: "commodity", label: "期货 / 商品" },
    { id: "forex",     label: "外汇" },
    { id: "other",     label: "其他" },
  ],

  init() {
    this.listEl    = document.getElementById("watchlist-list");
    this.emptyEl   = document.getElementById("watchlist-empty");
    this.groupsEl  = document.getElementById("watchlist-groups");
    this.updatedEl = document.getElementById("watchlist-updated");
    this.mainEl    = document.getElementById("watchlist-main");
    this.mainEmpty = document.getElementById("watchlist-main-empty");
    if (!this.listEl) return;

    document.getElementById("watchlist-refresh").addEventListener("click", () => this.refresh(true));
    document.getElementById("watchlist-add-btn").addEventListener("click", () => this._toggleAddForm(true));
    document.getElementById("watchlist-add-cancel").addEventListener("click", () => this._toggleAddForm(false));
    document.getElementById("watchlist-add-submit").addEventListener("click", () => this._submitAdd());
    this._wireSymbolSearch();
    document.getElementById("watchlist-import-history").addEventListener("click", () => this.importFromHistory());

    // Collapse / expand the whole watchlist sidebar so the selected ticker's
    // detail pane can use the full page width. The 收起 button lives in the
    // sidebar toolbar (hidden when collapsed); a slim rail button re-expands.
    this.shellEl = document.querySelector(".watchlist-shell");
    this.collapseBtn = document.getElementById("watchlist-collapse-btn");
    this.expandBtn = document.getElementById("watchlist-expand-btn");
    if (this.collapseBtn) this.collapseBtn.addEventListener("click", () => this.toggleSidebar(true));
    if (this.expandBtn)   this.expandBtn.addEventListener("click", () => this.toggleSidebar(false));
    this._applySidebarPref();

    if (window.Auth) window.Auth.onChange(() => this.refresh(true));
    this.refresh(true);
    // Auto-refresh quotes every 60s while page is active
    this._timer = setInterval(() => {
      if (document.getElementById("watchlist")?.classList.contains("active")) {
        this._fetchQuotes();
      }
    }, 60000);

    // Deep-link routing — Router fires `wl-route-changed` on initial paint
    // and on browser back/forward. We honor it by selecting the matching
    // ticker (and deferring the version selection to ComprehensiveReport).
    window.addEventListener("wl-route-changed", (ev) => {
      const detail = ev.detail || {};
      this._applyRoute(detail.ticker, detail.reportId);
    });
  },

  /** Apply a URL-derived route ({ticker, reportId}) to the current view. */
  _applyRoute(ticker, reportId) {
    if (!ticker) return;
    const target = (ticker || "").toUpperCase();
    const tryApply = () => {
      const entry = (this.cache || []).find(e => (e.ticker || "").toUpperCase() === target);
      if (!entry) return false;
      this.selectedId = entry.id;
      this.render();
      // Defer version selection until comp-report state is ready.
      if (reportId && window.ComprehensiveReport && window.ComprehensiveReport.selectVersion) {
        setTimeout(() => window.ComprehensiveReport.selectVersion(target, reportId), 50);
      }
      return true;
    };
    if (tryApply()) return;
    // Watchlist may not have loaded yet — wait one tick.
    setTimeout(tryApply, 200);
    setTimeout(tryApply, 800);
  },

  // ---- sidebar collapse (give the detail pane the full width) -------------
  SIDEBAR_KEY: "tda:wl-sidebar-hidden",
  _sidebarHidden() {
    try { return localStorage.getItem(this.SIDEBAR_KEY) === "1"; }
    catch { return false; }
  },
  _paintCollapseBtn(hidden) {
    // Both controls advertise the same expanded/collapsed state for a11y; the
    // 收起 button is static text (CSS hides it when collapsed) and the rail
    // button is the static ▶ re-expand affordance.
    if (this.collapseBtn) this.collapseBtn.setAttribute("aria-expanded", String(!hidden));
    if (this.expandBtn)   this.expandBtn.setAttribute("aria-expanded", String(!hidden));
  },
  _applySidebarPref() {
    const hidden = this._sidebarHidden();
    if (this.shellEl) this.shellEl.classList.toggle("sidebar-hidden", hidden);
    this._paintCollapseBtn(hidden);
  },
  /** Toggle (or force) the collapsed state of the watchlist sidebar. Persists
   *  in localStorage so the choice survives reloads. */
  toggleSidebar(force) {
    const hidden = (force != null) ? !!force : !this._sidebarHidden();
    try { localStorage.setItem(this.SIDEBAR_KEY, hidden ? "1" : "0"); } catch (e) { /* non-fatal */ }
    if (this.shellEl) this.shellEl.classList.toggle("sidebar-hidden", hidden);
    this._paintCollapseBtn(hidden);
  },

  _toggleAddForm(show) {
    const f = document.getElementById("watchlist-add-form");
    f.style.display = show ? "" : "none";
    if (show) setTimeout(() => document.getElementById("watchlist-add-ticker").focus(), 50);
    else {
      document.getElementById("watchlist-add-ticker").value = "";
      document.getElementById("watchlist-add-name").value = "";
      document.getElementById("watchlist-add-group").value = "";
      // Reset autocomplete state so the next open starts clean.
      this._selectedSymbol = null;
      const sug = document.getElementById("watchlist-add-suggest");
      if (sug) { sug.hidden = true; sug.innerHTML = ""; }
      const sel = document.getElementById("watchlist-add-selected");
      if (sel) { sel.hidden = true; sel.innerHTML = ""; }
    }
  },

  // -----------------------------------------------------------------
  // Symbol-search autocomplete (2026-05-22)
  //
  // Solves the "BTC means crypto OR US ETF" disambiguation problem by
  // asking the backend /api/symbol-search for candidates as the user
  // types. The selected row's canonical symbol (e.g. "BTC-USD" vs
  // "BTC") is what we write to the watchlist — so the existing
  // unique (user_id, ticker) constraint naturally separates them.
  // -----------------------------------------------------------------

  // Holds the currently-picked symbol from the autocomplete dropdown.
  // Null means "fall back to literal input + _detectMarket on submit".
  _selectedSymbol: null,
  // Debounce token + last-query so we ignore stale fetches that arrive
  // out of order.
  _searchDebounceTimer: null,
  _searchSeq: 0,
  // Keyboard-nav: which suggestion is highlighted (-1 = none).
  _suggestActive: -1,

  /** One-time wiring of the autocomplete input + dropdown. Called from setup(). */
  _wireSymbolSearch() {
    const input = document.getElementById("watchlist-add-ticker");
    const sug = document.getElementById("watchlist-add-suggest");
    if (!input || !sug) return;

    input.addEventListener("input", () => {
      const q = input.value.trim();
      // Any keystroke invalidates the previous "selection chip".
      if (this._selectedSymbol && this._selectedSymbol.symbol !== q.toUpperCase()) {
        this._selectedSymbol = null;
        const selEl = document.getElementById("watchlist-add-selected");
        if (selEl) { selEl.hidden = true; selEl.innerHTML = ""; }
      }
      clearTimeout(this._searchDebounceTimer);
      if (!q) {
        sug.hidden = true; sug.innerHTML = "";
        input.setAttribute("aria-expanded", "false");
        return;
      }
      // Debounce ~180ms so a typing burst hits the backend once.
      this._searchDebounceTimer = setTimeout(() => this._searchSymbols(q), 180);
    });

    input.addEventListener("keydown", (e) => {
      const items = Array.from(sug.querySelectorAll(".wl-add-suggest-item"));
      if (e.key === "ArrowDown" && items.length) {
        e.preventDefault();
        this._suggestActive = Math.min(this._suggestActive + 1, items.length - 1);
        this._paintActive(items);
      } else if (e.key === "ArrowUp" && items.length) {
        e.preventDefault();
        this._suggestActive = Math.max(this._suggestActive - 1, 0);
        this._paintActive(items);
      } else if (e.key === "Enter") {
        if (this._suggestActive >= 0 && items[this._suggestActive]) {
          e.preventDefault();
          items[this._suggestActive].click();
        } else {
          // No selection — submit with raw input (legacy path).
          this._submitAdd();
        }
      } else if (e.key === "Escape") {
        sug.hidden = true; sug.innerHTML = "";
        input.setAttribute("aria-expanded", "false");
      }
    });

    // Outside-click closes the dropdown — but only when the dropdown
    // itself isn't the target (otherwise the click on a suggestion
    // would never fire).
    document.addEventListener("click", (e) => {
      const wrap = document.getElementById("watchlist-add-symbol-wrap");
      if (!wrap) return;
      if (!wrap.contains(e.target)) {
        sug.hidden = true;
        input.setAttribute("aria-expanded", "false");
      }
    });
  },

  /** Highlight one suggestion + ensure it's visible. */
  _paintActive(items) {
    items.forEach((el, i) => el.classList.toggle("active", i === this._suggestActive));
    const active = items[this._suggestActive];
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  },

  /** Fetch suggestions from the backend; stale-request guarded by _searchSeq. */
  async _searchSymbols(q) {
    const seq = ++this._searchSeq;
    const sug = document.getElementById("watchlist-add-suggest");
    if (!sug) return;
    // Show a quick "loading" hint so the user isn't staring at nothing.
    sug.hidden = false;
    sug.innerHTML = `<div class="wl-add-suggest-loading">查询中…</div>`;
    try {
      const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
      const r = await fetch(`${apiBase}/api/symbol-search?q=${encodeURIComponent(q)}&limit=8`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      // Discard if a newer query has already fired.
      if (seq !== this._searchSeq) return;
      this._renderSuggest(j.items || []);
    } catch (e) {
      if (seq !== this._searchSeq) return;
      sug.innerHTML = `<div class="wl-add-suggest-error">查询失败：${e.message}</div>`;
    }
  },

  /** Render the dropdown from a list of {symbol,name,exchange,market,quote_type}. */
  _renderSuggest(items) {
    const sug = document.getElementById("watchlist-add-suggest");
    const input = document.getElementById("watchlist-add-ticker");
    if (!sug || !input) return;
    if (!items.length) {
      sug.hidden = true; sug.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
      return;
    }
    // Chinese label for each market — keeps the UI consistent with the
    // existing market chips on watchlist rows.
    const marketZh = {
      us: "美股", hk: "港股", cn: "A股", crypto: "加密",
      commodity: "期货", forex: "外汇", index: "指数", other: "其他",
    };
    // Chinese label for the asset type, when available.
    const typeZh = (qt) => {
      const k = (qt || "").toUpperCase();
      if (k === "EQUITY")          return "股票";
      if (k === "ETF")             return "ETF";
      if (k === "MUTUALFUND")      return "基金";
      if (k === "CRYPTOCURRENCY")  return "加密币";
      if (k === "FUTURE")          return "期货";
      if (k === "CURRENCY")        return "外汇";
      if (k === "INDEX")           return "指数";
      return "";
    };

    sug.innerHTML = items.map((it, i) => {
      const mZh = marketZh[it.market] || it.market || "其他";
      const tZh = typeZh(it.quote_type);
      const exch = it.exchange ? ` · ${escapeHtml(it.exchange)}` : "";
      return `
        <button type="button" class="wl-add-suggest-item" data-idx="${i}" role="option">
          <div class="wl-add-suggest-row1">
            <span class="wl-add-suggest-sym">${escapeHtml(it.symbol)}</span>
            <span class="wl-add-suggest-market wl-add-market-${escapeHtml(it.market || "other")}">${escapeHtml(mZh)}</span>
            ${tZh ? `<span class="wl-add-suggest-type">${escapeHtml(tZh)}</span>` : ""}
          </div>
          <div class="wl-add-suggest-row2">
            <span class="wl-add-suggest-name">${escapeHtml(it.name || "")}</span>
            <span class="wl-add-suggest-meta">${escapeHtml((it.quote_type || "").toLowerCase())}${exch}</span>
          </div>
        </button>`;
    }).join("");
    sug.hidden = false;
    input.setAttribute("aria-expanded", "true");
    this._suggestActive = -1;

    // Wire clicks.
    sug.querySelectorAll(".wl-add-suggest-item").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        const idx = parseInt(btn.dataset.idx, 10);
        const picked = items[idx];
        if (picked) this._selectSymbol(picked);
      });
    });
  },

  /** Accept a suggestion: stash it + render the visible chip + clear input. */
  _selectSymbol(item) {
    this._selectedSymbol = item;
    const input = document.getElementById("watchlist-add-ticker");
    const sug = document.getElementById("watchlist-add-suggest");
    const sel = document.getElementById("watchlist-add-selected");
    const nameInput = document.getElementById("watchlist-add-name");
    if (input)  input.value = item.symbol;
    if (sug)   { sug.hidden = true; sug.innerHTML = ""; input?.setAttribute("aria-expanded", "false"); }
    // Auto-fill nickname with the company/asset name (user can edit).
    if (nameInput && !nameInput.value && item.name && !item.name.startsWith("(")) {
      nameInput.value = item.name;
    }
    // Render a compact "selected" chip so it's obvious what's picked.
    if (sel) {
      const marketZh = {
        us: "美股", hk: "港股", cn: "A股", crypto: "加密",
        commodity: "期货", forex: "外汇", index: "指数", other: "其他",
      };
      const mZh = marketZh[item.market] || item.market || "其他";
      sel.hidden = false;
      sel.innerHTML = `
        <span class="wl-add-selected-chip">
          <span class="wl-add-selected-sym">${escapeHtml(item.symbol)}</span>
          <span class="wl-add-selected-name">${escapeHtml(item.name || "")}</span>
          <span class="wl-add-market-${escapeHtml(item.market || "other")} wl-add-suggest-market">${escapeHtml(mZh)}</span>
          <button type="button" class="wl-add-selected-clear" title="重新选择">×</button>
        </span>`;
      sel.querySelector(".wl-add-selected-clear")?.addEventListener("click", () => {
        this._selectedSymbol = null;
        sel.hidden = true; sel.innerHTML = "";
        if (input) { input.value = ""; input.focus(); }
      });
    }
  },

  _useRemote() { return Boolean(window.Watchlist && window.Auth && window.Auth.isSignedIn()); },

  // Bare crypto symbols frequently typed without -USD/-USDT suffix.
  // Treat them as crypto when standalone so import-from-history doesn't
  // misclassify e.g. "BTC" as a US stock.
  CRYPTO_BARE: new Set(["BTC","ETH","SOL","XRP","DOGE","ADA","MATIC","LINK","AVAX","DOT","BNB","TRX","SHIB","LTC","BCH","UNI","ATOM"]),

  _detectMarket(ticker) {
    const t = (ticker || "").toUpperCase();
    if (!t) return "other";
    if (this.CRYPTO_BARE.has(t)) return "crypto";
    if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|MATIC|LINK|AVAX|DOT)[-/]?(USD|USDT)$/.test(t)) return "crypto";
    if (t.endsWith("USDT") || t.endsWith("-USD")) return "crypto";
    if (/^\d{4,5}\.HK$|^\d{4,5}$/.test(t)) return "hk";
    if (/^(SH|SZ)?\d{6}(\.SS|\.SZ)?$/.test(t)) return "cn";
    if (/^[A-Z]{1,3}=F$|^GC|^CL|^NG|^SI|^HG|^ZC/.test(t)) return "commodity";
    if (/^[A-Z]{6}=X$/.test(t)) return "forex";
    if (/^[A-Z]{1,5}$/.test(t)) return "us";
    return "other";
  },

  async _submitAdd() {
    // Prefer the autocomplete-picked symbol when present — it carries
    // the canonical ticker (e.g. BTC-USD vs BTC) + correct market so we
    // don't have to fall back to the regex-based _detectMarket guesser.
    const picked = this._selectedSymbol;
    const rawTicker = document.getElementById("watchlist-add-ticker").value.trim().toUpperCase();
    const ticker = (picked && picked.symbol) ? picked.symbol.toUpperCase() : rawTicker;
    const name   = document.getElementById("watchlist-add-name").value.trim();
    const group  = document.getElementById("watchlist-add-group").value.trim();
    if (!ticker) return;
    // Market: trust the picked row first; otherwise fall back to the
    // legacy regex heuristic so old code paths (e.g. import-from-history)
    // keep working.
    const market = (picked && picked.market) ? picked.market : this._detectMarket(ticker);
    // Auto-fill display_name from the picked row's name if the user
    // didn't type one. Always strips the "(无在线匹配...)" placeholder.
    let displayName = name;
    if (!displayName && picked && picked.name && !picked.name.startsWith("(")) {
      displayName = picked.name;
    }
    if (this._useRemote()) {
      const r = await window.Watchlist.add({ ticker, display_name: displayName || null, market, custom_group: group || null });
      if (r.error) { alert("添加失败：" + r.error); return; }
    } else {
      // localStorage fallback
      const all = this._readLocal();
      if (all.some(x => x.ticker === ticker)) { alert(`${ticker} 已在自选中`); return; }
      all.unshift({ id: "loc-" + Date.now(), ticker, display_name: displayName || null, market, custom_group: group || null, added_at: new Date().toISOString() });
      localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all));
    }
    this._toggleAddForm(false);
    await this.refresh(true);
  },

  _readLocal() {
    try { return JSON.parse(localStorage.getItem(this.LOCAL_KEY) || "[]"); }
    catch { return []; }
  },

  /**
   * Pull every distinct ticker that ever appeared in the user's history
   * (History.cache) and add to watchlist if not already present.
   * Called by the 📥 从历史导入 button and once automatically when an
   * authenticated user has decisions but an empty watchlist (one-time
   * backfill — guarded by a localStorage flag so we don't nag).
   */
  async importFromHistory(silent = false) {
    if (typeof History === "undefined") return { added: 0, skipped: 0 };
    const seen = new Set(this.cache.map(e => (e.ticker || "").toUpperCase()));
    const toAdd = [];
    (History.cache || []).forEach(d => {
      const t = (d.ticker || "").trim().toUpperCase();
      if (t && !seen.has(t)) { seen.add(t); toAdd.push({ ticker: t }); }
    });
    if (!toAdd.length) {
      if (!silent) alert("没有可导入的新标的（历史记录里的代码都已在自选中）。");
      return { added: 0, skipped: 0 };
    }
    let added = 0, failed = 0;
    for (const t of toAdd) {
      const market = this._detectMarket(t.ticker);
      if (this._useRemote()) {
        const r = await window.Watchlist.add({ ticker: t.ticker, market });
        if (r.error) failed++; else added++;
      } else {
        const all = this._readLocal();
        if (!all.some(x => x.ticker === t.ticker)) {
          all.unshift({ id: "loc-" + Date.now() + Math.random().toString(36).slice(2,5), ticker: t.ticker, market, added_at: new Date().toISOString() });
          localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all));
          added++;
        }
      }
    }
    await this.refresh(true);
    if (!silent) {
      alert(`已导入 ${added} 个新标的${failed ? `（失败 ${failed} 个）` : ""}。`);
    }
    return { added, skipped: toAdd.length - added - failed };
  },

  async refresh(fetchQuotes = false) {
    this._loadError = null;
    if (this._useRemote()) {
      const { rows, error } = await window.Watchlist.list();
      this._loadError = error;
      this.cache = rows || [];
    } else {
      this.cache = this._readLocal();
    }
    // Reconcile the source list with the user's client-side pin choices before
    // the first paint so pinned tickers float to the top regardless of whether
    // the Supabase is_pinned column exists.
    this._applyPins();
    this.render();
    // Keep the Decisions page's "标的" filter in sync with the watchlist.
    if (typeof DecisionsPage !== "undefined" && DecisionsPage.tickerWrapEl) {
      DecisionsPage.renderTickerFilter();
    }

    // One-time auto-import: if signed-in user has decisions but no watchlist,
    // backfill from history. Guarded so it only runs once per browser.
    const flagKey = "tda:wl:autoImported";
    if (this._useRemote()
        && this.cache.length === 0
        && (typeof History !== "undefined" ? (History.cache || []).length : 0) > 0
        && !localStorage.getItem(flagKey)) {
      localStorage.setItem(flagKey, "1");
      try {
        const r = await this.importFromHistory(true);
        if (r.added > 0) console.info("watchlist auto-imported", r.added, "tickers from history");
      } catch (e) { console.warn("auto-import failed", e); }
    }

    if (fetchQuotes) this._fetchQuotes();
  },

  async _fetchQuotes() {
    if (!this.cache.length) return;
    const tickers = this.cache.map(e => e.ticker);
    try {
      const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
      const r = await fetch(`${apiBase}/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}`);
      const d = await r.json();
      (d.items || []).forEach(q => { this.quotes[q.ticker.toUpperCase()] = q; });
      if (this.updatedEl) this.updatedEl.textContent = "更新于 " + new Date().toLocaleTimeString();
      // Surgical update — NEVER call this.render() here. A full re-render
      // rebuilds the comp-report mount, the latest-decision card, and the
      // entire sidebar, causing visible jitter every 60s. Instead patch only
      // the cells whose values change.
      this._updateQuotesInPlace();
    } catch (e) {
      console.warn("watchlist quotes fetch failed", e);
    }
  },

  /** Surgical price/pct/stats refresh — no innerHTML rebuilds, no comp-report
   *  re-attach. Called from the 60s quote tick and from _fetchQuotes after the
   *  manual refresh button. */
  _updateQuotesInPlace() {
    if (!this.listEl) return;
    const fmt = (n, d=2) => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
    const fmtPct = (p) => (p == null || isNaN(p)) ? "—" : (p >= 0 ? "+" : "") + Number(p).toFixed(2) + "%";

    // -- Sidebar rows -----------------------------------------------------
    this.listEl.querySelectorAll(".watchlist-row").forEach(li => {
      const t = (li.dataset.ticker || "").toUpperCase();
      const q = this.quotes[t] || {};
      const pct = q.change_pct;
      const dirCls = pct == null ? "" : (pct >= 0 ? "up" : "down");
      const priceEl = li.querySelector(".wl-side-price");
      if (priceEl) priceEl.textContent = fmt(q.price);
      const pctEl = li.querySelector(".wl-side-pct");
      if (pctEl) {
        pctEl.textContent = fmtPct(pct);
        pctEl.classList.remove("up", "down");
        if (dirCls) pctEl.classList.add(dirCls);
      }
    });

    // -- Main pane (if a ticker is selected) -----------------------------
    const entry = this.cache.find(e => e.id === this.selectedId);
    if (!entry || !this.mainEl) return;
    const q = this.quotes[entry.ticker.toUpperCase()] || {};
    const pct = q.change_pct;
    const dirCls = pct == null ? "" : (pct >= 0 ? "up" : "down");
    const dirArrow = pct == null ? "" : (pct >= 0 ? "▲" : "▼");

    const mainPriceEl = this.mainEl.querySelector(".wl-main-price");
    if (mainPriceEl) mainPriceEl.textContent = fmt(q.price);
    const mainPctEl = this.mainEl.querySelector(".wl-main-pct");
    if (mainPctEl) {
      mainPctEl.textContent = `${dirArrow} ${fmtPct(pct)}`;
      mainPctEl.classList.remove("up", "down");
      if (dirCls) mainPctEl.classList.add(dirCls);
    }

    // -- Stats grid -- order: 开盘 最高 最低 昨收 成交额 市值 P/E 数据源
    const statEls = this.mainEl.querySelectorAll(".wl-stats .wl-stat-value");
    if (statEls && statEls.length >= 8) {
      const capRaw = q.market_cap;
      const capUsd = (capRaw != null && q.source === "finnhub") ? capRaw * 1e6 : capRaw;
      const turnoverUsd = q.turnover != null
        ? q.turnover
        : (q.volume != null && q.price != null ? q.volume * q.price : q.volume);
      statEls[0].textContent = fmt(q.open);
      statEls[1].textContent = fmt(q.high);
      statEls[2].textContent = fmt(q.low);
      statEls[3].textContent = fmt(q.prev_close);
      statEls[4].textContent = this.formatChineseAmount(turnoverUsd, "美元");
      statEls[5].textContent = this.formatChineseAmount(capUsd, "美元");
      statEls[6].textContent = fmt(q.pe_ratio, 1);
      statEls[7].textContent = q.source || "—";
    }
  },

  // ------ render ----------------------------------------------------------
  _customGroups() {
    const groups = new Map();
    this.cache.forEach(e => {
      if (e.custom_group) groups.set(e.custom_group, (groups.get(e.custom_group) || 0) + 1);
    });
    return [...groups.entries()];
  },

  /** Sort by (is_pinned DESC, sort_order ASC, added_at DESC). Used by
   *  both the rendering pipeline and the persist-order routine after a
   *  drag-and-drop reorder. */
  _sorted(entries) {
    return [...entries].sort((a, b) => {
      const ap = a.is_pinned ? 1 : 0;
      const bp = b.is_pinned ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const aso = (a.sort_order != null) ? a.sort_order : 1e9;
      const bso = (b.sort_order != null) ? b.sort_order : 1e9;
      if (aso !== bso) return aso - bso;
      const at = new Date(a.added_at || 0).getTime();
      const bt = new Date(b.added_at || 0).getTime();
      return bt - at;
    });
  },

  _filtered() {
    const g = this.activeGroup;
    let pool;
    if (g === "all") pool = this.cache;
    else if (g.startsWith("custom:")) {
      const name = g.slice(7);
      pool = this.cache.filter(e => e.custom_group === name);
    } else {
      pool = this.cache.filter(e => (e.market || "other") === g);
    }
    return this._sorted(pool);
  },

  // ---- formatters --------------------------------------------------------
  // Chinese natural-language amount: "1.532 万亿美元", "2090 亿美元",
  // "5.2 万美元", "3,456 美元". Pass `unit` to control suffix ("美元", "" …).
  // `n` is in absolute USD (already scaled — caller multiplies market_cap by
  // 1e6 when source is Finnhub).
  formatChineseAmount(n, unit = "美元") {
    if (n == null || isNaN(n)) return "—";
    const v = Number(n);
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    // 万亿 = 1e12, 亿 = 1e8, 万 = 1e4
    let scaled, suffix;
    if (abs >= 1e12)      { scaled = v / 1e12; suffix = "万亿"; }
    else if (abs >= 1e8)  { scaled = v / 1e8;  suffix = "亿";   }
    else if (abs >= 1e4)  { scaled = v / 1e4;  suffix = "万";   }
    else {
      return sign + Math.round(abs).toLocaleString("en-US") + " " + unit;
    }
    // Headline numbers: matches the form the user asked for —
    //   "1.532 万亿美元" (a < 10, 3 decimals)
    //   "20.9 亿美元"   (a in [10,100), 1 decimal)
    //   "2090 亿美元"   (a >= 100, 0 decimals)
    const a = Math.abs(scaled);
    const digits = a >= 100 ? 0 : a >= 10 ? 1 : 3;
    let txt = a.toFixed(digits);
    // Trim trailing zeros only after a decimal point — never from "1200".
    if (txt.indexOf(".") !== -1) txt = txt.replace(/0+$/, "").replace(/\.$/, "");
    return sign + txt + " " + suffix + unit;
  },

  render() {
    if (!this.listEl) return;
    this.renderGroups();

    if (!this.cache.length) {
      this.listEl.innerHTML = "";
      this.emptyEl.innerHTML = this._loadError
        ? `<span style="color:var(--danger);">⚠ ${escapeHtml(this._loadError)}</span><br><span style="font-size:11px;">检查 Supabase 是否跑过 schema.sql + 所有 migrations（包括 0006）。</span>`
        : `<div style="margin-bottom:8px;">还没添加任何自选。</div><div style="font-size:11px;">点击右上角 <strong>+ 添加自选</strong> 开始关注你感兴趣的标的。</div>`;
      this._renderMainEmpty();
      return;
    }
    this.emptyEl.innerHTML = "";

    const filtered = this._filtered();  // already (is_pinned DESC, sort_order ASC, added_at DESC)
    const fmt = (n, d=2) => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
    const fmtPct = (p) => (p == null || isNaN(p)) ? "—" : (p >= 0 ? "+" : "") + Number(p).toFixed(2) + "%";

    // If selectedId no longer matches any visible row (e.g. user changed
    // group filter), fall back to the first visible asset.
    if (!filtered.find(e => e.id === this.selectedId)) {
      this.selectedId = filtered[0]?.id || null;
    }

    const rows = filtered.map(e => {
      const q = this.quotes[e.ticker.toUpperCase()] || {};
      const pct = q.change_pct;
      const dirCls = pct == null ? "" : (pct >= 0 ? "up" : "down");
      const isSelected = this.selectedId === e.id;
      const nameSub = e.display_name || (q.name && q.name !== e.ticker ? q.name : "");
      const pinned = !!e.is_pinned;
      // Draggable rows + per-row pin button. The pin icon also doubles as the
      // "this row is pinned" indicator when active (gold) so the user can see
      // pin state at a glance.
      return `
        <li class="watchlist-row ${isSelected ? "selected" : ""} ${pinned ? "pinned" : ""}"
            data-id="${e.id}" data-ticker="${escapeHtml(e.ticker)}"
            data-pinned="${pinned ? "1" : "0"}" draggable="true">
          <span class="wl-side-drag" title="拖动以排序">⠿</span>
          <span class="wl-side-ticker">${escapeHtml(e.ticker)}${nameSub ? `<span class="wl-name">${escapeHtml(nameSub)}</span>` : ""}</span>
          <span class="wl-side-price">${fmt(q.price)}</span>
          <span class="wl-side-pct ${dirCls}">${fmtPct(pct)}</span>
          <span class="wl-side-actions">
            <button class="wl-side-pin ${pinned ? "on" : ""}" data-wl-pin="${e.id}" title="${pinned ? "取消置顶" : "置顶"}" aria-label="${pinned ? "取消置顶" : "置顶"}">${pinned ? "📌" : "📍"}</button>
            <button class="wl-side-del" data-wl-del="${e.id}" title="从自选中移除" aria-label="移除 ${escapeHtml(e.ticker)}">✕</button>
          </span>
        </li>`;
    }).join("");

    this.listEl.innerHTML = rows;
    this._wireRows();
    this._renderMain();
  },

  _renderMainEmpty() {
    if (!this.mainEl) return;
    this.mainEl.innerHTML = `<div class="watchlist-main-empty">还没添加任何自选标的。点击右上角「+ 添加自选」开始关注你感兴趣的标的。</div>`;
  },

  _renderMain() {
    if (!this.mainEl) return;
    const entry = this.cache.find(e => e.id === this.selectedId);
    if (!entry) {
      this.mainEl.innerHTML = `<div class="watchlist-main-empty">← 选择左侧任意标的查看实时行情和最新决策</div>`;
      return;
    }
    const q = this.quotes[entry.ticker.toUpperCase()] || {};
    const fmt = (n, d=2) => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
    const fmtPct = (p) => (p == null || isNaN(p)) ? "—" : (p >= 0 ? "+" : "") + Number(p).toFixed(2) + "%";
    const pct = q.change_pct;
    const dirCls = pct == null ? "" : (pct >= 0 ? "up" : "down");
    const dirArrow = pct == null ? "" : (pct >= 0 ? "▲" : "▼");
    const nameSub = entry.display_name || (q.name && q.name !== entry.ticker ? q.name : "");

    // Chinese natural-language formatter for 成交额 / 市值.
    // Note: Finnhub returns market_cap in millions USD — backend leaves it
    // as-is in `market_cap`, so multiply by 1e6 before formatting unless
    // the source is something else. CoinGecko / yfinance give absolute USD,
    // so we only scale when source is finnhub.
    const capRaw = q.market_cap;
    const capUsd = (capRaw != null && q.source === "finnhub") ? capRaw * 1e6 : capRaw;
    const turnoverUsd = q.turnover != null
      ? q.turnover
      : (q.volume != null && q.price != null ? q.volume * q.price : q.volume);
    const turnoverUnit = (q.source === "binance" || q.source === "coingecko") ? "美元" : "美元";

    // Compact horizontal stats strip. Each "stat" is a label-above-value
    // pair that takes only the width it needs — no more 8-cell grid with
    // a row of half-empty cards. Source badge moves to the right edge.
    const stats = `
      <div class="wl-stats">
        <div class="wl-stat"><div class="wl-stat-label">开盘</div><div class="wl-stat-value">${fmt(q.open)}</div></div>
        <div class="wl-stat"><div class="wl-stat-label">最高</div><div class="wl-stat-value">${fmt(q.high)}</div></div>
        <div class="wl-stat"><div class="wl-stat-label">最低</div><div class="wl-stat-value">${fmt(q.low)}</div></div>
        <div class="wl-stat"><div class="wl-stat-label">昨收</div><div class="wl-stat-value">${fmt(q.prev_close)}</div></div>
        <div class="wl-stat"><div class="wl-stat-label">成交额</div><div class="wl-stat-value">${this.formatChineseAmount(turnoverUsd, turnoverUnit)}</div></div>
        <div class="wl-stat"><div class="wl-stat-label">市值</div><div class="wl-stat-value">${this.formatChineseAmount(capUsd, "美元")}</div></div>
        <div class="wl-stat"><div class="wl-stat-label">P/E</div><div class="wl-stat-value">${fmt(q.pe_ratio, 1)}</div></div>
        ${q.source ? `<div class="wl-stat-source" title="行情数据源">${escapeHtml(q.source)}</div>` : ""}
      </div>`;

    // Header: ticker + name on the left, price block in the middle,
    // action buttons aligned to the right. Single-line, sticky-friendly.
    const head = `
      <div class="wl-main-head">
        <div class="wl-main-head-id">
          <span class="wl-main-ticker">${escapeHtml(entry.ticker)}</span>
          ${nameSub ? `<span class="wl-main-name">${escapeHtml(nameSub)}</span>` : ""}
        </div>
        <div class="wl-main-head-price">
          <span class="wl-main-price">${fmt(q.price)}</span>
          <span class="wl-main-pct ${dirCls}">${dirArrow} ${fmtPct(pct)}</span>
        </div>
        <div class="wl-main-actions">
          <button class="btn primary small" data-main-act="run">▶ 启动新决策</button>
        </div>
      </div>`;

    const compHTML = `<div class="wl-comp-mount" id="wl-comp-mount-${escapeHtml(entry.id)}"></div>`;
    this.mainEl.innerHTML = head + stats + compHTML + this._latestDecisionHTML(entry);
    this._wireMain(entry);
    // Lazily fetch the full decision payload (for summary text) and re-render
    // just the decision block when it lands.
    this._maybeLoadFullDecision(entry);
    if (window.ComprehensiveReport) {
      const mount = this.mainEl.querySelector(".wl-comp-mount");
      if (mount) window.ComprehensiveReport.attach(entry, mount);
    }
  },

  _matchedDecisions(entry) {
    // NB: bare `History` — `window.History` is the browser's built-in
    // History constructor (pushState/popState), not our app's data layer.
    return (typeof History !== "undefined" ? History.cache || [] : [])
      .filter(d => (d.ticker || "").toUpperCase() === entry.ticker.toUpperCase())
      .sort((a, b) => new Date(b.completedAt || b.startedAt) - new Date(a.completedAt || a.startedAt));
  },

  _latestDecisionHTML(entry) {
    const matched = this._matchedDecisions(entry);
    const latest = matched[0];
    if (!latest) {
      return `<div class="wl-decision-block">
        <h3>最新决策</h3>
        <div class="wl-no-decision">还没跑过 ${escapeHtml(entry.ticker)} 的决策。点击 ▶ 启动新决策 让 AI 为你分析。</div>
      </div>`;
    }
    const ratingColor = latest.rating === "Buy" || latest.rating === "Overweight" ? "#2e7d32"
      : latest.rating === "Sell" || latest.rating === "Underweight" ? "#c0392b"
      : latest.rating === "Hold" ? "#b89030" : "var(--bg-soft)";
    const ts = latest.completedAt || latest.startedAt;
    const tsTxt = ts ? new Date(ts).toLocaleString() : "";
    const stars = latest.user_rating ? `<span style="color:var(--accent);">${"★".repeat(latest.user_rating)}</span>` : "";

    // The full text is loaded asynchronously — show what we have now.
    const full = this._decisionFullCache[latest.id];
    const summary = full?.runState?.finalDecision?.raw_zh
      || full?.runState?.finalDecision?.raw_en
      || "";
    const summaryHTML = summary
      ? `<div class="wl-decision-summary">${mdLite(summary)}</div>`
      : `<div class="wl-decision-summary muted" style="font-size:12px;">点击查看完整决策内容…</div>`;

    const moreCount = matched.length > 1 ? matched.length - 1 : 0;
    const more = moreCount > 0
      ? `<div class="wl-decision-history-link">还有 ${moreCount} 条历史决策 · <a data-main-act="all-history">在「历史」页查看全部</a></div>`
      : "";

    return `<div class="wl-decision-block">
      <h3>最新决策</h3>
      <div class="wl-decision-card" data-main-act="open-decision" data-decision-id="${latest.id}">
        <div class="wl-decision-meta">
          <span class="wl-decision-rating" style="background:${ratingColor};">${escapeHtml(latest.rating || "—")}</span>
          <span>${escapeHtml(latest.trade_date || "")}</span>
          <span>${escapeHtml(tsTxt)}</span>
          ${stars}
        </div>
        ${summaryHTML}
      </div>
      ${more}
    </div>`;
  },

  // Pull the full decision body (runState.finalDecision.raw_zh/en) from
  // History.getEntry the first time we render an asset, then re-render the
  // decision block with the summary text in place.
  async _maybeLoadFullDecision(entry) {
    const latest = this._matchedDecisions(entry)[0];
    if (!latest) return;
    if (this._decisionFullCache[latest.id]) return;
    if (typeof History === "undefined") return;
    try {
      const full = await History.getEntry(latest.id);
      if (full) {
        this._decisionFullCache[latest.id] = full;
        // Only re-render if the user is still looking at this asset.
        if (this.selectedId === entry.id) this._renderMain();
      }
    } catch (e) {
      console.warn("watchlist load decision failed", e);
    }
  },

  _wireRows() {
    // Row click → select (ignored when clicking the per-row actions or drag handle).
    this.listEl.querySelectorAll(".watchlist-row").forEach(li => {
      li.addEventListener("click", (ev) => {
        if (ev.target.closest(".wl-side-actions, .wl-side-drag")) return;
        const id = li.dataset.id;
        if (this.selectedId === id) return;
        this.selectedId = id;
        // Push a deep-link URL so the user can bookmark / share / use the back
        // button to navigate between recently-viewed tickers.
        if (window.Router) window.Router.goWatchlist(li.dataset.ticker, null);
        this.render();
      });
    });
    // Per-row pin button.
    this.listEl.querySelectorAll("[data-wl-pin]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await this._togglePin(btn.dataset.wlPin);
      });
    });
    // Per-row remove button (moved here from the main panel header).
    this.listEl.querySelectorAll("[data-wl-del]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await this._removeEntry(btn.dataset.wlDel);
      });
    });
    // Drag-to-reorder (within the same pinned/unpinned group).
    this.listEl.querySelectorAll(".watchlist-row").forEach(li => {
      li.addEventListener("dragstart", (ev) => this._onDragStart(ev, li));
      li.addEventListener("dragover",  (ev) => this._onDragOver(ev, li));
      li.addEventListener("dragleave", (ev) => this._onDragLeave(ev, li));
      li.addEventListener("drop",      (ev) => this._onDrop(ev, li));
      li.addEventListener("dragend",   ()   => this._onDragEnd());
    });
  },

  // ---- pin state (client-authoritative) -----------------------------------
  // REDO (2026-05-29): pinning used to be persisted *only* to Supabase
  // (`watchlist.is_pinned`, migration 0009). When that migration wasn't applied
  // the column was missing, auth.js silently stripped the field, and pinning
  // appeared to do nothing ("置顶功能无效"). We now keep an authoritative
  // client-side pin map in localStorage so pinning ALWAYS works — signed in or
  // out, column present or not. The Supabase column is still written
  // best-effort so cross-device sync keeps working wherever 0009 *was* applied.
  PIN_KEY: "tda:wl-pins",        // { "NVDA": true, "AAPL": false, … }
  _readPins() {
    try { return JSON.parse(localStorage.getItem(this.PIN_KEY) || "{}"); }
    catch { return {}; }
  },
  _writePins(map) {
    try { localStorage.setItem(this.PIN_KEY, JSON.stringify(map || {})); }
    catch (e) { console.warn("wl pins save failed", e); }
  },
  /** Merged pin state for an entry: explicit local override wins, else the
   *  remote `is_pinned` (so devices where 0009 *is* applied still sync). */
  _pinStateFor(entry) {
    const pins = this._readPins();
    const k = (entry.ticker || "").toUpperCase();
    if (Object.prototype.hasOwnProperty.call(pins, k)) return !!pins[k];
    return !!entry.is_pinned;
  },
  /** Overlay the local pin map onto the cache so _sorted()/render() see it.
   *  Called from refresh() right before render so the source data (remote or
   *  localStorage list) is always reconciled with the user's pin choices. */
  _applyPins() {
    this.cache.forEach(e => { e.is_pinned = this._pinStateFor(e); });
  },

  // ---- pin / drag ---------------------------------------------------------

  async _togglePin(id) {
    if (!id) return;
    const entry = this.cache.find(e => e.id === id);
    if (!entry) return;
    const newVal = !entry.is_pinned;
    // Optimistic in-memory flip so the row re-sorts instantly.
    entry.is_pinned = newVal;
    // Authoritative client-side pin state — survives a missing Supabase column.
    const pins = this._readPins();
    pins[(entry.ticker || "").toUpperCase()] = newVal;
    this._writePins(pins);
    // Best-effort cross-device sync. No-op when the is_pinned column hasn't
    // been migrated (auth.js strips the field); failures are non-fatal because
    // the local pin map above is the real source of truth.
    if (this._useRemote()) {
      try { await window.Watchlist.update(id, { is_pinned: newVal }); }
      catch (e) { /* ignore — local pin map already persisted */ }
    }
    this.render();
  },

  _onDragStart(ev, li) {
    this._dragId = li.dataset.id;
    this._dragPinned = li.dataset.pinned === "1";
    li.classList.add("dragging");
    try {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", li.dataset.id);
    } catch (_) { /* some browsers throw on text/plain */ }
  },

  _onDragOver(ev, li) {
    if (!this._dragId || this._dragId === li.dataset.id) return;
    // Only allow dropping within the same group (pinned or unpinned).
    if ((li.dataset.pinned === "1") !== this._dragPinned) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    li.classList.add("drop-target");
  },

  _onDragLeave(_ev, li) {
    li.classList.remove("drop-target");
  },

  async _onDrop(ev, li) {
    ev.preventDefault();
    li.classList.remove("drop-target");
    const dragId = this._dragId;
    const targetId = li.dataset.id;
    if (!dragId || dragId === targetId) return;
    if ((li.dataset.pinned === "1") !== this._dragPinned) return;
    // Reorder this.cache: pull dragId out and insert before targetId.
    const sorted = this._sorted(this.cache);
    const di = sorted.findIndex(e => e.id === dragId);
    const ti = sorted.findIndex(e => e.id === targetId);
    if (di < 0 || ti < 0) return;
    const [moved] = sorted.splice(di, 1);
    const newTi = sorted.findIndex(e => e.id === targetId);  // recompute after splice
    sorted.splice(newTi, 0, moved);
    // Reassign sort_order across each pool independently.
    let pinSeq = 0, unpinSeq = 0;
    sorted.forEach(e => {
      if (e.is_pinned) e.sort_order = pinSeq++;
      else             e.sort_order = unpinSeq++;
    });
    // Mutate the actual cache items (sorted is a fresh array but the entry
    // objects are shared by reference, so the writes above already updated them).
    this.render();
    // Persist
    await this._persistOrder();
  },

  _onDragEnd() {
    this.listEl.querySelectorAll(".watchlist-row")
      .forEach(li => li.classList.remove("dragging", "drop-target"));
    this._dragId = null;
    this._dragPinned = null;
  },

  /** Push sort_order to Supabase (single batch) or localStorage. */
  async _persistOrder() {
    if (this._useRemote()) {
      const ordered = this._sorted(this.cache).map(e => e.id);
      await window.Watchlist.reorder(ordered);
    } else {
      const all = this._readLocal();
      // Merge our sort_order back into localStorage.
      const byId = new Map(this.cache.map(e => [e.id, e]));
      for (const r of all) {
        const mine = byId.get(r.id);
        if (mine) { r.sort_order = mine.sort_order; r.is_pinned = mine.is_pinned; }
      }
      localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all));
    }
  },

  /** Remove a ticker from the watchlist. Shared by the per-row ✕ button and
   *  any legacy main-panel delete affordance. Also drops the local pin entry
   *  so a re-added ticker starts unpinned. */
  async _removeEntry(id) {
    const entry = this.cache.find(e => e.id === id);
    if (!entry) return;
    if (!confirm(`从自选中移除 ${entry.ticker}？`)) return;
    if (this._useRemote()) await window.Watchlist.remove(id);
    else {
      const all = this._readLocal().filter(x => x.id !== id);
      localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all));
    }
    const pins = this._readPins();
    const k = (entry.ticker || "").toUpperCase();
    if (Object.prototype.hasOwnProperty.call(pins, k)) { delete pins[k]; this._writePins(pins); }
    if (this.selectedId === id) this.selectedId = null;
    await this.refresh();
  },

  _wireMain(entry) {
    if (!this.mainEl) return;
    this.mainEl.querySelectorAll("[data-main-act]").forEach(el => {
      el.addEventListener("click", async ev => {
        ev.stopPropagation();
        const act = el.dataset.mainAct;
        if (act === "run") {
          openDecisionFor(entry.ticker);
        } else if (act === "del") {
          await this._removeEntry(entry.id);
        } else if (act === "open-decision") {
          // Watchlist's "latest decision" card → jump to unified 决策 tab and
          // select that row so the full cockpit (including the multi-horizon
          // plan) renders in the main pane.
          const did = el.dataset.decisionId;
          document.querySelector('nav.tabs button[data-tab="decisions"]').click();
          if (typeof DecisionsPage !== "undefined") setTimeout(() => DecisionsPage._openItem(did), 100);
        } else if (act === "all-history") {
          // Jump to the unified 决策 tab pre-filtered by this ticker.
          document.querySelector('nav.tabs button[data-tab="decisions"]').click();
          if (typeof DecisionsPage !== "undefined") {
            setTimeout(() => {
              DecisionsPage.search = entry.ticker.toLowerCase();
              if (DecisionsPage.searchEl) DecisionsPage.searchEl.value = entry.ticker;
              DecisionsPage.render();
            }, 100);
          }
        }
      });
    });
  },

  renderGroups() {
    if (!this.groupsEl) return;
    const counts = {};
    this.cache.forEach(e => { const m = e.market || "other"; counts[m] = (counts[m] || 0) + 1; });
    const builtins = this.MARKETS
      .filter(m => m.id === "all" || counts[m.id])
      .map(m => `<span class="watchlist-group-chip ${this.activeGroup === m.id ? "active" : ""}" data-group="${m.id}">${m.label}<span class="count">${m.id === "all" ? this.cache.length : (counts[m.id] || 0)}</span></span>`)
      .join("");
    const customs = this._customGroups()
      .map(([name, n]) => `<span class="watchlist-group-chip ${this.activeGroup === "custom:"+name ? "active" : ""}" data-group="custom:${escapeHtml(name)}">${escapeHtml(name)}<span class="count">${n}</span></span>`)
      .join("");
    this.groupsEl.innerHTML = builtins + customs;
    this.groupsEl.querySelectorAll(".watchlist-group-chip").forEach(el => {
      el.addEventListener("click", () => {
        this.activeGroup = el.dataset.group;
        // Force reselect if current selection is filtered out
        const stillVisible = this._filtered().some(x => x.id === this.selectedId);
        if (!stillVisible) this.selectedId = null;
        this.render();
      });
    });
  },
};
// Expose Watchlist UI to other scripts. window.Watchlist is already taken by
// auth.js (the Supabase CRUD wrapper); use a distinct name to avoid collision.
window._appWatchlist = Watchlist;

// =========================================================================
// HistoryPage — legacy shim. The original full-page history view was merged
// into DecisionsPage; this object just exists so any cached external code
// path that still references HistoryPage doesn't blow up. New code should
// call DecisionsPage directly.
// =========================================================================
const HistoryPage = {
  render() { if (typeof DecisionsPage !== "undefined") DecisionsPage.render(); },
  openDrawer(id) { if (typeof DecisionsPage !== "undefined") DecisionsPage._openItem(id); },
  init() {},
  _legacyDeleted: true,
};

// =========================================================================
// Favorites — local storage (and Supabase via Auth.client when signed in)
// =========================================================================
const Favorites = {
  LOCAL_KEY: "tda:favorites",
  cache: [],
  compReports: [],   // pinned `comprehensive_reports` rows (Supabase + localStorage)
  activeTab: "strategy",

  init() {
    this.listEl = document.getElementById("favorites-list");
    document.querySelectorAll("[data-fav-tab]").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-fav-tab]").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        this.activeTab = b.dataset.favTab;
        this.render();
      });
    });
    if (window.Auth) window.Auth.onChange(() => this.refresh());
    this.refresh();
  },

  _useRemote() { return Boolean(window.Auth && window.Auth.isSignedIn() && window.Auth.rawClient()); },

  async refresh() {
    if (this._useRemote()) {
      const { data } = await window.Auth.rawClient()
        .from("favorites").select("*")
        .order("created_at", { ascending: false }).limit(500);
      this.cache = (data || []).map(r => ({
        id: r.id, kind: r.kind, ref_id: r.ref_id,
        label: r.label || {}, created_at: r.created_at,
      }));
    } else {
      try { this.cache = JSON.parse(localStorage.getItem(this.LOCAL_KEY) || "[]"); }
      catch { this.cache = []; }
    }
    // Pinned comprehensive reports live in their OWN table (RLS-scoped); load
    // them in parallel so the 收藏 page can render them in the 综合报告 tab.
    try {
      this.compReports = window.ComprehensiveReports
        ? (await window.ComprehensiveReports.listPinned(200)) || []
        : [];
    } catch (e) {
      console.warn("[favorites] listPinned failed", e);
      this.compReports = [];
    }
    this.render();
    this._updateCounts();
    // Cross-page rerenders so star/heart icons stay in sync
    if (typeof renderLibrary === "function") renderLibrary();
    if (typeof DecisionsPage !== "undefined") DecisionsPage.render();
  },

  isFavorited(kind, refId) {
    return this.cache.some(f => f.kind === kind && f.ref_id === refId);
  },

  async toggle(kind, refId, label = {}) {
    if (this.isFavorited(kind, refId)) {
      await this.remove(kind, refId);
    } else {
      await this.add(kind, refId, label);
    }
  },

  async add(kind, refId, label = {}) {
    if (this._useRemote()) {
      await window.Auth.rawClient().from("favorites").upsert({
        user_id: window.Auth.user().id, kind, ref_id: refId, label,
      }, { onConflict: "user_id,kind,ref_id" });
    } else {
      const all = this._readLocal();
      if (!all.some(f => f.kind === kind && f.ref_id === refId)) {
        all.unshift({ id: Date.now(), kind, ref_id: refId, label, created_at: new Date().toISOString() });
        localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all));
      }
    }
    await this.refresh();
  },

  async remove(kind, refId) {
    if (this._useRemote()) {
      await window.Auth.rawClient().from("favorites").delete()
        .eq("kind", kind).eq("ref_id", refId);
    } else {
      const all = this._readLocal().filter(f => !(f.kind === kind && f.ref_id === refId));
      localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all));
    }
    await this.refresh();
  },

  _readLocal() {
    try { return JSON.parse(localStorage.getItem(this.LOCAL_KEY) || "[]"); }
    catch { return []; }
  },

  _updateCounts() {
    document.getElementById("fav-count-strategy").textContent    = this.cache.filter(f => f.kind === "strategy").length;
    document.getElementById("fav-count-decision").textContent    = this.cache.filter(f => f.kind === "decision").length;
    const oppEl = document.getElementById("fav-count-opportunity");
    if (oppEl) oppEl.textContent = this.cache.filter(f => f.kind === "opportunity").length;
    const compEl = document.getElementById("fav-count-comp-report");
    if (compEl) compEl.textContent = this.compReports.length;
    const stat = document.getElementById("stat-favorites");
    if (stat) stat.textContent = this.cache.length + this.compReports.length;
  },

  render() {
    // Special branch: comp_report lives in its own table (comprehensive_reports
    // where is_pinned=true), not in the favorites table.
    if (this.activeTab === "comp_report") {
      this._renderCompReports();
      return;
    }
    const items = this.cache.filter(f => f.kind === this.activeTab);
    if (!items.length) {
      const emptyMsg = {
        strategy:    "未收藏任何策略。在策略库点击 ★ 添加。",
        decision:    "未收藏任何决策。在历史决策右键添加。",
        opportunity: "未收藏任何机会。在 24h 机会卡片右上角点 ★ 添加。",
      }[this.activeTab] || "未收藏任何项。";
      this.listEl.innerHTML = `<div class="muted" style="padding:32px; text-align:center;">${emptyMsg}</div>`;
      return;
    }
    if (this.activeTab === "strategy") {
      this.listEl.innerHTML = items.map(f => {
        const s = (typeof STRATEGIES !== "undefined") ? STRATEGIES.find(x => x.id === f.ref_id) : null;
        const name = s?.name || f.label?.name || f.ref_id;
        const desc = s?.desc || f.label?.desc || "";
        return `
          <div class="favorite-card" data-strategy-id="${f.ref_id}">
            <div class="icon">📚</div>
            <div class="info">
              <div class="title">${escapeHtml(name)}</div>
              <div class="meta">${escapeHtml(desc)}</div>
            </div>
            <button class="unfav" data-unfav-kind="strategy" data-unfav-ref="${f.ref_id}">取消收藏</button>
          </div>`;
      }).join("");
      this.listEl.querySelectorAll(".favorite-card").forEach(card => {
        card.addEventListener("click", ev => {
          if (ev.target.dataset.unfavKind) return;
          document.querySelector('nav.tabs button[data-tab="library"]').click();
          setTimeout(() => {
            const sCard = document.querySelector(`.strategy-card[data-id="${card.dataset.strategyId}"]`);
            if (sCard) { sCard.scrollIntoView({ block: "center" }); sCard.classList.add("expanded"); }
          }, 100);
        });
      });
    } else if (this.activeTab === "decision") {
      this.listEl.innerHTML = items.map(f => {
        const lbl = f.label || {};
        return `
          <div class="favorite-card" data-decision-id="${f.ref_id}">
            <div class="icon">🎯</div>
            <div class="info">
              <div class="title">${escapeHtml(lbl.ticker || f.ref_id)} · ${escapeHtml(lbl.rating || "—")}</div>
              <div class="meta">${escapeHtml(lbl.trade_date || "")}  ·  收藏于 ${new Date(f.created_at).toLocaleString()}</div>
            </div>
            <button class="unfav" data-unfav-kind="decision" data-unfav-ref="${f.ref_id}">取消收藏</button>
          </div>`;
      }).join("");
      this.listEl.querySelectorAll(".favorite-card").forEach(card => {
        card.addEventListener("click", async ev => {
          if (ev.target.dataset.unfavKind) return;
          const id = card.dataset.decisionId;
          const entry = await History.getEntry(id);
          if (!entry) { alert("找不到原始决策（可能已删除）"); return; }
          document.querySelector('nav.tabs button[data-tab="decisions"]').click();
          DecisionsPage.openHistorical(entry);
        });
      });
    } else if (this.activeTab === "opportunity") {
      const sevEmoji = { critical: "🔴", high: "🟠", watch: "🟡", info: "⚪" };
      this.listEl.innerHTML = items.map(f => {
        const lbl = f.label || {};
        const sev = sevEmoji[lbl.severity] || "⚪";
        return `
          <div class="favorite-card" data-opp-id="${f.ref_id}">
            <div class="icon">${sev}</div>
            <div class="info">
              <div class="title">${escapeHtml(lbl.ticker || lbl.type || f.ref_id)}</div>
              <div class="meta">${escapeHtml(lbl.headline || "")}  ·  收藏于 ${new Date(f.created_at).toLocaleString()}</div>
            </div>
            <button class="unfav" data-unfav-kind="opportunity" data-unfav-ref="${f.ref_id}">取消收藏</button>
          </div>`;
      }).join("");
      this.listEl.querySelectorAll(".favorite-card").forEach(card => {
        card.addEventListener("click", async ev => {
          if (ev.target.dataset.unfavKind) return;
          // Jump to 24h opportunities tab and try to scroll to the same id
          document.querySelector('nav.tabs button[data-tab="opportunities"]').click();
        });
      });
    }
    this.listEl.querySelectorAll("[data-unfav-kind]").forEach(btn => {
      btn.addEventListener("click", async ev => {
        ev.stopPropagation();
        await Favorites.remove(btn.dataset.unfavKind, btn.dataset.unfavRef);
      });
    });
  },

  /** Render the pinned comprehensive_reports (collected by ComprehensiveReports.listPinned).
   *  Re-fetches the pinned list every time we render so pin/unpin done on the
   *  自选 page is reflected immediately without a hard refresh. */
  async _renderCompReports() {
    // Refresh the in-memory list from the persistence layer (localStorage +
    // Supabase merged). Avoid blocking the very first paint — show whatever
    // we have now, then re-render once the listPinned call returns.
    try {
      if (window.ComprehensiveReports) {
        const fresh = await window.ComprehensiveReports.listPinned(200);
        if (Array.isArray(fresh)) {
          this.compReports = fresh;
          this._updateCounts();
        }
      }
    } catch (e) { console.warn("[favorites] listPinned crash", e); }
    const items = this.compReports || [];
    if (!items.length) {
      this.listEl.innerHTML = `<div class="muted" style="padding:32px; text-align:center;">
        还没有收藏任何综合报告。<br>
        <span style="font-size:12px;">在「⭐ 自选」页面打开某个标的，点击综合报告右上角的「☆ 收藏」按钮即可加入此处。</span>
      </div>`;
      return;
    }
    // Map raw model IDs ("deepseek-chat", "claude-opus-4-7") to friendly
    // labels for display. Mirrors _prettyModel in comprehensive.js.
    const prettyModel = (raw) => {
      if (!raw) return "";
      const direct = {
        "claude-opus-4-7": "Claude Opus 4.7", "claude-sonnet-4-6": "Claude Sonnet 4.6",
        "claude-haiku-4-5": "Claude Haiku 4.5",
        "deepseek-chat": "DeepSeek V3", "deepseek-reasoner": "DeepSeek R1",
        "gpt-5.4-mini": "GPT-5.4 Mini", "gpt-5.5": "GPT-5.5",
        "gemini-3.1-flash": "Gemini 3.1 Flash", "gemini-3.1-pro": "Gemini 3.1 Pro",
        "qwen-plus": "Qwen Plus", "qwen-max": "Qwen Max",
        "moonshot-v1-32k": "Kimi 32k", "glm-4.7-flash": "GLM 4.7 Flash",
      };
      return direct[raw] || raw;
    };
    this.listEl.innerHTML = items.map(r => {
      const headline = r.sections?.meta?.headline || r.sections?.intro?.narrative_shift || "—";
      const ticker = r.ticker || "—";
      const model = r.model || "";
      const dc = r.decisions_count || 0;
      const ts = r.generated_at ? new Date(r.generated_at).toLocaleString() : "—";
      const conviction = r.sections?.meta?.conviction
        ? `<span class="fav-comp-conviction conv-${escapeHtml(r.sections.meta.conviction)}">${escapeHtml({high:"高把握",medium:"中等",low:"弱信号"}[r.sections.meta.conviction] || r.sections.meta.conviction)}</span>`
        : "";
      const modelLabel = model ? `${escapeHtml(prettyModel(model))} · ` : "";
      return `
        <div class="favorite-card fav-comp-card" data-comp-id="${escapeHtml(r.id)}" data-comp-ticker="${escapeHtml(ticker)}">
          <div class="icon">📊</div>
          <div class="info">
            <div class="title">
              <span class="fav-comp-ticker">${escapeHtml(ticker)}</span>
              ${conviction}
              <span class="muted" style="font-size:11px;">${modelLabel}${dc} 次决策</span>
            </div>
            <div class="fav-comp-headline">${escapeHtml(headline)}</div>
            <div class="meta">收藏于 ${escapeHtml(ts)}</div>
          </div>
          <button class="unfav" data-unpin-comp="${escapeHtml(r.id)}">取消收藏</button>
        </div>`;
    }).join("");
    // Click a card → switch to 自选, select that ticker, switch to that version.
    this.listEl.querySelectorAll(".fav-comp-card").forEach(card => {
      card.addEventListener("click", async ev => {
        if (ev.target.dataset.unpinComp) return;
        const ticker = card.dataset.compTicker;
        const compId = card.dataset.compId;
        await Favorites._openCompReport(ticker, compId);
      });
    });
    this.listEl.querySelectorAll("[data-unpin-comp]").forEach(btn => {
      btn.addEventListener("click", async ev => {
        ev.stopPropagation();
        const id = btn.dataset.unpinComp;
        if (window.ComprehensiveReports) {
          await window.ComprehensiveReports.setPinned(id, false);
        }
        await Favorites.refresh();
      });
    });
  },

  /** Navigate from the favorites page to a specific comp report. */
  async _openCompReport(ticker, versionId) {
    const tu = (ticker || "").toUpperCase();
    if (!tu) return;
    // 1) Switch to 自选 tab.
    const wlTabBtn = document.querySelector('nav.tabs button[data-tab="watchlist"]');
    if (wlTabBtn) wlTabBtn.click();
    // 2) Find or auto-add the watchlist entry for this ticker.
    const wl = window._appWatchlist || (typeof Watchlist !== "undefined" ? Watchlist : null);
    if (!wl) return;
    let entry = (wl.cache || []).find(e => (e.ticker || "").toUpperCase() === tu);
    if (!entry) {
      // The user pinned a report for a ticker they later removed. Re-add it
      // silently so we can render. (Local-only when anonymous.)
      try {
        if (window.Watchlist && window.Auth?.isSignedIn?.()) {
          const r = await window.Watchlist.add({ ticker: tu });
          if (r && r.row) entry = r.row;
        }
      } catch (e) { /* non-fatal */ }
      if (!entry) {
        // Synthesise a local entry so the panel can render.
        entry = { id: "fav-" + tu, ticker: tu, display_name: null, market: wl._detectMarket?.(tu) || "other" };
        wl.cache = [entry, ...(wl.cache || [])];
      }
    }
    // 3) Select the entry and pre-set the comp-report version.
    if (window.ComprehensiveReport) {
      await window.ComprehensiveReport.selectVersion(tu, versionId);
    }
    wl.selectedId = entry.id;
    if (typeof wl.render === "function") wl.render();
    // 4) Scroll the comp block into view after the panel re-renders.
    setTimeout(() => {
      const mount = document.querySelector(`.wl-comp-mount[data-ticker="${tu}"], .wl-comp-mount`);
      if (mount) mount.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 150);
  },
};

// =========================================================================
// Profile — 资料 / 用量 / 设置 sub-tabs
// =========================================================================
const Profile = {
  // ── settings: data-source vendor keys
  DATA_KEYS: [
    { id: "FINNHUB_API_KEY",          label: "Finnhub Pro",          dash: "https://finnhub.io/dashboard" },
    { id: "POLYGON_API_KEY",          label: "Polygon.io",           dash: "https://polygon.io/dashboard" },
    { id: "ALPHA_VANTAGE_API_KEY",    label: "Alpha Vantage Premium",dash: "https://www.alphavantage.co/account/" },
    { id: "FMP_API_KEY",              label: "FMP Premium",          dash: "https://site.financialmodelingprep.com/dashboard" },
    { id: "NASDAQ_DATA_LINK_API_KEY", label: "Nasdaq Data Link",     dash: "https://data.nasdaq.com/account/profile" },
    { id: "DASHSCOPE_API_KEY",        label: "Qwen / DashScope (可选: 仅作数据源时)", dash: "https://dashscope.console.aliyun.com" },
    { id: "JQDATA_USERNAME",          label: "JQData (用户名)",       dash: "https://www.joinquant.com/help/api/data-help" },
    { id: "JQDATA_PASSWORD",          label: "JQData (密码)" },
    { id: "RQDATA_USERNAME",          label: "RQData 米筐 (用户名)",  dash: "https://www.ricequant.com/welcome/rqdata" },
    { id: "RQDATA_PASSWORD",          label: "RQData 米筐 (密码)" },
  ],

  // ── settings: LLM provider keys
  LLM_KEYS: [
    { id: "OPENAI_API_KEY",     label: "OpenAI (GPT-5.x)",          dash: "https://platform.openai.com/usage" },
    { id: "ANTHROPIC_API_KEY",  label: "Anthropic (Claude 4.x)",    dash: "https://console.anthropic.com/settings/usage" },
    { id: "GOOGLE_API_KEY",     label: "Google (Gemini 3.x)",       dash: "https://aistudio.google.com" },
    { id: "DEEPSEEK_API_KEY",   label: "DeepSeek (V4)",             dash: "https://platform.deepseek.com/usage" },
    { id: "DASHSCOPE_API_KEY",  label: "Qwen 通义千问 (3.6)",       dash: "https://dashscope.console.aliyun.com" },
    { id: "MOONSHOT_API_KEY",   label: "Kimi (Moonshot K2.6)",      dash: "https://platform.moonshot.cn/console" },
    { id: "ZHIPU_API_KEY",      label: "智谱 GLM (5)",              dash: "https://open.bigmodel.cn/usercenter" },
  ],

  init() {
    // Sub-tab switcher
    document.querySelectorAll(".profile-tab").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll(".profile-tab").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        document.querySelectorAll(".profile-pane").forEach(p => p.classList.remove("active"));
        document.querySelector(`[data-profile-pane="${b.dataset.profileTab}"]`).classList.add("active");
      });
    });

    if (window.Auth) window.Auth.onChange(() => this.renderAll());
    this.renderAll();
  },

  async renderAll() {
    await Promise.all([
      this.renderInfo(),
      this.renderPasswordChange(),
      this.renderUsage(),
      this.renderDataKeys(),
      this.renderLlmKeys(),
      this.renderPrefs(),
      this.fetchDataflows(),
    ]);
  },

  // ────────────────────────────────────────────── 资料 (修改密码)
  renderPasswordChange() {
    const el = document.getElementById("profile-password");
    if (!el) return;
    if (!window.Auth || !window.Auth.isSignedIn()) {
      el.innerHTML = `<div class="muted" style="padding:12px 0;">登录后可修改密码。</div>`;
      return;
    }
    el.innerHTML = `
      <div class="pwd-form" style="display:grid; gap:8px; max-width:360px;">
        <label style="font-size:12px;">当前密码
          <input type="password" id="pwd-current" autocomplete="current-password" />
        </label>
        <label style="font-size:12px;">新密码（至少 6 位）
          <input type="password" id="pwd-new" autocomplete="new-password" />
        </label>
        <label style="font-size:12px;">确认新密码
          <input type="password" id="pwd-confirm" autocomplete="new-password" />
        </label>
        <div style="display:flex; gap:8px; align-items:center; margin-top:4px;">
          <button class="btn primary small" id="pwd-submit">更新密码</button>
          <span class="muted" id="pwd-status" style="font-size:12px;"></span>
        </div>
      </div>
    `;
    document.getElementById("pwd-submit").addEventListener("click", async () => {
      const cur  = document.getElementById("pwd-current").value;
      const nw   = document.getElementById("pwd-new").value;
      const conf = document.getElementById("pwd-confirm").value;
      const status = document.getElementById("pwd-status");
      const btn = document.getElementById("pwd-submit");
      status.style.color = "";
      if (!cur)               { status.style.color = "var(--danger)"; status.textContent = "请输入当前密码"; return; }
      if (nw.length < 6)      { status.style.color = "var(--danger)"; status.textContent = "新密码至少 6 位"; return; }
      if (nw !== conf)        { status.style.color = "var(--danger)"; status.textContent = "两次新密码不一致"; return; }
      if (nw === cur)         { status.style.color = "var(--danger)"; status.textContent = "新密码不能与当前密码相同"; return; }
      btn.disabled = true; status.textContent = "更新中…";
      try {
        await window.Auth.updatePassword(cur, nw);
        status.style.color = "var(--success)"; status.textContent = "✓ 已更新";
        document.getElementById("pwd-current").value = "";
        document.getElementById("pwd-new").value = "";
        document.getElementById("pwd-confirm").value = "";
      } catch (e) {
        status.style.color = "var(--danger)";
        status.textContent = `失败：${e.message || e}`;
      } finally {
        btn.disabled = false;
        setTimeout(() => { if (status.textContent.startsWith("✓")) status.textContent = ""; }, 3000);
      }
    });
  },

  // ────────────────────────────────────────────── 资料 (info)
  async renderInfo() {
    const el = document.getElementById("profile-info");
    if (!el) return;
    if (!window.Auth || !window.Auth.isSignedIn()) {
      el.innerHTML = `<div class="muted" style="padding:12px 0;">未登录 — 请右上角登录后管理账号、保存 API key、查看历史与用量。</div>`;
      ["stat-decisions", "stat-favorites", "stat-pinned", "stat-rated"].forEach(id => {
        const e = document.getElementById(id); if (e) e.textContent = "—";
      });
      return;
    }
    const u = window.Auth.user();
    let profile = null;
    try {
      const { data } = await window.Auth.rawClient().from("profiles").select("*").eq("id", u.id).single();
      profile = data;
    } catch {}
    const dn = profile?.display_name || u.user_metadata?.display_name || "";
    el.innerHTML = `
      <dl>
        <dt>邮箱</dt><dd>${escapeHtml(u.email || "")}</dd>
        <dt>显示名称</dt>
        <dd>
          <input type="text" id="profile-display-name" value="${escapeHtml(dn)}" />
          <button class="btn secondary small" id="profile-save-name" style="margin-left:6px;">保存</button>
          <span class="muted" id="profile-save-status" style="font-size:11px; margin-left:6px;"></span>
        </dd>
        <dt>注册时间</dt><dd>${new Date(u.created_at).toLocaleString()}</dd>
        <dt>用户 ID</dt><dd style="font-family:monospace; font-size:11px; word-break:break-all;">${escapeHtml(u.id)}</dd>
      </dl>
    `;
    document.getElementById("profile-save-name").addEventListener("click", async () => {
      const name = document.getElementById("profile-display-name").value.trim();
      const status = document.getElementById("profile-save-status");
      const { error } = await window.Auth.rawClient().from("profiles").upsert({ id: u.id, display_name: name });
      status.textContent = error ? `失败: ${error.message}` : "✓ 已保存";
      if (!error) AuthUI.renderStatus();
      setTimeout(() => status.textContent = "", 2000);
    });
    // Activity stats from cached History + Favorites
    document.getElementById("stat-decisions").textContent = History.cache.length;
    document.getElementById("stat-favorites").textContent = Favorites.cache.length;
    document.getElementById("stat-pinned").textContent    = History.cache.filter(e => e.pinned).length;
    document.getElementById("stat-rated").textContent     = History.cache.filter(e => (e.user_rating || 0) > 0).length;
  },

  // ────────────────────────────────────────────── 用量 (usage)
  /**
   * Fetch the backend's per-model price table once per session and
   * cache it. Returned shape: { provider: [{model, input_per_1m_usd,
   * output_per_1m_usd}] }. Returns {} if the fetch fails so callers can
   * still render a degraded UI ("—" for cost).
   */
  async _fetchCostTable() {
    if (this._costTableCache) return this._costTableCache;
    try {
      const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
      const r = await fetch(`${apiBase}/api/cost-table`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this._costTableCache = await r.json();
    } catch (e) {
      console.warn("cost-table fetch failed:", e);
      this._costTableCache = {};
    }
    return this._costTableCache;
  },

  /**
   * Look up the per-1M USD prices for a (provider, model) pair against
   * a cost-table object (shape returned by _fetchCostTable). Mirrors
   * the longest-prefix-wins logic of backend/cost_table.py so the
   * front-end and back-end agree on cost numbers.
   */
  _lookupPrice(costTable, provider, model) {
    const p = (provider || "").toLowerCase();
    const m = (model || "").toLowerCase();
    const rows = costTable[p] || [];
    let best = null;
    for (const row of rows) {
      const mp = (row.model || "").toLowerCase();
      if (m.startsWith(mp) && (!best || mp.length > best.model.length)) {
        best = { model: mp, input: row.input_per_1m_usd, output: row.output_per_1m_usd };
      }
    }
    return best;
  },

  /**
   * Format a USD amount for the .cost column. Returns "—" if the price
   * lookup failed (unknown model) so the user sees a clear "no data"
   * marker rather than a misleading $0.00.
   */
  _formatCost(usd) {
    if (usd === null || usd === undefined) return "—";
    if (usd === 0) return "$0.00";
    if (usd < 0.01) return "<$0.01";
    return `$${usd.toFixed(2)}`;
  },

  async renderUsage() {
    const llmEl = document.getElementById("usage-llm");
    const dataEl = document.getElementById("usage-data");
    if (!llmEl || !dataEl) return;

    if (!window.Auth || !window.Auth.isSignedIn()) {
      llmEl.innerHTML = `<div class="muted" style="padding:12px 0;">登录后查看决策中的模型使用频次。</div>`;
      dataEl.innerHTML = `<div class="muted" style="padding:12px 0;">登录后查看数据源调用频次估算。</div>`;
      return;
    }

    // Tally LLM usage from decisions.params.llm_provider in last 90d
    const llmCounts = {};
    const dataCounts = { news: 0, market: 0, fundamentals: 0, social: 0 };
    const cutoff = Date.now() - 90 * 86400 * 1000;
    for (const e of History.cache) {
      const ts = new Date(e.completedAt || e.startedAt).getTime();
      if (ts < cutoff) continue;
      const p = (e.params || {}).llm_provider || "unknown";
      llmCounts[p] = (llmCounts[p] || 0) + 1;
      // every LIVE decision triggers ~4 dataflow calls (one per analyst)
      Object.keys(dataCounts).forEach(c => { dataCounts[c] += 1; });
    }

    // Fetch the cost table + sum tokens per provider over the last 90d
    // so each row can show a $-cost estimate alongside the call count.
    // We try Supabase first (the system-of-record once usage_events is
    // flushed there), and fall back to History.cache if the query
    // fails or returns no rows (e.g. RLS not yet provisioned).
    const costTable = await this._fetchCostTable();
    const cutoffIso = new Date(cutoff).toISOString();
    const usageByProv = {};   // provId -> [{model, tokens_in, tokens_out}]
    let usedSupabase = false;
    if (window.Auth?.rawClient) {
      try {
        const { data, error } = await window.Auth.rawClient()
          .from("usage_events")
          .select("provider, model, tokens_in, tokens_out")
          .eq("kind", "llm_call")
          .gte("ts", cutoffIso);
        if (!error && Array.isArray(data)) {
          usedSupabase = true;
          for (const row of data) {
            const pid = (row.provider || "unknown").toLowerCase();
            (usageByProv[pid] ||= []).push({
              model: row.model || "",
              tokens_in: row.tokens_in || 0,
              tokens_out: row.tokens_out || 0,
            });
          }
        }
      } catch (e) {
        console.warn("usage_events query failed, falling back to cache:", e);
      }
    }
    if (!usedSupabase) {
      // Walk History.cache for entries' runState.usage_events. Same
      // aggregation shape as the Supabase branch above.
      for (const e of History.cache) {
        const ts = new Date(e.completedAt || e.startedAt).getTime();
        if (ts < cutoff) continue;
        const events = (e.runState && e.runState.usage_events) || [];
        for (const ev of events) {
          if (ev.kind && ev.kind !== "llm_call") continue;
          const pid = (ev.provider || "unknown").toLowerCase();
          (usageByProv[pid] ||= []).push({
            model: ev.model || "",
            tokens_in: ev.tokens_in || 0,
            tokens_out: ev.tokens_out || 0,
          });
        }
      }
    }

    // Sum cost per provider. If every event in a provider lacks pricing
    // data we render "—"; otherwise we render the partial sum (unknown
    // models contribute $0 and we silently skip them).
    const costByProv = {};
    for (const [pid, events] of Object.entries(usageByProv)) {
      let total = 0;
      let priced = 0;
      for (const ev of events) {
        const price = this._lookupPrice(costTable, pid, ev.model);
        if (!price) continue;
        priced += 1;
        total += (ev.tokens_in / 1_000_000) * price.input
               + (ev.tokens_out / 1_000_000) * price.output;
      }
      costByProv[pid] = priced > 0 ? total : null;
    }

    const llmRows = this.LLM_KEYS.map(p => {
      const k = p.id.replace(/_API_KEY$/, "").toLowerCase();
      // map env → provider id used in /api/config
      const provMap = {
        openai_api_key: "openai", anthropic_api_key: "anthropic",
        google_api_key: "google", deepseek_api_key: "deepseek",
        dashscope_api_key: "qwen", moonshot_api_key: "kimi", zhipu_api_key: "glm",
      };
      const provId = provMap[p.id.toLowerCase()] || k;
      const count = llmCounts[provId] || 0;
      const cost = this._formatCost(costByProv[provId]);
      return `
        <div class="usage-row">
          <span class="icon">🧠</span>
          <div>
            <div class="name">${escapeHtml(p.label)}</div>
            <div class="meta">用作 deep / quick 模型 · 近 90 天 ${count} 次决策</div>
          </div>
          <div class="count">${count}</div>
          <div class="cost">${cost}</div>
          ${p.dash ? `<a class="dash-link" href="${p.dash}" target="_blank" rel="noopener">vendor 用量 ↗</a>` : `<span></span>`}
        </div>`;
    }).join("");
    llmEl.innerHTML = llmRows;

    const dataRows = Object.entries(dataCounts).map(([cat, n]) => `
      <div class="usage-row">
        <span class="icon">${ {market:"📈", news:"📰", fundamentals:"💼", social:"💬"}[cat] || "📊"}</span>
        <div>
          <div class="name">${cat}</div>
          <div class="meta">分析师调用估算（每次 LIVE 决策 ×1）</div>
        </div>
        <div class="count">${n}</div>
        <span></span>
        <span></span>
      </div>`).join("");
    dataEl.innerHTML = dataRows;
  },

  // ────────────────────────────────────────────── 设置: data API keys
  renderDataKeys() {
    const el = document.getElementById("settings-data-keys");
    if (!el) return;
    if (!window.Auth || !window.Auth.isSignedIn()) {
      el.innerHTML = `<div class="muted" style="padding:8px 0; font-size:13px;">登录后可保存数据源 API key（云端同步）。</div>`;
      return;
    }
    el.innerHTML = this.DATA_KEYS.map(k => this._keyRow(k, "data")).join("");
    this._loadKeys("data");
    el.querySelectorAll("[data-save-key]").forEach(btn => {
      btn.addEventListener("click", () => this._saveKey(btn.dataset.saveKey, "data"));
    });
  },

  // ────────────────────────────────────────────── 设置: LLM API keys
  renderLlmKeys() {
    const el = document.getElementById("settings-llm-keys");
    if (!el) return;
    if (!window.Auth || !window.Auth.isSignedIn()) {
      el.innerHTML = `<div class="muted" style="padding:8px 0; font-size:13px;">登录后可保存大模型 API key（云端同步）。</div>`;
      return;
    }
    el.innerHTML = this.LLM_KEYS.map(k => this._keyRow(k, "llm")).join("");
    this._loadKeys("llm");
    el.querySelectorAll("[data-save-key]").forEach(btn => {
      btn.addEventListener("click", () => this._saveKey(btn.dataset.saveKey, "llm"));
    });
  },

  _keyRow(k, kind) {
    const dashLink = k.dash ? ` <a href="${k.dash}" target="_blank" rel="noopener" class="dash-link" style="margin-left:4px;">用量 ↗</a>` : "";
    return `
      <div class="api-key-row" data-kind="${kind}">
        <span class="label-col">${escapeHtml(k.label)}${dashLink}</span>
        <input type="password" placeholder="${escapeHtml(k.id)}" data-api-key="${k.id}" data-kind="${kind}" autocomplete="off" />
        <button class="btn secondary save-btn" data-save-key="${k.id}" data-kind="${kind}">保存</button>
        <span class="status" data-key-status="${k.id}"></span>
      </div>`;
  },

  _columnFor(kind) {
    return kind === "llm" ? "llm_api_keys" : "custom_api_keys";
  },

  async _loadKeys(kind) {
    if (!window.Auth?.isSignedIn()) return;
    const u = window.Auth.user();
    const col = this._columnFor(kind);
    try {
      const { data } = await window.Auth.rawClient().from("profiles").select(col).eq("id", u.id).single();
      const keys = (data || {})[col] || {};
      const list = (kind === "llm" ? this.LLM_KEYS : this.DATA_KEYS);
      list.forEach(k => {
        const inp = document.querySelector(`[data-api-key="${k.id}"][data-kind="${kind}"]`);
        const stat = document.querySelector(`[data-key-status="${k.id}"]`);
        if (inp && keys[k.id]) {
          inp.value = "•".repeat(8);
          inp.dataset.hasValue = "1";
          if (stat) stat.textContent = "✓";
        }
      });
    } catch (e) { console.warn("load keys", kind, e); }
  },

  async _saveKey(envName, kind) {
    const inp = document.querySelector(`[data-api-key="${envName}"][data-kind="${kind}"]`);
    const stat = document.querySelector(`[data-key-status="${envName}"]`);
    const value = inp.value;
    if (!value || value.startsWith("•")) { stat.textContent = "—"; return; }
    const u = window.Auth.user();
    const client = window.Auth.rawClient();
    const col = this._columnFor(kind);
    try {
      const { data } = await client.from("profiles").select(col).eq("id", u.id).single();
      const keys = (data || {})[col] || {};
      keys[envName] = value;
      const update = { id: u.id }; update[col] = keys;
      const { error } = await client.from("profiles").upsert(update);
      stat.textContent = error ? `❌ ${error.message.slice(0, 30)}` : "✓";
      if (!error) {
        inp.value = "•".repeat(8);
        inp.dataset.hasValue = "1";
      }
    } catch (e) { stat.textContent = `❌ ${e.message}`; }
  },

  // ────────────────────────────────────────────── 设置: prefs
  async renderPrefs() {
    const el = document.getElementById("settings-prefs");
    if (!el) return;
    if (!window.Auth || !window.Auth.isSignedIn()) {
      el.innerHTML = `<div class="muted" style="padding:8px 0; font-size:13px;">登录后保存默认 LLM 提供商、研究深度等偏好。</div>`;
      return;
    }
    el.innerHTML = `
      <div class="muted" style="font-size:12px; margin-bottom:8px;">这些偏好作为新决策的默认值（保存到 <code>profiles.settings.prefs</code>）。</div>
      <div class="api-key-row" style="grid-template-columns: 120px 1fr auto;">
        <span class="label-col">主题</span>
        <select id="pref-theme">
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
        <button class="btn secondary save-btn" id="prefs-save-btn">保存所有偏好</button>
      </div>
      <div class="api-key-row" style="grid-template-columns: 120px 1fr auto;">
        <span class="label-col">默认研究深度</span>
        <select id="pref-depth">
          <option value="1">1 轮（快速）</option>
          <option value="2">2 轮</option>
          <option value="3">3 轮</option>
          <option value="5">5 轮（极致）</option>
        </select>
        <span></span>
      </div>
      <span id="prefs-save-status" class="muted" style="font-size:11px;"></span>
    `;
    // load existing prefs
    const u = window.Auth.user();
    try {
      const { data } = await window.Auth.rawClient().from("profiles").select("settings, theme").eq("id", u.id).single();
      const prefs = (data?.settings || {}).prefs || {};
      document.getElementById("pref-theme").value = data?.theme || prefs.theme || "light";
      document.getElementById("pref-depth").value = String(prefs.research_depth || 1);
    } catch {}
    document.getElementById("prefs-save-btn").addEventListener("click", async () => {
      const theme = document.getElementById("pref-theme").value;
      const depth = parseInt(document.getElementById("pref-depth").value, 10) || 1;
      const status = document.getElementById("prefs-save-status");
      const { data } = await window.Auth.rawClient().from("profiles").select("settings").eq("id", u.id).single();
      const settings = data?.settings || {};
      settings.prefs = Object.assign({}, settings.prefs || {}, { theme, research_depth: depth });
      const { error } = await window.Auth.rawClient().from("profiles").upsert({ id: u.id, settings, theme });
      status.textContent = error ? `失败: ${error.message}` : "✓ 已保存";
      if (!error) { Theme.set(theme); }
      setTimeout(() => status.textContent = "", 2000);
    });
  },

  async fetchDataflows() {
    const el = document.getElementById("dataflows-status");
    if (!el) return;
    try {
      const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
      const r = await fetch(`${apiBase}/api/dataflows`);
      const data = await r.json();
      const rows = [];
      Object.entries(data).forEach(([cat, vendors]) => {
        if (!vendors.length) {
          rows.push(`<div class="dataflow-row"><span class="cat">${cat}</span><span class="vendor">未注册</span><span class="status miss">—</span></div>`);
        } else {
          vendors.forEach(v => {
            rows.push(`
              <div class="dataflow-row">
                <span class="cat">${cat}</span>
                <span class="vendor">${escapeHtml(v.display_name)} <code style="font-size:10px;">${v.api_key_env}</code></span>
                <span class="status ${v.configured ? "ok" : "miss"}">${v.configured ? "已配置" : "未配置"}</span>
              </div>`);
          });
        }
      });
      el.innerHTML = rows.join("");
    } catch (e) {
      el.innerHTML = `<div class="muted" style="font-size:12px;">无法连接后端</div>`;
    }
  },
};

// =========================================================================
// Bootstrap
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
  Theme.init();
  initTabs();
  initLibrary();
  initDecisionForm();

  // Wait for Supabase JS to be loaded (or skipped, if not configured).
  // auth.js triggers `supabase-ready` either way.
  await new Promise(resolve => {
    if (window.supabase || !window.APP_CONFIG?.SUPABASE_URL) return resolve();
    window.addEventListener("supabase-ready", resolve, { once: true });
  });

  // Init auth + UI + history (in order so History sees the auth state).
  // DecisionsPage.init() must come AFTER History.init() so its first
  // render() sees the loaded cache, not an empty array.
  if (window.Auth) await window.Auth.init();
  AuthUI.init();
  await History.init();
  Favorites.init();
  DecisionsPage.init();
  Watchlist.init();
  Opportunities.init();
  Profile.init();

  // Default landing tab is the homepage. Router.init() already painted
  // the correct tab based on the URL — no autoclick needed here.
});

// History.save needs to be async-safe — DecisionWindow calls it on complete
async function saveHistorySafely(window_) {
  try { await History.save(window_); } catch (e) { console.error("history save", e); }
}
