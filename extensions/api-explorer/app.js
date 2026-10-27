import { state, load, save, uid, newRequest, findNode, cloneNode, activeEnv, addHistory, METHODS } from "./store.js";
import { h, prompt, confirmBox, menu, dragger, formatBytes, formatMs, tabIndent, pickFiles, download } from "./ui.js";
import { kvEditor } from "./kv.js";
import {
  scope, isDynamic, prepare, send, toCurl, fromCurl, looksLikeCurl, effectiveAuth,
  paramsFromUrl, urlFromParams, statusText,
} from "./http.js";
import { fromPostman, toPostman, envToPostman } from "./postman.js";
import { prettyJson, prettyMarkup } from "./highlight.js";
import { varField } from "./varfield.js";

await octopus.ready();
await load();

const $ = (id) => document.getElementById(id);
const clone = (x) => structuredClone(x);
const ui = state.ui;
let sideFilter = "";

// --- Layout ---------------------------------------------------------------------------------------

function applyLayout() {
  document.documentElement.style.setProperty("--side-w", ui.sideWidth + "px");
}
dragger($("vsplit"), (x) => {
  ui.sideWidth = Math.max(180, Math.min(520, x));
  applyLayout();
}, () => save("ui"));
applyLayout();

// --- Sidebar --------------------------------------------------------------------------------------

const SIDES = [
  ["collections", "Collections"],
  ["environments", "Environments"],
  ["history", "History"],
];

function renderSide() {
  $("side-tabs").replaceChildren(
    ...SIDES.map(([id, label]) =>
      h("button", { class: "side-tab" + (ui.side === id ? " on" : ""), onclick: () => ((ui.side = id), save("ui"), renderSide()) }, label),
    ),
  );
  const filter = h("input", {
    type: "search",
    placeholder: "Filter…",
    value: sideFilter,
    spellcheck: false,
    oninput: () => {
      sideFilter = filter.value;
      renderSideBody();
    },
  });
  const tools = [filter];
  if (ui.side === "collections")
    tools.push(
      h("button", { class: "ghost icon", title: "New collection", onclick: newCollection }, "+"),
      h("button", { class: "ghost small", title: "Import Postman collections and environments, or a curl command", onclick: importDialog }, "Import"),
    );
  if (ui.side === "environments")
    tools.push(
      h("button", { class: "ghost icon", title: "New environment", onclick: newEnvironment }, "+"),
      h("button", { class: "ghost small", title: "Import a Postman environment", onclick: importDialog }, "Import"),
    );
  if (ui.side === "history")
    tools.push(
      h("button", {
        class: "ghost small",
        disabled: !state.history.length,
        onclick: async () => {
          if (!(await confirmBox("Clear history", `Remove all ${state.history.length} requests from the history?`, "Clear"))) return;
          state.history = [];
          save("history");
          renderSide();
        },
      }, "Clear"),
    );
  $("side-tools").replaceChildren(...tools);
  renderSideBody();
}

function renderSideBody() {
  const body = $("side-body");
  if (ui.side === "collections") body.replaceChildren(...collectionsTree());
  else if (ui.side === "environments") body.replaceChildren(...environmentsList());
  else body.replaceChildren(...historyList());
}

const methodBadge = (m) => h("span", { class: "method m-" + m }, m === "DELETE" ? "DEL" : m === "OPTIONS" ? "OPT" : m);

function activeNodeId() {
  return state.tabs.find((t) => t.id === state.activeTab)?.nodeId;
}

function collectionsTree() {
  if (!state.collections.length)
    return [
      h("div", { class: "side-empty" },
        h("p", { class: "muted" }, "No collections yet."),
        h("div", { class: "toolbar" },
          h("button", { class: "primary", onclick: newCollection }, "New collection"),
          h("button", { onclick: importDialog }, "Import"))),
    ];
  const f = sideFilter.trim().toLowerCase();
  const matches = (n) => n.type === "request" && (n.name.toLowerCase().includes(f) || n.req.url.toLowerCase().includes(f));
  const visible = (n) => !f || matches(n) || (n.items ?? []).some(visible) || n.name.toLowerCase().includes(f);
  const active = activeNodeId();
  const rows = [];
  const walk = (n, depth) => {
    if (!visible(n)) return;
    const container = !!n.items;
    const open = f ? true : (ui.expanded[n.id] ?? n.type === "collection");
    const row = h(
      "div",
      {
        class: "node" + (n.id === active ? " active" : "") + (n.type === "collection" ? " coll" : ""),
        style: { paddingLeft: 6 + depth * 12 + "px" },
        draggable: true,
        onclick: () => {
          if (container) {
            ui.expanded[n.id] = !open;
            save("ui");
            renderSideBody();
          } else openNode(n.id);
        },
        ondblclick: () => {
          if (container) openContainer(n.id);
          else {
            const t = state.tabs.find((t) => t.nodeId === n.id);
            if (t) (t.preview = false), renderTabs();
          }
        },
        oncontextmenu: (e) => (e.preventDefault(), nodeMenu(n, e.clientX, e.clientY)),
        ondragstart: (e) => {
          e.dataTransfer.setData("text/x-node", n.id);
          e.dataTransfer.effectAllowed = "move";
        },
        ondragover: (e) => {
          if (![...e.dataTransfer.types].includes("text/x-node")) return;
          e.preventDefault();
          row.classList.add(container ? "drop-in" : "drop-before");
        },
        ondragleave: () => row.classList.remove("drop-in", "drop-before"),
        ondrop: (e) => {
          e.preventDefault();
          row.classList.remove("drop-in", "drop-before");
          moveNode(e.dataTransfer.getData("text/x-node"), n);
        },
      },
      container ? h("span", { class: "chev" + (open ? " open" : "") }) : methodBadge(n.req.method),
      h("span", { class: "node-name" }, n.name),
      h("button", { class: "ghost icon small more", title: "More", onclick: (e) => (e.stopPropagation(), nodeMenu(n, e.clientX, e.clientY)) }, "…"),
    );
    rows.push(row);
    if (container && open) {
      if (!n.items.length && !f) rows.push(h("div", { class: "node-empty faint", style: { paddingLeft: 24 + depth * 12 + "px" } }, "Empty"));
      for (const c of n.items) walk(c, depth + 1);
    }
  };
  for (const c of state.collections) walk(c, 0);
  if (!rows.length) rows.push(h("div", { class: "side-empty faint" }, "Nothing matches."));
  return rows;
}

