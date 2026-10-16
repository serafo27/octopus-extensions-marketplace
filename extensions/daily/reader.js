// The newspaper: every headline of the sources shown, newest first, in a full-screen layer over the board.
// The list on the left, the article on the right: its text comes from the feed or from the article's page
// (services.js `readArticle`), as plain text, never as the page's own HTML.

import { imageOf, imageNow, readArticle } from "./services.js";
import { icon } from "./icons.js";

let R = null; // { layer, list, article, tabs, opts, tab, link } while open

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function ago(at) {
  if (!at || isNaN(at)) return "";
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

/**
 * Opens the newspaper on `link` (or the newest headline). `opts`: `items()` the headlines (`{ ...item, source }`),
 * `sources()` the sources shown (`[{ id, name }]`), `loading()` true while feeds are read, `refresh()` reads them
 * again, `detached` when it's the whole page of a window of its own (reader.html), `tab` the source shown first.
 * In a narrow window it shows one pane at a time: the headlines, or the story read with a way back.
 */
export function openReader(link, opts) {
  if (R) return select(link);
  const detached = !!opts.detached;
  const tabs = h("div", { class: "tabs reader-tabs", role: "tablist" });
  const list = h("div", { class: "reader-list", role: "listbox", "aria-label": "Headlines" });
  const article = h("article", { class: "reader-article", tabindex: "-1" });
  const refreshButton = h("button", { class: "ghost tool", title: "Read the feeds again", "aria-label": "Refresh", onclick: () => refresh() }, icon("refresh", 14));
  const now = new Date();
  const layer = h(
    "div",
    { class: "reader-layer", role: "dialog", "aria-label": "News" },
    h(
      "header",
      { class: "reader-bar" },
      h("div", { class: "masthead" }, h("span", { class: "mast-name" }, "The Daily"), h("span", { class: "mast-date" }, now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }))),
      tabs,
      h("span", { class: "spacer" }),
      refreshButton,
      // A window of its own needs Octopus's `octopus.window` (newer SDKs only).
      !detached && octopus.window && h("button", { class: "ghost tool", title: "Detach: a window of its own, to keep beside other apps", "aria-label": "Detach", onclick: detach }, icon("detach", 14)),
      !detached && h("button", { class: "ghost", title: "Back to the board (Esc)", onclick: closeReader }, icon("close", 14), "Close"),
    ),
    h("div", { class: detached ? "reader-main detached" : "reader-main" }, list, article),
  );
  if (detached) layer.classList.add("detached");
  R = { layer, list, article, tabs, refreshButton, opts, tab: opts.tab || "all", link: null, rows: new Map(), emptyNote: h("p", { class: "empty-note", hidden: true }), seen: new IntersectionObserver(onSeen, { root: list, rootMargin: "200px" }) };
  document.body.append(layer);
  document.addEventListener("keydown", onKey);
  requestAnimationFrame(() => layer.classList.add("open"));
  updateReader();
  select(link, { read: !!link });
}

/** Moves the newspaper to a window of its own, on the story shown, and closes it here. */
async function detach() {
  const at = { link: R.link, tab: R.tab, at: Date.now() };
  try {
    // The window reads where to open from storage: one window for the newspaper, whatever story it's on.
    await octopus.storage.set("readerAt", at);
    await octopus.window.open("reader.html", { title: "The Daily", width: 520, height: 860 });
    closeReader();
  } catch (e) {
    octopus.toast(`Couldn't open a window: ${e.message}`, "error");
  }
}

/** The story a click elsewhere asked for (reader.html: when the window was already open). */
export function showStory(link, tab) {
  if (!R) return;
  if (tab && tab !== R.tab) (R.tab = tab), updateReader();
  select(link, { read: !!link });
}

export function closeReader() {
  if (!R) return;
  const { layer, seen } = R;
  seen.disconnect();
  document.removeEventListener("keydown", onKey);
  R = null;
  layer.classList.remove("open");
  setTimeout(() => layer.remove(), 180);
}

/**
 * Brings the tabs and the list up to date, after the feeds were read or a tab was picked. Rows are kept
 * and only shown, hidden or moved, and the row in view stays where it was: nothing jumps to the top.
 */
