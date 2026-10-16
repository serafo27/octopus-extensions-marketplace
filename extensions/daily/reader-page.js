// The newspaper in a window of its own (octopus.window.open("reader.html"), from the Detach button in
// reader.js): the same reader as on the board, filling the window, with its own copy of the headlines.
// Where to open (story, tab) comes from storage ("readerAt"), set by the board just before it asks for the
// window; asked again while the window is open, the window comes forward and shows the new story.

import { loadSettings } from "./settings.js";
import { news as getNews, sources, forgetNews } from "./services.js";
import { openReader, updateReader, showStory } from "./reader.js";

const S = { settings: null, news: {}, loading: false };

const shownSources = () => sources(S.settings).filter((src) => S.settings.news[src.id]);
const items = () => shownSources().flatMap((src) => (S.news[src.id]?.items || []).map((x) => ({ ...x, source: src.id })));

/** Reads the settings again (sources added on the board show here too), then the feeds (kept 20 minutes). */
async function load() {
  S.loading = true;
  updateReader();
  S.settings = await loadSettings();
  await Promise.all(
    shownSources().map(async (src) => {
      try {
        S.news[src.id] = { items: await getNews(src) };
      } catch (e) {
        S.news[src.id] = { error: e.message };
      }
    }),
  );
  S.loading = false;
  updateReader();
}

await octopus.ready();
await load();
let at = (await octopus.storage.get("readerAt").catch(() => null)) || {};
document.querySelector(".empty")?.remove();
openReader(at.link, {
  items,
  sources: shownSources,
  loading: () => S.loading,
  refresh: () => (forgetNews(), load()),
  detached: true,
  tab: at.tab,
});

// Brought forward by another click on Detach: the story asked for then. The page can't tell when its
// window comes forward (the focus stays outside the frame), so it looks every couple of seconds.
setInterval(async () => {
  const now = await octopus.storage.get("readerAt").catch(() => null);
  if (!now || now.at === at.at) return;
  at = now;
  showStory(at.link, at.tab);
}, 2000);

setInterval(load, 5 * 60_000);
