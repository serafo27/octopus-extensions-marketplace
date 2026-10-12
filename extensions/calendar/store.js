// State, persistence, calendar sources (local events and ICS feeds) and the occurrences the views draw.

import { parseICS, expand } from "./ics.js";
import { DAY, startOfDay } from "./dates.js";

/** Calendar colours: theme variables, so they follow Octopus's light and dark themes. */
export const PALETTE = [
  "var(--accent)",
  "var(--hl-keyword, var(--accent))",
  "var(--hl-string, var(--warn))",
  "var(--hl-function, var(--warn))",
  "var(--hl-type, var(--success))",
  "var(--hl-number, var(--success))",
  "var(--success)",
  "var(--warn)",
  "var(--error)",
  "var(--link)",
];
export const colorOf = (cal) => PALETTE[(cal?.color ?? 0) % PALETTE.length];

export const S = {
  view: "week", // day | week | month | agenda
  cursor: startOfDay(new Date()),
  miniCursor: startOfDay(new Date()),
  accounts: [], // [{ id, name, kind: "local" | "ics", calendars: [{ id, name, color, visible, url }] }]
  local: [], // [{ id, calendarId, title, start, end, allDay, location, description, repeat }]
  feeds: new Map(), // calendarId -> { series, status: "loading" | "ok" | "error", error, fetchedAt }
  settings: { weekStart: 1, hideWeekends: false, hideDeclined: false, hourHeight: 48, defaultDuration: 60, notify: true },
  query: "",
};

