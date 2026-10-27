// DOM helpers, modals and context menus.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || (v === false && !(k in el))) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else if (k === "value" || k === "checked" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Small modal with fields; resolves with { name: value } or null when cancelled. */
export function prompt(title, fields, { ok = "OK", danger = false, body } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const close = (val) => {
      back.remove();
      resolve(val);
    };
    const submit = () => {
      const out = {};
      for (const [k, el] of Object.entries(inputs)) out[k] = el.type === "checkbox" ? el.checked : el.value;
      close(out);
    };
    const form = h(
      "form",
      { class: "modal", onsubmit: (e) => (e.preventDefault(), submit()) },
      h("div", { class: "modal-title" }, title),
      body,
      fields.map((f) => {
        let input;
        if (f.options) {
          input = h("select", {}, f.options.map((o) => h("option", { value: o.value, selected: o.value === f.value }, o.label)));
        } else if (f.multiline) {
          input = h("textarea", { rows: f.rows ?? 10, spellcheck: false, placeholder: f.placeholder ?? "", class: "mono" });
          input.value = f.value ?? "";
        } else {
          input = h("input", { type: "text", value: f.value ?? "", placeholder: f.placeholder ?? "", spellcheck: false });
        }
        inputs[f.name] = input;
        return h("label", { class: "field" }, f.label && h("span", {}, f.label), input);
      }),
      h(
        "div",
        { class: "modal-foot" },
        h("button", { type: "button", class: "ghost", onclick: () => close(null) }, "Cancel"),
        h("button", { type: "submit", class: danger ? "primary danger" : "primary" }, ok),
      ),
    );
    const back = h("div", { class: "modal-back", onmousedown: (e) => e.target === back && close(null) }, form);
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), submit());
    });
    document.body.append(back);
    const first = Object.values(inputs)[0];
    if (first) {
      first.focus();
      first.select?.();
    } else form.querySelector("button.primary").focus();
  });
}

export const confirmBox = (title, text, ok = "Delete") =>
  prompt(title, [], { ok, danger: true, body: h("p", { class: "muted" }, text) }).then((v) => v != null);

let openMenu = null;
/** Context menu at (x, y). items: { label, action, danger, disabled } | "-" */
export function menu(x, y, items) {
  openMenu?.remove();
  const el = h(
    "div",
    { class: "menu" },
    items.map((it) =>
      it === "-"
        ? h("div", { class: "menu-sep" })
        : h(
            "button",
            {
              class: "menu-item" + (it.danger ? " menu-danger" : ""),
              disabled: it.disabled,
              onclick: () => {
                close();
                it.action();
              },
            },
            it.label,
          ),
    ),
  );
  const close = () => {
    el.remove();
    openMenu = null;
    removeEventListener("mousedown", outside, true);
    removeEventListener("keydown", onKey, true);
  };
  const outside = (e) => !el.contains(e.target) && close();
  const onKey = (e) => e.key === "Escape" && close();
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 4) + "px";
  el.style.top = Math.min(y, innerHeight - r.height - 4) + "px";
  openMenu = el;
  setTimeout(() => {
    addEventListener("mousedown", outside, true);
    addEventListener("keydown", onKey, true);
  });
}

/** Makes `handle` resize: calls onMove(clientX, clientY) while dragging. */
export function dragger(handle, onMove, onEnd) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
    const move = (ev) => onMove(ev.clientX, ev.clientY);
    const up = () => {
      document.body.classList.remove("dragging");
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      onEnd?.();
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
  });
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

export function formatMs(ms) {
  return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
}

/** Tab inserts two spaces in a textarea; Shift+Tab is left alone. */
export function tabIndent(ta) {
  ta.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  });
}

/** Opens local files and resolves with their texts (empty when cancelled). */
export function pickFiles(accept = ".json,application/json") {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple: true, style: { display: "none" } });
    input.addEventListener("change", async () => {
      resolve(await Promise.all([...(input.files ?? [])].map((f) => f.text())));
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Tries to save `text` as a download. */
export function download(name, text, type = "application/json") {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch {}
}
