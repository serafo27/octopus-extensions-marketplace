// A query tab: an SQL editor (highlighted), Run/Stop, and the result grid with what the server did (LIMIT added,
// rows capped, time, thread) — the statement is killed on the server when it outlives the connection's timeout.
import { call, wire } from "./api.js";
import { Completer } from "./complete.js";
import { cellText, Grid, toCsv, toJson, toTsv } from "./grid.js";
import { icons } from "./icons.js";
import { highlight, statementAt, tokenize } from "./sql.js";
import { confirmDialog, contextMenu, esc, fmtMs, fmtNum, modal } from "./ui.js";

export function showValue(column, v) {
  let text = cellText(v);
  let pretty = text;
  if (text && /^[[{]/.test(text.trim())) {
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  const extra = v && typeof v === "object" && v.cut ? `<div class="warn-line">Cut: the value has ${fmtNum(v.bytes || v.chars)} ${v.bytes ? "bytes" : "characters"}; only the start was fetched.</div>` : "";
  modal({
    title: `${column.name} · ${column.type || ""}`,
    body: `${extra}<pre class="value-view">${text === null ? '<span class="null">NULL</span>' : esc(pretty)}</pre>`,
    wide: true,
    buttons: [
      { label: "Copy", cls: "ghost", action: () => (octopus.copy(text ?? "NULL"), octopus.toast("Copied", "info")) },
      { label: "Close", value: null, cls: "primary", submit: true },
    ],
  });
}

/** The strip at the top of a production (or staging) connection's tabs. */
export function envBanner(el, c) {
  let b = el.querySelector(":scope > .env-banner");
  const env = c?.env;
  if (env !== "prod" && env !== "staging") return b?.remove();
  if (!b) {
    b = document.createElement("div");
    el.prepend(b);
  }
  b.className = `env-banner ${env}`;
  b.innerHTML =
    env === "prod"
      ? `${icons.lock}<b>PRODUCTION</b><span>${esc(c.name)} · read-only · at most 1,000 rows · killed after ${c.timeoutMs / 1000} s</span>`
      : `<b>STAGING</b><span>${esc(c.name)}${c.readOnly ? " · read-only" : ""}</span>`;
}

/** Asks before a write: "run", "dry" (preview it first, when it can be) or null. */
async function confirmWrite(conn, kind, html) {
  const dryable = /^(UPDATE|DELETE|INSERT|REPLACE)$/.test(kind);
  return modal({
    title: `Run ${kind}?`,
    body: html + (dryable ? '<p class="muted small">Dry run executes it in a transaction, shows the rows before → after, and rolls it back.</p>' : ""),
    onOpen: (dlg) => dlg.querySelector(".modal-foot button")?.focus(),
    buttons: [
      { label: "Cancel", value: null, cls: "ghost" },
      ...(dryable ? [{ label: "Dry run first", value: "dry", cls: "ghost" }] : []),
      { label: `Run ${kind}`, value: "run", cls: "danger", submit: true },
    ],
  });
}

function planTable(plan) {
  if (!plan?.rows?.length) return "";
  const cols = ["table", "type", "key", "rows", "filtered", "Extra"];
  return `<table class="props plan"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${plan.rows
    .map((r) => `<tr class="${r.type === "ALL" ? "bad" : ""}">${cols.map((c) => `<td class="mono">${r[c] === null || r[c] === undefined ? '<span class="faint">—</span>' : esc(c === "rows" ? fmtNum(r[c]) : r[c])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

export class QueryTab {
  constructor(app, { conn, schema, sql, savedId = null }) {
    this.app = app;
    this.kind = "query";
    this.savedId = savedId;
    this.connId = conn.id;
    this.schema = schema || conn.database || "";
    this.running = null;
    this.result = null;
    this.el = document.createElement("div");
    this.el.className = "query-tab";
    this.el.innerHTML = `
      <div class="toolbar q-toolbar">
        <button class="primary run" title="Run the statement under the cursor, or the selection (⌘↵)">${icons.play}<span>Run</span></button>
        <button class="ghost stop" title="Kill the running statement on the server (Esc)" hidden>${icons.stop}<span>Stop</span></button>
        <button class="ghost explain" title="EXPLAIN the statement under the cursor: how MySQL would run it, without running it">${icons.info}<span>Explain</span></button>
        <button class="ghost dryrun" title="Dry run (⇧⌘↵): run the change in a transaction, show the rows before → after, roll it back" hidden>${icons.beaker}<span>Dry run</span></button>
        <span class="sep"></span>
        <span class="conn-chip"></span>
        <select class="schema" title="Database the statement runs in"></select>
        <span class="sep"></span>
        <label class="limit" title="LIMIT added to SELECTs without one; more rows than this are never fetched">Limit <input type="number" min="1" max="50000"></label>
        <span class="grow"></span>
        <button class="ghost save" title="Save this query (⌘S; ⇧⌘S saves as a new one)">${icons.save}<span>Save</span></button>
        <button class="ghost icon history" title="History">${icons.history}</button>
      </div>
      <div class="editor"><pre class="hl" aria-hidden="true"></pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>
      <div class="hsplit" title="Drag to resize"></div>
      <div class="results">
        <div class="res-status toolbar"><span class="res-info muted">Run a query: ⌘↵ runs the statement under the cursor.</span><span class="grow"></span>
          <span class="res-actions" hidden>
            <button class="ghost export" title="Copy or export the rows">${icons.download}<span>Export</span></button>
          </span>
          <button class="danger apply" hidden title="Run the statement for real (no more rollback)">${icons.play}<span>Apply for real</span></button>
        </div>
        <div class="res-body"><div class="res-grid"></div><div class="res-msg" hidden></div></div>
      </div>`;
    this.ta = this.el.querySelector("textarea");
    this.hl = this.el.querySelector(".hl");
    this.limitInput = this.el.querySelector(".limit input");
    this.schemaSel = this.el.querySelector("select.schema");
    this.grid = new Grid(this.el.querySelector(".res-grid"), { onCellOpen: (col, v) => showValue(col, v) });
    this.ta.value = sql ?? "";
    this.limitInput.value = conn.rowLimit || 200;
    this.paintEditor();
    this.bind();
    this.completer = new Completer(this);
    this.refreshConn();
  }

  get conn() {
    return this.app.connById(this.connId);
  }

  get saved() {
    return this.savedId ? this.app.saved.find((q) => q.id === this.savedId) : null;
  }

  get title() {
    const q = this.saved;
    if (q) return (q.sql !== this.ta.value ? "• " : "") + q.name;
    const first = this.ta.value.trim().split("\n")[0].slice(0, 28);
    return first || "Query";
  }

  /** The saved query this tab edits was saved, renamed or deleted. */
  savedChanged() {
    const q = this.saved;
    this.el.querySelector(".save span").textContent = q ? "Save" : "Save";
    this.el.querySelector(".save").title = q ? `Save “${q.name}” (⌘S; ⇧⌘S saves as a new one)` : "Save this query (⌘S)";
    this.app.tabChanged(this);
  }

  /** Connected or disconnected: the database list follows. */
  connectionChanged() {
    this.refreshConn();
  }

  refreshConn() {
    const c = this.conn;
    if (!c) return;
    envBanner(this.el, c);
    this.el.querySelector(".dryrun").hidden = c.readOnly;
    this.limitInput.max = c.env === "prod" ? 1000 : 50000;
    if (c.env === "prod" && Number(this.limitInput.value) > 1000) this.limitInput.value = 1000;
    const chip = this.el.querySelector(".conn-chip");
    chip.innerHTML = `${c.color ? `<span class="dot" style="background:${c.color}"></span>` : ""}${esc(c.name)}${c.readOnly ? ` <span class="badge" title="Read-only connection">${icons.lock} read-only</span>` : ' <span class="badge warn" title="Writes allowed (asked each time)">writable</span>'}`;
    // Only a connected connection lists its databases: a tab doesn't reconnect by itself.
    const names = [...(this.app.schemaNames(c.id) || [])];
    if (this.schema && !names.includes(this.schema)) names.unshift(this.schema);
    this.schemaSel.innerHTML = `<option value="">(no database)</option>` + names.map((n) => `<option ${n === this.schema ? "selected" : ""}>${esc(n)}</option>`).join("");
  }

  bind() {
    const ta = this.ta;
    ta.addEventListener("input", () => {
      this.paintEditor();
      this.app.tabChanged(this);
    });
    ta.addEventListener("scroll", () => {
      this.hl.scrollTop = ta.scrollTop;
      this.hl.scrollLeft = ta.scrollLeft;
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) this.dryRun();
        else this.run();
      } else if (e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        document.execCommand("insertText", false, "  ");
      } else if (e.key === "Escape" && this.running) {
        this.stop();
      }
    });
    this.el.querySelector(".run").onclick = () => this.run();
    this.el.querySelector(".stop").onclick = () => this.stop();
    this.el.querySelector(".explain").onclick = () => {
      const sql = this.target().trim();
      if (sql) this.run(false, /^explain\b/i.test(sql) ? sql : `EXPLAIN ${sql}`);
    };
    this.el.querySelector(".history").onclick = () => this.showHistory();
    this.el.querySelector(".save").onclick = (e) => this.app.saveTab(this, e.shiftKey);
    this.el.querySelector(".dryrun").onclick = () => this.dryRun();
    this.el.querySelector(".apply").onclick = () => {
      const sql = this.dryRunSql;
      this.el.querySelector(".apply").hidden = true;
      if (sql) this.run(true, sql);
    };
    this.el.querySelector(".export").onclick = (e) => this.exportMenu(e);
    this.schemaSel.onchange = () => {
      this.schema = this.schemaSel.value;
      this.app.tabChanged(this);
    };
    // Editor / results splitter.
    const split = this.el.querySelector(".hsplit");
    split.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const editor = this.el.querySelector(".editor");
      const y0 = e.clientY;
      const h0 = editor.offsetHeight;
      const move = (ev) => (editor.style.height = Math.max(60, Math.min(this.el.offsetHeight - 120, h0 + ev.clientY - y0)) + "px");
      const up = () => {
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
  }

  paintEditor() {
    // The trailing newline keeps the <pre> as tall as the textarea when the text ends with one.
    this.hl.innerHTML = highlight(this.ta.value) + "\n";
  }

  focus() {
    this.ta.focus();
  }

  setSql(sql, run = false) {
    this.ta.value = sql;
    this.paintEditor();
    this.app.tabChanged(this);
    if (run) this.run();
  }

  /** The text to run: the selection, else the statement under the cursor. */
  target() {
    const { selectionStart: a, selectionEnd: b, value } = this.ta;
    if (b > a && value.slice(a, b).trim()) return value.slice(a, b);
    return statementAt(value, a)?.text?.trim() || "";
  }

  async run(confirmed = false, sqlOverride = null, planChecked = false) {
    if (this.running) return;
    const conn = this.conn;
    const sql = sqlOverride ?? this.target();
    if (!sql) return;
    const queryId = crypto.randomUUID();
    const limit = Number(this.limitInput.value) || conn.rowLimit || 200;
    const started = Date.now();
    this.running = { queryId, started };
    this.setRunning(true);
    const info = this.el.querySelector(".res-info");
    const tick = () => {
      if (!this.running) return;
      info.innerHTML = `<span class="spinner"></span> Running… ${fmtMs(Date.now() - started)} <span class="faint">· killed at ${conn.timeoutMs / 1000} s</span>`;
    };
    tick();
    const timer = setInterval(tick, 100);
    try {
      const r = await call(
        "/query",
        { conn: wire(conn), sql, schema: this.schema, limit, queryId, confirmed, planChecked },
        { timeoutMs: conn.timeoutMs + 30000 },
      );
      this.showResult(r, Date.now() - started);
      // Running a query connects: the tree and the database list catch up.
      if (!this.app.isConnected(conn.id)) this.app.schemasOf(conn.id);
      this.app.addHistory({ connId: conn.id, schema: this.schema, sql, at: Date.now(), ms: r.elapsedMs, rows: r.rows?.length, affected: r.affectedRows });
    } catch (e) {
      if (e.status === 409 && e.data?.needsPlanConfirm) {
        clearInterval(timer);
        this.running = null;
        this.setRunning(false);
        info.textContent = "";
        const ok = await confirmDialog(
          "This query looks expensive",
          `<p>Before running it, MySQL's plan says:</p><ul class="plan-warnings">${e.data.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` +
            planTable(e.data.plan) +
            `<p class="muted small">It may hold the server's resources until it's killed at ${conn.timeoutMs / 1000} s. An index on the filtered or joined columns, or a narrower WHERE, would avoid the scan.</p>`,
          "Run anyway",
          true,
          true,
        );
        if (ok) return this.run(confirmed, sql, true);
        info.textContent = "Not run.";
        return;
      }
      if (e.status === 409 && e.data?.needsConfirm) {
        clearInterval(timer);
        this.running = null;
        this.setRunning(false);
        info.textContent = "";
        const choice = await confirmWrite(
          conn,
          e.data.kind,
          `<p>This statement changes <b>${esc(conn.name)}</b>${this.schema ? ` (database <b>${esc(this.schema)}</b>)` : ""}:</p><pre class="value-view small">${esc(sql)}</pre>` +
            (/^(UPDATE|DELETE)$/.test(e.data.kind) && !tokenize(sql).some((t) => t.type === "kw" && t.text.toUpperCase() === "WHERE")
              ? `<p class="error-text"><b>No WHERE clause:</b> every row of the table will change.</p>`
              : ""),
        );
        if (choice === "dry") return this.dryRun(sql);
        if (choice === "run") return this.run(true, sql, planChecked);
        info.textContent = "Not run.";
        return;
      }
      this.showError(e, Date.now() - started);
      this.app.addHistory({ connId: conn.id, schema: this.schema, sql, at: Date.now(), error: e.message });
    } finally {
      clearInterval(timer);
      if (this.running?.queryId === queryId) {
        this.running = null;
        this.setRunning(false);
      }
    }
  }

  /** Runs the change in a transaction on the server, shows what it would do, and rolls it back. */
  async dryRun(sqlOverride = null) {
    if (this.running) return;
    const conn = this.conn;
    const sql = sqlOverride ?? this.target();
    if (!sql) return;
    const queryId = crypto.randomUUID();
    const started = Date.now();
    this.running = { queryId, started };
    this.setRunning(true);
    const info = this.el.querySelector(".res-info");
    info.innerHTML = '<span class="spinner"></span> Dry run: executing in a transaction…';
    try {
      const r = await call("/dryrun", { conn: wire(conn), sql, schema: this.schema, queryId }, { timeoutMs: conn.timeoutMs + 30000 });
      this.showDryRun(r, sql, Date.now() - started);
    } catch (e) {
      this.showError(e, Date.now() - started);
    } finally {
      this.running = null;
      this.setRunning(false);
    }
  }

  showDryRun(r, sql, totalMs) {
    this.result = r;
    this.dryRunSql = sql;
    const info = this.el.querySelector(".res-info");
    const msg = this.el.querySelector(".res-msg");
    const gridEl = this.el.querySelector(".res-grid");
    const n = (x, w) => `<b>${fmtNum(x)}</b> ${w}${x === 1 ? "" : "s"}`;
    const what =
      r.kind === "UPDATE"
        ? `${n(r.affected, "row")} would change${r.matched !== null && r.matched !== undefined ? ` (${fmtNum(r.matched)} matched${r.unchanged ? `, ${fmtNum(r.unchanged)} already as set` : ""})` : ""}`
        : r.kind === "DELETE"
          ? `${n(r.affected, "row")} would be deleted`
          : `${n(r.affected, "row")} would be ${r.kind === "REPLACE" ? "written" : "inserted"}`;
    info.className = "res-info";
    info.innerHTML =
      `<span class="badge dry">DRY RUN · rolled back</span> ${what} in <b>${esc(r.table || "several tables")}</b>` +
      (r.shown && r.shown < (r.matched ?? r.affected) ? ` · <span class="faint">first ${fmtNum(r.shown)} shown</span>` : "") +
      ` <span class="faint">· ${fmtMs(totalMs)}</span>`;
    this.el.querySelector(".res-actions").hidden = !r.rows.length;
    this.el.querySelector(".apply").hidden = r.affected === 0;
    const notes = r.notes.map((t) => `<li>${esc(t)}</li>`).join("");
    if (r.rows.length) {
      gridEl.hidden = false;
      msg.hidden = !notes;
      msg.className = "res-msg notes";
      msg.innerHTML = notes ? `<ul>${notes}</ul>` : "";
      this.grid.setData(r.columns, r.rows);
    } else {
      gridEl.hidden = true;
      msg.hidden = false;
      msg.className = "res-msg notes";
      msg.innerHTML = `<p>${r.affected === 0 ? "Nothing would change." : what.replace(/<[^>]+>/g, "") + "."}</p><ul>${notes}</ul>`;
    }
  }

  async stop() {
    if (!this.running) return;
    this.el.querySelector(".res-info").innerHTML = '<span class="spinner"></span> Killing the statement on the server…';
    try {
      await call("/cancel", { queryId: this.running.queryId });
    } catch (e) {
      octopus.toast(e.message, "error");
    }
  }

  setRunning(on) {
    this.el.querySelector(".run").hidden = on;
    this.el.querySelector(".explain").disabled = on;
    this.el.querySelector(".dryrun").disabled = on;
    if (on) this.el.querySelector(".apply").hidden = true;
    this.el.querySelector(".stop").hidden = !on;
    this.app.tabChanged(this);
  }

  showResult(r, totalMs) {
    this.result = r;
    this.dryRunSql = null;
    this.el.querySelector(".apply").hidden = true;
    const info = this.el.querySelector(".res-info");
    const msg = this.el.querySelector(".res-msg");
    const gridEl = this.el.querySelector(".res-grid");
    const bits = [];
    if (r.columns.length) {
      bits.push(`<b>${fmtNum(r.rows.length)}</b> row${r.rows.length === 1 ? "" : "s"}`);
      if (r.truncated) bits.push(`<span class="badge warn" title="The server had more rows: fetching stopped at ${r.limit} and the statement was killed">more rows not fetched (cap ${fmtNum(r.limit)})</span>`);
      if (r.limitApplied) bits.push(`<span class="badge" title="${esc(r.executedSql)}">LIMIT ${fmtNum(r.limit)} added</span>`);
    } else {
      bits.push(`<b>${fmtNum(r.affectedRows)}</b> row${r.affectedRows === 1 ? "" : "s"} affected`);
      if (r.insertId) bits.push(`insert id ${r.insertId}`);
    }
    bits.push(`<span class="faint">${fmtMs(r.elapsedMs)} on the server · ${fmtMs(totalMs)} total</span>`);
    info.className = "res-info";
    info.innerHTML = bits.join(" · ");
    this.el.querySelector(".res-actions").hidden = !r.columns.length;
    if (r.columns.length) {
      msg.hidden = true;
      gridEl.hidden = false;
      this.grid.setData(r.columns, r.rows);
    } else {
      gridEl.hidden = true;
      msg.hidden = false;
      msg.className = "res-msg";
      msg.textContent = `${r.kind} done: ${r.affectedRows} row(s) affected.`;
    }
  }

  showError(e, totalMs) {
    const info = this.el.querySelector(".res-info");
    const msg = this.el.querySelector(".res-msg");
    this.el.querySelector(".res-grid").hidden = true;
    this.el.querySelector(".res-actions").hidden = true;
    this.el.querySelector(".apply").hidden = true;
    info.className = "res-info";
    info.innerHTML = `<span class="badge error">${e.status === 408 ? (e.data?.stopped === "cancel" ? "Stopped" : "Timed out") : "Error"}</span> <span class="faint">after ${fmtMs(totalMs)}</span>`;
    msg.hidden = false;
    msg.className = "res-msg error";
    msg.textContent = e.message;
  }

  exportMenu(e) {
    const r = this.result;
    if (!r?.columns.length) return;
    const rows = () => this.grid.visibleRows();
    const copy = (text, what) => {
      octopus.copy(text);
      octopus.toast(`Copied ${fmtNum(r.rows.length)} rows as ${what}`, "info");
    };
    const download = (text, ext, type) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type }));
      a.download = `query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    contextMenu(e, [
      { label: "Copy as TSV (paste in a spreadsheet)", icon: icons.copy, action: () => copy(toTsv(r.columns, rows()), "TSV") },
      { label: "Copy as CSV", icon: icons.copy, action: () => copy(toCsv(r.columns, rows()), "CSV") },
      { label: "Copy as JSON", icon: icons.copy, action: () => copy(toJson(r.columns, rows()), "JSON") },
      { separator: true },
      { label: "Save CSV…", icon: icons.download, action: () => download(toCsv(r.columns, rows()), "csv", "text/csv") },
      { label: "Save JSON…", icon: icons.download, action: () => download(toJson(r.columns, rows()), "json", "application/json") },
      { separator: true },
      { label: "Copy the SQL that ran", icon: icons.query, action: () => (octopus.copy(r.executedSql), octopus.toast("Copied", "info")) },
    ]);
  }

  async showHistory() {
    const list = this.app.history.filter((h) => h.connId === this.connId).slice(0, 100);
    const body = list.length
      ? `<div class="hist">${list
          .map(
            (h, i) => `<div class="hist-item" data-i="${i}">
          <div class="hist-meta faint">${new Date(h.at).toLocaleString()} ${h.schema ? "· " + esc(h.schema) : ""} · ${h.error ? '<span class="err">error</span>' : h.rows !== undefined && h.rows !== null ? fmtNum(h.rows) + " rows" : fmtNum(h.affected) + " affected"}${h.ms !== undefined ? " · " + fmtMs(h.ms) : ""}</div>
          <pre class="mono">${esc(h.sql.length > 400 ? h.sql.slice(0, 400) + "…" : h.sql)}</pre></div>`,
          )
          .join("")}</div>`
      : '<p class="muted">No queries run on this connection yet.</p>';
    await modal({
      title: "History",
      body,
      wide: true,
      onOpen: (dlg, done) =>
        dlg.querySelectorAll(".hist-item").forEach((el) =>
          el.addEventListener("click", () => {
            const h = list[+el.dataset.i];
            const v = this.ta.value;
            this.setSql(v.trim() ? `${v.replace(/\s*$/, "")}\n\n${h.sql};` : `${h.sql};`);
            done(null);
          }),
        ),
      buttons: [{ label: "Close", value: null, submit: true }],
    });
  }

  serialize() {
    return { kind: "query", connId: this.connId, schema: this.schema, sql: this.ta.value, savedId: this.savedId };
  }
}
