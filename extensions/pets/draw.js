// Pixel-art pets and eggs. Shapes are described in a 64×48 space (side view, facing right, ground at
// y = 46) and rasterised to a 32×24 grid; each part gets an outline, then the whole sprite does.
// A sprite is a sheet of 4 frames drawn on a canvas once and cached as a PNG data URL:
//   pets: stand, step A, step B, sleep        eggs: whole, cracked, top shell, bottom shell

import { look, mulberry32, hashStr } from "./genetics.js";

const W = 32, H = 24;
const INK = "#1b1b1f";
const PINK = "hsl(350 60% 76%)";
const BEAK = "hsl(40 90% 55%)";
const FEET = "hsl(30 55% 40%)";
const cache = new Map();

// ---- Raster --------------------------------------------------------------------------------------

class Grid {
  constructor(w = W, h = H) { this.w = w; this.h = h; this.k = new Array(w * h).fill(0); }
  get(i, j) { return i < 0 || j < 0 || i >= this.w || j >= this.h ? 0 : this.k[j * this.w + i]; }
  set(i, j, v) { if (i >= 0 && j >= 0 && i < this.w && j < this.h) this.k[j * this.w + i] = v; }

  /** Paints the pixels whose centre is inside; `edge` outlines the part itself, `only` limits it to those keys. */
  paint(inside, key, { edge = false, only = null } = {}) {
    const { w: W, h: H } = this;
    const mask = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (inside(2 * i + 1, 2 * j + 1) && (!only || only.includes(this.k[j * W + i]))) mask[j * W + i] = 1;
    }
    const m = (i, j) => i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i];
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (!m(i, j)) continue;
      const border = edge && (!m(i - 1, j) || !m(i + 1, j) || !m(i, j - 1) || !m(i, j + 1));
      this.k[j * W + i] = border ? "o" : key;
    }
    return this;
  }

  /** A 1-pixel outline around everything, then a darker row along the bottom of the coat. */
  finish(soft = []) {
    const { w: W, h: H } = this;
    const src = this.k.slice();
    const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= H ? 0 : src[j * W + i]);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (src[j * W + i]) continue;
      const n = [at(i - 1, j), at(i + 1, j), at(i, j - 1), at(i, j + 1)];
      if (n.some((v) => v && v !== "o" && !soft.includes(v))) this.k[j * W + i] = "o";
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (this.get(i, j) === "b" && this.get(i, j + 1) === "o") this.k[j * W + i] = "sh";
    }
    return this;
  }
}

const rad = (d) => (d * Math.PI) / 180;
const ell = (cx, cy, rx, ry, rot = 0) => (x, y) => {
  let dx = x - cx, dy = y - cy;
  if (rot) { const a = -rad(rot), c = Math.cos(a), s = Math.sin(a); [dx, dy] = [dx * c - dy * s, dx * s + dy * c]; }
  return (dx / rx) ** 2 + (dy / ry) ** 2 <= 1;
};
const poly = (pts) => (x, y) => {
  let inside = false;
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [xa, ya] = pts[a], [xb, yb] = pts[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
};
const line = (pts, width) => (x, y) => {
  const r = Math.max(width, 2.2) / 2;
  for (let n = 1; n < pts.length; n++) {
    const [ax, ay] = pts[n - 1], [bx, by] = pts[n];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= r) return true;
  }
  return false;
};
const bez = (p0, p1, p2, p3, n = 14) => Array.from({ length: n + 1 }, (_, k) => {
  const t = k / n, u = 1 - t;
  return [0, 1].map((d) => u * u * u * p0[d] + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * p3[d]);
});

// ---- Pets ----------------------------------------------------------------------------------------

const GEO = {
  cat: { bx: 29, by: 31, brx: 15, bry: 8.5, hx: 46, hy: 22, hr: 8, legW: 3.6 },
  dog: { bx: 28, by: 29, brx: 17, bry: 9.5, hx: 47, hy: 20, hr: 8.5, legW: 4 },
  fox: { bx: 29, by: 31, brx: 15, bry: 8, hx: 46, hy: 22, hr: 7.5, legW: 3.6 },
  rabbit: { bx: 28, by: 33, brx: 14, bry: 10, hx: 43, hy: 24, hr: 8, legW: 4 },
  mouse: { bx: 29, by: 37, brx: 13, bry: 7, hx: 42, hy: 34, hr: 6.5, legW: 3 },
};

function coatPattern(g, L, cx, cy, rx, ry, seed) {
  const rng = mulberry32(seed);
  const only = { only: ["b"] };
  if (L.pattern === "stripes") {
    const n = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const x = cx - rx * 0.55 + (i * rx * 1.1) / (n - 1);
      g.paint(line([[x, cy - ry], [x + 1.5, cy + ry * 0.2]], 2.4), "d", only);
    }
  } else if (L.pattern === "spots") {
    const n = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * 0.65;
      g.paint(ell(cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d, 2.4 + rng() * 1.6, 2.2 + rng() * 1.2), "d", only);
    }
  } else if (L.pattern === "belly") {
    g.paint(ell(cx + 2, cy + ry * 0.55, rx * 0.75, ry * 0.5), "l", only);
  }
}

