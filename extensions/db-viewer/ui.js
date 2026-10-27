// Small DOM helpers shared by the views: escaping, formatting, dialogs and a context menu.

export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function fmtBytes(n) {
  if (n === null || n === undefined || n === "") return "";
  n = Number(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function fmtNum(n) {
  if (n === null || n === undefined || n === "") return "";
  return Number(n).toLocaleString("en-US");
}

export function fmtMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** A modal dialog. `body` is HTML; resolves with the clicked button's value (or null when closed). */
export function modal({ title, body, buttons = [{ label: "Close", value: null }], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal" + (wide ? " wide" : "");
    dlg.innerHTML = `<form method="dialog">
      <div class="modal-head">${esc(title)}</div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">${buttons
        .map((b, i) => `<button type="${b.submit ? "submit" : "button"}" data-i="${i}" class="${b.cls || ""}">${esc(b.label)}</button>`)
        .join("")}</div></form>`;
    document.body.appendChild(dlg);
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener("cancel", () => done(null));
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const b = buttons.find((x) => x.submit);
      if (b?.check && !b.check(dlg)) return;
      done(b ? b.value : null);
    });
    dlg.querySelectorAll(".modal-foot button[type=button]").forEach((el) =>
      el.addEventListener("click", async () => {
        const b = buttons[+el.dataset.i];
        if (b.action) return b.action(dlg, done);
        done(b.value);
      }),
    );
    dlg.showModal();
    onOpen?.(dlg, done);
  });
}

export async function confirmDialog(title, html, okLabel = "OK", danger = false, wide = false) {
  const v = await modal({
    title,
    body: html,
    wide,
    // Cancel has the focus: Enter alone never confirms something risky.
    onOpen: (dlg) => dlg.querySelector(".modal-foot button")?.focus(),
    buttons: [
      { label: "Cancel", value: false, cls: "ghost" },
      { label: okLabel, value: true, cls: danger ? "danger" : "primary", submit: true },
    ],
  });
  return !!v;
}

let openMenu = null;
/** A context menu at the mouse: items [{label, icon, action, danger, disabled} | {separator: true}]. */
export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.innerHTML = items
    .map((it, i) =>
      it.separator
        ? '<div class="sep-h"></div>'
        : `<div class="ctx-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}" data-i="${i}">${it.icon || '<span style="width:14px"></span>'}<span>${esc(it.label)}</span></div>`,
    )
    .join("");
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(e.clientX, innerWidth - r.width - 4) + "px";
  el.style.top = Math.min(e.clientY, innerHeight - r.height - 4) + "px";
  el.addEventListener("click", (ev) => {
    const it = items[+ev.target.closest(".ctx-item")?.dataset.i];
    if (!it || it.disabled) return;
    closeMenu();
    it.action();
  });
  openMenu = el;
}

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}
addEventListener("mousedown", (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
addEventListener("blur", closeMenu);
