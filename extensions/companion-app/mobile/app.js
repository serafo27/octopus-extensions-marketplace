// Companion, the phone side: served by server.py on the Mac. A wall of every terminal (Octopus's, read-only and
// relayed by the extension page, and the extension's own, which the phone types into), each opening full screen.
const $ = (id) => document.getElementById(id);
const KEYS = { esc: "\x1b", tab: "\t", ctrlc: "\x03", ctrld: "\x04", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r" };
const SIZES = [10, 11.5, 13, 15];
const PREVIEW_ROWS = 7;
const ORDER = { waiting: 0, working: 1, idle: 2, ended: 3 };

let st = { terminals: [], projects: [], accounts: [], sessions: [], previews: {}, allowInput: true, relaying: false, host: "" };
let online = true;
let filter = localStorage.getItem("filter") || "all";
let fontSize = Number(localStorage.getItem("fontSize")) || 11.5;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Companion": "1" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) location.reload(); // signed out (new pairing code)
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const projectName = (id) => st.projects.find((p) => p.id === id)?.name || "";
const lastLines = (text, n) => (text || "").replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, "")).slice(-n).join("\n");

// --- previews of the companion sessions: a terminal that is never drawn, fed with the session's output

const shadows = new Map(); // session id -> { term, seq, busy }

async function feedShadow(s) {
  let sh = shadows.get(s.id);
  if (!sh) {
    sh = { term: new Terminal({ cols: s.cols, rows: s.rows, scrollback: 50, allowProposedApi: true }), seq: 0, busy: false };
    shadows.set(s.id, sh);
  }
  if (sh.term.cols !== s.cols || sh.term.rows !== s.rows) sh.term.resize(s.cols, s.rows);
  if (sh.busy) return;
  sh.busy = true;
  try {
    const r = await api(`/api/sessions/${s.id}/read?from=${sh.seq}`);
    sh.seq = r.seq;
    if (r.data) await new Promise((done) => sh.term.write(decode(r.data), done));
  } catch {
    // shown again on the next round
  } finally {
    sh.busy = false;
  }
}

function shadowText(id) {
  const term = shadows.get(id)?.term;
  if (!term) return "";
  const buf = term.buffer.active;
  const lines = [];
  for (let y = buf.baseY + term.rows - 1; y >= 0 && lines.length < PREVIEW_ROWS; y--) {
    const line = buf.getLine(y)?.translateToString(true) ?? "";
    if (!lines.length && !line.trim()) continue;
    lines.unshift(line);
  }
  return lines.join("\n");
}

// --- state

async function refresh() {
  const onHome = route().view === "";
  try {
    st = await api("/api/state" + (onHome ? "?previews=1" : ""));
    online = true;
  } catch {
    online = false;
  }
  if (onHome && online) {
    await Promise.all(st.sessions.filter((s) => !s.exited || !shadows.has(s.id)).map(feedShadow));
    for (const id of shadows.keys()) if (!st.sessions.some((s) => s.id === id)) (shadows.get(id).term.dispose(), shadows.delete(id));
  }
  renderHome();
  if (route().view) renderViewHead();
}

function sessionState(s) {
  if (s.exited) return "ended";
  return Date.now() - s.lastOutputAt < 3000 ? "working" : "idle";
}

function tiles() {
  const octo = st.terminals.map((t) => ({
    key: "octo/" + t.id,
    mine: false,
    name: t.title || (t.kind === "claude" ? "Claude" : "Shell"),
    state: t.state || "idle",
    project: projectName(t.projectId),
    at: t.lastOutputAt || 0,
    preview: lastLines(st.previews?.[t.id], PREVIEW_ROWS),
  }));
  const mine = st.sessions.map((s) => ({
    key: "s/" + s.id,
    mine: true,
    name: s.kind === "claude" ? "Claude" : "Shell",
    state: sessionState(s),
    project: projectName(s.projectId),
    at: s.lastOutputAt,
    preview: shadowText(s.id),
  }));
  return [...octo, ...mine].sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.at - a.at);
}

