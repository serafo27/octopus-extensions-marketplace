// iCalendar (RFC 5545): parse a feed into event series, expand them into occurrences for a range.

import { zonedTime, normalizeZone, DAY } from "./dates.js";

/** Splits a feed into { name, color, events } where each event is a series (maybe recurring). */
export function parseICS(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const cal = { name: null, color: null, tz: null, events: [] };
  let ev = null;
  let depth = []; // component stack
  for (const raw of lines) {
    if (!raw) continue;
    const prop = parseLine(raw);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      depth.push(prop.value.toUpperCase());
      if (prop.value.toUpperCase() === "VEVENT") ev = { attendees: [], exdates: [], rdates: [] };
      continue;
    }
    if (prop.name === "END") {
      const comp = depth.pop();
      if (comp === "VEVENT" && ev) {
        const done = finishEvent(ev, cal.tz);
        if (done) cal.events.push(done);
        ev = null;
      }
      continue;
    }
    const inside = depth[depth.length - 1];
    if (inside === "VCALENDAR") {
      if (prop.name === "X-WR-CALNAME") cal.name = unescapeText(prop.value);
      else if (prop.name === "X-WR-TIMEZONE") cal.tz = normalizeZone(prop.value);
      else if (prop.name === "X-APPLE-CALENDAR-COLOR") cal.color = prop.value;
    } else if (inside === "VEVENT" && ev) {
      readEventProp(ev, prop);
    }
  }
  return cal;
}

