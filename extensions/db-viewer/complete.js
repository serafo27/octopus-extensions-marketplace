// Autocomplete in the query editor: tables and views of the tab's database, columns of the tables the statement
// names (and `alias.` → that table's columns), and keywords. ↑↓ choose, Tab/Enter accept, Esc closes; ⌃Space opens it.
import { quoteIdent, statementAt } from "./sql.js";
import { esc } from "./ui.js";

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS NULL", "IS NOT NULL", "LIKE", "BETWEEN", "EXISTS", "JOIN",
  "LEFT JOIN", "INNER JOIN", "ON", "USING", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "DISTINCT", "AS", "ASC",
  "DESC", "UNION ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "INTERVAL",
  "COUNT(", "SUM(", "AVG(", "MIN(", "MAX(", "COALESCE(", "IFNULL(", "CONCAT(", "DATE(", "NOW()", "CURDATE()",
  "DATE_SUB(", "DATE_ADD(", "JSON_EXTRACT(", "JSON_UNQUOTE(", "GROUP_CONCAT(", "CAST(", "LOWER(", "UPPER(",
];

const WORD = /[\w$]/;
const needsQuote = (n) => !/^[A-Za-z_][\w$]*$/.test(n);
const ident = (n) => (needsQuote(n) ? quoteIdent(n) : n);

/** Tables (and their aliases) a statement names: { aliasOrName(lowercase): tableName }. */
function tablesIn(sql) {
  const out = {};
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:`[^`]+`|[\w$]+)(?:\.(?:`[^`]+`|[\w$]+))?)(?:\s+(?:AS\s+)?(?!(?:WHERE|ON|USING|JOIN|LEFT|RIGHT|INNER|CROSS|NATURAL|STRAIGHT_JOIN|GROUP|ORDER|LIMIT|SET|HAVING|UNION|WINDOW|FOR|LOCK)\b)([\w$]+))?/gi;
  for (const m of sql.matchAll(re)) {
    const parts = m[1].split(".").map((p) => p.replace(/^`|`$/g, ""));
    const table = parts.pop();
    const schema = parts.pop() || null;
    out[table.toLowerCase()] = { table, schema };
    if (m[2]) out[m[2].toLowerCase()] = { table, schema };
  }
  return out;
}