function renderHome() {
  const notes = [];
  if (!online) notes.push("Can't reach the Mac. Same Wi-Fi? Is Octopus open?");
  else if (!st.relaying) notes.push("Octopus isn't relaying its terminals: open Companion App in Octopus on the Mac.");
  else if (!st.allowInput) notes.push("Typing from the phone is turned off in Octopus.");
  $("banner").hidden = !notes.length;
  $("banner").textContent = notes.join(" ");
  $("conn").className = "dot " + (!online ? "err" : st.relaying ? "ok" : "warn");
  $("host").textContent = online ? st.host : "offline";

  const all = tiles();
  const counts = { all: all.length, waiting: all.filter((t) => t.state === "waiting").length, mine: all.filter((t) => t.mine).length };
  for (const b of document.querySelectorAll(".seg [data-filter]")) {
    b.setAttribute("aria-selected", String(b.dataset.filter === filter));
    b.querySelector("span").textContent = counts[b.dataset.filter] || "";
  }
  const shown = all.filter((t) => filter === "all" || (filter === "mine" ? t.mine : t.state === filter));
  $("grid").replaceChildren(
    ...shown.map((t) =>
      el("button", { className: "tile " + t.state, onclick: () => go("#/" + t.key) },
        el("div", { className: "tile-head" },
          el("span", { className: "dot " + t.state }),
          el("span", { className: "name", textContent: t.name }),
          ...(t.mine ? [el("span", { className: "mine", textContent: "MINE" })] : []),
        ),
        el("div", { className: "tile-body", textContent: t.preview }),
        el("div", { className: "tile-foot", textContent: [t.project, t.state === "waiting" ? "needs you" : t.state].filter(Boolean).join(" · ") }),
      ),
    ),
  );
  const empty = $("empty");
  empty.hidden = shown.length > 0 || !online;
  empty.textContent = filter === "waiting" ? "Nothing needs you right now." : filter === "mine" ? "No session of yours yet: + starts a shell or Claude you can type into." : "No terminal open in Octopus.";
  $("fab").disabled = !st.allowInput || !st.projects.length;
}

for (const b of document.querySelectorAll(".seg [data-filter]")) {
  b.onclick = () => {
    filter = b.dataset.filter;
    localStorage.setItem("filter", filter);
    renderHome();
  };
}

// --- routing

function route() {
  const [, view, id] = location.hash.split("/");
  return { view: view || "", id };
}

function go(hash) {
  location.hash = hash;
}

function show() {
  const { view, id } = route();
  stopOcto();
  stopSession();
  $("home").hidden = view !== "";
  $("view").hidden = view === "";
  if (view === "octo") startOcto(id);
  if (view === "s") startSession(id);
  if (view) renderViewHead();
  else refresh();
}

function renderViewHead() {
  const { view, id } = route();
  if (view === "octo") {
    const t = st.terminals.find((x) => x.id === id);
    $("viewTitle").textContent = t?.title || "Terminal";
    $("viewSub").textContent = [projectName(t?.projectId), "Octopus", t?.state === "waiting" ? "needs you" : "read-only"].filter(Boolean).join(" · ");
    $("lock").hidden = false;
    $("lock").querySelector("span").textContent = "Octopus terminals are watch-only";
    $("controls").hidden = true;
    $("wrap").hidden = false;
  } else {
    $("wrap").hidden = true;
    const s = st.sessions.find((x) => x.id === id);
    $("viewTitle").textContent = s?.kind === "claude" ? "Claude" : "Shell";
    $("viewSub").textContent = [projectName(s?.projectId), s?.exited ? "ended" : st.allowInput ? "you can type" : "typing off"].filter(Boolean).join(" · ");
    const canType = st.allowInput && s && !s.exited;
    $("controls").hidden = !canType;
    $("lock").hidden = canType;
    $("lock").querySelector("span").textContent = s?.exited ? "This session has ended" : "Typing from the phone is turned off in Octopus";
  }
}

// --- an Octopus terminal: its text, polled

let octoTimer = null;
let octoAt = -1;

function stopOcto() {
  clearTimeout(octoTimer);
  octoTimer = null;
  octoAt = -1;
  $("snapshot").hidden = true;
}

function startOcto(id) {
  const pre = $("snapshot");
  pre.hidden = false;
  pre.textContent = st.previews?.[id] || "Loading…";
  pre.scrollTop = pre.scrollHeight;
  const tick = async () => {
    try {
      const snap = await api(`/api/octo/${encodeURIComponent(id)}`);
      if (route().id !== id) return;
      if (snap.at !== octoAt) {
        octoAt = snap.at;
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
        if (snap.text != null) pre.textContent = snap.text.replace(/\s+$/, "");
        else if (snap.at) pre.textContent = "This terminal is in a window of its own: Octopus can't read it.";
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }
    } catch (e) {
      pre.textContent = e.message;
    }
    if (route().id === id) octoTimer = setTimeout(tick, 1000);
  };
  tick();
}

// --- a companion session: a real terminal

let term = null;
let fit = null;
let source = null;
let sessionId = null;

function stopSession() {
  source?.close();
  term?.dispose();
  source = term = fit = sessionId = null;
  $("term").replaceChildren();
  $("term").hidden = true;
}