function quadruped(p, L, seed, frame) {
  const T = p.type;
  const G = { ...GEO[T] };
  const sleep = frame === 3;
  if (sleep) { G.by += 5; G.hy += 7; G.hx -= 1; }
  const { bx, by, brx, bry, hx, hy, hr, legW } = G;
  const points = L.pattern === "points";
  const ext = points ? "d" : "b";                         // ears, tail, muzzle
  const legKey = points || L.pattern === "tip" ? "d" : "b";
  const g = new Grid();
  const rx = bx - brx + 1.5, ry = by - 2;

  // Tail, behind everything.
  if (T === "cat") g.paint(line(bez([rx, ry], [rx - 8, ry - 1], [rx - 10, ry - 13], [rx - 5, ry - 18]), 3.4), ext);
  if (T === "dog") g.paint(line(bez([rx, ry], [rx - 7, ry - 3], [rx - 8, ry - 9], [rx - 6, ry - 13]), 3.8), ext);
  if (T === "fox") {
    g.paint(ell(rx - 7, ry - 1, 10, 4.8, 28), ext, { edge: true });
    if (L.pattern === "tip") g.paint(ell(rx - 14.6, ry - 5.3, 3.4, 3.4), "l", { only: [ext] });
  }
  if (T === "rabbit") g.paint(ell(rx, ry - 1, 4, 4), "l", { edge: true });
  if (T === "mouse") g.paint(line(bez([rx, ry + 2], [rx - 10, ry + 5], [rx - 12, ry - 7], [rx - 21, ry - 3]), 2.2), "p");

  // Legs: the far pair shaded, the near pair in front of the body. Steps swing the feet.
  const legTop = by + bry * 0.3;
  const swing = frame === 1 ? 2.5 : frame === 2 ? -2.5 : 0;
  const leg = (x, off, key) => g.paint(line([[x, legTop], [x + off, 44.5]], legW), key);
  const xb = bx - brx * 0.6, xf = bx + brx * 0.58;
  if (!sleep) { leg(xb + 3, -swing, "s"); leg(xf + 3, swing, "s"); }

  g.paint(ell(bx, by, brx, bry), "b", { edge: true });
  coatPattern(g, L, bx, by, brx, bry, seed);
  if (T === "rabbit") g.paint(ell(bx - 6, by + 3, 7, 6.5), "b", { edge: true });
  if (!sleep) { leg(xb, swing, legKey); leg(xf, -swing, legKey); }
  else g.paint(ell(xf, by + bry - 1, 3.5, 2), legKey, { edge: true });

  // Ears behind the head.
  if (T === "cat" || T === "fox") {
    const k = T === "fox" ? (L.bigEars ? 1.6 : 1.2) : 1;
    g.paint(poly([[hx - 7, hy - 1], [hx - 5, hy - 6 - 7 * k], [hx, hy - 6]]), ext, { edge: true });
    g.paint(poly([[hx - 1, hy - 7], [hx + 4, hy - 6 - 7 * k], [hx + 7.5, hy]]), ext, { edge: true });
    g.paint(poly([[hx + 1.5, hy - 6], [hx + 4, hy - 4 - 6 * k], [hx + 6, hy - 3]]), "p", { only: [ext] });
  }
  if (T === "rabbit" && !L.floppy) {
    g.paint(ell(hx - 4, hy - 11, 3.4, 8.5, -14), ext, { edge: true });
    g.paint(ell(hx + 1, hy - 12, 3.4, 8.5, 6), ext, { edge: true });
    g.paint(ell(hx + 1, hy - 12, 1.4, 6, 6), "p", { only: [ext] });
  }
  if (T === "mouse") { g.paint(ell(hx - 2, hy - 6, 5, 5), "b", { edge: true }); g.paint(ell(hx - 2, hy - 6, 2.6, 2.6), "p", { only: ["b"] }); }

  g.paint(ell(hx, hy, hr, hr), "b", { edge: true });

  // Ears and muzzle in front of the head.
  if (T === "dog") g.paint(ell(hx - 4, hy, 3.6, 7, 22), "d", { edge: true });
  if (T === "rabbit" && L.floppy) g.paint(ell(hx - 5, hy + 3, 3.4, 8.5, 22), ext, { edge: true });
  const muzzle = points ? "d" : "l";
  if (T === "dog") g.paint(ell(hx + 7, hy + 3, 5.4, 4), muzzle, { edge: true });
  if (T === "fox") g.paint(poly([[hx + 2, hy - 2], [hx + 13, hy + 3], [hx + 2, hy + 6]]), "l", { edge: true });
  if (T === "mouse") g.paint(poly([[hx + 2, hy - 3], [hx + 11, hy + 1.5], [hx + 2, hy + 4.5]]), "b", { edge: true });

  // Face: nose and eye pixels.
  const px = (x, y, k) => g.set(Math.floor(x / 2), Math.floor(y / 2), k);
  if (T === "dog") px(hx + 11.5, hy + 2, "n");
  if (T === "fox") px(hx + 12.5, hy + 3, "n");
  if (T === "cat" || T === "rabbit") px(hx + 7.5, hy + 2, "p");
  if (T === "mouse") px(hx + 11, hy + 1.5, "p");
  eye(g, hx + 3.5, hy - 1.5, sleep);
  return g.finish();
}

