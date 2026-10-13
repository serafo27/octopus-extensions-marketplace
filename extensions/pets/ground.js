// The scene's backdrop, in the same pixel art as the sprites (one art pixel = PX screen px): a strip of
// horizon at the top (sky, then hills, a treeline or the sea) and the ground plane below it, with
// patches stretched sideways so it reads as a floor seen from above, and small details (tufts,
// flowers, pebbles, leaves, shells). Everything comes from a hash of the pixel's position, so a resize
// only adds or removes ground at the edges.

import { rgbOf } from "./draw.js";

export const PX = 2.5;      // screen px per art pixel, as for places and adult pets
const HZ = 22;              // art pixels of horizon above the ground (55 px: pets stand from 64 px)

export const GROUNDS = {
  meadow: {
    label: "Meadow",
    sky: ["hsl(205 70% 72%)", "hsl(195 70% 86%)"], cloud: "hsl(0 0% 100%)", cloud2: "hsl(205 40% 88%)",
    far: "hsl(150 22% 58%)", near: "hsl(135 35% 34%)", near2: "hsl(140 38% 27%)", edge: "trees",
    base: "hsl(95 40% 47%)", dark: "hsl(102 40% 40%)", light: "hsl(88 46% 55%)", deep: "hsl(110 38% 31%)",
    details: [
      { kind: "tuft", p: 0.2, colors: ["hsl(110 40% 33%)"], tip: "hsl(85 50% 60%)" },
      { kind: "flower", p: 0.06, colors: ["hsl(350 80% 72%)", "hsl(48 95% 66%)", "hsl(0 0% 97%)", "hsl(265 60% 74%)"], stem: "hsl(110 40% 33%)", eye: "hsl(45 95% 60%)" },
      { kind: "pebble", p: 0.04, colors: ["hsl(40 8% 62%)"], shade: "hsl(40 8% 45%)" },
    ],
  },
  autumn: {
    label: "Autumn",
    sky: ["hsl(205 45% 70%)", "hsl(35 60% 86%)"], cloud: "hsl(30 60% 96%)", cloud2: "hsl(25 35% 84%)",
    far: "hsl(25 30% 58%)", near: "hsl(22 60% 42%)", near2: "hsl(8 55% 36%)", edge: "trees",
    base: "hsl(60 30% 43%)", dark: "hsl(50 32% 36%)", light: "hsl(64 34% 50%)", deep: "hsl(40 30% 28%)",
    details: [
      { kind: "leaf", p: 0.2, colors: ["hsl(22 85% 52%)", "hsl(8 70% 46%)", "hsl(42 90% 55%)", "hsl(30 55% 38%)"] },
      { kind: "tuft", p: 0.18, colors: ["hsl(55 30% 30%)"], tip: "hsl(52 45% 58%)" },
      { kind: "pebble", p: 0.05, colors: ["hsl(30 10% 58%)"], shade: "hsl(30 10% 42%)" },
    ],
  },
  snow: {
    label: "Snow",
    sky: ["hsl(210 30% 74%)", "hsl(210 35% 90%)"], cloud: "hsl(0 0% 100%)", cloud2: "hsl(210 25% 88%)",
    far: "hsl(212 30% 84%)", near: "hsl(165 35% 24%)", near2: "hsl(170 40% 17%)", edge: "pines",
    base: "hsl(210 40% 95%)", dark: "hsl(212 32% 87%)", light: "hsl(0 0% 100%)", deep: "hsl(214 28% 78%)",
    details: [
      { kind: "twig", p: 0.035, colors: ["hsl(25 30% 35%)"] },
      { kind: "pebble", p: 0.06, colors: ["hsl(215 12% 60%)"], shade: "hsl(215 14% 45%)" },
      { kind: "sparkle", p: 0.22, colors: ["hsl(0 0% 100%)"], shade: "hsl(212 32% 82%)" },
    ],
  },
  beach: {
    label: "Beach",
    sky: ["hsl(200 75% 70%)", "hsl(190 70% 88%)"], cloud: "hsl(0 0% 100%)", cloud2: "hsl(200 40% 88%)",
    far: "hsl(200 60% 46%)", near: "hsl(192 60% 56%)", near2: "hsl(0 0% 98%)", edge: "sea",
    base: "hsl(44 60% 78%)", dark: "hsl(40 48% 70%)", light: "hsl(46 70% 85%)", deep: "hsl(36 40% 60%)",
    details: [
      { kind: "shell", p: 0.12, colors: ["hsl(15 70% 86%)", "hsl(0 0% 97%)", "hsl(30 60% 72%)"], shade: "hsl(25 35% 60%)" },
      { kind: "pebble", p: 0.08, colors: ["hsl(35 12% 62%)"], shade: "hsl(35 12% 48%)" },
      { kind: "tuft", p: 0.05, colors: ["hsl(80 30% 45%)"], tip: "hsl(70 40% 62%)" },
    ],
  },
  night: {
    label: "Night",
    sky: ["hsl(235 45% 10%)", "hsl(225 40% 24%)"], stars: "hsl(50 80% 90%)", moon: "hsl(50 60% 88%)",
    far: "hsl(230 22% 26%)", near: "hsl(185 30% 14%)", near2: "hsl(190 35% 10%)", edge: "trees",
    base: "hsl(150 25% 23%)", dark: "hsl(158 28% 18%)", light: "hsl(140 22% 29%)", deep: "hsl(165 30% 13%)",
    details: [
      { kind: "tuft", p: 0.18, colors: ["hsl(160 30% 15%)"], tip: "hsl(140 25% 34%)" },
      { kind: "flower", p: 0.05, colors: ["hsl(220 40% 70%)", "hsl(0 0% 85%)"], stem: "hsl(160 30% 15%)", eye: "hsl(55 60% 70%)" },
      { kind: "firefly", p: 0.025, colors: ["hsl(70 100% 70%)"] },
    ],
  },
  plain: { label: "Plain" },   // the theme's own colours, no art
  // Office mode's (not in the scenery picker): a wall with windows over a wooden floor.
  office: {
    label: "Office", hidden: true, edge: "wall", floor: "planks",
    wall: "hsl(38 30% 82%)", wall2: "hsl(36 24% 76%)", trim: "hsl(30 20% 52%)", frame: "hsl(0 0% 97%)",
    sky0: "hsl(205 70% 74%)", sky1: "hsl(200 70% 86%)", cloud: "hsl(0 0% 100%)",
    base: "hsl(30 42% 52%)", dark: "hsl(28 40% 44%)", light: "hsl(32 46% 58%)", deep: "hsl(26 38% 34%)",
    details: [],
  },
};

