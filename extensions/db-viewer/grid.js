// A result grid: virtual rows (only what's on screen is in the DOM), sticky header, sortable and resizable columns,
// a selection (click a cell, drag or Shift+click/arrows for a range, click the row number for whole rows, Cmd+A for all)
// that Cmd+C copies (Shift+Cmd+C with the column names; right-click for more formats), double-click shows the value.
import { contextMenu } from "./ui.js";

const ROW_H = 22;
const NUMERIC = /^(TINY|SHORT|LONG|LONGLONG|INT24|FLOAT|DOUBLE|DECIMAL|NEWDECIMAL|YEAR)$/;

const OPS = { "~": "upd", "=": "same", "−": "del", "+": "ins", "?": "same" };
const OP_TITLES = { "~": "Changed", "=": "Matched, unchanged", "−": "Deleted", "+": "Inserted", "?": "Not found after" };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A cell's value as plain text (for copy, export, the value viewer). */
export function cellText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if ("$op" in v) return v.$op;
    if ("$diff" in v) return `${cellText(v.$diff[0]) ?? "NULL"} → ${cellText(v.$diff[1]) ?? "NULL"}`;
    if ("$binary" in v) return v.$binary + (v.cut ? "…" : "");
    if ("$text" in v) return v.$text + (v.cut ? "…" : "");
    return JSON.stringify(v);
  }
  return String(v);
}

function cellHtml(v) {
  if (v === null || v === undefined) return '<span class="null">NULL</span>';
  if (typeof v === "object") {
    // Dry-run previews: the row's change, and a cell's value before → after.
    if ("$op" in v) return `<span class="op ${OPS[v.$op] || ""}" title="${OP_TITLES[v.$op] || ""}">${esc(v.$op)}</span>`;
    if ("$diff" in v) return `<span class="d-old">${cellHtml(v.$diff[0])}</span> → <span class="d-new">${cellHtml(v.$diff[1])}</span>`;
    if ("$binary" in v) return `<span class="bin">${esc(v.$binary.slice(0, 66))}${v.$binary.length > 66 || v.cut ? "…" : ""}</span>`;
    if ("$text" in v) return esc(v.$text.slice(0, 500)) + "…";
  }
  const s = String(v);
  return esc(s.length > 500 ? s.slice(0, 500) + "…" : s);
}

export function toCsv(columns, rows) {
  const q = (s) => (s === null ? "" : /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map((c) => q(c.name)).join(","), ...rows.map((r) => r.map((v) => q(cellText(v))).join(","))].join("\n");
}

export function toTsv(columns, rows) {
  const q = (s) => (s === null ? "NULL" : s.replace(/[\t\n\r]/g, " "));
  return [columns.map((c) => c.name).join("\t"), ...rows.map((r) => r.map((v) => q(cellText(v))).join("\t"))].join("\n");
}

export function toJson(columns, rows) {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] && typeof r[i] === "object" ? cellText(r[i]) : r[i]]))),
    null,
    2,
  );
}

// Tab-separated for spreadsheets: a value with tabs, newlines or quotes is quoted (Sheets, Excel and Numbers read it).
const tsvCell = (t) => (t === null ? "NULL" : /[\t\n\r"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

/** INSERT statements for rows (table name from the query when known, else a placeholder). */
export function toInsert(columns, rows, table) {
  const id = (n) => "`" + String(n).replace(/`/g, "``") + "`";
  const lit = (v) => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "object" && "$binary" in v) return v.$binary.startsWith("0x") && !v.cut ? v.$binary : "NULL /* binary not copied */";
    const t = cellText(v);
    return "'" + t.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/\0/g, "\\0") + "'";
  };
  const head = `INSERT INTO ${table ? id(table) : "`table`"} (${columns.map((c) => id(c.name)).join(", ")}) VALUES`;
  return rows.map((r) => `${head} (${r.map(lit).join(", ")});`).join("\n");
}

