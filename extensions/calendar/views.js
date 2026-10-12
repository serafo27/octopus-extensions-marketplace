// The calendar views: day/week time grid, month grid, agenda and search results.

import { S, occurrencesIn, rerender, upsertLocal, localCalendars, colorOf } from "./store.js";
import { h, justClosedPopover } from "./ui.js";
import { openEditor, openDetails, openDayList, openOccurrence } from "./editor.js";
import {
  DAY, MIN, addDays, startOfDay, startOfWeek, startOfMonth, daysInMonth, sameDay, minutesOfDay, dayKey, format,
} from "./dates.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const snap = (m, step = 15) => Math.round(m / step) * step;
const at = (day, min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min);
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);

export function weekDays(anchor) {
  const start = startOfWeek(anchor, S.settings.weekStart);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return S.settings.hideWeekends ? days.filter((d) => d.getDay() !== 0 && d.getDay() !== 6) : days;
}

export function visibleDays() {
  return S.view === "day" ? [S.cursor] : weekDays(S.cursor);
}

const isLong = (o) => o.allDay || o.end - o.start >= DAY;

/** Column span [s, e) of an occurrence among `days` (s = -1 when not shown). */
function spanIn(days, o) {
  const sd = startOfDay(o.start);
  let endEx = o.end;
  if (!o.allDay) endEx = +startOfDay(o.end) === +o.end ? o.end : addDays(startOfDay(o.end), 1);
  if (+endEx <= +sd) endEx = addDays(sd, 1);
  let s = -1;
  let e = -1;
  days.forEach((d, i) => {
    if (d >= sd && d < endEx) {
      if (s < 0) s = i;
      e = i + 1;
    }
  });
  return { s, e, startsBefore: sd < days[0], endsAfter: endEx > addDays(days[days.length - 1], 1) };
}

/** Lanes for horizontal bars: items { s, e } get .lane; returns the lane count. */
function layoutLanes(items) {
  items.sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s));
  const ends = [];
  for (const it of items) {
    let lane = ends.findIndex((end) => end <= it.s);
    if (lane < 0) lane = ends.length;
    ends[lane] = it.e;
    it.lane = lane;
  }
  return ends.length;
}

function defaultCalendar() {
  const cals = localCalendars();
  return (cals.find((x) => x.cal.visible) || cals[0])?.cal;
}

function tzLabel() {
  const off = -new Date().getTimezoneOffset();
  const hh = Math.trunc(Math.abs(off) / 60);
  const mm = Math.abs(off) % 60;
  return `GMT${off >= 0 ? "+" : "-"}${hh}${mm ? ":" + String(mm).padStart(2, "0") : ""}`;
}

function eventStyle(o) {
  return { "--c": o.color };
}

function occClass(o, base) {
  const now = Date.now();
  let c = base;
  if (+o.end < now) c += " past";
  if (o.transparent || o.response === "TENTATIVE" || o.response === "NEEDS-ACTION") c += " free";
  if (o.response === "DECLINED") c += " declined";
  if (o.editable) c += " editable";
  return c;
}

// --- Day / week -------------------------------------------------------------------------------

let lastScroll = null;

