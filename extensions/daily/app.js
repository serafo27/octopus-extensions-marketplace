// Daily: the morning board. A sky that follows the hour with today's meetings on its horizon, a greeting
// and a summary of the day, the day at a glance, today's meetings, the weather, tasks in progress (doing,
// review) from every project, the rest of this week's one-off meetings and the news. Meetings come from
// what the Calendar extension shares (`octopus.shared.get("calendar", "events")`, calendar/store.js `publish`).

import { renderSky } from "./sky.js";
import { greeting, localSummary, claudeKey, claudeSummary } from "./summary.js";
import { weather as getWeather, news as getNews, describe, sources, forget, forgetNews, imageOf, imageNow, findPlaces } from "./services.js";
import { openReader, updateReader } from "./reader.js";
import { loadSettings, openSettings } from "./settings.js";
import { icon, weatherIcon } from "./icons.js";
import { ZONES, moveBlock, stepBlock, enableDrag, dragging } from "./layout.js";

const CALENDAR = "calendar";
const DAY = 86_400_000;
const PRIORITY = { 3: "Urgent", 2: "High", 1: "Medium", 0: "Low" };

const app = document.getElementById("app");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const S = {
  settings: null,
  projects: [],
  tasks: [],
  tasksError: null,
  calendar: null, // { id, name, enabled, ok } or null when not installed
  shared: null, // { from, to, publishedAt, events, errors }
  calendarError: null,
  sdkMissing: false,
  weather: null,
  weatherError: null,
  news: {}, // id -> { items } | { error }
  newsTab: "all",
  newsLoading: false,
  claude: null, // { key, text } | { key, loading } | { key, error }
  loading: true,
  risen: false,
  skyOpen: false, // the meetings under the horizon, unfolded with their names
};

// --- DOM ------------------------------------------------------------------------------------------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// --- Dates ----------------------------------------------------------------------------------------

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** The Monday-based week's end: the start of next Monday. */
const endOfWeek = (d) => addDays(startOfDay(d), 7 - ((d.getDay() + 6) % 7));
const time = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const longDate = (d) => d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
const weekdayName = (d) => d.toLocaleDateString([], { weekday: "long" });
const monthShort = (d) => d.toLocaleDateString([], { month: "short" });

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7)));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - y) / DAY - 3 + ((y.getUTCDay() + 6) % 7)) / 7);
}