function bird(p, L, seed, frame) {
  const g = new Grid();
  const sleep = frame === 3, dy = sleep ? 5 : 0;
  const hop = frame === 2 ? -1.5 : 0;
  if (!sleep) {
    g.paint(line([[27, 38 + hop], [27, 45]], 2), "f");
    g.paint(line([[32, 38 + hop], [32.5, 45]], 2), "f");
  }
  g.paint(poly([[19, 27 + dy], [5, 21 + dy], [8, 32 + dy]]), "d", { edge: true });
  g.paint(ell(28, 31 + dy + hop, 12.5, 9.5), "b", { edge: true });
  g.paint(ell(31, 35 + dy + hop, 8, 5), "l", { only: ["b"] });
  if (L.pattern === "stripes" || L.pattern === "spots") coatPattern(g, L, 27, 29 + dy + hop, 9, 6, seed);
  const up = frame === 1;
  g.paint(up ? ell(24, 22 + dy, 8, 4.5, -35) : ell(25, 30 + dy + hop, 8.5, 5), "d", { edge: true });
  const hy = (sleep ? 27 : 20) + hop, hx = sleep ? 37 : 39;
  g.paint(ell(hx, hy, 7.5, 7.5), "b", { edge: true });
  g.paint(poly([[hx + 5, hy - 3], [hx + 13, hy + 1], [hx + 5, hy + 3.5]]), "k", { edge: true });
  eye(g, hx + 2.5, hy - 1.5, sleep);
  return g.finish();
}

function eye(g, x, y, closed) {
  const i = Math.floor(x / 2), j = Math.floor(y / 2);
  if (closed) { g.set(i, j + 1, "o"); g.set(i - 1, j + 1, "o"); }
  else { g.set(i, j, "e"); g.set(i, j + 1, "e"); }
}

// ---- Output --------------------------------------------------------------------------------------

function sheet(grids, colors, scale = 1) {
  const { w, h } = grids[0];
  const c = document.createElement("canvas");
  c.width = w * grids.length * scale; c.height = h * scale;
  const ctx = c.getContext("2d");
  grids.forEach((g, f) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = g.k[j * w + i];
      if (!k) continue;
      ctx.fillStyle = colors[k] || colors.o;
      ctx.fillRect((f * w + i) * scale, j * scale, scale, scale);
    }
  });
  return c.toDataURL();
}

function paletteOf(L) {
  const h = Math.round(L.h);
  return {
    o: L.line, b: L.body, sh: L.shade, s: L.shade, d: L.dark, l: L.belly,
    p: PINK, e: INK, n: INK, k: BEAK, f: FEET, egg: `hsl(${h} 35% 93%)`, eggsh: `hsl(${h} 25% 80%)`,
  };
}

function keyOf(p, kind) {
  const g = p.genes;
  return `${kind}|${p.id}|${p.type}|${p.species}|${p.pattern}|${g.hue}|${g.sat}|${g.light}`;
}

function petSheet(p) {
  const key = keyOf(p, "pet");
  if (!cache.has(key)) {
    const L = look(p);
    const seed = hashStr(p.id || p.name || "x");
    const draw = p.type === "bird" ? bird : quadruped;
    cache.set(key, sheet([0, 1, 2, 3].map((f) => draw(p, L, seed, f)), paletteOf(L)));
  }
  return cache.get(key);
}

const crackRow = (i) => 14 + [0, -1, 0, 1][i % 4];

function eggSheet(p) {
  const key = keyOf(p, "egg");
  if (!cache.has(key)) {
    const L = look(p);
    const rng = mulberry32(hashStr((p.id || p.name) + "egg"));
    const shape = (x, y) => {
      if (y < 12 || y > 46) return false;
      const rx = 12.5 * (y < 31 ? 0.72 + 0.28 * ((y - 12) / 19) : 1);
      return ell(32, 31, rx, 15.5)(x, y);
    };
    const whole = new Grid().paint(shape, "egg");
    for (let n = 0; n < 7; n++) {
      const i = 12 + Math.floor(rng() * 8), j = 8 + Math.floor(rng() * 12);
      if (whole.get(i, j) === "egg") whole.set(i, j, "b");
    }
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      if (whole.get(i, j) && !whole.get(i, j + 1)) whole.set(i, j, "eggsh");
    }
    const cracked = new Grid(), top = new Grid(), bottom = new Grid();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = whole.get(i, j);
      if (!k) continue;
      const r = crackRow(i);
      cracked.set(i, j, j === r ? "o" : k);
      (j < r ? top : bottom).set(i, j, j === r ? "o" : k);
    }
    cache.set(key, sheet([whole, cracked, top, bottom].map((g) => g.finish()), paletteOf(L)));
  }
  return cache.get(key);
}

/** A pet's sprite (frame chosen by CSS: stand, walking steps, sleep). */
export function petArt(p) {
  return `<div class="px" style="background-image:url(${petSheet(p)})"></div>`;
}

/** An egg, speckled in the colour of what's inside; `.cracking` on an ancestor shows the crack. */
export function eggArt(p) {
  return `<div class="px egg-px" style="background-image:url(${eggSheet(p)})"></div>`;
}

