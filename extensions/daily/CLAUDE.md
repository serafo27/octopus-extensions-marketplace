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
  call `octopus.claude.*`), `tasks` (true to read or create tasks), `docs` (true to write Markdown and
  SVG files in projects' documentation folders), `shared` (ids of the extensions whose shared data it
  reads). When they grow, Octopus asks the user again before the extension runs. Ask only for what's needed.
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
  `output`, `search`, `beaker`.

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

// Documentation (permissions.docs): a Markdown or SVG file inside a project's documentation folder
// (default: the work project's), e.g. a report and the charts it shows (`![Volume](volume.svg)`).
// Resolves with its path from the project root; an existing file is kept unless `overwrite: true`.
const path = await octopus.docs.write("logs/2026-10-08-checkout.md", markdown, { projectId, overwrite: false });
await octopus.docs.open(path, { projectId });  // shows it in the project's Documentation tab

await octopus.storage.set("savedQueries", [...]); // JSON, kept by Octopus for this extension
const saved = await octopus.storage.get("savedQueries"); // null if never set

octopus.toast("Copied", "info");              // tones: info, success, error
octopus.copy(text);                           // to the clipboard
octopus.openUrl("https://…");                 // in the browser
octopus.on("theme", (theme) => {});           // colours already applied; redraw canvases/charts
octopus.on("visible", (shown) => {});         // the section was shown or hidden

// Other extensions. `list` needs no permission; reading what one shares needs its id in permissions.shared.
const exts = await octopus.extensions.list();  // [{ id, name, icon, version, enabled, ok }]
await octopus.shared.set("events", [...]);       // published for the extensions allowed to read it
const events = await octopus.shared.get("calendar", "events"); // null if nothing shared under that key
octopus.on("shared", ({ extension, key }) => {}); // something it reads changed
octopus.on("extensions", (list) => {});        // installed, removed, turned on or off
```

`localStorage` works too, but Octopus's storage is the one that lasts.
