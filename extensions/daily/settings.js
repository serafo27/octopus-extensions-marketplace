// The board's settings: kept in Octopus's storage for this extension, edited in a panel that slides in
// from the right. Every change is saved and shown at once.

import { findPlaces, probeFeed, sources } from "./services.js";
import { defaultLayout, normalizeLayout } from "./layout.js";
import { icon } from "./icons.js";

export const SECTIONS = [
  ["sky", "Sky and timeline"],
  ["summary", "Greeting and summary"],
  ["glance", "At a glance"],
  ["today", "Today's meetings"],
  ["tasks", "Tasks in progress"],
  ["week", "Later this week"],
  ["news", "News"],
];

export const DEFAULTS = {
  name: "", // none: the greeting is just "Good morning."
  animation: true,
  sections: { sky: true, summary: true, glance: true, today: true, tasks: true, week: true, news: true },
  summaryBy: "local", // local | claude
  weather: true,
  city: { name: "Milan", country: "Italy", lat: 45.4643, lon: 9.1895 },
  news: { ansa: true, bbc: true, hn: true, ilpost: true }, // source id -> shown, the user's feeds included
  feeds: [], // the user's own RSS or Atom feeds: [{ id, name, url }]
  newsCount: 4,
  dayEnd: 18, // the hour the working day ends: free time is counted until then
  review: true, // tasks in review count as in progress
  layout: defaultLayout(), // zone -> panel ids, see layout.js
};