/** The two halves of the shell, left behind when the pet hatches. */
export function eggDebris(p) {
  const url = eggSheet(p);
  return `<div class="px egg-bottom" style="background-image:url(${url})"></div><div class="px egg-top" style="background-image:url(${url})"></div>`;
}

// ---- Scene: places (one per project), food bowls, balls, tool icons -----------------------------

const rect = (x, y, w, h) => (X, Y) => X >= x && X < x + w && Y >= y && Y < y + h;
const OUT = "hsl(25 25% 16%)";

/** How pets use a place: go inside (`enter`), climb on top (`perch`: height in art units), rest beside. */
export const PLACE_KINDS = {
  house: { label: "House", enter: true },
  tent: { label: "Tent", enter: true },
  tree: { label: "Tree", perch: 74 },
  pine: { label: "Pine", perch: 0 },
  desk: { label: "Desk" },
};

let normCtx;
/** A CSS colour as [r, g, b] (the canvas normalises any syntax). */
export function rgbOf(c) {
  normCtx ||= document.createElement("canvas").getContext("2d");
  normCtx.fillStyle = "#000";
  normCtx.fillStyle = c;
  const h = normCtx.fillStyle;
  if (h[0] === "#") return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return h.match(/[\d.]+/g).slice(0, 3).map(Number);
}
/** Towards white (amt > 0) or black (amt < 0). */
function tint(c, amt) {
  const t = amt < 0 ? 0 : 255, a = Math.abs(amt);
  return `rgb(${rgbOf(c).map((v) => Math.round(v + (t - v) * a)).join(",")})`;
}
function each(g, fn) { for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) fn(i, j, g.get(i, j)); }
function recolor(g, from, to, test) { each(g, (i, j, k) => { if (k === from && test(i, j)) g.set(i, j, to); }); }

/** A place is 48×44 pixels (96×88 units), ground at y = 86, in the project's colour; `patch` colours
 *  the ground it stands on (two tones), grass by default. */
