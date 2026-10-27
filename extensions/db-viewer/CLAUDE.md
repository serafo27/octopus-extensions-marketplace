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
  `notifications` (true for the Mac's notifications),
  `shared` (ids of the extensions whose shared data it reads), `helpers` (programs it runs on the Mac, below).
  When they grow, Octopus asks the user again before the extension runs. Ask only for what's needed.
- **Name the extensions it needs** in `manifest.json` `dependencies`: `{ "calendar": "1.2.0" }` (the
  oldest version that will do; `"*"` for any). Installing it from a marketplace installs them too, after
  asking the user. They may still be missing (or turned off): check `octopus.extensions.list()` and say so.
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
const { extension, product, theme, projects, workProjectId } = await octopus.ready(); // wait before anything else
// `product`: { id, name } of the Octopus it runs in ("octopus", or a company's build of it, beside it on one Mac).

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
// A conversation: each turn continues the last (`claude --resume`). Claude reads the files of this folder
// only and uses skills, but can't run commands, edit files or reach the web: give it data, or let it
// ask the page for it in its reply.
let { text, session } = await octopus.claude.chat("…", { model: "sonnet", system: "You are…" });
({ text, session } = await octopus.claude.chat("and then?", { session, system: "You are…" }));
// A Claude Code session in a project's terminals, with this prompt (default: the work project); resolves with
// its terminal id. `background: true` opens it without leaving the extension (show it later with terminals.reveal).
const termId = await octopus.claude.open("Investigate …", { projectId, title: "Log investigation", background: true });
// Another Claude account than the project's: an `id` from `accounts` as `account` (also for `ask` and `chat`).
const accounts = await octopus.claude.accounts(); // [{ id, name, configDir, current }], the default (~/.claude) first
await octopus.claude.open("…", { projectId, account: accounts[1].id });

const list = await octopus.projects.list();   // [{ id, name, path, color }]
const tasks = await octopus.tasks.list({ projectId }); // [{ id, projectId, title, status, priority, tags,
                                              //    blocked, blockedReason, archived }]
const task = await octopus.tasks.create({ title, body: "Markdown", projectId, priority: 2, tags: ["logs"] });
// Only what's given changes. status: "todo" | "doing" | "review" | "done"; only a done task can be archived.
await octopus.tasks.update(task.id, { status: "doing", blocked: true, blockedReason: "Waiting for QA" });
await octopus.tasks.reveal(task.id);          // shows it on its board

// A branch's changes against the branch it goes into, shown on the Review page of the project's Git tab
// (no permission: only the user sees the code). Defaults: the work project, the checked-out branch, and
// the remote's default branch (main, master). Resolves with { branch, target }.
await octopus.git.review({ projectId, branch: "feature/dark-mode", target: "main" });

// Octopus's own terminals (permissions.terminals), read-only: the page can't type into them.
// `state`: "working" (Claude is on a turn, a shell prints), "idle", "waiting" (it rang for the user),
// "ended". Claude's comes from Claude Code itself; a shell's from its output in the last seconds.
const terms = await octopus.terminals.list(); // [{ id, projectId, taskId, title, kind: "claude" | "shell",
                                              //    state, exitCode, startedAt, lastOutputAt, floating }]
const text = await octopus.terminals.read(terms[0].id, { lines: 300 }); // what it shows, as text (scrollback
                                              // included); null when it's in a window of its own (`floating`)
octopus.on("terminals", (list) => {});        // one opened, closed, or changed state, title or task
await octopus.terminals.reveal(termId);       // shows it in its project's Terminals, focused
await octopus.terminals.close(termId);        // kills it: only a session this extension opened (claude.open)
// That session's terminal itself in the page, over an element (Octopus draws it there and follows the element's
// box; the user types in it, the page still can't). Only in the section; `dispose` gives it back to its project.
const view = await octopus.terminals.embed(termId, document.getElementById("term")); view.focus(); view.dispose();

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

// A page of the extension in a window of its own, to keep beside other apps (asked again: it comes forward).
// The page there has the same SDK; `octopus.window.detached` (and `ready()`'s `detached`) is true in it.
await octopus.window.open("reader.html", { title: "News", width: 460, height: 780, alwaysOnTop: false });
octopus.window.close();                       // from inside such a window
// The Mac's notifications (permissions.notifications), sent as Octopus (its icon). The first asks the user to
// allow them. A later one with the same `id` replaces it; a click shows the extension and sends the `id` back.
await octopus.notify({ title: "Build #12", subtitle: "Failed: tests", body: "3 tests failed", sound: true, id: "run:12" });
octopus.on("notification", ({ id }) => {});    // one with that `id` was clicked
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

// Programs of the extension run on the Mac (permissions.helpers), e.g. a local server the page calls with
// http.fetch (its address in permissions.http): [{ "id": "server", "command": ["python3", "server.py"],
// "keepAlive": false }]. Run in this folder through the user's login shell; the user allows each command, and
// is asked again when it or a file of this folder it names changes. Octopus stops them when the extension is
// turned off or removed, and when it quits; `keepAlive` starts one again when it stops on its own. Helpers (and
// the terminals Octopus opens) get OCTOPUS_PRODUCT (ready()'s product.id) and OCTOPUS_HOME (e.g. ~/.octopus):
// keep a helper's state, and pick its port, by them, so another product's copy of the extension doesn't clash.
const st = await octopus.helpers.start("server"); // { id, running, pid, startedAt, endedAt, exitCode, restarts, gaveUp }
await octopus.helpers.stop("server");          // SIGTERM to it and what it started, SIGKILL a few seconds later
const all = await octopus.helpers.status();     // every declared helper's status (one: status("server"))
const out = await octopus.helpers.log("server", { lines: 100 }); // its output since it last started
octopus.on("helpers", (status) => {});         // one started, stopped or ended
```

`localStorage` works too, but Octopus's storage is the one that lasts.

## A website as it is

To show a site itself (WhatsApp Web, Slack) rather than a page of your own, set `permissions.webapp` to its
https address: Octopus shows it in a webview of its own over the section, signed in with a profile of its
own, and counts what's unread from its title. For several, make it a list of
`{ "id": "telegram", "name": "Telegram", "url": "https://web.telegram.org/a/", "color": "#229ED9" }` (`icon`
a codicon instead of the coloured initial; `userAgent` `"chrome"` for a site that calls Safari unsupported):
the user pins the ones they use as tabs. `index.html` is then only what an older Octopus shows, and
the SDK isn't there: the site can't reach Octopus, nor Octopus the site's content.
