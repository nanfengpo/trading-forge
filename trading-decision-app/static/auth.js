/* =========================================================================
   Auth module — Supabase Auth + a minimal login/signup modal.

   - Supabase client is loaded from the CDN script tag in index.html
     (window.supabase). We wrap it in a small `Auth` API so the rest of
     app.js doesn't have to know about Supabase internals.
   - When `window.APP_CONFIG` is missing or has no Supabase keys, the
     module silently falls back to "anonymous" — the rest of the app keeps
     working with localStorage history.
   - Exposes a global `Auth` and `Decisions` (CRUD on the decisions table).
   ========================================================================= */

(function () {
  "use strict";

  const cfg = window.APP_CONFIG || {};
  const SUPABASE_URL = cfg.SUPABASE_URL || "";
  const SUPABASE_ANON = cfg.SUPABASE_ANON_KEY || "";

  let client = null;
  let session = null;
  const listeners = new Set();

  function isConfigured() {
    return Boolean(SUPABASE_URL && SUPABASE_ANON && window.supabase);
  }

  function notify() { listeners.forEach(fn => { try { fn(session); } catch (e) { console.error(e); } }); }

  // ------------------------------------------------------------------ Auth
  const Auth = {
    isConfigured,

    async init() {
      if (!isConfigured()) {
        console.info("[auth] Supabase not configured — running anonymous-only");
        return null;
      }
      try {
        client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
          auth: { persistSession: true, autoRefreshToken: true },
        });
        const { data } = await client.auth.getSession();
        session = data?.session || null;
        client.auth.onAuthStateChange((_evt, sess) => {
          session = sess || null;
          notify();
        });
        return session;
      } catch (e) {
        console.error("[auth] init failed:", e);
        return null;
      }
    },

    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    user() { return session?.user || null; },
    accessToken() { return session?.access_token || null; },
    isSignedIn() { return Boolean(session?.user); },

    async signUp(email, password, displayName) {
      if (!isConfigured()) throw new Error("Supabase 未配置");
      const { data, error } = await client.auth.signUp({
        email, password,
        options: { data: { display_name: displayName || email.split("@")[0] } },
      });
      if (error) throw error;
      session = data.session;
      notify();
      return data;
    },

    async signIn(email, password) {
      if (!isConfigured()) throw new Error("Supabase 未配置");
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      session = data.session;
      notify();
      return data;
    },

    async signInWithMagicLink(email) {
      if (!isConfigured()) throw new Error("Supabase 未配置");
      const { error } = await client.auth.signInWithOtp({ email });
      if (error) throw error;
    },

    async signOut() {
      if (!client) return;
      await client.auth.signOut();
      session = null;
      notify();
    },

    /**
     * Change the password for the current signed-in user.
     * Verifies the current password first by re-signing-in (Supabase doesn't
     * require it, but checking blocks drive-by changes on an unlocked machine).
     */
    async updatePassword(currentPassword, newPassword) {
      if (!isConfigured()) throw new Error("Supabase 未配置");
      if (!session?.user?.email) throw new Error("未登录");
      if (!newPassword || newPassword.length < 6) throw new Error("新密码至少 6 位");
      // Step 1: verify the current password by attempting a re-auth.
      const { error: verifyErr } = await client.auth.signInWithPassword({
        email: session.user.email, password: currentPassword,
      });
      if (verifyErr) throw new Error("当前密码不正确");
      // Step 2: update.
      const { error } = await client.auth.updateUser({ password: newPassword });
      if (error) throw error;
    },

    rawClient() { return client; },
  };

  // ------------------------------------------------------------- Decisions
  // Thin CRUD wrapper around the `decisions` table. RLS in Supabase
  // ensures every query is automatically scoped to auth.uid().
  const Decisions = {
    isConfigured,

    async list() {
      if (!client || !session) return { rows: [], error: null };
      // Try the summary view first (cheaper — no run_state JSONB).
      let { data, error } = await client
        .from("decisions_summary")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) {
        console.warn("[decisions] view failed, falling back to decisions:", error.message);
        // View missing / column drift — fall back to the base table so the
        // user can at least see records. Pull params JSONB so the UI can
        // still extract llm_provider / depth / mode for filtering.
        const fb = await client
          .from("decisions")
          .select("id,ticker,trade_date,rating,status,started_at,completed_at,created_at,pinned,user_rating,user_note,params")
          .order("created_at", { ascending: false })
          .limit(500);
        if (fb.data) {
          // Normalise to the shape decisions_summary would have produced.
          data = fb.data.map(r => ({
            ...r,
            llm_provider:    r.params?.llm_provider ?? null,
            deep_think_llm:  r.params?.deep_think_llm ?? null,
            quick_think_llm: r.params?.quick_think_llm ?? null,
            instrument_hint: r.params?.instrument_hint ?? null,
            mode:            r.params?.mode ?? null,
            output_language: r.params?.output_language ?? null,
            research_depth:  r.params?.research_depth ?? null,
          }));
        } else {
          data = null;
        }
        error = fb.error;
        if (error) console.error("[decisions] list (fallback)", error);
      }
      return { rows: data || [], error: error ? (error.message || String(error)) : null };
    },

    async get(id) {
      if (!client || !session) return null;
      const { data, error } = await client
        .from("decisions")
        .select("*")
        .eq("id", id)
        .single();
      if (error) { console.error("[decisions] get", error); return null; }
      return data;
    },

    async upsert(entry) {
      if (!client || !session) return null;
      const row = {
        id: entry.id,
        user_id: session.user.id,
        ticker: entry.ticker,
        trade_date: entry.trade_date,
        rating: entry.rating,
        status: entry.status || "done",
        started_at: entry.startedAt,
        completed_at: entry.completedAt,
        pinned: !!entry.pinned,
        user_rating: entry.user_rating || 0,
        user_note: entry.user_note || null,
        params: entry.params,
        run_state: entry.runState,
      };
      const { data, error } = await client
        .from("decisions")
        .upsert(row, { onConflict: "id" })
        .select()
        .single();
      if (error) { console.error("[decisions] upsert", error); return null; }
      return data;
    },

    async delete(id) {
      if (!client || !session) return false;
      const { error } = await client.from("decisions").delete().eq("id", id);
      if (error) { console.error("[decisions] delete", error); return false; }
      return true;
    },

    async deleteAll() {
      if (!client || !session) return false;
      const { error } = await client.from("decisions").delete().eq("user_id", session.user.id);
      if (error) { console.error("[decisions] deleteAll", error); return false; }
      return true;
    },
  };

  // --------------------------------------------------------- Watchlist
  const Watchlist = {
    async list() {
      if (!client || !session) return { rows: [], error: null };
      const { data, error } = await client
        .from("watchlist")
        .select("*")
        .order("sort_order", { ascending: true })
        .order("added_at", { ascending: false });
      if (error) { console.error("[watchlist] list", error); return { rows: [], error: error.message }; }
      return { rows: data || [], error: null };
    },
    async add(entry) {
      if (!client || !session) return { error: "未登录" };
      const row = {
        user_id: session.user.id,
        ticker: (entry.ticker || "").trim().toUpperCase(),
        display_name: entry.display_name || null,
        market: entry.market || null,
        custom_group: entry.custom_group || null,
        note: entry.note || null,
      };
      if (!row.ticker) return { error: "代码不能为空" };
      const { data, error } = await client.from("watchlist").upsert(row, { onConflict: "user_id,ticker" }).select().single();
      if (error) { console.error("[watchlist] add", error); return { error: error.message }; }
      return { row: data };
    },
    async remove(id) {
      if (!client || !session) return false;
      const { error } = await client.from("watchlist").delete().eq("id", id);
      if (error) { console.error("[watchlist] remove", error); return false; }
      return true;
    },
    async update(id, patch) {
      if (!client || !session) return false;
      const { error } = await client.from("watchlist").update(patch).eq("id", id);
      if (error) { console.error("[watchlist] update", error); return false; }
      return true;
    },
  };

  // -------------------------------------------------- ComprehensiveReports
  //
  // **Dual-write store** — every report lives in BOTH localStorage and (when
  // signed in) Supabase. localStorage is the **source of truth for the UI**;
  // Supabase is a best-effort cross-device sync layer.
  //
  // Why: the previous Supabase-first implementation silently lost data when
  // any write failed (RLS denial, payload size, transient network, missing
  // column). User saw the report immediately after generation (via in-memory
  // state) but it vanished on refresh because nothing reached Supabase. This
  // rewrite makes Supabase failures non-fatal — local data always survives.
  //
  // Local shape:  { "TICKER": [ row, ... newest-first ] }
  // Row schema mirrors the Supabase column set (id, sections, model,
  // decision_ids, decisions_count, quote_snapshot, status, error_message,
  // is_pinned, generated_at) plus `user_id` ("local" when anonymous) and
  // `updated_at`. `id` is a Supabase UUID when sync succeeded, or
  // `local-…` when it didn't. Capped at 20 versions per ticker (LRU).
  const ComprehensiveReports = {
    LOCAL_KEY: "tda:comp-reports",
    LOCAL_MAX_PER_TICKER: 20,

    _tableMissing:    false,
    _isPinnedMissing: false,

    // ---- localStorage primitives ---------------------------------------
    _readLocal() {
      try { return JSON.parse(localStorage.getItem(this.LOCAL_KEY) || "{}"); }
      catch { return {}; }
    },

    _writeLocal(all) {
      try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all)); return true; }
      catch (e) {
        // Quota exceeded — trim each ticker's history aggressively and retry.
        try {
          const trimmed = {};
          for (const k of Object.keys(all)) trimmed[k] = (all[k] || []).slice(0, 5);
          localStorage.setItem(this.LOCAL_KEY, JSON.stringify(trimmed));
          return true;
        } catch (e2) { console.warn("[comp-reports] local quota", e2); return false; }
      }
    },

    _newLocalId() {
      return "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    },

    /** Insert-or-patch a row by id, then sort+trim the bucket. */
    _putRow(ticker, row) {
      const all = this._readLocal();
      const tu = (ticker || row.ticker || "").toUpperCase();
      let list = all[tu] || [];
      const idx = list.findIndex(r => r.id === row.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...row };
      else          list.unshift(row);
      list.sort((a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0));
      if (list.length > this.LOCAL_MAX_PER_TICKER) list.length = this.LOCAL_MAX_PER_TICKER;
      all[tu] = list;
      this._writeLocal(all);
      return list[Math.max(0, list.findIndex(r => r.id === row.id))];
    },

    _delRow(id) {
      const all = this._readLocal();
      let removed = false;
      for (const tu of Object.keys(all)) {
        const before = (all[tu] || []).length;
        all[tu] = (all[tu] || []).filter(r => r.id !== id);
        if (all[tu].length !== before) removed = true;
      }
      if (removed) this._writeLocal(all);
      return removed;
    },

    // ---- Supabase plumbing (all best-effort, ALL handle schema drift) ---
    _haveSupa() { return Boolean(client && session); },

    async _supaSelect(builder) {
      try {
        const { data, error } = await builder;
        if (error) {
          if (error.code === "42P01" || /relation .* does not exist/i.test(error.message || "")) {
            this._tableMissing = true;
            console.warn("[comp-reports] table missing — run migrations 0007+0008. Using localStorage only.");
            return null;
          }
          if (/column .*is_pinned.* does not exist/i.test(error.message || "")) {
            this._isPinnedMissing = true;
            console.warn("[comp-reports] is_pinned column missing — run migration 0008. Pin/listPinned will use localStorage only.");
            return null;
          }
          console.error("[comp-reports] select", error);
          return null;
        }
        return data || [];
      } catch (e) {
        console.warn("[comp-reports] select crash", e);
        return null;
      }
    },

    async _supaInsert(row) {
      const payload = this._isPinnedMissing ? (() => { const { is_pinned, ...rest } = row; return rest; })() : row;
      try {
        const { data, error } = await client.from("comprehensive_reports").insert(payload).select().single();
        if (error) {
          if (error.code === "42P01" || /relation .* does not exist/i.test(error.message || "")) {
            this._tableMissing = true;
            console.warn("[comp-reports] insert: table missing");
            return null;
          }
          if (/column .*is_pinned.* does not exist/i.test(error.message || "")) {
            this._isPinnedMissing = true;
            const { is_pinned, ...rest } = row;
            const r2 = await client.from("comprehensive_reports").insert(rest).select().single();
            if (r2.error) { console.error("[comp-reports] insert retry", r2.error); return null; }
            return r2.data;
          }
          console.error("[comp-reports] insert", error);
          return null;
        }
        return data;
      } catch (e) { console.warn("[comp-reports] insert crash", e); return null; }
    },

    async _supaUpdate(id, patch) {
      const payload = this._isPinnedMissing ? (() => { const { is_pinned, ...rest } = patch; return rest; })() : patch;
      try {
        const { data, error } = await client.from("comprehensive_reports").update(payload).eq("id", id).select().maybeSingle();
        if (error) {
          if (/column .*is_pinned.* does not exist/i.test(error.message || "")) {
            this._isPinnedMissing = true;
            const { is_pinned, ...rest } = patch;
            const r2 = await client.from("comprehensive_reports").update(rest).eq("id", id).select().maybeSingle();
            return r2.data || null;
          }
          console.error("[comp-reports] update", error);
          return null;
        }
        return data;  // null when 0 rows matched (RLS / stale id) — that's OK.
      } catch (e) { console.warn("[comp-reports] update crash", e); return null; }
    },

    /** Pull Supabase rows for a ticker into localStorage cache. Merging
     *  rules: Supabase wins for rows present in both unless local is newer;
     *  local-only rows (id starts "local-") are preserved; Supabase rows not
     *  in local are added; rows missing from Supabase but present locally
     *  with a non-"local-" id are KEPT (we may have just inserted them and
     *  PostgREST may not see them yet on the next request). */
    async _syncSupaForTicker(ticker, limit = 20) {
      if (!this._haveSupa() || this._tableMissing) return;
      const tu = (ticker || "").toUpperCase();
      const data = await this._supaSelect(
        client.from("comprehensive_reports").select("*")
          .eq("user_id", session.user.id).eq("ticker", tu)
          .order("generated_at", { ascending: false }).limit(limit)
      );
      if (!Array.isArray(data)) return;
      const all = this._readLocal();
      const existing = all[tu] || [];
      const byId = new Map();
      for (const r of data) byId.set(r.id, r);
      const merged = [];
      for (const local of existing) {
        if (byId.has(local.id)) {
          const remote = byId.get(local.id);
          const lU = new Date(local.updated_at || local.generated_at || 0).getTime();
          const rU = new Date(remote.updated_at || remote.generated_at || 0).getTime();
          merged.push(rU >= lU ? remote : { ...remote, ...local });
          byId.delete(local.id);
        } else {
          // Keep local rows that Supabase didn't return — they might be
          // local-only OR just-inserted-and-not-yet-visible.
          merged.push(local);
        }
      }
      for (const remoteOnly of byId.values()) merged.push(remoteOnly);
      merged.sort((a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0));
      all[tu] = merged.slice(0, this.LOCAL_MAX_PER_TICKER);
      this._writeLocal(all);
    },

    // ---- public API ----------------------------------------------------

    /** Insert a brand-new row. Always returns a usable row (Supabase UUID
     *  if sync succeeded, else `local-…`). */
    async insert(ticker, payload) {
      const tu = (ticker || "").toUpperCase();
      const baseRow = {
        ticker: tu,
        sections: payload.sections || {},
        model: payload.model || null,
        decision_ids: payload.decision_ids || [],
        decisions_count: payload.decisions_count || 0,
        quote_snapshot: payload.quote_snapshot || {},
        status: payload.status || "ready",
        error_message: payload.error_message || null,
        is_pinned: !!payload.is_pinned,
        generated_at: payload.generated_at || new Date().toISOString(),
      };
      let realRow = null;
      if (this._haveSupa() && !this._tableMissing) {
        realRow = await this._supaInsert({ ...baseRow, user_id: session.user.id });
      }
      const localRow = realRow
        ? { ...realRow, updated_at: realRow.updated_at || new Date().toISOString() }
        : { ...baseRow, id: this._newLocalId(), user_id: "local", updated_at: new Date().toISOString() };
      return this._putRow(tu, localRow);
    },

    /** Patch a row by id. localStorage updates synchronously; Supabase sync
     *  is fire-and-forget. Returns the patched local row. */
    async updateRow(id, patch) {
      if (!id) return null;
      const all = this._readLocal();
      let touched = null;
      let touchedTicker = null;
      for (const tu of Object.keys(all)) {
        const list = all[tu] || [];
        const idx = list.findIndex(r => r.id === id);
        if (idx >= 0) {
          list[idx] = { ...list[idx], ...patch, updated_at: new Date().toISOString() };
          all[tu] = list;
          touched = list[idx];
          touchedTicker = tu;
          break;
        }
      }
      if (touched) this._writeLocal(all);
      // Supabase sync — best-effort, awaited so callers can rely on at least
      // local state being final.
      if (this._haveSupa() && !this._tableMissing && !String(id).startsWith("local-")) {
        try {
          const remote = await this._supaUpdate(id, patch);
          if (remote && touched) {
            this._putRow(touchedTicker, { ...touched, ...remote });
          }
        } catch (e) { /* non-fatal */ }
      }
      return touched;
    },

    async setPinned(id, pinned) {
      return this.updateRow(id, { is_pinned: !!pinned });
    },

    async deleteRow(id) {
      if (!id) return false;
      const removed = this._delRow(id);
      if (this._haveSupa() && !this._tableMissing && !String(id).startsWith("local-")) {
        try { await client.from("comprehensive_reports").delete().eq("id", id); }
        catch (e) { /* non-fatal */ }
      }
      return removed;
    },

    async markGenerating(ticker, payload = {}) {
      return this.insert(ticker, { ...payload, sections: {}, status: "generating" });
    },

    /** Latest row for a ticker (after syncing from Supabase). */
    async getLatest(ticker) {
      const list = await this.listHistory(ticker, 1);
      return list[0] || null;
    },

    /** Back-compat alias. */
    async get(ticker) { return this.getLatest(ticker); },

    /** Newest-first version list for a ticker. ALWAYS reads from localStorage
     *  (after merging in any newer Supabase rows). */
    async listHistory(ticker, limit = 20) {
      const tu = (ticker || "").toUpperCase();
      await this._syncSupaForTicker(tu, limit);
      const all = this._readLocal();
      return (all[tu] || []).slice(0, limit);
    },

    async getById(id) {
      const all = this._readLocal();
      for (const tu of Object.keys(all)) {
        const hit = (all[tu] || []).find(r => r.id === id);
        if (hit) return hit;
      }
      if (!this._haveSupa() || this._tableMissing) return null;
      const data = await this._supaSelect(client.from("comprehensive_reports").select("*").eq("id", id).limit(1));
      return (data && data[0]) || null;
    },

    /** All pinned versions across all tickers — used by the 收藏 page. */
    async listPinned(limit = 200) {
      // Step 1: sync each known ticker from Supabase so the local cache reflects
      // recent changes (other tabs / other devices).
      if (this._haveSupa() && !this._tableMissing) {
        // Pull every pinned row in one query and merge ticker-by-ticker.
        const data = await this._supaSelect(
          client.from("comprehensive_reports").select("*")
            .eq("user_id", session.user.id)
            .eq("is_pinned", true)
            .order("generated_at", { ascending: false }).limit(limit)
        );
        if (Array.isArray(data)) {
          for (const r of data) this._putRow(r.ticker, { ...r, updated_at: r.updated_at || new Date().toISOString() });
        }
      }
      // Step 2: read pinned rows from localStorage (now merged).
      const all = this._readLocal();
      const out = [];
      for (const tu of Object.keys(all)) {
        for (const r of (all[tu] || [])) if (r.is_pinned) out.push(r);
      }
      out.sort((a, b) => new Date(b.generated_at || 0) - new Date(a.generated_at || 0));
      return out.slice(0, limit);
    },
  };

  window.Auth = Auth;
  window.Decisions = Decisions;
  window.Watchlist = Watchlist;
  window.ComprehensiveReports = ComprehensiveReports;
})();
