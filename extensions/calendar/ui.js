// DOM helpers: element builder, icons, a single popover and a modal.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  let checked;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith("--")) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    } else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") value = v;
    else if (k === "checked") checked = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  if (checked !== undefined) el.checked = checked;
  return el;
}

const PATHS = {
  left: "M10 3 5 8l5 5",
  right: "M6 3l5 5-5 5",
  plus: "M8 3v10M3 8h10",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5 14 14",
  close: "M4 4l8 8M12 4l-8 8",
  gear: gearPath(),
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.5V8l2.5 1.5",
  pin: "M8 14.5s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0c0 3.3 4.5 7.5 4.5 7.5zM8 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  text: "M2.5 4h11M2.5 8h11M2.5 12h7",
  people: "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 2.8a2.3 2.3 0 0 1 0 4.4M12.5 9.7c1.3.5 2 1.8 2 3.8",
  video: "M2 4.5h8v7H2zM10 7l4-2.5v7L10 9",
  repeat: "M3 6.5V5.5A1.5 1.5 0 0 1 4.5 4H13l-2-2M13 9.5v1A1.5 1.5 0 0 1 11.5 12H3l2 2",
  calendar: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
  link: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.7.7M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  chevronDown: "M4 6l4 4 4-4",
};

/** A cog: eight teeth around a ring, and the hole in the middle. */
function gearPath() {
  const teeth = 8;
  const [outer, inner, hole] = [6.6, 4.9, 2];
  const pt = (r, a) => `${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`;
  const step = (2 * Math.PI) / teeth;
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    pts.push(pt(inner, a - step * 0.32), pt(outer, a - step * 0.18), pt(outer, a + step * 0.18), pt(inner, a + step * 0.32));
  }
  return `M${pts.join("L")}zM${8 + hole} 8a${hole} ${hole} 0 1 0-${hole * 2} 0a${hole} ${hole} 0 1 0 ${hole * 2} 0z`;
}

export function icon(name, size = 14) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "icon");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", PATHS[name] || "");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", name === "more" ? "2.4" : "1.4");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}

// --- Popover ----------------------------------------------------------------------------------

let pop = null;
let popClose = null;

/** Shows `content` beside `anchor` (an element or a DOMRect). onClose runs however it closes. */
export function openPopover(anchor, content, { onClose, width = 340, prefer = "right" } = {}) {
  closePopover();
  pop = h("div", { class: "popover", style: { width: `${width}px` } }, content);
  document.body.append(pop);
  popClose = onClose || null;
  placePopover(anchor, prefer);
  return pop;
}

export function placePopover(anchor, prefer = "right") {
  if (!pop) return;
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 8;
  let left;
  let top;
  if (prefer === "below") {
    left = r.left;
    top = r.bottom + gap;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - gap);
  } else {
    left = r.right + gap;
    if (left + pw > vw - 8) left = r.left - pw - gap;
    if (left < 8) left = Math.min(vw - pw - 8, Math.max(8, r.left + r.width / 2 - pw / 2));
    top = r.top;
  }
  left = Math.min(Math.max(8, left), vw - pw - 8);
  top = Math.min(Math.max(8, top), vh - ph - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

export function closePopover() {
  if (!pop) return;
  const el = pop;
  const cb = popClose;
  pop = null;
  popClose = null;
  el.remove();
  cb?.();
}

export const popoverOpen = () => !!pop;

// A click outside closes the popover and does nothing else (it doesn't also start a new event).
let closedByOutsideAt = 0;
export const justClosedPopover = () => performance.now() - closedByOutsideAt < 300;

document.addEventListener(
  "pointerdown",
  (e) => {
    if (pop && !pop.contains(e.target) && !e.target.closest?.(".modal-backdrop")) {
      closedByOutsideAt = performance.now();
      closePopover();
    }
  },
  true,
);

// --- Modal ------------------------------------------------------------------------------------

let modal = null;

export function openModal(title, body, { width = 460 } = {}) {
  closeModal();
  modal = h(
    "div",
    { class: "modal-backdrop", onpointerdown: (e) => e.target === modal && closeModal() },
    h(
      "div",
      { class: "modal", style: { width: `${width}px` } },
      h("div", { class: "modal-head" }, h("span", { class: "modal-title" }, title), h("button", { class: "ghost icon-btn", title: "Close", onclick: closeModal }, icon("close"))),
      body,
    ),
  );
  document.body.append(modal);
  modal.querySelector("input, select, textarea")?.focus();
}

export function closeModal() {
  modal?.remove();
  modal = null;
}

export const modalOpen = () => !!modal;
