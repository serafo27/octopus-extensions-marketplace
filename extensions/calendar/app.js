// Calendar: layout, sidebar (mini month, accounts and calendars, next meeting), toolbar, keys.

import {
  S, load, onRender, rerender, saveAccounts, saveUi, refreshAll, refreshFeed, removeCalendar, colorOf, PALETTE,
  occurrencesIn, meetingLink, icsCalendars, deleteLocal,
} from "./store.js";
import { h, icon, openPopover, closePopover, popoverOpen, modalOpen, closeModal } from "./ui.js";
import { renderTimeGrid, renderMonth, renderAgenda, weekDays, visibleDays, resetScroll } from "./views.js";
import { updateMenuBar } from "./menubar.js";
import { openAddCalendar, openNewLocalCalendar, openSettings, openOccurrence, openShortcuts } from "./editor.js";
import { addDays, addMonths, startOfDay, startOfWeek, startOfMonth, sameDay, format, formatDuration, formatRange, MIN, DAY } from "./dates.js";

const app = document.getElementById("app");
const side = h("aside", { class: "side" });
const toolbar = h("header", { class: "bar" });
const view = h("main", { class: "view" });
app.replaceChildren(side, h("section", { class: "main" }, toolbar, view));

// --- Navigation -------------------------------------------------------------------------------

function step(dir) {
  if (S.view === "day") {
    let d = addDays(S.cursor, dir);
    if (S.settings.hideWeekends) while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, dir);
    S.cursor = d;
  } else if (S.view === "week") S.cursor = addDays(S.cursor, 7 * dir);
  else if (S.view === "month") S.cursor = addMonths(S.cursor, dir);
  else S.cursor = addDays(S.cursor, 30 * dir);
  S.miniCursor = S.cursor;
  rerender();
}

function goToday() {
  S.cursor = startOfDay(new Date());
  S.miniCursor = S.cursor;
  rerender();
}

function setView(v) {
  S.view = v;
  saveUi();
  rerender();
}

function title() {
  const c = S.cursor;
  if (S.view === "day") return [format.long(c), String(c.getFullYear())];
  if (S.view === "week") {
    const days = weekDays(c);
    const a = days[0];
    const b = days[days.length - 1];
    if (a.getMonth() === b.getMonth()) return [format.monthYear(a), `Week ${isoWeek(a)}`];
    const left = a.getFullYear() === b.getFullYear() ? format.monthShort(a) : `${format.monthShort(a)} ${a.getFullYear()}`;
    return [`${left} – ${format.monthShort(b)} ${b.getFullYear()}`, `Week ${isoWeek(a)}`];
  }
  if (S.view === "month") return [format.monthYear(c), ""];
  return [`From ${format.dayMonth(c)}`, ""];
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7)));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - y) / DAY - 3 + ((y.getUTCDay() + 6) % 7)) / 7);
}

// --- Toolbar ----------------------------------------------------------------------------------

const search = h("input", { class: "search", type: "search", placeholder: "Search events", spellcheck: "false" });
search.addEventListener("input", () => {
  S.query = search.value;
  renderView();
});
search.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    search.value = "";
    S.query = "";
    search.blur();
    renderView();
  }
});

function renderToolbar() {
  const [main, sub] = title();
  const loading = [...S.feeds.values()].some((f) => f.status === "loading");
  toolbar.replaceChildren(
    ...[
    h("div", { class: "bar-title" }, h("span", { class: "t-main" }, main), sub && h("span", { class: "t-sub faint" }, sub)),
    h("span", { class: "spacer" }),
    h("div", { class: "search-wrap" }, icon("search", 13), search),
    icsCalendars().length > 0 &&
      h("button", { class: "ghost icon-btn", title: "Refresh calendars (R)", disabled: loading, onclick: () => refreshAll() }, loading ? h("span", { class: "spinner" }) : icon("refresh")),
    h("button", { class: "ghost settings-btn", title: "Settings · ? for shortcuts", onclick: (e) => openSettings(e.currentTarget) }, icon("gear"), "Settings"),
    h(
      "div",
      { class: "seg" },
      [["day", "Day", "D"], ["week", "Week", "W"], ["month", "Month", "M"], ["agenda", "Agenda", "A"]].map(([v, l, k]) =>
        h("button", { class: S.view === v ? "on" : "", title: `${l} (${k})`, onclick: () => setView(v) }, l),
      ),
    ),
    h("button", { class: "today-btn", title: "Today (T)", onclick: goToday }, "Today"),
    h("div", { class: "nav" },
      h("button", { class: "ghost icon-btn", title: "Previous (K, ←)", onclick: () => step(-1) }, icon("left")),
      h("button", { class: "ghost icon-btn", title: "Next (J, →)", onclick: () => step(1) }, icon("right")),
    ),
    ].filter(Boolean),
  );
}

