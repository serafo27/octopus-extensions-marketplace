// The sky over the day: its colour follows the hour (dawn, morning, midday, afternoon, dusk, night),
// the sun (or the moon) sits above "now" on a timeline of the day, and today's meetings lie on the
// horizon. Two layers: the weather's decor (clouds, rain, stars), rebuilt only when it changes, so its
// slow animations don't restart every minute, and the day itself, redrawn on every render.

const NS = "http://www.w3.org/2000/svg";
const H = 200; // folded: meetings as thin bars under the horizon
const HORIZON = 140;
const LANE_OPEN = 24; // unfolded: a row per meeting, its name written beside it
const PAD = 28;
const HOUR = 3_600_000;

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

/** A random sequence that's the same for the same seed: stars and clouds don't jump between renders. */
function seeded(seed) {
  let x = seed % 2147483647 || 1;
  return () => (x = (x * 48271) % 2147483647) / 2147483647;
}

/** Sunrise and sunset, from the weather when there is one, else a plain 7:00 to 19:00. */
function sunTimes(now, weather) {
  if (weather?.sunrise && weather?.sunset) return [weather.sunrise, weather.sunset];
  const d = new Date(now);
  return [new Date(d.setHours(7, 0, 0, 0)), new Date(d.setHours(19, 0, 0, 0))];
}

export function periodOf(now, weather) {
  const [rise, set] = sunTimes(now, weather);
  const t = +now;
  const m = now.getHours() * 60 + now.getMinutes();
  if (t < +rise - HOUR || t > +set + HOUR) return "night";
  if (t < +rise + HOUR) return "dawn";
  if (t > +set - HOUR) return "dusk";
  if (m < 11 * 60 + 30) return "morning";
  if (m < 14 * 60 + 30) return "midday";
  return "afternoon";
}

/** The hours the timeline shows: 7 to 20, wider when meetings are earlier or later. */
function span(now, meetings) {
  let from = 7;
  let to = 20;
  for (const e of meetings) {
    from = Math.min(from, e.start.getHours());
    to = Math.max(to, Math.min(24, e.end.getHours() + (e.end.getMinutes() ? 1 : 0)));
  }
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return [new Date(+day + from * HOUR), new Date(+day + to * HOUR)];
}

/**
 * Draws the sky in `el` (`.sky`). `meetings` are today's timed meetings; `animate` lets the sun rise to
 * its place (the first render only) and the decor move.
 */
