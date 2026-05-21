/* =========================================================================
   Comprehensive Report — frontend layer for the 自选 page 综合报告 module.

   Flow:
     1. Watchlist._renderMain() calls ComprehensiveReport.attach(entry, container)
     2. attach() reads the cached row from Supabase (or local fallback),
        renders it, and exposes a manual 重新生成 button.
     3. After a new decision lands (case "complete" in WindowState),
        ComprehensiveReport.autoRegenerate(ticker) fires-and-forgets.
        It collects the user's decisions for the ticker, POSTs to
        /api/comprehensive-report/generate, then persists the result.
     4. While generating, the UI shows a skeleton + "正在生成…" hint.
   ========================================================================= */

(function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const fmtTime = (iso) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); }
    catch { return iso; }
  };

  const signalChip = (sig) => {
    const map = {
      bullish:  { cls: "comp-sig-bull",    label: "看多" },
      bearish:  { cls: "comp-sig-bear",    label: "看空" },
      neutral:  { cls: "comp-sig-neutral", label: "中性" },
      mixed:    { cls: "comp-sig-mixed",   label: "分歧" },
      range_bound: { cls: "comp-sig-neutral", label: "震荡" },
    };
    const k = (sig || "").toLowerCase();
    const it = map[k] || { cls: "comp-sig-neutral", label: sig || "—" };
    return `<span class="comp-sig-chip ${it.cls}">${esc(it.label)}</span>`;
  };

  const trendChip = (t) => signalChip(t);

  const convChip = (c) => {
    const k = (c || "").toLowerCase();
    const label = { high: "高把握", medium: "中等", low: "弱信号" }[k] || c || "—";
    return `<span class="comp-conv-chip comp-conv-${esc(k)}">${esc(label)}</span>`;
  };

  const _inflight = new Set();

  const ComprehensiveReport = {

    async attach(entry, container) {
      if (!entry || !container) return;
      const ticker = (entry.ticker || "").toUpperCase();
      container.dataset.ticker = ticker;
      container.innerHTML = this._skeletonHTML("加载综合报告…");
      try {
        const row = window.ComprehensiveReports
          ? await window.ComprehensiveReports.get(ticker)
          : null;
        if (container.dataset.ticker !== ticker) return;
        container.innerHTML = this._renderHTML(ticker, row);
        this._wire(entry, container);
      } catch (e) {
        console.warn("comp-report attach failed", e);
        container.innerHTML = this._renderHTML(ticker, null);
        this._wire(entry, container);
      }
    },

    autoRegenerate(ticker) {
      const tu = (ticker || "").toUpperCase();
      if (!tu) return;
      this.regenerate(tu).catch(e => console.warn("auto-regen failed", e));
    },

    async regenerate(ticker, { silent = false } = {}) {
      const tu = (ticker || "").toUpperCase();
      if (!tu) return null;
      if (_inflight.has(tu)) {
        if (!silent) console.info(`comp-report: regen already in-flight for ${tu}`);
        return null;
      }
      _inflight.add(tu);

      try {
        if (window.ComprehensiveReports) await window.ComprehensiveReports.markGenerating(tu);
        this._refreshIfVisible(tu);
      } catch (e) { /* non-fatal */ }

      try {
        const decisions = await this._collectDecisions(tu);
        if (!decisions.length) {
          if (!silent) alert(`${tu}: 还没有任何历史决策，无法生成综合报告。先跑一次决策吧。`);
          return null;
        }

        const quote = this._latestQuote(tu);
        const cfg = (window.APP_CONFIG_CACHED && window.APP_CONFIG_CACHED.defaults) || {};

        const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
        const headers = { "Content-Type": "application/json" };
        if (window.Auth && window.Auth.accessToken && window.Auth.accessToken()) {
          headers["Authorization"] = "Bearer " + window.Auth.accessToken();
        }
        const resp = await fetch(`${apiBase}/api/comprehensive-report/generate`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ticker: tu,
            decisions,
            quote,
            llm_provider: cfg.llm_provider || "",
            deep_model: cfg.deep_think_llm || "",
          }),
        });

        if (!resp.ok) {
          const errBody = await resp.json().catch(() => ({}));
          const msg = errBody.error || `HTTP ${resp.status}`;
          if (window.ComprehensiveReports) {
            await window.ComprehensiveReports.upsert(tu, {
              sections: {}, status: "error", error_message: msg,
              decisions_count: decisions.length,
              decision_ids: decisions.map(d => d.id),
            });
          }
          if (!silent) console.warn(`comp-report ${tu} failed:`, msg);
          this._refreshIfVisible(tu);
          return null;
        }

        const data = await resp.json();
        const report = data.report || {};
        const saved = window.ComprehensiveReports
          ? await window.ComprehensiveReports.upsert(tu, {
              sections: report,
              model: report._model || "",
              decision_ids: decisions.map(d => d.id),
              decisions_count: decisions.length,
              quote_snapshot: quote || {},
              status: "ready",
              generated_at: new Date().toISOString(),
            })
          : null;
        this._refreshIfVisible(tu);
        return saved;
      } catch (e) {
        console.warn(`comp-report regenerate ${tu} crashed:`, e);
        if (window.ComprehensiveReports) {
          try {
            await window.ComprehensiveReports.upsert(tu, {
              sections: {}, status: "error", error_message: String(e),
            });
          } catch { /* ignore */ }
        }
        this._refreshIfVisible(tu);
        return null;
      } finally {
        _inflight.delete(tu);
      }
    },

    _watchlistUI() {
      // Same caveat as History: window.Watchlist is the Supabase CRUD wrapper
      // (auth.js), NOT the page-UI controller in app.js. Use the duck-typed
      // resolution we set up below.
      try {
        if (typeof Watchlist !== "undefined" && Watchlist && Array.isArray(Watchlist.cache)) {
          return Watchlist;
        }
      } catch (_) { /* unresolved */ }
      return window._appWatchlist || null;
    },

    _refreshIfVisible(ticker) {
      const wl = this._watchlistUI();
      if (!wl || !wl.cache) return;
      const entry = wl.cache.find(e => e.id === wl.selectedId);
      if (entry && (entry.ticker || "").toUpperCase() === ticker.toUpperCase()) {
        if (typeof wl._renderMain === "function") wl._renderMain();
      }
    },

    async _collectDecisions(ticker) {
      // Resolve the app's History object — NOT window.History (which is the
      // browser's built-in). The app declares `const History = {...}` at the
      // top of app.js so a bare reference resolves to it through the realm's
      // global lexical environment. Duck-type for safety in case app.js has
      // not run yet.
      let H = null;
      try {
        if (typeof History !== "undefined" && History && Array.isArray(History.cache)) {
          H = History;
        }
      } catch (_) { /* unresolved reference — fall through */ }
      if (!H && window._appHistory) H = window._appHistory;
      if (!H) return [];
      const stubs = (H.cache || [])
        .filter(e => (e.ticker || "").toUpperCase() === ticker.toUpperCase());
      const full = [];
      for (const stub of stubs) {
        try {
          const entry = await H.getEntry(stub.id);
          if (!entry) continue;
          full.push({
            id: entry.id,
            ticker: entry.ticker,
            trade_date: entry.trade_date,
            rating: entry.rating,
            completedAt: entry.completedAt || entry.startedAt,
            runState: entry.runState || entry.run_state || {},
            params: entry.params || {},
          });
        } catch (e) {
          console.warn("comp-report decision fetch failed", stub.id, e);
        }
      }
      return full;
    },

    _latestQuote(ticker) {
      const wl = this._watchlistUI();
      if (!wl || !wl.quotes) return null;
      return wl.quotes[ticker.toUpperCase()] || null;
    },

    _skeletonHTML(label) {
      return `
        <div class="comp-block">
          <div class="comp-head">
            <h3 class="comp-title">📊 综合报告</h3>
            <span class="comp-skel-dot"></span>
            <span class="comp-skel-msg">${esc(label || "")}</span>
          </div>
          <div class="comp-skel-grid">
            <div class="comp-skel-card"></div>
            <div class="comp-skel-card"></div>
            <div class="comp-skel-card"></div>
            <div class="comp-skel-card"></div>
          </div>
        </div>`;
    },

    _renderHTML(ticker, row) {
      const status = row?.status || "empty";
      const sections = row?.sections || {};
      const gen = row?.generated_at;
      const model = row?.model;

      const isReady = status === "ready" && sections && Object.keys(sections).length > 0;
      const isGenerating = status === "generating";
      const isError = status === "error";

      const headRight = isReady
        ? `<span class="comp-meta">${row?.decisions_count || 0} 次决策 · ${esc(model || "—")} · 更新于 ${esc(fmtTime(gen))}</span>
           <button class="btn secondary tiny comp-regen-btn">↻ 重新生成</button>`
        : isGenerating
          ? `<span class="comp-status-pill comp-pill-gen">⚡ 正在生成…</span>`
          : isError
            ? `<span class="comp-status-pill comp-pill-err" title="${esc(row?.error_message || "")}">⚠ 生成失败</span>
               <button class="btn secondary tiny comp-regen-btn">↻ 重试</button>`
            : `<span class="comp-status-pill comp-pill-empty">尚未生成</span>
               <button class="btn primary tiny comp-regen-btn">⚡ 生成综合报告</button>`;

      const head = `
        <div class="comp-head">
          <h3 class="comp-title">📊 综合报告</h3>
          <div class="comp-head-right">${headRight}</div>
        </div>`;

      let body;
      if (isGenerating) {
        body = `<div class="comp-skel-grid">
                  <div class="comp-skel-card"></div>
                  <div class="comp-skel-card"></div>
                  <div class="comp-skel-card"></div>
                  <div class="comp-skel-card"></div>
                </div>
                <div class="comp-skel-msg" style="text-align:center;margin-top:14px;">正在综合 ${esc(ticker)} 的全部决策，约 30-60 秒…</div>`;
      } else if (isReady) {
        body = `
          ${this._headlineHTML(sections.meta || {}, sections.intro || {}, ticker)}
          ${this._introHTML(sections.intro || {})}
          ${this._dimensionsHTML(sections.dimensions || {})}
          ${this._scenariosHTML(sections.scenarios || {})}
          ${this._horizonsHTML(sections.horizons || {})}
          ${this._footerHTML(row)}
        `;
      } else if (isError) {
        body = `<div class="comp-empty">
          <p>生成综合报告失败：${esc(row?.error_message || "未知错误")}</p>
          <p class="muted" style="font-size:12px;">请检查后端日志或 LLM API Key 配置后重试。</p>
        </div>`;
      } else {
        body = `<div class="comp-empty">
          <p>还没有为 <strong>${esc(ticker)}</strong> 生成综合报告。</p>
          <p class="muted" style="font-size:12px;">点击右上角「⚡ 生成综合报告」即可基于该标的的全部历史决策生成一份多维度研究档案。新决策完成后会自动重新生成。</p>
        </div>`;
      }

      return `<div class="comp-block" data-status="${esc(status)}">${head}${body}</div>`;
    },

    _headlineHTML(meta, intro, ticker) {
      const headline = meta.headline || intro.narrative_shift || "";
      if (!headline && !meta.conviction && !meta.key_debate) return "";
      const conviction = meta.conviction ? convChip(meta.conviction) : "";
      const debate = meta.key_debate
        ? `<div class="comp-headline-debate"><span class="comp-headline-debate-label">核心分歧</span> ${esc(meta.key_debate)}</div>`
        : "";
      return `
        <div class="comp-headline-banner">
          <div class="comp-headline-main">
            <div class="comp-headline-label">PM HEADLINE · ${esc(ticker)}</div>
            <div class="comp-headline-text">${esc(headline)}</div>
          </div>
          ${conviction ? `<div class="comp-headline-side">${conviction}</div>` : ""}
          ${debate}
        </div>`;
    },

    _introHTML(intro) {
      if (!intro || (!intro.what_is_it && !intro.latest_news && !intro.narrative_shift)) {
        return "";
      }
      const name = intro.name_zh
        ? `<div class="comp-intro-name">${esc(intro.name_zh)}</div>` : "";
      return `
        <section class="comp-section comp-intro">
          ${name}
          ${intro.what_is_it ? `<p class="comp-intro-what">${esc(intro.what_is_it)}</p>` : ""}
          ${intro.latest_news ? `
            <div class="comp-intro-news">
              <div class="comp-intro-news-label">📰 最新资讯</div>
              <p>${esc(intro.latest_news)}</p>
            </div>` : ""}
          ${intro.narrative_shift ? `
            <div class="comp-intro-narrative">
              <div class="comp-intro-narrative-label">📈 叙事演变</div>
              <p>${esc(intro.narrative_shift)}</p>
            </div>` : ""}
        </section>`;
    },

    _dimensionsHTML(dims) {
      if (!dims || !Object.keys(dims).length) return "";
      const order = [
        { key: "fundamentals", label: "基本面",   icon: "📊" },
        { key: "news",         label: "新闻",     icon: "📰" },
        { key: "technical",    label: "市场技术", icon: "📈" },
        { key: "sentiment",    label: "情绪",     icon: "🌡️" },
      ];
      const cards = order.map(o => {
        const d = dims[o.key] || {};
        const summary = d.summary || "";
        const hl = (d.highlights || []).map(h => `<li>${esc(h)}</li>`).join("");
        const ev  = d.evolution
          ? `<div class="comp-dim-ev"><span class="comp-dim-ev-label">演化</span> ${esc(d.evolution)}</div>`
          : "";
        return `
          <article class="comp-dim-card comp-dim-${o.key}" data-signal="${esc((d.signal || "").toLowerCase())}">
            <header class="comp-dim-head">
              <span class="comp-dim-icon">${o.icon}</span>
              <span class="comp-dim-label">${o.label}</span>
              ${signalChip(d.signal || "neutral")}
            </header>
            ${summary ? `<p class="comp-dim-summary">${esc(summary)}</p>` : ""}
            ${hl ? `<ul class="comp-dim-list">${hl}</ul>` : ""}
            ${ev}
          </article>`;
      }).join("");
      return `
        <section class="comp-section">
          <h4 class="comp-section-title">🔬 四大维度</h4>
          <div class="comp-dim-grid">${cards}</div>
        </section>`;
    },

    _scenariosHTML(s) {
      if (!s || (!s.base && !s.bull && !s.bear && !(s.checklist || []).length)) return "";
      const order = [
        { key: "bull", label: "🟢 牛市", cls: "comp-scen-bull" },
        { key: "base", label: "🟡 基准", cls: "comp-scen-base" },
        { key: "bear", label: "🔴 熊市", cls: "comp-scen-bear" },
      ];
      const cards = order.map(o => {
        const sc = s[o.key] || {};
        const prob = sc.probability != null
          ? `<span class="comp-scen-prob">${(sc.probability * 100).toFixed(0)}%</span>`
          : "";
        const preds = (sc.falsifiable_predictions || []).map(p => `<li>${esc(p)}</li>`).join("");
        return `
          <div class="comp-scen-card ${o.cls}">
            <div class="comp-scen-head">
              <span class="comp-scen-label">${o.label}</span>
              ${prob}
            </div>
            ${sc.narrative ? `<p class="comp-scen-narrative">${esc(sc.narrative)}</p>` : ""}
            ${preds ? `
              <div class="comp-scen-block">
                <div class="comp-scen-block-label">📌 可证伪预测</div>
                <ul>${preds}</ul>
              </div>` : ""}
            ${sc.invalidation ? `
              <div class="comp-scen-invalidation">
                <span class="comp-scen-invalidation-label">⚠ 失效条件</span>
                <span>${esc(sc.invalidation)}</span>
              </div>` : ""}
          </div>`;
      }).join("");
      const checklist = (s.checklist || []).map(c => `<li>${esc(c)}</li>`).join("");
      return `
        <section class="comp-section">
          <h4 class="comp-section-title">🌳 情景树 · 可证伪预测</h4>
          <div class="comp-scen-grid">${cards}</div>
          ${checklist ? `
            <div class="comp-checklist">
              <div class="comp-checklist-head">✅ 未来观察清单</div>
              <ul>${checklist}</ul>
            </div>` : ""}
        </section>`;
    },

    _horizonsHTML(h) {
      if (!h || (!h.short && !h.mid && !h.long)) return "";
      const order = [
        { key: "short", default_label: "短期 (1-2 个月)", cls: "comp-h-short" },
        { key: "mid",   default_label: "中期 (3-6 个月)", cls: "comp-h-mid" },
        { key: "long",  default_label: "长期 (6 个月以上)", cls: "comp-h-long" },
      ];
      const cards = order.map(o => {
        const hz = h[o.key] || {};
        const risks = (hz.key_risks || []).map(r => `<li>${esc(r)}</li>`).join("");
        return `
          <article class="comp-h-card ${o.cls}">
            <header class="comp-h-head">
              <span class="comp-h-label">${esc(hz.label || o.default_label)}</span>
              ${trendChip(hz.trend || "neutral")}
              ${hz.confidence ? convChip(hz.confidence) : ""}
            </header>
            ${hz.target_price ? `
              <div class="comp-h-target">
                <span class="comp-h-target-label">目标价</span>
                <span class="comp-h-target-value">${esc(hz.target_price)}</span>
              </div>` : ""}
            ${hz.summary ? `<p class="comp-h-summary">${esc(hz.summary)}</p>` : ""}
            ${hz.strategy ? `
              <div class="comp-h-strategy">
                <div class="comp-h-strategy-label">⚙ 执行策略</div>
                <p>${esc(hz.strategy)}</p>
              </div>` : ""}
            ${risks ? `
              <div class="comp-h-risks">
                <div class="comp-h-risks-label">⚠ 关键风险</div>
                <ul>${risks}</ul>
              </div>` : ""}
          </article>`;
      }).join("");
      return `
        <section class="comp-section">
          <h4 class="comp-section-title">⏱ 多周期走势与执行策略</h4>
          <div class="comp-h-grid">${cards}</div>
        </section>`;
    },

    _footerHTML(row) {
      return `
        <footer class="comp-footer muted">
          基于 ${row?.decisions_count || 0} 次历史决策综合生成 · ${esc(row?.model || "—")} · ${esc(fmtTime(row?.generated_at))}
        </footer>`;
    },

    _wire(entry, container) {
      const btn = container.querySelector(".comp-regen-btn");
      if (btn) {
        btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          btn.disabled = true;
          btn.textContent = "⚡ 正在生成…";
          await this.regenerate(entry.ticker);
        });
      }
    },
  };

  window.ComprehensiveReport = ComprehensiveReport;
})();