// --- Sidebar ----------------------------------------------------------------------------------

function renderSide() {
  side.replaceChildren(miniMonth(), nextUp(), calendarsList());
}

function miniMonth() {
  const m = startOfMonth(S.miniCursor);
  const start = startOfWeek(m, S.settings.weekStart);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const busy = new Set(occurrencesIn(start, addDays(start, 42)).flatMap((o) => {
    const keys = [];
    for (let d = startOfDay(o.start); d < o.end || +d === +startOfDay(o.start); d = addDays(d, 1)) {
      keys.push(+d);
      if (keys.length > 42) break;
    }
    return keys;
  }));
  const shown = S.view === "month" ? null : S.view === "agenda" ? [S.cursor] : visibleDays();
  const today = new Date();
  return h(
    "div",
    { class: "mini" },
    h(
      "div",
      { class: "mini-head" },
      h("span", { class: "mini-title" }, format.monthYear(m)),
      h("button", { class: "ghost icon-btn sm", onclick: () => ((S.miniCursor = addMonths(m, -1)), renderSide()) }, icon("left", 12)),
      h("button", { class: "ghost icon-btn sm", onclick: () => ((S.miniCursor = addMonths(m, 1)), renderSide()) }, icon("right", 12)),
    ),
    h(
      "div",
      { class: "mini-grid" },
      days.slice(0, 7).map((d) => h("span", { class: "mini-dow faint" }, format.weekdayNarrow(d))),
      days.map((d) =>
        h(
          "button",
          {
            class: [
              "mini-day",
              d.getMonth() !== m.getMonth() && "other",
              sameDay(d, today) && "today",
              (shown ? shown.some((x) => sameDay(x, d)) : S.view === "month" && d.getMonth() === S.cursor.getMonth() && d.getFullYear() === S.cursor.getFullYear()) && "in-view",
              busy.has(+d) && "busy",
            ].filter(Boolean).join(" "),
            onclick: () => {
              S.cursor = d;
              S.miniCursor = d;
              rerender();
            },
          },
          d.getDate(),
        ),
      ),
    ),
  );
}

// The meetings happening now or, when none is, the next one and those overlapping it: a carousel.
// Not from a muted calendar (its "Mute calendar" option).
let nextIdx = { sig: "", i: 0 };

function nextGroup(now) {
  const seen = new Set();
  const upcoming = occurrencesIn(now, addDays(now, 1)).filter((o) => {
    if (o.allDay || o.transparent || o.response === "DECLINED" || o.cal.hideInMenuBar || +o.end <= +now) return false;
    const k = `${o.uid}|${+o.start}`; // the same invite in two accounts shows once
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const live = upcoming.filter((o) => +o.start <= +now);
  if (live.length) return live;
  // The next meeting and those starting with it (within 15 minutes and before it ends).
  const first = upcoming[0];
  return first ? upcoming.filter((o) => +o.start < Math.min(+first.end, +first.start + 15 * MIN)) : [];
}

function nextCard(o, now) {
  const live = +o.start <= +now;
  const mins = Math.round((o.start - now) / MIN);
  const when = live
    ? `Now · ends in ${formatDuration(o.end - now)}`
    : mins < 60 ? `In ${mins} min · ${format.time(o.start)}` : `${sameDay(o.start, now) ? "Today" : "Tomorrow"} ${format.time(o.start)}`;
  const link = meetingLink(o);
  return h(
    "div",
    { class: `next${live ? " live" : ""}`, style: { "--c": o.color }, onclick: (e) => !e.target.closest("button") && openOccurrence(o, e.currentTarget) },
    h("div", { class: "next-when" }, when),
    h("div", { class: "next-title" }, o.title),
    h("div", { class: "next-cal faint" }, o.cal.name),
    link && h("button", { class: "primary sm", onclick: () => octopus.openUrl(link) }, icon("video", 12), " Join"),
  );
}

function nextUp() {
  const now = new Date();
  const group = nextGroup(now);
  if (!group.length) return h("div", { class: "next empty faint" }, "Nothing else in the next 24 hours");
  if (group.length === 1) return nextCard(group[0], now);

  const sig = group.map((o) => o.key).join(",");
  if (nextIdx.sig !== sig) nextIdx = { sig, i: 0 };
  const track = h("div", { class: "next-track" }, group.map((o) => nextCard(o, now)));
  const dots = group.map((o, i) => h("button", { class: "next-dot", style: { "--c": o.color }, title: o.title, onclick: () => go(i) }));
  const count = h("span", { class: "next-count faint" });
  const go = (i, animate = true) => {
    nextIdx.i = (i + group.length) % group.length;
    track.style.transition = animate ? "" : "none";
    track.style.transform = `translateX(-${nextIdx.i * 100}%)`;
    dots.forEach((d, j) => d.classList.toggle("on", j === nextIdx.i));
    count.textContent = `${nextIdx.i + 1} of ${group.length}`;
  };
  const viewport = h("div", { class: "next-viewport" }, track);
  // A horizontal trackpad swipe flips too.
  let wheelLock = 0;
  viewport.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaX) < 12 || Math.abs(e.deltaX) < Math.abs(e.deltaY) || performance.now() < wheelLock) return;
    e.preventDefault();
    wheelLock = performance.now() + 450;
    go(nextIdx.i + Math.sign(e.deltaX));
  }, { passive: false });
  const el = h(
    "div",
    { class: "next-carousel" },
    viewport,
    h(
      "div",
      { class: "next-nav" },
      h("button", { class: "ghost icon-btn sm", title: "Previous meeting", onclick: () => go(nextIdx.i - 1) }, icon("left", 12)),
      h("div", { class: "next-dots" }, dots),
      h("button", { class: "ghost icon-btn sm", title: "Next meeting", onclick: () => go(nextIdx.i + 1) }, icon("right", 12)),
      h("span", { class: "spacer" }),
      count,
    ),
  );
  go(nextIdx.i, false);
  return el;
}

