// A table (or view) tab: its columns, indexes, foreign keys both ways, triggers, DDL and general info, and a first
// page of its rows.
import { call, wire } from "./api.js";
import { Grid } from "./grid.js";
import { icons } from "./icons.js";
import { envBanner, showValue } from "./query.js";
import { highlight, quoteIdent } from "./sql.js";
import { esc, fmtBytes, fmtMs, fmtNum } from "./ui.js";

const SECTIONS = ["Columns", "Indexes", "Foreign keys", "Referenced by", "Triggers", "DDL", "Info", "Data"];

export class TableTab {
  constructor(app, { conn, schema, table, section }) {
    this.app = app;
    this.kind = "table";
    this.connId = conn.id;
    this.schema = schema;
    this.table = table;
    this.section = section || "Columns";
    this.data = null;
    this.el = document.createElement("div");
    this.el.className = "table-tab";
    this.el.innerHTML = `
      <div class="toolbar t-head">
        <span class="t-title">${icons.table}<b>${esc(table)}</b><span class="faint">${esc(schema)}</span></span>
        <span class="t-summary faint"></span>
        <span class="grow"></span>
        <button class="ghost q" title="New query on this table">${icons.query}<span>Query</span></button>
        <button class="ghost icon refresh" title="Reload">${icons.refresh}</button>
      </div>
      <div class="subtabs">${SECTIONS.map((s) => `<button class="subtab" data-s="${s}">${s}<span class="count"></span></button>`).join("")}</div>
      <div class="t-body"><div class="t-content"></div><div class="t-data" hidden><div class="toolbar data-bar"></div><div class="t-grid"></div></div></div>`;
    this.content = this.el.querySelector(".t-content");
    envBanner(this.el, conn);
    this.dataEl = this.el.querySelector(".t-data");
    this.gridEl = this.el.querySelector(".t-grid");
    this.grid = new Grid(this.gridEl, { onCellOpen: (col, v) => showValue(col, v) });
    this.el.querySelector(".subtabs").addEventListener("click", (e) => {
      const b = e.target.closest(".subtab");
      if (b) this.show(b.dataset.s);
    });
    this.el.querySelector(".refresh").onclick = () => this.load();
    this.el.querySelector(".q").onclick = () =>
      this.app.openQuery(this.conn, this.schema, `SELECT *\nFROM ${quoteIdent(this.table)}\nLIMIT ${this.conn.rowLimit || 200};`);
    this.load();
  }

  get conn() {
    return this.app.connById(this.connId);
  }

  get title() {
    return this.table;
  }

  async load() {
    this.content.innerHTML = '<div class="pad muted"><span class="spinner"></span> Loading…</div>';
    try {
      this.data = await call("/table", { conn: wire(this.conn), schema: this.schema, table: this.table });
      const d = this.data;
      const i = d.info;
      const isView = i.type === "VIEW";
      this.el.querySelector(".t-title svg").outerHTML = isView ? icons.view : icons.table;
      this.el.querySelector(".t-summary").innerHTML = isView
        ? "view"
        : [i.engine, i.rows !== null ? `≈${fmtNum(i.rows)} rows` : "", i.dataBytes !== null ? `${fmtBytes(i.dataBytes)} data` : "", i.indexBytes ? `${fmtBytes(i.indexBytes)} indexes` : ""]
            .filter(Boolean)
            .join(" · ");
      const counts = { Columns: d.columns.length, Indexes: d.indexes.length, "Foreign keys": d.foreignKeys.length, "Referenced by": d.referencedBy.length, Triggers: d.triggers.length };
      this.el.querySelectorAll(".subtab").forEach((b) => {
        const n = counts[b.dataset.s];
        b.querySelector(".count").textContent = n ? ` ${n}` : "";
        b.classList.toggle("empty", n === 0);
      });
      this.show(this.section);
    } catch (e) {
      this.content.innerHTML = `<div class="pad error-text">${esc(e.message)}</div>`;
    }
  }