function nodeMenu(n, x, y) {
  const items = [];
  if (n.items) {
    items.push(
      { label: "New request", action: () => newRequestIn(n) },
      { label: "New folder", action: () => newFolderIn(n) },
      { label: n.type === "collection" ? "Auth & variables…" : "Auth…", action: () => openContainer(n.id) },
      "-",
    );
  } else {
    items.push(
      { label: "Open in new tab", action: () => openNode(n.id, { pin: true }) },
      { label: "Copy as cURL", action: () => copyCurl(n.req, findNode(n.id)) },
      "-",
    );
  }
  items.push({ label: "Rename…", action: () => renameNode(n) }, { label: "Duplicate", action: () => duplicateNode(n) });
  if (n.type !== "collection") items.push({ label: "Move to…", action: () => moveDialog(n) });
  if (n.type === "collection") items.push({ label: "Export (Postman v2.1)", action: () => exportCollection(n) });
  items.push("-", { label: "Delete", danger: true, action: () => deleteNode(n) });
  menu(x, y, items);
}

function containers(exclude) {
  const out = [];
  const walk = (n, path) => {
    if (n.id === exclude) return;
    out.push({ value: n.id, label: [...path, n.name].join(" / ") });
    for (const c of n.items) if (c.items) walk(c, [...path, n.name]);
  };
  state.collections.forEach((c) => walk(c, []));
  return out;
}

async function newCollection() {
  const v = await prompt("New collection", [{ name: "name", label: "Name", value: "New collection" }], { ok: "Create" });
  if (!v?.name.trim()) return;
  const c = { id: uid(), type: "collection", name: v.name.trim(), items: [], variables: [], auth: { type: "none" } };
  state.collections.push(c);
  ui.side = "collections";
  save("collections", "ui");
  renderSide();
}

async function newRequestIn(parent) {
  const v = await prompt("New request", [{ name: "name", label: "Name", value: "New request" }], { ok: "Create" });
  if (!v?.name.trim()) return;
  const n = { id: uid(), type: "request", name: v.name.trim(), req: newRequest() };
  parent.items.push(n);
  ui.expanded[parent.id] = true;
  save("collections", "ui");
  renderSide();
  openNode(n.id, { pin: true });
}

async function newFolderIn(parent) {
  const v = await prompt("New folder", [{ name: "name", label: "Name", value: "New folder" }], { ok: "Create" });
  if (!v?.name.trim()) return;
  parent.items.push({ id: uid(), type: "folder", name: v.name.trim(), items: [], auth: { type: "inherit" } });
  ui.expanded[parent.id] = true;
  save("collections", "ui");
  renderSide();
}

async function renameNode(n) {
  const v = await prompt("Rename", [{ name: "name", label: "Name", value: n.name }], { ok: "Rename" });
  if (!v?.name.trim()) return;
  n.name = v.name.trim();
  save("collections");
  renderAll();
}

function duplicateNode(n) {
  const c = cloneNode(n);
  c.name = n.name + " copy";
  if (n.type === "collection") state.collections.splice(state.collections.indexOf(n) + 1, 0, c);
  else {
    const { parent } = findNode(n.id);
    parent.items.splice(parent.items.indexOf(n) + 1, 0, c);
  }
  save("collections");
  renderSide();
}

async function deleteNode(n) {
  const what = n.items ? `“${n.name}” and everything in it` : `“${n.name}”`;
  if (!(await confirmBox("Delete " + n.type, `Delete ${what}? This can't be undone.`))) return;
  const ids = new Set();
  const collect = (x) => (ids.add(x.id), x.items?.forEach(collect));
  collect(n);
  if (n.type === "collection") state.collections.splice(state.collections.indexOf(n), 1);
  else {
    const { parent } = findNode(n.id);
    parent.items.splice(parent.items.indexOf(n), 1);
  }
  // Open requests stay, unsaved; settings tabs of what's gone close.
  state.tabs = state.tabs.filter((t) => !(t.kind === "container" && ids.has(t.nodeId)));
  for (const t of state.tabs) if (ids.has(t.nodeId)) (t.nodeId = null), (t.dirty = true);
  if (!state.tabs.find((t) => t.id === state.activeTab)) state.activeTab = state.tabs[0]?.id ?? null;
  save("collections", "tabs");
  renderAll();
}

function isInside(id, n) {
  return n.id === id || (n.items ?? []).some((c) => isInside(id, c));
}

/** Drop of node `id` on `target`: into it when it's a folder/collection, before it otherwise. */
function moveNode(id, target) {
  const src = findNode(id);
  if (!src || id === target.id || src.node.type === "collection" || isInside(target.id, src.node)) return;
  src.parent.items.splice(src.parent.items.indexOf(src.node), 1);
  if (target.items) {
    target.items.push(src.node);
    ui.expanded[target.id] = true;
  } else {
    const { parent } = findNode(target.id);
    parent.items.splice(parent.items.indexOf(target), 0, src.node);
  }
  save("collections", "ui");
  renderAll();
}

async function moveDialog(n) {
  const options = containers(n.id).filter((o) => !isInside(o.value, n));
  const v = await prompt("Move “" + n.name + "”", [{ name: "to", label: "To", options, value: findNode(n.id).parent.id }], { ok: "Move" });
  if (!v) return;
  moveNode(n.id, findNode(v.to).node);
}

function exportCollection(c) {
  const text = JSON.stringify(toPostman(c), null, 2);
  octopus.copy(text);
  download(c.name.replace(/[^\w.-]+/g, "_") + ".postman_collection.json", text);
  octopus.toast("Collection copied as Postman v2.1 JSON", "success");
}

// Environments

function environmentsList() {
  if (!state.environments.length)
    return [
      h("div", { class: "side-empty" },
        h("p", { class: "muted" }, "Environments hold variables like {{baseUrl}} or {{token}}, used in URLs, headers, bodies and auth."),
        h("button", { class: "primary", onclick: newEnvironment }, "New environment")),
    ];
  const f = sideFilter.trim().toLowerCase();
  const openId = state.tabs.find((t) => t.id === state.activeTab)?.envId;
  return state.environments
    .filter((e) => !f || e.name.toLowerCase().includes(f))
    .map((e) =>
      h(
        "div",
        {
          class: "node" + (e.id === openId ? " active" : ""),
          onclick: () => openEnv(e.id),
          oncontextmenu: (ev) => (ev.preventDefault(), envMenu(e, ev.clientX, ev.clientY)),
        },
        h("span", {
          class: "env-dot" + (e.id === state.activeEnv ? " on" : ""),
          title: e.id === state.activeEnv ? "Active" : "Make active",
          onclick: (ev) => (ev.stopPropagation(), setActiveEnv(e.id === state.activeEnv ? null : e.id)),
        }),
        h("span", { class: "node-name" }, e.name),
        h("span", { class: "faint small-text" }, e.variables.length),
        h("button", { class: "ghost icon small more", onclick: (ev) => (ev.stopPropagation(), envMenu(e, ev.clientX, ev.clientY)) }, "…"),
      ),
    );
}

