// {{variable}} highlighting in inputs and textareas, with a tooltip to see, edit or define a variable.
//
// A layer with the same text sits over the field (which draws its text transparent) and colours the
// variables: found ones in one colour, undefined ones in red. `ctx`:
//   lookup(name) -> { value, source: "env" | "collection" | "dynamic", scopeName } | null
//   set(name, value)            changes a variable where lookup found it
//   add(name, value, where)     defines it in "env" or "collection"
//   envName, collName           where it can be added (null when there's no such scope)
//   onChange()                  after set/add

import { h } from "./ui.js";

const VAR = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX = 200_000;
const PROPS = [
  "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing", "textIndent", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
];
const live = new Set();

/** Repaints every field on screen (after a variable was defined or changed). */
export function refreshVarFields() {
  for (const f of live) if (f.el.isConnected) f.paint();
  else live.delete(f);
}

/** Wraps `el` (an input or textarea) and returns the wrapper to put where `el` would go. */
export function varField(el, ctx) {
  const isArea = el.tagName === "TEXTAREA";
  const inner = h("div", { class: "vf-inner" });
  const back = h("div", { class: "vf-back" + (isArea ? " area" : "") }, inner);
  const wrap = h("div", { class: "vf vf-off" + (isArea ? " vf-area" : "") }, el, back);
  el.classList.add("vf-input");

  const copyStyle = () => {
    const cs = getComputedStyle(el);
    for (const p of PROPS) back.style[p] = cs[p];
    if (isArea) {
      const sb = el.offsetWidth - el.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      back.style.paddingRight = parseFloat(cs.paddingRight) + sb + "px";
    }
  };
  const scroll = () => (inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`);
  const paint = () => {
    const v = el.value;
    const off = el.type === "password" || v.length > MAX || !v.includes("{{");
    wrap.classList.toggle("vf-off", off);
    if (off) return inner.replaceChildren();
    if (el.isConnected) copyStyle();
    const parts = [];
    let last = 0;
    for (const m of v.matchAll(VAR)) {
      parts.push(v.slice(last, m.index));
      parts.push(h("span", { class: "vf-var " + (ctx.lookup(m[1]) ? "ok" : "missing"), dataset: { name: m[1] } }, m[0]));
      last = m.index + m[0].length;
    }
    parts.push(v.slice(last) + (isArea ? "\n " : ""));
    inner.replaceChildren(...parts);
    scroll();
  };
  const f = { el, paint };
  live.add(f);
  el.paintVars = paint;
  el.addEventListener("input", paint);
  el.addEventListener("focus", paint);
  el.addEventListener("blur", paint);
  for (const ev of ["scroll", "keyup", "click", "select"]) el.addEventListener(ev, scroll);
  requestAnimationFrame(paint);

  wrap.addEventListener("mousemove", (e) => {
    if (wrap.classList.contains("vf-off")) return hideSoon();
    const box = wrap.getBoundingClientRect();
    const span = [...inner.querySelectorAll(".vf-var")].find((s) => {
      const r = s.getBoundingClientRect();
      return e.clientX >= Math.max(r.left, box.left) && e.clientX <= Math.min(r.right, box.right) && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (span) showTip(span, span.dataset.name, ctx);
    else hideSoon();
  });
  wrap.addEventListener("mouseleave", hideSoon);
  return wrap;
}

// --- Tooltip --------------------------------------------------------------------------------------

let tip = null;
let tipTimer = null;

function hideSoon() {
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    if (tip && !tip.contains(document.activeElement)) hide();
  }, 250);
}

function hide() {
  tip?.remove();
  tip = null;
}

addEventListener("keydown", (e) => e.key === "Escape" && tip && hide(), true);

const SOURCE = { env: "Environment", collection: "Collection", dynamic: "Dynamic" };

function showTip(span, name, ctx) {
  clearTimeout(tipTimer);
  if (tip?.dataset.name === name && tip.isConnected) return;
  hide();
  const info = ctx.lookup(name);
  const body = [h("div", { class: "vt-head" }, h("span", { class: "mono vt-name" + (info ? "" : " missing") }, `{{${name}}}`),
    info && h("span", { class: "badge" }, SOURCE[info.source] + (info.scopeName ? " · " + info.scopeName : "")))];

  if (info?.source === "dynamic") {
    body.push(h("div", { class: "faint" }, "Generated when the request is sent."));
  } else if (info) {
    const input = h("input", { class: "mono", value: info.value ?? "", spellcheck: false, placeholder: "Empty" });
    input.addEventListener("input", () => {
      ctx.set(name, input.value);
      refreshVarFields();
      ctx.onChange?.();
    });
    input.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === "Escape") && hide());
    input.addEventListener("blur", hideSoon);
    body.push(input);
  } else {
    body.push(h("div", { class: "vt-missing" }, "Not defined in the active environment or the collection."));
    const targets = [ctx.envName != null && ["env", `Add to “${ctx.envName}”`], ctx.collName != null && ["collection", `Add to collection “${ctx.collName}”`]].filter(Boolean);
    if (targets.length) {
      const input = h("input", { class: "mono", spellcheck: false, placeholder: "Value" });
      input.addEventListener("blur", hideSoon);
      const add = (where) => {
        ctx.add(name, input.value, where);
        hide();
        refreshVarFields();
        ctx.onChange?.();
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && add(targets[0][0]));
      body.push(input, h("div", { class: "vt-actions" }, targets.map(([w, label], i) =>
        h("button", { class: (i === 0 ? "primary " : "") + "small", onmousedown: (e) => e.preventDefault(), onclick: () => add(w) }, label))));
    } else body.push(h("div", { class: "faint" }, "Pick an environment, or save the request in a collection, to define it."));
  }

  tip = h("div", { class: "var-tip", dataset: { name }, onmouseenter: () => clearTimeout(tipTimer), onmouseleave: hideSoon }, body);
  document.body.append(tip);
  const r = span.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  tip.style.left = Math.max(4, Math.min(r.left, innerWidth - t.width - 8)) + "px";
  tip.style.top = (r.bottom + 4 + t.height > innerHeight ? r.top - t.height - 4 : r.bottom + 4) + "px";
}