export function updateReader() {
  if (!R) return;
  const sources = R.opts.sources();
  if (R.tab !== "all" && !sources.some((s) => s.id === R.tab)) R.tab = "all";
  drawTabs(sources);
  R.refreshButton.replaceChildren(R.opts.loading() ? h("span", { class: "spinner" }) : icon("refresh", 14));

  const anchor = anchorOf();
  const items = sorted();
  const keep = new Set(items.map((x) => x.link));
  for (const [link, row] of R.rows) {
    if (keep.has(link)) continue;
    R.seen.unobserve(row);
    row.remove();
    R.rows.delete(link);
  }
  let prev = null;
  let visible = 0;
  for (const x of items) {
    let row = R.rows.get(x.link);
    if (!row) R.rows.set(x.link, (row = rowOf(x)));
    else row.querySelector(".rl-ago").textContent = ago(x.at);
    row.hidden = !inTab(x);
    if (!row.hidden) visible++;
    const want = prev ? prev.nextElementSibling : R.list.firstElementChild;
    if (want !== row) R.list.insertBefore(row, want); // moves only what changed place
    prev = row;
  }
  R.emptyNote.textContent = R.opts.loading() ? "Reading the feeds…" : "No headlines right now.";
  R.emptyNote.hidden = visible > 0;
  if (R.list.lastElementChild !== R.emptyNote) R.list.append(R.emptyNote);

  if (anchor && !anchor.row.hidden) R.list.scrollTop += anchor.row.getBoundingClientRect().top - anchor.top;
}

/** The tabs, rebuilt only when the sources change; otherwise just the one that's on. */
function drawTabs(sources) {
  const all = [{ id: "all", name: "All" }, ...sources];
  const ids = all.map((s) => s.id).join("\n");
  if (R.tabs.dataset.ids !== ids) {
    R.tabs.dataset.ids = ids;
    R.tabs.replaceChildren(
      ...all.map((s) =>
        h("button", { role: "tab", class: "tab", "data-id": s.id, onclick: () => ((R.tab = s.id), updateReader()) }, s.name),
      ),
    );
  }
  for (const b of R.tabs.children) {
    const on = b.dataset.id === R.tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
}

/** The row to keep in place: the open story's when it's in view, else the first row in view. */
function anchorOf() {
  const box = R.list.getBoundingClientRect();
  const inView = (row) => {
    if (row.hidden || !row.isConnected) return false;
    const r = row.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  };
  const open = R.rows.get(R.link);
  const row = open && inView(open) ? open : [...R.rows.values()].find(inView);
  return row ? { row, top: row.getBoundingClientRect().top } : null;
}

function rowOf(x) {
  const thumb = h("span", { class: "rl-thumb" });
  const row = h(
    "button",
    { class: x.link === R.link ? "rl-item on" : "rl-item", role: "option", "aria-selected": String(x.link === R.link), "data-link": x.link, onclick: () => select(x.link) },
    thumb,
    h("span", { class: "rl-text" }, h("span", { class: "rl-src" }, sourceName(x), h("span", { class: "faint rl-ago" }, ago(x.at))), h("span", { class: "rl-title" }, x.title)),
  );
  const ready = imageNow(x);
  if (ready) thumb.append(h("img", { src: ready, alt: "" }));
  else if (x.source !== "hn") R.seen.observe(row);
  return row;
}

const inTab = (x) => R.tab === "all" || x.source === R.tab;
const sorted = () => R.opts.items().sort((a, b) => (+b.at || 0) - (+a.at || 0));

const shown = () => sorted().filter(inTab);

const sourceName = (x) => R.opts.sources().find((s) => s.id === x.source)?.name || "";

/** Thumbnails load only once their row comes near the view: the whole list would be dozens of downloads. */
function onSeen(entries) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    R.seen.unobserve(e.target);
    const x = R.opts.items().find((i) => i.link === e.target.dataset.link);
    if (!x) continue;
    const thumb = e.target.querySelector(".rl-thumb");
    imageOf(x).then((url) => url && thumb.isConnected && thumb.replaceChildren(h("img", { src: url, alt: "", class: "arrive" })));
  }
}

async function refresh() {
  if (R.opts.loading()) return;
  const done = R.opts.refresh();
  updateReader();
  await done;
  updateReader();
}

function onKey(e) {
  if (!R || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches?.("input, textarea")) return;
  if (e.key === "Escape") {
    // Narrow: back to the headlines first. A window of its own isn't closed by a key.
    if (R.layer.classList.contains("reading") && narrow()) R.layer.classList.remove("reading");
    else if (!R.opts.detached) closeReader();
  }
  else if (e.key === "ArrowDown" || e.key === "j") step(1);
  else if (e.key === "ArrowUp" || e.key === "k") step(-1);
  else if (e.key === "o") {
    const x = current();
    if (x) octopus.openUrl(x.link);
  } else return;
  e.preventDefault();
}

