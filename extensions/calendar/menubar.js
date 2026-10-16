// The next meeting in the Mac's menu bar (octopus.statusBar), Notion Calendar style: "[Standup] in 5m",
// then "[Standup] 5m left", for today's meetings only. Octopus gets a timeline for the rest of today
// and counts down by itself.

import { S, occurrencesIn, meetingLink } from "./store.js";
import { format, addDays, startOfDay, HOUR, MIN } from "./dates.js";

const TITLE_MAX = 24;
/** Setting `menuBar`: how long before a meeting it shows; 0 = off, -1 = the next one today, however far. */
export const MENU_BAR_OPTIONS = [
  [15, "15 min before"],
  [30, "30 min before"],
  [60, "1 hour before"],
  [-1, "Always the next one"],
];

let publishedSig = null;

const shortTitle = (t) => (t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t);

// A calendar's colour is a theme variable: the menu bar needs it as #rrggbb.
const probe = document.createElement("span");
function hexOf(color) {
  if (!probe.isConnected) document.body.append(probe);
  probe.style.color = "";
  probe.style.color = color;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  return m ? `#${m.slice(1, 4).map((n) => (+n).toString(16).padStart(2, "0")).join("")}` : undefined;
}

/**
 * Meetings as the sidebar's "next up" counts them: not free, not declined, each invite once, and not
 * from a muted calendar (its "Mute calendar" option, `hideInMenuBar`).
 */