function calendarsList() {
  const wrap = h("div", { class: "cals" });
  for (const account of S.accounts) {
    wrap.append(
      h("div", { class: "acc-head faint" }, h("span", { class: "acc-name", title: account.name }, account.name)),
      ...account.calendars.map((cal) => calendarRow(account, cal)),
    );
  }
  wrap.append(
    h(
      "div",
      { class: "cal-add" },
      h("button", { class: "ghost", onclick: () => openAddCalendar("google") }, icon("plus", 12), " Add calendar (Google, Outlook, iCloud)"),
      h("button", { class: "ghost", onclick: openNewLocalCalendar }, icon("plus", 12), " New local calendar"),
    ),
  );
  return wrap;
}

function calendarRow(account, cal) {
  const feed = S.feeds.get(cal.id);
  const toggle = h("input", { type: "checkbox", class: "cal-check", style: { "--c": colorOf(cal) }, checked: cal.visible });
  toggle.addEventListener("change", () => {
    cal.visible = toggle.checked;
    saveAccounts();
    rerender();
  });
  const row = h(
    "div",
    { class: `cal-row${cal.hideInMenuBar ? " muted" : ""}`, title: feed?.status === "error" ? feed.error : cal.name },
    h("label", { class: "cal-label" }, toggle, h("span", { class: "cal-name" }, cal.name)),
    cal.hideInMenuBar &&
      h("button", {
        class: "ghost icon-btn sm cal-muted",
        title: "Muted: not in the menu bar, Up next, notifications, auto join or other extensions · click to unmute",
        onclick: () => ((cal.hideInMenuBar = false), saveAccounts(), rerender()),
      }, icon("bellOff", 12)),
    feed?.status === "loading" && h("span", { class: "spinner sm" }),
    feed?.status === "error" && h("span", { class: "badge error", title: feed.error }, "!"),
    h("button", { class: "ghost icon-btn sm cal-menu", title: "Options", onclick: (e) => calendarMenu(e.currentTarget, account, cal) }, icon("more", 12)),
  );
  return row;
}

