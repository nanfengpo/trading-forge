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
  // History-keeping store: each generation = a new row (no upsert). The user
  // can browse past versions. RLS-scoped by Supabase; falls back to a
  // localStorage ring buffer when anonymous.
  //
  // Local storage shape:  { "TICKER": [ row, row, ... newest first ] }
  // Each "row" mirrors the Supabase row schema (sections, model, status,
  // generated_at, …) plus a synthetic `id` (local-…). Capped at 20 per ticker.
  const ComprehensiveReports = {
    LOCAL_KEY: "tda:comp-reports",
    LOCAL_MAX_PER_TICKER: 20,

    _tableMissing: false,

    // ---- low-level Supabase ↔ localStorage plumbing ---------------------
    async _supaSelect(builder) {
      const { data, error } = await builder;
      if (error) {
        if (error.code === "42P01" || /relation .* does not exist/i.test(error.message)) {
          this._tableMissing = true;
          console.warn("[comp-reports] table missing — run migration 0007 + 0008");
          return null;
        }
        console.error("[comp-reports]", error);
        return null;
      }
      return data;
    },

    _readLocal() {
      try { return JSON.parse(localStorage.getItem(this.LOCAL_KEY) || "{}"); }
      catch { return {}; }
    },

    _writeLocal(all) {
      try { localStorage.setItem(this.LOCAL_KEY, JSON.stringify(all)); return true; }
      catch (e) { console.warn("comp-reports local save failed", e); return false; }
    },

    _localPush(ticker, row) {
      const all = this._readLocal();
      const tu = (ticker || "").toUpperCase();
      const list = all[tu] || [];
      list.unshift(row);
      if (list.length > this.LOCAL_MAX_PER_TICKER) list.length = this.LOCAL_MAX_PER_TICKER;
      all[tu] = list;
      this._writeLocal(all);
      return row;
    },

    _localPatch(id, patch) {
      const all = this._readLocal();
      for (const tu of Object.keys(all)) {
        const list = all[tu] || [];
        const i = list.findIndex(r => r.id === id);
        if (i >= 0) {
          list[i] = { ...list[i], ...patch, updated_at: new Date().toISOString() };
          this._writeLocal(all);
          return list[i];
        }
      }
      return null;
    },

    // ---- public API -----------------------------------------------------

    /** Latest ready/generating/error row for a ticker (one record). */
    async getLatest(ticker) {
      const tu = (ticker || "").toUpperCase();
      if (!client || !session) {
        const all = this._readLocal();
        return (all[tu] || [])[0] || null;
      }
      const data = await this._supaSelect(
        client.from("comprehensive_reports").select("*")
          .eq("user_id", session.user.id).eq("ticker", tu)
          .order("generated_at", { ascending: false }).limit(1)
      );
      return (data && data[0]) || null;
    },

    /** Back-compat alias used by older callers — same as getLatest. */
    async get(ticker) { return this.getLatest(ticker); },

    /** Full history for a ticker, newest first. */
    async listHistory(ticker, limit = 20) {
      const tu = (ticker || "").toUpperCase();
      if (!client || !session) {
        const all = this._readLocal();
        return (all[tu] || []).slice(0, limit);
      }
      const data = await this._supaSelect(
        client.from("comprehensive_reports").select("*")
          .eq("user_id", session.user.id).eq("ticker", tu)
          .order("generated_at", { ascending: false }).limit(limit)
      );
      return data || [];
    },

    async getById(id) {
      if (!client || !session) {
        const all = this._readLocal();
        for (const tu of Object.keys(all)) {
          const hit = (all[tu] || []).find(r => r.id === id);
          if (hit) return hit;
        }
        return null;
      }
      const data = await this._supaSelect(
        client.from("comprehensive_reports").select("*").eq("id", id).limit(1)
      );
      return (data && data[0]) || null;
    },

    /** Insert a brand-new version row. Returns the inserted row (with id). */
    async insert(ticker, payload) {
      const tu = (ticker || "").toUpperCase();
      const row = {
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
      if (!client || !session) {
        const local = {
          ...row,
          id: "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          user_id: "local",
          updated_at: new Date().toISOString(),
        };
        return this._localPush(tu, local);
      }
      const { data, error } = await client
        .from("comprehensive_reports")
        .insert({ ...row, user_id: session.user.id })
        .select()
        .single();
      if (error) {
        if (error.code === "42P01" || /relation .* does not exist/i.test(error.message)) {
          this._tableMissing = true;
          console.warn("[comp-reports] table missing — run migration 0007 + 0008. Falling back to localStorage.");
          const local = {
            ...row, id: "local-" + Date.now().toString(36), user_id: "local",
            updated_at: new Date().toISOString(),
          };
          return this._localPush(tu, local);
        }
        if (/column .*is_pinned.* does not exist/i.test(error.message || "")) {
          console.warn("[comp-reports] is_pinned column missing — run migration 0008. Retrying without it.");
          const { is_pinned, ...rest } = row;
          const r2 = await client.from("comprehensive_reports").insert({ ...rest, user_id: session.user.id }).select().single();
          if (r2.error) { console.error("[comp-reports] insert retry", r2.error); return null; }
          return r2.data;
        }
        console.error("[comp-reports] insert", error);
        return null;
      }
      return data;
    },

    /** Patch one row by id (status, sections, error_message, is_pinned, …). */
    async updateRow(id, patch) {
      if (!id) return null;
      if (!client || !session || String(id).startsWith("local-")) {
        return this._localPatch(id, patch);
      }
      const { data, error } = await client
        .from("comprehensive_reports")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) { console.error("[comp-reports] update", error); return null; }
      return data;
    },

    async setPinned(id, pinned) {
      return this.updateRow(id, { is_pinned: !!pinned });
    },

    async deleteRow(id) {
      if (!id) return false;
      if (!client || !session || String(id).startsWith("local-")) {
        const all = this._readLocal();
        for (const tu of Object.keys(all)) {
          const before = (all[tu] || []).length;
          all[tu] = (all[tu] || []).filter(r => r.id !== id);
          if (all[tu].length !== before) { this._writeLocal(all); return true; }
        }
        return false;
      }
      const { error } = await client.from("comprehensive_reports").delete().eq("id", id);
      if (error) { console.error("[comp-reports] delete", error); return false; }
      return true;
    },

    /** Convenience used by the UI to create a "generating" placeholder. */
    async markGenerating(ticker, payload = {}) {
      return this.insert(ticker, { ...payload, sections: {}, status: "generating" });
    },
  };

  window.Auth = Auth;
  window.Decisions = Decisions;
  window.Watchlist = Watchlist;
  window.ComprehensiveReports = ComprehensiveReports;
})();