export function placeArt(kind, color, lit, seed, patch = null) {
  const key = `place|${kind}|${color}|${lit}|${seed}|${patch}`;
  if (cache.has(key)) return cache.get(key);
  const g = new Grid(48, 44);
  const e = { edge: true };
  const rng = mulberry32(seed);
  const grass = (rx) => {
    g.paint(ell(48, 85, rx, 3.6), "grass");
    each(g, (i, j, k) => { if (k === "grass" && (i + j) % 2 && rng() < 0.5) g.set(i, j, "grass2"); });
  };

  if (kind === "house") {
    grass(46);
    g.paint(rect(64, 12, 10, 30), "brick", e);
    recolor(g, "brick", "mortar", (i, j) => j % 3 === 0 || (i + (Math.floor(j / 3) % 2) * 2) % 4 === 0);
    g.paint(rect(62, 9, 14, 4), "stone", e);
    g.paint(rect(14, 44, 68, 42), "wall", e);
    recolor(g, "wall", "wall2", (i, j) => j % 3 === 0);
    recolor(g, "wall", "wall3", (i) => i >= 37);
    recolor(g, "wall2", "wall3", (i) => i >= 37);
    g.paint(poly([[4, 49], [48, 5], [92, 49]]), "roof", e);
    recolor(g, "roof", "roof2", (i, j) => j % 3 === 2 || (j % 3 === 1 && (i + Math.floor(j / 3)) % 3 === 0));
    each(g, (i, j, k) => { if (k === "roof" && g.get(i - 1, j) === "o") g.set(i, j, "roof3"); });
    g.paint(rect(4, 46, 88, 4), "trim", e);
    recolor(g, "wall", "wallsh", (i, j) => j === 25);
    recolor(g, "wall2", "wallsh", (i, j) => j === 25);
    recolor(g, "wall3", "wallsh", (i, j) => j === 25);
    // Attic window, two windows with shutters and flower boxes, a door.
    g.paint(ell(48, 32, 5.6, 5.6), "win", e);
    for (const [x0, y0] of [[22, 54], [60, 54]]) {
      g.paint(rect(x0 - 5, y0, 5, 16), "shutter", e);
      g.paint(rect(x0 + 14, y0, 5, 16), "shutter", e);
      g.paint(rect(x0, y0, 14, 16), "win", e);
      g.paint(rect(x0 - 2, y0 + 16, 18, 4), "box", e);
      for (let x = x0; x < x0 + 14; x += 3) g.set(Math.floor(x / 2), Math.floor((y0 + 14) / 2), rng() < 0.5 ? "fl1" : "fl2");
    }
    each(g, (i, j, k) => {
      if (k !== "win") return;
      if (i === 14 || i === 24 || i === 33 || j === 16 || j === 31 || (i === 32 && j === 31)) g.set(i, j, "frame");
    });
    for (const [i, j] of [[12, 28], [13, 28], [12, 29], [31, 28], [32, 28], [31, 29]]) if (g.get(i, j) === "win") g.set(i, j, "glint");
    g.paint((x, y) => rect(40, 62, 16, 24)(x, y) || ell(48, 63, 8, 5)(x, y), "door", e);
    recolor(g, "door", "door2", (i) => i % 2 === 0);
    g.set(26, 37, "knob");
    g.paint(rect(36, 83, 24, 4), "stone", e);
    // Shrubs.
    for (const x of [9, 87]) {
      g.paint(ell(x, 80, 9, 7), "leaf", e);
      g.paint(ell(x - 2, 77, 4, 3), "leafl", { only: ["leaf"] });
      g.set(Math.floor((x + 3) / 2), 39, "fl1");
      g.set(Math.floor((x - 4) / 2), 40, "fl2");
    }
  } else if (kind === "tree") {
    grass(40);
    g.paint(poly([[38, 86], [43, 50], [53, 50], [58, 86]]), "trunk", e);
    g.paint(poly([[31, 86], [42, 77], [44, 86]]), "trunk", e);
    g.paint(poly([[65, 86], [54, 77], [52, 86]]), "trunk", e);
    g.paint(line([[46, 58], [33, 45]], 3.4), "trunk");
    g.paint(line([[51, 56], [63, 45]], 3.4), "trunk");
    recolor(g, "trunk", "bark", (i, j) => (i * 7 + j * 3) % 5 === 0);
    recolor(g, "trunk", "trunkd", (i) => i >= 25);
    const blobs = [[48, 34, 31, 19], [25, 45, 15, 11], [71, 45, 15, 11], [34, 21, 17, 13], [62, 21, 17, 13], [48, 12, 16, 11], [48, 47, 22, 9]];
    g.paint((x, y) => blobs.some(([cx, cy, rx, ry]) => ell(cx, cy, rx, ry)(x, y)), "leaf");
    for (const [cx, cy, rx, ry] of blobs) {
      g.paint((x, y) => ell(cx, cy, rx, ry)(x, y) && !ell(cx - 1, cy - 3, rx - 1, ry - 2)(x, y), "leafd", { only: ["leaf"] });
      g.paint(ell(cx - rx * 0.3, cy - ry * 0.35, rx * 0.38, ry * 0.32), "leafl", { only: ["leaf"] });
    }
    each(g, (i, j, k) => { if (k === "leaf" && (i + j) % 2 && rng() < 0.12) g.set(i, j, "leafd"); });
    // Fruit in the project's colour.
    for (let tries = 0, fruit = 0; tries < 200 && fruit < 9; tries++) {
      const i = 6 + Math.floor(rng() * 36), j = 2 + Math.floor(rng() * 26);
      if (["leaf", "leafl"].includes(g.get(i, j)) && ["leaf", "leafl", "leafd"].includes(g.get(i + 1, j))) {
        g.set(i, j, "fruit"); g.set(i + 1, j, "fruitd");
        fruit++;
      }
    }
  } else if (kind === "pine") {
    grass(36);
    g.paint(rect(44, 72, 8, 14), "trunk", e);
    recolor(g, "trunk", "trunkd", (i) => i >= 24);
    const tiers = [[78, 46, 38], [62, 30, 31], [46, 15, 24], [30, 2, 15]];
    for (const [y0, y1, w] of tiers) {
      const bottom = (x) => y0 + Math.sin(x / 4) * 1.6;
      g.paint((x, y) => y <= bottom(x) && poly([[48 - w, y0 + 2], [48, y1], [48 + w, y0 + 2]])(x, y), "pine", e);
      g.paint((x, y) => y > bottom(x) - 5 && poly([[48 - w, y0 + 2], [48, y1], [48 + w, y0 + 2]])(x, y), "pined", { only: ["pine"] });
    }
    recolor(g, "pine", "pinel", (i, j) => i < 22 && (i + j) % 2 === 0);
    recolor(g, "pine", "pined", (i, j) => i > 26 && (i + j) % 3 === 0);
    for (let n = 0; n < 9; n++) {
      const i = 12 + Math.floor(rng() * 24), j = 6 + Math.floor(rng() * 30);
      if (["pine", "pinel", "pined"].includes(g.get(i, j))) g.set(i, j, n % 3 ? "fruit" : "fl2");
    }
    for (const [i, j] of [[24, 0], [23, 1], [24, 1], [25, 1], [24, 2]]) g.set(i, j, "star");
  } else {
    grass(44);
    g.paint(poly([[4, 86], [48, 13], [92, 86]]), "roof", e);
    recolor(g, "roof", "roofl", (i) => Math.floor((i + 1) / 3) % 2 === 0);
    each(g, (i, j, k) => { if ((k === "roof" || k === "roofl") && g.get(i + 1, j) === "o") g.set(i, j, "roof2"); });
    g.paint(poly([[38, 86], [48, 50], [58, 86]]), lit ? "lamp" : "dark");
    if (lit) g.paint(ell(48, 86, 6, 8), "lamp2", { only: ["lamp"] });
    g.paint(poly([[48, 50], [58, 86], [66, 86]]), "trim", e);
    g.paint(line([[48, 14], [48, 3]], 2), "trunk");
    g.paint(poly([[49, 2], [63, 6], [49, 10]]), "flag", e);
    for (const x of [6, 90]) g.paint(rect(x - 1, 82, 2, 5), "trunk");
  }
  g.finish(["grass", "grass2"]);
  const colors = {
    o: OUT, sh: OUT, grass: patch?.[0] || "hsl(95 32% 36%)", grass2: patch?.[1] || "hsl(100 30% 28%)",
    brick: "hsl(8 50% 45%)", mortar: "hsl(20 25% 68%)", stone: "hsl(30 8% 60%)",
    wall: "hsl(38 45% 85%)", wall2: "hsl(36 35% 75%)", wall3: "hsl(34 30% 70%)", wallsh: "hsl(30 22% 55%)",
    roof: color, roof2: tint(color, -0.3), roof3: tint(color, 0.3), roofl: tint(color, 0.45),
    trim: tint(color, -0.5), shutter: tint(color, -0.2), box: "hsl(25 45% 38%)",
    win: lit ? "hsl(46 95% 66%)" : "hsl(212 35% 30%)", glint: lit ? "hsl(52 100% 88%)" : "hsl(205 40% 60%)", frame: "hsl(36 30% 92%)",
    door: "hsl(25 50% 36%)", door2: "hsl(25 50% 29%)", knob: "hsl(45 90% 60%)",
    fl1: "hsl(350 80% 66%)", fl2: "hsl(48 95% 62%)",
    leaf: "hsl(108 42% 40%)", leafl: "hsl(92 50% 52%)", leafd: "hsl(130 42% 25%)",
    trunk: "hsl(25 40% 34%)", trunkd: "hsl(25 40% 26%)", bark: "hsl(25 35% 24%)",
    fruit: color, fruitd: tint(color, -0.35),
    pine: "hsl(150 42% 30%)", pinel: "hsl(140 40% 40%)", pined: "hsl(160 45% 20%)", star: "hsl(48 100% 62%)",
    dark: "hsl(25 30% 14%)", lamp: "hsl(40 90% 55%)", lamp2: "hsl(48 100% 75%)", flag: "hsl(48 95% 60%)",
  };
  const url = sheet([g], colors);
  cache.set(key, url);
  return url;
}

