// Where the board's panels go: four zones (a full-width row on top, two columns, a full-width row at the
// bottom), each an ordered list of panel ids, kept in the settings. Panels move by dragging their header,
// or from the keyboard with the grip in it (arrows).

export const BLOCKS = ["today", "weather", "tasks", "week", "news"];
export const ZONES = ["top", "left", "right", "bottom"];
const DEFAULT = { top: [], left: ["today"], right: ["weather", "tasks"], bottom: ["week", "news"] };

export const defaultLayout = () => structuredClone(DEFAULT);

/** A saved layout made whole: every known panel exactly once, unknown ones dropped, missing ones back in their default zone. */
export function normalizeLayout(saved) {
  const out = Object.fromEntries(ZONES.map((z) => [z, []]));
  const seen = new Set();
  for (const z of ZONES) {
    for (const id of Array.isArray(saved?.[z]) ? saved[z] : []) {
      if (BLOCKS.includes(id) && !seen.has(id)) out[z].push(id), seen.add(id);
    }
  }
  for (const z of ZONES) for (const id of DEFAULT[z]) if (!seen.has(id)) out[z].push(id);
  return out;
}

/**
 * Moves panel `id` to position `index` of `zone`, counted among the panels shown (`visible`): hidden
 * ones keep their place around them.
 */
export function moveBlock(layout, id, zone, index, visible) {
  for (const z of ZONES) layout[z] = layout[z].filter((x) => x !== id);
  const before = layout[zone].filter((x) => visible.has(x))[index];
  layout[zone].splice(before ? layout[zone].indexOf(before) : layout[zone].length, 0, id);
}

/**
 * One keyboard step for panel `id` among the panels shown (`visible`): up and down within its zone, then
 * into the zone before or after; left and right between the columns (the rows count as both).
 */
export function stepBlock(layout, id, key, visible) {
  const zoneOf = ZONES.find((z) => layout[z].includes(id));
  const at = layout[zoneOf].filter((x) => visible.has(x)).indexOf(id);
  const count = layout[zoneOf].filter((x) => visible.has(x)).length;
  const put = (z, i) => moveBlock(layout, id, z, i, visible);
  const order = ZONES.indexOf(zoneOf);
  if (key === "ArrowUp") {
    if (at > 0) put(zoneOf, at - 1);
    else if (order > 0) put(ZONES[order - (zoneOf === "right" ? 2 : 1)], Infinity);
    else return false;
  } else if (key === "ArrowDown") {
    if (at < count - 1) put(zoneOf, at + 1);
    else if (order < ZONES.length - 1) put(ZONES[order + (zoneOf === "left" ? 2 : 1)], 0);
    else return false;
  } else if (key === "ArrowLeft" && zoneOf !== "left") put("left", zoneOf === "right" ? at : Infinity);
  else if (key === "ArrowRight" && zoneOf !== "right") put("right", zoneOf === "left" ? at : Infinity);
  else return false;
  return true;
}

// --- Dragging -------------------------------------------------------------------------------------

let drag = null; // { id, el, ph } while a panel is being dragged

/** True while a panel is dragged: the board mustn't be drawn again under it. */
export const dragging = () => !!drag;

/**
 * Lets the panels of `board` be dragged by their header (`.panel-head[draggable]`) into any `.zone`.
 * `onMove(id, zone, index)` runs on a drop; `onEnd()` after every drag, dropped or cancelled.
 */
export function enableDrag(board, { onMove, onEnd }) {
  board.addEventListener("dragstart", (e) => {
    const el = e.target.closest?.(".panel-head")?.closest("[data-block]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ph = document.createElement("div");
    ph.className = "drop-slot";
    ph.style.height = `${Math.min(r.height, 200)}px`;
    drag = { id: el.dataset.block, el, ph };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", drag.id);
    e.dataTransfer.setDragImage(el, e.clientX - r.left, e.clientY - r.top);
    // After the browser has taken its picture of the panel: changing the DOM now would cancel the drag.
    setTimeout(() => {
      if (!drag) return;
      board.classList.add("dragging");
      el.classList.add("drag-src");
      el.after(ph);
    });
  });

  board.addEventListener("dragover", (e) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const zone = e.target.closest?.(".zone");
    if (!zone) return; // between zones: the slot stays where it was
    const before = [...zone.children].find((c) => {
      if (!c.dataset.block || c === drag.el) return false;
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (before ? drag.ph.nextElementSibling !== before : zone.lastElementChild !== drag.ph) zone.insertBefore(drag.ph, before || null);
  });

  board.addEventListener("drop", (e) => {
    if (!drag?.ph.parentElement) return;
    e.preventDefault();
    const zone = drag.ph.parentElement;
    let index = 0;
    for (const c of zone.children) {
      if (c === drag.ph) break;
      if (c.dataset.block && c !== drag.el) index++;
    }
    onMove(drag.id, zone.dataset.zone, index);
  });

  board.addEventListener("dragend", () => {
    if (!drag) return;
    drag.ph.remove();
    drag.el.classList.remove("drag-src");
    board.classList.remove("dragging");
    drag = null;
    onEnd();
  });
}