function envMenu(e, x, y) {
  menu(x, y, [
    { label: e.id === state.activeEnv ? "Deactivate" : "Set active", action: () => setActiveEnv(e.id === state.activeEnv ? null : e.id) },
    { label: "Rename…", action: async () => {
      const v = await prompt("Rename", [{ name: "name", label: "Name", value: e.name }], { ok: "Rename" });
      if (!v?.name.trim()) return;
      e.name = v.name.trim();
      save("environments");
      renderAll();
    } },
    { label: "Duplicate", action: () => {
      state.environments.push({ ...clone(e), id: uid(), name: e.name + " copy" });
      save("environments");
      renderAll();
    } },
    { label: "Export (Postman)", action: () => {
      const text = JSON.stringify(envToPostman(e), null, 2);
      octopus.copy(text);
      download(e.name.replace(/[^\w.-]+/g, "_") + ".postman_environment.json", text);
      octopus.toast("Environment copied as Postman JSON", "success");
    } },
    "-",
    { label: "Delete", danger: true, action: async () => {
      if (!(await confirmBox("Delete environment", `Delete “${e.name}”?`))) return;
      state.environments.splice(state.environments.indexOf(e), 1);
      if (state.activeEnv === e.id) state.activeEnv = null;
      state.tabs = state.tabs.filter((t) => t.envId !== e.id);
      if (!state.tabs.find((t) => t.id === state.activeTab)) state.activeTab = state.tabs[0]?.id ?? null;
      save("environments", "activeEnv", "tabs");
      renderAll();
    } },
  ]);
}

async function newEnvironment() {
  const v = await prompt("New environment", [{ name: "name", label: "Name", value: "Local" }], { ok: "Create" });
  if (!v?.name.trim()) return;
  const e = { id: uid(), name: v.name.trim(), variables: [] };
  state.environments.push(e);
  if (!state.activeEnv) state.activeEnv = e.id;
  ui.side = "environments";
  save("environments", "activeEnv", "ui");
  renderSide();
  renderEnvSelect();
  openEnv(e.id);
}

function setActiveEnv(id) {
  state.activeEnv = id;
  save("activeEnv");
  renderEnvSelect();
  renderSideBody();
  renderPane();
}

// History

function historyList() {
  if (!state.history.length) return [h("div", { class: "side-empty faint" }, "Requests you send show up here.")];
  const f = sideFilter.trim().toLowerCase();
  const out = [];
  let day = null;
  for (const it of state.history) {
    if (f && !(it.req.url.toLowerCase().includes(f) || it.req.method.toLowerCase().includes(f))) continue;
    const d = new Date(it.at);
    const label = dayLabel(d);
    if (label !== day) out.push(h("div", { class: "side-group" }, (day = label)));
    out.push(
      h(
        "div",
        {
          class: "node hist",
          title: it.req.url + "\n" + d.toLocaleString(),
          onclick: () => openReq(clone(it.req)),
          oncontextmenu: (e) => {
            e.preventDefault();
            menu(e.clientX, e.clientY, [
              { label: "Open", action: () => openReq(clone(it.req)) },
              { label: "Save to collection…", action: () => saveAs({ req: clone(it.req) }) },
              "-",
              { label: "Remove", danger: true, action: () => {
                state.history.splice(state.history.indexOf(it), 1);
                save("history");
                renderSideBody();
              } },
            ]);
          },
        },
        methodBadge(it.req.method),
        h("span", { class: "node-name" }, it.req.url || "(no URL)"),
        h("span", { class: "hist-status " + statusClass(it.status) }, it.status),
      ),
    );
  }
  if (!out.length) out.push(h("div", { class: "side-empty faint" }, "Nothing matches."));
  return out;
}