/** A pixel shadow, 15×3, black: shown under pets and things at low opacity. */
export function shadowArt() {
  if (!cache.has("shadow")) {
    const g = new Grid(15, 3);
    g.paint(ell(15, 3, 15, 3.2), "x");
    cache.set("shadow", sheet([g], { x: "#000" }));
  }
  return cache.get("shadow");
}

/** A food bowl, 12×8 pixels; frames: full, half, empty. */
export function bowlArt() {
  if (!cache.has("bowl")) {
    const frames = [1, 0.6, 0].map((amount) => {
      const g = new Grid(12, 8);
      if (amount) {
        g.paint(ell(12, 8, 9 * amount, 4.5 * amount), "food", { edge: true });
        for (const [i, j] of [[4, 3], [7, 3], [5, 2], [8, 4]]) if (g.get(i, j) === "food") g.set(i, j, "food2");
      }
      g.paint(poly([[2, 8], [22, 8], [19, 15], [5, 15]]), "bowl", { edge: true });
      g.paint(rect(4, 9, 16, 2), "bowl2", { only: ["bowl"] });
      return g.finish();
    });
    cache.set("bowl", sheet(frames, { o: OUT, food: "hsl(28 50% 38%)", food2: "hsl(35 60% 58%)", bowl: "hsl(0 62% 50%)", bowl2: "hsl(0 70% 64%)" }));
  }
  return cache.get("bowl");
}

/** A ball, 16×16 pixels: a shaded sphere whose stripe turns over 4 frames as it rolls. */
export function ballArt(hue) {
  const key = "ball|" + hue;
  if (!cache.has(key)) {
    const c = 16, R = 14.8;
    const inside = ell(c, c, R, R);
    const frames = [-0.75, -0.25, 0.25, 0.75].map((shift) => {
      const g = new Grid(16, 16);
      g.paint(inside, "ball", { edge: true });
      // A band of longitude on the sphere: straight at the middle, curved towards the edges.
      g.paint((x, y) => {
        const v = (y - c) / R, w = Math.sqrt(Math.max(0.05, 1 - v * v));
        let u = (x - c) / (R * w) - shift;
        u = ((u + 1) % 2 + 2) % 2 - 1;
        return Math.abs(u) < 0.3;
      }, "ball2", { only: ["ball"] });
      g.paint((x, y) => (x - c) + (y - c) > R * 0.75, "balld", { only: ["ball"] });
      g.paint((x, y) => (x - c) + (y - c) > R * 0.75, "ball2d", { only: ["ball2"] });
      for (const [i, j] of [[4, 4], [5, 4], [4, 5], [6, 3]]) if (g.get(i, j) !== "o") g.set(i, j, "hi");
      return g.finish();
    });
    cache.set(key, sheet(frames, {
      o: OUT, ball: `hsl(${hue} 75% 55%)`, balld: `hsl(${hue} 70% 42%)`,
      ball2: `hsl(${hue} 40% 94%)`, ball2d: `hsl(${hue} 25% 78%)`, hi: "#fff",
    }));
  }
  return cache.get(key);
}