export class Grid {
  constructor(host, { onCellOpen } = {}) {
    this.host = host;
    this.onCellOpen = onCellOpen;
    host.classList.add("grid");
    host.tabIndex = 0;
    host.innerHTML = `<div class="grid-scroll"><table><colgroup></colgroup><thead><tr></tr></thead><tbody></tbody></table></div>`;
    this.scroll = host.querySelector(".grid-scroll");
    this.table = host.querySelector("table");
    this.colgroup = host.querySelector("colgroup");
    this.headRow = host.querySelector("thead tr");
    this.body = host.querySelector("tbody");
    this.columns = [];
    this.rows = [];
    this.view = [];
    this.sel = null; // the cursor {r, c}, in view coordinates
    this.anchor = null; // where the range starts; the range is anchor..sel (whole rows when this.rowMode)
    this.rowMode = false;
    this.sort = null;
    this.scroll.addEventListener("scroll", () => this.paint());
    new ResizeObserver(() => this.paint()).observe(this.scroll);
    this.body.addEventListener("mousedown", (e) => {
      const td = e.target.closest("td");
      const tr = td?.parentNode;
      if (!tr?.dataset.r) return;
      const r = +tr.dataset.r;
      if (e.button === 0 && e.target.closest(".cell-open")) {
        e.preventDefault();
        e.stopPropagation();
        return this.openCell(r, +td.dataset.c);
      }
      const isRn = td.classList.contains("rn");
      if (e.button === 2) {
        // Right-click inside the selection keeps it; elsewhere it selects that cell (or row) first.
        if (!(isRn ? this.rowMode && this.inRows(r) : this.inRange(r, +td.dataset.c))) this.select(r, isRn ? 0 : +td.dataset.c, { rows: isRn });
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      this.select(r, isRn ? this.sel?.c ?? 0 : +td.dataset.c, { extend: e.shiftKey, rows: isRn });
      // Drag extends the range.
      const move = (ev) => {
        const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("td");
        const row = t?.parentNode;
        if (!row?.dataset?.r || !this.body.contains(row)) return;
        const rr = +row.dataset.r;
        const cc = this.rowMode || t.classList.contains("rn") ? this.sel.c : +t.dataset.c;
        if (rr !== this.sel.r || cc !== this.sel.c) this.select(rr, cc, { extend: true, rows: this.rowMode });
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    this.body.addEventListener("contextmenu", (e) => {
      const td = e.target.closest("td");
      if (!td?.parentNode?.dataset.r) return;
      this.showMenu(e, td.classList.contains("rn") ? null : +td.dataset.c);
    });
    this.body.addEventListener("dblclick", (e) => {
      const td = e.target.closest("td[data-c]");
      if (td) this.openCell(+td.parentNode.dataset.r, +td.dataset.c);
    });
    host.addEventListener("keydown", (e) => this.key(e));
    this.headRow.addEventListener("click", (e) => {
      if (e.target.closest(".resizer")) return;
      if (e.target.closest("th.rn")) return this.selectAll();
      const th = e.target.closest("th[data-c]");
      if (th) this.toggleSort(+th.dataset.c);
    });
    this.headRow.addEventListener("mousedown", (e) => this.startResize(e));
  }

  setData(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.sort = null;
    this.sel = null;
    this.anchor = null;
    this.rowMode = false;
    this.widths = columns.map((c, i) => {
      let w = c.name.length;
      for (let r = 0; r < Math.min(rows.length, 200); r++) {
        const t = cellText(rows[r][i]);
        w = Math.max(w, t === null ? 4 : Math.min(t.length, 60));
      }
      return Math.max(60, Math.min(420, w * 7.4 + 22));
    });
    this.numeric = columns.map((c) => NUMERIC.test(c.type || ""));
    this.buildHead();
    this.applySort();
    this.scroll.scrollTop = 0;
    this.scroll.scrollLeft = 0;
    this.paint(true);
  }

  buildHead() {
    this.colgroup.innerHTML = `<col style="width:48px">` + this.widths.map((w) => `<col style="width:${w}px">`).join("");
    this.table.style.width = 48 + this.widths.reduce((a, b) => a + b, 0) + "px";
    const arrow = (i) => (this.sort?.c === i ? (this.sort.dir > 0 ? " ▲" : " ▼") : "");
    this.headRow.innerHTML =
      `<th class="rn" title="Select all (⌘A)">#</th>` +
      this.columns
        .map(
          (c, i) =>
            `<th data-c="${i}" title="${esc(c.name)} · ${esc(c.type || "")}${c.nullable ? " · nullable" : ""}" class="${this.numeric[i] ? "num" : ""}">` +
            `<span class="th-name">${esc(c.name)}</span><span class="th-sort">${arrow(i)}</span><span class="resizer"></span></th>`,
        )
        .join("");
  }

  applySort() {
    this.view = this.rows.map((_, i) => i);
    if (!this.sort) return;
    const { c, dir } = this.sort;
    const num = this.numeric[c];
    const key = (v) => {
      const t = cellText(v);
      return t === null ? null : num ? Number(t) : t.toLowerCase();
    };
    this.view.sort((a, b) => {
      const x = key(this.rows[a][c]);
      const y = key(this.rows[b][c]);
      if (x === y) return a - b;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  }

  toggleSort(c) {
    this.sort = this.sort?.c === c ? (this.sort.dir > 0 ? { c, dir: -1 } : null) : { c, dir: 1 };
    this.applySort();
    this.buildHead();
    this.paint(true);
  }

  startResize(e) {
    const handle = e.target.closest(".resizer");
    if (!handle) return;
    e.preventDefault();
    const c = +handle.parentNode.dataset.c;
    const x0 = e.clientX;
    const w0 = this.widths[c];
    const move = (ev) => {
      this.widths[c] = Math.max(40, w0 + ev.clientX - x0);
      this.colgroup.children[c + 1].style.width = this.widths[c] + "px";
      this.table.style.width = 48 + this.widths.reduce((a, b) => a + b, 0) + "px";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  paint(force = false) {
    const h = this.scroll.clientHeight || 400;
    const first = Math.max(0, Math.floor(this.scroll.scrollTop / ROW_H) - 10);
    const last = Math.min(this.view.length, first + Math.ceil(h / ROW_H) + 20);
    if (!force && first === this.first && last === this.last) return;
    this.first = first;
    this.last = last;
    const cols = this.columns.length;
    let html = `<tr class="spacer" style="height:${first * ROW_H}px"><td colspan="${cols + 1}"></td></tr>`;
    for (let r = first; r < last; r++) {
      const row = this.rows[this.view[r]];
      const rowSel = this.rowMode && this.inRows(r);
      html += `<tr data-r="${r}"${rowSel ? ' class="row-sel"' : ""}><td class="rn">${this.view[r] + 1}</td>`;
      for (let c = 0; c < cols; c++) {
        const cls = (this.numeric[c] ? "num" : "") + (this.sel && this.sel.r === r && this.sel.c === c ? " sel" : "") + (this.inRange(r, c) ? " in-sel" : "");
        html += `<td data-c="${c}" class="${cls}">${cellHtml(row[c])}</td>`;
      }
      html += "</tr>";
    }
    html += `<tr class="spacer" style="height:${(this.view.length - last) * ROW_H}px"><td colspan="${cols + 1}"></td></tr>`;
    this.body.innerHTML = html;
    this.markCut();
  }

  /** On the selected cell, when its value doesn't fit (or spans lines), a button that opens it whole. */
  markCut() {
    const td = this.body.querySelector("td.sel");
    if (!td || this.rowMode) return;
    const v = this.rows[this.view[this.sel.r]]?.[this.sel.c];
    const t = cellText(v);
    const cut = (v && typeof v === "object" && (v.cut || "$text" in v)) || (t && t.includes("\n")) || td.scrollWidth > td.clientWidth;
    if (!cut) return;
    td.classList.add("has-open");
    td.insertAdjacentHTML("beforeend", `<button class="cell-open" title="Show the whole value (Enter, double-click)">⤢</button>`);
  }

  /** Moves the cursor; `extend` grows the range from the anchor, `rows` selects whole rows. */
  select(r, c, { extend = false, rows = false } = {}) {
    if (!this.view.length || !this.columns.length) return;
    this.sel = { r: Math.max(0, Math.min(this.view.length - 1, r)), c: Math.max(0, Math.min(this.columns.length - 1, c)) };
    if (!extend || !this.anchor) {
      this.anchor = { ...this.sel };
      this.rowMode = rows;
    }
    // Keep it in view.
    const top = this.sel.r * ROW_H;
    const headH = this.headRow.offsetHeight;
    if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
    else if (top + ROW_H > this.scroll.scrollTop + this.scroll.clientHeight - headH) this.scroll.scrollTop = top + ROW_H - this.scroll.clientHeight + headH;
    this.paint(true);
    this.host.focus({ preventScroll: true });
  }

  selectAll() {
    if (!this.view.length) return;
    this.anchor = { r: 0, c: 0 };
    this.sel = { r: this.view.length - 1, c: this.sel?.c ?? 0 };
    this.rowMode = true;
    this.paint(true);
    this.host.focus({ preventScroll: true });
  }

  /** The selected rectangle, in view coordinates: {r0, r1, c0, c1} (inclusive). */
  range() {
    if (!this.sel) return null;
    const a = this.anchor || this.sel;
    return {
      r0: Math.min(a.r, this.sel.r),
      r1: Math.max(a.r, this.sel.r),
      c0: this.rowMode ? 0 : Math.min(a.c, this.sel.c),
      c1: this.rowMode ? this.columns.length - 1 : Math.max(a.c, this.sel.c),
    };
  }

  inRows(r) {
    const g = this.range();
    return !!g && r >= g.r0 && r <= g.r1;
  }

  inRange(r, c) {
    const g = this.range();
    if (!g || (g.r0 === g.r1 && g.c0 === g.c1 && !this.rowMode)) return false; // a single cell: just the cursor
    return r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  }

  /** What's selected: {columns, rows} with rows as arrays of raw values, in display order. */
  selection({ wholeRows = false } = {}) {
    const g = this.range();
    if (!g) return null;
    const c0 = wholeRows ? 0 : g.c0;
    const c1 = wholeRows ? this.columns.length - 1 : g.c1;
    const rows = [];
    for (let r = g.r0; r <= g.r1; r++) rows.push(this.rows[this.view[r]].slice(c0, c1 + 1));
    return { columns: this.columns.slice(c0, c1 + 1), rows };
  }

  copy(format = "tsv", opts = {}) {
    const s = this.selection(opts);
    if (!s) return;
    let text;
    const single = s.rows.length === 1 && s.columns.length === 1;
    if (format === "json") text = toJson(s.columns, s.rows);
    else if (format === "csv") text = toCsv(s.columns, s.rows);
    else if (format === "insert") text = toInsert(s.columns, s.rows, this.tableName);
    else if (single && !opts.headers) {
      const t = cellText(s.rows[0][0]);
      text = t === null ? "NULL" : t; // one cell: its value as it is
    } else {
      const lines = s.rows.map((r) => r.map((v) => tsvCell(cellText(v))).join("\t"));
      if (opts.headers) lines.unshift(s.columns.map((c) => c.name).join("\t"));
      text = lines.join("\n");
    }
    octopus.copy(text);
    const n = s.rows.length;
    octopus.toast(single && format === "tsv" && !opts.headers ? "Copied" : `Copied ${n} row${n === 1 ? "" : "s"}${opts.wholeRows || this.rowMode ? "" : ` × ${s.columns.length} column${s.columns.length === 1 ? "" : "s"}`}`, "info");
  }

  showMenu(e, c) {
    const g = this.range();
    if (!g) return;
    const nRows = g.r1 - g.r0 + 1;
    const nCols = g.c1 - g.c0 + 1;
    const single = nRows === 1 && nCols === 1 && !this.rowMode;
    const rowsLabel = nRows === 1 ? "row" : `${nRows} rows`;
    const items = [
      { label: single ? "Copy value" : "Copy", action: () => this.copy("tsv") },
      { label: "Copy with column names", action: () => this.copy("tsv", { headers: true }) },
      { separator: true },
      { label: `Copy ${rowsLabel}`, action: () => this.copy("tsv", { wholeRows: true }) },
      { label: `Copy ${rowsLabel} with column names`, action: () => this.copy("tsv", { wholeRows: true, headers: true }) },
      { label: `Copy ${rowsLabel} as CSV`, action: () => this.copy("csv", { wholeRows: true }) },
      { label: `Copy ${rowsLabel} as JSON`, action: () => this.copy("json", { wholeRows: true }) },
      { label: `Copy ${rowsLabel} as INSERT`, action: () => this.copy("insert", { wholeRows: true }) },
    ];
    if (c !== null && c !== undefined) {
      items.push({ separator: true }, { label: "Copy column name", action: () => (octopus.copy(this.columns[c].name), octopus.toast("Copied", "info")) });
    }
    if (single) items.push({ label: "Show value", action: () => this.openCell(g.r0, g.c0) });
    contextMenu(e, items);
  }

  selectedValue() {
    if (!this.sel) return undefined;
    return this.rows[this.view[this.sel.r]][this.sel.c];
  }

  openCell(r, c) {
    const v = this.rows[this.view[r]][c];
    this.onCellOpen?.(this.columns[c], v, this.rows[this.view[r]]);
  }

  key(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "a") {
      e.preventDefault();
      return this.selectAll();
    }
    if (!this.sel) return;
    const { r, c } = this.sel;
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [20, 0], PageUp: [-20, 0] };
    if (moves[e.key]) {
      e.preventDefault();
      this.select(r + moves[e.key][0], c + moves[e.key][1], { extend: e.shiftKey, rows: e.shiftKey && this.rowMode });
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.openCell(r, c);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this.copy("tsv", { headers: e.shiftKey });
    } else if (e.key === "Escape" && (this.rowMode || this.anchor.r !== r || this.anchor.c !== c)) {
      e.preventDefault();
      e.stopPropagation();
      this.select(r, c); // back to the cursor's cell
    }
  }

  /** Rows in display order (sorted as shown). */
  visibleRows() {
    return this.view.map((i) => this.rows[i]);
  }
}
