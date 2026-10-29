// Db Viewer: connections and their schema tree on the left, query and table tabs on the right.
// Connections (without passwords) and open tabs are kept in Octopus's storage; passwords are in the Keychain,
// handled by the helper (server.py), which also runs every statement.
import { call, connectHelper, restartHelper, wire } from "./api.js";
import { editConnection, ENVS } from "./connform.js";
import { icons } from "./icons.js";
import { importConnections } from "./importer.js";
import { envBanner, QueryTab } from "./query.js";
import { SessionsTab } from "./sessions.js";
import { quoteIdent } from "./sql.js";
import { TableTab } from "./table.js";
import { confirmDialog, contextMenu, esc, fmtBytes, fmtNum, modal } from "./ui.js";

const $ = (s) => document.querySelector(s);
const key = (...parts) => JSON.stringify(parts);

class App {
  constructor() {
    this.connections = [];
    this.history = [];
    this.saved = []; // [{id, connId, schema, name, sql, updatedAt}]
    this.ui = {}; // {sidebar, groupByEnv}
    this.tabs = [];
    this.active = null;
    this.expanded = new Set();
    // connId -> {list, error, loading, promise}. A connection is "connected" while it has a list here: from the
    // first successful load (opening it in the tree, running a query) until Disconnect.
    this.schemas = new Map();
    this.objects = new Map(); // key(connId, schema) -> {tables, views, routines} | {error} | {loading}
    this.columns = new Map(); // key(connId, schema, table) -> [...] | {error} | {loading}
    this.nodes = new Map(); // tree row key -> what it is
    this.sessions = {};
    this.running = [];
    this.filter = "";
  }

  async start() {
    await octopus.ready();
    const [conns, hist, tabs, expanded, ui, saved] = await Promise.all(["connections", "history", "tabs", "expanded", "ui", "saved"].map((k) => octopus.storage.get(k)));
    this.connections = conns || [];
    // Production's default colour changed over versions (red, orange, dark orange): it's bordeaux now.
    for (const c of this.connections) if (c.env === "prod" && ["#f85149", "#f0883e", "#d9661f"].includes(c.color)) c.color = "#9e1c2c";
    if (this.connections.length) this.saveConnections();
    // 0.3 and before suggested a 100,000-row plan-check threshold; the default is now 1,000.
    if (this.connections.some((c) => c.scanWarnRows === 100000)) {
      for (const c of this.connections) if (c.scanWarnRows === 100000) c.scanWarnRows = 1000;
      this.saveConnections();
    }
    this.history = hist || [];
    this.saved = saved || [];
    this.expanded = new Set(expanded || []);
    this.ui = ui || {};
    if (this.ui.sidebar) $("#sidebar").style.width = this.ui.sidebar + "px";
    this.bindChrome();
    this.renderTree();
    this.renderTabs();
    this.helperState("starting");
    try {
      await connectHelper();
      this.helperState("ok");
    } catch (e) {
      this.helperState("error", e.message);
    }
    for (const t of tabs || []) {
      const conn = this.connById(t.connId);
      if (!conn) continue;
      if (t.kind === "query") this.addTab(new QueryTab(this, { conn, schema: t.schema, sql: t.sql, savedId: t.savedId }), false);
      else if (t.kind === "table") this.addTab(new TableTab(this, { conn, schema: t.schema, table: t.table, section: t.section }), false);
      else if (t.kind === "sessions") this.addTab(new SessionsTab(this, { conn }), false);
    }
    if (this.tabs.length) this.activate(this.tabs[0]);
    this.renderTabs();
    // Re-open what was expanded (lazily: each level loads when its parent is shown).
    this.renderTree();
    this.pollStatus();
  }

  connById(id) {
    return this.connections.find((c) => c.id === id);
  }

  isConnected(id) {
    return !!this.schemas.get(id)?.list;
  }

  /** Database names of a connected connection (no round trip), or null. */
  schemaNames(id) {
    return this.schemas.get(id)?.list?.map((s) => s.name) || null;
  }

  helperState(state, message = "") {
    const el = $("#helper");
    el.className = "helper " + state;
    el.innerHTML =
      state === "ok"
        ? `<span class="dot ok"></span><span class="faint">Helper running</span>`
        : state === "starting"
          ? `<span class="spinner"></span><span class="faint">Starting helper…</span>`
          : `<span class="dot err"></span><span class="error-text" title="${esc(message)}">${esc(message || "Helper stopped")}</span><button class="ghost restart">Restart</button>`;
    el.querySelector(".restart")?.addEventListener("click", async () => {
      this.helperState("starting");
      try {
        await restartHelper();
        this.helperState("ok");
      } catch (e) {
        this.helperState("error", e.message);
      }
    });
  }