export class Completer {
  constructor(tab) {
    this.tab = tab;
    this.ta = tab.ta;
    this.box = document.createElement("div");
    this.box.className = "complete";
    this.box.hidden = true;
    tab.el.querySelector(".editor").appendChild(this.box);
    this.items = [];
    this.index = 0;
    this.seq = 0;
    this.ta.addEventListener("input", (e) => {
      if (e.inputType?.startsWith("insert") && e.data && (WORD.test(e.data) || e.data === ".")) this.update(false);
      else this.close();
    });
    this.ta.addEventListener("keydown", (e) => this.key(e), true);
    this.ta.addEventListener("blur", () => setTimeout(() => this.close(), 150));
    this.ta.addEventListener("click", () => this.close());
    this.box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const el = e.target.closest(".c-item");
      if (el) this.accept(+el.dataset.i);
    });
  }

  get open() {
    return !this.box.hidden;
  }

  key(e) {
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      return this.update(true);
    }
    if (!this.open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.index = (this.index + (e.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
      this.paint();
    } else if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.accept(this.index);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    }
  }

  close() {
    this.box.hidden = true;
    this.items = [];
  }

  /** The word being typed before the cursor and what's before it ("alias." for a column of a table). */
  context() {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    let a = pos;
    while (a > 0 && WORD.test(v[a - 1])) a--;
    let qualifier = null;
    if (v[a - 1] === ".") {
      let q = a - 1;
      if (v[q - 1] === "`") {
        const open = v.lastIndexOf("`", q - 2);
        qualifier = v.slice(open + 1, q - 1);
      } else {
        let b = q;
        while (b > 0 && WORD.test(v[b - 1])) b--;
        qualifier = v.slice(b, q);
      }
    }
    return { prefix: v.slice(a, pos), start: a, end: pos, qualifier };
  }

  async update(forced) {
    const seq = ++this.seq;
    const ctx = this.context();
    if (!forced && !ctx.prefix && !ctx.qualifier) return this.close();
    const app = this.tab.app;
    const conn = this.tab.conn;
    const schema = this.tab.schema;
    const stmt = statementAt(this.ta.value, ctx.start)?.text || "";
    const named = tablesIn(stmt);
    const p = ctx.prefix.toLowerCase();
    const match = (name) => name.toLowerCase().startsWith(p);
    let items = [];
    const columnsOf = async (t) => (await app.columnsOf(conn.id, t.schema || schema, t.table)) || [];

    if (ctx.qualifier) {
      const t = named[ctx.qualifier.toLowerCase()] || { table: ctx.qualifier, schema: null };
      if (schema || t.schema) items = (await columnsOf(t)).filter((c) => match(c.name)).map((c) => ({ label: c.name, insert: ident(c.name), kind: "col", detail: c.type }));
      // `schema.` → its tables.
      if (!items.length) {
        const objs = await app.objectsOf(conn.id, ctx.qualifier);
        if (objs?.tables) items = [...objs.tables, ...objs.views].filter((x) => match(x.name)).map((x) => ({ label: x.name, insert: ident(x.name), kind: "table" }));
      }
    } else {
      const cols = [];
      for (const t of new Map(Object.values(named).map((t) => [t.table + "\0" + t.schema, t])).values()) {
        for (const c of await columnsOf(t)) if (match(c.name)) cols.push({ label: c.name, insert: ident(c.name), kind: "col", detail: `${t.table} · ${c.type}` });
      }
      const objs = schema ? await app.objectsOf(conn.id, schema) : null;
      const tables = objs?.tables ? [...objs.tables, ...objs.views].filter((x) => match(x.name)).map((x) => ({ label: x.name, insert: ident(x.name), kind: x.type === "VIEW" ? "view" : "table" })) : [];
      const kws = p.length ? KEYWORDS.filter((k) => k.toLowerCase().startsWith(p) && k.toLowerCase() !== p).map((k) => ({ label: k, insert: k, kind: "kw" })) : [];
      // After FROM/JOIN, tables first; elsewhere, columns first.
      const before = this.ta.value.slice(0, ctx.start).trimEnd();
      items = /\b(FROM|JOIN|UPDATE|INTO|TABLE|DESCRIBE|DESC)$/i.test(before) ? [...tables, ...cols, ...kws] : [...cols, ...tables, ...kws];
    }
    if (seq !== this.seq) return;
    // Exact matches add nothing.
    items = items.filter((it) => it.label.toLowerCase() !== p || ctx.qualifier).slice(0, 50);
    if (!items.length) return this.close();
    this.items = items;
    this.ctx = ctx;
    this.index = 0;
    this.paint();
    this.place();
  }

  paint() {
    this.box.hidden = false;
    this.box.innerHTML = this.items
      .map(
        (it, i) =>
          `<div class="c-item ${i === this.index ? "sel" : ""}" data-i="${i}"><span class="c-kind ${it.kind}">${{ col: "col", table: "tbl", view: "view", kw: "kw" }[it.kind]}</span><span class="c-label">${esc(it.label)}</span><span class="c-detail">${esc(it.detail || "")}</span></div>`,
      )
      .join("");
    this.box.children[this.index]?.scrollIntoView({ block: "nearest" });
  }

  /** Under the cursor: the editor's font is monospace, so the caret's place comes from its line and column. */
  place() {
    const v = this.ta.value.slice(0, this.ctx.start);
    const line = v.split("\n").length - 1;
    const col = v.length - v.lastIndexOf("\n") - 1;
    const cs = getComputedStyle(this.ta);
    if (!this.cw) {
      const c = document.createElement("canvas").getContext("2d");
      c.font = `${cs.fontSize} ${cs.fontFamily}`;
      this.cw = c.measureText("0000000000").width / 10;
    }
    const lh = parseFloat(cs.lineHeight) || 19.5;
    const x = parseFloat(cs.paddingLeft) + col * this.cw - this.ta.scrollLeft;
    const y = parseFloat(cs.paddingTop) + (line + 1) * lh - this.ta.scrollTop + 2;
    const maxX = this.ta.clientWidth - 320;
    this.box.style.left = Math.max(4, Math.min(x - 30, maxX)) + "px";
    this.box.style.top = y + "px";
  }

  accept(i) {
    const it = this.items[i];
    if (!it) return;
    this.ta.focus();
    this.ta.setSelectionRange(this.ctx.start, this.ta.selectionStart);
    document.execCommand("insertText", false, it.insert);
    this.close();
  }
}
