/* =========================================================================
   Comprehensive Report — frontend layer for the 自选 page 综合报告 module.

   Behavior (rev 2):
     • Manual-only — no auto-trigger after a decision lands.
     • Each generation creates a NEW history row (migration 0008 drops the
       unique constraint). The user can browse past versions via a dropdown.
     • Live progress: while a generation is in flight we tick an elapsed-seconds
       counter so the UI never looks frozen.
     • Survives Supabase write hiccups — keeps the freshly-generated report in
       the per-ticker `_state` map so the UI shows it immediately even if a
       Supabase round-trip fails.
     • Surfaces backend errors (LLM failure / no key) verbatim into the UI.
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

  const fmtTimeShort = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      return sameDay
        ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" }) + " " +
          d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch { return iso; }
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

  // ---------------- module-level state ----------------------------------

  // ticker → { row, history: [], selectedId, progressTimer, startedAt, elapsed }
  const _state = Object.create(null);

  function _getState(ticker) {
    const k = (ticker || "").toUpperCase();
    if (!_state[k]) _state[k] = { row: null, history: null, selectedId: null, progressTimer: null, startedAt: 0, elapsed: 0 };
    return _state[k];
  }

  // ---------------- main API --------------------------------------------

  const ComprehensiveReport = {

    async attach(entry, container) {
      if (!entry || !container) return;
      const ticker = (entry.ticker || "").toUpperCase();
      container.dataset.ticker = ticker;
      const st = _getState(ticker);

      // Show skeleton only on the very first render for this ticker.
      if (!st.row && !st.history) {
        container.innerHTML = this._skeletonHTML("加载综合报告…");
      }

      let history = [];
      try {
        if (window.ComprehensiveReports) {
          history = await window.ComprehensiveReports.listHistory(ticker, 20) || [];
        }
      } catch (e) {
        console.warn("comp-report listHistory failed", e);
      }

      if (container.dataset.ticker !== ticker) return;

      // Merge fetched history with any in-memory placeholder we created
      // for an in-flight generation (the placeholder may not yet be in
      // Supabase if the row insert failed).
      const inflightPlaceholders = (st.history || []).filter(h =>
        String(h.id || "").startsWith("mem-") && h.status === "generating"
      );
      st.history = [...inflightPlaceholders, ...history.filter(h => !inflightPlaceholders.some(p => p.id === h.id))];

      const supaLatest = history[0] || null;
      if (!st.row || (supaLatest && new Date(supaLatest.generated_at || 0) > new Date(st.row.generated_at || 0))) {
        st.row = supaLatest;
      }
      if (!st.selectedId || !st.history.find(h => h.id === st.selectedId)) {
        st.selectedId = (st.row && st.row.id) || (st.history[0] && st.history[0].id) || null;
      }
      const selected = st.history.find(h => h.id === st.selectedId) || st.row;

      container.innerHTML = this._renderHTML(ticker, selected, st);
      this._wire(entry, container, ticker);
    },

    /** Back-compat shim — auto-trigger removed per UX spec. */
    autoRegenerate(_ticker) { /* intentionally disabled */ },

    async regenerate(ticker) {
      const tu = (ticker || "").toUpperCase();
      if (!tu) return null;
      const st = _getState(tu);
      if (st.progressTimer) {
        console.info(`comp-report: regen already in-flight for ${tu}`);
        return null;
      }

      const decisions = await this._collectDecisions(tu);
      if (!decisions.length) {
        alert(`${tu}: 还没有任何历史决策，无法生成综合报告。请先跑一次决策。`);
        return null;
      }

      // Insert a "generating" placeholder so the UI knows where we are.
      let placeholder = null;
      try {
        if (window.ComprehensiveReports) {
          placeholder = await window.ComprehensiveReports.markGenerating(tu, {
            decisions_count: decisions.length,
            decision_ids: decisions.map(d => d.id),
          });
        }
      } catch (e) { console.warn("comp-report markGenerating failed", e); }

      const memPlaceholder = placeholder || {
        id: "mem-" + Date.now().toString(36),
        ticker: tu, sections: {}, status: "generating",
        decisions_count: decisions.length,
        decision_ids: decisions.map(d => d.id),
        generated_at: new Date().toISOString(),
      };
      st.row = memPlaceholder;
      st.selectedId = memPlaceholder.id;
      st.history = [memPlaceholder, ...(st.history || []).filter(h => h.id !== memPlaceholder.id)];
      st.startedAt = Date.now();
      st.elapsed = 0;
      this._startProgressTimer(tu);
      this._refreshIfVisible(tu);

      const quote = this._latestQuote(tu);
      const cfg = (window.APP_CONFIG_CACHED && window.APP_CONFIG_CACHED.defaults) || {};
      const apiBase = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "";
      const headers = { "Content-Type": "application/json" };
      if (window.Auth && window.Auth.accessToken && window.Auth.accessToken()) {
        headers["Authorization"] = "Bearer " + window.Auth.accessToken();
      }

      try {
        const resp = await fetch(`${apiBase}/api/comprehensive-report/generate`, {
          method: "POST", headers,
          body: JSON.stringify({
            ticker: tu, decisions, quote,
            llm_provider: cfg.llm_provider || "",
            deep_model:   cfg.deep_think_llm || "",
          }),
        });

        const data = await resp.json().catch(() => ({}));

        if (!resp.ok) {
          const msg = data.error || `HTTP ${resp.status}`;
          await this._finishWithError(tu, memPlaceholder.id, msg);
          return null;
        }

        const report = data.report || {};
        const finishedAt = new Date().toISOString();
        const fields = {
          sections: report,
          model: data.model || report._model || "",
          decision_ids: decisions.map(d => d.id),
          decisions_count: decisions.length,
          quote_snapshot: quote || {},
          status: "ready",
          error_message: null,
          generated_at: finishedAt,
        };

        let saved = null;
        try {
          if (window.ComprehensiveReports && memPlaceholder.id && !String(memPlaceholder.id).startsWith("mem-")) {
            saved = await window.ComprehensiveReports.updateRow(memPlaceholder.id, fields);
          }
        } catch (e) { console.warn("comp-report updateRow failed", e); }

        const finalRow = saved || { ...memPlaceholder, ...fields };
        st.row = finalRow;
        st.selectedId = finalRow.id;
        st.history = (st.history || []).map(h => h.id === memPlaceholder.id ? finalRow : h);
        this._stopProgressTimer(tu);

        // Refresh history from Supabase so other devices see the new row.
        try {
          if (window.ComprehensiveReports) {
            const fresh = await window.ComprehensiveReports.listHistory(tu, 20);
            if (fresh && fresh.length) {
              // Keep the in-memory finalRow at the head if Supabase missed it.
              const haveMine = fresh.some(h => h.id === finalRow.id || h.generated_at === finalRow.generated_at);
              st.history = haveMine ? fresh : [finalRow, ...fresh];
              const matched = st.history.find(h => h.id === finalRow.id)
                || st.history.find(h => h.generated_at === finalRow.generated_at);
              if (matched) { st.selectedId = matched.id; st.row = matched; }
            }
          }
        } catch (e) { /* non-fatal */ }
        this._refreshIfVisible(tu);
        return finalRow;
      } catch (e) {
        await this._finishWithError(tu, memPlaceholder.id, String(e));
        return null;
      }
    },

    async selectVersion(ticker, versionId) {
      const tu = (ticker || "").toUpperCase();
      const st = _getState(tu);
      st.selectedId = versionId;
      this._refreshIfVisible(tu);
    },

    async togglePinned(ticker, versionId) {
      const tu = (ticker || "").toUpperCase();
      const st = _getState(tu);
      const cur = (st.history || []).find(h => h.id === versionId);
      if (!cur) return;
      const newVal = !cur.is_pinned;
      cur.is_pinned = newVal;
      try {
        if (window.ComprehensiveReports) {
          await window.ComprehensiveReports.setPinned(versionId, newVal);
        }
      } catch (e) { console.warn("setPinned failed", e); }
      this._refreshIfVisible(tu);
    },

    async deleteVersion(ticker, versionId) {
      const tu = (ticker || "").toUpperCase();
      if (!confirm("删除这个历史版本？")) return;
      const st = _getState(tu);
      try {
        if (window.ComprehensiveReports) {
          await window.ComprehensiveReports.deleteRow(versionId);
        }
      } catch (e) { console.warn("deleteRow failed", e); }
      st.history = (st.history || []).filter(h => h.id !== versionId);
      if (st.selectedId === versionId) {
        st.selectedId = st.history[0]?.id || null;
        st.row = st.history[0] || null;
      }
      this._refreshIfVisible(tu);
    },

    // ---------------- progress timer ------------------------------------

    _startProgressTimer(ticker) {
      const tu = (ticker || "").toUpperCase();
      const st = _getState(tu);
      this._stopProgressTimer(tu);
      st.progressTimer = setInterval(() => {
        st.elapsed = Math.floor((Date.now() - st.startedAt) / 1000);
        // Cheap inline update — no full re-render.
        document.querySelectorAll(".wl-comp-mount").forEach(m => {
          if (m.dataset.ticker !== tu) return;
          m.querySelectorAll(".comp-elapsed").forEach(el => { el.textContent = `${st.elapsed}s`; });
        });
      }, 1000);
    },

    _stopProgressTimer(ticker) {
      const tu = (ticker || "").toUpperCase();
      const st = _getState(tu);
      if (st.progressTimer) {
        clearInterval(st.progressTimer);
        st.progressTimer = null;
      }
    },

    async _finishWithError(ticker, placeholderId, msg) {
      const tu = (ticker || "").toUpperCase();
      const st = _getState(tu);
      this._stopProgressTimer(tu);
      const errFields = {
        sections: {}, status: "error", error_message: msg,
        generated_at: new Date().toISOString(),
      };
      let saved = null;
      try {
        if (window.ComprehensiveReports && placeholderId && !String(placeholderId).startsWith("mem-")) {
          saved = await window.ComprehensiveReports.updateRow(placeholderId, errFields);
        }
      } catch (e) { /* non-fatal */ }
      const errRow = saved || (st.history || []).find(h => h.id === placeholderId);
      if (errRow) {
        Object.assign(errRow, errFields);
        st.row = errRow;
      }
      st.history = (st.history || []).map(h => h.id === placeholderId ? (saved || h) : h);
      this._refreshIfVisible(tu);
      console.warn(`comp-report ${tu} failed:`, msg);
    },

    // ---------------- cross-script resolvers ----------------------------

    _watchlistUI() {
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
      let H = null;
      try {
        if (typeof History !== "undefined" && History && Array.isArray(History.cache)) {
          H = History;
        }
      } catch (_) { /* unresolved */ }
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
        } catch (e) { console.warn("comp-report decision fetch failed", stub.id, e); }
      }
      return full;
    },

    _latestQuote(ticker) {
      const wl = this._watchlistUI();
      if (!wl || !wl.quotes) return null;
      return wl.quotes[ticker.toUpperCase()] || null;
    },

    // ---------------- rendering -----------------------------------------

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

    _renderHTML(ticker, row, st) {
      const status = row?.status || "empty";
      const sections = row?.sections || {};
      const isReady = status === "ready" && sections && Object.keys(sections).length > 0;
      const isGenerating = status === "generating";
      const isError = status === "error";

      const history = (st && st.history) || [];
      const hasHistory = history.length > 1;

      const head = this._headHTML(ticker, row, isReady, isGenerating, isError, history, hasHistory, st);

      let body;
      if (isGenerating) {
        const elapsed = st?.elapsed != null ? st.elapsed : 0;
        body = `
          <div class="comp-progress">
            <div class="comp-progress-bar"><div class="comp-progress-bar-fill"></div></div>
            <div class="comp-progress-text">
              正在综合 <strong>${esc(ticker)}</strong> 的 ${row?.decisions_count || 0} 次历史决策
              <span class="comp-progress-dots"><span></span><span></span><span></span></span>
              · 已耗时 <span class="comp-elapsed">${elapsed}s</span>
            </div>
            <div class="comp-progress-steps">
              <div class="comp-progress-step done">📥 收集决策原始资料</div>
              <div class="comp-progress-step active">🧠 LLM 综合推理中…</div>
              <div class="comp-progress-step">💾 保存版本</div>
            </div>
            <div class="comp-progress-hint muted">
              通常 30–60 秒；深思模型 + 多次决策时可能稍久。可保持页面打开或先看其他标的，生成完成后会自动出现。
            </div>
          </div>`;
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
        const errMsg = row?.error_message || "未知错误";
        body = `<div class="comp-empty comp-error-detail">
          <div class="comp-error-icon">⚠</div>
          <p><strong>生成综合报告失败</strong></p>
          <pre class="comp-error-msg">${esc(errMsg)}</pre>
          <p class="muted" style="font-size:12px;">点击右上角「↻ 重试」再试一次。如多次失败，请检查 fly logs 或 LLM API Key 配置。</p>
        </div>`;
      } else {
        body = `<div class="comp-empty">
          <p>还没有为 <strong>${esc(ticker)}</strong> 生成综合报告。</p>
          <p class="muted" style="font-size:12px;">点击右上角「⚡ 生成综合报告」即可基于该标的的全部历史决策生成一份多维度研究档案。</p>
        </div>`;
      }

      return `<div class="comp-block" data-status="${esc(status)}">${head}${body}</div>`;
    },

    _headHTML(ticker, row, isReady, isGenerating, isError, history, hasHistory, st) {
      const model = row?.model;
      const gen = row?.generated_at;

      const historyDropdown = hasHistory
        ? this._historyDropdownHTML(ticker, history, row?.id)
        : "";

      let buttons = "";
      if (isReady) {
        buttons = `
          <span class="comp-meta">${row?.decisions_count || 0} 次决策 · ${esc(model || "—")} · ${esc(fmtTimeShort(gen))}</span>
          ${historyDropdown}
          <button class="btn secondary tiny comp-pin-btn" data-pinned="${row?.is_pinned ? "1" : "0"}" title="收藏此版本">${row?.is_pinned ? "★" : "☆"}</button>
          <button class="btn primary tiny comp-regen-btn">⚡ 生成新版本</button>`;
      } else if (isGenerating) {
        buttons = `
          <span class="comp-status-pill comp-pill-gen">⚡ 生成中 · <span class="comp-elapsed">${st?.elapsed || 0}s</span></span>
          ${historyDropdown}`;
      } else if (isError) {
        buttons = `
          <span class="comp-status-pill comp-pill-err">⚠ 失败</span>
          ${historyDropdown}
          <button class="btn primary tiny comp-regen-btn">↻ 重试</button>`;
      } else {
        buttons = `
          <span class="comp-status-pill comp-pill-empty">尚未生成</span>
          ${historyDropdown}
          <button class="btn primary tiny comp-regen-btn">⚡ 生成综合报告</button>`;
      }

      return `
        <div class="comp-head">
          <h3 class="comp-title">📊 综合报告</h3>
          <div class="comp-head-right">${buttons}</div>
        </div>`;
    },

    _historyDropdownHTML(ticker, history, selectedId) {
      const items = history.map(h => {
        const sel = h.id === selectedId ? " selected" : "";
        const pin = h.is_pinned ? "★ " : "";
        const stat =
          h.status === "ready" ? "✓" :
          h.status === "generating" ? "⚡" :
          h.status === "error" ? "⚠" : "·";
        const label = `${pin}${stat} ${fmtTimeShort(h.generated_at)} · ${h.decisions_count || 0} 次决策${h.model ? " · " + h.model : ""}`;
        return `<option value="${esc(h.id)}"${sel}>${esc(label)}</option>`;
      }).join("");
      return `<select class="comp-history-select" title="查看历史版本">${items}</select>`;
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
      if (!intro || (!intro.what_is_it && !intro.latest_news && !intro.narrative_shift)) return "";
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
                <div class="comp-h-strategy-label">⚙ 执行策略 + 策略库匹配</div>
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

    _wire(entry, container, ticker) {
      const regenBtn = container.querySelector(".comp-regen-btn");
      if (regenBtn) {
        regenBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          regenBtn.disabled = true;
          regenBtn.textContent = "⚡ 启动中…";
          await this.regenerate(entry.ticker);
        });
      }
      const pinBtn = container.querySelector(".comp-pin-btn");
      if (pinBtn) {
        pinBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const st = _getState(ticker);
          if (!st.selectedId) return;
          await this.togglePinned(ticker, st.selectedId);
        });
      }
      const hist = container.querySelector(".comp-history-select");
      if (hist) {
        hist.addEventListener("change", (ev) => {
          ev.stopPropagation();
          this.selectVersion(ticker, hist.value);
        });
      }
    },
  };

  window.ComprehensiveReport = ComprehensiveReport;
})();
