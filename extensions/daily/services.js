// Outside services: weather (Open-Meteo, no key) and news (RSS and Atom feeds, Hacker News). Each answer is kept
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
/** Drops the headlines only, so the next read asks the feeds again. */
export const forgetNews = () => [...cache.keys()].forEach((k) => k.startsWith("news:") && cache.delete(k));

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

// Some sites (Il Post among them) refuse requests without a browser's User-Agent.
const BROWSER = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

export const SOURCES = {
  ansa: { name: "ANSA", url: "https://www.ansa.it/sito/ansait_rss.xml", kind: "rss" },
  bbc: { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", kind: "rss" },
  hn: { name: "Hacker News", url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20", kind: "hn" },
  // Il Post answers only at `/feed`, not `/feed/`.
  ilpost: { name: "Il Post", url: "https://www.ilpost.it/feed", kind: "rss" },
};

/** The built-in sources and the user's own feeds (`settings.feeds`), in that order: `[{ id, name, url, kind, custom }]`. */
export function sources(settings) {
  return [
    ...Object.entries(SOURCES).map(([id, src]) => ({ id, ...src, custom: false })),
    ...(settings.feeds || []).map((f) => ({ ...f, kind: "rss", custom: true })),
  ];
}

/** The newest headlines of a source: `[{ title, link, at, meta, image }]`. */
export function news(src) {
  return cached(`news:${src.id}:${src.url}`, async () => {
    if (src.kind === "hn") {
      const d = await getJson(src.url);
      return d.hits.map((x) => ({
        title: x.title,
        link: x.url || `https://news.ycombinator.com/item?id=${x.objectID}`,
        at: new Date(x.created_at),
        meta: `${x.points} points, ${x.num_comments} comments`,
        domain: x.url ? new URL(x.url).hostname.replace(/^www\./, "") : "news.ycombinator.com",
        image: null,
        summary: "",
        content: x.story_text || "", // Ask HN and the like: the post itself
        comments: `https://news.ycombinator.com/item?id=${x.objectID}`,
      }));
    }
    return (await feed(src.url)).items;
  });
}

/** Checks a feed the user is adding: `{ title, items }`, or throws why it can't be read. */
export async function probeFeed(url) {
  const f = await feed(url);
  if (!f.items.length) throw new Error("The feed has no headlines");
  return f;
}

/** Reads an RSS 2.0, RSS 1.0 (RDF) or Atom feed: `{ title, items }`. */
async function feed(url) {
  const res = await octopus.http.fetch(url, {
    timeoutMs: 20000,
    headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", ...BROWSER },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = new DOMParser().parseFromString(res.text(), "text/xml");
  if (xml.querySelector("parsererror")) throw new Error("It isn't a valid RSS or Atom feed");
  const root = xml.documentElement;
  const atom = root.localName === "feed";
  const entries = [...root.getElementsByTagName(atom ? "entry" : "item")];
  if (!entries.length && !["rss", "RDF", "feed"].includes(root.localName)) throw new Error("It isn't an RSS or Atom feed");
  const title = decode(child(atom ? root : root.getElementsByTagName("channel")[0] || root, "title")?.textContent?.trim() || "");
  return { title, items: entries.map((e) => (atom ? atomItem(e) : rssItem(e))).filter((x) => x.title && x.link) };
}

/** The first direct child named `name` (without namespace), so an item's <title> wins over nested ones. */
const child = (el, name) => [...el.children].find((c) => c.localName === name) || null;
const textOf = (el, name) => child(el, name)?.textContent?.trim() || "";
const date = (s) => (s && !isNaN(new Date(s)) ? new Date(s) : null);

function rssItem(item) {
  const html = textOf(item, "description") + textOf(item, "encoded"); // content:encoded
  return {
    title: decode(textOf(item, "title")),
    link: textOf(item, "link") || (textOf(item, "guid").startsWith("http") ? textOf(item, "guid") : ""),
    at: date(textOf(item, "pubDate") || textOf(item, "date")), // dc:date in RSS 1.0
    meta: "",
    image: mediaImage(item) || inlineImage(html),
    summary: plain(textOf(item, "description")),
    content: textOf(item, "encoded"),
  };
}

function atomItem(entry) {
  const links = [...entry.children].filter((c) => c.localName === "link");
  const link = links.find((l) => (l.getAttribute("rel") || "alternate") === "alternate") || links[0];
  return {
    title: decode(textOf(entry, "title")),
    link: link?.getAttribute("href") || "",
    at: date(textOf(entry, "published") || textOf(entry, "updated")),
    meta: "",
    image: mediaImage(entry) || inlineImage(textOf(entry, "content") + textOf(entry, "summary")),
    summary: plain(textOf(entry, "summary") || textOf(entry, "content")),
    content: textOf(entry, "content"),
  };
}

/** media:thumbnail, media:content or an image enclosure. BBC's thumbnails come in a larger size too. */
function mediaImage(item) {
  const all = [...item.getElementsByTagName("*")];
  const thumb = all.find((c) => c.localName === "thumbnail")?.getAttribute("url");
  if (thumb) return thumb.replace("/standard/240/", "/standard/480/");
  const media = all.find((c) => c.localName === "content" && c.getAttribute("url") && (c.getAttribute("medium") === "image" || /^image\//.test(c.getAttribute("type") || "")));
  if (media) return media.getAttribute("url");
  const enclosure = all.find((c) => c.localName === "enclosure" && /^image\//.test(c.getAttribute("type") || ""));
  return enclosure?.getAttribute("url") || null;
}

/** The text of an HTML snippet, in a few lines at most. DOMParser's documents run nothing and load nothing. */
function plain(html) {
  const text = new DOMParser().parseFromString(html, "text/html").body.textContent.replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 497).replace(/\s+\S*$/, "")}…` : text;
}

const inlineImage = (html) => /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] || null;

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

/** The picture of a headline, as a data: URL, or null. Without one in the feed (ANSA), the article's og:image. */
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
  if (!url && /^https?:/.test(item.link)) {
    const page = await octopus.http.fetch(item.link, { timeoutMs: 15000, headers: BROWSER });
    url = page.ok ? ogImage(page.text()) : null;
  }
  if (!url) return null;
  url = new URL(url.replace(/&amp;/g, "&"), item.link).href; // relative and HTML-escaped addresses
  const res = await octopus.http.fetch(url, { binary: true, timeoutMs: 20000, headers: BROWSER });
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

/** og:image (or twitter:image) of an article page, whatever the order of the <meta> attributes. */
function ogImage(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!/(property|name)=["'](og:image|twitter:image)["']/i.test(tag)) continue;
    const content = /content=["']([^"']+)["']/i.exec(tag)?.[1];
    if (content) return content;
  }
  return null;
}

// --- Articles -------------------------------------------------------------------------------------

const articles = new Map(); // link -> Promise<{ blocks, from }>

/**
 * The text of a headline's article, to read on the board: `{ blocks: [{ kind: "p"|"h"|"quote"|"li", text }], from }`,
 * `from` saying where it comes from ("feed" or "page"). The feed's own content first, when it's the whole
 * article; else the article's page, when Octopus can reach it. Rejects when neither works.
 */
export function readArticle(item) {
  if (!articles.has(item.link)) {
    const job = loadArticle(item);
    job.catch(() => articles.delete(item.link)); // a failure is asked again next time
    articles.set(item.link, job);
  }
  return articles.get(item.link);
}

async function loadArticle(item) {
  const fromFeed = item.content ? blocksOf(new DOMParser().parseFromString(item.content, "text/html").body) : [];
  if (length(fromFeed) > 900) return { blocks: fromFeed, from: "feed" };
  let res;
  try {
    res = await octopus.http.fetch(item.link, { timeoutMs: 20000, headers: { Accept: "text/html", ...BROWSER } });
  } catch (e) {
    if (fromFeed.length) return { blocks: fromFeed, from: "feed" };
    throw new Error(/isn't in the hosts/.test(e.message) ? `Daily can't reach ${new URL(item.link).host}` : e.message);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(res.text(), "text/html");
  const blocks = blocksOf(articleRoot(doc));
  if (length(blocks) < 200) {
    if (fromFeed.length) return { blocks: fromFeed, from: "feed" };
    throw new Error("The page has no article text Daily can find");
  }
  return { blocks, from: "page" };
}

const length = (blocks) => blocks.reduce((n, b) => n + b.text.length, 0);

/** The element holding the article: a marked article body, else the one with the most paragraph text. */
function articleRoot(doc) {
  doc.querySelectorAll("script, style, noscript, nav, header, footer, aside, form, iframe, svg, button, [aria-hidden='true']").forEach((x) => x.remove());
  const marked = doc.querySelector("[itemprop='articleBody'], .entry-content, .article-body, .article__body, .story-body");
  if (marked && textIn(marked) > 400) return marked;
  // Readability's idea in short: each paragraph scores for its parent, and half as much for its grandparent.
  const score = new Map();
  for (const p of doc.querySelectorAll("p")) {
    const n = p.textContent.trim().length;
    if (n < 40) continue;
    const parent = p.parentElement;
    const grand = parent?.parentElement;
    if (parent) score.set(parent, (score.get(parent) || 0) + n);
    if (grand) score.set(grand, (score.get(grand) || 0) + n / 2);
  }
  let best = doc.querySelector("article") || doc.body;
  let top = 0;
  for (const [el, n] of score) if (n > top) (best = el), (top = n);
  return best;
}

const textIn = (el) => [...el.querySelectorAll("p")].reduce((n, p) => n + p.textContent.trim().length, 0);

/** Paragraphs, headings, quotes and list items of `root`, as plain text, in reading order. */
function blocksOf(root) {
  const kinds = { P: "p", H2: "h", H3: "h", H4: "h", BLOCKQUOTE: "quote", LI: "li" };
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      const kind = kinds[c.tagName];
      if (kind) {
        const text = c.textContent.replace(/\s+/g, " ").trim();
        if (text && (kind !== "li" || text.length > 20)) out.push({ kind, text });
      } else walk(c);
    }
  };
  walk(root);
  // A feed's content is sometimes just text with <br>s.
  if (!out.length) {
    const text = root.textContent.replace(/\s+/g, " ").trim();
    if (text) out.push({ kind: "p", text });
  }
  return out.slice(0, 300);
}