export function renderTimeGrid(root) {
  const days = visibleDays();
  const N = days.length;
  const from = days[0];
  const to = addDays(days[N - 1], 1);
  const occs = occurrencesIn(from, to);
  const byKey = new Map(occs.map((o) => [o.key, o]));
  const hourH = S.settings.hourHeight;
  const now = new Date();
  const cols = `52px repeat(${N}, minmax(0, 1fr))`;

  // Header: weekday + date.
  const head = h(
    "div",
    { class: "tg-head", style: { gridTemplateColumns: cols } },
    h("div", { class: "tg-gutter tz faint" }, tzLabel()),
    days.map((d) =>
      h(
        "div",
        {
          class: `tg-dayhead${sameDay(d, now) ? " today" : ""}${d < startOfDay(now) ? " past" : ""}`,
          title: format.full(d),
          onclick: () => {
            S.cursor = d;
            S.view = "day";
            rerender();
          },
        },
        h("span", { class: "dow" }, format.weekdayShort(d)),
        h("span", { class: "dnum" }, d.getDate()),
      ),
    ),
  );

  // All-day row.
  const bars = occs.filter(isLong).map((o) => ({ o, ...spanIn(days, o) })).filter((x) => x.s >= 0);
  const laneCount = layoutLanes(bars);
  const lanesEl = h(
    "div",
    {
      class: "tg-allday-lanes",
      style: { gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.max(1, laneCount)}, 22px)` },
    },
    bars.map(({ o, s, e, lane, startsBefore, endsAfter }) =>
      h(
        "div",
        {
          class: occClass(o, `ad-ev${startsBefore ? " cont-l" : ""}${endsAfter ? " cont-r" : ""}`),
          "data-key": o.key,
          style: { ...eventStyle(o), gridColumn: `${s + 1} / ${e + 1}`, gridRow: lane + 1 },
          title: o.title,
        },
        h("span", { class: "ad-title" }, o.title),
        !o.allDay && h("span", { class: "ad-time" }, format.time(o.start)),
      ),
    ),
  );
  lanesEl.addEventListener("click", (e) => {
    const el = e.target.closest(".ad-ev");
    if (el) return openOccurrence(byKey.get(el.dataset.key), el);
    if (justClosedPopover()) return;
    // An empty spot: a new all-day event that day.
    const r = lanesEl.getBoundingClientRect();
    const i = clamp(Math.floor(((e.clientX - r.left) / r.width) * N), 0, N - 1);
    const cal = defaultCalendar();
    if (!cal) return;
    openEditor({ draft: { start: days[i], end: addDays(days[i], 1), allDay: true, calendarId: cal.id } }, new DOMRect(e.clientX, e.clientY, 1, 1));
  });
  const allday = h(
    "div",
    { class: "tg-allday", style: { gridTemplateColumns: cols } },
    h("div", { class: "tg-gutter label faint" }, "all-day"),
    h("div", { class: "tg-allday-wrap", style: { gridColumn: `2 / span ${N}` } }, lanesEl),
  );

  // Hours.
  const gutter = h(
    "div",
    { class: "tg-gutter hours" },
    Array.from({ length: 23 }, (_, i) => h("span", { class: "hour faint", style: { top: `${(i + 1) * hourH}px` } }, format.hour(i + 1))),
  );
  const colEls = days.map((d, i) => {
    const wd = d.getDay();
    return h("div", {
      class: `tg-col${sameDay(d, now) ? " today" : ""}${wd === 0 || wd === 6 ? " weekend" : ""}`,
      "data-i": i,
    });
  });

  // Timed events, split per day.
  const timed = occs.filter((o) => !isLong(o));
  days.forEach((d, i) => {
    const dayStart = +d;
    const dayEnd = +addDays(d, 1);
    const segs = [];
    for (const o of timed) {
      const s = Math.max(+o.start, dayStart);
      const e = Math.min(+o.end, dayEnd);
      if (e < s || (e === s && +o.start !== s) || s >= dayEnd) continue;
      const top = (s - dayStart) / MIN;
      const bottom = e === dayEnd ? 1440 : (e - dayStart) / MIN;
      segs.push({ o, top, bottom: Math.max(bottom, top + 15), contTop: +o.start < dayStart, contBottom: +o.end > dayEnd });
    }
    layoutColumns(segs);
    for (const seg of segs) colEls[i].append(eventBlock(seg, hourH));
  });

  // Now.
  const todayIdx = days.findIndex((d) => sameDay(d, now));
  if (todayIdx >= 0) {
    const top = (minutesOfDay(now) / 60) * hourH;
    colEls[todayIdx].append(h("div", { class: "now-line", style: { top: `${top}px` } }));
    gutter.append(h("span", { class: "now-label", style: { top: `${top}px` } }, format.time(now)));
  }

  const colsWrap = h("div", { class: "tg-cols", style: { gridColumn: `2 / span ${N}`, gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` } }, colEls);
  const body = h("div", { class: "tg-body", style: { gridTemplateColumns: cols, height: `${24 * hourH}px`, "--hour": `${hourH}px` } }, gutter, colsWrap);
  const scroller = h("div", { class: "tg-scroll" }, h("div", { class: "tg-sticky" }, head, allday), body);
  root.append(scroller);

  const scrollKey = `${S.view}`;
  if (lastScroll?.key === scrollKey) scroller.scrollTop = lastScroll.top;
  else {
    const target = todayIdx >= 0 ? Math.max(0, minutesOfDay(now) / 60 - 2) : 7.5;
    scroller.scrollTop = target * hourH;
  }
  scroller.addEventListener("scroll", () => (lastScroll = { key: scrollKey, top: scroller.scrollTop }));
  lastScroll = { key: scrollKey, top: scroller.scrollTop };

  // Pointer: create by dragging on empty space, move and resize local events.
  const slotAt = (e) => {
    const r = colsWrap.getBoundingClientRect();
    const i = clamp(Math.floor(((e.clientX - r.left) / r.width) * N), 0, N - 1);
    return { i, min: ((e.clientY - r.top) / hourH) * 60 };
  };

  colsWrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || justClosedPopover()) return;
    const evEl = e.target.closest(".ev");
    if (evEl) {
      const o = byKey.get(evEl.dataset.key);
      if (!o.editable) return; // a click shows the details
      e.preventDefault();
      return dragEvent(e, o, evEl, e.target.classList.contains("ev-resize") ? "resize" : "move");
    }
    e.preventDefault();
    createByDrag(e);
  });
  colsWrap.addEventListener("click", (e) => {
    const evEl = e.target.closest(".ev");
    if (evEl && !evEl.classList.contains("editable")) openDetails(byKey.get(evEl.dataset.key), evEl);
  });

  function createByDrag(e) {
    const cal = defaultCalendar();
    if (!cal) return;
    const a = slotAt(e);
    const day = days[a.i];
    const m0 = clamp(Math.floor(a.min / 15) * 15, 0, 1425);
    let m1 = Math.min(1440, m0 + S.settings.defaultDuration);
    let moved = false;
    const ghost = h("div", { class: "ev ghost", style: { "--c": colorOf(cal) } }, h("div", { class: "ev-time" }));
    colEls[a.i].append(ghost);
    const paint = () => {
      const s = Math.min(m0, m1);
      const en = Math.max(m0, m1);
      ghost.style.top = `${(s / 60) * hourH}px`;
      ghost.style.height = `${((en - s) / 60) * hourH - 2}px`;
      ghost.firstChild.textContent = `${format.time(at(day, s))} – ${format.time(at(day, en))}`;
    };
    paint();
    const y0 = e.clientY;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      const m = clamp(snap(slotAt(ev).min), 0, 1440);
      m1 = m === m0 ? m0 + 15 : m;
      paint();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const s = Math.min(m0, m1);
      const en = Math.max(m0, m1);
      openEditor({ draft: { start: at(day, s), end: at(day, en), allDay: false, calendarId: cal.id } }, ghost, {
        onClose: () => ghost.remove(),
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dragEvent(e, o, el, mode) {
    const a = slotAt(e);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let ghost = null;
    let newStart = o.start;
    let newEnd = o.end;
    const dur = o.end - o.start;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      const b = slotAt(ev);
      if (mode === "move") {
        const dMin = snap(b.min - a.min);
        const dDays = daysBetween(days[a.i], days[b.i]);
        newStart = new Date(+o.start + dMin * MIN);
        newStart.setDate(newStart.getDate() + dDays);
        newEnd = new Date(+newStart + dur);
      } else {
        const end = at(days[b.i], clamp(snap(b.min), 0, 1440));
        newEnd = new Date(Math.max(+end, +o.start + 15 * MIN));
      }
      if (!ghost) {
        el.classList.add("drag-src");
        ghost = el.cloneNode(true);
        ghost.classList.remove("drag-src");
        ghost.classList.add("dragging");
        ghost.style.left = "2px";
        ghost.style.width = "calc(100% - 4px)";
      }
      const i = days.findIndex((d) => sameDay(d, newStart));
      if (i < 0) return ghost.remove();
      const top = minutesOfDay(newStart);
      const bottom = sameDay(newStart, newEnd) ? minutesOfDay(newEnd) : 1440;
      ghost.style.top = `${(top / 60) * hourH}px`;
      ghost.style.height = `${(Math.max(bottom - top, 15) / 60) * hourH - 2}px`;
      const t = ghost.querySelector(".ev-time");
      if (t) t.textContent = `${format.time(newStart)} – ${format.time(newEnd)}`;
      colEls[i].append(ghost);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) return openEditor(o, el);
      const ev = S.local.find((x) => x.id === o.id);
      if (!ev) return rerender();
      // Shifts the whole series (a repeating event moves every occurrence).
      const dStart = newStart - o.start;
      const dEnd = newEnd - o.end;
      upsertLocal({ ...ev, start: ev.start + dStart, end: ev.end + dEnd });
      rerender();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}

/** Side-by-side columns for overlapping segments (sets .col and .cols). */
function layoutColumns(segs) {
  segs.sort((a, b) => a.top - b.top || b.bottom - b.top - (a.bottom - a.top));
  let cluster = [];
  let clusterEnd = -1;
  let colEnds = [];
  const close = () => {
    for (const s of cluster) s.cols = colEnds.length;
    cluster = [];
    colEnds = [];
  };
  for (const s of segs) {
    if (cluster.length && s.top >= clusterEnd) close();
    let c = colEnds.findIndex((end) => end <= s.top);
    if (c < 0) c = colEnds.length;
    colEnds[c] = s.bottom;
    s.col = c;
    cluster.push(s);
    clusterEnd = cluster.length === 1 ? s.bottom : Math.max(clusterEnd, s.bottom);
  }
  close();
}

function eventBlock(seg, hourH) {
  const { o, top, bottom, col, cols } = seg;
  const height = ((bottom - top) / 60) * hourH - 2;
  const compact = height < 34;
  const left = (col / cols) * 100;
  const width = (1 / cols) * 100;
  return h(
    "div",
    {
      class: occClass(o, `ev${compact ? " compact" : ""}${seg.contTop ? " cont-t" : ""}${seg.contBottom ? " cont-b" : ""}`),
      "data-key": o.key,
      title: `${o.title}\n${format.time(o.start)} – ${format.time(o.end)}${o.location ? "\n" + o.location : ""}`,
      style: {
        ...eventStyle(o),
        top: `${(top / 60) * hourH}px`,
        height: `${Math.max(height, 14)}px`,
        left: `calc(${left}% + 1px)`,
        width: `calc(${width}% - 3px)`,
      },
    },
    h("div", { class: "ev-title" }, o.title, compact && h("span", { class: "ev-time-inline" }, format.time(o.start))),
    !compact && h("div", { class: "ev-time" }, `${format.time(o.start)} – ${format.time(o.end)}`),
    !compact && height > 52 && o.location && h("div", { class: "ev-loc" }, o.location),
    o.editable && h("div", { class: "ev-resize" }),
  );
}

// --- Month ------------------------------------------------------------------------------------

export function renderMonth(root) {
  const first = startOfMonth(S.cursor);
  const gridStart = startOfWeek(first, S.settings.weekStart);
  const offset = daysBetween(gridStart, first);
  const weeks = Math.ceil((offset + daysInMonth(first.getFullYear(), first.getMonth())) / 7);
  const gridEnd = addDays(gridStart, weeks * 7);
  const occs = occurrencesIn(gridStart, gridEnd);
  const byKey = new Map(occs.map((o) => [o.key, o]));
  const now = new Date();
  const weekRows = Array.from({ length: weeks }, (_, w) => weekDays(addDays(gridStart, w * 7)));
  const N = weekRows[0].length;

  const head = h(
    "div",
    { class: "m-head", style: { gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` } },
    weekRows[0].map((d) => h("div", { class: "m-dow faint" }, format.weekdayShort(d))),
  );
  const grid = h("div", { class: "m-grid", style: { gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))` } });
  root.append(h("div", { class: "month" }, head, grid));

  const rowH = grid.clientHeight / weeks;
  const LANE = 20;
  const maxLanes = Math.max(1, Math.floor((rowH - 28) / LANE));

  weekRows.forEach((days) => {
    const row = h("div", { class: "m-week", style: { gridTemplateColumns: `repeat(${N}, minmax(0, 1fr))` } });
    days.forEach((d) => {
      const wd = d.getDay();
      row.append(
        h(
          "div",
          {
            class: `m-cell${d.getMonth() !== first.getMonth() ? " other" : ""}${sameDay(d, now) ? " today" : ""}${wd === 0 || wd === 6 ? " weekend" : ""}`,
            "data-day": dayKey(d),
          },
          h(
            "span",
            {
              class: "m-num",
              onclick: (e) => {
                e.stopPropagation();
                S.cursor = d;
                S.view = "day";
                rerender();
              },
            },
            d.getDate() === 1 ? `${format.monthShort(d)} 1` : d.getDate(),
          ),
        ),
      );
    });

    // Lanes: multi-day bars first, then single-day items in the free lanes of their day.
    const items = [];
    for (const o of occs) {
      const sp = spanIn(days, o);
      if (sp.s < 0) continue;
      items.push({ o, ...sp, multi: isLong(o) && sp.e - sp.s > 0 && (o.allDay || sp.e - sp.s > 1) });
    }
    const multi = items.filter((x) => x.multi);
    layoutLanes(multi);
    const occupied = days.map(() => new Set());
    for (const m of multi) for (let i = m.s; i < m.e; i++) occupied[i].add(m.lane);
    const singles = items.filter((x) => !x.multi);
    for (const it of singles) {
      let lane = 0;
      while (occupied[it.s].has(lane)) lane++;
      it.lane = lane;
      occupied[it.s].add(lane);
    }
    const counts = occupied.map((set) => set.size);
    const visibleLanes = counts.map((c) => (c > maxLanes ? maxLanes - 1 : maxLanes));
    const shown = days.map(() => 0);
    for (const it of [...multi, ...singles]) {
      const fits = Math.min(...visibleLanes.slice(it.s, it.e)) > it.lane;
      if (!fits) continue;
      for (let i = it.s; i < it.e; i++) shown[i]++;
      row.append(monthItem(it, N, LANE));
    }
    days.forEach((d, i) => {
      const hidden = counts[i] - shown[i];
      if (hidden <= 0) return;
      row.append(
        h(
          "div",
          {
            class: "m-more",
            style: { left: `calc(${(i / N) * 100}% + 4px)`, width: `calc(${100 / N}% - 8px)`, top: `${26 + visibleLanes[i] * LANE}px` },
            onclick: (e) => {
              e.stopPropagation();
              openDayList(d, e.currentTarget);
            },
          },
          `${hidden} more`,
        ),
      );
    });
    grid.append(row);
  });

  // Click an empty day: a new all-day event. Drag a local event to another day.
  const dayAt = (e) => {
    const rows = [...grid.children];
    const r = rows.findIndex((row) => {
      const b = row.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY < b.bottom;
    });
    if (r < 0) return null;
    const b = rows[r].getBoundingClientRect();
    const c = clamp(Math.floor(((e.clientX - b.left) / b.width) * N), 0, N - 1);
    return { day: weekRows[r][c], cell: rows[r].children[c] };
  };
  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || justClosedPopover() || e.target.closest(".m-more, .m-num")) return;
    const el = e.target.closest(".m-ev");
    if (el) {
      const o = byKey.get(el.dataset.key);
      if (!o.editable) return;
      e.preventDefault();
      const from = dayAt(e);
      const x0 = e.clientX;
      const y0 = e.clientY;
      let moved = false;
      let target = null;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        moved = true;
        el.classList.add("drag-src");
        const t = dayAt(ev);
        if (target?.cell !== t?.cell) target?.cell.classList.remove("drop");
        target = t;
        target?.cell.classList.add("drop");
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        target?.cell.classList.remove("drop");
        if (!moved) return openEditor(o, el);
        const delta = target && from ? daysBetween(from.day, target.day) : 0;
        const ev = S.local.find((x) => x.id === o.id);
        if (!delta || !ev) return rerender();
        const shift = (ts) => {
          const d = new Date(ts);
          d.setDate(d.getDate() + delta);
          return +d;
        };
        upsertLocal({ ...ev, start: shift(ev.start), end: shift(ev.end) });
        rerender();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
  });
  grid.addEventListener("click", (e) => {
    const el = e.target.closest(".m-ev");
    if (el) {
      if (!el.classList.contains("editable")) openDetails(byKey.get(el.dataset.key), el);
      return;
    }
    if (e.target.closest(".m-more, .m-num") || justClosedPopover()) return;
    const t = dayAt(e);
    const cal = defaultCalendar();
    if (!t || !cal) return;
    t.cell.classList.add("drop");
    openEditor({ draft: { start: t.day, end: addDays(t.day, 1), allDay: true, calendarId: cal.id } }, t.cell, {
      onClose: () => t.cell.classList.remove("drop"),
    });
  });
}