export function renderSky(el, { now, meetings, weather, sky, animate, rise, expanded, onToggle }) {
  const W = Math.max(320, el.clientWidth);
  const period = periodOf(now, weather);
  el.dataset.period = period;
  el.dataset.weather = sky;
  el.classList.toggle("still", !animate);

  // Lanes first: overlapping meetings stack, and their number sets the sky's height when unfolded.
  const placed = [];
  const lanes = [];
  for (const e of [...meetings].sort((a, b) => a.start - b.start)) {
    let lane = lanes.findIndex((end) => end <= +e.start);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = +e.end;
    placed.push({ e, lane });
  }
  const open = expanded && placed.length > 0;
  const height = open ? HORIZON + 12 + placed.length * LANE_OPEN + 24 : H;
  el.style.height = `${height}px`;
  el.classList.toggle("open", open);

  const [from, to] = span(now, meetings);
  const x = (d) => PAD + ((Math.min(Math.max(+d, +from), +to) - +from) / (+to - +from)) * (W - 2 * PAD);

  // --- Decor: stars, clouds, rain, snow ---
  const decorKey = `${W}|${period}|${sky}|${now.toDateString()}`;
  let decor = el.querySelector("svg.decor");
  if (!decor || decor.dataset.key !== decorKey) {
    decor?.remove();
    decor = s("svg", { class: "decor", width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true", style: `--w:${W + 220}px` });
    decor.dataset.key = decorKey;
    const rnd = seeded(+new Date(now.toDateString()) / 1000);
    if (period === "night" || period === "dusk") {
      const stars = period === "night" ? 46 : 14;
      for (let i = 0; i < stars; i++) {
        decor.append(
          s("circle", {
            class: "star",
            cx: (rnd() * W).toFixed(1),
            cy: (6 + rnd() * (HORIZON - 24)).toFixed(1),
            r: (0.5 + rnd() * 1.1).toFixed(2),
            style: `animation-delay:${(-rnd() * 6).toFixed(2)}s;animation-duration:${(3 + rnd() * 4).toFixed(2)}s`,
          }),
        );
      }
    }
    const clouds = { partly: 3, cloudy: 6, rain: 6, storm: 6, snow: 5, fog: 5 }[sky] || (period !== "night" ? 2 : 0);
    if (clouds) {
      // Soft edges for the puffs, a wider blur for the shade under them.
      decor.append(
        s(
          "defs",
          {},
          s("filter", { id: "cloud-soft", x: "-20%", y: "-40%", width: "140%", height: "180%" }, s("feGaussianBlur", { stdDeviation: 0.9 })),
          s("filter", { id: "cloud-shade", x: "-30%", y: "-60%", width: "160%", height: "220%" }, s("feGaussianBlur", { stdDeviation: 3.5 })),
        ),
      );
    }
    // Spread along their drift: each starts a share of the way across, so they never bunch up.
    for (let i = 0; i < clouds; i++) {
      const share = (i + 0.2 + rnd() * 0.6) / clouds;
      const cx = -200 + share * (W + 220);
      const cy = 62 + rnd() * 44;
      const k = 0.6 + rnd() * 0.8;
      const secs = 110 + rnd() * 50;
      decor.append(cloud(i, cx, cy, k, rnd, `animation-duration:${secs.toFixed(0)}s;animation-delay:${(-share * secs).toFixed(1)}s;--x:${cx.toFixed(0)}px`));
    }
    if (sky === "rain" || sky === "storm" || sky === "snow") {
      const drops = sky === "snow" ? 50 : 70;
      for (let i = 0; i < drops; i++) {
        const dx = rnd() * W;
        const delay = (-rnd() * 2).toFixed(2);
        decor.append(
          sky === "snow"
            ? s("circle", { class: "flake", cx: dx, cy: 0, r: 1 + rnd(), style: `animation-delay:${delay * 3}s;animation-duration:${(4 + rnd() * 3).toFixed(2)}s` })
            : s("line", { class: "drop", x1: dx, y1: 0, x2: dx - 3, y2: 9, style: `animation-delay:${delay}s;animation-duration:${(0.7 + rnd() * 0.5).toFixed(2)}s` }),
        );
      }
    }
    if (sky === "storm") decor.append(s("rect", { class: "flash", x: 0, y: 0, width: W, height: HORIZON }));
    el.prepend(decor);
  }

  // --- The day: sun path, sun or moon, hours, meetings ---
  const [rise_, set] = sunTimes(now, weather);
  const arcY = (frac) => HORIZON - (HORIZON - 62) * Math.sin(Math.PI * Math.min(Math.max(frac, 0), 1));
  const dayFrac = (t) => (+t - +rise_) / (+set - +rise_);
  const isDay = +now >= +rise_ && +now <= +set;

  const svg = s("svg", {
    class: "day",
    width: W,
    height,
    viewBox: `0 0 ${W} ${height}`,
    role: placed.length ? "button" : "img",
    tabindex: placed.length ? 0 : null,
    "aria-expanded": placed.length ? String(open) : null,
    "aria-label": placed.length ? (open ? "Today's meetings by name; press to fold" : "Today, hour by hour; press to see the meetings' names") : "Today, hour by hour",
  });
  if (placed.length && onToggle) {
    // A click under the horizon (the meetings, the hours) folds or unfolds them.
    svg.addEventListener("click", (ev) => {
      const y = ev.clientY - svg.getBoundingClientRect().top;
      if (y >= HORIZON - 6) onToggle();
    });
    svg.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onToggle();
      }
    });
    svg.append(s("rect", { class: "strip", x: 0, y: HORIZON - 6, width: W, height: height - HORIZON + 6 }));
  }

  // The sun's path across the sky, sunrise to sunset.
  const path = [];
  for (let i = 0; i <= 48; i++) {
    const t = new Date(+rise_ + ((+set - +rise_) * i) / 48);
    if (t < from || t > to) continue;
    path.push(`${x(t).toFixed(1)},${arcY(i / 48).toFixed(1)}`);
  }
  if (path.length > 1) svg.append(s("polyline", { class: "sun-path", points: path.join(" ") }));

  svg.append(s("line", { class: "horizon", x1: 0, y1: HORIZON, x2: W, y2: HORIZON }));

  // Hours under the horizon.
  const hours = (+to - +from) / HOUR;
  const every = W / hours < 46 ? 2 : 1;
  for (let i = 0; i <= hours; i++) {
    const t = new Date(+from + i * HOUR);
    const hx = x(t);
    svg.append(s("line", { class: "tick", x1: hx, y1: HORIZON, x2: hx, y2: HORIZON + 4 }));
    if (open) svg.append(s("line", { class: "grid", x1: hx, y1: HORIZON + 6, x2: hx, y2: height - 22 }));
    if (i % every === 0) svg.append(s("text", { class: "hour", x: hx, y: height - 8, "text-anchor": "middle" }, document.createTextNode(String(t.getHours()))));
  }

  // Meetings under the horizon: thin bars, or (unfolded) blocks with their time and name.
  for (const { e, lane } of placed) {
    if (!open && lane > 2) continue;
    const x1 = x(e.start);
    const x2 = Math.max(x(e.end), x1 + 4);
    const w = Math.max(2, x2 - x1 - 2);
    const cls = ["bar", e.recurring ? "recurring" : "oneoff", e.end <= now && "past", e.start <= now && e.end > now && "current", e.response === "DECLINED" && "declined"]
      .filter(Boolean)
      .join(" ");
    const tip = s("title", {}, document.createTextNode(`${clock(e.start)}–${clock(e.end)} ${e.title}${e.recurring ? "" : " (one-off)"}`));
    if (!open) {
      svg.append(s("rect", { class: cls, x: x1 + 1, y: HORIZON + 8 + lane * 9, width: w, height: 6, rx: 3 }, tip));
      continue;
    }
    // A row each, in order of start: the name beside the block, on its left when it would run off the edge.
    const row = placed.findIndex((p) => p.e === e);
    const y = HORIZON + 12 + row * LANE_OPEN;
    const bh = LANE_OPEN - 6;
    const block = s("g", { class: `${cls} block` }, tip, s("rect", { x: x1 + 1, y, width: w, height: bh, rx: 4 }), s("rect", { class: "edge", x: x1 + 1, y, width: 3, height: bh, rx: 1.5 }));
    const label = `${clock(e.start)} `;
    const guess = (label.length + e.title.length) * 6.4; // Inter at 12px, roughly
    const right = x1 + w + 8 + guess <= W - 8;
    block.append(
      s(
        "text",
        { class: "block-text", x: right ? x1 + w + 8 : x1 - 6, y: y + bh / 2 + 4, "text-anchor": right ? "start" : "end" },
        s("tspan", { class: "block-time" }, document.createTextNode(label)),
        document.createTextNode(e.title),
      ),
    );
    svg.append(block);
  }
  if (placed.length) {
    svg.append(s("text", { class: "fold-hint", x: W - PAD, y: HORIZON - 8, "text-anchor": "end" }, document.createTextNode(open ? "Hide names" : "Show names")));
  }

  // Now: a thin line from the sun (or the moon) down to the horizon.
  const nx = x(now);
  let frac;
  if (isDay) frac = dayFrac(now);
  else {
    const night = 24 * HOUR - (+set - +rise_);
    const since = +now > +set ? +now - +set : +now + 24 * HOUR - +set;
    frac = Math.min(1, since / night);
  }
  const ny = arcY(frac);
  svg.append(s("line", { class: "now-line", x1: nx, y1: ny + 14, x2: nx, y2: HORIZON }));
  const body = isDay
    ? s("g", { class: "sun" }, s("circle", { class: "glow", r: 24 }), s("circle", { class: "disc", r: 11 }))
    : s("g", { class: "moon" }, s("circle", { class: "glow", r: 20 }), s("circle", { class: "disc", r: 9 }), s("circle", { class: "bite", cx: 5, cy: -3, r: 8 }));
  body.setAttribute("transform", `translate(${nx.toFixed(1)} ${ny.toFixed(1)})`);
  svg.append(body);
  svg.append(s("text", { class: "now-label", x: nx, y: HORIZON - 6, "text-anchor": nx > W - 60 ? "end" : nx < 60 ? "start" : "middle", dx: nx > W - 60 ? -6 : nx < 60 ? 6 : 0 }, document.createTextNode(clock(now))));

  const old = el.querySelector("svg.day");
  if (old) old.replaceWith(svg);
  else el.append(svg);

  // The first render: the sun rises from the horizon to where it is now.
  if (rise && animate && isDay) {
    const start = performance.now();
    const x0 = x(rise_);
    const f0 = dayFrac(new Date(Math.max(+rise_, +from)));
    const step = (t) => {
      const k = Math.min(1, (t - start) / 1600);
      const e = 1 - Math.pow(1 - k, 3);
      const fx = x0 + (nx - x0) * e;
      const fy = arcY(f0 + (frac - f0) * e);
      body.setAttribute("transform", `translate(${fx.toFixed(1)} ${fy.toFixed(1)})`);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

/**
 * A cumulus: a flat base with three to five puffs on top, the middle ones tallest. Drawn around x = 0
 * (its drift moves it), shaded top to bottom by a gradient of its own, over a blurred shadow.
 */
function cloud(i, cx, cy, k, rnd, style) {
  const w = (70 + rnd() * 60) * k;
  const base = 13 * k;
  const n = 3 + Math.floor(rnd() * 3);
  const shapes = () => {
    const out = [s("rect", { x: -w / 2, y: cy - base, width: w, height: base, rx: base / 2 })];
    for (let j = 0; j < n; j++) {
      const t = (j + 0.5) / n;
      const r = (w / n) * (0.55 + rnd() * 0.3) * (1.15 - Math.abs(t - 0.5) * 0.9);
      out.push(s("circle", { cx: (-w / 2 + t * w + (rnd() - 0.5) * 6 * k).toFixed(1), cy: (cy - base * 0.55 - r * 0.5).toFixed(1), r: r.toFixed(1) }));
    }
    return out;
  };
  const body = shapes();
  const top = Math.min(...body.slice(1).map((c) => +c.getAttribute("cy") - +c.getAttribute("r")));
  const id = `cloud-g-${i}`;
  const grad = s(
    "linearGradient",
    { id, gradientUnits: "userSpaceOnUse", x1: 0, y1: top.toFixed(1), x2: 0, y2: cy.toFixed(1) },
    s("stop", { offset: "0", class: "cloud-hi" }),
    s("stop", { offset: "0.6", class: "cloud-mid" }),
    s("stop", { offset: "1", class: "cloud-lo" }),
  );
  return s(
    "g",
    { class: "cloud", style },
    s("defs", {}, grad),
    s("g", { class: "cloud-shadow", filter: "url(#cloud-shade)", transform: `translate(${(4 * k).toFixed(1)} ${(5 * k).toFixed(1)})` }, body.map((x) => x.cloneNode())),
    s("g", { class: "cloud-body", fill: `url(#${id})`, filter: "url(#cloud-soft)" }, body),
  );
}

const clock = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