function calendarMenu(anchor, account, cal) {
  const feed = S.feeds.get(cal.id);
  const rename = h("input", { value: cal.name });
  rename.addEventListener("change", () => {
    cal.name = rename.value.trim() || cal.name;
    saveAccounts();
    rerender();
  });
  openPopover(
    anchor,
    h(
      "div",
      { class: "menu" },
      rename,
      h("div", { class: "swatches" }, PALETTE.map((c, i) =>
        h("button", { class: `swatch${i === cal.color ? " on" : ""}`, style: { "--c": c }, onclick: () => ((cal.color = i), saveAccounts(), closePopover(), rerender()) }),
      )),
      h("button", { class: "ghost item", onclick: () => { for (const x of S.accounts.flatMap((a) => a.calendars)) x.visible = x.id === cal.id; saveAccounts(); closePopover(); rerender(); } }, icon("eye", 12), " Show only this"),
      h("button", {
        class: "ghost item",
        title: "Leaves the menu bar, Up next, notifications, auto join and what other extensions read; stays in the views",
        onclick: () => ((cal.hideInMenuBar = !cal.hideInMenuBar), saveAccounts(), closePopover(), rerender()),
      }, icon("bellOff", 12), cal.hideInMenuBar ? " Unmute calendar" : " Mute calendar"),
      account.kind === "ics" && h("button", { class: "ghost item", onclick: () => (closePopover(), refreshFeed(cal)) }, icon("refresh", 12), " Refresh"),
      account.kind === "ics" && h("button", { class: "ghost item", onclick: () => (octopus.copy(cal.url), octopus.toast("Address copied", "info")) }, icon("copy", 12), " Copy address"),
      feed?.fetchedAt && h("div", { class: "faint item-note" }, `Updated ${format.time(new Date(feed.fetchedAt))}, ${format.dayMonth(new Date(feed.fetchedAt))}`),
      feed?.status === "error" && h("div", { class: "ed-err" }, feed.error),
      (account.kind === "ics" || S.accounts.find((a) => a.kind === "local").calendars.length > 1) &&
        h("button", {
          class: "ghost item danger",
          onclick: () => {
            const n = S.local.filter((e) => e.calendarId === cal.id).length;
            if (n && !confirm(`Remove “${cal.name}” and its ${n} event${n === 1 ? "" : "s"}?`)) return;
            removeCalendar(cal.id);
            closePopover();
            rerender();
          },
        }, icon("trash", 12), account.kind === "ics" ? " Unsubscribe" : " Delete calendar"),
    ),
    { width: 230, prefer: "right" },
  );
  rename.focus();
}

// --- Render -----------------------------------------------------------------------------------

function renderView() {
  view.replaceChildren();
  view.className = `view v-${S.query ? "search" : S.view}`;
  if (S.query.trim()) renderAgenda(view, { search: true });
  else if (S.view === "month") renderMonth(view);
  else if (S.view === "agenda") renderAgenda(view);
  else renderTimeGrid(view);
}

function render() {
  renderToolbar();
  renderSide();
  renderView();
  updateMenuBar();
}
onRender(render);

// --- Keys -------------------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  const typing = e.target.matches?.("input, textarea, select");
  if (e.key === "Escape") {
    if (modalOpen()) return closeModal();
    if (popoverOpen()) return closePopover();
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      search.focus();
      search.select();
    }
    return;
  }
  if (modalOpen()) return;
  const k = e.key.toLowerCase();
  const map = {
    t: goToday,
    d: () => setView("day"),
    w: () => setView("week"),
    m: () => setView("month"),
    a: () => setView("agenda"),
    j: () => step(1),
    n: () => step(1),
    arrowright: () => step(1),
    k: () => step(-1),
    p: () => step(-1),
    arrowleft: () => step(-1),
    r: () => refreshAll(),
    "/": () => (search.focus(), search.select()),
    c: newEventNow,
    "?": openShortcuts,
  };
  if ((k === "backspace" || k === "delete") && popoverOpen() && S.editing) {
    deleteLocal(S.editing);
    S.editing = null;
    closePopover();
    rerender();
    return e.preventDefault();
  }
  if (map[k] && !popoverOpen()) {
    e.preventDefault();
    map[k]();
  }
});

function newEventNow() {
  const now = new Date();
  const start = new Date(now);
  start.setMinutes(Math.ceil(now.getMinutes() / 30) * 30, 0, 0);
  const day = S.view === "day" || S.view === "week" ? visibleDays().find((d) => sameDay(d, now)) || S.cursor : now;
  start.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  const anchor = toolbar.getBoundingClientRect();
  import("./editor.js").then(({ openEditor }) =>
    openEditor(
      { draft: { start, end: new Date(+start + S.settings.defaultDuration * MIN), allDay: false, calendarId: S.accounts.find((a) => a.kind === "local").calendars[0].id } },
      new DOMRect(anchor.right - 400, anchor.bottom, 1, 1),
    ),
  );
}

// --- Start ------------------------------------------------------------------------------------

new ResizeObserver(() => S.view === "month" && !S.query && renderView()).observe(view);

