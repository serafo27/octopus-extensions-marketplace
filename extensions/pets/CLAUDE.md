# An Octopus extension

This folder is an extension of Octopus, a desktop work hub: a section of its own in Octopus's
activity bar, shown full screen. Octopus loads `index.html` from `ext://<folder name>/` in an
iframe and reloads it every time a file here changes, so the user sees your work as you save.
What the extension should do is in `manifest.json` (`description`) and in what the user asks you.

## Rules

- **Plain files, no build step.** HTML, CSS and ES modules (`<script type="module">`) loaded as they
  are. No npm, no bundler, no CDN. A library is fine only as a file copied into this folder (e.g.
  `vendor/chart.umd.js`), and only when hand-written code would be much worse.
- **No network but `octopus.http.fetch`.** The page runs under a CSP that only allows its own files:
  `fetch()` to other hosts, CDN scripts, and remote images fail. Requests go through Octopus, and only
  to the URL prefixes listed in `manifest.json` `permissions.http`.
- **Declare what you use** in `manifest.json` `permissions`: `http` (URL prefixes), `claude` (true to
  call `octopus.claude.*`), `tasks` (true to read or create tasks), `terminals` (true to see Octopus's
  terminals, read-only), `docs` (true to write Markdown and
  SVG files in projects' documentation folders), `statusBar` (true for an item in the Mac's menu bar),
  `shared` (ids of the extensions whose shared data it reads). When they grow, Octopus asks the user
  again before the extension runs. Ask only for what's needed.
- **Only this folder.** Never change Octopus itself (its app or its source code, wherever it is): the
  SDK below is all an extension gets. If something it needs is missing, say so to the user and stop.
- **Look like Octopus.** Link `/__octopus/base.css` (already in `index.html`) and use its CSS variables
  for every colour: `--bg-editor`, `--bg-widget`, `--bg-input`, `--bg-hover`, `--bg-selected`,
  `--border`, `--fg`, `--fg-strong`, `--fg-muted`, `--fg-faint`, `--accent`, `--link`, `--error`,
  `--warn`, `--success`, `--hl-*` (syntax colours: `--hl-keyword`, `--hl-string`, `--hl-number`, …),
  and `--radius-*`, `--font-ui`, `--font-mono`. Octopus sets them as its theme changes (light or
  dark): never hard-code colours. Classes ready to use: `button.primary`, `button.ghost`, `.card`,
  `.badge` (`.error`, `.warn`, `.success`), `.toolbar`, `.muted`, `.faint`, `.mono`, `.spinner`.
  Dense, quiet UI like VS Code's: 13px text, small paddings, no big headers or marketing copy.
- English for UI copy, code and comments.
- `manifest.json` also sets `name`, `description` and `icon`: a codicon name
  (https://microsoft.github.io/vscode-codicons/dist/codicon.html), e.g. `pulse`, `graph`, `database`,
  `output`, `search`, `beaker`. `stage` is `"alpha"` or `"beta"` while it isn't finished (Octopus shows
  it as a label in the list and the marketplace); leave it out once it is.

## The SDK: `window.octopus` (from `/__octopus/sdk.js`)

Every call returns a promise and rejects with an `Error` whose message says why.

