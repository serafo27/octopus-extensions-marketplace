// Date helpers. Everything the views handle is a local Date; ICS times are converted on parse.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addMonths(d, n) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
  return x;
}

export function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

export function startOfWeek(d, weekStart = 1) {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStart + 7) % 7;
  return addDays(x, -diff);
}

export function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Minutes since local midnight. */
export function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

export function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

/** "2026-10-12" for <input type=date>. */
export function toDateInput(d) {
  return dayKey(d);
}

/** "09:30" for <input type=time>. */
export function toTimeInput(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputs(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = (time || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
}

const fmtCache = new Map();
function fmt(opts) {
  const key = JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(undefined, opts));
  return fmtCache.get(key);
}

export const format = {
  time: (d) => fmt({ hour: "numeric", minute: "2-digit" }).format(d),
  hour: (h) => fmt({ hour: "numeric" }).format(new Date(2000, 0, 1, h)),
  weekdayShort: (d) => fmt({ weekday: "short" }).format(d),
  weekdayNarrow: (d) => fmt({ weekday: "narrow" }).format(d),
  monthYear: (d) => fmt({ month: "long", year: "numeric" }).format(d),
  monthShort: (d) => fmt({ month: "short" }).format(d),
  dayShort: (d) => fmt({ weekday: "short", month: "short", day: "numeric" }).format(d),
  dayMonth: (d) => fmt({ day: "numeric", month: "short" }).format(d),
  long: (d) => fmt({ weekday: "long", day: "numeric", month: "long" }).format(d),
  full: (d) => fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d),
};

export function formatRange(start, end, allDay) {
  if (allDay) {
    const last = addDays(end, -1);
    return sameDay(start, last) ? format.long(start) : `${format.dayMonth(start)} – ${format.dayMonth(last)}`;
  }
  if (sameDay(start, end)) return `${format.long(start)} · ${format.time(start)} – ${format.time(end)}`;
  return `${format.dayMonth(start)} ${format.time(start)} – ${format.dayMonth(end)} ${format.time(end)}`;
}

export function formatDuration(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// --- Time zones -------------------------------------------------------------------------------

const WINDOWS_ZONES = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Singapore Standard Time": "Asia/Singapore",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
};

const zoneOk = new Map();
export function normalizeZone(tz) {
  if (!tz) return null;
  tz = tz.replace(/^"|"$/g, "").replace(/^\/[^/]+\/[^/]+\//, ""); // strip "/mozilla.org/20050126_1/" prefixes
  if (WINDOWS_ZONES[tz]) tz = WINDOWS_ZONES[tz];
  if (!zoneOk.has(tz)) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      zoneOk.set(tz, true);
    } catch {
      zoneOk.set(tz, false);
    }
  }
  return zoneOk.get(tz) ? tz : null;
}

const partsFmt = new Map();
function zoneOffset(ts, tz) {
  if (!partsFmt.has(tz)) {
    partsFmt.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  }
  const p = {};
  for (const { type, value } of partsFmt.get(tz).formatToParts(new Date(ts))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** The instant of a wall-clock time in a zone (null zone: local time). */
export function zonedTime(y, mo, d, h, mi, s, tz) {
  if (!tz) return new Date(y, mo, d, h, mi, s);
  if (tz === "UTC") return new Date(Date.UTC(y, mo, d, h, mi, s));
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let ts = guess - zoneOffset(guess, tz);
  ts = guess - zoneOffset(ts, tz);
  return new Date(ts);
}