/** Toolbar and cursor icons, 12×12 pixels (`scale` 2 for a cursor). */
export function toolIcon(kind, scale = 1) {
  const key = `tool|${kind}|${scale}`;
  if (!cache.has(key)) {
    const g = new Grid(12, 12);
    if (kind === "food") {
      g.paint(ell(12, 13, 9, 5), "food", { edge: true });
      g.paint(poly([[1, 13], [23, 13], [19, 22], [5, 22]]), "bowl", { edge: true });
    } else if (kind === "brush") {
      g.paint(line([[4, 21], [13, 12]], 3.4), "wood", { edge: true });
      g.paint(ell(16, 8, 7, 4.2, -45), "head", { edge: true });
      g.paint(line([[13, 3], [21, 11]], 2), "bristle", { only: ["head"] });
    } else if (kind === "ball") {
      g.paint(ell(12, 12, 9, 9), "ball", { edge: true });
      g.paint(rect(0, 10, 24, 4), "ball2", { only: ["ball"] });
    } else if (kind === "erase") {
      g.paint(poly([[3, 15], [12, 6], [21, 15], [12, 24]]), "rub", { edge: true });
      g.paint(poly([[3, 15], [8, 10], [17, 19], [12, 24]]), "rub2", { only: ["rub"] });
    } else {
      g.paint(ell(12, 14, 7, 6), "paw", { edge: true });
      for (const [x, y] of [[5, 6], [10, 4], [15, 4], [20, 7]]) g.paint(ell(x, y, 2.6, 2.8), "paw", { edge: true });
    }
    g.finish();
    cache.set(key, sheet([g], {
      o: OUT, food: "hsl(28 50% 40%)", bowl: "hsl(0 62% 50%)", wood: "hsl(25 45% 40%)", head: "hsl(205 60% 50%)",
      bristle: "hsl(45 60% 85%)", rub: "hsl(345 70% 72%)", rub2: "hsl(210 45% 55%)", ball: "hsl(350 75% 55%)", ball2: "hsl(350 40% 92%)", paw: "hsl(30 30% 70%)",
    }, scale));
  }
  return cache.get(key);
}

/** A card table for poker night, 24×14 pixels (48×28 units, ground at 27). */
export function tableArt() {
  if (!cache.has("table")) {
    const g = new Grid(24, 14);
    g.paint(rect(8, 12, 3, 15), "wood", { edge: true });
    g.paint(rect(37, 12, 3, 15), "wood", { edge: true });
    g.paint(ell(24, 11, 23, 8), "wood", { edge: true });
    g.paint(ell(24, 10.5, 19, 5.6), "felt", { only: ["wood"] });
    for (const [i, j, k] of [[9, 4, "card"], [10, 4, "card"], [14, 5, "card"], [12, 6, "chip"], [13, 6, "chip2"], [8, 6, "chip"], [16, 4, "chip2"]]) g.set(i, j, k);
    g.finish();
    cache.set("table", sheet([g], { o: OUT, sh: OUT, wood: "hsl(25 45% 35%)", felt: "hsl(145 45% 30%)", card: "#f4f1ea", chip: "hsl(0 70% 52%)", chip2: "hsl(210 70% 55%)" }));
  }
  return cache.get("table");
}

/** A building site over a place, same 48×44 pixels: scaffolding on the right, a striped barrier on
 *  the left with a warning lamp, a cone in front. Frames: lamp off, lamp on (blinks while work goes on). */
export function siteArt() {
  if (!cache.has("site")) {
    const frames = [false, true].map((on) => {
      const g = new Grid(48, 44);
      const e = { edge: true };
      // Scaffolding: two poles, three planks, a brace.
      for (const x of [72, 90]) g.paint(rect(x, 26, 3, 61), "pole", e);
      for (const y of [30, 50, 70]) g.paint(rect(68, y, 28, 3), "plank", e);
      g.paint(line([[74, 68], [90, 52]], 1.6), "pole");
      g.paint(line([[74, 48], [90, 32]], 1.6), "pole");
      // A barrier on two legs, striped, with its lamp.
      for (const x of [8, 32]) g.paint(rect(x, 74, 3, 13), "pole", e);
      g.paint(rect(4, 72, 34, 6), "bar", e);
      recolor(g, "bar", "bar2", (i) => Math.floor(i / 2) % 2 === 0);
      g.paint(ell(9, 69, 3.4, 3.4), on ? "lamp" : "lampoff", e);
      // A cone.
      g.paint(poly([[58, 87], [63, 70], [68, 87]]), "cone", e);
      g.paint(rect(56, 84, 14, 3), "cone", e);
      recolor(g, "cone", "cone2", (i, j) => j === 39 || j === 40);
      return g.finish();
    });
    cache.set("site", sheet(frames, {
      o: OUT, sh: OUT, pole: "hsl(30 10% 55%)", plank: "hsl(32 50% 50%)",
      bar: "hsl(0 70% 52%)", bar2: "hsl(40 30% 94%)", lamp: "hsl(40 100% 60%)", lampoff: "hsl(30 50% 32%)",
      cone: "hsl(22 95% 55%)", cone2: "hsl(40 30% 94%)",
    }));
  }
  return cache.get("site");
}

/** Where a desk's monitors stand (art units, 0–96): one per seat, up to three. */
export function deskSeats(n) {
  return [[48], [30, 66], [18, 48, 78]][Math.max(1, Math.min(3, n)) - 1];
}

/** A project's desk in office mode, 48×44 pixels like a place: a rug in the project's colour, a desk,
 *  a monitor per seat (`seats`: each "off", "idle", "working" or "waiting") with a coffee mug beside
 *  the busy ones, a lamp, lit on the work project's (when there's room). Frames: two, for code scrolling and steam rising. */