function dayLabel(d) {
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const statusClass = (s) => (typeof s !== "number" ? "error" : s < 300 ? "success" : s < 400 ? "warn" : "error");

// --- Tabs -----------------------------------------------------------------------------------------

function tabTitle(t) {
  if (t.kind === "env") return state.environments.find((e) => e.id === t.envId)?.name ?? "Environment";
  if (t.kind === "container") return findNode(t.nodeId)?.node.name ?? "Settings";
  if (t.nodeId) return findNode(t.nodeId)?.node.name ?? t.name;
  return t.req.url.replace(/^https?:\/\//, "") || "Untitled request";
}

function renderTabs() {
  $("tabs").replaceChildren(
    ...state.tabs.map((t) => {
      const el = h(
        "div",
        {
          class: "tab" + (t.id === state.activeTab ? " on" : "") + (t.preview ? " preview" : ""),
          title: t.kind === "request" ? t.req.method + " " + t.req.url : tabTitle(t),
          onclick: () => activate(t.id),
          ondblclick: () => ((t.preview = false), renderTabs()),
          onauxclick: (e) => e.button === 1 && closeTab(t.id),
          oncontextmenu: (e) => {
            e.preventDefault();
            menu(e.clientX, e.clientY, [
              { label: "Close", action: () => closeTab(t.id) },
              { label: "Close others", action: () => closeTabs(state.tabs.filter((x) => x.id !== t.id)) },
              { label: "Close all", action: () => closeTabs([...state.tabs]) },
              ...(t.kind === "request" ? ["-", { label: "Duplicate", action: () => openReq(clone(t.req)) }] : []),
            ]);
          },
        },
        t.kind === "request" ? methodBadge(t.req.method) : h("span", { class: "tab-kind" }, t.kind === "env" ? "ENV" : "⚙"),
        h("span", { class: "tab-name" }, tabTitle(t)),
        t.dirty && t.nodeId ? h("span", { class: "dirty", title: "Unsaved changes" }) : null,
        h("button", { class: "ghost icon small close", title: "Close", onclick: (e) => (e.stopPropagation(), closeTab(t.id)) }, "×"),
      );
      return el;
    }),
  );
  $("tabs").querySelector(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function activate(id) {
  state.activeTab = id;
  save("activeTab");
  renderTabs();
  renderPane();
  renderSideBody();
}

function addTab(tab, { preview = false } = {}) {
  if (preview) {
    const old = state.tabs.findIndex((t) => t.preview && !t.dirty);
    if (old >= 0) {
      state.tabs[old] = tab;
      tab.preview = true;
      save("tabs");
      return activate(tab.id);
    }
    tab.preview = true;
  }
  const i = state.tabs.findIndex((t) => t.id === state.activeTab);
  state.tabs.splice(i + 1, 0, tab);
  save("tabs");
  activate(tab.id);
}

function openNode(id, { pin = false } = {}) {
  const existing = state.tabs.find((t) => t.kind === "request" && t.nodeId === id);
  if (existing) {
    if (pin) existing.preview = false;
    return activate(existing.id);
  }
  const { node } = findNode(id);
  addTab({ id: uid(), kind: "request", nodeId: id, req: clone(node.req), dirty: false }, { preview: !pin });
}

function openReq(req) {
  addTab({ id: uid(), kind: "request", nodeId: null, req: { ...newRequest(), ...req }, dirty: true });
}

function openContainer(id) {
  const existing = state.tabs.find((t) => t.kind === "container" && t.nodeId === id);
  if (existing) return activate(existing.id);
  addTab({ id: uid(), kind: "container", nodeId: id, sub: "auth" });
}

function openEnv(id) {
  const existing = state.tabs.find((t) => t.kind === "env" && t.envId === id);
  if (existing) return activate(existing.id);
  addTab({ id: uid(), kind: "env", envId: id });
}

async function closeTab(id) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.kind === "request" && t.dirty && t.nodeId && !(await confirmBox("Unsaved changes", `Close “${tabTitle(t)}” without saving?`, "Discard")))
    return;
  closeTabs([t]);
}

function closeTabs(list) {
  const ids = new Set(list.map((t) => t.id));
  let i = state.tabs.findIndex((t) => t.id === state.activeTab);
  state.tabs = state.tabs.filter((t) => !ids.has(t.id));
  if (ids.has(state.activeTab)) state.activeTab = state.tabs[Math.min(i, state.tabs.length - 1)]?.id ?? null;
  save("tabs", "activeTab");
  renderTabs();
  renderPane();
  renderSideBody();
}

$("new-tab").onclick = () => openReq(newRequest());

function renderEnvSelect() {
  const sel = $("env-select");
  sel.replaceChildren(
    h("option", { value: "" }, "No environment"),
    ...state.environments.map((e) => h("option", { value: e.id, selected: e.id === state.activeEnv }, e.name)),
  );
  sel.value = state.activeEnv ?? "";
  sel.onchange = () => setActiveEnv(sel.value || null);
}

// --- Pane -----------------------------------------------------------------------------------------

function currentTab() {
  return state.tabs.find((t) => t.id === state.activeTab) ?? null;
}

function renderPane() {
  const t = currentTab();
  const pane = $("pane");
  if (!t) return pane.replaceChildren(welcome());
  if (t.kind === "env") return pane.replaceChildren(envPane(t));
  if (t.kind === "container") return pane.replaceChildren(containerPane(t));
  pane.replaceChildren(requestPane(t));
}

function welcome() {
  return h(
    "div",
    { class: "welcome" },
    h("div", { class: "welcome-box" },
      h("h2", {}, "API explorer"),
      h("p", { class: "muted" }, "Send HTTP requests to any API, keep them in collections, switch environments."),
      h("div", { class: "toolbar" },
        h("button", { class: "primary", onclick: () => openReq(newRequest()) }, "New request"),
        h("button", { onclick: importDialog }, "Import…")),
      h("ul", { class: "tips faint" },
        h("li", {}, "Paste a curl command into the URL bar to import it."),
        h("li", {}, "Use {{variables}} from the active environment or the collection."),
        h("li", {}, "⌘↵ sends, ⌘S saves, ⌘T opens a new request."))),
  );
}

/** Variables and inherited auth for a tab's request. */
function ctxFor(t) {
  const f = t.nodeId ? findNode(t.nodeId) : null;
  return {
    found: f,
    ancestors: f ? f.ancestors : [],
    vars: scope(activeEnv()?.variables, f?.collection.variables),
  };
}

/** What the {{variable}} highlighting needs (see varfield.js): the active environment, then `collection`. */
function varContext(collection, onChange) {
  const env = activeEnv();
  const find = (list, name) => list?.find((v) => v.key === name && v.enabled !== false);
  return {
    envName: env?.name ?? null,
    collName: collection?.name ?? null,
    lookup(name) {
      const e = find(env?.variables, name);
      if (e) return { value: e.value, source: "env", scopeName: env.name };
      const c = find(collection?.variables, name);
      if (c) return { value: c.value, source: "collection", scopeName: collection.name };
      return isDynamic(name) ? { source: "dynamic" } : null;
    },
    set(name, value) {
      const e = find(env?.variables, name);
      if (e) (e.value = value), save("environments");
      else {
        const c = find(collection?.variables, name);
        if (c) (c.value = value), save("collections");
      }
    },
    add(name, value, where) {
      if (where === "env" && env) env.variables.push({ key: name, value, enabled: true }), save("environments");
      else if (collection) (collection.variables ??= []).push({ key: name, value, enabled: true }), save("collections");
    },
    onChange,
  };
}

function requestPane(t) {
  const req = t.req;
  const ctx = ctxFor(t);
  const changed = () => {
    t.dirty = true;
    t.preview = false;
    save("tabs");
    renderTabs();
    updateCounts();
  };

  // Head: breadcrumb + actions
  const crumbs = ctx.found ? [...ctx.found.ancestors].reverse().map((a) => a.name) : [];
  const head = h(
    "div",
    { class: "req-head" },
    h("div", { class: "crumbs" },
      crumbs.map((c) => [h("span", { class: "faint" }, c), h("span", { class: "faint sep" }, "/")]),
      h("span", { class: "crumb-name" }, ctx.found ? ctx.found.node.name : "Unsaved request")),
    h("div", { class: "grow" }),
    h("button", { class: "ghost small", title: "Copy as cURL", onclick: () => copyCurl(req, ctx.found) }, "cURL"),
    h("button", { class: "small", title: "Save (⌘S)", onclick: () => saveTab(t) }, "Save"),
  );

  // URL bar
  const method = h("select", { class: "method-select m-" + req.method },
    [...new Set([...METHODS, req.method])].map((m) => h("option", { value: m, selected: m === req.method }, m)));
  method.onchange = () => {
    req.method = method.value;
    method.className = "method-select m-" + req.method;
    changed();
  };
  const url = h("input", {
    class: "url mono",
    type: "text",
    value: req.url,
    placeholder: "https://api.example.com/v1/items  — or paste a curl command",
    spellcheck: false,
  });
  url.addEventListener("input", () => {
    req.url = url.value;
    req.params.splice(0, req.params.length, ...paramsFromUrl(req.url, req.params));
    if (ui.reqTab === "params") renderSection();
    changed();
  });
  url.addEventListener("paste", (e) => {
    const text = e.clipboardData.getData("text");
    if (!looksLikeCurl(text)) return;
    e.preventDefault();
    try {
      Object.assign(req, fromCurl(text));
      changed();
      renderPane();
      octopus.toast("Imported from curl", "success");
    } catch (err) {
      octopus.toast(err.message, "error");
    }
  });
  url.addEventListener("keydown", (e) => e.key === "Enter" && sendTab(t));
  const vctx = varContext(ctx.found?.collection);
  const sendBtn = h("button", { class: "primary send", onclick: () => (t.sending ? cancelSend(t) : sendTab(t)) }, t.sending ? "Cancel" : "Send");
  const urlBar = h("div", { class: "url-bar" }, method, varField(url, vctx), sendBtn);

  // Request sections
  const SECTIONS = [["params", "Params"], ["auth", "Auth"], ["headers", "Headers"], ["body", "Body"], ["settings", "Settings"]];
  const counts = {};
  const sectionTabs = h("div", { class: "subtabs" },
    SECTIONS.map(([id, label]) =>
      h("button", { class: "subtab" + (ui.reqTab === id ? " on" : ""), dataset: { id }, onclick: () => {
        ui.reqTab = id;
        save("ui");
        sectionTabs.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
        renderSection();
      } }, label, (counts[id] = h("span", { class: "count" })))));
  const updateCounts = () => {
    const n = (l) => l.filter((x) => x.enabled !== false && x.key).length;
    counts.params.textContent = n(req.params) || "";
    counts.headers.textContent = n(req.headers) || "";
    counts.body.textContent = req.body.mode !== "none" ? "●" : "";
    counts.auth.textContent = req.auth.type !== "none" && req.auth.type !== "inherit" ? "●" : "";
    counts.settings.textContent = Object.keys(req.settings ?? {}).length ? "●" : "";
  };
  const section = h("div", { class: "section" });
  const renderSection = () => {
    if (ui.reqTab === "params")
      section.replaceChildren(kvEditor(req.params, () => {
        req.url = urlFromParams(req.url, req.params);
        url.value = req.url;
        url.paintVars();
        changed();
      }, { keyPh: "Query parameter", vars: vctx }));
    else if (ui.reqTab === "headers")
      section.replaceChildren(
        kvEditor(req.headers, changed, { keyPh: "Header", vars: vctx }),
        h("p", { class: "faint note" }, "Content-Type comes from the body and Authorization from Auth, unless set here."),
      );
    else if (ui.reqTab === "auth") section.replaceChildren(authEditor(req, true, ctx.ancestors, changed, vctx));
    else if (ui.reqTab === "settings") section.replaceChildren(settingsEditor(req, changed));
    else section.replaceChildren(bodyEditor(req, changed, vctx));
  };
  renderSection();
  updateCounts();

  const reqPart = h("div", { class: "req-part", style: { flexBasis: ui.split * 100 + "%" } }, sectionTabs, section);
  const split = h("div", { class: "splitter-h" });
  const resPart = h("div", { class: "res-part", id: "response" });
  const root = h("div", { class: "req-pane" }, head, urlBar, h("div", { class: "req-body" }, reqPart, split, resPart));
  dragger(split, (x, y) => {
    const box = reqPart.parentElement.getBoundingClientRect();
    ui.split = Math.max(0.12, Math.min(0.85, (y - box.top) / box.height));
    reqPart.style.flexBasis = ui.split * 100 + "%";
  }, () => save("ui"));
  renderResponse(t, resPart);
  if (!req.url) setTimeout(() => url.focus());
  return root;
}

function authEditor(holder, allowInherit, ancestors, changed, vctx = null) {
  const root = h("div", { class: "auth" });
  const render = () => {
    const a = holder.auth;
    const types = [
      ...(allowInherit ? [["inherit", "Inherit from parent"]] : []),
      ["none", "No auth"], ["bearer", "Bearer token"], ["basic", "Basic auth"], ["apikey", "API key"],
      ...(a.type === "other" ? [["other", `${a.raw?.type ?? "Other"} (from Postman)`]] : []),
    ];
    const sel = h("select", {}, types.map(([v, l]) => h("option", { value: v, selected: v === a.type }, l)));
    sel.onchange = () => {
      holder.auth = { type: sel.value, ...(sel.value === "apikey" ? { in: "header" } : {}) };
      changed();
      render();
    };
    const field = (label, key, { secret, ph } = {}) => {
      // Secrets are masked, unless they only refer to variables.
      const masked = () => secret && !!a[key] && !/^(\s*\{\{[^{}]+\}\}\s*)+$/.test(a[key]);
      const input = h("input", { type: masked() ? "password" : "text", value: a[key] ?? "", placeholder: ph ?? "", spellcheck: false, class: "mono" });
      input.oninput = () => ((a[key] = input.value), changed());
      if (secret) {
        input.onfocus = () => (input.type = "text");
        input.onblur = () => (input.type = masked() ? "password" : "text");
      }
      return h("label", { class: "field row" }, h("span", {}, label), vctx ? varField(input, vctx) : input);
    };
    const rows = [h("label", { class: "field row" }, h("span", {}, "Type"), sel)];
    if (a.type === "bearer") rows.push(field("Token", "token", { secret: true, ph: "{{token}}" }));
    if (a.type === "basic") rows.push(field("Username", "username"), field("Password", "password", { secret: true }));
    if (a.type === "apikey") {
      const where = h("select", {}, h("option", { value: "header", selected: a.in !== "query" }, "Header"), h("option", { value: "query", selected: a.in === "query" }, "Query params"));
      where.onchange = () => ((a.in = where.value), changed());
      rows.push(field("Key", "key", { ph: "X-API-Key" }), field("Value", "value", { secret: true }), h("label", { class: "field row" }, h("span", {}, "Add to"), where));
    }
    if (a.type === "inherit") {
      const from = ancestors.find((x) => x.auth && x.auth.type !== "inherit");
      const eff = effectiveAuth(a, ancestors);
      rows.push(h("p", { class: "faint note" }, from ? `Uses the auth of “${from.name}”: ${authLabel(eff)}.` : "No parent sets an auth: none is sent."));
    }
    if (a.type === "none") rows.push(h("p", { class: "faint note" }, "No authorization is sent."));
    if (a.type === "other") rows.push(h("p", { class: "faint note" }, "This auth type isn't supported here: it is kept as is for the Postman export, and nothing is sent."));
    root.replaceChildren(...rows);
  };
  render();
  return root;
}

const authLabel = (a) => ({ none: "no auth", bearer: "bearer token", basic: "basic auth", apikey: "API key", other: "unsupported" })[a.type] ?? a.type;

function bodyEditor(req, changed, vctx) {
  const root = h("div", { class: "body-ed" });
  const MODES = [["none", "None"], ["json", "JSON"], ["text", "Text"], ["form", "Form data"], ["urlencoded", "URL-encoded"]];
  const render = () => {
    const b = req.body;
    const modes = h("div", { class: "modes" },
      MODES.map(([v, l]) =>
        h("label", { class: "mode" },
          h("input", { type: "radio", name: "body-mode", checked: b.mode === v, onchange: () => {
            b.mode = v;
            b.form ??= [];
            changed();
            render();
          } }),
          l)));
    const children = [modes];
    if (b.mode === "json" || b.mode === "text") {
      const ta = h("textarea", { class: "code-edit mono", spellcheck: false, placeholder: b.mode === "json" ? '{\n  "name": "value"\n}' : "" });
      ta.value = b.raw ?? "";
      tabIndent(ta);
      const status = h("span", { class: "faint" });
      const check = () => {
        if (b.mode !== "json" || !b.raw.trim()) return status.replaceChildren();
        try {
          // Variables outside strings ({{n}}) are fine: check with them as numbers.
          JSON.parse(b.raw.replace(/\{\{[^{}]+\}\}/g, "0"));
          status.replaceChildren();
        } catch (e) {
          status.replaceChildren(h("span", { class: "warn-text" }, "Invalid JSON: " + e.message.replace(/^JSON\.parse: /, "")));
        }
      };
      ta.oninput = () => {
        b.raw = ta.value;
        check();
        changed();
      };
      check();
      if (b.mode === "json")
        modes.append(h("div", { class: "grow" }), status, h("button", { class: "ghost small", onclick: () => {
          try {
            b.raw = JSON.stringify(JSON.parse(b.raw), null, 2);
            ta.value = b.raw;
            ta.paintVars();
            check();
            changed();
          } catch {
            octopus.toast("Not valid JSON", "error");
          }
        } }, "Beautify"));
      children.push(varField(ta, vctx));
    } else if (b.mode === "form" || b.mode === "urlencoded") {
      children.push(kvEditor(b.form, changed, { keyPh: "Field", vars: vctx }));
    } else children.push(h("p", { class: "faint note" }, "This request has no body."));
    root.replaceChildren(...children);
  };
  render();
  return root;
}

/** Per-request settings, as in Postman: only what differs from the defaults is stored. */
const DEFAULTS = { followRedirects: true, verifyTls: true, timeoutMs: 60000 };

function sendOptions(req) {
  return { ...DEFAULTS, ...req.settings };
}

function settingsEditor(req, changed) {
  const set = (k, v) => {
    req.settings = { ...req.settings, [k]: v };
    if (v === DEFAULTS[k]) delete req.settings[k];
    if (!Object.keys(req.settings).length) delete req.settings;
    changed();
  };
  const o = sendOptions(req);
  const check = (k, label, help) =>
    h("label", { class: "setting" },
      h("input", { type: "checkbox", checked: o[k], onchange: (e) => set(k, e.target.checked) }),
      h("span", {}, h("div", {}, label), h("div", { class: "faint" }, help)));
  const timeout = h("input", { type: "number", min: 1, max: 600, value: o.timeoutMs / 1000, class: "num" });
  timeout.oninput = () => {
    const s = Number(timeout.value);
    if (s >= 1 && s <= 600) set("timeoutMs", Math.round(s * 1000));
  };
  return h("div", { class: "settings" },
    check("followRedirects", "Follow redirects", "Follow 3xx responses to where they point (up to 10)."),
    check("verifyTls", "Verify TLS certificates", "Turn off for hosts with self-signed or internal certificates."),
    h("label", { class: "setting" }, h("span", { class: "setting-num" }, timeout, " s"),
      h("span", {}, h("div", {}, "Timeout"), h("div", { class: "faint" }, "How long to wait for the response."))));
}

// --- Response -------------------------------------------------------------------------------------

function renderResponse(t, el = $("response")) {
  if (!el || t.id !== state.activeTab) return;
  const sendBtn = el.parentElement?.parentElement?.querySelector(".send");
  if (sendBtn) sendBtn.textContent = t.sending ? "Cancel" : "Send";
  if (t.sending) return el.replaceChildren(h("div", { class: "res-empty" }, h("span", { class: "spinner" }), " Sending request…"));
  if (t.error)
    return el.replaceChildren(h("div", { class: "res-empty" }, h("div", { class: "card err-card" },
      h("div", { class: "error-text" }, "Could not send the request"),
      h("div", { class: "mono" }, t.error),
      t.errorTls && h("div", { class: "toolbar err-actions" },
        h("span", { class: "muted" }, "Self-signed or internal certificate?"),
        h("button", { class: "small", onclick: () => {
          t.req.settings = { ...t.req.settings, verifyTls: false };
          t.dirty = true;
          renderPane();
          sendTab(t);
        } }, "Send without verifying it")))));
  const r = t.response;
  if (!r) return el.replaceChildren(h("div", { class: "res-empty faint" }, "Enter a URL and press Send (⌘↵) to see the response."));

  const status = h("span", { class: "badge " + statusClass(r.status) }, `${r.status} ${statusText(r.status, r.reason)}`);
  const redirected = r.redirects?.length
    ? h("span", { class: "faint", title: r.redirects.map((x) => `${x.status} ${x.url}`).join("\n") }, `${r.redirects.length} redirect${r.redirects.length > 1 ? "s" : ""}`)
    : null;
  const RES = [["body", "Body"], ["headers", `Headers (${r.headers.length})`]];
  const content = h("div", { class: "res-content" });
  const tabs = h("div", { class: "subtabs" },
    RES.map(([id, label]) => h("button", { class: "subtab" + (ui.resTab === id ? " on" : ""), dataset: { id }, onclick: () => {
      ui.resTab = id;
      save("ui");
      tabs.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
      renderContent();
    } }, label)),
    h("div", { class: "grow" }),
    h("div", { class: "res-meta" }, redirected, status, h("span", { class: "muted" }, formatMs(r.ms)), h("span", { class: "muted" }, formatBytes(r.size))),
  );
  const renderContent = () => {
    if (ui.resTab === "headers") {
      content.replaceChildren(h("div", { class: "scroll" }, h("table", { class: "hdr-table" }, h("tbody", {},
        r.headers.map(([k, v]) => h("tr", {}, h("td", { class: "hk" }, k), h("td", { class: "mono hv" }, v)))))));
      return;
    }
    if (r.image) return content.replaceChildren(h("div", { class: "scroll img-wrap" }, h("img", { src: r.image })));
    if (r.binary) return content.replaceChildren(h("div", { class: "res-empty faint" }, `Binary response (${r.type || "unknown type"}, ${formatBytes(r.size)})`));
    if (!r.body) return content.replaceChildren(h("div", { class: "res-empty faint" }, "No body"));
    let html = null;
    let kind = "text";
    if (ui.pretty) {
      html = prettyJson(r.body);
      if (html != null) kind = "JSON";
      else if (/xml|html/.test(r.type) || /^\s*</.test(r.body)) (html = prettyMarkup(r.body)), (kind = /html/.test(r.type) ? "HTML" : "XML");
    }
    const pre = h("pre", { class: "code" });
    if (html != null) pre.innerHTML = html;
    else pre.textContent = r.body;
    const bar = h("div", { class: "body-bar" },
      h("div", { class: "seg" },
        h("button", { class: ui.pretty ? "on" : "", onclick: () => ((ui.pretty = true), save("ui"), renderContent()) }, "Pretty"),
        h("button", { class: ui.pretty ? "" : "on", onclick: () => ((ui.pretty = false), save("ui"), renderContent()) }, "Raw")),
      h("span", { class: "faint" }, ui.pretty ? kind : r.type || "text"),
      h("div", { class: "grow" }),
      h("button", { class: "ghost small", onclick: () => {
        const json = ui.pretty && prettyJson(r.body, { color: false });
        octopus.copy(json ? new DOMParser().parseFromString(json, "text/html").documentElement.textContent : r.body);
        octopus.toast("Response copied", "success");
      } }, "Copy"));
    content.replaceChildren(bar, h("div", { class: "scroll" }, pre));
  };
  renderContent();
  el.replaceChildren(tabs, content);
}

async function sendTab(t) {
  if (t.sending) return;
  if (!t.req.url.trim()) return octopus.toast("Enter a URL first", "error");
  const ctx = ctxFor(t);
  const p = prepare(t.req, ctx.vars, ctx.ancestors);
  const token = (t.sendToken = uid());
  t.sending = true;
  t.error = null;
  t.preview = false;
  renderTabs();
  renderResponse(t);
  try {
    const res = await send(p, sendOptions(t.req));
    if (t.sendToken !== token) return;
    t.response = res;
    addHistory(t.req, res.status, res.ms);
  } catch (e) {
    if (t.sendToken !== token) return;
    t.error = e.message;
    t.errorTls = !!e.tls;
    t.response = null;
    addHistory(t.req, "ERR", null);
  }
  t.sending = false;
  save("tabs");
  renderResponse(t);
  if (ui.side === "history") renderSideBody();
}

function cancelSend(t) {
  t.sendToken = null;
  t.sending = false;
  renderResponse(t);
}

function copyCurl(req, found) {
  const vars = scope(activeEnv()?.variables, found?.collection.variables);
  octopus.copy(toCurl(prepare(req, vars, found?.ancestors ?? [])));
  octopus.toast("Copied as cURL", "success");
}

// --- Saving ---------------------------------------------------------------------------------------

async function saveTab(t) {
  if (t.kind !== "request") return;
  const f = t.nodeId && findNode(t.nodeId);
  if (!f) return saveAs(t);
  f.node.req = clone(t.req);
  t.dirty = false;
  t.preview = false;
  save("collections", "tabs");
  renderTabs();
  renderSideBody();
  octopus.toast("Saved", "success");
}

/** Saves a tab (or a history entry: { req }) into a collection or folder. */
async function saveAs(t) {
  if (!state.collections.length) {
    state.collections.push({ id: uid(), type: "collection", name: "My collection", items: [], variables: [], auth: { type: "none" } });
  }
  const options = containers();
  const name = t.req.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] || t.req.url || "New request";
  const v = await prompt("Save request", [
    { name: "name", label: "Name", value: `${t.req.method} ${name}` },
    { name: "to", label: "Save to", options, value: options[0].value },
  ], { ok: "Save" });
  if (!v?.name.trim()) return;
  const parent = findNode(v.to).node;
  const node = { id: uid(), type: "request", name: v.name.trim(), req: clone(t.req) };
  parent.items.push(node);
  ui.expanded[parent.id] = true;
  if (t.id) {
    t.nodeId = node.id;
    t.dirty = false;
    t.preview = false;
  }
  ui.side = "collections";
  save("collections", "tabs", "ui");
  renderAll();
  octopus.toast("Saved to " + options.find((o) => o.value === v.to).label, "success");
}

// --- Collection / folder settings, environments ---------------------------------------------------

function containerPane(t) {
  const f = findNode(t.nodeId);
  if (!f) return h("div", { class: "res-empty faint" }, "This item no longer exists.");
  const n = f.node;
  const isColl = n.type === "collection";
  const changed = () => save("collections");
  const name = h("input", { class: "title-input", value: n.name, spellcheck: false });
  name.oninput = () => {
    n.name = name.value;
    changed();
    renderTabs();
    renderSideBody();
  };
  const SUBS = [["auth", "Auth"], ...(isColl ? [["variables", "Variables"]] : []), ["overview", "Overview"]];
  if (!SUBS.find(([id]) => id === t.sub)) t.sub = "auth";
  const section = h("div", { class: "section" });
  const subtabs = h("div", { class: "subtabs" },
    SUBS.map(([id, label]) => h("button", { class: "subtab" + (t.sub === id ? " on" : ""), dataset: { id }, onclick: () => {
      t.sub = id;
      save("tabs");
      subtabs.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
      render();
    } }, label)));
  const render = () => {
    if (t.sub === "auth")
      section.replaceChildren(
        h("p", { class: "faint note" }, `Requests in this ${n.type} that inherit their auth use this one.`),
        authEditor(n, !isColl, f.ancestors, changed, varContext(f.collection)),
      );
    else if (t.sub === "variables")
      section.replaceChildren(
        h("p", { class: "faint note" }, "Collection variables, used as {{name}}. The active environment's variables of the same name win."),
        kvEditor(n.variables, changed, { keyPh: "Variable", bulk: true }),
      );
    else {
      let reqs = 0, folders = 0;
      const count = (x) => x.items?.forEach((c) => (c.items ? folders++ : reqs++, count(c)));
      count(n);
      section.replaceChildren(
        h("p", {}, `${reqs} requests, ${folders} folders.`),
        n.description ? h("pre", { class: "desc" }, n.description) : null,
        h("div", { class: "toolbar" },
          h("button", { onclick: () => newRequestIn(n) }, "New request"),
          h("button", { onclick: () => newFolderIn(n) }, "New folder"),
          isColl ? h("button", { onclick: () => exportCollection(n) }, "Export (Postman v2.1)") : null,
          isColl ? h("button", { onclick: () => runCollection(n) }, "Run all requests") : null),
        h("div", { id: "runner" }),
      );
    }
  };
  render();
  return h("div", { class: "settings-pane" }, h("div", { class: "settings-head" }, h("span", { class: "faint" }, isColl ? "Collection" : "Folder"), name), subtabs, section);
}

/** Sends every request of a collection in order and lists the results. */
async function runCollection(c) {
  const out = $("runner");
  const list = [];
  const walk = (n, anc) => n.items.forEach((x) => (x.items ? walk(x, [x, ...anc]) : list.push({ node: x, ancestors: anc })));
  walk(c, [c]);
  const vars = scope(activeEnv()?.variables, c.variables);
  const rows = h("tbody");
  out.replaceChildren(h("table", { class: "run-table" }, rows));
  let ok = 0;
  for (const { node, ancestors } of list) {
    const status = h("td", {}, h("span", { class: "spinner" }));
    const time = h("td", { class: "muted" });
    rows.append(h("tr", {}, h("td", {}, methodBadge(node.req.method)), h("td", {}, h("a", { href: "#", onclick: (e) => (e.preventDefault(), openNode(node.id, { pin: true })) }, node.name)), status, time));
    try {
      const r = await send(prepare(node.req, vars, ancestors), sendOptions(node.req));
      status.replaceChildren(h("span", { class: "badge " + statusClass(r.status) }, r.status));
      time.textContent = formatMs(r.ms);
      if (r.status < 400) ok++;
    } catch (e) {
      status.replaceChildren(h("span", { class: "badge error", title: e.message }, "ERR"));
    }
  }
  out.prepend(h("p", { class: "muted" }, `${ok} of ${list.length} answered with a status below 400.`));
}

function envPane(t) {
  const e = state.environments.find((x) => x.id === t.envId);
  if (!e) return h("div", { class: "res-empty faint" }, "This environment no longer exists.");
  const name = h("input", { class: "title-input", value: e.name, spellcheck: false });
  name.oninput = () => {
    e.name = name.value;
    save("environments");
    renderTabs();
    renderSideBody();
    renderEnvSelect();
  };
  const active = e.id === state.activeEnv;
  return h("div", { class: "settings-pane" },
    h("div", { class: "settings-head" }, h("span", { class: "faint" }, "Environment"), name,
      h("div", { class: "grow" }),
      active ? h("span", { class: "badge success" }, "Active") : h("button", { class: "small", onclick: () => setActiveEnv(e.id) }, "Set active")),
    h("p", { class: "faint note" }, "Use them as {{name}} in URLs, params, headers, bodies and auth. Values are stored by Octopus on this Mac."),
    h("div", { class: "section" }, kvEditor(e.variables, () => save("environments"), { keyPh: "Variable" })));
}

// --- Import ---------------------------------------------------------------------------------------

async function importDialog() {
  const pick = h("button", { type: "button", class: "small", onclick: async (e) => {
    const texts = await pickFiles(".json,application/json,text/plain");
    if (!texts.length) return;
    const modal = e.target.closest(".modal");
    if (texts.length === 1) return (modal.querySelector("textarea").value = texts[0]);
    modal.querySelector(".modal-foot .ghost").click();
    importTexts(texts);
  } }, "Choose files…");
  const v = await prompt("Import", [{ name: "text", multiline: true, rows: 14, placeholder: "Paste a Postman collection (v2.0 / v2.1) or environment as JSON, or a curl command." }], {
    ok: "Import",
    body: h("div", { class: "toolbar" }, pick, h("span", { class: "faint" }, "or paste below")),
  });
  if (!v?.text.trim()) return;
  importTexts([v.text]);
}

/** Imports pasted or dropped texts: Postman collections and environments, or one curl command. */
function importTexts(texts) {
  if (texts.length === 1 && looksLikeCurl(texts[0])) {
    try {
      openReq(fromCurl(texts[0]));
    } catch (e) {
      octopus.toast("Import failed: " + e.message, "error");
    }
    return;
  }
  const out = { collections: [], environments: [] };
  let failed = 0;
  for (const t of texts) {
    try {
      const r = fromPostman(t);
      if (r.collection) out.collections.push(r.collection);
      else out.environments.push(r.environment);
    } catch {
      failed++;
    }
  }
  if (out.collections.length || out.environments.length) addImported(out);
  if (failed) octopus.toast(`${failed} of ${texts.length} files aren't a Postman collection or environment`, "error");
  else if (texts.length === 1) octopus.toast(`Imported “${(out.collections[0] ?? out.environments[0]).name}”`, "success");
  else octopus.toast(`Imported ${out.collections.length} collections and ${out.environments.length} environments`, "success");
}

/** Adds imported collections and environments. */
function addImported({ collections, environments }) {
  state.collections.push(...collections);
  state.environments.push(...environments);
  if (collections.length) ui.side = "collections";
  else if (environments.length) ui.side = "environments";
  for (const c of collections) ui.expanded[c.id] = collections.length === 1;
  save("collections", "environments", "ui");
  renderAll();
}

// Dropping files anywhere imports them.
addEventListener("dragover", (e) => [...e.dataTransfer.types].includes("Files") && e.preventDefault());
addEventListener("drop", async (e) => {
  const files = [...(e.dataTransfer.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  importTexts(await Promise.all(files.map((f) => f.text())));
});

// --- Keys & start ---------------------------------------------------------------------------------

addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-back")) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const t = currentTab();
  if (e.key === "Enter" && t?.kind === "request") (e.preventDefault(), sendTab(t));
  else if (e.key === "s" && t?.kind === "request") (e.preventDefault(), saveTab(t));
  else if (e.key === "t") (e.preventDefault(), openReq(newRequest()));
  else if (e.key === "w" && t) (e.preventDefault(), closeTab(t.id));
});

function renderAll() {
  renderSide();
  renderTabs();
  renderEnvSelect();
  renderPane();
}

renderAll();