function parseLine(line) {
  // NAME;P=v;P="a:b":value
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = splitOutsideQuotes(head, ";");
  const name = parts[0].toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

function splitOutsideQuotes(s, sep) {
  const out = [];
  let cur = "";
  let q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    if (c === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function unescapeText(v) {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function readEventProp(ev, { name, params, value }) {
  switch (name) {
    case "UID":
      ev.uid = value;
      break;
    case "SUMMARY":
      ev.summary = unescapeText(value);
      break;
    case "DESCRIPTION":
      ev.description = unescapeText(value);
      break;
    case "LOCATION":
      ev.location = unescapeText(value);
      break;
    case "URL":
      ev.url = value;
      break;
    case "STATUS":
      ev.status = value.toUpperCase();
      break;
    case "TRANSP":
      ev.transparent = value.toUpperCase() === "TRANSPARENT";
      break;
    case "DTSTART":
      ev.dtstart = { value, params };
      break;
    case "DTEND":
      ev.dtend = { value, params };
      break;
    case "DURATION":
      ev.duration = parseDuration(value);
      break;
    case "RRULE":
      ev.rrule = parseRRule(value);
      break;
    case "EXDATE":
      for (const v of value.split(",")) ev.exdates.push({ value: v, params });
      break;
    case "RDATE":
      for (const v of value.split(",")) ev.rdates.push({ value: v, params });
      break;
    case "RECURRENCE-ID":
      ev.recurrenceId = { value, params };
      break;
    case "ORGANIZER":
      ev.organizer = { name: params.CN ? unescapeText(params.CN) : null, email: value.replace(/^mailto:/i, "") };
      break;
    case "ATTENDEE":
      ev.attendees.push({
        name: params.CN ? unescapeText(params.CN) : null,
        email: value.replace(/^mailto:/i, ""),
        status: params.PARTSTAT || null,
      });
      break;
    case "X-GOOGLE-CONFERENCE":
      ev.conference = value;
      break;
  }
}

/** A DATE or DATE-TIME property: { date, allDay, wall: {y,mo,d,h,mi,s}, tz } */
function parseDateProp(p, defaultTz) {
  if (!p) return null;
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const wall = { y: +y, mo: +mo - 1, d: +d, h: +(h || 0), mi: +(mi || 0), s: +(s || 0) };
  if (!h || p.params.VALUE === "DATE") {
    return { date: new Date(wall.y, wall.mo, wall.d), allDay: true, wall, tz: null };
  }
  const tz = z ? "UTC" : normalizeZone(p.params.TZID) || defaultTz || null;
  return { date: zonedTime(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, tz), allDay: false, wall, tz };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return { ms: sign === "-" ? -ms : ms, days: (+w || 0) * 7 + (+d || 0), timeOnly: !w && !d };
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function parseRRule(v) {
  const r = {};
  for (const part of v.split(";")) {
    const [k, val] = part.split("=");
    if (!k || val == null) continue;
    r[k.toUpperCase()] = val;
  }
  const rule = {
    freq: r.FREQ,
    interval: Math.max(1, parseInt(r.INTERVAL || "1", 10)),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL || null,
    byday: r.BYDAY
      ? r.BYDAY.split(",").map((s) => {
          const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(s.trim());
          return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WEEKDAYS.indexOf(m[2]) } : null;
        }).filter((x) => x && x.wd >= 0)
      : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(",").map((x) => Number(x) - 1) : null,
    bysetpos: r.BYSETPOS ? r.BYSETPOS.split(",").map(Number) : null,
    wkst: r.WKST ? WEEKDAYS.indexOf(r.WKST) : 1,
  };
  return rule.freq ? rule : null;
}

function finishEvent(ev, calTz) {
  const start = parseDateProp(ev.dtstart, calTz);
  if (!start) return null;
  let durationMs;
  let durationDays = 0;
  const end = parseDateProp(ev.dtend, calTz);
  if (end) {
    durationMs = end.date - start.date;
    if (start.allDay) durationDays = Math.max(1, Math.round(durationMs / DAY));
  } else if (ev.duration) {
    durationMs = ev.duration.ms;
    durationDays = start.allDay ? Math.max(1, ev.duration.days) : 0;
  } else {
    durationMs = start.allDay ? DAY : 0;
    durationDays = start.allDay ? 1 : 0;
  }
  const rule = ev.rrule;
  if (rule?.until) {
    const u = parseDateProp({ value: rule.until, params: {} }, start.tz);
    rule.untilTs = u ? (u.allDay ? +u.date + DAY - 1 : +u.date) : null;
  }
  const exKeys = new Set();
  for (const ex of ev.exdates) {
    const p = parseDateProp(ex, start.tz || calTz);
    if (p) exKeys.add(occKey(p.date, start.allDay));
  }
  const rec = parseDateProp(ev.recurrenceId, start.tz || calTz);
  return {
    uid: ev.uid || `${ev.summary}-${ev.dtstart.value}`,
    title: ev.summary || "(No title)",
    description: ev.description || "",
    location: ev.location || "",
    url: ev.url || "",
    conference: ev.conference || "",
    status: ev.status || "CONFIRMED",
    transparent: !!ev.transparent,
    organizer: ev.organizer || null,
    attendees: ev.attendees,
    allDay: start.allDay,
    start,
    durationMs: Math.max(0, durationMs),
    durationDays,
    rule,
    exKeys,
    rdates: ev.rdates.map((r) => parseDateProp(r, start.tz || calTz)).filter(Boolean),
    recurrenceKey: rec ? occKey(rec.date, start.allDay || rec.allDay) : null,
  };
}

/** Exclusion and override matching: all-day by date, timed by instant. */
function occKey(date, allDay) {
  return allDay ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : String(+date);
}

/**
 * Occurrences of the given series that overlap [from, to): { key, uid, title, start, end, allDay, ... }.
 */
export function expand(series, from, to) {
  const overrides = new Map(); // uid -> Set of overridden keys
  for (const s of series) {
    if (s.recurrenceKey) {
      if (!overrides.has(s.uid)) overrides.set(s.uid, new Set());
      overrides.get(s.uid).add(s.recurrenceKey);
    }
  }
  const out = [];
  for (const s of series) {
    if (s.status === "CANCELLED") continue;
    if (!s.rule && !s.rdates.length || s.recurrenceKey) {
      pushIfOverlaps(out, s, s.start.date, from, to);
      continue;
    }
    const skip = overrides.get(s.uid);
    const seen = new Set();
    const emit = (date) => {
      const k = occKey(date, s.allDay);
      if (seen.has(k)) return;
      seen.add(k);
      if (s.exKeys.has(k) || skip?.has(k)) return;
      pushIfOverlaps(out, s, date, from, to);
    };
    if (s.rule) for (const d of occurrences(s, from, to)) emit(d);
    for (const r of s.rdates) emit(r.date);
  }
  return out;
}

function pushIfOverlaps(out, s, start, from, to) {
  const end = s.allDay
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + (s.durationDays || 1))
    : new Date(+start + s.durationMs);
  const endForOverlap = +end === +start ? +start + 1 : +end;
  if (endForOverlap <= +from || +start >= +to) return;
  out.push({
    key: `${s.uid}|${+start}`,
    uid: s.uid,
    title: s.title,
    description: s.description,
    location: s.location,
    url: s.url,
    conference: s.conference,
    organizer: s.organizer,
    attendees: s.attendees,
    transparent: s.transparent,
    recurring: !!s.rule || !!s.recurrenceKey || s.rdates.length > 0, // a moved occurrence is still part of its series
    allDay: s.allDay,
    start,
    end,
  });
}

/** Start dates of a recurring series, in order, until `to` (or COUNT/UNTIL). */
function* occurrences(s, from, to) {
  const { rule, start } = s;
  const w = start.wall;
  const toTs = +to;
  const mk = (y, mo, d) =>
    s.allDay ? new Date(y, mo, d) : zonedTime(y, mo, d, w.h, w.mi, w.s, start.tz);
  let count = 0;
  const startTs = +start.date;
  const startDayUtc = Date.UTC(w.y, w.mo, w.d);
  // Without COUNT, days long before the range needn't be built (zone conversion is the slow part).
  const skipBefore = rule.count == null ? +from - Math.max(s.durationMs, (s.durationDays || 1) * DAY) - 2 * DAY : -Infinity;
  // Candidate wall dates (as UTC day numbers) per period, filtered and limited.
  for (let period = 0; period < 50000; period++) {
    const days = periodDays(rule, w, startDayUtc, period);
    if (days === null) return;
    let pastEnd = false;
    for (const dayUtc of days) {
      if (dayUtc < startDayUtc || dayUtc < skipBefore) continue;
      const dt = new Date(dayUtc);
      const date = mk(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
      if (+date < startTs) continue;
      if (rule.untilTs != null && +date > rule.untilTs) return;
      if (rule.count != null && count >= rule.count) return;
      if (+date >= toTs) {
        pastEnd = true;
        break;
      }
      count++;
      yield date;
    }
    if (pastEnd) return;
  }
}

/** Sorted UTC day numbers for the n-th period of the rule (null when the rule can't be expanded). */
function periodDays(rule, w, startDayUtc, n) {
  const step = rule.interval * n;
  const filterMonth = (list) => (rule.bymonth ? list.filter((d) => rule.bymonth.includes(new Date(d).getUTCMonth())) : list);
  switch (rule.freq) {
    case "DAILY": {
      const d = startDayUtc + step * DAY;
      const dt = new Date(d);
      if (rule.byday && !rule.byday.some((b) => b.wd === dt.getUTCDay())) return [];
      if (rule.bymonthday && !rule.bymonthday.includes(dt.getUTCDate())) return [];
      return filterMonth([d]);
    }
    case "WEEKLY": {
      const wd = new Date(startDayUtc).getUTCDay();
      const weekStart = startDayUtc - ((wd - rule.wkst + 7) % 7) * DAY + step * 7 * DAY;
      const wanted = rule.byday ? rule.byday.map((b) => b.wd) : [wd];
      const days = wanted.map((x) => weekStart + ((x - rule.wkst + 7) % 7) * DAY).sort((a, b) => a - b);
      return filterMonth(days);
    }
    case "MONTHLY": {
      const y = w.y + Math.floor((w.mo + step) / 12);
      const mo = (w.mo + step) % 12;
      return applySetPos(rule, monthDays(rule, y, mo, w.d));
    }
    case "YEARLY": {
      const y = w.y + step;
      const months = rule.bymonth || [w.mo];
      const all = [];
      for (const mo of months) {
        if (rule.byday || rule.bymonthday) all.push(...monthDays(rule, y, mo, w.d));
        else if (w.d <= new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()) all.push(Date.UTC(y, mo, w.d));
      }
      return applySetPos(rule, all.sort((a, b) => a - b));
    }
    default:
      return null;
  }
}

function monthDays(rule, y, mo, defaultDay) {
  const len = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  let days = [];
  if (rule.bymonthday) {
    for (const md of rule.bymonthday) {
      const d = md > 0 ? md : len + md + 1;
      if (d >= 1 && d <= len) days.push(Date.UTC(y, mo, d));
    }
  }
  if (rule.byday) {
    const byday = [];
    for (const { n, wd } of rule.byday) {
      const matches = [];
      for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === wd) matches.push(Date.UTC(y, mo, d));
      if (n === 0) byday.push(...matches);
      else {
        const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
        if (pick != null) byday.push(pick);
      }
    }
    days = rule.bymonthday ? days.filter((d) => byday.includes(d)) : byday;
  }
  if (!rule.bymonthday && !rule.byday && defaultDay <= len) days.push(Date.UTC(y, mo, defaultDay));
  return [...new Set(days)].sort((a, b) => a - b);
}

function applySetPos(rule, days) {
  if (!rule.bysetpos) return days;
  const out = [];
  for (const p of rule.bysetpos) {
    const d = p > 0 ? days[p - 1] : days[days.length + p];
    if (d != null) out.push(d);
  }
  return out.sort((a, b) => a - b);
}