  async pollStatus() {
    const tick = async () => {
      if (document.hidden) return;
      try {
        const s = await call("/status", {}, { timeoutMs: 5000 });
        const changed = JSON.stringify(s.sessions) !== JSON.stringify(this.sessions) || JSON.stringify(s.running.map((r) => r.queryId)) !== JSON.stringify(this.running.map((r) => r.queryId));
        this.sessions = s.sessions;
        this.running = s.running;
        if (changed) this.renderTree();
        if ($("#helper").classList.contains("error")) this.helperState("ok");
      } catch (e) {
        this.helperState("error", e.message);
      }
    };
    setInterval(tick, 3000);
    octopus.on("visible", (shown) => shown && tick());
  }

  // ---- Storage ----

  saveConnections() {
    return octopus.storage.set("connections", this.connections);
  }

  saveExpanded() {
    octopus.storage.set("expanded", [...this.expanded]);
  }

  addHistory(entry) {
    this.history.unshift(entry);
    // The last 300 statements; same text run again moves up instead of repeating.
    const seen = new Set();
    this.history = this.history.filter((h) => {
      const k = h.connId + "\u0000" + h.sql.trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 300);
    octopus.storage.set("history", this.history);
  }

  tabChanged(tab) {
    clearTimeout(this.saveTabsTimer);
    this.saveTabsTimer = setTimeout(() => octopus.storage.set("tabs", this.tabs.map((t) => t.serialize())), 500);
    const el = document.querySelector(`.tab[data-id="${tab.id}"] .tab-label`);
    if (el) el.textContent = tab.title;
    document.querySelector(`.tab[data-id="${tab.id}"]`)?.classList.toggle("running", !!tab.running);
  }

  // ---- Data for the tree ----

  schemasOf(connId, force = false) {
    const conn = this.connById(connId);
    let s = this.schemas.get(connId);
    if (s && !force) return s.promise;
    s = { loading: true };
    s.promise = call("/schemas", { conn: wire(conn) })
      .then((list) => {
        s.list = list;
        // It connected: whatever password it has (maybe none) is the right one.
        if (conn.needsPassword) (delete conn.needsPassword, this.saveConnections());
        for (const t of this.tabs) if (t.connId === connId) t.connectionChanged?.();
        return list;
      })
      .catch((e) => {
        s.error = e.message;
        return null;
      })
      .finally(() => {
        s.loading = false;
        this.renderTree();
      });
    this.schemas.set(connId, s);
    return s.promise;
  }

  /** Tables, views and routines of a schema (cached); resolves with them, or null on error. */
  objectsOf(connId, schema, force = false) {
    return this.cached(this.objects, key(connId, schema), force, () => call("/objects", { conn: wire(this.connById(connId)), schema }));
  }

  /** A table's columns (cached); resolves with them, or null on error. */
  columnsOf(connId, schema, table, force = false) {
    return this.cached(this.columns, key(connId, schema, table), force, () => call("/columns", { conn: wire(this.connById(connId)), schema, table }));
  }

  cached(map, k, force, load) {
    const have = map.get(k);
    if (have && !force) return have.loading ? have.promise : Promise.resolve(have.error ? null : have);
    const entry = { loading: true };
    entry.promise = load()
      .then((v) => (map.set(k, v), v))
      .catch((e) => (map.set(k, { error: e.message }), null))
      .finally(() => this.renderTree());
    map.set(k, entry);
    return entry.promise;
  }

  // ---- Tree ----

  bindChrome() {
    $("#new-conn").onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left, clientY: r.bottom + 2 }, [
        { label: "New connection…", icon: icons.plus, action: () => this.newConnection() },
        { label: "Import from other apps…", icon: icons.download, action: () => this.importConnections() },
      ]);
    };
    const groupBtn = $("#group-env");
    groupBtn.innerHTML = icons.group;
    groupBtn.classList.toggle("on", !!this.ui.groupByEnv);
    groupBtn.onclick = () => {
      this.ui.groupByEnv = !this.ui.groupByEnv;
      groupBtn.classList.toggle("on", this.ui.groupByEnv);
      octopus.storage.set("ui", this.ui);
      this.renderTree();
    };
    $("#filter").addEventListener("input", (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      this.renderTree();
    });
    const tree = $("#tree");
    tree.addEventListener("click", (e) => {
      const row = e.target.closest(".node");
      if (!row) return;
      const n = this.nodes.get(row.dataset.key);
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) return this.nodeAction(n, act, e);
      if (n.type === "saved") return this.openSaved(n.savedId);
      if (n.type === "conn" && !this.expanded.has(n.key)) return this.connect(this.connById(n.connId));
      if (e.target.closest(".caret") || n.type !== "table") return this.toggle(n);
      this.openTable(this.connById(n.connId), n.schema, n.name);
    });
    tree.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".node");
      const n = row && this.nodes.get(row.dataset.key);
      if (n?.type === "table" && !e.target.closest(".caret, [data-act]")) this.openData(n);
      if (n?.type === "column") this.insertText(quoteIdent(n.name));
    });
    tree.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".node");
      if (row) this.nodeMenu(this.nodes.get(row.dataset.key), e);
    });
    // Sidebar resize.
    $("#vsplit").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const side = $("#sidebar");
      const x0 = e.clientX;
      const w0 = side.offsetWidth;
      const move = (ev) => (side.style.width = Math.max(180, Math.min(600, w0 + ev.clientX - x0)) + "px");
      const up = () => {
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
        this.ui.sidebar = side.offsetWidth;
        octopus.storage.set("ui", this.ui);
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
    addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        const conn = this.activeTab?.conn || this.connections[0];
        if (conn) this.openQuery(conn, this.activeTab?.schema);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "s" && this.activeTab?.kind === "query") {
        e.preventDefault();
        this.saveTab(this.activeTab, e.shiftKey);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "w" && this.activeTab) {
        e.preventDefault();
        this.closeTab(this.activeTab);
      }
    });
  }

  toggle(n) {
    if (this.expanded.has(n.key)) this.expanded.delete(n.key);
    else this.expanded.add(n.key);
    this.saveExpanded();
    this.renderTree();
  }

  renderTree() {
    const tree = $("#tree");
    this.nodes.clear();
    if (!this.connections.length) {
      tree.innerHTML = `<div class="empty-tree muted">No connections yet.<br><button class="primary" id="first-conn">${icons.plus}<span>New connection</span></button><br><button class="ghost" id="first-import">${icons.download}<span>Import from other apps…</span></button></div>`;
      $("#first-conn").onclick = () => this.newConnection();
      $("#first-import").onclick = () => this.importConnections();
      return;
    }
    const out = [];
    const f = this.filter;
    const row = (n, depth, { icon, label, meta = "", actions = "", caret = true, cls = "", title = "" }) => {
      this.nodes.set(n.key, n);
      // Environment groups start open: their key in `expanded` means collapsed.
      const open = n.type === "env" ? !this.expanded.has(n.key) || !!f : this.expanded.has(n.key) || (f && n.type !== "table" && n.type !== "conn");
      out.push(
        `<div class="node ${cls}" data-key="${esc(n.key)}" style="padding-left:${4 + (depth + base) * 12}px" title="${esc(title)}">` +
          `<span class="caret ${caret ? (open ? "open" : "") : "none"}">${caret ? icons.chevron : ""}</span>` +
          `<span class="ic">${icon}</span><span class="label">${label}</span><span class="meta">${meta}</span>` +
          `<span class="acts">${actions}</span></div>`,
      );
      return caret && open;
    };
    const act = (name, icon, title) => `<button class="ghost icon" data-act="${name}" title="${title}">${icon}</button>`;
    const status = (depth, s) => out.push(`<div class="node status" style="padding-left:${16 + (depth + base) * 12}px">${s}</div>`);

    // Grouped by environment: Production, Staging, Development headers, each connection indented under its own.
    const grouped = !!this.ui.groupByEnv;
    const envOf = (c) => (ENVS[c.env] ? c.env : "dev");
    const order = ["prod", "staging", "dev"];
    const conns = grouped ? order.flatMap((e) => this.connections.filter((c) => envOf(c) === e)) : this.connections;
    let base = 0;
    let lastEnv = null;
    let envOpen = true;
    for (const c of conns) {
      if (grouped && envOf(c) !== lastEnv) {
        lastEnv = envOf(c);
        base = 0;
        const count = this.connections.filter((x) => envOf(x) === lastEnv).length;
        envOpen = row({ type: "env", key: key("env", lastEnv), env: lastEnv }, 0, {
          icon: `<span class="env-dot ${lastEnv}"></span>`,
          label: ENVS[lastEnv],
          meta: `<span class="faint">${count}</span>`,
          actions: act("newconn", icons.plus, `New ${ENVS[lastEnv].toLowerCase()} connection`),
          cls: "env-group",
        });
        base = 1;
      }
      if (grouped && !envOpen) continue;
      const n = { type: "conn", key: key("c", c.id), connId: c.id };
      const sessions = this.sessions[c.id] || 0;
      const running = this.running.filter((r) => r.connId === c.id).length;
      const connected = this.isConnected(c.id);
      const open = row(n, 0, {
        icon: `<span class="conn-ic" ${c.color ? `style="--c:${c.color}"` : ""}>${icons.server}</span>`,
        label: `${esc(c.name)}${connected ? `<span class="dot ok" title="Connected · ${sessions} session(s) open on the server now (idle ones close after a minute and reopen when needed)"></span>` : ""}`,
        meta: `${c.needsPassword ? `<span class="badge warn" data-act="edit" title="Imported from ${esc(c.importedFrom || "another app")} without its password: click to add it">no password</span>` : ""}${running ? `<span class="badge warn" title="Running statements" data-act="sessions">${running} running</span>` : ""}${c.env === "prod" ? '<span class="env-tag prod" title="Production: always read-only">PROD</span>' : c.env === "staging" ? '<span class="env-tag staging">STG</span>' : ""}${c.readOnly ? `<span class="ro" title="Read-only">${icons.lock}</span>` : ""}`,
        actions: act("query", icons.query, "New query (⌘T)") + act("sessions", icons.pulse, "Sessions: running queries, kill") + act("menu", "⋯", "More"),
        title: `${c.user}@${c.host}:${c.port}${c.database ? "/" + c.database : ""}`,
        cls: "conn",
      });
      if (!open) continue;
      const saved = this.saved.filter((q) => q.connId === c.id && (!f || q.name.toLowerCase().includes(f)));
      if (saved.length) {
        const qn = { type: "group", key: key("sq", c.id), connId: c.id };
        if (row(qn, 1, { icon: icons.star, label: "Saved queries", meta: `<span class="faint">${saved.length}</span>`, cls: "group saved-group" })) {
          for (const q of saved.sort((a, b) => a.name.localeCompare(b.name))) {
            row({ type: "saved", key: key("q", q.id), connId: c.id, savedId: q.id }, 2, {
              icon: icons.query,
              label: highlightMatch(q.name, f),
              meta: q.schema ? `<span class="faint">${esc(q.schema)}</span>` : "",
              actions: act("run", icons.play, "Run"),
              caret: false,
              title: q.sql.slice(0, 500),
            });
          }
        }
      }
      const s = this.schemas.get(c.id);
      if (!s) {
        this.schemasOf(c.id);
        status(1, '<span class="spinner"></span> Connecting…');
        continue;
      }
      if (s.loading) {
        status(1, '<span class="spinner"></span> Connecting…');
        continue;
      }
      if (s.error) {
        status(1, `<span class="error-text">${esc(s.error)}</span> <a href="#" data-retry="${esc(c.id)}">Retry</a>`);
        continue;
      }
      const list = [...s.list].sort((a, b) => a.system - b.system || a.name.localeCompare(b.name));
      for (const sc of list) {
        const sn = { type: "schema", key: key("s", c.id, sc.name), connId: c.id, schema: sc.name };
        const objs = this.objects.get(key(c.id, sc.name));
        if (f && !sc.name.toLowerCase().includes(f) && !(objs?.tables || []).concat(objs?.views || []).some((t) => t.name.toLowerCase().includes(f)) && !this.expanded.has(sn.key)) continue;
        const sOpen = row(sn, 1, {
          icon: icons.schema,
          label: esc(sc.name),
          meta: `<span class="faint">${sc.tables}</span>`,
          actions: act("query", icons.query, "New query in this database"),
          cls: sc.system ? "system" : "",
          title: `${sc.charset} · ${sc.collation}`,
        });
        if (!sOpen || (f && !this.expanded.has(sn.key))) continue;
        if (!objs) {
          this.objectsOf(c.id, sc.name);
          status(2, '<span class="spinner"></span> Loading…');
          continue;
        }
        if (objs.loading) {
          status(2, '<span class="spinner"></span> Loading…');
          continue;
        }
        if (objs.error) {
          status(2, `<span class="error-text">${esc(objs.error)}</span>`);
          continue;
        }
        const groups = [
          ["tables", "Tables", icons.table],
          ["views", "Views", icons.view],
          ["routines", "Routines", icons.routine],
        ];
        for (const [g, gl, gi] of groups) {
          const items = objs[g].filter((t) => !f || t.name.toLowerCase().includes(f));
          if (!objs[g].length) continue;
          const gn = { type: "group", key: key("g", c.id, sc.name, g), connId: c.id, schema: sc.name };
          const gOpen = row(gn, 2, { icon: "", label: gl, meta: `<span class="faint">${f ? `${items.length}/` : ""}${objs[g].length}</span>`, cls: "group" });
          if (!gOpen) continue;
          for (const t of items) {
            if (g === "routines") {
              const rn = { type: "routine", key: key("r", c.id, sc.name, t.name), connId: c.id, schema: sc.name, name: t.name };
              row(rn, 3, { icon: gi, label: esc(t.name), meta: `<span class="faint">${esc(t.type.toLowerCase())}</span>`, caret: false, title: t.comment || "" });
              continue;
            }
            const tn = { type: "table", key: key("t", c.id, sc.name, t.name), connId: c.id, schema: sc.name, name: t.name, view: g === "views" };
            const tOpen = row(tn, 3, {
              icon: gi,
              label: highlightMatch(t.name, f),
              meta: g === "tables" && t.rows !== null ? `<span class="faint" title="≈${fmtNum(t.rows)} rows · ${fmtBytes(t.dataBytes)} data · ${fmtBytes(t.indexBytes)} indexes">${shortNum(t.rows)}</span>` : "",
              actions: act("data", icons.data, "First rows") + act("query", icons.query, "New query on this table"),
              title: t.comment || "",
            });
            if (!tOpen) continue;
            const cols = this.columns.get(key(c.id, sc.name, t.name));
            if (!cols) {
              this.columnsOf(c.id, sc.name, t.name);
              status(4, '<span class="spinner"></span>');
            } else if (cols.loading) status(4, '<span class="spinner"></span>');
            else if (cols.error) status(4, `<span class="error-text">${esc(cols.error)}</span>`);
            else
              for (const col of cols) {
                const cn = { type: "column", key: key("col", c.id, sc.name, t.name, col.name), connId: c.id, schema: sc.name, table: t.name, name: col.name };
                row(cn, 4, {
                  icon: col.key === "PRI" ? `<span class="pk">${icons.key}</span>` : col.key === "MUL" || col.key === "UNI" ? `<span class="ix">${icons.index}</span>` : icons.column,
                  label: esc(col.name),
                  meta: `<span class="faint mono">${esc(col.type)}${col.nullable ? "" : " ·nn"}</span>`,
                  caret: false,
                  cls: "column",
                  title: [col.type, col.nullable ? "NULL" : "NOT NULL", col.default !== null ? `default ${col.default}` : "", col.extra, col.comment].filter(Boolean).join(" · "),
                });
              }
          }
        }
      }
    }
    const scrollTop = tree.scrollTop;
    tree.innerHTML = out.join("");
    tree.scrollTop = scrollTop;
    tree.querySelectorAll("[data-retry]").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.schemasOf(a.dataset.retry, true);
      }),
    );
  }

  nodeAction(n, act, e) {
    if (act === "newconn") return this.newConnection({ env: n.env });
    const conn = this.connById(n.connId);
    if (act === "menu") return this.nodeMenu(n, e);
    if (act === "data") return this.openData(n);
    if (act === "sessions") return this.openSessions(conn);
    if (act === "edit") return this.editConn(conn);
    if (act === "run") return this.openSaved(n.savedId, true);
    if (act === "query") {
      if (n.type === "table") return this.openQuery(conn, n.schema, `SELECT *\nFROM ${quoteIdent(n.name)}\nLIMIT ${conn.rowLimit || 200};`);
      return this.openQuery(conn, n.schema || conn.database);
    }
  }

  nodeMenu(n, e) {
    const conn = this.connById(n.connId);
    if (n.type === "env") {
      contextMenu(e, [
        { label: `New ${ENVS[n.env].toLowerCase()} connection…`, icon: icons.plus, action: () => this.newConnection({ env: n.env }) },
        { label: "Disconnect all", icon: icons.disconnect, action: () => this.connections.filter((c) => (ENVS[c.env] ? c.env : "dev") === n.env && this.isConnected(c.id)).forEach((c) => this.disconnect(c)) },
        { separator: true },
        { label: "Ungroup", icon: icons.group, action: () => $("#group-env").click() },
      ]);
    } else if (n.type === "conn") {
      const sessions = this.sessions[conn.id] || 0;
      const connected = this.isConnected(conn.id) || sessions > 0;
      contextMenu(e, [
        connected
          ? { label: `Disconnect${sessions ? ` (${sessions} session${sessions > 1 ? "s" : ""} open)` : ""}`, icon: icons.disconnect, action: () => this.disconnect(conn) }
          : { label: "Connect", icon: icons.plug, action: () => this.connect(conn) },
        { separator: true },
        { label: "New query", icon: icons.query, action: () => this.openQuery(conn, conn.database) },
        { label: "Sessions and running queries", icon: icons.pulse, action: () => this.openSessions(conn) },
        { label: "Refresh", icon: icons.refresh, disabled: !connected, action: () => this.refreshConn(conn.id) },
        { separator: true },
        { label: "Edit…", icon: icons.edit, action: () => this.editConn(conn) },
        { label: "Duplicate…", icon: icons.copy, action: () => this.duplicateConn(conn) },
        { separator: true },
        { label: "Delete", icon: icons.trash, danger: true, action: () => this.deleteConn(conn) },
      ]);
    } else if (n.type === "saved") {
      const q = this.saved.find((x) => x.id === n.savedId);
      contextMenu(e, [
        { label: "Open", icon: icons.query, action: () => this.openSaved(q.id) },
        { label: "Run", icon: icons.play, action: () => this.openSaved(q.id, true) },
        { separator: true },
        { label: "Rename…", icon: icons.edit, action: () => this.renameSaved(q) },
        { label: "Copy SQL", icon: icons.copy, action: () => (octopus.copy(q.sql), octopus.toast("Copied", "info")) },
        { separator: true },
        { label: "Delete", icon: icons.trash, danger: true, action: () => this.deleteSaved(q) },
      ]);
    } else if (n.type === "schema") {
      contextMenu(e, [
        { label: "New query", icon: icons.query, action: () => this.openQuery(conn, n.schema) },
        { label: "Refresh", icon: icons.refresh, action: () => this.objectsOf(conn.id, n.schema, true) },
        { label: "Copy name", icon: icons.copy, action: () => octopus.copy(n.schema) },
      ]);
    } else if (n.type === "table") {
      contextMenu(e, [
        { label: "Structure", icon: icons.table, action: () => this.openTable(conn, n.schema, n.name) },
        { label: "First rows", icon: icons.data, action: () => this.openData(n) },
        { label: "New query", icon: icons.query, action: () => this.nodeAction(n, "query") },
        { label: "Count rows (exact)", icon: icons.index, action: () => this.openQuery(conn, n.schema, `SELECT COUNT(*)\nFROM ${quoteIdent(n.name)};`, true) },
        { separator: true },
        { label: "Copy name", icon: icons.copy, action: () => octopus.copy(n.name) },
        { label: "Insert name in editor", icon: icons.edit, action: () => this.insertText(quoteIdent(n.name)) },
        { label: "Refresh columns", icon: icons.refresh, action: () => this.columnsOf(conn.id, n.schema, n.name, true) },
      ]);
    } else if (n.type === "column") {
      contextMenu(e, [
        { label: "Copy name", icon: icons.copy, action: () => octopus.copy(n.name) },
        { label: "Insert name in editor", icon: icons.edit, action: () => this.insertText(quoteIdent(n.name)) },
        {
          label: "Distinct values (top 100)",
          icon: icons.data,
          action: () => this.openQuery(conn, n.schema, `SELECT ${quoteIdent(n.name)}, COUNT(*) AS n\nFROM ${quoteIdent(n.table)}\nGROUP BY ${quoteIdent(n.name)}\nORDER BY n DESC\nLIMIT 100;`, true),
        },
      ]);
    }
  }

  insertText(text) {
    const t = this.activeTab;
    if (t?.kind !== "query") return octopus.copy(text);
    t.ta.focus();
    document.execCommand("insertText", false, text);
  }

  refreshConn(id) {
    const wasConnected = this.isConnected(id);
    this.forget(id);
    if (wasConnected) this.schemasOf(id, true);
    this.renderTree();
    for (const t of this.tabs.filter((t) => t.connId === id)) t.kind === "query" ? t.refreshConn() : envBanner(t.el, t.conn);
  }

  connect(conn) {
    this.expanded.add(key("c", conn.id));
    this.saveExpanded();
    if (!this.isConnected(conn.id)) this.schemasOf(conn.id, true);
    this.renderTree();
  }

  /** Closes the connection's sessions on the server (killing what runs), forgets its tree and collapses it.
   * Nothing reconnects by itself: expanding it, Connect, or running a query does. */
  async disconnect(conn) {
    let r = { closed: 0, killed: 0 };
    try {
      r = await call("/disconnect", { id: conn.id });
    } catch (e) {
      octopus.toast(e.message, "error");
    }
    this.forget(conn.id);
    this.expanded.delete(key("c", conn.id));
    this.saveExpanded();
    this.sessions[conn.id] = 0;
    this.running = this.running.filter((x) => x.connId !== conn.id);
    this.renderTree();
    for (const t of this.tabs) if (t.connId === conn.id) t.connectionChanged?.();
    octopus.toast(`Disconnected ${conn.name}: ${r.closed} session(s) closed${r.killed ? `, ${r.killed} running statement(s) killed` : ""}`, "info");
  }

  forget(id) {
    this.schemas.delete(id);
    for (const m of [this.objects, this.columns]) for (const k of [...m.keys()]) if (JSON.parse(k)[0] === id) m.delete(k);
  }

  // ---- Saved queries ----

  saveSaved() {
    return octopus.storage.set("saved", this.saved);
  }

  async askName(title, value = "") {
    let name = null;
    await modal({
      title,
      body: `<div class="form"><label><span>Name</span><input name="qname" value="${esc(value)}" autofocus></label></div>`,
      buttons: [
        { label: "Cancel", value: null, cls: "ghost" },
        {
          label: "Save",
          cls: "primary",
          submit: true,
          check: (dlg) => {
            name = dlg.querySelector("[name=qname]").value.trim();
            return !!name;
          },
        },
      ],
      onOpen: (dlg) => dlg.querySelector("[name=qname]").select(),
    });
    return name;
  }

  /** Saves a query tab: updates its saved query, or asks a name and creates one (`asNew` always does). */
  async saveTab(tab, asNew = false) {
    let q = !asNew && this.saved.find((x) => x.id === tab.savedId);
    if (q) {
      Object.assign(q, { sql: tab.ta.value, schema: tab.schema, updatedAt: Date.now() });
    } else {
      const first = tab.ta.value.trim().split("\n")[0].replace(/^--\s*/, "").slice(0, 60);
      const name = await this.askName(asNew ? "Save query as" : "Save query", first);
      if (!name) return;
      q = { id: crypto.randomUUID(), connId: tab.connId, schema: tab.schema, name, sql: tab.ta.value, updatedAt: Date.now() };
      this.saved.push(q);
      tab.savedId = q.id;
      this.expanded.add(key("sq", tab.connId));
      this.saveExpanded();
    }
    await this.saveSaved();
    tab.savedChanged();
    this.renderTree();
    octopus.toast(`Saved “${q.name}”`, "success");
  }

  openSaved(id, run = false) {
    const q = this.saved.find((x) => x.id === id);
    const conn = q && this.connById(q.connId);
    if (!conn) return;
    const open = this.tabs.find((t) => t.kind === "query" && t.savedId === id);
    if (open) {
      this.activate(open);
      if (run) open.run(false, open.ta.value.trim());
      return open;
    }
    const tab = new QueryTab(this, { conn, schema: q.schema, sql: q.sql, savedId: id });
    this.addTab(tab);
    if (run) tab.run(false, q.sql.trim());
    return tab;
  }

  async renameSaved(q) {
    const name = await this.askName("Rename query", q.name);
    if (!name) return;
    q.name = name;
    await this.saveSaved();
    this.tabs.filter((t) => t.savedId === q.id).forEach((t) => t.savedChanged());
    this.renderTree();
  }

  async deleteSaved(q) {
    if (!(await confirmDialog("Delete saved query", `<p>Delete <b>${esc(q.name)}</b>?</p>`, "Delete", true))) return;
    this.saved = this.saved.filter((x) => x !== q);
    await this.saveSaved();
    this.tabs.filter((t) => t.savedId === q.id).forEach((t) => ((t.savedId = null), t.savedChanged()));
    this.renderTree();
  }

  // ---- Connections ----

  async newConnection(preset = {}) {
    const conn = await editConnection(null, { preset });
    if (!conn) return;
    this.connections.push(conn);
    await this.saveConnections();
    this.expanded.add(key("c", conn.id));
    this.saveExpanded();
    this.renderTree();
  }

  async importConnections() {
    const conns = await importConnections(this.connections);
    if (!conns.length) return;
    this.connections.push(...conns);
    await this.saveConnections();
    this.renderTree();
    this.renderWelcome();
    octopus.toast(`Imported ${conns.length} connection${conns.length > 1 ? "s" : ""}: add their passwords with Edit…`, "success");
  }

  async editConn(conn) {
    const has = await call("/secret/has", { ids: [conn.id] }).catch(() => ({}));
    const updated = await editConnection(conn, { hasPassword: !!has[conn.id] });
    if (!updated) return;
    await call("/disconnect", { id: conn.id }).catch(() => {});
    Object.assign(conn, updated);
    delete conn.needsPassword; // the form was saved: its password is what the user meant
    await this.saveConnections();
    this.refreshConn(conn.id);
  }

  async duplicateConn(conn) {
    const copy = await editConnection({ ...conn, id: undefined, name: conn.name + " copy" });
    if (!copy) return;
    this.connections.push(copy);
    await this.saveConnections();
    this.renderTree();
  }

  async deleteConn(conn) {
    const nSaved = this.saved.filter((q) => q.connId === conn.id).length;
    if (!(await confirmDialog("Delete connection", `<p>Delete <b>${esc(conn.name)}</b> and its password from the Keychain${nSaved ? `, with its ${nSaved} saved quer${nSaved > 1 ? "ies" : "y"}` : ""}? Its open tabs close.</p>`, "Delete", true))) return;
    await call("/disconnect", { id: conn.id }).catch(() => {});
    await call("/secret/delete", { id: conn.id }).catch(() => {});
    this.tabs.filter((t) => t.connId === conn.id).forEach((t) => this.closeTab(t));
    this.connections = this.connections.filter((c) => c !== conn);
    this.history = this.history.filter((h) => h.connId !== conn.id);
    octopus.storage.set("history", this.history);
    this.saved = this.saved.filter((q) => q.connId !== conn.id);
    this.saveSaved();
    await this.saveConnections();
    this.refreshConn(conn.id);
  }

  // ---- Tabs ----

  get activeTab() {
    return this.tabs.find((t) => t.id === this.active);
  }

  addTab(tab, activate = true) {
    tab.id = crypto.randomUUID();
    this.tabs.push(tab);
    tab.el.hidden = true;
    $("#panes").appendChild(tab.el);
    if (activate) this.activate(tab);
    this.tabChanged(tab);
  }

  activate(tab) {
    this.active = tab.id;
    for (const t of this.tabs) t.el.hidden = t !== tab;
    $("#welcome").hidden = true;
    this.renderTabs();
    if (tab.kind === "query") requestAnimationFrame(() => tab.focus());
  }

  closeTab(tab) {
    if (tab.running) tab.stop();
    tab.dispose?.();
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.el.remove();
    if (this.active === tab.id) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else this.active = null;
    }
    this.renderTabs();
    octopus.storage.set("tabs", this.tabs.map((t) => t.serialize()));
  }

  renderTabs() {
    const bar = $("#tabs");
    bar.innerHTML = this.tabs
      .map((t) => {
        const c = t.conn;
        return `<div class="tab ${t.id === this.active ? "active" : ""} ${t.running ? "running" : ""}" data-id="${t.id}" title="${esc(c?.name || "")}${t.schema ? " · " + esc(t.schema) : ""}">
          ${c?.color ? `<span class="tab-color" style="background:${c.color}"></span>` : ""}
          <span class="tab-ic">${{ query: icons.query, table: icons.table, sessions: icons.pulse }[t.kind]}</span><span class="tab-label">${esc(t.title)}</span>
          <button class="ghost icon tab-close" title="Close (⌘W)">${icons.close}</button></div>`;
      })
      .join("");
    bar.querySelectorAll(".tab").forEach((el) => {
      const tab = this.tabs.find((t) => t.id === el.dataset.id);
      el.addEventListener("mousedown", (e) => {
        if (e.button === 1) return this.closeTab(tab);
        if (!e.target.closest(".tab-close")) this.activate(tab);
      });
      el.querySelector(".tab-close").addEventListener("click", () => this.closeTab(tab));
    });
    $("#welcome").hidden = this.tabs.length > 0;
    if (!this.tabs.length) this.renderWelcome();
  }

  renderWelcome() {
    $("#welcome").innerHTML = `
      <div class="welcome-inner">
        <div class="strong">Db Viewer</div>
        <p class="muted">Pick a table in the tree to see its structure, or open a query on a connection (⌘T).</p>
        <ul class="muted small">
          <li>Passwords are stored in the macOS Keychain, never in Octopus's storage.</li>
          <li>Production and staging connections are read-only: the server session is READ ONLY.</li>
          <li>On a writable connection every change asks first, and can be dry-run: executed, previewed, rolled back.</li>
          <li>SELECTs without LIMIT get one; rows past the limit are never fetched.</li>
          <li>A statement running past the connection's timeout is killed on the server.</li>
          <li>Idle sessions close after a minute.</li>
        </ul>
        ${this.connections.length ? "" : `<button class="primary" id="welcome-new">${icons.plus}<span>New connection</span></button> <button class="ghost" id="welcome-import">${icons.download}<span>Import from other apps…</span></button>`}
      </div>`;
    $("#welcome-new")?.addEventListener("click", () => this.newConnection());
    $("#welcome-import")?.addEventListener("click", () => this.importConnections());
  }

  openQuery(conn, schema, sql = "", run = false) {
    const tab = new QueryTab(this, { conn, schema, sql });
    this.addTab(tab);
    if (run) tab.run();
    return tab;
  }

  openTable(conn, schema, table, section) {
    const existing = this.tabs.find((t) => t.kind === "table" && t.connId === conn.id && t.schema === schema && t.table === table);
    if (existing) {
      this.activate(existing);
      if (section) existing.show(section);
      return existing;
    }
    const tab = new TableTab(this, { conn, schema, table, section });
    this.addTab(tab);
    return tab;
  }

  openSessions(conn) {
    const existing = this.tabs.find((t) => t.kind === "sessions" && t.connId === conn.id);
    if (existing) {
      this.activate(existing);
      return existing.load();
    }
    this.addTab(new SessionsTab(this, { conn }));
  }

  openData(n) {
    this.openTable(this.connById(n.connId), n.schema, n.name, "Data");
  }
}

function shortNum(n) {
  n = Number(n);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "k";
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + "M";
  return (n / 1e9).toFixed(1) + "B";
}

function highlightMatch(name, f) {
  if (!f) return esc(name);
  const i = name.toLowerCase().indexOf(f);
  if (i < 0) return esc(name);
  return esc(name.slice(0, i)) + `<mark>${esc(name.slice(i, i + f.length))}</mark>` + esc(name.slice(i + f.length));
}

const app = new App();
window.dbViewer = app;
app.start().catch((e) => {
  document.body.insertAdjacentHTML("afterbegin", `<div class="fatal error-text">${esc(e.message)}</div>`);
});
