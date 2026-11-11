/* Fortnight Shop — standalone app layer.
   The list itself (index.html) was written for claude.ai, where it asks for capabilities with
   claude.use("db" | "user" | "sample" | "mcp"). This file provides the same calls on your own services:
     db     -> Supabase table "docs" (login + live sync between your phones)
     sample -> Claude API with your own key (read photos and recipes, estimate prices)
     mcp    -> Claude API web fetch (read a recipe link)
   Nothing here is shared with anyone else: every row is locked to your Supabase login. */
(function () {
  "use strict";
  const CFG_KEY = "fs-config";
  const SB_TABLE = "docs";
  const MODEL_MAIN = "claude-sonnet-5-5";
  const MODEL_QUICK = "claude-haiku-5-5";

  // ---------- settings saved on this phone ----------
  function readCfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) {}
    const base = window.APP_CONFIG || {};
    return {
      supabaseUrl: (c.supabaseUrl || base.supabaseUrl || "").trim(),
      supabaseKey: (c.supabaseKey || base.supabaseKey || "").trim(),
      claudeKey: (c.claudeKey || "").trim(),
    };
  }
  function writeCfg(patch) {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) {}
    Object.assign(c, patch);
    try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {}
  }
  // a setup link from the other phone: #setup=<base64 json>
  (function takeSetupLink() {
    const m = location.hash.match(/^#setup=([A-Za-z0-9_\-]+={0,2})$/);
    if (!m) return;
    try {
      const json = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")))));
      const patch = {};
      if (json.u) patch.supabaseUrl = json.u;
      if (json.k) patch.supabaseKey = json.k;
      if (json.c) patch.claudeKey = json.c;
      writeCfg(patch);
    } catch (e) {}
    history.replaceState(null, "", location.pathname + location.search);
  })();

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const errOf = (code, message) => Object.assign(new Error(message || code), { code });
  const isNetErr = (e) => !navigator.onLine || (e && (e.name === "TypeError" || /fetch|network|Failed to fetch|Load failed/i.test(String(e.message || e))));

  // ---------- Supabase connection and login ----------
  let sb = null, user = null;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  function client() {
    const c = readCfg();
    if (!c.supabaseUrl || !c.supabaseKey || !window.supabase) return null;
    if (!sb) sb = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "fs-auth" } });
    return sb;
  }

  async function boot() {
    const c = readCfg();
    if (!c.supabaseUrl || !c.supabaseKey) { showSetup(); return; }
    if (!window.supabase) { // library not loaded (offline on very first open)
      addEventListener("online", () => location.reload(), { once: true });
      return;
    }
    const s = client();
    let session = null;
    try { session = (await s.auth.getSession()).data.session; } catch (e) {}
    if (!session) {
      // keep using the saved copy while offline; ask to sign in once there's signal
      try {
        const raw = localStorage.getItem("fs-auth");
        const saved = raw && JSON.parse(raw);
        if (saved && saved.user && !navigator.onLine) {
          addEventListener("online", () => location.reload(), { once: true });
          return;
        }
      } catch (e) {}
      showLogin();
      return;
    }
    user = session.user;
    resolveReady();
  }

  s_onAuth();
  function s_onAuth() {
    // set up after the client exists
    queueMicrotask(() => {
      const s = client();
      if (!s) return;
      s.auth.onAuthStateChange((evt, session) => {
        if (evt === "SIGNED_OUT") { try { localStorage.removeItem("fortnight-shop-v2-synced"); } catch (e) {} location.reload(); }
        if (session && session.user) user = session.user;
      });
    });
  }

  // ---------- db: the same calls the list makes on claude.ai ----------
  function makeDb() {
    const s = client();
    const mapErr = (error) => (isNetErr(error) ? errOf("offline") : errOf("error", error && error.message));
    async function run(q) {
      let res;
      try { res = await q; } catch (e) { throw mapErr(e); }
      if (res.error) throw mapErr(res.error);
      return res.data;
    }
    const doc = (path) => {
      const [col, id] = path.split("/");
      return {
        id,
        async get() {
          if (!navigator.onLine) await new Promise((r) => addEventListener("online", r, { once: true }));
          const data = await run(s.from(SB_TABLE).select("data").eq("col", col).eq("id", id).maybeSingle());
          return { id, exists: !!data, data: () => (data ? data.data : undefined) };
        },
        async set(d) {
          await run(s.from(SB_TABLE).upsert({ user_id: user.id, col, id, data: d, updated_at: new Date().toISOString() }, { onConflict: "user_id,col,id" }));
        },
        async delete() {
          await run(s.from(SB_TABLE).delete().eq("col", col).eq("id", id));
        },
        async acquire() { return { acquired: true }; },
      };
    };

    // live collections: load once, then follow changes; reload whenever the phone wakes or comes back online
    const subs = {}; // col -> {map, fns:[{fn,onErr}]}
    function emit(col) {
      const sub = subs[col]; if (!sub) return;
      const docs = [...sub.map].map(([id, d]) => ({ id, exists: true, data: () => d, metadata: {} }));
      const snap = { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} };
      sub.fns.forEach(({ fn }) => { try { fn(snap); } catch (e) { console.error(e); } });
    }
    async function load(col) {
      const out = new Map();
      for (let from = 0; ; from += 1000) {
        const rows = await run(s.from(SB_TABLE).select("id,data").eq("col", col).range(from, from + 999));
        rows.forEach((r) => out.set(r.id, r.data));
        if (rows.length < 1000) break;
      }
      return out;
    }
    let loading = {};
    function refresh(col) {
      if (loading[col]) return loading[col];
      loading[col] = load(col).then((m) => { subs[col].map = m; emit(col); })
        .catch((e) => subs[col].fns.forEach(({ onErr }) => onErr && onErr(e)))
        .finally(() => { loading[col] = null; });
      return loading[col];
    }
    const refreshAll = () => Object.keys(subs).forEach(refresh);
    let channel = null;
    function listen() {
      if (channel) return;
      channel = s.channel("docs-" + user.id)
        .on("postgres_changes", { event: "*", schema: "public", table: SB_TABLE }, (p) => {
          const row = p.eventType === "DELETE" ? p.old : p.new;
          if (!row || !row.col || (row.user_id && row.user_id !== user.id)) return;
          const sub = subs[row.col]; if (!sub) return;
          if (p.eventType === "DELETE") sub.map.delete(row.id); else sub.map.set(row.id, row.data);
          emit(row.col);
        })
        .subscribe((status) => { if (status === "SUBSCRIBED") refreshAll(); });
    }
    addEventListener("online", refreshAll);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshAll(); });

    return {
      doc,
      collection(col) {
        return {
          doc: (id) => doc(col + "/" + id),
          onSnapshot(fn, onErr) {
            subs[col] = subs[col] || { map: new Map(), fns: [] };
            const entry = { fn, onErr };
            subs[col].fns.push(entry);
            if (navigator.onLine) refresh(col); else onErr && onErr(errOf("offline"));
            listen();
            return () => { subs[col].fns = subs[col].fns.filter((x) => x !== entry); };
          },
        };
      },
    };
  }

  // ---------- Claude API (your key, this phone only) ----------
  async function claudeCall(body, { signal, beta } = {}) {
    const key = readCfg().claudeKey;
    if (!key) throw errOf("not_granted");
    const headers = {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (beta) headers["anthropic-beta"] = beta;
    let r;
    try { r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal }); }
    catch (e) {
      if (e && e.name === "AbortError") throw errOf("cancelled");
      throw errOf(isNetErr(e) ? "offline" : "error", e && e.message);
    }
    let j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) || "HTTP " + r.status;
      if (r.status === 401 || r.status === 403) throw errOf("bad_key", msg);
      if (r.status === 429 || r.status === 529) throw errOf("rate_limited", msg);
      throw errOf(r.status === 400 ? "bad_request" : "error", msg);
    }
    return j;
  }
  const textOf = (j) => (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");

  // phone photos are large: shrink to 1600px JPEG before sending
  async function imageBlock(blob) {
    let bmp;
    try { bmp = await createImageBitmap(blob); }
    catch (e) {
      bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(errOf("image_rejected")); im.src = URL.createObjectURL(blob); });
    }
    const w = bmp.width, h = bmp.height, k = Math.min(1, 1600 / Math.max(w, h));
    const cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const data = cv.toDataURL("image/jpeg", 0.85).split(",")[1];
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
  }
  function parseJson(text) {
    let t = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return JSON.parse(t); } catch (e) {}
    const a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    throw errOf("invalid_json");
  }
  function toMessages(input) {
    if (typeof input === "string") return [{ role: "user", content: input }];
    return input;
  }
  async function withImages(messages, images) {
    if (!images || !images.length) return messages;
    const blocks = await Promise.all(images.map(imageBlock));
    const last = messages[messages.length - 1];
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    return [...messages.slice(0, -1), { role: "user", content: [...blocks, ...content] }];
  }
  function makeSample() {
    const sample = async (input, opts = {}) => {
      const messages = await withImages(toMessages(input), opts.images);
      const j = await claudeCall({ model: opts.modelTier === "quick" ? MODEL_QUICK : MODEL_MAIN, max_tokens: 8000, messages }, { signal: opts.signal });
      const text = textOf(j);
      if (opts.onText) opts.onText({ text, delta: text });
      return { text, truncated: j.stop_reason === "max_tokens" };
    };
    sample.json = async (input, opts = {}) => {
      const msgs = toMessages(input);
      const last = msgs[msgs.length - 1];
      const add = "\n\nReply with the JSON only, no other text.";
      const patched = [...msgs.slice(0, -1), { ...last, content: typeof last.content === "string" ? last.content + add : last.content }];
      const { text } = await sample(patched, opts);
      return parseJson(text);
    };
    sample.limits = async () => ({ images: { mediaTypes: ["image/*"] } });
    return sample;
  }

  // reading a recipe link: Claude fetches the page and copies out the recipe text
  function makeLinkReader() {
    let lastUrl = "";
    async function fetchPage(url) {
      const body = {
        model: MODEL_MAIN, max_tokens: 6000,
        messages: [{ role: "user", content: `Fetch ${url} and copy out the recipe or product details as plain text: the title, every ingredient line exactly as written (with amounts), and the method steps. No commentary.` }],
        tools: [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, max_content_tokens: 40000 }],
      };
      let j;
      try { j = await claudeCall(body); }
      catch (e) { if (e.code === "bad_request") j = await claudeCall(body, { beta: "web-fetch-2025-09-10" }); else throw e; }
      const failed = (j.content || []).find((b) => b.type === "web_fetch_tool_result" && b.content && b.content.type === "web_fetch_tool_result_error");
      const text = textOf(j);
      if (failed && text.length < 80) throw errOf("error", failed.content.error_code);
      return text;
    }
    return {
      linksOnPhone: true,
      async callTool(server, tool, input) {
        if (tool === "navigate") { lastUrl = input.url; return { payload: "ok" }; }
        if (tool === "get_page_text") { const t = await fetchPage(lastUrl); return { payload: t, content: [{ type: "text", text: t }] }; }
        throw errOf("unavailable");
      },
    };
  }

  // ---------- the calls the list makes ----------
  window.STANDALONE = { openSettings: () => openSettings() };
  window.claude = {
    async use(name) {
      if (name === "db") { await ready; return makeDb(); }
      if (name === "user") { await ready; return { isOwner: () => true, canEdit: () => true, can: () => true, id: async () => user.id, me: async () => ({ id: user.id, name: user.email }) }; }
      if (name === "sample") return readCfg().claudeKey ? makeSample() : null;
      if (name === "mcp") return readCfg().claudeKey ? makeLinkReader() : null;
      return null;
    },
  };

  // ---------- screens: first-time setup, sign in, settings ----------
  const css = document.createElement("style");
  css.textContent = `
  .fs-gate{position:fixed;inset:0;z-index:50;background:var(--bg,#f3f5f2);color:var(--fg,#1b2420);overflow:auto;
    padding:calc(24px + env(safe-area-inset-top,0px)) max(20px,env(safe-area-inset-right,0px)) calc(24px + env(safe-area-inset-bottom,0px)) max(20px,env(safe-area-inset-left,0px))}
  .fs-card{max-width:420px;margin:0 auto;display:grid;gap:14px}
  .fs-card img{width:72px;height:72px;border-radius:18px}
  .fs-card h1{font-family:var(--display,system-ui);font-size:1.7rem;margin:0}
  .fs-card p{margin:0;color:var(--muted,#66736c);line-height:1.45}
  .fs-card label{display:grid;gap:5px;font-size:.88rem;color:var(--muted,#66736c)}
  .fs-card input,.fs-card textarea{font:inherit;font-size:16px;padding:12px;border:1px solid var(--line,#dde3de);border-radius:10px;background:var(--surface,#fff);color:var(--fg,#1b2420);width:100%;box-sizing:border-box}
  .fs-card textarea{min-height:90px}
  .fs-card button{font:inherit;font-weight:700;padding:13px;border:0;border-radius:10px;background:var(--accent,#1f6b5c);color:var(--surface,#fff);cursor:pointer}
  .fs-card .err{color:#b3412e}
  .fs-gear{position:absolute;top:0;right:0;font:inherit;font-size:.85rem;border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:999px;padding:8px 12px;cursor:pointer;min-height:40px}
  header{position:relative}
  header h1{padding-right:96px}
  .fs-set{display:grid;gap:16px}
  .fs-set h3{margin:0 0 4px;font-family:var(--display);font-size:1rem}
  .fs-set section{margin:0;display:grid;gap:8px;padding-top:12px;border-top:1px solid var(--line)}
  .fs-set section:first-of-type{border-top:0;padding-top:0}
  .fs-set input[type=password],.fs-set input[type=text],.fs-set textarea{font:inherit;font-size:16px;width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}
  .fs-set textarea{min-height:70px;font-size:13px!important}
  .fs-set .row{display:flex;gap:8px;flex-wrap:wrap}
  .fs-filebtn{position:relative;overflow:hidden}
  .fs-filebtn input{position:absolute;inset:0;opacity:0;cursor:pointer}`;
  document.head.appendChild(css);

  function gate(html) {
    let g = document.getElementById("fs-gate");
    if (!g) { g = document.createElement("div"); g.id = "fs-gate"; g.className = "fs-gate"; document.body.appendChild(g); }
    g.innerHTML = `<div class="fs-card"><img src="icons/icon-192.png" alt="">${html}</div>`;
    return g;
  }
  function onBody(fn) { if (document.body) fn(); else addEventListener("DOMContentLoaded", fn, { once: true }); }

  function showSetup() {
    onBody(() => {
      const c = readCfg();
      const g = gate(`<h1>Set up Fortnight Shop</h1>
        <p>This connects the app to your Supabase project so your list syncs between phones. You only do this once per phone. On your second phone, open the setup link from Settings instead.</p>
        <label>Supabase project URL<input id="fs-u" type="url" placeholder="https://abcd1234.supabase.co" value="${esc(c.supabaseUrl)}" autocomplete="off"></label>
        <label>Supabase publishable (anon) key<textarea id="fs-k" placeholder="eyJ… or sb_publishable_…">${esc(c.supabaseKey)}</textarea></label>
        <p class="err" id="fs-e" hidden></p>
        <button id="fs-go" type="button">Save and continue</button>`);
      g.querySelector("#fs-go").onclick = () => {
        const u = g.querySelector("#fs-u").value.trim().replace(/\/+$/, ""), k = g.querySelector("#fs-k").value.trim();
        const e = g.querySelector("#fs-e");
        if (!/^https:\/\/[^\s/]+$/.test(u)) { e.hidden = false; e.textContent = "Enter the project URL, starting with https://"; return; }
        if (k.length < 20) { e.hidden = false; e.textContent = "Paste the whole publishable key."; return; }
        writeCfg({ supabaseUrl: u, supabaseKey: k }); location.reload();
      };
    });
  }

  function showLogin() {
    onBody(() => {
      const g = gate(`<h1>Sign in</h1>
        <p>Use the email and password you both share for Fortnight Shop.</p>
        <form id="fs-f" style="display:grid;gap:12px">
          <label>Email<input id="fs-em" type="email" autocomplete="username" required></label>
          <label>Password<input id="fs-pw" type="password" autocomplete="current-password" required></label>
          <p class="err" id="fs-e" hidden></p>
          <button type="submit" id="fs-go">Sign in</button>
        </form>
        <p style="font-size:.85rem">Wrong project? <a href="#" id="fs-reset">Change the Supabase connection</a></p>`);
      g.querySelector("#fs-f").onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = g.querySelector("#fs-go"), e = g.querySelector("#fs-e");
        btn.disabled = true; btn.textContent = "Signing in…"; e.hidden = true;
        try {
          const { data, error } = await client().auth.signInWithPassword({ email: g.querySelector("#fs-em").value.trim(), password: g.querySelector("#fs-pw").value });
          if (error) throw error;
          user = data.user; g.remove(); resolveReady();
        } catch (err) {
          e.hidden = false;
          e.textContent = isNetErr(err) ? "No connection. Try again when you have signal." : (/invalid/i.test(err.message) ? "That email and password don't match." : err.message);
          btn.disabled = false; btn.textContent = "Sign in";
        }
      };
      g.querySelector("#fs-reset").onclick = (ev) => { ev.preventDefault(); writeCfg({ supabaseUrl: "", supabaseKey: "" }); location.reload(); };
    });
  }

  function setupLink(includeClaude) {
    const c = readCfg();
    const payload = { u: c.supabaseUrl, k: c.supabaseKey };
    if (includeClaude && c.claudeKey) payload.c = c.claudeKey;
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_");
    return location.origin + location.pathname + "#setup=" + b64;
  }

  function openSettings() {
    const c = readCfg();
    const open = window.openSheet, close = window.closeSheet;
    open(`<h2>Settings</h2><div class="fs-set">
      <section><h3>Account</h3>
        <p class="status">Signed in as <strong>${esc(user ? user.email : "")}</strong>. Your list syncs to every phone signed in with this account.</p>
        <div class="row"><button class="btn ghost" type="button" id="fs-out">Sign out</button></div>
        <label class="status" for="fs-pw1">Change the shared password (both phones use it next time they sign in)</label>
        <input type="password" id="fs-pw1" placeholder="New password, at least 8 characters" autocomplete="new-password">
        <input type="password" id="fs-pw2" placeholder="Type it again" autocomplete="new-password">
        <div class="row"><button class="btn ghost" type="button" id="fs-pwgo">Change password</button></div>
        <p class="status" id="fs-pwm"></p></section>
      <section><h3>Claude (photos, links and prices)</h3>
        <p class="status">Reading photos, recipe links and estimating prices use your Claude API key, saved on this phone only. Get one at platform.claude.com under API keys. Each photo or link costs a few cents.</p>
        <input type="password" id="fs-ck" placeholder="sk-ant-…" value="${esc(c.claudeKey)}" autocomplete="off" aria-label="Claude API key">
        <div class="row"><button class="btn" type="button" id="fs-cks">Save key</button>${c.claudeKey ? `<button class="btn ghost" type="button" id="fs-ckt">Test it</button><button class="link" type="button" id="fs-ckd">Remove</button>` : ""}</div>
        <p class="status" id="fs-ckm"></p></section>
      <section><h3>Set up another phone</h3>
        <p class="status">Send this link to your other phone and open it there. It connects the app to your list, then you sign in with the same email and password.</p>
        <label class="tools" style="color:var(--fg)"><input type="checkbox" id="fs-incl"> Include this phone's Claude key</label>
        <textarea id="fs-link" readonly></textarea>
        <div class="row"><button class="btn ghost" type="button" id="fs-copy">Copy link</button></div></section>
      <section><h3>Backup</h3>
        <p class="status">Save a copy of everything (list, recipes, Made history, aisles), or restore one. Restoring replaces the list on both phones.</p>
        <div class="row"><button class="btn ghost" type="button" id="fs-bk">Save a backup</button>
          <label class="btn ghost fs-filebtn">Restore a backup<input type="file" id="fs-rs" accept="application/json,.json"></label></div>
        <p class="status" id="fs-bkm"></p></section>
      <section><h3>App</h3>
        <p class="status">Fortnight Shop ${esc(window.APP_VERSION || "")}. Updates install by themselves the next time you open the app with signal.</p></section>
    </div>`);
    const $ = (id) => document.getElementById(id);
    const linkBox = $("fs-link");
    const drawLink = () => (linkBox.value = setupLink($("fs-incl").checked));
    drawLink(); $("fs-incl").onchange = drawLink;
    $("fs-copy").onclick = () => {
      const done = () => ($("fs-copy").textContent = "Copied");
      if (navigator.clipboard) navigator.clipboard.writeText(linkBox.value).then(done, () => { linkBox.select(); });
      else linkBox.select();
    };
    $("fs-pwgo").onclick = async () => {
      const a = $("fs-pw1").value, b = $("fs-pw2").value, m = $("fs-pwm");
      if (a.length < 8) { m.textContent = "Use at least 8 characters."; return; }
      if (a !== b) { m.textContent = "The two passwords don't match."; return; }
      m.textContent = "Changing…";
      try {
        const { error } = await client().auth.updateUser({ password: a });
        if (error) throw error;
        $("fs-pw1").value = $("fs-pw2").value = "";
        m.textContent = "Password changed. Use the new one next time either phone signs in.";
      } catch (e) {
        m.textContent = isNetErr(e) ? "No connection. Try again when you have signal." : /reauth|recent/i.test(e.message || "") ? "For safety, sign out and back in, then change it." : (e.message || "Couldn't change the password.");
      }
    };
    $("fs-out").onclick = async () => { try { await client().auth.signOut(); } catch (e) {} location.reload(); };
    $("fs-cks").onclick = () => { writeCfg({ claudeKey: $("fs-ck").value.trim() }); location.reload(); };
    if ($("fs-ckd")) $("fs-ckd").onclick = () => { writeCfg({ claudeKey: "" }); location.reload(); };
    if ($("fs-ckt")) $("fs-ckt").onclick = async () => {
      const m = $("fs-ckm"); m.textContent = "Testing…";
      try { await claudeCall({ model: MODEL_QUICK, max_tokens: 5, messages: [{ role: "user", content: "Say ok" }] }); m.textContent = "Your key works."; }
      catch (e) { m.textContent = e.code === "bad_key" ? "That key was refused. Check it and save again." : e.code === "offline" ? "No connection right now." : "Claude said: " + e.message; }
    };
    $("fs-bk").onclick = () => {
      const data = JSON.stringify(window.FS.backup(), null, 1);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      a.download = "fortnight-shop-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      $("fs-bkm").textContent = "Backup saved to your downloads.";
    };
    $("fs-rs").onchange = async (ev) => {
      const f = ev.target.files && ev.target.files[0]; if (!f) return;
      const m = $("fs-bkm");
      try {
        const b = JSON.parse(await f.text());
        const n = (b.items || []).length, r = (b.recipes || []).length;
        if (!Array.isArray(b.items) || !Array.isArray(b.recipes)) throw new Error("That file isn't a Fortnight Shop backup.");
        $("fs-rs").value = "";
        m.innerHTML = `This backup has <strong>${n} items</strong> and <strong>${r} recipes</strong>. It replaces what's on the list now, on both phones.
          <span class="row" style="margin-top:8px"><button class="btn" type="button" id="fs-rsok">Replace the list</button><button class="btn ghost" type="button" id="fs-rsno">Cancel</button></span>`;
        $("fs-rsno").onclick = () => (m.textContent = "");
        $("fs-rsok").onclick = () => { window.FS.restore(b); m.textContent = `Restored ${n} items and ${r} recipes.`; close && setTimeout(close, 900); };
      } catch (e) { m.textContent = e.message && !/JSON/.test(e.message) ? e.message : "That file isn't a Fortnight Shop backup."; }
    };
  }

  // settings button in the header, once the page is there
  onBody(() => {
    const h = document.querySelector("header");
    if (h && !document.getElementById("fs-gear")) {
      const b = document.createElement("button");
      b.id = "fs-gear"; b.className = "fs-gear"; b.type = "button"; b.textContent = "Settings";
      b.onclick = () => (user ? openSettings() : null);
      h.appendChild(b);
    }
  });

  boot();
})();