export async function loadSettings() {
  const saved = (await octopus.storage.get("settings")) || {};
  return {
    ...DEFAULTS,
    ...saved,
    sections: { ...DEFAULTS.sections, ...(saved.sections || {}) },
    news: { ...DEFAULTS.news, ...(saved.news || {}) },
    feeds: Array.isArray(saved.feeds) ? saved.feeds : [],
    layout: normalizeLayout(saved.layout),
  };
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v === "boolean") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Opens the panel over the board; `change(settings)` runs after each edit. `focus: "feed"` starts on adding a feed. */
export function openSettings(settings, change, { focus } = {}) {
  document.querySelector(".settings-layer")?.remove();
  const save = () => {
    octopus.storage.set("settings", settings).catch((e) => octopus.toast(`Couldn't save the settings: ${e.message}`, "error"));
    change(settings);
  };

  const check = (label, get, set, hint) =>
    h(
      "label",
      { class: "check" },
      h("input", { type: "checkbox", checked: !!get(), onchange: (e) => (set(e.target.checked), save()) }),
      h("span", {}, label, hint && h("span", { class: "hint" }, hint)),
    );

  const choice = (name, options, get, set) =>
    h(
      "div",
      { class: "seg", role: "radiogroup" },
      options.map(([value, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(get() === value),
            class: get() === value ? "on" : "",
            onclick: (e) => {
              set(value);
              save();
              for (const b of e.currentTarget.parentElement.children) {
                const on = b === e.currentTarget;
                b.classList.toggle("on", on);
                b.setAttribute("aria-checked", String(on));
              }
            },
          },
          label,
        ),
      ),
    );

  // The city: typed, then picked among the places Open-Meteo knows by that name.
  const cityNow = h("div", { class: "hint" }, placeName(settings.city));
  const results = h("div", { class: "places" });
  const cityInput = h("input", { type: "text", placeholder: "Find a city", spellcheck: "false" });
  const find = async () => {
    const q = cityInput.value.trim();
    if (!q) return;
    results.replaceChildren(h("span", { class: "spinner" }));
    try {
      const places = await findPlaces(q);
      results.replaceChildren(
        ...(places.length
          ? places.map((p) =>
              h(
                "button",
                {
                  type: "button",
                  class: "ghost place",
                  onclick: () => {
                    settings.city = p;
                    cityNow.textContent = placeName(p);
                    results.replaceChildren();
                    cityInput.value = "";
                    save();
                  },
                },
                placeName(p),
              ),
            )
          : [h("span", { class: "hint" }, `No place called “${q}”.`)]),
      );
    } catch (e) {
      results.replaceChildren(h("span", { class: "hint error" }, `Couldn't search: ${e.message}`));
    }
  };
  cityInput.addEventListener("keydown", (e) => e.key === "Enter" && find());

  // News sources: the built-in ones can be hidden, the user's own feeds removed too.
  const sourceList = h("div", { class: "sources" });
  const drawSources = () =>
    sourceList.replaceChildren(
      ...sources(settings).map((src) =>
        h(
          "div",
          { class: "source" },
          check(src.name, () => settings.news[src.id], (v) => (settings.news[src.id] = v), src.custom ? src.url : null),
          src.custom &&
            h(
              "button",
              {
                type: "button",
                class: "ghost remove",
                title: `Remove ${src.name}`,
                "aria-label": `Remove ${src.name}`,
                onclick: () => {
                  settings.feeds = settings.feeds.filter((f) => f.id !== src.id);
                  delete settings.news[src.id];
                  drawSources();
                  save();
                },
              },
              icon("close", 14),
            ),
        ),
      ),
    );
  drawSources();

  const feedInput = h("input", { type: "text", placeholder: "https://example.com/feed.xml", spellcheck: "false", "aria-label": "Feed address" });
  const feedStatus = h("div", { class: "hint" });
  const addFeed = async () => {
    let url = feedInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      url = new URL(url).href;
    } catch {
      return feedStatus.replaceChildren(h("span", { class: "error" }, "That isn't a web address."));
    }
    const known = sources(settings).find((src) => src.url === url);
    if (known) return feedStatus.replaceChildren(`It's already there, as ${known.name}.`);
    addButton.disabled = true;
    feedStatus.replaceChildren(h("span", { class: "spinner" }), " Reading the feed…");
    try {
      const feed = await probeFeed(url);
      const id = `feed-${Date.now().toString(36)}`;
      const name = (feed.title || new URL(url).hostname.replace(/^www\./, "")).slice(0, 40);
      settings.feeds = [...settings.feeds, { id, name, url }];
      settings.news[id] = true;
      feedInput.value = "";
      feedStatus.replaceChildren(`Added ${name}, ${feed.items.length} headlines.`);
      drawSources();
      save();
    } catch (e) {
      // Octopus reaches only the prefixes in manifest.json, and an extension can't add to them itself.
      if (/isn't in the hosts/.test(e.message)) {
        const prefix = `${new URL(url).origin}/`;
        feedStatus.replaceChildren(
          h("span", { class: "error" }, `Daily can't reach ${new URL(url).host} yet. Add “${prefix}” to permissions.http in manifest.json (Claude Code in this folder can do it), then add the feed again.`),
          " ",
          h("button", { type: "button", class: "ghost copy-prefix", onclick: () => (octopus.copy(prefix), octopus.toast("Copied", "info")) }, "Copy"),
        );
      } else feedStatus.replaceChildren(h("span", { class: "error" }, `Couldn't add it: ${e.message}`));
    } finally {
      addButton.disabled = false;
    }
  };
  const addButton = h("button", { type: "button", onclick: addFeed }, "Add");
  feedInput.addEventListener("keydown", (e) => e.key === "Enter" && addFeed());

  const close = () => {
    layer.classList.remove("open");
    setTimeout(() => layer.remove(), 220);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);

  const panel = h(
    "aside",
    { class: "settings", role: "dialog", "aria-label": "Board settings" },
    h("div", { class: "settings-head" }, h("span", {}, "Board settings"), h("button", { type: "button", class: "ghost", onclick: close }, "Done")),
    h(
      "div",
      { class: "settings-body" },
      h(
        "section",
        {},
        h("h3", {}, "You"),
        h(
          "label",
          { class: "field" },
          h("span", {}, "Name in the greeting"),
          h("input", { type: "text", value: settings.name || "", placeholder: "No name", oninput: (e) => ((settings.name = e.target.value.trim()), save()) }),
        ),
      ),
      h(
        "section",
        {},
        h("h3", {}, "Look"),
        check("Animations", () => settings.animation, (v) => (settings.animation = v), "The sun rising, drifting clouds, rain and stars. Off when the Mac reduces motion."),
      ),
      h(
        "section",
        {},
        h("h3", {}, "Show on the board"),
        SECTIONS.map(([key, label]) => check(label, () => settings.sections[key], (v) => (settings.sections[key] = v))),
        check("Count tasks in review as in progress", () => settings.review, (v) => (settings.review = v)),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Your working day ends at"),
          choice("dayEnd", [[17, "17:00"], [18, "18:00"], [19, "19:00"], [20, "20:00"]], () => settings.dayEnd, (v) => (settings.dayEnd = v)),
          h("p", { class: "hint" }, "Free time is counted until then."),
        ),
      ),
      h(
        "section",
        {},
        h("h3", {}, "Layout"),
        h("p", { class: "hint" }, "Drag a section by its header to move it. Or focus its grip and use the arrow keys."),
        h(
          "button",
          {
            type: "button",
            class: "reset-layout",
            onclick: () => {
              settings.layout = defaultLayout();
              save();
            },
          },
          "Reset the layout",
        ),
      ),
      h(
        "section",
        {},
        h("h3", {}, "Summary"),
        choice("summaryBy", [["local", "Written here"], ["claude", "Written by Claude"]], () => settings.summaryBy, (v) => (settings.summaryBy = v)),
        h("p", { class: "hint" }, "Claude's takes a few seconds and is written again only when your meetings, tasks or the weather change."),
      ),
      h(
        "section",
        {},
        h("h3", {}, "Weather"),
        check("Show the weather", () => settings.weather, (v) => (settings.weather = v), "From Open-Meteo. It also sets sunrise and sunset in the sky."),
        h("div", { class: "field" }, h("span", {}, "City"), cityNow, h("div", { class: "row-input" }, cityInput, h("button", { type: "button", onclick: find }, "Find")), results),
      ),
      h(
        "section",
        {},
        h("h3", {}, "News"),
        sourceList,
        h(
          "div",
          { class: "field" },
          h("span", {}, "Add an RSS or Atom feed"),
          h("div", { class: "row-input" }, feedInput, addButton),
          feedStatus,
        ),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Headlines per source"),
          choice("newsCount", [[2, "2"], [4, "4"], [6, "6"]], () => settings.newsCount, (v) => (settings.newsCount = v)),
        ),
      ),
    ),
  );
  const layer = h("div", { class: "settings-layer" }, h("div", { class: "scrim", onclick: close }), panel);
  document.body.append(layer);
  requestAnimationFrame(() => layer.classList.add("open"));
  if (focus === "feed") {
    feedInput.scrollIntoView({ block: "center" });
    feedInput.focus();
  } else panel.querySelector("input")?.focus();
}

const placeName = (p) => [p.name, p.admin && p.admin !== p.name ? p.admin : "", p.country].filter(Boolean).join(", ");
