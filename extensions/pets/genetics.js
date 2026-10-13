// Species, genes and the semi-random algorithms that create, inherit and invent them.

export const DAY_SECONDS = 120;        // real seconds per pet-day at 1×
export const MATURITY_DAYS = 5;        // adult from this age: can breed
export const GESTATION_DAYS = 1.5;     // from mating to the egg
export const BREED_COOLDOWN_DAYS = 4;
export const MAX_POPULATION = 30;      // living pets and eggs: no breeding beyond

export const ANIMALS = {
  cat: {
    label: "Cat", scale: 1, life: 1, hop: false,
    bias: { sociability: -0.08, curiosity: 0.08 },
    species: {
      Tabby: { hue: 28, sat: 75, light: 55, pattern: "stripes" },
      Siamese: { hue: 35, sat: 40, light: 84, pattern: "points" },
      Black: { hue: 260, sat: 10, light: 18, pattern: "solid" },
      Calico: { hue: 30, sat: 70, light: 62, pattern: "spots" },
      "British Blue": { hue: 215, sat: 12, light: 58, pattern: "solid" },
    },
  },
  dog: {
    label: "Dog", scale: 1.1, life: 1, hop: false,
    bias: { sociability: 0.15, energy: 0.08 },
    species: {
      Shiba: { hue: 26, sat: 70, light: 52, pattern: "belly", belly: [40, 40, 92] },
      Dalmatian: { hue: 40, sat: 10, light: 94, pattern: "spots" },
      Labrador: { hue: 40, sat: 65, light: 62, pattern: "solid" },
      Husky: { hue: 210, sat: 10, light: 45, pattern: "belly", belly: [0, 0, 95] },
      Beagle: { hue: 30, sat: 55, light: 45, pattern: "belly", belly: [0, 0, 95] },
    },
  },
  rabbit: {
    label: "Rabbit", scale: 0.9, life: 0.85, hop: true,
    bias: { fertility: 0.15, sociability: 0.05, curiosity: -0.05 },
    species: {
      Lop: { hue: 30, sat: 40, light: 55, pattern: "solid", floppy: true },
      "Snow White": { hue: 0, sat: 0, light: 96, pattern: "solid" },
      Dutch: { hue: 0, sat: 0, light: 22, pattern: "belly", belly: [0, 0, 96] },
      Lionhead: { hue: 35, sat: 45, light: 70, pattern: "points" },
    },
  },
  bird: {
    label: "Bird", scale: 0.85, life: 0.8, hop: true,
    bias: { energy: 0.15, speed: 0.1 },
    species: {
      Canary: { hue: 52, sat: 90, light: 58, pattern: "solid" },
      Robin: { hue: 25, sat: 30, light: 40, pattern: "belly", belly: [15, 75, 55] },
      Bluebird: { hue: 212, sat: 70, light: 52, pattern: "belly", belly: [28, 60, 72] },
      Parakeet: { hue: 110, sat: 65, light: 48, pattern: "stripes" },
      Cardinal: { hue: 355, sat: 80, light: 45, pattern: "solid" },
    },
  },
  fox: {
    label: "Fox", scale: 1, life: 0.9, hop: false,
    bias: { curiosity: 0.15, sociability: -0.1 },
    species: {
      Red: { hue: 22, sat: 85, light: 50, pattern: "tip" },
      Arctic: { hue: 200, sat: 10, light: 94, pattern: "solid" },
      Fennec: { hue: 38, sat: 55, light: 72, pattern: "tip", bigEars: true },
      Silver: { hue: 220, sat: 6, light: 30, pattern: "tip" },
    },
  },
  mouse: {
    label: "Mouse", scale: 0.8, life: 0.6, hop: false,
    bias: { fertility: 0.2, speed: 0.1, size: -0.1 },
    species: {
      House: { hue: 30, sat: 8, light: 55, pattern: "belly" },
      White: { hue: 0, sat: 0, light: 95, pattern: "solid" },
      Field: { hue: 28, sat: 45, light: 42, pattern: "belly" },
    },
  },
};

export const PATTERNS = ["solid", "stripes", "spots", "belly", "points", "tip"];

export const GENES = ["hue", "sat", "light", "size", "speed", "curiosity", "sociability", "fertility", "longevity", "energy"];

export const TRAIT_LABELS = {
  size: "Size", speed: "Speed", curiosity: "Curiosity", sociability: "Sociability",
  fertility: "Fertility", energy: "Energy", longevity: "Longevity",
};

export const QUIRKS = {
  none: "No particular quirk",
  zoomies: "Gets the zoomies",
  napper: "Naps a lot",
  wanderer: "Wanders far",
  clingy: "Follows its friends",
  spinner: "Chases its tail",
  singer: "Hums little tunes",
};
const QUIRK_IDS = Object.keys(QUIRKS);

// ---- Randomness ----------------------------------------------------------------------------------

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gauss = (rng) => (rng() + rng() + rng() - 1.5) / 0.5; // ~N(0, 1), bounded
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

// ---- Names ---------------------------------------------------------------------------------------

const SYL = ["mo", "chi", "pi", "ku", "la", "no", "ra", "be", "zu", "fi", "lo", "mi", "sa", "to", "ko",
  "ri", "na", "po", "bu", "ta", "ni", "ma", "yu", "pe", "do", "li", "su", "ka", "ne", "gu"];