export function deskArt(color, lit, seats, seed) {
  const key = `desk|${color}|${lit}|${seats.join(",")}|${seed}`;
  if (cache.has(key)) return cache.get(key);
  const list = seats.length ? seats.slice(0, 3) : ["off"];
  const xs = deskSeats(list.length);
  const frames = [0, 1].map((f) => {
    const g = new Grid(48, 44);
    const e = { edge: true };
    g.paint(ell(48, 84, 46, 4), "rug");
    g.paint(ell(48, 84, 40, 2.6), "rug2", { only: ["rug"] });
    // Desk: top, legs, a drawer block on the right.
    g.paint(rect(4, 54, 88, 5), "top", e);
    g.paint(rect(8, 59, 4, 26), "leg", e);
    g.paint(rect(84, 59, 4, 26), "leg", e);
    g.paint(rect(66, 59, 18, 22), "drawer", e);
    g.paint(rect(68, 63, 14, 2), "drawer2", { only: ["drawer"] });
    g.paint(rect(68, 72, 14, 2), "drawer2", { only: ["drawer"] });
    // A lamp at the left end, lit on the work project's desk; a plant on the right.
    if (list.length < 3) {
      g.paint(rect(5, 50, 8, 4), "lampb", e);
      g.paint(line([[8, 50], [8, 40], [14, 34]], 1.6), "lampb");
      g.paint(poly([[10, 32], [20, 30], [18, 38]]), lit ? "lampon" : "lampb", e);
    }
    if (list.length < 3) {
      g.paint(rect(84, 46, 8, 8), "pot", e);
      g.paint((x, y) => ell(88, 42, 6, 5)(x, y) || ell(84, 38, 3, 4)(x, y) || ell(92, 38, 3, 4)(x, y), "leaf", e);
    }
    list.forEach((st, k) => {
      const cx = xs[k];
      g.paint(rect(cx - 2, 46, 4, 8), "stand", e);
      g.paint(rect(cx - 6, 52, 12, 2), "stand", e);
      g.paint(rect(cx - 12, 26, 24, 20), "bezel", e);
      g.paint(rect(cx - 10, 28, 20, 15), st === "off" ? "scr0" : st === "waiting" ? "scrw" : "scr", { only: ["bezel"] });
      if (st === "working" || st === "idle") {
        // Lines of code, scrolling a line per frame while it works.
        const shift = st === "working" ? f : 0;
        for (let row = 0; row < 6; row++) {
          const j = 14 + row, len = 2 + Math.floor(mulberry32(seed + row + shift * 7 + k * 13)() * 7);
          const indent = (row + shift) % 3;
          for (let i = 0; i < len; i++) {
            const x = Math.floor((cx - 9) / 2) + indent + i;
            if (g.get(x, j) === "scr" && (row + shift) % 4 !== 3) g.set(x, j, i < 2 ? "code1" : "code2");
          }
        }
        if (st === "idle") g.set(Math.floor((cx - 9) / 2) + 1, 20, f ? "scr" : "code1");
      } else if (st === "waiting") {
        g.set(Math.floor(cx / 2), 16, "ink"); g.set(Math.floor(cx / 2), 17, "ink"); g.set(Math.floor(cx / 2), 18, "ink"); g.set(Math.floor(cx / 2), 20, "ink");
      }
      // Coffee beside a busy monitor, steaming.
      if (st !== "off") {
        const mx = cx + (k === list.length - 1 && list.length > 1 ? -18 : 14);
        g.paint(rect(mx - 3, 47, 7, 7), "mug", e);
        g.paint(rect(mx + 4, 49, 3, 3), "mug", e);
        g.paint(rect(mx - 2, 47, 5, 1.6), "coffee", { only: ["mug"] });
        for (const [dx, dy] of f ? [[0, 44], [1, 42], [0, 40]] : [[1, 45], [0, 43], [1, 41]]) g.set(Math.floor((mx + dx * 2) / 2), Math.floor(dy / 2), "steam");
      }
    });
    return g.finish(["rug", "rug2", "steam"]);
  });
  const url = sheet(frames, {
    o: OUT, sh: OUT, rug: tint(color, 0.35), rug2: tint(color, 0.15),
    top: "hsl(30 35% 46%)", leg: "hsl(28 30% 34%)", drawer: "hsl(30 32% 42%)", drawer2: "hsl(28 30% 30%)",
    stand: "hsl(220 8% 40%)", bezel: "hsl(220 10% 22%)",
    scr0: "hsl(220 12% 14%)", scr: "hsl(220 30% 18%)", scrw: "hsl(38 90% 55%)", ink: "hsl(25 60% 18%)",
    code1: color, code2: "hsl(140 45% 62%)",
    mug: "hsl(0 0% 95%)", coffee: "hsl(25 50% 24%)", steam: "hsl(0 0% 88%)",
    lampb: "hsl(220 8% 30%)", lampon: "hsl(48 100% 65%)",
    pot: "hsl(15 55% 45%)", leaf: "hsl(120 40% 38%)",
  });
  cache.set(key, url);
  return url;
}