let renderFn = () => {};
export function onRender(fn) {
  renderFn = fn;
}
export function rerender() {
  renderFn();
  publishSoon();
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// --- Persistence ------------------------------------------------------------------------------

function defaultAccounts() {
  return [
    {
      id: "local",
      name: "On this Mac",
      kind: "local",
      calendars: [{ id: "personal", name: "Personal", color: 0, visible: true }],
    },
  ];
}

export async function load() {
  const [accounts, local, settings, ui] = await Promise.all([
    octopus.storage.get("accounts"),
    octopus.storage.get("localEvents"),
    octopus.storage.get("settings"),
    octopus.storage.get("ui"),
  ]);
  S.accounts = accounts?.length ? accounts : defaultAccounts();
  S.local = local || [];
  Object.assign(S.settings, settings || {});
  if (ui?.view) S.view = ui.view;
  await Promise.all(
    icsCalendars().map(async ({ cal }) => {
      const cached = await octopus.storage.get(`ics:${cal.id}`);
      if (cached?.text) setFeed(cal, cached.text, cached.at);
    }),
  );
}

// Octopus saves a key by rewriting this extension's whole storage file through one temp file, so two
// saves at once can fail or lose each other's data. Every write goes through this queue, one at a time;
// a key saved again while still waiting is written once, with its latest value.
let writes = Promise.resolve();
const waiting = new Map();
function persist(key, value) {
  const queued = waiting.has(key);
  waiting.set(key, value);
  if (queued) return writes;
  writes = writes
    .then(() => {
      const v = waiting.get(key);
      waiting.delete(key);
      return octopus.storage.set(key, v);
    })
    .catch((e) => octopus.toast(`Couldn't save the calendar's data: ${e.message}`, "error"));
  return writes;
}

export const saveAccounts = () => persist("accounts", S.accounts);
export const saveLocal = () => persist("localEvents", S.local);
export const saveSettings = () => persist("settings", S.settings);
export const saveUi = () => persist("ui", { view: S.view });

// The offline copy of a feed: only what can still be shown (recent, future or repeating events), and
// rewritten only when the feed changed. Big work calendars are mostly years of past meetings.
const CACHE_KEEP_DAYS = 120;
const CACHE_MAX = 4 * 1024 * 1024;
const cachedSig = new Map();

function trimFeed(text) {
  const cutoff = new Date(Date.now() - CACHE_KEEP_DAYS * DAY);
  const min = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, "0")}${String(cutoff.getDate()).padStart(2, "0")}`;
  const date = (re, block) => re.exec(block)?.[1] ?? null;
  return text.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n?/g, (block) => {
    const unfolded = block.replace(/\r?\n[ \t]/g, "");
    if (/\nRRULE[:;]/.test(unfolded)) {
      const until = date(/\nRRULE[:;][^\n]*UNTIL=(\d{8})/, unfolded);
      return !until || until >= min ? block : ""; // a series that ended long ago
    }
    if (/\nRDATE[:;]/.test(unfolded)) return block;
    const end = date(/\nDTEND[^:\n]*:(\d{8})/, unfolded) || date(/\nDTSTART[^:\n]*:(\d{8})/, unfolded);
    const was = date(/\nRECURRENCE-ID[^:\n]*:(\d{8})/, unfolded); // a moved occurrence: old on both ends?
    return !end || end >= min || (was && was >= min) ? block : "";
  });
}

function cacheFeed(cal, text) {
  const trimmed = trimFeed(text);
  const sig = `${trimmed.length}:${hash(trimmed)}`;
  if (cachedSig.get(cal.id) === sig) return;
  cachedSig.set(cal.id, sig);
  persist(`ics:${cal.id}`, trimmed.length <= CACHE_MAX ? { text: trimmed, at: Date.now() } : null);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 7) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// --- Calendars --------------------------------------------------------------------------------

export function allCalendars() {
  return S.accounts.flatMap((account) => account.calendars.map((cal) => ({ account, cal })));
}
export const icsCalendars = () => allCalendars().filter((x) => x.account.kind === "ics");
export const localCalendars = () => allCalendars().filter((x) => x.account.kind === "local");
export const findCalendar = (id) => allCalendars().find((x) => x.cal.id === id) || null;

export function addLocalCalendar(name) {
  const account = S.accounts.find((a) => a.kind === "local");
  const cal = { id: uid(), name, color: nextColor(), visible: true };
  account.calendars.push(cal);
  saveAccounts();
  return cal;
}

export function nextColor() {
  const used = allCalendars().map((x) => x.cal.color);
  for (let i = 0; i < PALETTE.length; i++) if (!used.includes(i)) return i;
  return used.length % PALETTE.length;
}

/** Adds a feed under an account (created by name when new). Fetches it first: throws when unreachable. */
export async function addFeed({ accountName, url, name, color }) {
  url = normalizeUrl(url);
  const dup = icsCalendars().find((x) => x.cal.url === url);
  if (dup) throw new Error(`Already added, as “${dup.cal.name}” in ${dup.account.name}.`);
  const text = await fetchFeed(url);
  const parsed = parseICS(text);
  if (!parsed.events.length && !/BEGIN:VCALENDAR/i.test(text)) throw new Error("This address doesn't return an iCalendar (.ics) feed.");
  let account = S.accounts.find((a) => a.kind === "ics" && a.name.toLowerCase() === accountName.trim().toLowerCase());
  if (!account) {
    account = { id: uid(), name: accountName.trim(), kind: "ics", calendars: [] };
    S.accounts.push(account);
  }
  const cal = { id: uid(), name: name?.trim() || parsed.name || "Calendar", color, visible: true, url };
  account.calendars.push(cal);
  setFeed(cal, text, Date.now());
  saveAccounts();
  cacheFeed(cal, text);
  return cal;
}

export function removeCalendar(id) {
  for (const a of S.accounts) a.calendars = a.calendars.filter((c) => c.id !== id);
  S.accounts = S.accounts.filter((a) => a.kind === "local" || a.calendars.length);
  S.local = S.local.filter((e) => e.calendarId !== id);
  S.feeds.delete(id);
  cachedSig.delete(id);
  persist(`ics:${id}`, null);
  saveAccounts();
  saveLocal();
}

function normalizeUrl(url) {
  url = url.trim();
  if (url.startsWith("webcal://")) url = "https://" + url.slice(9);
  return url;
}

async function fetchFeed(url) {
  let res;
  try {
    res = await octopus.http.fetch(url, { timeoutMs: 45000, headers: { Accept: "text/calendar, */*" } });
  } catch (e) {
    if (/permissions\.http|can reach/.test(e.message)) {
      const host = new URL(url).host;
      const err = new Error(`${host} isn't allowed yet. Ask Claude, in the terminal beside this calendar, to allow https://${host}.`);
      err.host = host;
      throw err;
    }
    throw e;
  }
  if (!res.ok) throw new Error(res.status === 404 ? "Calendar not found (404): is the secret address still valid?" : `HTTP ${res.status}`);
  return res.text();
}

function setFeed(cal, text, at) {
  try {
    const parsed = parseICS(text);
    S.feeds.set(cal.id, { series: parsed.events, status: "ok", fetchedAt: at });
  } catch (e) {
    S.feeds.set(cal.id, { series: [], status: "error", error: `Can't read the feed: ${e.message}` });
  }
}

export async function refreshFeed(cal) {
  const prev = S.feeds.get(cal.id);
  S.feeds.set(cal.id, { ...(prev || { series: [] }), status: "loading" });
  rerender();
  try {
    const text = await fetchFeed(cal.url);
    setFeed(cal, text, Date.now());
    cacheFeed(cal, text);
  } catch (e) {
    S.feeds.set(cal.id, { ...(prev || { series: [] }), status: "error", error: e.message });
  }
  rerender();
}

export const refreshAll = () => Promise.all(icsCalendars().map(({ cal }) => refreshFeed(cal)));

// --- Local events -----------------------------------------------------------------------------

export function upsertLocal(ev) {
  const i = S.local.findIndex((e) => e.id === ev.id);
  if (i >= 0) S.local[i] = ev;
  else S.local.push(ev);
  saveLocal();
}