  show(section) {
    this.section = section;
    this.el.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("active", b.dataset.s === section));
    this.app.tabChanged(this);
    const isData = section === "Data";
    this.dataEl.hidden = !isData;
    this.content.hidden = isData;
    if (isData) return this.loadData();
    if (!this.data) return;
    const d = this.data;
    const table = (head, rows) =>
      `<table class="props"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
    const none = (what) => `<div class="pad muted">No ${what}.</div>`;
    const fkByCol = new Map();
    d.foreignKeys.forEach((fk) => fk.columns.forEach((c, i) => fkByCol.set(c, `${fk.refTable}.${fk.refColumns[i]}`)));
    let html = "";
    if (section === "Columns") {
      html = table(
        ["#", "Name", "Type", "Null", "Default", "Key", "Extra", "Comment"],
        d.columns.map(
          (c) => `<tr>
            <td class="faint">${c.position}</td>
            <td class="mono strong">${c.key === "PRI" ? `<span class="pk" title="Primary key">${icons.key}</span>` : ""}${fkByCol.has(c.name) ? `<span class="fk" title="→ ${esc(fkByCol.get(c.name))}">${icons.link}</span>` : ""}${esc(c.name)}</td>
            <td class="mono type">${esc(c.type)}${c.collation && c.collation !== d.info.collation ? ` <span class="faint">${esc(c.collation)}</span>` : ""}</td>
            <td>${c.nullable ? "yes" : '<span class="faint">no</span>'}</td>
            <td class="mono">${c.default === null ? (c.nullable ? '<span class="null">NULL</span>' : "") : esc(c.default)}</td>
            <td>${c.key ? `<span class="badge">${esc(c.key)}</span>` : ""}</td>
            <td class="mono faint">${esc(c.extra)}${c.generation ? ` AS (${esc(c.generation)})` : ""}</td>
            <td class="muted">${esc(c.comment)}</td></tr>`,
        ),
      );
    } else if (section === "Indexes") {
      html = d.indexes.length
        ? table(
            ["Name", "Columns", "Unique", "Type", "Cardinality", "Comment"],
            d.indexes.map(
              (ix) => `<tr><td class="mono strong">${esc(ix.name)}</td><td class="mono">${ix.columns.map(esc).join(", ")}</td>
                <td>${ix.unique ? '<span class="badge success">unique</span>' : ""}</td><td class="faint">${esc(ix.type)}</td>
                <td class="num">${fmtNum(ix.cardinality)}</td><td class="muted">${esc(ix.comment)}</td></tr>`,
            ),
          )
        : none("indexes");
    } else if (section === "Foreign keys") {
      html = d.foreignKeys.length
        ? table(
            ["Name", "Columns", "References", "On update", "On delete"],
            d.foreignKeys.map(
              (fk) => `<tr><td class="mono strong">${esc(fk.name)}</td><td class="mono">${fk.columns.map(esc).join(", ")}</td>
                <td class="mono"><a href="#" class="open-table" data-s="${esc(fk.refSchema)}" data-t="${esc(fk.refTable)}">${fk.refSchema !== this.schema ? esc(fk.refSchema) + "." : ""}${esc(fk.refTable)}</a> (${fk.refColumns.map(esc).join(", ")})</td>
                <td>${esc(fk.onUpdate)}</td><td>${esc(fk.onDelete)}</td></tr>`,
            ),
          )
        : none("foreign keys");
    } else if (section === "Referenced by") {
      html = d.referencedBy.length
        ? table(
            ["Table", "Columns", "→ Columns here", "Constraint"],
            d.referencedBy.map(
              (r) => `<tr><td class="mono"><a href="#" class="open-table" data-s="${esc(r.schema)}" data-t="${esc(r.table)}">${r.schema !== this.schema ? esc(r.schema) + "." : ""}${esc(r.table)}</a></td>
                <td class="mono">${esc(r.columns)}</td><td class="mono">${esc(r.refColumns)}</td><td class="mono faint">${esc(r.name)}</td></tr>`,
            ),
          )
        : none("tables referencing this one");
    } else if (section === "Triggers") {
      html = d.triggers.length
        ? d.triggers.map((t) => `<div class="pad"><b class="mono">${esc(t.name)}</b> <span class="badge">${esc(t.timing)} ${esc(t.event)}</span><pre class="code">${highlight(t.statement || "")}</pre></div>`).join("")
        : none("triggers");
    } else if (section === "DDL") {
      html = `<div class="pad"><div class="toolbar"><button class="ghost copy-ddl">${icons.copy}<span>Copy</span></button></div><pre class="code">${highlight(d.ddl || "")}</pre></div>`;
    } else if (section === "Info") {
      const i = d.info;
      const rows = [
        ["Type", i.type],
        ["Engine", i.engine],
        ["Rows (estimate)", fmtNum(i.rows)],
        ["Average row", fmtBytes(i.avgRowBytes)],
        ["Data", fmtBytes(i.dataBytes)],
        ["Indexes", fmtBytes(i.indexBytes)],
        ["Free", fmtBytes(i.freeBytes)],
        ["Next AUTO_INCREMENT", fmtNum(i.autoIncrement)],
        ["Row format", i.rowFormat],
        ["Collation", i.collation],
        ["Created", i.created],
        ["Updated", i.updated],
        ["Options", i.options],
        ["Comment", i.comment],
      ].filter(([, v]) => v !== null && v !== undefined && v !== "");
      html = `<table class="props kv"><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`;
    }
    this.content.innerHTML = html;
    this.content.querySelector(".copy-ddl")?.addEventListener("click", () => (octopus.copy(d.ddl), octopus.toast("Copied", "info")));
    this.content.querySelectorAll(".open-table").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.app.openTable(this.conn, a.dataset.s, a.dataset.t);
      }),
    );
  }

  async loadData(force = false) {
    if (this.dataLoaded && !force) return;
    const bar = this.dataEl.querySelector(".data-bar");
    bar.innerHTML = '<span class="muted"><span class="spinner"></span> Reading rows…</span>';
    const limit = this.conn.rowLimit || 200;
    try {
      const started = Date.now();
      const r = await call(
        "/query",
        // A bare SELECT … LIMIT stops after `limit` rows: no need to check its plan.
        { conn: wire(this.conn), schema: this.schema, sql: `SELECT * FROM ${quoteIdent(this.table)}`, limit, queryId: crypto.randomUUID(), planChecked: true },
        { timeoutMs: this.conn.timeoutMs + 30000 },
      );
      this.dataLoaded = true;
      bar.innerHTML = `<span class="muted">First ${fmtNum(r.rows.length)} rows${r.truncated ? " (more not fetched)" : ""} · ${fmtMs(Date.now() - started)}</span><span class="grow"></span>
        <button class="ghost icon reload-data" title="Reload rows">${icons.refresh}</button>
        <button class="ghost open-q">${icons.query}<span>Open as query</span></button>`;
      bar.querySelector(".open-q").onclick = () =>
        this.app.openQuery(this.conn, this.schema, `SELECT *\nFROM ${quoteIdent(this.table)}\nLIMIT ${limit};`, true);
      bar.querySelector(".reload-data").onclick = () => this.loadData(true);
      this.grid.setData(r.columns, r.rows);
    } catch (e) {
      bar.innerHTML = `<span class="error-text">${esc(e.message)}</span>`;
    }
  }

  serialize() {
    return { kind: "table", connId: this.connId, schema: this.schema, table: this.table, section: this.section };
  }
}