function startSession(id) {
  sessionId = id;
  $("term").hidden = false;
  term = new Terminal({ fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize, scrollback: 5000, theme: { background: "#000000" }, cursorBlink: true });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("term"));
  fit.fit();
  term.onData((d) => input(d));
  term.onResize(({ cols, rows }) => api(`/api/sessions/${id}/resize`, { cols, rows }).catch(() => {}));
  api(`/api/sessions/${id}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {});
  let seq = 0;
  const open = () => {
    source = new EventSource(`/api/sessions/${id}/stream?from=${seq}`);
    source.onmessage = (e) => {
      term?.write(decode(JSON.parse(e.data).d));
      seq = Number(e.lastEventId) || seq;
    };
    source.addEventListener("exit", (e) => {
      const { code } = JSON.parse(e.data);
      term?.write(`\r\n\x1b[2m[session ended${code != null ? ", exit " + code : ""}]\x1b[0m\r\n`);
      source.close();
      refresh();
    });
    source.onerror = () => {
      // EventSource reconnects with `from` of its first URL: reopen from where we are instead.
      source.close();
      if (sessionId === id) setTimeout(() => sessionId === id && open(), 1500);
    };
  };
  open();
}

async function input(data) {
  if (!sessionId) return;
  try {
    await api(`/api/sessions/${sessionId}/input`, { data });
  } catch (e) {
    term?.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
  }
}

$("keys").onclick = (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (k) input(KEYS[k]);
};
$("send").onsubmit = (e) => {
  e.preventDefault();
  const line = $("line");
  input(line.value + "\r");
  line.value = "";
};
$("line").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("send").requestSubmit();
  }
};

function applyFontSize() {
  document.documentElement.style.setProperty("--fs", fontSize + "px");
  if (term) {
    term.options.fontSize = fontSize;
    fit.fit();
  }
}

// Octopus terminals' text: long lines wrapped, or kept whole with horizontal scrolling (the default).
let wrap = localStorage.getItem("wrap") === "1";

function applyWrap() {
  $("snapshot").classList.toggle("nowrap", !wrap);
  $("wrap").setAttribute("aria-pressed", String(wrap));
}

$("wrap").onclick = () => {
  wrap = !wrap;
  localStorage.setItem("wrap", wrap ? "1" : "0");
  applyWrap();
};

$("textSize").onclick = () => {
  fontSize = SIZES[(SIZES.indexOf(fontSize) + 1) % SIZES.length];
  localStorage.setItem("fontSize", String(fontSize));
  applyFontSize();
};

// --- new session

const HINTS = {
  shell: "A login shell in the project's folder. You can type into it from here.",
  claude: "Claude Code in the project's folder. You can type into it from here.",
  octo: "A Claude session in Octopus's terminals. You can watch it from here, not type into it.",
};
let kind = "shell";

function setKind(k) {
  kind = k;
  for (const b of document.querySelectorAll("[data-kind]")) b.setAttribute("aria-checked", String(b.dataset.kind === k));
  $("dlgHint").textContent = HINTS[k];
  $("dlgAccountRow").hidden = k === "shell" || st.accounts.length < 2;
  $("dlgPromptRow").hidden = k !== "octo";
  $("dlgPrompt").required = k === "octo";
}

for (const b of document.querySelectorAll("[data-kind]")) b.onclick = () => setKind(b.dataset.kind);

$("fab").onclick = () => {
  const dlg = $("dlg");
  $("dlgProject").replaceChildren(...st.projects.map((p) => new Option(p.name, p.id)));
  const keep = localStorage.getItem("project");
  if (keep && st.projects.some((p) => p.id === keep)) $("dlgProject").value = keep;
  $("dlgAccount").replaceChildren(...st.accounts.map((a) => new Option(a.name, a.id)));
  $("dlgPrompt").value = "";
  setKind(localStorage.getItem("kind") || "shell");
  dlg.showModal();
};

$("dlg").onclose = async () => {
  if ($("dlg").returnValue !== "ok") return;
  const projectId = $("dlgProject").value;
  localStorage.setItem("project", projectId);
  localStorage.setItem("kind", kind);
  const account = $("dlgAccountRow").hidden ? undefined : $("dlgAccount").value;
  try {
    if (kind === "octo") {
      await api("/api/octo/open", { prompt: $("dlgPrompt").value, projectId, account });
      alert("Sent: the session appears in the grid in a few seconds.");
    } else {
      const s = await api("/api/sessions", { kind, projectId, account });
      await refresh();
      go(`#/s/${s.id}`);
    }
  } catch (e) {
    alert(e.message);
  }
};

$("back").onclick = () => go("#/");
window.addEventListener("hashchange", show);
window.addEventListener("resize", () => fit?.fit());
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());

applyFontSize();
applyWrap();
await refresh();
show();
setInterval(refresh, 2000);
