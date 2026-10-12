await octopus.ready();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let data;
let error = null;
let query = "";
const folded = new Set();

const pathOf = (parent, key) =>
  typeof key === "number" ? `${parent}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;

function mark(text) {
  const t = esc(text);
  if (!query) return t;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return t;
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + query.length)) + "</mark>" + esc(text.slice(i + query.length));
}

/** Whether the value or anything under it matches the search. */
function hits(value, key) {
  if (!query) return true;
  if (key != null && String(key).toLowerCase().includes(query)) return true;
  if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => hits(v, Array.isArray(value) ? null : k));
  return String(value).toLowerCase().includes(query);
}

function leaf(v) {
  if (v === null) return `<span class="b">null</span>`;
  if (typeof v === "string") return `<span class="s">"${mark(v)}"</span>`;
  if (typeof v === "number") return `<span class="n">${mark(String(v))}</span>`;
  return `<span class="b">${mark(String(v))}</span>`;
}

function node(value, key, path) {
  if (!hits(value, key)) return "";
  const label = key == null ? "" : typeof key === "number" ? `<span class="meta">${key}</span>: ` : `<span class="k">${mark(key)}</span>: `;
  const acts = `<span class="acts"><button class="ghost" data-copy-path="${esc(path)}">path</button><button class="ghost" data-copy-value="${esc(path)}">value</button></span>`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const isArr = Array.isArray(value);
    const open = !folded.has(path) || !!query;
    const summary = isArr ? `[${entries.length}]` : `{${entries.length}}`;
    let html = `<div class="row"><span class="tw" data-fold="${esc(path)}">${open ? "▾" : "▸"}</span>${label}<span class="meta">${summary}</span>${acts}</div>`;
    if (open) html += `<div class="node">${entries.map(([k, v]) => node(v, isArr ? Number(k) : k, pathOf(path, isArr ? Number(k) : k))).join("")}</div>`;
    return html;
  }
  return `<div class="row"><span class="tw"></span>${label}${leaf(value)}${acts}</div>`;
}

function count(v) {
  let n = 1;
  if (v && typeof v === "object") for (const x of Object.values(v)) n += count(x);
  return n;
}

function render() {
  const tree = $("tree");
  if (error) {
    tree.innerHTML = `<div class="error">${esc(error)}</div>`;
    $("stats").textContent = "";
  } else if (data === undefined) {
    tree.innerHTML = `<div class="empty">Paste JSON on the left.</div>`;
    $("stats").textContent = "";
  } else {
    tree.innerHTML = node(data, null, "$") || `<div class="empty">Nothing matches “${esc(query)}”.</div>`;
    $("stats").textContent = `${count(data).toLocaleString()} values`;
  }
}

function parse() {
  const text = $("src").value.trim();
  void octopus.storage.set("source", text);
  if (!text) {
    data = undefined;
    error = null;
  } else {
    try {
      data = JSON.parse(text);
      error = null;
    } catch (e) {
      error = e.message;
    }
  }
  render();
}

function valueAt(path) {
  let v = data;
  for (const m of path.slice(1).matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g)) v = v[m[1] ?? (m[2] != null ? Number(m[2]) : JSON.parse(m[3]))];
  return v;
}

function allPaths(v, path, out) {
  if (v && typeof v === "object") {
    out.push(path);
    for (const [k, x] of Object.entries(v)) allPaths(x, pathOf(path, Array.isArray(v) ? Number(k) : k), out);
  }
  return out;
}

let timer;
$("src").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(parse, 200);
});
$("search").addEventListener("input", () => {
  query = $("search").value.trim().toLowerCase();
  render();
});
$("format").addEventListener("click", () => {
  if (data !== undefined && !error) $("src").value = JSON.stringify(data, null, 2);
});
$("clear").addEventListener("click", () => {
  $("src").value = "";
  folded.clear();
  parse();
});
$("expand").addEventListener("click", () => {
  folded.clear();
  render();
});
$("collapse").addEventListener("click", () => {
  if (data !== undefined) for (const p of allPaths(data, "$", [])) if (p !== "$") folded.add(p);
  render();
});
$("tree").addEventListener("click", (e) => {
  const fold = e.target.closest("[data-fold]");
  if (fold) {
    const p = fold.dataset.fold;
    if (folded.has(p)) folded.delete(p);
    else folded.add(p);
    return render();
  }
  const cp = e.target.closest("[data-copy-path]");
  if (cp) {
    octopus.copy(cp.dataset.copyPath);
    return octopus.toast(`Copied ${cp.dataset.copyPath}`);
  }
  const cv = e.target.closest("[data-copy-value]");
  if (cv) {
    const v = valueAt(cv.dataset.copyValue);
    octopus.copy(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    return octopus.toast("Value copied");
  }
});
octopus.on("theme", render);

$("src").value = (await octopus.storage.get("source")) ?? "";
parse();
