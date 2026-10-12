// Outside services: weather (Open-Meteo, no key) and news (RSS feeds, Hacker News). Each answer is kept
// for a while so the board's minute refresh doesn't call them again.

const KEEP_MS = 20 * 60_000;
const cache = new Map(); // key -> { at, value }

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export const forget = () => cache.clear();

async function getJson(url) {
  const res = await octopus.http.fetch(url, { timeoutMs: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Weather --------------------------------------------------------------------------------------

/** Places matching a name: `[{ name, country, admin, lat, lon }]`. */
export async function findPlaces(name) {
  const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=${encodeURIComponent(name)}`);
  return (data.results || []).map((r) => ({ name: r.name, country: r.country || "", admin: r.admin1 || "", lat: r.latitude, lon: r.longitude }));
}

export function weather(city) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&timezone=auto&forecast_days=2` +
    "&current=temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
    "&hourly=precipitation_probability,temperature_2m,weather_code,is_day";
  return cached(`weather:${city.lat},${city.lon}`, async () => {
    const d = await getJson(url);
    // Times come in the place's own zone: as long as it's the user's, they read as local times.
    const hourly = (d.hourly?.time || []).map((t, i) => ({
      at: new Date(t),
      rain: d.hourly.precipitation_probability[i],
      temp: d.hourly.temperature_2m[i],
      code: d.hourly.weather_code[i],
      isDay: !!d.hourly.is_day[i],
    }));
    return {
      temp: d.current.temperature_2m,
      feels: d.current.apparent_temperature,
      code: d.current.weather_code,
      isDay: !!d.current.is_day,
      wind: d.current.wind_speed_10m,
      max: d.daily.temperature_2m_max[0],
      min: d.daily.temperature_2m_min[0],
      rain: d.daily.precipitation_probability_max[0],
      sunrise: new Date(d.daily.sunrise[0]),
      sunset: new Date(d.daily.sunset[0]),
      hourly,
    };
  });
}

/** WMO weather codes: words and the kind of sky they mean. */
export function describe(code) {
  const table = [
    [[0], "clear", "clear"],
    [[1], "mostly clear", "clear"],
    [[2], "partly cloudy", "partly"],
    [[3], "overcast", "cloudy"],
    [[45, 48], "foggy", "fog"],
    [[51, 53, 55, 56, 57], "drizzle", "rain"],
    [[61, 63, 80, 81], "rain", "rain"],
    [[65, 66, 67, 82], "heavy rain", "rain"],
    [[71, 73, 75, 77, 85, 86], "snow", "snow"],
    [[95, 96, 99], "thunderstorms", "storm"],
  ];
  const row = table.find(([codes]) => codes.includes(code));
  return row ? { text: row[1], sky: row[2] } : { text: "", sky: "clear" };
}

// --- News -----------------------------------------------------------------------------------------

export const SOURCES = {
  ansa: { name: "ANSA", url: "https://www.ansa.it/sito/ansait_rss.xml", kind: "rss" },
  bbc: { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", kind: "rss" },
  hn: { name: "Hacker News", url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20", kind: "hn" },
  // Il Post refuses requests without a browser's User-Agent, and its `/feed/` (with the slash).
  ilpost: { name: "Il Post", url: "https://www.ilpost.it/feed", kind: "rss", headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } },
};

/** The newest headlines of a source: `[{ title, link, at, meta }]`. */
export function news(id) {
  const src = SOURCES[id];
  return cached(`news:${id}`, async () => {
    if (src.kind === "hn") {
      const d = await getJson(src.url);
      return d.hits.map((x) => ({
        title: x.title,
        link: x.url || `https://news.ycombinator.com/item?id=${x.objectID}`,
        at: new Date(x.created_at),
        meta: `${x.points} points, ${x.num_comments} comments`,
        domain: x.url ? new URL(x.url).hostname.replace(/^www\./, "") : "news.ycombinator.com",
        image: null,
      }));
    }
    const res = await octopus.http.fetch(src.url, {
      timeoutMs: 20000,
      headers: { Accept: "application/rss+xml, application/xml, text/xml", ...(src.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = new DOMParser().parseFromString(res.text(), "text/xml");
    if (xml.querySelector("parsererror")) throw new Error("The feed isn't valid RSS");
    return [...xml.querySelectorAll("item")].map((item) => {
      const text = (sel) => item.querySelector(sel)?.textContent?.trim() || "";
      const at = text("pubDate");
      // BBC: media:thumbnail (480 px exists too); Il Post: the <img> in the description; ANSA: none (see `imageOf`).
      const thumb = item.getElementsByTagName("media:thumbnail")[0]?.getAttribute("url");
      const inline = /<img[^>]+src="([^"]+)"/.exec(text("description"))?.[1];
      const image = thumb ? thumb.replace("/standard/240/", "/standard/480/") : inline || null;
      return { title: decode(text("title")), link: text("link"), at: at ? new Date(at) : null, meta: "", image };
    });
  });
}

function decode(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

// --- Images ---------------------------------------------------------------------------------------

// Remote images can't load in the page (its CSP), so they come through Octopus as data: URLs.
// Needs an Octopus whose http.fetch knows `binary`; older ones just show no pictures.
const images = new Map(); // article link -> Promise<data URL | null>
let hasBinary = true;

/** The picture of a headline, as a data: URL, or null. ANSA's comes from the article's og:image. */
export function imageOf(item) {
  if (!hasBinary) return Promise.resolve(null);
  if (!images.has(item.link)) images.set(item.link, queued(() => loadImage(item)).catch(() => null));
  return images.get(item.link);
}

// A few downloads at a time: a page of headlines shouldn't fire twenty requests at once.
let running = 0;
const waiting = [];
function queued(job) {
  return new Promise((resolve, reject) => {
    waiting.push(() => job().then(resolve, reject).finally(() => (running--, next())));
    next();
  });
}
function next() {
  while (running < 4 && waiting.length) {
    running++;
    waiting.shift()();
  }
}

export function imageNow(item) {
  return cachedImages.get(item.link) ?? null;
}
const cachedImages = new Map();

async function loadImage(item) {
  let url = item.image;
  if (!url && item.link.startsWith("https://www.ansa.it/sito/")) {
    const page = await octopus.http.fetch(item.link, { timeoutMs: 15000 });
    url = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(page.text())?.[1] || null;
  }
  if (!url) return null;
  const res = await octopus.http.fetch(url, { binary: true, timeoutMs: 20000 });
  if (!res.ok) return null;
  if (typeof res.dataUrl !== "function") {
    hasBinary = false;
    return null;
  }
  const data = res.dataUrl();
  if (!data.startsWith("data:image/")) return null;
  cachedImages.set(item.link, data);
  return data;
}