export function deleteLocal(id) {
  S.local = S.local.filter((e) => e.id !== id);
  saveLocal();
}

/** A local event as an ICS-like series, so repeats expand the same way feeds do. */
function localSeries(e) {
  const d = new Date(e.start);
  return {
    uid: e.id,
    title: e.title || "(No title)",
    description: e.description || "",
    location: e.location || "",
    url: "",
    conference: "",
    status: "CONFIRMED",
    organizer: null,
    attendees: [],
    allDay: !!e.allDay,
    start: {
      date: d,
      allDay: !!e.allDay,
      tz: null,
      wall: { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: 0 },
    },
    durationMs: e.end - e.start,
    durationDays: e.allDay ? Math.max(1, Math.round((e.end - e.start) / DAY)) : 0,
    rule: e.repeat ? { freq: e.repeat, interval: 1, count: null, wkst: 1, byday: null, bymonthday: null, bymonth: null, bysetpos: null } : null,
    exKeys: new Set(),
    rdates: [],
    recurrenceKey: null,
  };
}

// --- Occurrences ------------------------------------------------------------------------------

/** Every visible occurrence overlapping [from, to), sorted, each with its calendar and account. */
export function occurrencesIn(from, to, { all = false, search = true } = {}) {
  const out = [];
  for (const { account, cal } of allCalendars()) {
    if (!cal.visible && !all) continue;
    const me = account.name.toLowerCase();
    let series;
    if (account.kind === "local") series = S.local.filter((e) => e.calendarId === cal.id).map(localSeries);
    else series = S.feeds.get(cal.id)?.series || [];
    for (const o of expand(series, from, to)) {
      const mine = o.attendees?.find((a) => a.email?.toLowerCase() === me)?.status || null;
      if (mine === "DECLINED" && S.settings.hideDeclined) continue;
      out.push({
        response: mine, // ACCEPTED | DECLINED | TENTATIVE | NEEDS-ACTION, when the account name is an attendee's email
        ...o,
        key: `${cal.id}|${o.key}`,
        id: account.kind === "local" ? o.uid : null,
        editable: account.kind === "local",
        cal,
        account,
        color: colorOf(cal),
      });
    }
  }
  const q = search ? S.query.trim().toLowerCase() : "";
  const filtered = q
    ? out.filter((o) => `${o.title} ${o.location} ${o.description} ${o.cal.name}`.toLowerCase().includes(q))
    : out;
  return filtered.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.title.localeCompare(b.title));
}

/** A video call link in the event, if any (Meet, Zoom, Teams, Webex). */
export function meetingLink(o) {
  const hay = `${o.conference || ""} ${o.location || ""} ${o.url || ""} ${o.description || ""}`;
  const m = /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|[\w.-]*zoom\.us\/[^\s"<>]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+|teams\.live\.com\/meet\/[^\s"<>]+|[\w.-]*webex\.com\/[^\s"<>]+)/i.exec(hay);
  return m ? m[0].replace(/[).,;>]+$/, "") : null;
}

// --- Shared with other extensions ---------------------------------------------------------------

// The next two weeks of the visible calendars, for extensions allowed to read them (Daily's morning
// check): `octopus.shared.get("calendar", "events")`. Written only when they change.
const SHARE_DAYS = 14;
let publishTimer = null;
let publishedSig = "";

function publishSoon() {
  if (!octopus.shared) return; // an Octopus without shared data
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publish, 1500);
}

function publish() {
  if ([...S.feeds.values()].some((f) => f.status === "loading")) return publishSoon();
  const from = startOfDay(new Date());
  const to = new Date(+from + SHARE_DAYS * DAY);
  const events = occurrencesIn(from, to, { search: false }).map((o) => ({
    id: o.key,
    title: o.title,
    start: o.start.toISOString(),
    end: o.end.toISOString(),
    allDay: !!o.allDay,
    recurring: !!o.recurring,
    location: o.location || "",
    meetingLink: meetingLink(o),
    organizer: o.organizer || null,
    attendees: o.attendees?.length || 0,
    response: o.response, // ACCEPTED | DECLINED | TENTATIVE | NEEDS-ACTION | null
    free: !!o.transparent, // shown as free (TRANSP:TRANSPARENT)
    calendar: o.cal.name,
    account: o.account.name,
  }));
  const errors = [...S.feeds.entries()].filter(([, f]) => f.status === "error").map(([id, f]) => ({ calendar: findCalendar(id)?.cal.name ?? id, error: f.error }));
  const sig = JSON.stringify([+from, events, errors]);
  if (sig === publishedSig) return;
  publishedSig = sig;
  octopus.shared
    .set("events", { from: from.toISOString(), to: to.toISOString(), publishedAt: new Date().toISOString(), events, errors })
    .catch((e) => console.warn("Couldn't share the calendar's events", e));
}