```js
const { extension, theme, projects, workProjectId } = await octopus.ready(); // wait before anything else

// HTTP, to a prefix in permissions.http. Made by Octopus: the Mac's network (VPN) applies, no CORS.
// Any status resolves; only a failure to connect rejects. Up to 64 MB.
const res = await octopus.http.fetch("http://host/api?x=1", {
  method: "GET",          // default
  headers: { "X-Org": "a" },
  body: { any: "json" },  // or a string
  timeoutMs: 60000,
});
res.status; res.ok; res.headers; res.text(); res.json();
// Images and other binary files: `binary: true`, then `res.dataUrl()` for an <img> (data: is allowed).
const img = await octopus.http.fetch("https://host/pic.jpg", { binary: true }); el.src = img.dataUrl();

// Claude Code without a terminal (`claude -p` in this folder, in the Claude account of the project
// being worked on, with that account's plugins and skills). Takes 5-30 s: show progress. Ask for JSON
// and parse it when you need data; `model: "sonnet"` or `"haiku"` answer faster.
const answer = await octopus.claude.ask("…", { model: "sonnet" }); // model optional
// A conversation: each turn continues the last (`claude --resume`). Claude reads files and uses skills
// there, but can't run commands or edit files: give it data, or let it ask the page for it in its reply.
let { text, session } = await octopus.claude.chat("…", { model: "sonnet", system: "You are…" });
({ text, session } = await octopus.claude.chat("and then?", { session, system: "You are…" }));
// A Claude Code session in a project's terminals, with this prompt (default: the work project).
await octopus.claude.open("Investigate …", { projectId, title: "Log investigation" });

const list = await octopus.projects.list();   // [{ id, name, path, color }]
const tasks = await octopus.tasks.list({ projectId }); // [{ id, projectId, title, status, priority, tags }]
const task = await octopus.tasks.create({ title, body: "Markdown", projectId, priority: 2, tags: ["logs"] });
await octopus.tasks.reveal(task.id);          // shows it on its board

// Octopus's own terminals (permissions.terminals), read-only: nothing can be typed into them.
// `state`: "working" (Claude is on a turn, a shell prints), "idle", "waiting" (it rang for the user),
// "ended". Claude's comes from Claude Code itself; a shell's from its output in the last seconds.
const terms = await octopus.terminals.list(); // [{ id, projectId, taskId, title, kind: "claude" | "shell",
                                              //    state, exitCode, startedAt, lastOutputAt, floating }]
const text = await octopus.terminals.read(terms[0].id, { lines: 300 }); // what it shows, as text; null if floating
octopus.on("terminals", (list) => {});        // one opened, closed, or changed state, title or task

// Documentation (permissions.docs): a Markdown or SVG file inside a project's documentation folder
// (default: the work project's), e.g. a report and the charts it shows (`![Volume](volume.svg)`).
// Resolves with its path from the project root; an existing file is kept unless `overwrite: true`.
const path = await octopus.docs.write("logs/2026-10-08-checkout.md", markdown, { projectId, overwrite: false });
await octopus.docs.open(path, { projectId });  // shows it in the project's Documentation tab

await octopus.storage.set("savedQueries", [...]); // JSON, kept by Octopus for this extension
const saved = await octopus.storage.get("savedQueries"); // null if never set

// The Mac's menu bar (permissions.statusBar): an item of its own, from a timeline Octopus follows by
// itself, also while the page is hidden (an extension with it is loaded when Octopus starts). The first
// entry with `from <= now < to` shows; `{remaining}` is the time left until its `to` ("5m", "1h 20m").
// `color` "#rrggbb" draws a pill before the text, `url` is offered in its menu. Gives the next hours.
await octopus.statusBar.set([
  { text: "[Standup] in {remaining}", from: start - 15 * 60e3, to: start, color: "#5b8def", url },
  { text: "[Standup] {remaining} left", from: start, to: end, color: "#5b8def", url },
]);
// A click opens a menu: give its rows. A click on a row opens its `url`, sends its `id` to the page
// ("statusBar" event) and shows the extension when `show: true` (or when the row has neither). `color` draws
// a bar before the text (`bar`: "solid", "striped", "outline"); `icon` an image instead (a file here or a
// data: URL; `iconTemplate: true` draws it in the menu's text colour). `checked`, `shortcut` ("Cmd+1"),
// `disabled`, `items` (a submenu, two levels). `{remaining}` in a row counts down to its `to`, also while open.
await octopus.statusBar.set(entries, { menu: [
  { text: "Upcoming in {remaining}", header: true, to: start },
  { text: "2:30 PM · Standup", color: "#5b8def", id: "event:42", show: true, items: [{ text: "Copy link", id: "copy:42" }] },
  { text: "Join Google Meet meeting", icon: "icons/meet.svg", url },
  { separator: true },
  { text: "Settings…", id: "settings", show: true, shortcut: "Cmd+," },
] });
octopus.on("statusBar", ({ id }) => {});       // a row with that `id` was clicked
await octopus.statusBar.clear();               // no item

octopus.toast("Copied", "info");              // tones: info, success, error
octopus.copy(text);                           // to the clipboard
octopus.openUrl("https://…");                 // in the browser
octopus.on("theme", (theme) => {});           // colours already applied; redraw canvases/charts
octopus.on("visible", (shown) => {});         // the section was shown or hidden

// Other extensions. `list` needs no permission; reading what one shares needs its id in permissions.shared.
const exts = await octopus.extensions.list();  // [{ id, name, icon, version, stage, enabled, ok }]
await octopus.shared.set("events", [...]);       // published for the extensions allowed to read it
const events = await octopus.shared.get("calendar", "events"); // null if nothing shared under that key
octopus.on("shared", ({ extension, key }) => {}); // something it reads changed
octopus.on("extensions", (list) => {});        // installed, removed, turned on or off
```

`localStorage` works too, but Octopus's storage is the one that lasts.