/** The colours under a place (its footprint), or null for the default grass. */
export function groundPatch(id) {
  const g = GROUNDS[id];
  return g?.base ? [g.dark, g.deep] : null;
}

// ---- Noise ---------------------------------------------------------------------------------------

function hash(i, j, s = 0) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise(x, y, s) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j, s), b = hash(i + 1, j, s), c = hash(i, j + 1, s), d = hash(i + 1, j + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (i, j) => BAYER[(j & 3) * 4 + (i & 3)];

// ---- Drawing -------------------------------------------------------------------------------------

/** Draws ground `id` on `canvas` for a scene of w×h screen px. */
export function drawGround(canvas, w, h, id) {
  const G = GROUNDS[id];
  const cw = Math.ceil(w / PX), ch = Math.ceil(h / PX);
  canvas.width = cw; canvas.height = ch;
  canvas.style.width = cw * PX + "px"; canvas.style.height = ch * PX + "px";
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(cw, ch), data = img.data;
  const C = {};
  for (const [k, v] of Object.entries(G)) if (typeof v === "string" && k !== "label" && k !== "edge" && k !== "floor") C[k] = rgbOf(v);
  const set = (i, j, rgb) => {
    if (i < 0 || j < 0 || i >= cw || j >= ch) return;
    const o = (j * cw + i) * 4;
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
  };

  if (G.edge === "wall") drawWall(set, C, cw);
  else drawOutdoors(set, C, G, cw);
  if (G.floor === "planks") drawPlanks(set, C, cw, ch);
  else drawGrounds(set, C, G, cw, ch);
  ctx.putImageData(img, 0, 0);
}

/** An office wall: light paint with a faint stripe, a window every so often, a skirting board. */
function drawWall(set, C, cw) {
  for (let j = 0; j < HZ; j++) for (let i = 0; i < cw; i++) set(i, j, i % 8 === 0 && j < HZ - 3 ? C.wall2 : C.wall);
  for (let k = 0; k * 64 < cw + 64; k++) {
    const x0 = k * 64 + 18, y0 = 3, w = 26, h = 12;
    for (let j = y0; j <= y0 + h; j++) for (let i = x0; i <= x0 + w; i++) {
      const edge = j === y0 || j === y0 + h || i === x0 || i === x0 + w || i === x0 + w / 2;
      const cloud = hash(Math.floor(i / 4) + k * 9, Math.floor(j / 2), 31) < 0.12 && j < y0 + 7;
      set(i, j, edge ? C.frame : cloud ? C.cloud : bayer(i, j) < (j - y0) / h ? C.sky1 : C.sky0);
    }
    for (let i = x0 - 1; i <= x0 + w + 1; i++) set(i, y0 + h + 1, C.trim);
  }
  for (let j = HZ - 3; j < HZ; j++) for (let i = 0; i < cw; i++) set(i, j, j === HZ - 3 ? C.frame : C.trim);
}

/** Planks across the floor, each row staggered, with darker seams and a little grain. */
function drawPlanks(set, C, cw, ch) {
  for (let j = HZ; j < ch; j++) {
    const row = Math.floor((j - HZ) / 4), y = (j - HZ) % 4;
    for (let i = 0; i < cw; i++) {
      const x = i + Math.floor(hash(row, 0, 41) * 24), plank = Math.floor(x / 24);
      const tone = hash(plank, row, 42);
      let c = tone < 0.3 ? C.dark : tone > 0.75 ? C.light : C.base;
      if (y === 3 || x % 24 === 0) c = C.deep;
      else if (hash(i, j, 43) < 0.04) c = C.dark;
      set(i, j, c);
    }
  }
}

/** Sky, clouds, stars or the moon, then the far edge: hills and a treeline, pines or the sea. */
function drawOutdoors(set, C, G, cw) {
  // Sky, dithered from top to bottom.
  const skyEnd = G.edge === "sea" ? HZ - 9 : HZ;
  C.sky0 = rgbOf(G.sky[0]); C.sky1 = rgbOf(G.sky[1]);
  for (let j = 0; j < skyEnd; j++) for (let i = 0; i < cw; i++) {
    set(i, j, bayer(i, j) < Math.min(1, j / (skyEnd - 4)) ? C.sky1 : C.sky0);
  }
  if (G.stars) {
    for (let j = 0; j < skyEnd - 6; j++) for (let i = 0; i < cw; i++) if (hash(i, j, 7) < 0.012) set(i, j, C.stars);
  }
  if (G.moon) {
    const mx = Math.floor(cw * 0.82), my = 6;
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
      const d = i * i + j * j, cut = (i + 2) ** 2 + (j - 1) ** 2;
      if (d <= 13 && cut > 10) set(mx + i, my + j, C.moon);
    }
  }
  if (G.cloud) {
    for (let k = 0; k * 60 < cw + 60; k++) {
      if (hash(k, 17, 3) < 0.4) continue;
      const cx = k * 60 + Math.floor(hash(k, 29, 4) * 45), cy = 3 + Math.floor(hash(k, 41, 5) * 7);
      const len = 4 + Math.floor(hash(k, 53, 6) * 10);
      for (let j = -3; j <= 2; j++) for (let i = -len - 3; i <= len + 3; i++) {
        const top = Math.abs(i) < len * 0.5 ? -3 : Math.abs(i) < len ? -2 : -1;
        const end = len + 3 - (j === 2 ? 2 : j < 0 ? 1 - j : 0);
        if (j >= top && Math.abs(i) <= end) set(cx + i, cy + j, j === 2 ? C.cloud2 : C.cloud);
      }
    }
  }

  // The far edge: hills, then a treeline, pines or the sea.
  for (let i = 0; i < cw; i++) {
    if (G.edge === "sea") {
      for (let j = skyEnd; j < HZ; j++) {
        const t = (j - skyEnd) / (HZ - skyEnd);
        let c = bayer(i, j) < t * 1.3 ? C.near : C.far;
        if (j === skyEnd) c = C.near;
        if (hash(i, j, 5) < 0.05 + t * 0.08 && j > skyEnd) c = C.near2;
        if (j === HZ - 1 && (Math.sin(i / 3.5) > -0.3 || hash(i, 0, 9) < 0.3)) c = C.near2;
        set(i, j, c);
      }
      continue;
    }
    const hill = HZ - 9 + Math.round(2.5 * Math.sin(i / 19 + 1) + 1.5 * Math.sin(i / 7.3));
    for (let j = hill; j < HZ; j++) set(i, j, C.far);
    let bump = 0;
    const step = G.edge === "pines" ? 4 : 5;
    for (let k = Math.floor(i / step) - 2; k <= Math.floor(i / step) + 2; k++) {
      const cx = k * step + hash(k, 0, 11) * 3, d = Math.abs(i - cx);
      if (G.edge === "pines") {
        const ht = 4 + hash(k, 1, 11) * 5, half = ht * 0.42;
        if (d < half) bump = Math.max(bump, ht * (1 - d / half));
      } else {
        const r = 2.5 + hash(k, 1, 11) * 2.5;
        if (d < r) bump = Math.max(bump, Math.sqrt(r * r - d * d) * 0.9);
      }
    }
    const top = HZ - 2 - Math.round(bump);
    for (let j = top; j < HZ; j++) set(i, j, (i + j) % 2 && hash(i, j, 13) < 0.45 ? C.near2 : C.near);
  }
}