function monthItem(it, N, LANE) {
  const { o, s, e, lane, multi, startsBefore, endsAfter } = it;
  const style = {
    ...eventStyle(o),
    left: `calc(${(s / N) * 100}% + ${startsBefore ? 0 : 4}px)`,
    width: `calc(${((e - s) / N) * 100}% - ${(startsBefore ? 0 : 4) + (endsAfter ? 0 : 4)}px)`,
    top: `${26 + lane * LANE}px`,
  };
  if (multi) {
    return h(
      "div",
      { class: occClass(o, `m-ev bar${startsBefore ? " cont-l" : ""}${endsAfter ? " cont-r" : ""}`), "data-key": o.key, style, title: o.title },
      h("span", { class: "m-title" }, o.title),
    );
  }
  return h(
    "div",
    { class: occClass(o, `m-ev${o.allDay ? " bar" : " dot"}`), "data-key": o.key, style, title: `${format.time(o.start)} ${o.title}` },
    !o.allDay && h("span", { class: "m-dot" }),
    !o.allDay && h("span", { class: "m-time" }, format.time(o.start)),
    h("span", { class: "m-title" }, o.title),
  );
}

// --- Agenda and search ------------------------------------------------------------------------

export function renderAgenda(root, { search = false } = {}) {
  const today = startOfDay(new Date());
  const from = search ? addDays(today, -365) : startOfDay(S.cursor);
  const to = search ? addDays(today, 365) : addDays(from, S.agendaDays || 30);
  const occs = occurrencesIn(from, to);
  const list = h("div", { class: "agenda" });
  if (search) list.append(h("div", { class: "agenda-summary muted" }, `${occs.length} result${occs.length === 1 ? "" : "s"} for “${S.query}” in the last and next 12 months`));

  const groups = new Map();
  for (const o of occs) {
    const first = startOfDay(o.start);
    const last = o.allDay ? addDays(o.end, -1) : startOfDay(new Date(Math.max(+o.start, +o.end - 1)));
    const total = daysBetween(first, last) + 1;
    const days = [];
    if (search) days.push(first);
    else for (let d = first < from ? from : first; d <= last && d < to; d = addDays(d, 1)) days.push(d);
    for (const d of days) {
      const k = dayKey(d);
      if (!groups.has(k)) groups.set(k, { day: d, items: [] });
      groups.get(k).items.push({ o, nth: total > 1 ? `Day ${daysBetween(first, d) + 1}/${total}` : null });
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.day - b.day);
  if (!sorted.length) list.append(h("div", { class: "empty muted" }, search ? "Nothing found." : "No events in the next 30 days."));
  for (const g of sorted) {
    const isToday = sameDay(g.day, today);
    g.items.sort((a, b) => (b.o.allDay - a.o.allDay) || a.o.start - b.o.start);
    list.append(
      h(
        "div",
        { class: `ag-day${isToday ? " today" : ""}${g.day < today ? " past" : ""}` },
        h("div", { class: "ag-date" }, h("span", { class: "ag-num" }, g.day.getDate()), h("span", { class: "ag-dow" }, `${format.monthShort(g.day)}, ${format.weekdayShort(g.day)}`), isToday && h("span", { class: "badge" }, "Today")),
        h(
          "div",
          { class: "ag-items" },
          g.items.map(({ o, nth }) =>
            h(
              "div",
              {
                class: occClass(o, "ag-item"),
                style: eventStyle(o),
                onclick: (e) => openOccurrence(o, e.currentTarget),
              },
              h("span", { class: "ag-bar" }),
              h("span", { class: "ag-time" }, o.allDay || nth ? nth || "All day" : `${format.time(o.start)} – ${format.time(o.end)}`),
              h("span", { class: "ag-title" }, o.title),
              o.location && h("span", { class: "ag-loc faint" }, o.location),
              h("span", { class: "ag-cal faint" }, o.cal.name),
            ),
          ),
        ),
      ),
    );
  }
  if (!search) {
    list.append(
      h("div", { class: "ag-more" }, h("button", { class: "ghost", onclick: () => ((S.agendaDays = (S.agendaDays || 30) + 30), rerender()) }, "Show 30 more days")),
    );
  }
  root.append(list);
}
