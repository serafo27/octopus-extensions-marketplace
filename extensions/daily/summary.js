// The words at the top: a greeting and a short paragraph about the day. Written here at once; when the
// settings ask for it, Claude writes a warmer one, kept for the day until what it talks about changes.

import { describe } from "./services.js";

export function greeting(now, name) {
  const h = now.getHours();
  const who = name ? `, ${name}` : "";
  if (h >= 4 && h < 12) return `Good morning${who}.`;
  if (h >= 12 && h < 18) return `Good afternoon${who}.`;
  if (h >= 18 && h < 23) return `Good evening${who}.`;
  return `Still up${who}?`;
}

const time = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayName = (d) => d.toLocaleDateString([], { weekday: "long" });

function duration(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60}` : `${h} hour${h > 1 ? "s" : ""}`;
}

function list(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The day in a few sentences, as an array of parts: strings and `{ strong }` for the names worth seeing.
 * `day`: { now, today (timed meetings), week (one-offs later this week), tasks, weather, city, calendar }.
 */
export function localSummary(day) {
  const { now, today, week, tasks, weather, city, calendar } = day;
  const out = [];
  const say = (...parts) => out.push(...parts, " ");

  if (calendar) {
    const live = today.filter((e) => e.response !== "DECLINED");
    const current = live.find((e) => e.start <= now && e.end > now);
    const ahead = live.filter((e) => e.start > now);
    const important = ahead.filter((e) => !e.recurring);
    if (current) say("You're in ", { strong: current.title }, ` until ${time(current.end)}.`);
    if (!ahead.length) {
      say(live.length ? "No more meetings today: the rest of the day is yours." : "No meetings today: the whole day is yours.");
    } else {
      const busy = ahead.reduce((sum, e) => sum + (e.end - e.start), 0);
      const first = ahead[0];
      say(
        `${ahead.length === 1 ? "One meeting" : `${ahead.length} meetings`} still to come, about ${duration(busy)} in all; ${ahead.length === 1 ? "it's" : "the next is"} `,
        { strong: first.title },
        ` at ${time(first.start)}${first.recurring ? "" : ", not a regular one"}.`,
      );
      const others = important.filter((e) => e !== first);
      if (others.length) {
        const parts = others.slice(0, 3).flatMap((e, i, a) => [i ? (i === a.length - 1 ? " and " : ", ") : "", { strong: e.title }, ` at ${time(e.start)}`]);
        say(`${important.includes(first) ? "Also out" : "Out"} of the ordinary today: `, ...parts, ".");
      }
      const unanswered = ahead.filter((e) => e.response === "NEEDS-ACTION");
      if (unanswered.length) say(`You haven't answered ${unanswered.length === 1 ? "one invitation" : `${unanswered.length} invitations`} yet.`);
    }
  }

  const doing = tasks.filter((t) => t.status === "doing");
  const review = tasks.filter((t) => t.status === "review");
  if (doing.length || review.length) {
    const top = [...doing].sort((a, b) => b.priority - a.priority)[0];
    const parts = [];
    if (doing.length) parts.push(`${doing.length} task${doing.length > 1 ? "s" : ""} in progress`);
    if (review.length) parts.push(`${review.length} waiting for review`);
    say(`On your plate: ${list(parts)}.`, ...(top ? [" The most pressing is ", { strong: top.title }, "."] : []));
  } else {
    say("Nothing in progress on your boards.");
  }

  if (calendar) {
    if (week.length) {
      const shown = week.slice(0, 3);
      const parts = shown.flatMap((e, i) => [i ? (i === shown.length - 1 ? " and " : ", ") : "", `${dayName(e.start)}'s `, { strong: e.title }]);
      say("Later this week: ", ...parts, week.length > 3 ? `, plus ${week.length - 3} more.` : ".");
    } else {
      say("Nothing out of the ordinary later this week.");
    }
  }

  if (weather) {
    const w = describe(weather.code);
    const rainy = weather.hourly?.filter((x) => x.at > now && x.at.toDateString() === now.toDateString() && x.rain >= 50) || [];
    const joint = w.sky === "rain" || w.sky === "snow" || w.sky === "storm" ? "with" : "and";
    let line = `In ${city} it's ${Math.round(weather.temp)}° ${joint} ${w.text}, ${Math.round(weather.min)}° to ${Math.round(weather.max)}° today`;
    if (rainy.length) line += `; rain likely from ${time(rainy[0].at)}, so take an umbrella`;
    say(`${line}.`);
  }
  return out;
}

/** What Claude's summary is about: when this changes, it's written again. */
export function claudeKey(day) {
  const ids = (xs) => xs.map((e) => e.id).join(",");
  const ahead = day.today.filter((e) => e.end > day.now && e.response !== "DECLINED");
  return [
    day.now.toDateString(),
    ids(ahead),
    ids(day.week),
    day.tasks.map((t) => `${t.id}:${t.status}`).join(","),
    day.weather ? describe(day.weather.code).sky : "",
  ].join("|");
}

export async function claudeSummary(day, name) {
  const data = {
    now: day.now.toString(),
    name: name || null,
    meetingsLeftToday: day.today
      .filter((e) => e.end > day.now && e.response !== "DECLINED")
      .map((e) => ({ title: e.title, start: time(e.start), end: time(e.end), recurring: e.recurring, needsReply: e.response === "NEEDS-ACTION" })),
    oneOffMeetingsLaterThisWeek: day.week.map((e) => ({ title: e.title, day: dayName(e.start), start: e.allDay ? "all day" : time(e.start) })),
    tasks: day.tasks.map((t) => ({ title: t.title, status: t.status, priority: ["low", "medium", "high", "urgent"][t.priority] })),
    weather: day.weather ? { city: day.city, now: Math.round(day.weather.temp), sky: describe(day.weather.code).text, min: day.weather.min, max: day.weather.max, rainChance: day.weather.rain } : null,
  };
  const prompt =
    "Write my morning briefing from this JSON. Plain prose, 3 to 5 short sentences, no greeting (it's shown above), " +
    "no lists, no markdown, English. Lead with what matters today: meetings still to come, and above all the ones that " +
    "aren't recurring. Then what I'm working on, then the one-off meetings later this week, then a line on the weather " +
    "if it changes what I should do. Calm and warm, never chirpy; no advice about productivity.\n\n" +
    JSON.stringify(data);
  const text = await octopus.claude.ask(prompt, { model: "haiku" });
  return text.trim().replace(/^["“]|["”]$/g, "");
}