export function randomName(rng = Math.random) {
  let s = pick(SYL, rng);
  if (rng() < 0.12) s += s;                       // Momo, Kiki
  else { s += pick(SYL, rng); if (rng() < 0.2) s += pick(SYL, rng); }
  return s[0].toUpperCase() + s.slice(1);
}

// ---- Species -------------------------------------------------------------------------------------

/** The preset species of an animal, or one invented from its name (same name, same look). */
export function speciesDef(type, name) {
  const presets = ANIMALS[type].species;
  const key = Object.keys(presets).find((k) => k.toLowerCase() === String(name).trim().toLowerCase());
  if (key) return presets[key];
  const rng = mulberry32(hashStr(type + "/" + String(name).trim().toLowerCase()));
  return {
    hue: Math.floor(rng() * 360), sat: 20 + rng() * 60, light: 30 + rng() * 50,
    pattern: pick(PATTERNS, rng), floppy: type === "rabbit" && rng() < 0.3, bigEars: type === "fox" && rng() < 0.3,
  };
}

export function normalizeSpecies(type, name) {
  const n = String(name || "").trim();
  if (!n) return Object.keys(ANIMALS[type].species)[0];
  const key = Object.keys(ANIMALS[type].species).find((k) => k.toLowerCase() === n.toLowerCase());
  return key || n.replace(/\b\w/g, (c) => c.toUpperCase());
}

export const sameSpecies = (a, b) => a.type === b.type && a.species.toLowerCase() === b.species.toLowerCase();

// ---- Genes ---------------------------------------------------------------------------------------

/** A founder's genes: each the mean of two draws (bell-shaped), nudged by the animal's nature. */
export function randomGenes(rng, type) {
  const bias = ANIMALS[type].bias || {};
  const g = {};
  for (const k of GENES) g[k] = clamp((rng() + rng()) / 2 + (bias[k] || 0), 0.02, 0.98);
  return g;
}

export function founderPattern(type, species, rng) {
  return rng() < 0.88 ? speciesDef(type, species).pattern : pick(PATTERNS, rng);
}

export const randomQuirk = (rng) => (rng() < 0.3 ? "none" : pick(QUIRK_IDS.slice(1), rng));

/** A child's genes: each from one parent or their blend, plus a small mutation. */
export function inheritGenes(a, b, rng) {
  const g = {};
  for (const k of GENES) {
    const r = rng();
    const v = r < 0.4 ? a[k] : r < 0.8 ? b[k] : (a[k] + b[k]) / 2;
    g[k] = clamp(v + gauss(rng) * 0.06, 0.02, 0.98);
  }
  return g;
}

export function inheritPattern(a, b, rng) {
  return rng() < 0.06 ? pick(PATTERNS, rng) : rng() < 0.5 ? a.pattern : b.pattern;
}

export function inheritQuirk(a, b, rng) {
  const r = rng();
  return r < 0.45 ? a.quirk : r < 0.9 ? b.quirk : randomQuirk(rng);
}

/** Genes for an invented parent: close to the child's, as if the child had inherited them. */
export function ancestorGenes(child, rng) {
  const g = {};
  for (const k of GENES) g[k] = clamp(child[k] + gauss(rng) * 0.12, 0.02, 0.98);
  return g;
}

// ---- Phenotype -----------------------------------------------------------------------------------

export function lifespanOf(type, genes) {
  return (20 + genes.longevity * 20) * ANIMALS[type].life;
}

export function temperament(g) {
  if (g.energy < 0.3) return "Lazy";
  if (g.curiosity > 0.68 && g.energy > 0.6) return "Adventurous";
  if (g.sociability > 0.7) return "Cuddly";
  if (g.sociability < 0.3) return "Shy";
  if (g.curiosity > 0.65) return "Curious";
  if (g.energy > 0.7) return "Playful";
  if (g.speed > 0.7) return "Restless";
  return "Easygoing";
}

export function phenotype(p) {
  const g = p.genes;
  return {
    size: (0.82 + g.size * 0.4) * ANIMALS[p.type].scale,
    speed: 24 + g.speed * 46,                   // px per second
    lifespan: lifespanOf(p.type, g),            // days
    fertility: 0.25 + g.fertility * 0.75,
    temperament: temperament(g),
    quirk: QUIRKS[p.quirk] || QUIRKS.none,
  };
}

/** Colours of a pet's coat (artwork, not UI: they don't follow the theme). */
export function look(p) {
  const def = speciesDef(p.type, p.species);
  const g = p.genes;
  const h = (def.hue + (g.hue - 0.5) * 36 + 360) % 360;
  const s = clamp(def.sat + (g.sat - 0.5) * 30, 0, 100);
  const l = clamp(def.light + (g.light - 0.5) * 22, 10, 96);
  const hsl = (H, S, L) => `hsl(${Math.round(H)} ${Math.round(S)}% ${Math.round(L)}%)`;
  return {
    h, s, l,
    body: hsl(h, s, l),
    shade: hsl(h, s, Math.max(6, l - 9)),
    dark: l < 30 ? hsl(h, s, l + 20) : hsl(h, Math.min(100, s + 8), l - 24),
    belly: def.belly ? hsl(...def.belly) : hsl(h, s * 0.55, Math.min(97, l + 24)),
    line: hsl(h, s * 0.6, Math.max(6, l - 38)),
    pattern: p.pattern,
    floppy: !!def.floppy,
    bigEars: !!def.bigEars,
  };
}
