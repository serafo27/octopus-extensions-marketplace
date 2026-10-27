// Companion App, the Octopus side: runs the helper (server.py), shows how to pair a phone, and relays
// Octopus's terminals to it (they are read-only for extensions, so the helper can't see them by itself).
import qrcode from "./vendor/qrcode.mjs";

const $ = (id) => document.getElementById(id);
const SNAPSHOT_LINES = 400;
const PREVIEW_LINES = 30; // the phone keeps the last non-empty ones

let base = null; // "http://127.0.0.1:<port>"
let localToken = null;
let projects = [];
let accounts = [];
let terminals = [];
let allowInput = true;
let running = false;
let sessions = [];
let selected = null; // companion session shown in the viewer
let lastPairUrl = "";

await octopus.ready();

// --- helper

async function api(path, { method = "GET", body } = {}) {
  const res = await octopus.http.fetch(base + path, {
    method,
    body,
    headers: { "X-Local-Token": localToken, "Content-Type": "application/json" },
    timeoutMs: 15000,
  });
  const data = res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function readReady() {
  const log = await octopus.helpers.log("server", { lines: 200 });
  const text = Array.isArray(log) ? log.join("\n") : String(log || "");
  const m = [...text.matchAll(/COMPANION_READY port=(\d+) token=(\S+)/g)].pop();
  return m ? { port: m[1], token: m[2] } : null;
}

async function connect() {
  setStatus("Starting…");
  await octopus.helpers.start("server");
  for (let i = 0; i < 40; i++) {
    const ready = await readReady();
    if (ready) {
      base = `http://127.0.0.1:${ready.port}`;
      localToken = ready.token;
      try {
        await refreshInfo();
        running = true;
        setStatus("Running", "success");
        return;
      } catch {
        // The log may still hold a previous run's line: wait for the new one.
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const st = await octopus.helpers.status("server");
  setStatus(st?.running ? "Not answering" : "Stopped", "error");
}

async function stop() {
  running = false;
  await octopus.helpers.stop("server");
  await octopus.statusBar.clear().catch(() => {});
  setStatus("Stopped");
}

function setStatus(text, tone = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "badge " + tone;
  $("toggle").textContent = running ? "Stop" : "Start";
}

// --- pairing

async function refreshInfo() {
  const info = await api("/local/info");
  renderPairing(info.pairUrls);
  renderPhones(info.phones);
  renderSessions(info.sessions);
}

function renderPairing(urls) {
  const box = $("urls");
  box.replaceChildren();
  if (!urls.length) {
    $("qr").replaceChildren();
    box.textContent = "No network address: is Wi-Fi on?";
    return;
  }
  for (const u of urls) {
    const a = document.createElement("a");
    a.textContent = u.replace(/\?t=.*/, "?t=…");
    a.title = "Copy the pairing link";
    a.onclick = () => (octopus.copy(u), octopus.toast("Pairing link copied", "info"));
    box.append(a);
  }
  if (urls[0] !== lastPairUrl) {
    lastPairUrl = urls[0];
    const qr = qrcode(0, "M");
    qr.addData(urls[0]);
    qr.make();
    $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
}

const ONLINE_MS = 15000; // the phone page asks for the state every 2 s while it's open

function device(agent = "") {
  const os = /iPhone/.test(agent) ? "iPhone" : /iPad/.test(agent) ? "iPad" : /Android/.test(agent) ? (agent.match(/Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/)?.[1] || "Android") : /Macintosh/.test(agent) ? "Mac" : "Device";
  const browser = /EdgiOS|EdgA|Edg\//.test(agent) ? "Edge" : /CriOS|Chrome\//.test(agent) ? "Chrome" : /FxiOS|Firefox\//.test(agent) ? "Firefox" : /Safari\//.test(agent) ? "Safari" : "";
  return { os, browser };
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 10 ? "now" : s < 60 ? s + " s ago" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago";
}

function viewingLabel(v) {
  if (!v) return "On the list";
  if (v.kind === "octo") return "Watching " + (terminals.find((t) => t.id === v.id)?.title || "an Octopus terminal");
  return "In " + (sessions.find((s) => s.id === v.id)?.title || "a companion session");
}

const PHONE_SVG = '<svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true"><rect x="4" y="1.5" width="8" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="6.5" y="12.3" width="3" height=".9" rx=".45" fill="currentColor"/></svg>';

function renderPhones(list) {
  const el = $("phones");
  const online = list.filter((p) => Date.now() - p.seenAt < ONLINE_MS).length;
  $("phonesCount").textContent = online ? `${online} online` : "";
  if (!list.length) {
    el.innerHTML = '<p class="faint small">No phone yet: scan the QR code above.</p>';
    return;
  }
  el.replaceChildren(
    ...list.map((p) => {
      const on = Date.now() - p.seenAt < ONLINE_MS;
      const { os, browser } = device(p.agent);
      const row = document.createElement("div");
      row.className = "phone" + (on ? " on" : "");
      row.title = p.agent;
      row.innerHTML = `<span class="ph-icon">${PHONE_SVG}<span class="dot${on ? "" : " off"}"></span></span>
        <span class="ph-text"><b></b><span class="faint small"></span></span>
        <span class="ph-when faint small"></span>`;
      row.querySelector("b").textContent = [os, browser].filter(Boolean).join(" · ");
      row.querySelector(".ph-text span").textContent = on ? viewingLabel(p.viewing) : p.address;
      row.querySelector(".ph-when").textContent = on ? p.address : ago(p.seenAt);
      return row;
    }),
  );
}

// --- relay of Octopus's terminals

async function loadProjects() {
  projects = await octopus.projects.list();
  accounts = await octopus.claude.accounts().catch(() => []);
  const sel = $("project");
  const keep = sel.value;
  sel.replaceChildren(...projects.map((p) => new Option(p.name, p.id)));
  if (keep) sel.value = keep;
}

let pushing = false;
let watched = [];
let lastPhones = [];
let wantPreviews = false; // a phone shows the grid of terminals: send each one's last lines
let previewsAt = 0;

async function push() {
  if (!running || pushing) return;
  pushing = true;
  try {
    terminals = await octopus.terminals.list();
    const snapshots = {};
    for (const id of watched) {
      if (!terminals.some((t) => t.id === id)) continue;
      try {
        snapshots[id] = await octopus.terminals.read(id, { lines: SNAPSHOT_LINES });
      } catch {
        snapshots[id] = null;
      }
    }
    let previews = null;
    if (wantPreviews && Date.now() - previewsAt > 2000) {
      previewsAt = Date.now();
      previews = {};
      for (const t of terminals) {
        try {
          const text = await octopus.terminals.read(t.id, { lines: PREVIEW_LINES });
          if (text != null) previews[t.id] = text;
        } catch {
          // ended meanwhile
        }
      }
    }
    const reply = await api("/local/push", {
      method: "POST",
      body: {
        terminals,
        projects: projects.map((p) => ({ id: p.id, name: p.name, path: p.path, color: p.color })),
        accounts: accounts.map((a, i) => ({ ...a, default: i === 0 })),
        allowInput,
        snapshots,
        previews,
      },
    });
    watched = reply.watching;
    wantPreviews = reply.previews;
    renderSessions(reply.sessions);
    for (const a of reply.actions) await runAction(a);
    renderPhones(reply.phones);
    const online = reply.phones.filter((p) => Date.now() - p.seenAt < ONLINE_MS).map((p) => p.address);
    if (JSON.stringify(online) !== JSON.stringify(lastPhones)) {
      lastPhones = online;
      updateStatusBar();
    }
    $("relay").textContent = `${terminals.length} Octopus terminal${terminals.length === 1 ? "" : "s"} · ${
      online.length ? online.length + " phone" + (online.length > 1 ? "s" : "") + " connected" : "no phone connected"
    }${watched.length ? ` · ${watched.length} watched` : ""}`;
  } catch (e) {
    $("relay").textContent = "Relay error: " + e.message;
    if (/connect|refused|ECONN/i.test(e.message)) {
      running = false;
      connect().catch((err) => setStatus(err.message, "error"));
    }
  } finally {
    pushing = false;
  }
}

async function runAction(a) {
  if (a.type !== "open") return;
  try {
    await octopus.claude.open(a.prompt, {
      projectId: a.projectId || undefined,
      account: a.account || undefined,
      title: "From phone: " + a.prompt.slice(0, 40),
      background: true,
    });
    octopus.toast("Claude session started from the phone", "info");
  } catch (e) {
    octopus.toast("Couldn't start the phone's Claude session: " + e.message, "error");
  }
}

function updateStatusBar() {
  if (!lastPhones.length) return octopus.statusBar.clear().catch(() => {});
  const now = Date.now();
  octopus.statusBar
    .set([{ text: `Companion · ${lastPhones.length} phone${lastPhones.length > 1 ? "s" : ""}`, from: now - 1000, to: now + 6 * 3600e3, color: "#3fb950" }], {
      menu: [{ text: "Open Companion App", id: "show", show: true }],
    })
    .catch(() => {});
}

// --- companion sessions

function renderSessions(list) {
  sessions = list;
  const ul = $("sessions");
  ul.replaceChildren(
    ...list.map((s) => {
      const li = document.createElement("li");
      li.className = s.id === selected?.id ? "selected" : "";
      const dot = document.createElement("span");
      dot.className = "dot" + (s.exited ? " off" : "");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = s.title;
      li.append(dot, t);
      li.onclick = () => select(s);
      return li;
    }),
  );
  if (selected) {
    const s = list.find((x) => x.id === selected.id);
    if (!s) return unselect();
    $("closeSession").hidden = s.exited;
    $("forgetSession").hidden = !s.exited;
    $("viewTitle").textContent = s.title + (s.exited ? ` (ended${s.exitCode != null ? ", " + s.exitCode : ""})` : "");
  }
}

async function create(kind) {
  if (!running) return;
  try {
    const s = await api("/api/sessions", { method: "POST", body: { kind, projectId: $("project").value } });
    await refreshInfo();
    select(s);
  } catch (e) {
    octopus.toast(e.message, "error");
  }
}

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return { background: v("--bg-editor"), foreground: v("--fg"), cursor: v("--fg-strong"), selectionBackground: v("--bg-selected") };
}

let term = null;
let fit = null;
let seq = 0;
let pollTimer = null;

function select(s) {
  unselect();
  selected = s;
  seq = 0;
  $("empty").hidden = true;
  $("term").hidden = false;
  $("term").replaceChildren();
  term = new Terminal({ fontFamily: getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace", fontSize: 12, theme: themeColors(), scrollback: 5000 });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("term"));
  fit.fit();
  term.onData((d) => api(`/api/sessions/${s.id}/input`, { method: "POST", body: { data: d } }).catch(() => {}));
  term.onResize(({ cols, rows }) => api(`/api/sessions/${s.id}/resize`, { method: "POST", body: { cols, rows } }).catch(() => {}));
  api(`/api/sessions/${s.id}/resize`, { method: "POST", body: { cols: term.cols, rows: term.rows } }).catch(() => {});
  term.focus();
  renderSessions(sessions);
  poll();
}

function unselect() {
  clearTimeout(pollTimer);
  term?.dispose();
  term = fit = selected = null;
  $("term").replaceChildren();
  $("viewTitle").textContent = "No session open";
  $("empty").hidden = false;
  $("term").hidden = true;
  $("closeSession").hidden = $("forgetSession").hidden = true;
}

async function poll() {
  const s = selected;
  if (!s) return;
  let wait = 150;
  try {
    const r = await api(`/api/sessions/${s.id}/read?from=${seq}`);
    if (s !== selected) return;
    if (r.data) term.write(Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
    else wait = 400;
    seq = r.seq;
    if (r.exited && !r.data) wait = 3000;
  } catch {
    wait = 2000;
  }
  if (s === selected) pollTimer = setTimeout(poll, wait);
}

// --- wiring

$("toggle").onclick = () => (running ? stop() : connect().then(push)).catch((e) => setStatus(e.message, "error"));
$("rotate").onclick = async () => {
  if (!running) return;
  const info = await api("/local/rotate", { method: "POST", body: {} });
  renderPairing(info.pairUrls);
  renderPhones([]);
  octopus.toast("New pairing code: phones must scan it again", "info");
};
$("allowInput").onchange = async (e) => {
  allowInput = e.target.checked;
  await octopus.storage.set("allowInput", allowInput);
  push();
};
$("newShell").onclick = () => create("shell");
$("newClaude").onclick = () => create("claude");
$("emptyShell").onclick = () => create("shell");
$("emptyClaude").onclick = () => create("claude");
$("closeSession").onclick = () => selected && api(`/api/sessions/${selected.id}/close`, { method: "POST", body: {} });
$("forgetSession").onclick = async () => {
  if (!selected) return;
  await api(`/api/sessions/${selected.id}/forget`, { method: "POST", body: {} });
  unselect();
  refreshInfo();
};
new ResizeObserver(() => fit?.fit()).observe($("term"));
octopus.on("theme", () => term && (term.options.theme = themeColors()));
octopus.on("terminals", () => push());
octopus.on("statusBar", () => {});

allowInput = (await octopus.storage.get("allowInput")) ?? true;
$("allowInput").checked = allowInput;
await loadProjects();
setInterval(loadProjects, 60000);
await connect().catch((e) => setStatus(e.message, "error"));
setInterval(push, 1000);
setInterval(() => running && refreshInfo().catch(() => {}), 10000);
push();