function step(by) {
  const items = shown();
  const i = items.findIndex((x) => x.link === R.link);
  const next = items[Math.max(0, Math.min(items.length - 1, i + by))];
  if (next) select(next.link, { read: R.layer.classList.contains("reading") }); // the pane shown stays
}

const current = () => R.opts.items().find((x) => x.link === R.link);

const narrow = () => R.layer.clientWidth <= 760;

/** Shows a story; `read`: in a narrow window, its pane (a click, or the story asked for), not the list's. */
function select(link, { read = true } = {}) {
  const items = shown();
  const x = items.find((i) => i.link === link) || R.opts.items().find((i) => i.link === link) || items[0];
  if (!x) return R.article.replaceChildren();
  R.link = x.link;
  if (read) R.layer.classList.add("reading");
  for (const row of R.list.querySelectorAll(".rl-item")) {
    const on = row.dataset.link === x.link;
    row.classList.toggle("on", on);
    row.setAttribute("aria-selected", String(on));
    if (on && !row.hidden) reveal(row);
  }
  drawArticle(x);
}

/** Scrolls the list, and only the list, just enough to show `row` (scrollIntoView would move the page too). */
function reveal(row) {
  const box = R.list.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < box.top) R.list.scrollTop -= box.top - r.top;
  else if (r.bottom > box.bottom) R.list.scrollTop += r.bottom - box.bottom;
}

function drawArticle(x) {
  const pic = h("figure", { class: "ra-pic" });
  const ready = imageNow(x);
  if (ready) pic.append(h("img", { src: ready, alt: "" }));
  else if (x.source !== "hn")
    imageOf(x).then((url) => {
      if (url && pic.isConnected) pic.replaceChildren(h("img", { src: url, alt: "", class: "arrive" }));
      else pic.remove();
    });
  if (!ready && x.source === "hn") pic.hidden = true;

  const body = h("div", { class: "ra-body" }, h("p", { class: "ra-wait faint" }, h("span", { class: "spinner" }), " Getting the article…"));
  const standfirst = x.summary && h("p", { class: "ra-standfirst" }, x.summary);
  const items = shown();
  const i = items.findIndex((y) => y.link === x.link);
  R.article.replaceChildren(
    h(
      "div",
      { class: "ra-inner" },
      h("button", { class: "ghost ra-back", onclick: () => R.layer.classList.remove("reading") }, "← Headlines"),
      h("div", { class: "ra-kicker" }, h("span", { class: "src-dot" }), sourceName(x), x.at && h("span", { class: "faint" }, x.at.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))),
      h("h1", { class: "ra-title" }, x.title),
      x.meta && h("p", { class: "ra-meta faint" }, x.meta),
      standfirst,
      pic,
      body,
      h(
        "div",
        { class: "ra-actions" },
        h("button", { class: "primary", onclick: () => octopus.openUrl(x.link) }, "Open the original"),
        x.comments && x.comments !== x.link && h("button", { onclick: () => octopus.openUrl(x.comments) }, "Comments"),
        h("span", { class: "spacer" }),
        h("button", { class: "ghost", disabled: i <= 0, title: "Previous (↑ or k)", onclick: () => step(-1) }, "Previous"),
        h("button", { class: "ghost", disabled: i < 0 || i >= items.length - 1, title: "Next (↓ or j)", onclick: () => step(1) }, "Next"),
      ),
    ),
  );
  R.article.scrollTop = 0;

  readArticle(x).then(
    ({ blocks, from }) => {
      if (R?.link !== x.link) return;
      // The page often opens with the feed's summary itself: no need to read it twice.
      if (standfirst && blocks[0] && x.summary.slice(0, 60) === blocks[0].text.slice(0, 60)) standfirst.remove();
      body.replaceChildren(...paragraphs(blocks), from === "feed" && blocks.length < 4 && note("This is what the feed carries. The whole story is on the site."));
    },
    (e) => {
      if (R?.link !== x.link) return;
      body.replaceChildren(note(x.source === "hn" ? `Hacker News links to articles all over the web. ${e.message}: open it in the browser.` : `The full article can't be read here: ${e.message}.`));
    },
  );
}

const note = (text) => h("p", { class: "ra-note" }, text);

/** Blocks as elements; list items in a row become one list. */
function paragraphs(blocks) {
  const out = [];
  let ul = null;
  for (const b of blocks) {
    if (b.kind === "li") {
      if (!ul) out.push((ul = h("ul", {})));
      ul.append(h("li", {}, b.text));
      continue;
    }
    ul = null;
    out.push(b.kind === "h" ? h("h2", {}, b.text) : b.kind === "quote" ? h("blockquote", {}, b.text) : h("p", {}, b.text));
  }
  return out;
}