function meetings(from, to, { allDay = false } = {}) {
  const seen = new Set();
  return occurrencesIn(from, to, { search: false }).filter((o) => {
    if ((o.allDay && !allDay) || o.transparent || o.response === "DECLINED" || o.cal.hideInMenuBar) return false;
    const k = `${o.uid}|${+o.start}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Only today's meetings: once the last one ends, the item shows just the day until midnight.
function timeline(lead, now) {
  const today = startOfDay(now);
  const list = meetings(now, addDays(today, 1)).filter((o) => +o.end > +now);
  const entry = (o, text, from, to) => ({
    text,
    from,
    to,
    color: hexOf(o.color),
    tooltip: `${o.title} · ${format.time(o.start)}–${format.time(o.end)} · ${o.cal.name}`,
    url: meetingLink(o) || undefined,
  });
  // The first entry of the moment wins: a meeting under way before the next one coming.
  const during = list.map((o) => entry(o, `${shortTitle(o.title)} {remaining} left`, +o.start, +o.end));
  const before = list.map((o, i) => {
    const from = lead < 0 ? (i ? +list[i - 1].start : undefined) : +o.start - lead * MIN;
    return entry(o, `${shortTitle(o.title)} in {remaining}`, from, +o.start);
  });
  // With no meeting to show, the day ("Mon 12"): the item stays, to open the menu.
  const days = [0, 1, 2].map((i) => {
    const d = addDays(today, i);
    return { text: `${format.weekdayShort(d)} ${d.getDate()}`, from: +d, to: +addDays(d, 1) };
  });
  return [...during, ...before, ...days];
}

// The menu a click opens, like Notion Calendar's: the meeting under way or coming next, under "Now · 20m
// left" or "Upcoming in 2h 34m" (Octopus keeps the countdown going while the menu is open), with a row to
// join its call; then the rest of today and the next two days that have meetings (one with a call opens a
// submenu, Join first); then Refresh and
// Settings. Each event has its calendar's colour as a bar, striped while the invitation isn't answered.
// A click on an event shows it in the calendar (app.js handles the rows' ids: `event:`, `copy:`, …).
const MENU_DAYS = 3;
const MENU_MAX = 40;
/** Rows in the later meetings' submenus, all together: the menu stays under Octopus's 200. */
const SUB_MAX = 100;

const CALLS = [
  [/meet\.google\.com/, "Google Meet", "icons/meet.svg"],
  [/zoom\.us/, "Zoom", "icons/zoom.svg"],
  [/teams\.(microsoft|live)\.com/, "Microsoft Teams", "icons/teams.svg"],
  [/webex\.com/, "Webex", "icons/webex.svg"],
];

/** An occurrence's id in the menu's rows: its start (to find its day) and its key. */
export const menuRef = (o) => `${+o.start}|${o.key}`;

function joinRow(link) {
  const [, name, icon] = CALLS.find(([re]) => re.test(link)) || [null, "video", "icons/video.svg"];
  return { text: `Join ${name} meeting`, url: link, icon, iconTemplate: icon === "icons/video.svg" };
}

function eventRow(o, items) {
  const when = o.allDay ? "All day" : format.time(o.start);
  const row = {
    text: `${o.response === "NEEDS-ACTION" ? "⚠ " : ""}${when} · ${o.title}`,
    color: hexOf(o.color),
    bar: o.response === "NEEDS-ACTION" ? "striped" : o.response === "TENTATIVE" ? "outline" : "solid",
    id: `event:${menuRef(o)}`,
    show: true,
  };
  return items ? { ...row, items } : row;
}

/** The submenu of a later meeting with a call: joining it first, kept short (Octopus shows 200 rows in all). */
function joinMenu(o) {
  const link = meetingLink(o);
  return [
    joinRow(link),
    { separator: true },
    { text: "Open in Calendar", id: `event:${menuRef(o)}`, show: true },
    { text: "Copy meeting link", id: `copy-link:${menuRef(o)}` },
  ];
}

/** The submenu of the meeting coming next: what's in its details, and what to do with it. */
function detailsMenu(o) {
  const link = meetingLink(o);
  const rows = [{ text: `${format.time(o.start)} – ${format.time(o.end)} · ${o.cal.name}`, disabled: true }];
  if (o.location && o.location !== link) rows.push({ text: o.location, disabled: true });
  if (o.attendees?.length) rows.push({ text: `${o.attendees.length} ${o.attendees.length === 1 ? "guest" : "guests"}`, disabled: true });
  rows.push({ separator: true }, { text: "Open in Calendar", id: `event:${menuRef(o)}`, show: true });
  if (link) rows.push({ text: "Copy meeting link", id: `copy-link:${menuRef(o)}` });
  rows.push({ text: "Copy details", id: `copy:${menuRef(o)}` });
  return rows;
}

function menu(now) {
  const today = startOfDay(now);
  const end = addDays(today, 31); // far enough to find the next days with meetings
  const list = meetings(now, end, { allDay: true }).filter((o) => +o.end > +now);
  const timed = list.filter((o) => !o.allDay);
  const live = timed.filter((o) => +o.start <= +now);
  const featured = live.length ? live : timed.filter((o) => +o.start === +timed[0]?.start);
  const rows = [];

  const next = featured[0];
  if (live.length) rows.push({ text: "Now · {remaining} left", header: true, to: +next.end });
  else if (next && +next.start - +now < 12 * HOUR) rows.push({ text: "Upcoming in {remaining}", header: true, to: +next.start });
  else if (next) rows.push({ text: `Next · ${dayLabel(startOfDay(next.start), today)}`, header: true });
  else rows.push({ text: "No upcoming meetings", header: true });
  for (const o of featured) {
    rows.push(eventRow(o, detailsMenu(o)));
    const link = meetingLink(o);
    if (link) rows.push(joinRow(link));
  }

  // The rest by day (an event that began before today under today), up to MENU_DAYS days that have some.
  const byDay = new Map();
  for (const o of list) {
    if (featured.includes(o)) continue;
    const k = +startOfDay(+o.start < +today ? today : o.start);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(o);
  }
  let subRows = 0;
  for (const [k, day] of [...byDay].slice(0, MENU_DAYS)) {
    rows.push({ text: dayLabel(new Date(k), today), header: true });
    // An event with a call opens a submenu that starts with joining it, while there's room for one.
    for (const o of day) {
      if (rows.length >= MENU_MAX) break;
      const sub = meetingLink(o) && subRows < SUB_MAX ? joinMenu(o) : undefined;
      subRows += sub?.length ?? 0;
      rows.push(eventRow(o, sub));
    }
  }

  rows.push(
    { separator: true },
    { text: "Refresh Calendars", id: "refresh" },
    { text: "Settings…", id: "settings", show: true, shortcut: "Cmd+," },
  );
  return rows;
}

function dayLabel(d, today) {
  return +d === +today ? "Today" : +d === +addDays(today, 1) ? "Tomorrow" : format.dayShort(d);
}

/** Sends the timeline and menu when they changed (called on every render); clears the item when off. */
export function updateMenuBar() {
  if (!octopus.statusBar) return; // an Octopus without the menu bar
  if ([...S.feeds.values()].some((f) => f.status === "loading")) return;
  const lead = S.settings.menuBar ?? 0;
  const now = new Date();
  const entries = lead ? timeline(lead, now) : [];
  const rows = lead ? menu(now) : [];
  const sig = JSON.stringify([entries, rows]);
  if (sig === publishedSig) return;
  publishedSig = sig;
  octopus.statusBar.set(entries, { menu: rows }).catch((e) => {
    publishedSig = null;
    console.warn("Couldn't update the menu bar", e);
  });
}