function ago(at) {
  const min = Math.round((Date.now() - new Date(at)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

function duration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`;
}

function until(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `in ${m} min`;
  return `in ${duration(ms)}`;
}

// --- Data -----------------------------------------------------------------------------------------

async function loadTasks() {
  try {
    const [projects, tasks] = await Promise.all([octopus.projects.list(), octopus.tasks.list()]);
    S.projects = projects;
    S.tasks = tasks;
    S.tasksError = null;
  } catch (e) {
    S.tasksError = e.message;
  }
}

async function loadCalendar() {
  if (!octopus.extensions || !octopus.shared) {
    S.sdkMissing = true;
    return;
  }
  try {
    const list = await octopus.extensions.list();
    S.calendar = list.find((e) => e.id === CALENDAR) || null;
    S.shared = S.calendar ? await octopus.shared.get(CALENDAR, "events") : null;
    S.calendarError = null;
  } catch (e) {
    // An Octopus older than the extensions/shared API answers "… isn't part of Octopus's extension SDK".
    if (/isn't part of/.test(e.message)) S.sdkMissing = true;
    else S.calendarError = e.message;
  }
}

async function loadWeather() {
  if (!S.settings.weather) return (S.weather = null);
  try {
    S.weather = await getWeather(S.settings.city);
    S.weatherError = null;
  } catch (e) {
    S.weatherError = e.message;
  }
}

async function loadNews() {
  if (!S.settings.sections.news) return;
  S.newsLoading = true;
  await Promise.all(
    shownSources().map(async (src) => {
      try {
        S.news[src.id] = { items: await getNews(src) };
      } catch (e) {
        S.news[src.id] = { error: e.message };
      }
    }),
  );
  S.newsLoading = false;
  updateReader();
}

/** Reads every feed again, past the 20 minutes they're kept for. */
async function refreshNews() {
  forgetNews();
  const done = loadNews();
  render();
  await done;
  render();
}

/** Every headline of the sources shown, each with its source's id: what the newspaper lists. */
const allNews = () => shownSources().flatMap((src) => (S.news[src.id]?.items || []).map((x) => ({ ...x, source: src.id })));

function openNews(link) {
  openReader(link, { items: allNews, sources: shownSources, loading: () => S.newsLoading, refresh: refreshNews });
}

const shownSources = () => sources(S.settings).filter((src) => S.settings.news[src.id]);
const sourceOf = (id) => sources(S.settings).find((src) => src.id === id);

/** Board first (tasks and meetings are local and quick), then the outside services as they answer. */
async function refresh() {
  await Promise.all([loadTasks(), loadCalendar()]);
  S.loading = false;
  render();
  await Promise.all([loadWeather(), loadNews()]);
  render();
}

function events() {
  return (S.shared?.events || []).map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
}

function onDay(day) {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  return events().filter((e) => e.start < to && e.end > from);
}
const today = () => onDay(new Date());

/** Meetings after today until the end of the week that aren't part of a series, nor declined. */
function restOfWeek() {
  const from = addDays(startOfDay(new Date()), 1);
  const to = endOfWeek(new Date());
  return events().filter((e) => e.start >= from && e.start < to && !e.recurring && e.response !== "DECLINED");
}

function inProgress() {
  const order = { doing: 0, review: 1 };
  return S.tasks
    .filter((t) => t.status === "doing" || (S.settings.review && t.status === "review"))
    .sort((a, b) => order[a.status] - order[b.status] || b.priority - a.priority || a.title.localeCompare(b.title));
}

const calendarReady = () => !S.sdkMissing && S.calendar?.enabled && !!S.shared;
const animated = () => S.settings.animation && !reducedMotion.matches;
const attending = (e) => e.response !== "DECLINED" && !e.free;

function dayData(now) {
  return {
    now,
    today: today().filter((e) => !e.allDay),
    week: restOfWeek(),
    tasks: inProgress(),
    weather: S.weather,
    city: S.settings.city.name,
    calendar: calendarReady(),
  };
}

/** The longest stretch without meetings from now until the working day ends: `{ from, to }` or null. */
function longestFree(now, meetings) {
  const end = new Date(startOfDay(now).getTime() + S.settings.dayEnd * 3_600_000);
  let cursor = new Date(Math.max(+now, +startOfDay(now) + 9 * 3_600_000));
  if (cursor >= end) return null;
  let best = null;
  const busy = meetings.filter((e) => attending(e) && e.end > cursor && e.start < end).sort((a, b) => a.start - b.start);
  for (const e of [...busy, { start: end, end }]) {
    if (e.start > cursor && (!best || e.start - cursor > best.to - best.from)) best = { from: cursor, to: new Date(Math.min(+e.start, +end)) };
    if (e.end > cursor) cursor = e.end;
  }
  return best;
}

// --- Render ---------------------------------------------------------------------------------------

let skyEl = null;

function render() {
  if (S.loading || dragging()) return; // a drag redraws the board when it ends
  const now = new Date();
  const sec = S.settings.sections;
  const day = dayData(now);

  // The sky keeps its element between renders: its decor's slow animations go on.
  if (sec.sky) skyEl ??= h("div", { class: "sky" });

  app.classList.toggle("still", !animated());
  app.replaceChildren(
    ...[
      hero(now, day),
      calendarNotice(),
      // Beside the summary when it's shown; a row of its own when it isn't.
      sec.glance && !sec.summary && glance(now, day, false),
      board(now, day),
    ].filter(Boolean), // the DOM's own replaceChildren would print null
  );

  if (sec.sky) {
    requestAnimationFrame(() => {
      renderSky(skyEl, {
        now,
        meetings: day.calendar ? day.today : [],
        weather: S.weather,
        sky: S.weather ? describe(S.weather.code).sky : "clear",
        animate: animated(),
        expanded: S.skyOpen,
        onToggle: () => {
          S.skyOpen = !S.skyOpen;
          octopus.storage.set("skyOpen", S.skyOpen).catch(() => {});
          render();
        },
      });
    });
  }
}

/** The panels, in the zones the user has put them in (layout.js). */
function board(now, day) {
  const sec = S.settings.sections;
  const make = {
    today: () => sec.today && todayPanel(now),
    weather: () => S.settings.weather && weatherPanel(now),
    tasks: () => sec.tasks && tasksPanel(day.tasks),
    week: () => sec.week && weekPanel(now, day.week),
    news: () => sec.news && newsPanel(),
  };
  const zones = Object.fromEntries(
    ZONES.map((z) => [z, h("div", { class: `zone zone-${z}`, "data-zone": z }, S.settings.layout[z].map((id) => make[id]?.() || null))]),
  );
  const columns = h("div", { class: "columns" }, zones.left, zones.right);
  // One column alone takes the whole width, unless a drag needs both as targets (see style.css).
  columns.classList.toggle("single", !zones.left.childElementCount || !zones.right.childElementCount);
  columns.classList.toggle("empty", !zones.left.childElementCount && !zones.right.childElementCount);
  const el = h("div", { class: "board" }, zones.top, columns, zones.bottom);
  enableDrag(el, {
    onMove: (id, zone, index) => {
      moveBlock(S.settings.layout, id, zone, index, shownBlocks(el));
      saveSettings();
    },
    onEnd: render,
  });
  return el;
}

const shownBlocks = (root) => new Set([...root.querySelectorAll("[data-block]")].map((x) => x.dataset.block));

/** The grip's keys: arrows move the panel, and focus follows it to its new place. */
function onGripKey(e) {
  const id = e.currentTarget.closest("[data-block]").dataset.block;
  if (!stepBlock(S.settings.layout, id, e.key, shownBlocks(app))) return;
  e.preventDefault();
  saveSettings();
  render();
  app.querySelector(`[data-block="${id}"] .grip`)?.focus();
}

function saveSettings() {
  octopus.storage.set("settings", S.settings).catch((e) => octopus.toast(`Couldn't save the settings: ${e.message}`, "error"));
}

function tools() {
  return h(
    "div",
    { class: "tools" },
    h("button", { class: "ghost tool", title: "Copy the day as Markdown", "aria-label": "Copy", onclick: copyMarkdown }, icon("copy", 14)),
    h("button", { class: "ghost tool", title: "Read everything again", "aria-label": "Refresh", onclick: () => (forget(), refresh()) }, icon("refresh", 14)),
    h("button", { class: "ghost tool", title: "Board settings", "aria-label": "Settings", onclick: () => openSettings(S.settings, onSettings) }, icon("gear", 14)),
  );
}

/** The top card: the sky (if shown), the date, and the greeting with the day in words. */
function hero(now, day) {
  const sec = S.settings.sections;
  const top = h(
    "div",
    { class: "hero-top" },
    h("div", { class: "date" }, h("span", { class: "dd" }, now.getDate()), h("span", { class: "dm" }, h("span", {}, weekdayName(now)), h("span", { class: "faint" }, `${monthShort(now)}, week ${isoWeek(now)}`))),
    h("span", { class: "spacer" }),
    S.weather &&
      h(
        "button",
        { class: "ghost hero-wx", title: `${S.settings.city.name}: change city`, onclick: () => (cityPicker ? null : openCityPicker()) },
        weatherIcon(S.weather.code, S.weather.isDay, 22),
        h("span", {}, `${Math.round(S.weather.temp)}°`),
        h("span", { class: "hero-city" }, S.settings.city.name),
      ),
    tools(),
  );
  return h(
    "header",
    { class: sec.sky ? "hero card has-sky" : "hero card" },
    sec.sky ? h("div", { class: "sky-wrap" }, skyEl, top) : top,
    sec.summary && letter(day, sec.glance ? glance(now, day, true) : null),
  );
}

function letter(day, aside) {
  let parts = localSummary(day);
  let by = null;
  if (S.settings.summaryBy === "claude") {
    const key = claudeKey(day);
    if (S.claude?.key !== key) askClaude(day, key);
    if (S.claude?.text) parts = [S.claude.text];
    by = S.claude?.loading
      ? h("span", { class: "by" }, h("span", { class: "spinner" }), " Claude is writing")
      : S.claude?.error
        ? h("span", { class: "by error", title: S.claude.error }, "Claude couldn't write it, so this is the plain one")
        : h("span", { class: "by" }, "Written by Claude");
  }
  return h(
    "section",
    { class: aside ? "letter with-aside" : "letter" },
    h(
      "div",
      { class: "letter-text" },
      h("h1", { class: "hello" }, greeting(day.now, S.settings.name)),
      h("p", { class: "story" }, parts.map((p) => (typeof p === "string" ? p : h("strong", {}, p.strong)))),
      by,
    ),
    aside,
  );
}

let claudeAsking = null;
async function askClaude(day, key) {
  if (claudeAsking === key) return;
  claudeAsking = key;
  const stored = await octopus.storage.get("claudeSummary").catch(() => null);
  if (stored?.key === key) {
    S.claude = stored;
    claudeAsking = null;
    return render();
  }
  S.claude = { key, loading: true, text: S.claude?.text };
  try {
    const text = await claudeSummary(day, S.settings.name);
    S.claude = { key, text };
    octopus.storage.set("claudeSummary", S.claude).catch(() => {});
  } catch (e) {
    S.claude = { key, error: e.message };
  }
  claudeAsking = null;
  render();
}

/** Why meetings may be missing or old: no Calendar, turned off, nothing shared yet, feeds failing. */
function calendarNotice() {
  const notice = (tone, text) => h("div", { class: `notice ${tone}` }, icon("calendar", 14), h("span", {}, text));
  if (S.sdkMissing) return notice("error", "This Octopus doesn't let extensions read each other's data yet: meetings need a build with octopus.extensions and octopus.shared.");
  if (S.calendarError) return notice("error", `Couldn't read Calendar: ${S.calendarError}`);
  if (!S.calendar) return notice("warn", "The Calendar extension isn't installed, so only tasks are shown.");
  if (!S.calendar.ok) return notice("error", "The Calendar extension has a broken manifest.");
  if (!S.calendar.enabled) return notice("warn", "The Calendar extension is turned off. Turn it on in Extensions to see your meetings.");
  if (!S.shared) return notice("warn", "Calendar hasn't shared any events yet. Open Calendar once: it shares them as it loads.");
  const errors = S.shared.errors || [];
  if (errors.length) return notice("error", `Some calendars couldn't be refreshed: ${errors.map((e) => `${e.calendar} (${e.error})`).join(", ")}`);
  if (new Date(S.shared.publishedAt) < startOfDay(new Date())) return notice("warn", `Meetings were shared ${ago(S.shared.publishedAt)}. Open Calendar to bring them up to date.`);
  return null;
}

// --- At a glance ------------------------------------------------------------------------------------

function tile(tone, iconName, label, value, sub, action) {
  return h(
    "div",
    { class: `tile tone-${tone}` },
    h("span", { class: "badge-icon" }, icon(iconName, 15)),
    h("div", { class: "tile-text" }, h("span", { class: "tile-label" }, label), h("span", { class: "tile-value", title: value }, value), sub && h("span", { class: "tile-sub" }, sub)),
    action,
  );
}

const joinButton = (e) => e?.meetingLink && h("button", { class: "primary join", title: e.meetingLink, onclick: () => octopus.openUrl(e.meetingLink) }, icon("join", 13), "Join");

/** The day in four facts: the meeting now or next, meetings left, the longest free block, tasks. */
function glance(now, day, beside) {
  const tiles = [];
  if (day.calendar) {
    const live = day.today.filter(attending);
    const current = live.find((e) => e.start <= now && e.end > now);
    const next = live.find((e) => e.start > now);
    if (current) tiles.push(tile("sun", "clock", "Now", current.title, `until ${time(current.end)}`, joinButton(current)));
    else if (next) tiles.push(tile("sun", "clock", "Next meeting", next.title, `${time(next.start)}, ${until(next.start - now)}`, next.start - now < 15 * 60_000 && joinButton(next)));
    else tiles.push(tile("sun", "clock", "Next meeting", "None left", "The rest of the day is free"));

    const ahead = live.filter((e) => e.end > now);
    const busy = ahead.reduce((sum, e) => sum + (e.end - Math.max(+e.start, +now)), 0);
    tiles.push(tile("violet", "people", "Meetings left", ahead.length ? `${ahead.length}` : "0", ahead.length ? `${duration(busy)} in calls` : "Nothing scheduled"));

    const free = longestFree(now, day.today);
    tiles.push(
      free
        ? tile("green", "focus", "Longest free block", duration(free.to - free.from), `${time(free.from)} to ${time(free.to)}`)
        : tile("green", "focus", "Longest free block", "None", now.getHours() >= S.settings.dayEnd ? "The working day is over" : "Back to back until the evening"),
    );
  }
  const doing = day.tasks.filter((t) => t.status === "doing").length;
  const review = day.tasks.filter((t) => t.status === "review").length;
  tiles.push(tile("accent", "check", "In progress", `${doing}`, review ? `${review} waiting for review` : doing ? "Nothing waiting for review" : "Pick something from a board"));
  return h(beside ? "aside" : "section", { class: beside ? "glance beside" : "glance" }, tiles);
}

// --- Panels -------------------------------------------------------------------------------------------

function panel(cls, tone, iconName, title, meta, body, aside) {
  return h(
    "section",
    { class: `panel card ${cls} tone-${tone}` },
    h(
      "header",
      { class: "panel-head" },
      h("span", { class: "badge-icon" }, icon(iconName, 15)),
      h("div", { class: "panel-title" }, h("h2", {}, title), meta && h("span", { class: "panel-meta" }, meta)),
      h("span", { class: "spacer" }),
      aside,
    ),
    h("div", { class: "panel-body" }, body),
  );
}

const empty = (text) => h("p", { class: "empty-note" }, text);

function todayPanel(now) {
  if (!calendarReady()) return panel("today", "sun", "calendar", "Today", null, empty("Meetings show here once Calendar shares them."));
  const list = today();
  const allDay = list.filter((e) => e.allDay);
  const timed = list.filter((e) => !e.allDay);
  const next = timed.find((e) => e.start > now && attending(e));
  const left = timed.filter((e) => e.end > now && attending(e)).length;
  const rows = [];
  let marked = false;
  const nowMark = () => h("li", { class: "now-mark" }, h("span", { class: "rail-dot" }), h("span", {}, `Now, ${time(now)}`));
  for (const e of timed) {
    if (!marked && e.start > now) {
      rows.push(nowMark());
      marked = true;
    }
    rows.push(meetingRow(e, now, e === next));
  }
  if (!marked && timed.length) rows.push(nowMark());
  return panel(
    "today",
    "sun",
    "calendar",
    "Today",
    timed.length ? `${timed.length} meeting${timed.length === 1 ? "" : "s"}, ${left ? `${left} to go` : "all done"}` : "No meetings",
    [
      allDay.length > 0 && h("div", { class: "allday" }, allDay.map((e) => h("span", { class: "chip", title: e.calendar }, e.title))),
      rows.length ? h("ol", { class: "timeline" }, rows) : empty("Nothing on the calendar today. A good day to get deep work done."),
    ],
  );
}

function meetingRow(e, now, next) {
  const past = e.end <= now;
  const current = e.start <= now && e.end > now;
  const cls = ["meeting", past && "past", current && "current", next && "next", e.response === "DECLINED" && "declined", !e.recurring && "oneoff"];
  const where = e.location && !/^https?:/.test(e.location) ? e.location : "";
  return h(
    "li",
    { class: cls.filter(Boolean).join(" "), title: `${e.title}\n${e.calendar}` },
    h("span", { class: "when" }, h("span", {}, time(e.start)), h("span", { class: "len" }, duration(e.end - e.start))),
    h("span", { class: "rail-dot" }),
    h(
      "div",
      { class: "what" },
      h("div", { class: "title" }, e.title),
      h(
        "div",
        { class: "sub" },
        !e.recurring && h("span", { class: "flag oneoff", title: "Not part of a series" }, "One-off"),
        e.response === "NEEDS-ACTION" && h("span", { class: "flag reply", title: "You haven't answered yet" }, "Needs reply"),
        e.response === "TENTATIVE" && h("span", { class: "flag" }, "Maybe"),
        current && h("span", { class: "flag live" }, `Ends ${time(e.end)}`),
        (where || e.organizer?.name) && h("span", { class: "where" }, [where, e.organizer?.name ? `with ${e.organizer.name}` : ""].filter(Boolean).join(", ")),
      ),
    ),
    e.meetingLink && !past && h("button", { class: current || next ? "primary join" : "join", title: e.meetingLink, onclick: () => octopus.openUrl(e.meetingLink) }, icon("join", 13), "Join"),
  );
}

// The city picker keeps its element between renders, so the minute refresh doesn't wipe what's typed.
let cityPicker = null;

function openCityPicker() {
  const input = h("input", { type: "text", placeholder: "Type a city and press Enter", spellcheck: "false", "aria-label": "City" });
  const results = h("div", { class: "city-results" });
  const close = () => {
    cityPicker = null;
    render();
  };
  const pick = (p) => {
    S.settings.city = p;
      S.risen = true;
    saveSettings();
    S.weather = null;
    S.claude = null;
    close();
    loadWeather().then(render);
  };
  const find = async () => {
    const q = input.value.trim();
    if (!q) return;
    results.replaceChildren(h("span", { class: "spinner" }));
    try {
      const places = await findPlaces(q);
      results.replaceChildren(
        ...(places.length
          ? places.map((p) => h("button", { class: "ghost city-option", onclick: () => pick(p) }, h("span", {}, p.name), h("span", { class: "faint" }, [p.admin, p.country].filter(Boolean).join(", "))))
          : [h("span", { class: "faint" }, `No place called “${q}”.`)]),
      );
    } catch (e) {
      results.replaceChildren(h("span", { class: "faint" }, `Couldn't search: ${e.message}`));
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") find();
    if (e.key === "Escape") close();
  });
  cityPicker = h(
    "div",
    { class: "city-picker" },
    h("div", { class: "city-row" }, input, h("button", { onclick: find }, "Find"), h("button", { class: "ghost", onclick: close }, "Cancel")),
    results,
  );
  render();
  input.focus();
  cityPicker.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function weatherPanel(now) {
  const city = S.settings.city.name;
  const change = h("button", { class: "ghost change-city", title: "Show the weather of another city", onclick: () => (cityPicker ? null : openCityPicker()) }, "Change city");
  const panelOf = (body) => panel("weather", "sky", "drop", "Weather", city, [cityPicker, body], change);
  if (S.weatherError) return panelOf(empty(`Couldn't get the weather: ${S.weatherError}`));
  if (!S.weather) return panelOf(h("div", { class: "empty-note" }, h("span", { class: "spinner" })));
  const w = S.weather;
  const hours = w.hourly.filter((x) => x.at > new Date(+now - 3_600_000)).slice(0, 8);
  return panelOf([
      h(
        "div",
        { class: "wx-now" },
        weatherIcon(w.code, w.isDay, 44),
        h("div", { class: "wx-temp" }, h("span", { class: "deg" }, `${Math.round(w.temp)}°`), h("span", { class: "wx-text" }, describe(w.code).text)),
        h(
          "dl",
          { class: "wx-facts" },
          h("dt", {}, "Feels"), h("dd", {}, `${Math.round(w.feels)}°`),
          h("dt", {}, "Range"), h("dd", {}, `${Math.round(w.min)}° to ${Math.round(w.max)}°`),
          h("dt", {}, "Rain"), h("dd", {}, `${w.rain}%`),
          h("dt", {}, "Wind"), h("dd", {}, `${Math.round(w.wind)} km/h`),
        ),
      ),
      h(
        "ol",
        { class: "hours" },
        hours.map((x) =>
          h(
            "li",
            { class: x.at <= now ? "hour-now" : "" },
            h("span", { class: "hh" }, x.at <= now ? "Now" : String(x.at.getHours()).padStart(2, "0")),
            weatherIcon(x.code, x.isDay, 18),
            h("span", { class: "ht" }, `${Math.round(x.temp)}°`),
            h("span", { class: "rain-bar", title: `${x.rain}% chance of rain` }, h("span", { style: { height: `${Math.max(2, x.rain)}%` } })),
          ),
        ),
      ),
    ],
  );
}

function tasksPanel(tasks) {
  if (S.tasksError) return panel("tasks", "accent", "check", "In progress", null, empty(S.tasksError));
  if (!tasks.length) return panel("tasks", "accent", "check", "In progress", "Nothing started", empty("Nothing in progress. Pick something from a board."));
  const byProject = new Map();
  for (const t of tasks) {
    const k = t.projectId || "";
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k).push(t);
  }
  const project = (id) => S.projects.find((p) => p.id === id);
  const groups = [...byProject.entries()].sort(([a], [b]) => (project(a)?.name || "~").localeCompare(project(b)?.name || "~"));
  const review = tasks.filter((t) => t.status === "review").length;
  return panel(
    "tasks",
    "accent",
    "check",
    "In progress",
    `${tasks.length - review} doing${review ? `, ${review} in review` : ""}`,
    groups.map(([id, list]) =>
      h(
        "div",
        { class: "project" },
        h("div", { class: "project-name" }, h("span", { class: "dot", style: { background: project(id)?.color || "var(--fg-faint)" } }), project(id)?.name || "General", h("span", { class: "faint" }, list.length)),
        list.map((t) =>
          h(
            "button",
            { class: "task", title: "Show it on its board", onclick: () => octopus.tasks.reveal(t.id).catch((e) => octopus.toast(e.message, "error")) },
            h("span", { class: `prio p${t.priority}`, title: PRIORITY[t.priority] }),
            h("span", { class: "title" }, t.title),
            t.status === "review" && h("span", { class: "flag reply" }, "Review"),
          ),
        ),
      ),
    ),
  );
}

/** One column per day left in the week: its one-off meetings, and how many regular ones it also has. */
function weekPanel(now, oneOffs) {
  if (!calendarReady()) return panel("week", "violet", "week", "Later this week", null, empty("Meetings show here once Calendar shares them."));
  const days = [];
  for (let d = addDays(startOfDay(now), 1); d < endOfWeek(now); d = addDays(d, 1)) days.push(d);
  if (!days.length) return panel("week", "violet", "week", "Later this week", "One-offs only", empty("The week ends today. Enjoy the weekend."));
  const shown = days.filter((d) => {
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return !weekend || oneOffs.some((e) => +startOfDay(e.start) === +d);
  });
  return panel(
    "week",
    "violet",
    "week",
    "Later this week",
    oneOffs.length ? `${oneOffs.length} one-off meeting${oneOffs.length === 1 ? "" : "s"}; regular ones are left out` : "No one-off meetings; regular ones are left out",
    h(
      "div",
      { class: "days" },
      shown.map((d) => {
        const mine = oneOffs.filter((e) => +startOfDay(e.start) === +d);
        const regular = onDay(d).filter((e) => e.recurring && attending(e) && !e.allDay).length;
        return h(
          "div",
          { class: mine.length ? "day has" : "day" },
          h("div", { class: "day-head" }, h("span", { class: "dn" }, d.getDate()), h("span", { class: "dw" }, weekdayName(d))),
          mine.length
            ? mine.map((e) =>
                h(
                  "div",
                  { class: "week-event", title: `${e.title}\n${e.calendar}` },
                  h("span", { class: "we-time" }, e.allDay ? "All day" : `${time(e.start)}, ${duration(e.end - e.start)}`),
                  h("span", { class: "we-title" }, e.title),
                  e.response === "NEEDS-ACTION" && h("span", { class: "flag reply" }, "Needs reply"),
                ),
              )
            : h("div", { class: "day-free" }, "Nothing special"),
          regular > 0 && h("div", { class: "day-regular" }, `+ ${regular} regular`),
        );
      }),
    ),
  );
}

// --- News -----------------------------------------------------------------------------------------

function newsItems() {
  const ids = shownSources().map((src) => src.id).filter((id) => S.newsTab === "all" || S.newsTab === id);
  const n = S.newsTab === "all" ? S.settings.newsCount : S.settings.newsCount * 3;
  const lists = ids.map((id) => (S.news[id]?.items || []).slice(0, n).map((x) => ({ ...x, source: id })));
  // All: take turns between sources, so each gets a place near the top.
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

function newsPanel() {
  const shown = shownSources();
  const ids = shown.map((src) => src.id);
  if (!ids.length) return null;
  if (S.newsTab !== "all" && !ids.includes(S.newsTab)) S.newsTab = "all";
  const tabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    [["all", "All"], ...shown.map((src) => [src.id, src.name])].map(([id, label]) =>
      h("button", { role: "tab", "aria-selected": String(S.newsTab === id), class: S.newsTab === id ? "tab on" : "tab", onclick: () => ((S.newsTab = id), render()) }, label),
    ),
  );
  const loading = S.newsLoading || ids.some((id) => !S.news[id]);
  const errors = ids.filter((id) => S.news[id]?.error && (S.newsTab === "all" || S.newsTab === id));
  const items = newsItems();
  const actions = h(
    "div",
    { class: "panel-tools" },
    h("button", { class: "ghost tool", title: "Read all the news, newspaper style", "aria-label": "Open the newspaper", onclick: () => openNews(newsItems()[0]?.link) }, icon("book", 14)),
    h("button", { class: "ghost tool", title: "Add a news source", "aria-label": "Add a source", onclick: () => openSettings(S.settings, onSettings, { focus: "feed" }) }, icon("plus", 14)),
    h("button", { class: "ghost tool", title: "Read the feeds again", "aria-label": "Refresh the news", disabled: S.newsLoading, onclick: refreshNews }, S.newsLoading ? h("span", { class: "spinner" }) : icon("refresh", 14)),
  );
  return panel(
    "news",
    "green",
    "news",
    "News",
    loading ? "Loading…" : null,
    [
      tabs,
      errors.map((id) => h("p", { class: "empty-note" }, `${sourceOf(id).name}: couldn't load it (${S.news[id].error}).`)),
      items.length ? h("div", { class: "stories" }, items.map((x, i) => story(x, i === 0))) : !loading && !errors.length && empty("No headlines right now."),
    ],
    actions,
  );
}

function story(x, lead) {
  const name = sourceOf(x.source)?.name || "";
  const ready = imageNow(x);
  const pic = h("div", { class: `pic src-${x.source}` }, ready ? h("img", { src: ready, alt: "" }) : h("span", { class: "pic-mark" }, x.source === "hn" ? x.domain : name));
  if (!ready && x.source !== "hn") {
    imageOf(x).then((url) => {
      if (!url || !pic.isConnected) return;
      const img = h("img", { src: url, alt: "", class: "arrive" });
      pic.replaceChildren(img);
    });
  }
  return h(
    "a",
    { class: lead ? "story-card lead" : "story-card", href: x.link, title: "Read it in the newspaper", onclick: (e) => (e.preventDefault(), openNews(x.link)) },
    pic,
    h(
      "div",
      { class: "story-text" },
      h("span", { class: "story-src" }, h("span", { class: `src-dot src-${x.source}` }), name, x.at && !isNaN(x.at) && h("span", { class: "faint" }, ago(x.at))),
      h("span", { class: "story-title" }, x.title),
      x.meta && h("span", { class: "story-meta" }, x.meta),
    ),
  );
}

// --- Copy -----------------------------------------------------------------------------------------

function copyMarkdown() {
  const now = new Date();
  const day = dayData(now);
  const plain = (parts) => parts.map((p) => (typeof p === "string" ? p : `**${p.strong}**`)).join("").trim();
  const name = (id) => S.projects.find((p) => p.id === id)?.name || "General";
  const lines = [`## ${longDate(now)}`, "", S.claude?.text && S.settings.summaryBy === "claude" ? S.claude.text : plain(localSummary(day)), "", "### In progress"];
  lines.push(...(day.tasks.length ? day.tasks.map((t) => `- ${t.status === "review" ? "[review] " : ""}${t.title} (${name(t.projectId)})`) : ["- Nothing in progress"]));
  if (day.calendar) {
    const ahead = today().filter((e) => e.end > now && attending(e));
    lines.push("", "### Today", ...(ahead.length ? ahead.map((e) => `- ${e.allDay ? "all day" : time(e.start)} ${e.title}${e.recurring ? "" : " (one-off)"}`) : ["- No meetings left"]));
    lines.push("", "### Later this week", ...(day.week.length ? day.week.map((e) => `- ${weekdayName(e.start)}, ${e.allDay ? "all day" : time(e.start)}: ${e.title}`) : ["- Nothing out of the ordinary"]));
  }
  octopus.copy(lines.join("\n"));
  octopus.toast("Copied the day as Markdown", "success");
}

// --- Start ----------------------------------------------------------------------------------------

function onSettings(settings) {
  S.settings = settings;
  render();
  Promise.all([loadWeather(), loadNews()]).then(render);
}

await octopus.ready();
S.settings = await loadSettings();
S.skyOpen = !!(await octopus.storage.get("skyOpen").catch(() => false));
await refresh();

octopus.on("visible", (shown) => shown && refresh());
octopus.on("shared", ({ extension, key }) => extension === CALENDAR && key === "events" && loadCalendar().then(render));
octopus.on("extensions", () => loadCalendar().then(render));
octopus.on("projects", () => refresh());
reducedMotion.addEventListener("change", render);
let width = app.clientWidth;
new ResizeObserver(() => {
  if (app.clientWidth === width) return; // only the width moves the sky; heights change with every render
  width = app.clientWidth;
  if (skyEl?.isConnected) render();
}).observe(app);
// The sun moves, meetings pass, tasks change on their boards.
setInterval(() => refresh(), 60_000);