/** The ground and its details (tufts, flowers, pebbles…). */
function drawGrounds(set, C, G, cw, ch) {
  // The ground: large patches, wider than tall, softened by dithering at their edges.
  for (let j = HZ; j < ch; j++) for (let i = 0; i < cw; i++) {
    const d = j - HZ;
    const v = noise(i / 15, d / 7, 1) * 0.75 + noise(i / 5, d / 2.5, 2) * 0.25;
    const b = (bayer(i, j) - 0.5) * 0.08;
    let c = v + b < 0.36 ? C.dark : v + b > 0.66 ? C.light : C.base;
    if (d === 0) c = C.deep;
    else if (d === 1) c = (i + j) % 2 ? C.deep : C.dark;
    set(i, j, c);
  }

  // Details, one at most per cell, never against the horizon.
  const CX = 7, CY = 6;
  for (let cj = 0; cj * CY < ch; cj++) for (let ci = 0; ci * CX < cw + CX; ci++) {
    const i = ci * CX + Math.floor(hash(ci, cj, 21) * (CX - 2)) + 1;
    const j = HZ + 4 + cj * CY + Math.floor(hash(ci, cj, 22) * (CY - 2));
    if (j >= ch + 2) continue;
    let r = hash(ci, cj, 23);
    const det = G.details.find((x) => (r -= x.p) < 0);
    if (!det) continue;
    const col = rgbOf(det.colors[Math.floor(hash(ci, cj, 24) * det.colors.length)]);
    const sh = det.shade && rgbOf(det.shade);
    switch (det.kind) {
      case "tuft": {
        const tip = rgbOf(det.tip);
        for (const [x, y] of [[-2, 0], [-1, 0], [-1, -1], [0, 0], [0, -1], [0, -2], [1, 0], [1, -1], [2, 0]]) set(i + x, j + y, col);
        set(i - 1, j - 2, tip); set(i, j - 3, tip); set(i + 1, j - 2, tip);
        break;
      }
      case "flower": {
        set(i, j, rgbOf(det.stem));
        for (const [x, y] of [[-1, -2], [1, -2], [0, -1], [0, -3]]) set(i + x, j + y, col);
        set(i, j - 2, rgbOf(det.eye));
        break;
      }
      case "pebble": set(i, j, sh); set(i + 1, j, sh); set(i, j - 1, col); set(i + 1, j - 1, col); set(i + 2, j, sh); break;
      case "leaf": set(i, j, col); set(i + 1, j, col); set(i + 1, j - 1, col); break;
      case "shell": set(i, j, col); set(i + 1, j, col); set(i + 2, j, sh); set(i, j - 1, col); set(i + 1, j - 1, sh); break;
      case "twig": set(i, j, col); set(i + 1, j - 1, col); set(i + 2, j - 1, col); set(i + 3, j - 2, col); set(i + 1, j - 2, col); break;
      case "sparkle": set(i, j, col); set(i - 1, j + 1, sh); set(i + 1, j + 1, sh); break;
      case "firefly": set(i, j - 4, col); break;
    }
  }
}