// Keep "now" current: the red line, "next up" and past events. A toast as a meeting is about to start
// (not for a muted calendar).
const notified = new Set();
let pointerDown = false;
window.addEventListener("pointerdown", () => (pointerDown = true), true);
window.addEventListener("pointerup", () => (pointerDown = false), true);
let ticks = 0;
setInterval(() => {
  const busy = popoverOpen() || modalOpen() || pointerDown || document.activeElement?.matches("input, textarea, select");
  if (ticks++ % 2 === 0 && !busy) render();
  else updateMenuBar();
  if (S.settings.autoJoin) autoJoin();
  if (!S.settings.notify) return;
  const now = Date.now();
  const lead = (S.settings.notifyLead ?? 1) * MIN + 10_000; // the timer ticks every 30 s
  for (const o of occurrencesIn(new Date(now), new Date(now + lead))) {
    if (o.allDay || o.response === "DECLINED" || o.cal.hideInMenuBar || +o.start < now || +o.start > now + lead || notified.has(o.key)) continue;
    notified.add(o.key);
    octopus.toast(`${o.title} starts at ${format.time(o.start)}${meetingLink(o) ? " · Join from the sidebar" : ""}`, "info");
  }
}, 30_000);

// Auto join: the chosen minutes before a meeting you accepted (or organize) starts, open its call link as
// the Join button would; never for a muted calendar. Each invite once, also across reloads (the page
// reloads on every file save).
const JOINED_KEY = "calendar:autoJoined";
function joinedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(JOINED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function autoJoin() {
  const now = Date.now();
  const joined = joinedSet();
  const lead = (S.settings.autoJoinLead ?? 1) * MIN + 10_000; // the timer ticks every 30 s
  for (const o of occurrencesIn(new Date(now), new Date(now + lead), { search: false })) {
    if (o.allDay || o.cal.hideInMenuBar || +o.start < now || +o.start > now + lead) continue;
    const me = o.account.name.toLowerCase();
    const mine = o.response === "ACCEPTED" || (o.organizer?.email && o.organizer.email.toLowerCase() === me);
    const link = mine && meetingLink(o);
    const k = `${o.uid}|${+o.start}`;
    if (!link || joined.has(k)) continue;
    joined.add(k);
    octopus.openUrl(link);
    octopus.toast(`Joining ${o.title}`, "info");
  }
  try {
    localStorage.setItem(JOINED_KEY, JSON.stringify([...joined].filter((k) => +k.split("|").pop() > now - DAY)));
  } catch {}
}
setInterval(() => refreshAll(), 15 * 60_000);
// Every time the section is shown, it opens on today (and the current hour), not where it was left.
octopus.on("visible", (shown) => {
  if (!shown || popoverOpen() || modalOpen()) return;
  resetScroll();
  goToday();
});
octopus.on("theme", () => updateMenuBar()); // calendar colours are theme colours

// Clicks in the menu bar's menu (menubar.js): its rows' ids.
octopus.on("statusBar", ({ id }) => {
  if (id === "refresh") return void refreshAll();
  if (id === "settings") return whenShown(document.querySelector(".settings-btn"), (el) => openSettings(el));
  const [, action, start, key] = /^([\w-]+):(\d+)\|(.+)$/.exec(id) || [];
  const day = start && startOfDay(new Date(+start));
  const o = day && occurrencesIn(day, addDays(day, 1), { all: true, search: false }).find((x) => x.key === key);
  if (!o) return octopus.toast("That event isn't in the calendar anymore", "error");
  if (action === "copy-link") return void octopus.copy(meetingLink(o)).then(() => octopus.toast("Meeting link copied", "success"));
  if (action === "copy") {
    const text = [o.title, formatRange(o.start, o.end, o.allDay), o.location, meetingLink(o)].filter(Boolean).join("\n");
    return void octopus.copy(text).then(() => octopus.toast("Details copied", "success"));
  }
  if (action === "event") {
    // Its day in the calendar, then its details beside it once the section shows.
    closePopover();
    search.value = S.query = "";
    if (S.view === "agenda" || !visibleDays().some((d) => sameDay(d, o.start))) S.cursor = day;
    S.miniCursor = S.cursor;
    rerender();
    const el = document.querySelector(`[data-key="${CSS.escape(o.key)}"]`) || document.querySelector(".toolbar");
    whenShown(el, (anchor) => openOccurrence(o, anchor));
  }
});

/** Runs `fn(el)` once the page shows `el` (Octopus brings the section up after the click), within 2 s. */
function whenShown(el, fn, tries = 120) {
  if (!el) return;
  if (el.getBoundingClientRect().width > 0) return fn(el);
  if (tries > 0) requestAnimationFrame(() => whenShown(el, fn, tries - 1));
}

(async () => {
  await octopus.ready();
  await load();
  render();
  refreshAll();
})().catch((e) => {
  view.replaceChildren(h("div", { class: "empty" }, h("span", { class: "badge error" }, "Error"), " ", e.message));
});
