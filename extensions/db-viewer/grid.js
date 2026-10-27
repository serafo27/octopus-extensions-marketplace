// A result grid: virtual rows (only what's on screen is in the DOM), sticky header, sortable and resizable columns,
// a selected cell (arrows move it, Cmd+C copies it), double-click shows the whole value.

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
    this.sel = null; // {r, c} in view coordinates
    this.sort = null;
    this.scroll.addEventListener("scroll", () => this.paint());
    new ResizeObserver(() => this.paint()).observe(this.scroll);
    this.body.addEventListener("mousedown", (e) => {
      const td = e.target.closest("td[data-c]");
      if (!td) return;
      this.select(+td.parentNode.dataset.r, +td.dataset.c);
    });
    this.body.addEventListener("dblclick", (e) => {
      const td = e.target.closest("td[data-c]");
      if (td) this.openCell(+td.parentNode.dataset.r, +td.dataset.c);
    });
    host.addEventListener("keydown", (e) => this.key(e));
    this.headRow.addEventListener("click", (e) => {
      if (e.target.closest(".resizer")) return;
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
      `<th class="rn">#</th>` +
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
      html += `<tr data-r="${r}"><td class="rn">${this.view[r] + 1}</td>`;
      for (let c = 0; c < cols; c++) {
        const selected = this.sel && this.sel.r === r && this.sel.c === c ? " sel" : "";
        html += `<td data-c="${c}" class="${this.numeric[c] ? "num" : ""}${selected}">${cellHtml(row[c])}</td>`;
      }
      html += "</tr>";
    }
    html += `<tr class="spacer" style="height:${(this.view.length - last) * ROW_H}px"><td colspan="${cols + 1}"></td></tr>`;
    this.body.innerHTML = html;
  }

  select(r, c) {
    this.sel = { r: Math.max(0, Math.min(this.view.length - 1, r)), c: Math.max(0, Math.min(this.columns.length - 1, c)) };
    // Keep it in view.
    const top = this.sel.r * ROW_H;
    const headH = this.headRow.offsetHeight;
    if (top < this.scroll.scrollTop) this.scroll.scrollTop = top;
    else if (top + ROW_H > this.scroll.scrollTop + this.scroll.clientHeight - headH) this.scroll.scrollTop = top + ROW_H - this.scroll.clientHeight + headH;
    this.paint(true);
    this.host.focus({ preventScroll: true });
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
    if (!this.sel) return;
    const { r, c } = this.sel;
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [20, 0], PageUp: [-20, 0] };
    if (moves[e.key]) {
      e.preventDefault();
      this.select(r + moves[e.key][0], c + moves[e.key][1]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.openCell(r, c);
    } else if ((e.metaKey || e.ctrlKey) && e.key === "c") {
      e.preventDefault();
      const t = cellText(this.selectedValue());
      octopus.copy(t === null ? "NULL" : t);
      octopus.toast("Copied", "info");
    }
  }

  /** Rows in display order (sorted as shown). */
  visibleRows() {
    return this.view.map((i) => this.rows[i]);
  }
}
