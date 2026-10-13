import * as G from "./genetics.js";
import { petArt, eggArt, eggDebris, placeArt, siteArt, deskArt, deskSeats, bowlArt, ballArt, tableArt, toolIcon, shadowArt, PLACE_KINDS } from "./draw.js";
import { GROUNDS, drawGround, groundPatch } from "./ground.js";

const $ = (s) => document.querySelector(s);
const HATCH_SECONDS = 6;       // real seconds an egg wobbles and cracks
const ZOOM = 1.25;             // on-screen size of an adult of size 1
const PLACE_SCALE = 1.25;      // places: 2.5 screen px per art pixel
const BALL_SECONDS = 45;       // a ball lasts this long, then deflates
const MAX_BOWLS = 6, MAX_BALLS = 3;
const STORE_KEY = "world";
const PLACE_ORDER = ["house", "tree", "tent", "pine"];
// Time away (section hidden, Octopus closed, the Mac asleep) is made up when the world runs again,
// in coarse steps, up to a cap so a long absence doesn't wipe the family out.
const AWAY_AFTER_MS = 5000;    // shorter gaps are just frames
const AWAY_STEP_DAYS = 0.1;
const MAX_AWAY_DAYS = 10;

/** Everything that lasts (saved in Octopus storage). Pets are kept after death, for heritage. */
let world = freshWorld();
/** What doesn't: DOM and behaviour of what's on screen, by id. */
const rt = new Map(), placeRt = new Map(), itemRt = new Map();
let selectedId = null, selectedPlace = null;
let her = null;                // heritage view: { id, back: [ids] }
let dirty = false, sideStale = false, loopError = "";
let tool = "hand";
let projects = [], workProjectId = null;
/** Octopus's terminals (permissions.terminals): each open one is a building site at its project's place. */
let terminals = [];
/** Who works on which terminal's site: terminal id → pet id. Lives only on screen. */
const crew = new Map();
let siteT = 0;
let W = 800, H = 600;

const worldEl = $("#world"), sideEl = $("#side"), herEl = $("#heritage");

function freshWorld() {
  return { v: 1, time: 0, speed: 1, paused: false, nextId: 1, pets: {}, places: {}, items: [], ground: "meadow" };
}

// ---- Queries ---------------------------------------------------------------------------------------

const pets = () => Object.values(world.pets);
const onScreen = () => pets().filter((p) => p.stage === "alive" || p.stage === "egg");
const ageOf = (p) => (p.stage === "dead" ? p.diedAt - p.bornAt : world.time - p.bornAt);
const childrenOf = (id) => pets().filter((p) => p.mother === id || p.father === id).sort((a, b) => a.bornAt - b.bornAt);
const siblingsOf = (p) => (p.mother ? pets().filter((q) => q.id !== p.id && q.mother === p.mother && q.father === p.father) : []);
const sexSym = (p) => (p.sex === "f" ? "♀" : "♂");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const days = (d) => (d < 10 ? d.toFixed(1) : Math.floor(d)) + "d";
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const rnd = Math.random;

function stageLabel(p) {
  if (p.stage === "egg") return "Egg";
  if (p.stage === "dead") return "Departed";
  const age = ageOf(p), t = G.phenotype(p);
  if (age < G.MATURITY_DAYS) return "Baby";
  return age > t.lifespan * 0.8 ? "Elder" : "Adult";
}

function scaleOf(p) {
  const t = G.phenotype(p);
  const s = p.stage === "egg" ? 0.7 * G.ANIMALS[p.type].scale : t.size * (0.55 + 0.45 * Math.min(1, ageOf(p) / G.MATURITY_DAYS));
  return Math.round(s * ZOOM * 4) / 4;   // whole half-pixels: crisp pixel art, babies grow in steps
}

function bounds() {
  return { x0: 30, x1: Math.max(60, W - 30), y0: 64, y1: Math.max(90, H - 22) };
}
/** The scene is 0×0 while Octopus keeps the section hidden: nothing is laid out until it has a size. */
const sized = () => W > 120 && H > 120;
/** Office mode: an office floor, every project's place a desk. */
const groundId = () => (world.office ? "office" : world.ground);
const clampPos = (p) => {
  if (!sized()) return;
  const b = bounds();
  p.x = Math.max(b.x0, Math.min(b.x1, p.x));
  p.y = Math.max(b.y0, Math.min(b.y1, p.y));
};

/** Food, cleanliness and joy, from 0 (bad) to 1 (good). Older saves have none. */
function needs(p) {
  if (!p.needs) p.needs = { food: 0.8, clean: 0.85, joy: 0.7 };
  return p.needs;
}

// ---- Creating pets ---------------------------------------------------------------------------------

function newId(prefix = "p") { return prefix + world.nextId++; }

function addFounder(d) {
  const b = bounds();
  const p = {
    id: newId(), name: d.name, type: d.type, species: d.species, sex: d.sex,
    genes: d.genes, pattern: d.pattern, quirk: d.quirk,
    mother: null, father: null, gen: 1, founder: true,
    stage: "egg", bornAt: world.time, diedAt: null,
    x: b.x0 + rnd() * (b.x1 - b.x0), y: b.y0 + rnd() * (b.y1 - b.y0),
  };
  world.pets[p.id] = p;
  ensureAncestors(p, 2);
  mount(p);
  select(p.id);
  save(true);
}

function addChild(mother, father) {
  const p = {
    id: newId(), name: G.randomName(rnd), type: mother.type, species: mother.species,
    sex: rnd() < 0.5 ? "f" : "m",
    genes: G.inheritGenes(mother.genes, father.genes, rnd),
    pattern: G.inheritPattern(mother, father, rnd), quirk: G.inheritQuirk(mother, father, rnd),
    mother: mother.id, father: father.id, gen: Math.max(mother.gen || 1, father.gen || 1) + 1,
    stage: "egg", bornAt: world.time, diedAt: null,
    x: mother.x - (rt.get(mother.id)?.dir || 1) * 22, y: mother.y + 6,
  };
  clampPos(p);
  world.pets[p.id] = p;
  mount(p);
  return p;
}

/** Invents the parents of a founder or of an invented ancestor, as far back as `depth`. */
function ensureAncestors(p, depth) {
  if (!p || depth <= 0) return;
  if (!p.mother && !p.father && (p.founder || p.generated)) {
    const rng = G.mulberry32(G.hashStr(`${p.id}/${p.name}/${p.species}/${p.genes.hue}`));
    for (const sex of ["f", "m"]) {
      const genes = G.ancestorGenes(p.genes, rng);
      const life = G.lifespanOf(p.type, genes);
      const bornAt = p.bornAt - (G.MATURITY_DAYS + 1 + rng() * life * 0.6);
      const a = {
        id: newId(), name: G.randomName(rng), type: p.type, species: p.species, sex, genes,
        pattern: rng() < 0.8 ? p.pattern : G.PATTERNS[Math.floor(rng() * G.PATTERNS.length)],
        quirk: rng() < 0.4 ? p.quirk : G.randomQuirk(rng),
        mother: null, father: null, gen: (p.gen || 1) - 1, generated: true,
        stage: "dead", bornAt, diedAt: bornAt + life * (0.8 + rng() * 0.2),
      };
      world.pets[a.id] = a;
      p[sex === "f" ? "mother" : "father"] = a.id;
    }
    dirty = true;
  }
  ensureAncestors(world.pets[p.mother], depth - 1);
  ensureAncestors(world.pets[p.father], depth - 1);
}

// ---- Pets on screen --------------------------------------------------------------------------------

function mount(p) {
  const el = document.createElement("div");
  el.className = "pet";
  el.dataset.id = p.id;
  el.innerHTML = `<div class="shadow"></div><div class="sprite"></div><div class="label"></div>`;
  const r = {
    el, sprite: el.children[1], label: el.children[2], cls: {}, s: 0, dir: rnd() < 0.5 ? -1 : 1,
    mind: { mode: "idle", t: 0.5 + rnd() * 2 }, walking: false, eggT: 0, zT: 0, held: false, lift: 0,
  };
  r.label.textContent = p.name;
  rt.set(p.id, r);
  if (p.x == null) { const b = bounds(); p.x = b.x0 + rnd() * (b.x1 - b.x0); p.y = b.y0 + rnd() * (b.y1 - b.y0); }
  drawSprite(p);
  setCls(r, "hop", G.ANIMALS[p.type].hop);
  worldEl.appendChild(el);
  grab(p.id, el);
  place(p, r);
  renderEmpty();
}

function drawSprite(p) {
  const r = rt.get(p.id);
  r.sprite.innerHTML = p.stage === "egg" ? eggArt(p) : petArt(p);
  setCls(r, "egg", p.stage === "egg");
}

function setCls(r, c, on) {
  if (!!r.cls[c] !== on) { r.cls[c] = on; r.el.classList.toggle(c, on); }
}

function place(p, r) {
  const s = scaleOf(p);
  if (Math.abs(s - r.s) > 0.004) { r.s = s; r.el.style.setProperty("--s", s.toFixed(3)); }
  r.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  r.el.style.zIndex = String(Math.round(p.y));
  const mode = r.mind.mode;
  setCls(r, "left", r.dir < 0);
  setCls(r, "walking", r.walking);
  setCls(r, "running", r.walking && !!r.running);
  setCls(r, "spin", mode === "spin");
  setCls(r, "eating", mode === "eat");
  const atDesk = mode === "work" && placeRt.get(r.mind.place)?.kind === "desk";
  setCls(r, "building", mode === "work" && !!r.building && !atDesk);
  setCls(r, "typing", atDesk && !!r.building);
  setCls(r, "sleeping", mode === "sleep" || (mode === "work" && r.mind.breakT > 15));
  setCls(r, "brushed", mode === "brushed");
  setCls(r, "inside", mode === "inside");
  setCls(r, "perched", mode === "perch");
  if (mode === "perch" && r.lift !== r.mind.lift) { r.lift = r.mind.lift; r.el.style.setProperty("--lift", r.lift + "px"); }
  setCls(r, "held", r.held);
  setCls(r, "selected", p.id === selectedId);
  if (p.stage === "alive") {
    setCls(r, "elder", ageOf(p) > G.phenotype(p).lifespan * 0.8);
    setCls(r, "dirty", needs(p).clean < 0.3);
  }
  if (p.stage === "egg") setCls(r, "cracking", r.eggT > HATCH_SECONDS * 0.5);
}

function fxAt(el, text, cls = "") {
  const f = document.createElement("span");
  f.className = "fx " + cls;
  f.textContent = text;
  el.appendChild(f);
  setTimeout(() => f.remove(), 1700);
}
const fx = (p, text, cls) => { const r = rt.get(p.id); if (r) fxAt(r.el, text, cls); };

/** Drag a pet around; a click without moving selects it (and pets it when already selected). */
function grab(id, el) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || tool !== "hand") return;   // other tools are handled by the world
    e.preventDefault();
    e.stopPropagation();
    const p = world.pets[id], r = rt.get(id);
    if (!p || !r) return;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved && p.stage === "alive") r.mind = { mode: "idle", t: 1.5 };
      moved = true;
      r.held = p.stage === "alive";
      p.x = start.px + dx; p.y = start.py + dy;
      clampPos(p);
      place(p, r);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      r.held = false;
      if (moved) { r.mind = { mode: "idle", t: 1.5 }; dirty = true; return; }
      if (selectedId === id && p.stage === "alive") {
        fx(p, "♥", "heart");
        needs(p).joy = clamp01(needs(p).joy + 0.03);
        if (r.mind.mode === "sleep") r.mind = { mode: "idle", t: 1 };
      }
      select(id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

// ---- Places: one per Octopus project ---------------------------------------------------------------

/** A project's place keeps its kind; a new one gets the kind there's least of. */
function placeKind(proj) {
  const spot = world.places[proj.id];
  if (!spot.kind) {
    const count = (k) => Object.values(world.places).filter((p) => p.kind === k).length;
    spot.kind = [...PLACE_ORDER].sort((a, b) => count(a) - count(b))[0];
    dirty = true;
  }
  return spot.kind;
}

function placeColor(proj) {
  if (proj.color) return proj.color;
  return `hsl(${G.hashStr(proj.id + "c") % 360} 55% 55%)`;
}

/** Where a project's place stands: kept as a fraction of the scene, so it follows resizes. */
function placePos(id) {
  const f = world.places[id];
  const b = bounds();
  return {
    x: Math.max(b.x0 + 30, Math.min(b.x1 - 30, f.fx * W)),
    y: Math.max(b.y0 + 70, Math.min(b.y1, f.fy * H)),
  };
}

/** A new place goes where it's farthest from the others. */
function findSpot() {
  const others = [];
  for (const id of placeRt.keys()) others.push(placePos(id));
  const b = bounds();
  let best = null, bestScore = -1;
  for (let k = 0; k < 40; k++) {
    const x = b.x0 + 50 + rnd() * Math.max(10, b.x1 - b.x0 - 100);
    const y = b.y0 + 90 + rnd() * Math.max(10, b.y1 - b.y0 - 100);
    const score = others.length ? Math.min(...others.map((o) => Math.hypot((o.x - x) * 0.8, o.y - y))) : rnd();
    if (score > bestScore) { bestScore = score; best = { x, y }; }
  }
  return { fx: best.x / W, fy: best.y / H };
}

function renderPlaces() {
  if (!sized()) return;
  const ids = new Set(projects.map((p) => p.id));
  for (const [id, pr] of placeRt) {
    if (!ids.has(id) || world.places[id]?.hidden) { evacuate(id); pr.el.remove(); placeRt.delete(id); }
  }
  for (const proj of projects) {
    if (world.places[proj.id]?.hidden) continue;
    if (!world.places[proj.id]) { world.places[proj.id] = findSpot(); dirty = true; }
    let pr = placeRt.get(proj.id);
    if (!pr) {
      const el = document.createElement("div");
      el.className = "place";
      el.dataset.id = proj.id;
      el.style.setProperty("--s", PLACE_SCALE);
      el.innerHTML = `<div class="sprite"><div class="px1"></div></div><div class="sprite site"><div class="px1" style="background-image:url(${siteArt()})"></div></div><div class="label"></div>`;
      pr = { el, id: proj.id, art: "" };
      placeRt.set(proj.id, pr);
      worldEl.appendChild(el);
      dragPlace(pr);
    }
    const kind = world.office ? "desk" : placeKind(proj), lit = proj.id === workProjectId;
    Object.assign(pr, { kind, name: proj.name, lit });
    setPlaceArt(pr, proj);
    pr.el.classList.toggle("office", kind === "desk");
    pr.el.classList.toggle("work", lit);
    pr.el.classList.toggle("smoking", lit && kind === "house");
    pr.el.classList.toggle("selected", selectedPlace === proj.id);
    pr.el.querySelector(".label").textContent = proj.name;
    pr.el.title = `${proj.name} · ${PLACE_KINDS[kind].label}${lit ? " · work project" : ""}`;
    positionPlace(pr);
  }
  renderSites();
}

/** A place's art: its kind's, or its desk with a monitor per open terminal in office mode. */
function artFor(proj, kind, lit) {
  if (kind === "desk") return deskArt(placeColor(proj), lit, sitesAt(proj.id).map((t) => t.state), G.hashStr(proj.id));
  return placeArt(kind, placeColor(proj), lit, G.hashStr(proj.id), groundPatch(groundId()));
}

function setPlaceArt(pr, proj) {
  const art = artFor(proj, pr.kind, pr.lit);
  if (pr.art !== art) { pr.art = art; pr.el.querySelector(".px1").style.backgroundImage = `url(${art})`; }
}

/** Inline style showing a place's art as a thumbnail (a desk's is a sheet of two frames). */
const artStyle = (art, kind) => (art ? `background-image:url(${art})${kind === "desk" ? ";background-size:200% 100%" : ""}` : "");

function positionPlace(pr) {
  const { x, y } = placePos(pr.id);
  pr.x = x; pr.y = y;
  pr.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  pr.el.style.zIndex = String(Math.round(y));
}

function dragPlace(pr) {
  pr.el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || tool !== "hand") return;
    e.preventDefault();
    e.stopPropagation();
    pr.el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, px: pr.x, py: pr.y };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      Object.assign(world.places[pr.id], { fx: (start.px + dx) / W, fy: (start.py + dy) / H });
      positionPlace(pr);
      for (const [pid, r] of rt) {          // whoever was on it or in it comes out
        if (r.mind.place === pr.id) { const p = world.pets[pid]; leavePlace(p, r); }
      }
    };
    const up = () => {
      pr.el.removeEventListener("pointermove", move);
      pr.el.removeEventListener("pointerup", up);
      pr.el.removeEventListener("pointercancel", up);
      if (moved) return save(true);
      selectPlace(pr.id);
    };
    pr.el.addEventListener("pointermove", move);
    pr.el.addEventListener("pointerup", up);
    pr.el.addEventListener("pointercancel", up);
  });
}

/** Whoever is in or on a place comes out. */
function evacuate(placeId) {
  for (const [pid, r] of rt) {
    if (r.mind.place === placeId || r.mind.then?.place === placeId) leavePlace(world.pets[pid], r);
  }
}

function setPlaceHidden(id, hide) {
  const spot = world.places[id];
  if (!spot) return;
  if (hide) spot.hidden = true; else delete spot.hidden;
  if (hide && selectedPlace === id) selectedPlace = null;
  renderPlaces();
  refreshSide();
  save(true);
  const name = projects.find((p) => p.id === id)?.name || "Place";
  if (hide) octopus.toast(`${name} removed from the scene. Add it back from Places in the sidebar.`, "info");
}

async function loadProjects() {
  try {
    const info = await octopus.ready();
    workProjectId = info.workProjectId || null;
    const list = await octopus.projects.list();
    const changed = JSON.stringify(list) !== JSON.stringify(projects);
    projects = list;
    if (changed) refreshSide();
  } catch (e) {
    console.error("Pets: projects unavailable", e);
  }
  renderPlaces();
}

const visitorsOf = (placeId) => [...rt.entries()].filter(([, r]) => r.mind.place === placeId).map(([id]) => world.pets[id]).filter(Boolean);

// ---- Building sites: Octopus's terminals ----------------------------------------------------------
// Every terminal open in Octopus is a site at its project's place, with a pet working on it: busy while
// the terminal works, on a break while it's idle, calling for you when it waits. Read-only: Pets only
// looks at the terminals (permissions.terminals).

const TERMINAL_LABEL = { working: "Working", idle: "Idle", waiting: "Waiting for you" };
const terminalOf = (id) => terminals.find((t) => t.id === id);
/** The open terminals whose project has a place on screen. */
const sites = () => terminals.filter((t) => t.state !== "ended" && placeRt.has(t.projectId));
const sitesAt = (placeId) => sites().filter((t) => t.projectId === placeId);

async function loadTerminals() {
  try {
    terminals = await octopus.terminals.list();
  } catch (e) {
    // An Octopus without terminals for extensions, or the permission not given: no sites.
    console.warn("Pets: terminals unavailable", e.message);
    terminals = [];
  }
  syncSites();
}

/** Sites as the terminals are: workers hired for new ones, sent home from closed ones, back to work. */
function syncSites() {
  const open = new Map(sites().map((t) => [t.id, t]));
  for (const [termId, petId] of crew) {
    const p = world.pets[petId], r = rt.get(petId);
    if (open.has(termId) && p?.stage === "alive" && r) continue;
    crew.delete(termId);
    if (r && r.mind.mode === "work") { r.mind = { mode: "idle", t: 1 + rnd() }; if (p) fx(p, "✓", "yum"); }
  }
  for (const t of open.values()) {
    if (!crew.has(t.id)) {
      const p = hire(t.projectId);
      if (!p) continue;
      crew.set(t.id, p.id);
    }
    const p = world.pets[crew.get(t.id)], r = rt.get(p.id);
    // Sent back after being carried, brushed, fed…: whatever took it away, the site is still open.
    const m = r.mind;
    if (m.mode !== "work" && !r.held && (m.mode === "idle" || m.mode === "sleep" || (m.mode === "walk" && !m.then))) {
      if (r.mind.place) leavePlace(p, r);
      r.mind = { mode: "work", term: t.id, place: t.projectId, t: 0, beat: rnd(), breakT: 0 };
    }
  }
  renderSites();
}

/** The nearest grown-up pet free to work; a busy one will do if nobody is. */
function hire(placeId) {
  const pr = placeRt.get(placeId);
  const hired = new Set(crew.values());
  const fit = (p) => p.stage === "alive" && !hired.has(p.id) && ageOf(p) >= G.MATURITY_DAYS * 0.5 && rt.get(p.id) && !rt.get(p.id).held;
  const pool = onScreen().filter((p) => fit(p) && isFree(p));
  const list = pool.length ? pool : onScreen().filter((p) => fit(p) && !["seek", "event", "brushed"].includes(rt.get(p.id).mind.mode));
  if (!list.length || !pr) return null;
  // In the office, a cat if there's one: they run the place.
  const notCat = (p) => (world.office && p.type !== "cat" ? 1 : 0);
  list.sort((a, b) => notCat(a) - notCat(b) || Math.hypot(a.x - pr.x, a.y - pr.y) - Math.hypot(b.x - pr.x, b.y - pr.y));
  return list[0];
}

/** Where a site's workers stand: in front of the place, alternating sides. */
function workSpot(pr, termId) {
  const here = sitesAt(pr.id);
  const i = Math.max(0, here.findIndex((t) => t.id === termId));
  // At a desk: in front of its monitor, the first three; the others stand by with their coffee.
  if (pr.kind === "desk" && i < 3) {
    const x = pr.x + (deskSeats(Math.min(3, here.length))[i] - 48) * PLACE_SCALE;
    return { x, y: pr.y + 3, face: x > pr.x + 1 ? -1 : 1 };
  }
  const side = i % 2 ? 1 : -1, row = Math.floor(i / 2);
  const b = bounds();
  return {
    x: Math.max(b.x0, Math.min(b.x1, pr.x + side * (42 + row * 18) * PLACE_SCALE * 0.8)),
    y: Math.max(b.y0, Math.min(b.y1, pr.y + 4 + row * 8)),
    face: -side,
  };
}

function stepWork(p, r, dt, spd) {
  const m = r.mind, pr = placeRt.get(m.place), t = terminalOf(m.term);
  if (!pr || !t || t.state === "ended") { r.mind = { mode: "idle", t: 1 }; return; }
  const spot = workSpot(pr, m.term);
  // Hungry: off to a bowl (decide picks it), back once fed.
  if (needs(p).food < 0.2 && world.items.some((i) => i.kind === "food" && i.bites > 0)) { r.building = false; r.mind = { mode: "idle", t: 0 }; return; }
  if (moveToward(p, r, spot.x, spot.y, spd, dt) > 2) { r.building = false; return; }
  r.dir = spot.face;
  r.building = t.state === "working";
  m.beat -= dt;
  const desk = pr.kind === "desk";
  if (t.state === "working") {
    m.breakT = 0;
    // At a desk: typing, and a sip of coffee now and then; on a site: hammering.
    if (m.beat <= 0 && desk) { if (rnd() < 0.2) { fx(p, "☕", "sip"); m.beat = 2.5; } else { fx(p, rnd() < 0.5 ? "tap" : "tik", "note"); m.beat = 0.9 + rnd() * 0.8; } }
    else if (m.beat <= 0) { fx(p, rnd() < 0.65 ? "tok" : "✦", "sparkle"); m.beat = 0.7 + rnd() * 0.6; }
    needs(p).joy = clamp01(needs(p).joy + dt * 0.002);
  } else if (t.state === "waiting") {
    m.breakT = 0;
    if (m.beat <= 0) { fx(p, "!", "warn"); m.beat = 2.5; }
  } else {
    // Idle: a breather, then a nap on the job.
    m.breakT += dt;
    if (m.breakT > 15) { r.zT -= dt; if (r.zT <= 0) { fx(p, "z", "z"); r.zT = 1.8; } }
    else if (m.beat <= 0) { fx(p, desk && rnd() < 0.6 ? "☕" : "…", desk ? "sip" : "bubble"); m.beat = 4 + rnd() * 4; }
  }
}

/** Places with open terminals show their site; the lamp blinks while one of them works. */
function renderSites() {
  const open = sites();
  for (const [id, pr] of placeRt) {
    const here = open.filter((t) => t.projectId === id);
    pr.el.classList.toggle("site", here.length > 0);
    pr.el.classList.toggle("busy", here.some((t) => t.state === "working"));
    pr.el.classList.toggle("calling", here.some((t) => t.state === "waiting"));
    if (pr.kind === "desk") { const proj = projects.find((p) => p.id === id); if (proj) setPlaceArt(pr, proj); }
  }
}

function siteHTML(placeId) {
  const here = sitesAt(placeId);
  if (!here.length) return "";
  const rows = here.map((t) => {
    const worker = crew.get(t.id);
    const cls = t.state === "working" ? "success" : t.state === "waiting" ? "warn" : "";
    return `<div class="site-row"><span class="badge ${cls}">${TERMINAL_LABEL[t.state] || t.state}</span>
      <span class="site-title">${esc(t.title)}</span>
      <span class="muted">${t.kind === "claude" ? "Claude" : "Shell"} · ${worker ? linkTo(worker) : `<span class="faint">no one free</span>`}</span></div>`;
  }).join("");
  const what = placeRt.get(placeId)?.kind === "desk" ? "At the desk" : "Building site";
  return `<h4>${what} (${here.length} terminal${here.length > 1 ? "s" : ""})</h4><div class="site-list">${rows}</div>`;
}

// ---- Items: food bowls and balls -------------------------------------------------------------------

function addItem(kind, x, y) {
  const list = world.items.filter((i) => i.kind === kind);
  if (list.length >= (kind === "food" ? MAX_BOWLS : MAX_BALLS)) removeItem(list[0]);
  const it = { id: newId("i"), kind, x, y };
  if (kind === "food") it.bites = 6;
  if (kind === "ball") Object.assign(it, { hue: Math.floor(rnd() * 360), life: BALL_SECONDS, z: 0, vz: 160, vx: (rnd() - 0.5) * 160, vy: (rnd() - 0.5) * 80 });
  clampPos(it);
  world.items.push(it);
  mountItem(it);
  // Pets nearby notice it.
  for (const p of onScreen()) {
    const r = rt.get(p.id);
    if (p.stage !== "alive" || !r || ["sleep", "inside", "eat", "seek", "brushed", "chase", "event", "work"].includes(r.mind.mode)) continue;
    if (kind === "ball" && performance.now() < (r.playAgainAt || 0)) continue;
    if (Math.hypot(p.x - x, p.y - y) < 420) r.mind = { mode: "idle", t: rnd() * 0.8 };
  }
  dirty = true;
  return it;
}

function mountItem(it) {
  const el = document.createElement("div");
  el.className = "thing " + it.kind;
  el.dataset.id = it.id;
  const art = it.kind === "food" ? bowlArt() : ballArt(it.hue);
  el.innerHTML = `<div class="shadow"></div><div class="sprite"><div class="px" style="background-image:url(${art})"></div></div>`;
  el.style.setProperty("--s", ZOOM);
  worldEl.appendChild(el);
  const ir = { el, px: el.querySelector(".px"), frame: -1, roll: 0 };
  itemRt.set(it.id, ir);
  dragItem(it, el);
  renderItem(it);
}

/** Drag a bowl or a ball; let go of a moving ball and it's thrown. A click on a ball kicks it. */
function dragItem(it, el) {
  el.addEventListener("pointerdown", (e) => {
    if (tool !== "hand" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, ix: it.x, iy: it.y };
    let moved = false, vx = 0, vy = 0, lx = e.clientX, ly = e.clientY, lt = performance.now();
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      el.classList.add("held");
      const now = performance.now(), dtm = Math.max(1, now - lt) / 1000;
      vx = vx * 0.5 + ((ev.clientX - lx) / dtm) * 0.5; vy = vy * 0.5 + ((ev.clientY - ly) / dtm) * 0.5;
      lx = ev.clientX; ly = ev.clientY; lt = now;
      it.x = start.ix + dx; it.y = start.iy + dy;
      if (it.kind === "ball") { it.vx = it.vy = it.vz = 0; it.z = 0; }
      clampPos(it);
      renderItem(it);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("held");
      if (!moved) {
        if (it.kind === "ball") kick(it, it.x - (e.offsetX > 10 ? 1 : -1) * 10, it.y, 1.3);
        return;
      }
      if (it.kind === "ball") {
        const cap = (v) => Math.max(-500, Math.min(500, v));
        Object.assign(it, { vx: cap(vx), vy: cap(vy) * 0.7, vz: Math.min(220, Math.hypot(vx, vy) * 0.3) });
        it.life = Math.max(it.life, 10);
      }
      dirty = true;
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

function removeItem(it) {
  world.items = world.items.filter((i) => i !== it);
  const ir = itemRt.get(it.id);
  if (ir) { ir.el.classList.add("gone"); setTimeout(() => ir.el.remove(), 900); itemRt.delete(it.id); }
  dirty = true;
}

function renderItem(it) {
  const ir = itemRt.get(it.id);
  if (!ir) return;
  ir.el.style.transform = `translate(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px)`;
  ir.el.style.zIndex = String(Math.round(it.y));
  let frame = 0;
  if (it.kind === "food") frame = it.bites > 3 ? 0 : it.bites > 0 ? 1 : 2;
  else {
    frame = Math.floor(ir.roll / 5) % 4;
    ir.el.style.setProperty("--z", it.z.toFixed(1) + "px");
  }
  if (frame !== ir.frame) {
    ir.frame = frame;
    const n = it.kind === "food" ? 3 : 4;
    ir.px.style.backgroundPosition = `${(frame / (n - 1)) * 100}% 0`;
  }
}

/** Sends the ball away from where it was hit. */
function kick(ball, fromX, fromY, power = 1) {
  const a = Math.atan2(ball.y - fromY, ball.x - fromX) + (rnd() - 0.5) * 0.9;
  const v = (90 + rnd() * 110) * power;
  ball.vx = Math.cos(a) * v;
  ball.vy = Math.sin(a) * v * 0.6;
  ball.vz = 120 + rnd() * 80;
  if (power > 1) ball.life = Math.max(ball.life, 10);   // your kick keeps it going a bit; theirs don't
}

function stepItems(dt) {
  const b = bounds();
  for (const it of [...world.items]) {
    if (it.kind !== "ball") continue;
    it.life -= dt;
    if (it.life <= 0) { removeItem(it); continue; }
    const ir = itemRt.get(it.id);
    it.vz -= 520 * dt;
    it.z += it.vz * dt;
    if (it.z <= 0) { it.z = 0; it.vz = Math.abs(it.vz) > 60 ? -it.vz * 0.45 : 0; }
    const k = Math.exp(-(it.z > 0 ? 0.5 : 1.6) * dt);
    it.vx *= k; it.vy *= k;
    it.x += it.vx * dt; it.y += it.vy * dt;
    if (it.x < b.x0 || it.x > b.x1) { it.vx = -it.vx * 0.7; }
    if (it.y < b.y0 || it.y > b.y1) { it.vy = -it.vy * 0.7; }
    clampPos(it);
    if (ir) ir.roll += Math.hypot(it.vx, it.vy) * dt;
  }
}

// ---- Tools -----------------------------------------------------------------------------------------

const TOOLS = { hand: "Pet", food: "Food", brush: "Brush", ball: "Ball", erase: "Remove" };

function renderTools() {
  $("#tools").innerHTML = Object.entries(TOOLS).map(([k, label]) =>
    `<button data-tool="${k}" class="${k === tool ? "on" : ""}" title="${toolHint(k)}"><img src="${toolIcon(k)}" alt="">${label}</button>`).join("");
  worldEl.dataset.tool = tool;
  worldEl.style.cursor = tool === "hand" ? "" : `url(${toolIcon(tool, 2)}) 12 12, crosshair`;
}

function toolHint(k) {
  return {
    hand: "Select and drag pets and places (Esc)",
    food: "Click to put down a food bowl",
    brush: "Click a pet to brush it",
    ball: "Click to throw a ball",
    erase: "Click a bowl, a ball or a place to remove it (places come back from the sidebar)",
  }[k];
}

function setTool(k) { tool = k; renderTools(); }

$("#fun").addEventListener("click", () => {
  if (!startEvent()) octopus.toast("Needs at least two free, fed pets", "info");
});

$("#tools").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tool]");
  if (b) setTool(b.dataset.tool === tool ? "hand" : b.dataset.tool);
});

worldEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || herEl.contains(e.target) || $("#empty").contains(e.target)) return;
  if (tool === "hand") {
    if (e.target === worldEl) { select(null); }
    return;
  }
  const box = worldEl.getBoundingClientRect();
  const x = e.clientX - box.left, y = e.clientY - box.top;
  if (tool === "food") addItem("food", x, y);
  if (tool === "ball") addItem("ball", x, y);
  if (tool === "erase") {
    const thing = e.target.closest(".thing");
    const it = thing && world.items.find((i) => i.id === thing.dataset.id);
    if (it) return removeItem(it);
    const placeEl = e.target.closest(".place");
    if (placeEl) return setPlaceHidden(placeEl.dataset.id, true);
    return;
  }
  if (tool === "brush") {
    const el = e.target.closest(".pet");
    const p = el && world.pets[el.dataset.id];
    if (p) brush(p);
  }
});

function brush(p) {
  const r = rt.get(p.id);
  if (!r || p.stage !== "alive") return;
  const n = needs(p);
  if (r.mind.mode === "inside" || r.mind.mode === "perch") leavePlace(p, r);
  // Shy pets don't always like it.
  if (p.genes.sociability < 0.3 && rnd() < 0.5) {
    fx(p, "!", "warn");
    n.joy = clamp01(n.joy - 0.04);
    const b = bounds();
    const tx = Math.max(b.x0, Math.min(b.x1, p.x + (rnd() < 0.5 ? -1 : 1) * 140));
    r.mind = { mode: "walk", tx, ty: p.y, t: 0, zoom: true };
    return;
  }
  n.clean = 1;
  n.joy = clamp01(n.joy + 0.12);
  r.mind = { mode: "brushed", t: 1.8 };
  fx(p, "✦", "sparkle");
  setTimeout(() => fx(p, "✧", "sparkle"), 300);
  setTimeout(() => fx(p, "♥", "heart"), 700);
  select(p.id);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("#dlg").open) return;
  if (her) closeHeritage();
  else setTool("hand");
});

// ---- Life ------------------------------------------------------------------------------------------

function canMate(p) {
  if (p.stage !== "alive" || p.pregnantUntil || needs(p).food < 0.3) return false;
  const age = ageOf(p);
  if (age < G.MATURITY_DAYS || age > G.phenotype(p).lifespan * 0.85) return false;
  return world.time >= (p.cooldownUntil || 0);
}

function partnerFor(p) {
  if (onScreen().length >= G.MAX_POPULATION) return null;
  let best = null, bestD = Infinity;
  for (const q of onScreen()) {
    if (q === p || q.sex === p.sex || !G.sameSpecies(p, q) || !canMate(q) || rt.get(q.id)?.mind.mode === "work") continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { best = q; bestD = d; }
  }
  return best;
}

function mate(a, b) {
  const mother = a.sex === "f" ? a : b, father = a.sex === "f" ? b : a;
  mother.pregnantUntil = world.time + G.GESTATION_DAYS;
  mother.pregnantBy = father.id;
  a.cooldownUntil = b.cooldownUntil = world.time + G.BREED_COOLDOWN_DAYS;
  for (const p of [a, b]) {
    fx(p, "♥", "heart");
    setTimeout(() => fx(p, "♥", "heart"), 350);
    needs(p).joy = clamp01(needs(p).joy + 0.15);
    rt.get(p.id).mind = { mode: "idle", t: 2.5 };
  }
  dirty = true;
  refreshSide();
}

/** `quiet`: while making up time away, which says it all in one toast at the end. */
function layEgg(mother, quiet) {
  const father = world.pets[mother.pregnantBy];
  mother.pregnantUntil = null;
  mother.pregnantBy = null;
  if (!father) return;
  const child = addChild(mother, father);
  if (quiet) return child;
  octopus.toast(`${mother.name} and ${father.name} have an egg`, "info");
  save(true);
  refreshSide();
  return child;
}

function hatch(p) {
  const r = rt.get(p.id);
  // The shell stays behind and breaks while the pet pops out.
  const debris = document.createElement("div");
  debris.className = "debris";
  debris.innerHTML = `<div class="sprite">${eggDebris(p)}</div>`;
  debris.style.setProperty("--s", r.s.toFixed(3));
  debris.style.transform = r.el.style.transform;
  debris.style.zIndex = String(Math.round(p.y) + 1);
  worldEl.appendChild(debris);
  setTimeout(() => debris.remove(), 3000);

  p.stage = "alive";
  p.bornAt = world.time;
  needs(p);
  setCls(r, "cracking", false);
  drawSprite(p);
  setCls(r, "pop", true);
  setTimeout(() => setCls(r, "pop", false), 600);
  r.mind = { mode: "idle", t: 1.5 };
  octopus.toast(`${p.name} hatched`, "success");
  save(true);
  refreshSide();
}

function die(p, quiet) {
  const r = rt.get(p.id);
  p.stage = "dead";
  p.diedAt = world.time;
  p.pregnantUntil = null;
  delete p.x; delete p.y; delete p.needs;
  rt.delete(p.id);
  if (r) {
    r.walking = false;
    r.el.classList.remove("inside", "perched");
    r.el.classList.add("dying", "elder");
    setTimeout(() => r.el.remove(), 2700);
  }
  if (quiet) return;
  octopus.toast(`${p.name} passed away at ${Math.floor(ageOf(p))} days`, "info");
  save(true);
  refreshSide();
  renderEmpty();
}

/** Comes out of a house or down from a tree, in front of it. */
function leavePlace(p, r) {
  const pr = placeRt.get(r.mind.place);
  if (pr) { p.x = pr.x + (rnd() - 0.5) * 20; p.y = pr.y + 8; clampPos(p); }
  r.mind = { mode: "idle", t: 0.8 + rnd() };
}

/** What a pet does on reaching where it was going. */
function arrive(p, r, then) {
  const n = needs(p);
  const pr = then.place && placeRt.get(then.place);
  if (then.place && !pr) { r.mind = { mode: "idle", t: 1 }; return; }
  if (then.act === "enter") {
    r.mind = { mode: "inside", place: pr.id, t: 6 + rnd() * 10 };
    n.joy = clamp01(n.joy + 0.04);
  } else if (then.act === "perch") {
    const s = PLACE_SCALE;
    p.x = pr.x + (rnd() - 0.5) * 24 * s;
    p.y = pr.y + 2;
    r.mind = { mode: "perch", place: pr.id, t: 6 + rnd() * 8, lift: Math.round(PLACE_KINDS[pr.kind].perch * s) };
    n.joy = clamp01(n.joy + 0.05);
  } else if (then.act === "rest") {
    r.mind = { mode: "sleep", place: pr.id, t: 6 + rnd() * 8 };
    r.zT = 0.5;
  } else if (then.act === "sleep") {
    r.mind = { mode: "sleep", t: then.t || 6 + rnd() * 8 };
    r.zT = 0.5 + rnd();
  } else if (then.act === "eat") {
    const bowl = world.items.find((i) => i.id === then.item);
    if (!bowl || bowl.bites <= 0) { r.mind = { mode: "idle", t: 0.5 }; return; }
    r.dir = bowl.x > p.x ? 1 : -1;
    r.mind = { mode: "eat", item: bowl.id, t: 2.2 };
  } else {
    r.mind = { mode: "idle", t: 0.6 + rnd() * 2.5 };
  }
}

function moveToward(p, r, tx, ty, spd, dt) {
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  if (d < 1) return d;
  const k = Math.min(1, (spd * dt) / d);
  p.x += dx * k; p.y += dy * k;
  if (Math.abs(dx) > 0.5) r.dir = dx > 0 ? 1 : -1;
  r.walking = true;
  return d;
}

function step(p, dt, dDays) {
  const r = rt.get(p.id);
  if (!r) return;
  if (p.stage === "egg") {
    r.eggT += dt;
    if (r.eggT >= HATCH_SECONDS) hatch(p);
    return;
  }
  const t = G.phenotype(p);
  const age = ageOf(p);
  if (age >= t.lifespan) return die(p);
  if (p.pregnantUntil && world.time >= p.pregnantUntil) layEgg(p);

  const n = needs(p), g = p.genes;
  n.food = clamp01(n.food - dDays * (0.16 + 0.12 * g.energy));
  n.clean = clamp01(n.clean - dDays * 0.09);
  n.joy = clamp01(n.joy - dDays * (0.1 + 0.1 * g.sociability));
  if (r.held) { r.walking = false; return; }

  const m = r.mind;
  m.t -= dt;
  r.walking = false;
  r.running = false;
  const elder = age > t.lifespan * 0.8, baby = age < G.MATURITY_DAYS;
  const spd = t.speed * (elder ? 0.55 : 1) * (baby ? 0.8 : 1) * (n.food < 0.2 ? 0.7 : 1) * (m.zoom ? 2.6 : 1);

  switch (m.mode) {
    case "sleep":
      r.zT -= dt;
      if (r.zT <= 0) { fx(p, "z", "z"); r.zT = 1.8; }
      break;
    case "inside": {
      const pr = placeRt.get(m.place);
      r.zT -= dt;
      if (pr && r.zT <= 0) { fxAt(pr.el, "z", "z"); r.zT = 2.2; }
      if (!pr || m.t <= 0) return leavePlace(p, r);
      return;
    }
    case "perch":
      if (!placeRt.get(m.place) || m.t <= 0) return leavePlace(p, r);
      return;
    case "eat": {
      const bowl = world.items.find((i) => i.id === m.item);
      if (!bowl) { r.mind = { mode: "idle", t: 0.5 }; return; }
      if (Math.hypot(bowl.x - p.x, bowl.y - p.y) > 30) {        // someone moved it
        const side = p.x < bowl.x ? -1 : 1;
        r.mind = { mode: "walk", tx: bowl.x + side * 16, ty: bowl.y + 1, t: 0, then: { act: "eat", item: bowl.id } };
        return;
      }
      if (m.t > 0) return;
      bowl.bites--;
      n.food = clamp01(n.food + 0.35);
      n.joy = clamp01(n.joy + 0.03);
      fx(p, "+", "yum");
      if (bowl.bites <= 0) setTimeout(() => removeItem(bowl), 2500);
      // Another bite if still hungry and there's some left.
      r.mind = n.food < 0.85 && bowl.bites > 0 ? { mode: "eat", item: bowl.id, t: 2.2 } : { mode: "idle", t: 1 + rnd() };
      dirty = true;
      return;
    }
    case "chase": {
      const ball = world.items.find((i) => i.id === m.ball);
      if (!ball || m.t <= 0) return tiredOfPlaying(p, r);
      r.running = true;
      const d = moveToward(p, r, ball.x, ball.y, spd * BALL_RUN * sprint(r, dt), dt);
      if (d < 14 && ball.z < 10) {
        kick(ball, p.x, p.y);
        n.joy = clamp01(n.joy + 0.05);
        if (rnd() < 0.3) fx(p, "!", "note");
      }
      return;
    }
    case "event":
      return stepEvent(p, r, dt, spd);
    case "work":
      return stepWork(p, r, dt, spd);
    case "seek": {
      const q = world.pets[m.partner];
      if (!q || !canMate(q) || !canMate(p) || m.t < -25) { r.mind = { mode: "idle", t: 1 }; return; }
      if (Math.hypot(q.x - p.x, q.y - p.y) < 26) return mate(p, q);
      const qr = rt.get(q.id);
      if (qr && qr.mind.mode !== "seek") {
        if (qr.mind.place) leavePlace(q, qr);
        qr.mind = { mode: "idle", t: 2 };
        qr.dir = p.x < q.x ? -1 : 1;
      }
      moveToward(p, r, q.x - Math.sign(q.x - p.x || 1) * 14, q.y, spd, dt);
      return;
    }
    case "walk": {
      const d = moveToward(p, r, m.tx, m.ty, spd, dt);
      if (d < 2) return m.then ? arrive(p, r, m.then) : arrive(p, r, {});
      if (m.t < -30) r.mind = { mode: "idle", t: 1 };
      return;
    }
  }
  if (m.t <= 0) decide(p, t, age);
}

/** After a game a pet wants something else for a while: longer when it has little energy. */
function tiredOfPlaying(p, r) {
  r.playAgainAt = performance.now() + (25 + (1 - p.genes.energy) * 45 + rnd() * 25) * 1000;
  if (rnd() < 0.3) { r.mind = { mode: "sleep", t: 4 + rnd() * 6 }; r.zT = 0.8; }
  else r.mind = { mode: "idle", t: 1.5 + rnd() * 2 };
}

function placesFor(p, act) {
  const list = [...placeRt.values()];
  if (act === "enter") return list.filter((pr) => PLACE_KINDS[pr.kind].enter);
  if (act === "perch") return (p.type === "cat" || p.type === "bird") ? list.filter((pr) => PLACE_KINDS[pr.kind].perch) : [];
  if (act === "rest") return list.filter((pr) => !PLACE_KINDS[pr.kind].enter);
  return list;
}

/** Walks to a place, preferring near ones; false when there's none. */
function goTo(p, r, act) {
  const list = placesFor(p, act);
  if (!list.length) return false;
  list.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
  const pr = list[Math.floor(rnd() * Math.min(3, list.length))];
  const side = act === "rest" ? (rnd() < 0.5 ? -1 : 1) * 30 * PLACE_SCALE : 0;
  r.mind = { mode: "walk", tx: pr.x + side, ty: pr.y + (act === "rest" ? 4 : 2), t: 0, then: { act, place: pr.id } };
  return true;
}

function decide(p, t, age) {
  const r = rt.get(p.id), g = p.genes, q = p.quirk, n = needs(p);
  const elder = age > t.lifespan * 0.8, baby = age < G.MATURITY_DAYS;

  if (canMate(p) && rnd() < t.fertility * 0.6 * (0.4 + n.joy)) {
    const partner = partnerFor(p);
    if (partner) { r.mind = { mode: "seek", partner: partner.id, t: 0 }; return; }
  }
  // Hungry: the nearest bowl with food left.
  const bowls = world.items.filter((i) => i.kind === "food" && i.bites > 0);
  if (bowls.length && n.food < 0.8 && rnd() < 0.25 + (1 - n.food)) {
    bowls.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    const bowl = bowls[0];
    const side = p.x < bowl.x ? -1 : 1;
    r.mind = { mode: "walk", tx: bowl.x + side * 16, ty: bowl.y + 1, t: 0, then: { act: "eat", item: bowl.id } };
    return;
  }
  // A ball: energetic pets and babies love it.
  const balls = world.items.filter((i) => i.kind === "ball");
  if (balls.length && performance.now() > (r.playAgainAt || 0) && rnd() < 0.15 + g.energy * 0.35 + (baby ? 0.2 : 0) - (elder ? 0.25 : 0)) {
    r.mind = { mode: "chase", ball: balls[Math.floor(rnd() * balls.length)].id, t: 5 + g.energy * 7 + rnd() * 3 };
    return;
  }
  const sleepP = 0.07 + (1 - g.energy) * 0.15 + (q === "napper" ? 0.2 : 0) + (elder ? 0.15 : 0) + (baby ? 0.1 : 0);
  if (rnd() < sleepP) {
    if (rnd() < 0.55 && goTo(p, r, rnd() < 0.6 ? "enter" : "rest")) return;
    r.mind = { mode: "sleep", t: 5 + rnd() * 10 };
    r.zT = 0.5;
    return;
  }
  if (q === "spinner" && rnd() < 0.12) { r.mind = { mode: "spin", t: 1.6 }; return; }
  if (q === "singer" && rnd() < 0.15) {
    fx(p, "♪", "note"); setTimeout(() => fx(p, "♫", "note"), 600);
    r.mind = { mode: "idle", t: 2 }; return;
  }
  // Curious pets visit the places: climb trees, peek into houses.
  if (rnd() < 0.12 + g.curiosity * 0.2) {
    const act = rnd() < 0.5 ? "perch" : rnd() < 0.5 ? "enter" : "visit";
    if (goTo(p, r, act)) return;
  }
  if (rnd() < 0.4 + g.curiosity * 0.35 + g.energy * 0.15) {
    const b = bounds();
    let tx, ty;
    const social = g.sociability * 0.5 + (q === "clingy" ? 0.35 : 0);
    const friends = onScreen().filter((o) => o !== p && o.stage === "alive");
    if (friends.length && rnd() < social) {
      const same = friends.filter((o) => G.sameSpecies(o, p));
      const pool = same.length && rnd() < 0.7 ? same : friends;
      const f = pool[Math.floor(rnd() * pool.length)];
      tx = f.x + (rnd() - 0.5) * 70; ty = f.y + (rnd() - 0.5) * 40;
      n.joy = clamp01(n.joy + 0.02);
    } else {
      const radius = (80 + g.curiosity * 320) * (q === "wanderer" ? 1.8 : 1);
      const a = rnd() * Math.PI * 2;
      tx = p.x + Math.cos(a) * radius * (0.3 + rnd() * 0.7);
      ty = p.y + Math.sin(a) * radius * 0.6 * (0.3 + rnd() * 0.7);
    }
    tx = Math.max(b.x0, Math.min(b.x1, tx)); ty = Math.max(b.y0, Math.min(b.y1, ty));
    r.mind = { mode: "walk", tx, ty, t: 0, zoom: q === "zoomies" && rnd() < 0.25 };
    return;
  }
  r.mind = { mode: "idle", t: 1 + rnd() * 3 };
}

function doing(p) {
  if (p.stage !== "alive") return "";
  const r = rt.get(p.id);
  if (!r) return "";
  const m = r.mind;
  const where = (id) => esc(placeRt.get(id)?.name || "a place");
  switch (m.mode) {
    case "sleep": return m.place ? `Napping by ${where(m.place)}` : "Sleeping";
    case "inside": return `Napping in ${where(m.place)}`;
    case "perch": return `On top of ${where(m.place)}`;
    case "eat": return "Eating";
    case "chase": return "Playing with the ball";
    case "brushed": return "Being brushed";
    case "seek": return `Courting ${esc(world.pets[m.partner]?.name || "")}`;
    case "spin": return "Chasing its tail";
    case "event": return eventDoing(p, m.ev);
    case "work": {
      const st = terminalOf(m.term)?.state;
      if (placeRt.get(m.place)?.kind === "desk") {
        return st === "working" ? `Working at ${where(m.place)}'s desk` : st === "waiting" ? `Waiting for you at ${where(m.place)}'s desk` : `Coffee break at ${where(m.place)}'s desk`;
      }
      return st === "working" ? `Building at ${where(m.place)}` : st === "waiting" ? `Waiting for you at ${where(m.place)}` : `On a break at ${where(m.place)}`;
    }
    case "walk":
      if (m.then?.act === "eat") return "Going to eat";
      if (m.then?.place) return `Going to ${where(m.then.place)}`;
      return "Walking";
    default: return r.held ? "Being carried" : "Looking around";
  }
}

// ---- Activities between pets ----------------------------------------------------------------------
// Every so often a group of free pets starts something together. Activities live only on screen.

let events = [];
let nextEventIn = 12 + rnd() * 15;           // real seconds
const BUBBLES = ["…", "?", "!", "ha!", "♥", "♪", "hm", "!!"];
const SUITS = ["♠", "♥", "♦", "♣"];

const ACTIVITIES = {
  tag: { label: "Tag", min: 2, max: 4, weight: 3 },
  ball: { label: "Ball game", min: 2, max: 4, weight: 2 },
  poker: { label: "Poker night", min: 2, max: 4, weight: 2 },
  conga: { label: "Conga line", min: 3, max: 6, weight: 1.5 },
  chat: { label: "Chat", min: 2, max: 2, weight: 3 },
  nap: { label: "Nap pile", min: 2, max: 5, weight: 1 },
};

function isFree(p) {
  const r = rt.get(p.id);
  return p.stage === "alive" && r && !r.held && (r.mind.mode === "idle" || (r.mind.mode === "walk" && !r.mind.then)) && needs(p).food > 0.15;
}

const members = (ev) => ev.pets.map((id) => world.pets[id]).filter((p) => p && rt.get(p.id)?.mind.ev === ev);
const names = (list) => list.map((p) => p.name).join(list.length > 2 ? ", " : " and ");

/** Starts an activity (a random one fitting the free pets when `kind` is omitted). */
function startEvent(kind) {
  const free = onScreen().filter(isFree);
  const fits = Object.entries(ACTIVITIES).filter(([k, a]) => free.length >= a.min && (!kind || k === kind));
  if (!fits.length) return false;
  let roll = rnd() * fits.reduce((n, [, a]) => n + a.weight, 0);
  const [k, a] = fits.find(([, a]) => (roll -= a.weight) <= 0) || fits[0];
  // A group of neighbours around a random pet.
  const first = free[Math.floor(rnd() * free.length)];
  free.sort((x, y) => Math.hypot(x.x - first.x, x.y - first.y) - Math.hypot(y.x - first.x, y.y - first.y));
  const n = Math.min(free.length, a.min + Math.floor(rnd() * (a.max - a.min + 1)));
  const group = free.slice(0, n);
  const cx = group.reduce((s, p) => s + p.x, 0) / n, cy = group.reduce((s, p) => s + p.y, 0) / n;
  const b = bounds();
  const spot = { x: Math.max(b.x0 + 50, Math.min(b.x1 - 50, cx)), y: Math.max(b.y0 + 30, Math.min(b.y1 - 20, cy)) };
  const ev = { kind: k, pets: group.map((p) => p.id), t: 20, spot, tick: 0, turn: 0 };
  events.push(ev);

  if (k === "ball") {
    const ball = addItem("ball", spot.x, spot.y);
    ball.life = 18;
    for (const p of group) rt.get(p.id).mind = { mode: "chase", ball: ball.id, t: 10 + rnd() * 8 };
    ev.t = 18;
  } else if (k === "nap") {
    group.forEach((p, i) => {
      const a = (i / n) * Math.PI * 2;
      rt.get(p.id).mind = { mode: "walk", t: 0, tx: spot.x + Math.cos(a) * 16, ty: spot.y + Math.sin(a) * 8, then: { act: "sleep", t: 14 } };
    });
    ev.t = 18;
  } else {
    if (k === "tag") { ev.it = group[0].id; ev.t = 16; }
    if (k === "conga") { ev.t = 15; ev.wp = null; }
    if (k === "chat") { ev.t = 30; ev.seats = [{ x: spot.x - 15, y: spot.y, dir: 1 }, { x: spot.x + 15, y: spot.y, dir: -1 }]; }
    if (k === "poker") {
      ev.t = 30;
      ev.seats = [[-48, 0, 1], [48, 0, -1], [-16, -16, 1], [16, -16, -1]].map(([dx, dy, dir]) => ({ x: spot.x + dx, y: spot.y + dy, dir }));
      const el = document.createElement("div");
      el.className = "thing table";
      el.style.setProperty("--s", 1.75);
      el.innerHTML = `<div class="sprite"><div class="px" style="background-image:url(${tableArt()})"></div></div>`;
      el.style.transform = `translate(${spot.x}px, ${spot.y + 2}px)`;
      el.style.zIndex = String(Math.round(spot.y + 2));
      worldEl.appendChild(el);
      ev.table = el;
    }
    group.forEach((p, i) => { rt.get(p.id).mind = { mode: "event", ev, seat: ev.seats?.[i], t: 0 }; });
  }
  return true;
}

function endEvent(ev) {
  events = events.filter((e) => e !== ev);
  for (const p of members(ev)) rt.get(p.id).mind = { mode: "idle", t: 0.5 + rnd() * 1.5 };
  if (ev.table) { ev.table.classList.add("gone"); setTimeout(() => ev.table.remove(), 900); }
}

function eventTitle(ev) {
  const list = ev.kind === "ball" || ev.kind === "nap" ? ev.pets.map((id) => world.pets[id]).filter((p) => p?.stage === "alive") : members(ev);
  if (ev.result) return ev.result;
  return `${ACTIVITIES[ev.kind].label}: ${names(list)}`;
}

function eventDoing(p, ev) {
  if (!ev) return "Playing";
  if (ev.kind === "tag") return ev.it === p.id ? "It! Chasing the others" : "Playing tag";
  if (ev.kind === "chat") return `Chatting with ${esc(members(ev).find((q) => q !== p)?.name || "a friend")}`;
  if (ev.kind === "poker") return ev.started ? "Playing poker" : "Going to the card table";
  if (ev.kind === "conga") return ev.pets[0] === p.id ? "Leading a conga line" : "Dancing in a conga line";
  return "Playing";
}

const seated = (ev) => members(ev).every((q) => { const s = rt.get(q.id).mind.seat; return !s || Math.hypot(q.x - s.x, q.y - s.y) < 3; });

function stepEvents(dt) {
  nextEventIn -= dt;
  if (nextEventIn <= 0) { nextEventIn = 25 + rnd() * 35; startEvent(); }
  for (const ev of [...events]) {
    ev.t -= dt;
    if (ev.kind === "ball" || ev.kind === "nap") { if (ev.t <= 0) events = events.filter((e) => e !== ev); continue; }
    const list = members(ev);
    if (ev.result) { if (ev.t <= 0) endEvent(ev); continue; }
    if (list.length < 2 || ev.t <= 0) {
      if (ev.kind === "poker" && ev.started && list.length >= 2) {
        const winner = list[Math.floor(rnd() * list.length)];
        for (const q of list) needs(q).joy = clamp01(needs(q).joy + (q === winner ? 0.25 : 0.08));
        fx(winner, "★", "sparkle");
        setTimeout(() => fx(winner, "$", "yum"), 400);
        ev.result = `Poker night: ${winner.name} wins the pot`;
        ev.t = 2.5;
        continue;
      }
      endEvent(ev);
      continue;
    }
    ev.tick -= dt;
    if (ev.kind === "chat" && seated(ev) && ev.tick <= 0) {
      if (!ev.started) { ev.started = true; ev.t = 7 + rnd() * 4; }
      fx(list[ev.turn++ % 2], BUBBLES[Math.floor(rnd() * BUBBLES.length)], "bubble");
      ev.tick = 0.8 + rnd() * 0.7;
    }
    if (ev.kind === "poker" && !ev.started && seated(ev)) { ev.started = true; ev.t = 14 + rnd() * 6; }
    if (ev.kind === "poker" && ev.started && ev.tick <= 0) {
      fx(list[Math.floor(rnd() * list.length)], SUITS[Math.floor(rnd() * 4)], "card");
      ev.tick = 0.9 + rnd() * 0.8;
    }
    if (ev.kind === "conga" && ev.tick <= 0) { fx(list[0], "♪", "note"); ev.tick = 1.2; }
  }
}

// Tag and ball games are played at a run: about twice the walking speed, with short bursts on top.
const TAG_CHASE = 2.1, TAG_FLEE = 1.9, BALL_RUN = 1.9;
function sprint(r, dt) {
  r.burstT = (r.burstT ?? rnd() * 2) - dt;
  if (r.burstT <= 0) r.burstT = 1.5 + rnd() * 2.5;
  return r.burstT < 0.6 ? 1.35 : 1;
}

/** One pet's part in an activity. */
function stepEvent(p, r, dt, spd) {
  const m = r.mind, ev = m.ev;
  if (!events.includes(ev)) { r.mind = { mode: "idle", t: 1 }; return; }
  const list = members(ev);
  if (m.seat) {
    const d = moveToward(p, r, m.seat.x, m.seat.y, spd, dt);
    if (d < 3) { r.walking = false; r.dir = m.seat.dir; }
    return;
  }
  if (ev.kind === "tag") {
    if (m.wait > 0) { m.wait -= dt; return; }
    if (ev.it === p.id) {
      const others = list.filter((q) => q !== p);
      if (!others.length) return;
      const q = others.reduce((a, b) => (Math.hypot(a.x - p.x, a.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? a : b));
      r.running = true;
      if (moveToward(p, r, q.x, q.y, spd * TAG_CHASE * sprint(r, dt), dt) < 16) {
        ev.it = q.id;
        fx(q, "!", "warn");
        fx(p, "ha!", "bubble");
        rt.get(q.id).mind.wait = 1.1;
        needs(p).joy = clamp01(needs(p).joy + 0.05);
      }
    } else {
      const it = world.pets[ev.it];
      if (!it) return;
      const dx = p.x - it.x, dy = p.y - it.y, d = Math.hypot(dx, dy) || 1;
      if (d < 170) {
        const b = bounds();
        let tx = p.x + (dx / d) * 80, ty = p.y + (dy / d) * 80;
        if (tx < b.x0 + 10 || tx > b.x1 - 10) ty = p.y + (dy >= 0 ? 90 : -90);   // cornered: slip sideways
        if (ty < b.y0 + 10 || ty > b.y1 - 10) tx = p.x + (dx >= 0 ? 90 : -90);
        r.running = true;
        moveToward(p, r, Math.max(b.x0, Math.min(b.x1, tx)), Math.max(b.y0, Math.min(b.y1, ty)), spd * TAG_FLEE * sprint(r, dt), dt);
        needs(p).joy = clamp01(needs(p).joy + dt * 0.004);
      }
    }
    return;
  }
  if (ev.kind === "conga") {
    const i = list.indexOf(p);
    if (i <= 0) {
      if (!ev.wp || Math.hypot(ev.wp.x - p.x, ev.wp.y - p.y) < 6) {
        const b = bounds();
        ev.wp = { x: b.x0 + 40 + rnd() * (b.x1 - b.x0 - 80), y: b.y0 + 20 + rnd() * (b.y1 - b.y0 - 40) };
      }
      moveToward(p, r, ev.wp.x, ev.wp.y, 34, dt);
    } else {
      const lead = list[i - 1], lr = rt.get(lead.id);
      const d = Math.hypot(lead.x - p.x, lead.y - p.y);
      if (d > 26) moveToward(p, r, lead.x - lr.dir * 22, lead.y, Math.max(spd, 34) * 1.3, dt);
      else r.dir = lead.x > p.x ? 1 : -1;
    }
    needs(p).joy = clamp01(needs(p).joy + dt * 0.004);
  }
}

// ---- Loop ------------------------------------------------------------------------------------------

let last = performance.now(), uiT = 0;
// Driven by animation frames; when the page gets none (some web views throttle them), a timer
// takes over at 10 fps so the pets never freeze.
function loop(now) {
  requestAnimationFrame(loop);
  tick(now);
}
setInterval(() => { const now = performance.now(); if (now - last > 250) tick(now); }, 100);

function tick(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  try {
    frame(dt);
  } catch (e) {
    if (!loopError) { loopError = String(e?.message || e); console.error("Pets: frame failed", e); octopus.toast("Pets: " + loopError, "error"); }
  }
}

function frame(dt) {
  if (sized()) {
    // Paused time isn't time away.
    if (world.paused) world.seenAt = Date.now();
    else catchUp();
  }
  if (sized() && !world.paused) {
    const dDays = (dt * world.speed) / G.DAY_SECONDS;
    world.time += dDays;
    for (const p of onScreen()) step(p, dt, dDays);
    stepItems(dt);
    stepEvents(dt);
    siteT -= dt;
    if (siteT <= 0) { siteT = 1; syncSites(); }
    dirty = true;
  }
  for (const p of onScreen()) { const r = rt.get(p.id); if (r) place(p, r); }
  for (const it of world.items) renderItem(it);
  uiT -= dt;
  if (uiT <= 0) { uiT = 0.5; updateLive(); }
}

// ---- Time away -------------------------------------------------------------------------------------

/** Makes up the time since the world last ran (`world.seenAt`), if it's more than a few seconds. */
function catchUp() {
  const now = Date.now();
  const away = world.seenAt ? now - world.seenAt : 0;
  world.seenAt = now;
  if (away < AWAY_AFTER_MS) return;
  const total = Math.min(MAX_AWAY_DAYS, ((away / 1000) * world.speed) / G.DAY_SECONDS);
  const eggs = [], died = [];
  for (let left = total; left > 1e-9; left -= AWAY_STEP_DAYS) {
    const dDays = Math.min(AWAY_STEP_DAYS, left);
    world.time += dDays;
    for (const p of pets()) if (p.stage === "alive") awayStep(p, dDays, eggs, died);
  }
  // Balls deflated and empty bowls were cleared meanwhile; everyone starts afresh.
  for (const it of [...world.items]) if (it.kind === "ball" || (it.kind === "food" && it.bites <= 0)) removeItem(it);
  for (const p of onScreen()) {
    const r = rt.get(p.id);
    if (r && !r.held) r.mind = { mode: "idle", t: rnd() * 1.5 };
  }
  dirty = true;
  save(true);
  refreshSide();
  renderEmpty();
  if (eggs.length || died.length) {
    const what = [
      eggs.length ? `${eggs.length} egg${eggs.length > 1 ? "s" : ""} laid` : "",
      died.length ? `${names(died)} passed away` : "",
    ].filter(Boolean).join(", ");
    octopus.toast(`While you were away (${days(total)}): ${what}`, "info");
  }
}

/** A pet's life over `dDays` while nobody watches: aging, needs, bowls, company, breeding. */
function awayStep(p, dDays, eggs, died) {
  const t = G.phenotype(p);
  if (ageOf(p) >= t.lifespan) { die(p, true); died.push(p); return; }
  if (p.pregnantUntil && world.time >= p.pregnantUntil) {
    const child = layEgg(p, true);
    if (child) eggs.push(child);
  }
  const n = needs(p), g = p.genes;
  n.food = clamp01(n.food - dDays * (0.16 + 0.12 * g.energy));
  n.clean = clamp01(n.clean - dDays * 0.09);
  n.joy = clamp01(n.joy - dDays * (0.1 + 0.1 * g.sociability));
  // Hungry: a bite from a bowl with food left.
  const bowl = n.food < 0.5 && world.items.find((i) => i.kind === "food" && i.bites > 0);
  if (bowl) { bowl.bites--; n.food = clamp01(n.food + 0.35); }
  // Others around keep its spirits up, as their games and chats do on screen.
  if (onScreen().some((q) => q !== p && q.stage === "alive")) n.joy = clamp01(n.joy + dDays * (0.08 + 0.12 * g.sociability));
  // About as often as on screen: once or twice a day when she can.
  if (p.sex === "f" && canMate(p) && rnd() < t.fertility * (0.4 + n.joy) * dDays * 2) {
    const q = partnerFor(p);
    if (q) {
      p.pregnantUntil = world.time + G.GESTATION_DAYS;
      p.pregnantBy = q.id;
      p.cooldownUntil = q.cooldownUntil = world.time + G.BREED_COOLDOWN_DAYS;
    }
  }
}

async function save(force) {
  if (!dirty && !force) return;
  dirty = false;
  try {
    await octopus.storage.set(STORE_KEY, world);
  } catch (e) {
    dirty = true;
    console.error("Pets: save failed", e);
  }
}

// ---- Toolbar ---------------------------------------------------------------------------------------

function renderBar() {
  for (const b of document.querySelectorAll("#speed button")) {
    const s = Number(b.dataset.speed);
    b.classList.toggle("on", s === 0 ? world.paused : !world.paused && s === world.speed);
    if (s === 0) b.textContent = world.paused ? "Resume" : "Pause";
  }
  $("#paused").hidden = !world.paused;
  $("#office").classList.toggle("on", !!world.office);
  worldEl.classList.toggle("is-paused", world.paused);
}

// ---- Ground ----------------------------------------------------------------------------------------

const groundEl = $("#ground"), groundSel = $("#ground-pick");
groundSel.innerHTML = Object.entries(GROUNDS).filter(([, g]) => !g.hidden).map(([id, g]) => `<option value="${id}">${g.label}</option>`).join("");
worldEl.style.setProperty("--shadow-img", `url(${shadowArt()})`);
let groundQueued = false;

/** Draws the chosen ground (at the next frame: resizes come in bursts). */
function renderGround() {
  if (groundQueued) return;
  groundQueued = true;
  requestAnimationFrame(() => {
    groundQueued = false;
    if (!GROUNDS[world.ground]) world.ground = "meadow";
    const art = groundId() !== "plain";
    groundSel.value = world.ground;
    groundSel.disabled = !!world.office;
    groundSel.title = world.office ? "Scenery (outside the office)" : "Scenery";
    worldEl.classList.toggle("art", art);
    groundEl.hidden = !art;
    if (art && sized()) drawGround(groundEl, W, H, groundId());
  });
}

$("#office").addEventListener("click", () => {
  world.office = !world.office;
  // Desks can't be entered or climbed: whoever was in or on a place comes out.
  for (const id of placeRt.keys()) evacuate(id);
  renderBar();
  renderGround();
  renderPlaces();
  refreshSide();
  save(true);
});

groundSel.addEventListener("change", () => {
  world.ground = groundSel.value;
  renderGround();
  renderPlaces();
  refreshSide();
  save(true);
});

$("#paused").addEventListener("click", () => { world.paused = false; renderBar(); save(true); });

$("#speed").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const s = Number(b.dataset.speed);
  if (s === 0) world.paused = !world.paused;
  else { world.speed = s; world.paused = false; }
  renderBar();
  save(true);
});

$("#reset").addEventListener("click", async () => {
  if (!confirm("Remove every pet, egg, ancestor and item? Places keep their spots.")) return;
  for (const r of rt.values()) r.el.remove();
  for (const ir of itemRt.values()) ir.el.remove();
  for (const ev of events) ev.table?.remove();
  events = [];
  rt.clear();
  itemRt.clear();
  world = { ...freshWorld(), places: world.places, ground: world.ground, office: world.office };
  selectedId = null;
  closeHeritage();
  await save(true);
  renderBar();
  refreshSide();
  renderEmpty();
});

function renderEmpty() {
  const none = onScreen().length === 0;
  $("#empty").hidden = !none;
  if (!none) return;
  const gone = pets().some((p) => p.stage === "dead" && !p.generated);
  $("#empty-text").textContent = gone ? "Every pet has passed away. Their heritage stays in the sidebar." : "No pets yet.";
  $("#new2").textContent = gone ? "Hatch a new pet" : "Hatch your first pet";
}

// ---- Sidebar ---------------------------------------------------------------------------------------

function select(id) {
  selectedId = id;
  if (id) selectedPlace = null;
  for (const pr of placeRt.values()) pr.el.classList.toggle("selected", selectedPlace === pr.id);
  for (const p of onScreen()) { const r = rt.get(p.id); if (r) place(p, r); }
  refreshSide();
}

function selectPlace(id) {
  selectedPlace = id;
  select(null);
  selectedPlace = id;
  for (const pr of placeRt.values()) pr.el.classList.toggle("selected", selectedPlace === pr.id);
  refreshSide();
}

function refreshSide() {
  const a = document.activeElement;
  if (a && a.id === "insp-name") { sideStale = true; return; }
  sideStale = false;
  renderSide();
}

function lifeText(p) {
  if (p.stage === "egg") return "egg";
  if (p.stage === "dead") return `lived ${days(ageOf(p))}`;
  return days(ageOf(p));
}

function linkTo(id) {
  const p = world.pets[id];
  return p ? `<a class="pl" data-sel="${p.id}">${esc(p.name)}</a>` : `<span class="faint">unknown</span>`;
}

const NEEDS = { food: "Fed", clean: "Clean", joy: "Happy" };

function needFlags(p) {
  if (p.stage !== "alive") return [];
  const n = needs(p), out = [];
  if (n.food < 0.25) out.push("Hungry");
  if (n.clean < 0.3) out.push("Dirty");
  if (n.joy < 0.25) out.push("Bored");
  return out;
}

function inspectorHTML(p) {
  if (!p) {
    return `<section class="hint muted">Click a pet to see its characteristics. Drag pets and places to move them.
      Use Food, Brush and Ball in the toolbar to look after them.</section>`;
  }
  const t = G.phenotype(p);
  const label = stageLabel(p);
  const badgeCls = { Baby: "success", Elder: "warn", Departed: "error" }[label] || "";
  const kids = childrenOf(p.id);
  const lifePct = p.stage === "egg" ? 0 : Math.min(100, (ageOf(p) / t.lifespan) * 100);
  const traits = Object.entries(G.TRAIT_LABELS).map(([k, name]) => {
    const v = p.genes[k];
    return `<div class="trait"><span class="muted">${name}</span><div class="bar"><i style="width:${(v * 100).toFixed(0)}%"></i></div><span>${(v * 100).toFixed(0)}</span></div>`;
  }).join("");
  const needRows = p.stage === "alive" ? `<h4>Needs</h4>` + Object.entries(NEEDS).map(([k, name]) =>
    `<div class="trait"><span class="muted">${name}</span><div class="bar need"><i data-need="${k}"></i></div><span data-needv="${k}"></span></div>`).join("") : "";
  const origin = p.founder ? "Founder" : p.generated ? "Ancestor" : `Generation ${p.gen}`;
  return `<section>
    <div class="insp-head">
      <div class="portrait">${p.stage === "egg" ? eggArt(p) : petArt(p)}</div>
      <div style="min-width:0;flex:1">
        <input id="insp-name" value="${esc(p.name)}" maxlength="24" ${p.generated ? "disabled" : ""} spellcheck="false" />
        <div class="muted">${G.ANIMALS[p.type].label} · ${esc(p.species)} · ${sexSym(p)}</div>
        <div class="badges"><span class="badge ${badgeCls}">${label}</span>
          ${p.pregnantUntil ? `<span class="badge warn">Expecting</span>` : ""}
          ${needFlags(p).map((f) => `<span class="badge error">${f}</span>`).join("")}
          <span class="badge">${origin}</span></div>
      </div>
    </div>
    ${p.stage === "alive" ? `<div class="kv doing"><span>Now</span><span data-doing="${p.id}"></span></div>` : ""}
    ${needRows}
    <h4>Life</h4>
    <div class="kv"><span>Age</span><span data-age="${p.id}">${lifeText(p)}</span></div>
    <div class="bar life ${lifePct > 80 ? "old" : ""}"><i data-life="${p.id}" style="width:${lifePct.toFixed(1)}%"></i></div>
    <div class="kv"><span>Lifespan</span><span>${days(t.lifespan)}</span></div>
    <div class="kv"><span>Temperament</span><span>${t.temperament}</span></div>
    <div class="kv"><span>Quirk</span><span>${t.quirk}</span></div>
    <div class="kv"><span>Coat</span><span>${p.pattern}</span></div>
    <h4>Characteristics</h4>${traits}
    <h4>Family</h4>
    <div class="kv links"><span>Mother</span><span>${p.mother ? linkTo(p.mother) : p.founder ? `<span class="faint">see heritage</span>` : "—"}</span></div>
    <div class="kv links"><span>Father</span><span>${p.father ? linkTo(p.father) : p.founder ? `<span class="faint">see heritage</span>` : "—"}</span></div>
    <div class="kv links"><span>Children</span><span>${kids.length ? kids.map((k) => linkTo(k.id)).join(", ") : "—"}</span></div>
    <div class="actions"><button class="primary" data-her="${p.id}">Heritage</button></div>
  </section>`;
}

function placeHTML(id) {
  const pr = placeRt.get(id);
  if (!pr) return inspectorHTML(null);
  const visitors = visitorsOf(id);
  return `<section>
    <div class="insp-head">
      <div class="portrait"><div class="px1" style="${artStyle(pr.art, pr.kind)}"></div></div>
      <div style="min-width:0;flex:1">
        <div class="place-name">${esc(pr.name)}</div>
        <div class="muted">${PLACE_KINDS[pr.kind].label} · project</div>
        <div class="badges">${pr.lit ? `<span class="badge success">Work project</span>` : ""}</div>
      </div>
    </div>
    ${siteHTML(id)}
    <h4>Here now (${visitors.length})</h4>
    <div class="links">${visitors.map((v) => linkTo(v.id)).join(", ") || `<span class="faint">Nobody.</span>`}</div>
    <div class="actions"><button class="ghost" data-hide-place="${id}">Remove from scene</button></div>
    <p class="faint">${PLACE_KINDS[pr.kind].enter ? "Pets come in here to nap." : PLACE_KINDS[pr.kind].perch ? "Cats and birds climb on top; others rest in its shade." : "Pets rest in its shade."} Drag it to move it.</p>
  </section>`;
}

function listHTML(title, list, empty) {
  const rows = list.map((p) => `<div class="item ${p.id === selectedId ? "on" : ""}" data-sel="${p.id}">
      <span class="mini">${p.stage === "egg" ? eggArt(p) : petArt(p)}</span>
      <span class="nm">${esc(p.name)}</span><span class="st">${sexSym(p)} ${esc(p.species)}</span>
      <span class="spacer"></span><span class="st" data-age="${p.id}">${lifeText(p)}</span></div>`).join("");
  return `<section><h4>${title} (${list.length})</h4>${rows || `<div class="faint">${empty}</div>`}</section>`;
}

/** Every project, shown in the scene or not. */
function placesHTML() {
  if (!projects.length) return "";
  const rows = projects.map((proj) => {
    const spot = world.places[proj.id];
    const shown = spot && !spot.hidden;
    const kind = world.office ? "desk" : spot?.kind;
    const art = kind ? artFor(proj, kind, proj.id === workProjectId) : "";
    return `<div class="item ${selectedPlace === proj.id ? "on" : ""} ${shown ? "" : "off"}" ${shown ? `data-place="${proj.id}"` : ""}>
      <span class="mini place-mini"><span class="px1" style="${artStyle(art, kind)}"></span></span>
      <span class="nm">${esc(proj.name)}</span>
      <span class="spacer"></span>
      <button class="ghost small" ${shown ? `data-hide-place="${proj.id}">Remove` : `data-show-place="${proj.id}">Add`}</button></div>`;
  }).join("");
  const hiddenCount = projects.filter((p) => world.places[p.id]?.hidden).length;
  return `<section><h4>Places (${projects.length - hiddenCount}/${projects.length})</h4>${rows}</section>`;
}

function renderSide() {
  const p = world.pets[selectedId];
  const living = onScreen().sort((a, b) => a.name.localeCompare(b.name));
  const departed = pets().filter((q) => q.stage === "dead" && !q.generated).sort((a, b) => b.diedAt - a.diedAt).slice(0, 60);
  lastStage = "";
  const top = selectedPlace ? placeHTML(selectedPlace) : inspectorHTML(p);
  sideEl.innerHTML = top + listHTML("Living", living, "Nobody yet.") + placesHTML() + listHTML("Departed", departed, "Nobody has died yet.");
  const name = $("#insp-name");
  if (name) {
    name.addEventListener("change", () => rename(p, name.value));
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
    name.addEventListener("blur", () => { if (sideStale) setTimeout(refreshSide); });
  }
  updateLive();
}

function rename(p, value) {
  const n = value.trim().slice(0, 24);
  if (!n || n === p.name) return;
  p.name = n;
  const r = rt.get(p.id);
  if (r) r.label.textContent = n;
  save(true);
}

sideEl.addEventListener("click", (e) => {
  const hide = e.target.closest("[data-hide-place]");
  if (hide) return setPlaceHidden(hide.dataset.hidePlace, true);
  const show = e.target.closest("[data-show-place]");
  if (show) return setPlaceHidden(show.dataset.showPlace, false);
  const pl = e.target.closest("[data-place]");
  if (pl) return selectPlace(pl.dataset.place);
  const h = e.target.closest("[data-her]");
  if (h) return openHeritage(h.dataset.her);
  const s = e.target.closest("[data-sel]");
  if (s) select(s.dataset.sel);
});

let lastStage = "";
function updateLive() {
  $("#clock").textContent = `Day ${Math.floor(world.time) + 1}`;
  const on = onScreen();
  const eggs = on.filter((p) => p.stage === "egg").length;
  $("#pop").textContent = `${on.length - eggs} alive${eggs ? ` · ${eggs} egg${eggs > 1 ? "s" : ""}` : ""}`;
  for (const el of sideEl.querySelectorAll("[data-age]")) {
    const p = world.pets[el.dataset.age];
    if (p) el.textContent = lifeText(p);
  }
  $("#event").textContent = events.map(eventTitle).join(" · ");
  const p = world.pets[selectedId];
  if (!p) return;
  const bar = sideEl.querySelector(`[data-life="${p.id}"]`);
  if (bar && p.stage === "alive") bar.style.width = Math.min(100, (ageOf(p) / G.phenotype(p).lifespan) * 100).toFixed(1) + "%";
  const d = sideEl.querySelector("[data-doing]");
  if (d) d.innerHTML = doing(p);
  if (p.stage === "alive") {
    const n = needs(p);
    for (const k of Object.keys(NEEDS)) {
      const i = sideEl.querySelector(`[data-need="${k}"]`), v = sideEl.querySelector(`[data-needv="${k}"]`);
      if (i) { i.style.width = (n[k] * 100).toFixed(0) + "%"; i.parentElement.classList.toggle("low", n[k] < 0.3); }
      if (v) v.textContent = (n[k] * 100).toFixed(0);
    }
  }
  const st = stageLabel(p) + (p.pregnantUntil ? "+" : "") + needFlags(p).join();
  if (lastStage && st !== lastStage) refreshSide();
  lastStage = st;
}

// ---- Heritage --------------------------------------------------------------------------------------

function openHeritage(id) {
  if (her && her.id !== id) her.back.push(her.id);
  else if (!her) her = { back: [] };
  her.id = id;
  renderHeritage();
}

function closeHeritage() {
  her = null;
  herEl.hidden = true;
  herEl.innerHTML = "";
}

function nodeHTML(p, root) {
  if (!p) return `<div class="node unknown">Unknown</div>`;
  const sub = [p.species, lifeText(p), p.generated ? "ancestor" : p.founder ? "founder" : `gen ${p.gen}`].map(esc).join(" · ");
  return `<div class="node ${root ? "root" : ""} ${p.stage === "dead" ? "dead" : ""}" data-node="${p.id}" title="${esc(G.phenotype(p).temperament + " · " + G.phenotype(p).quirk)}">
    <span class="mini">${p.stage === "egg" ? eggArt(p) : petArt(p)}</span>
    <div style="min-width:0"><div class="nm">${sexSym(p)} ${esc(p.name)}</div><div class="sub">${sub}</div></div></div>`;
}

function renderHeritage() {
  const root = world.pets[her.id];
  if (!root) return closeHeritage();
  ensureAncestors(root, 3);
  const cols = [[root]];
  for (let gen = 1; gen < 4; gen++) {
    cols.push(cols[gen - 1].flatMap((p) => [world.pets[p?.mother], world.pets[p?.father]]));
  }
  const titles = ["Pet", "Parents", "Grandparents", "Great-grandparents"];
  const kids = childrenOf(root.id), sibs = siblingsOf(root);
  herEl.innerHTML = `<div class="her-bar">
      <button class="ghost" id="her-back" ${her.back.length ? "" : "disabled"}>Back</button>
      <span class="title">Heritage of ${esc(root.name)}</span>
      <span class="muted">${G.ANIMALS[root.type].label} · ${esc(root.species)}</span>
      <span class="spacer"></span>
      <span class="faint">Click an ancestor to go further back</span>
      ${root.stage !== "dead" ? `<button class="ghost" id="her-find">Show in world</button>` : ""}
      <button class="ghost" id="her-close">Close</button>
    </div>
    <div class="ped">${cols.map((col, i) => `<div class="ped-col"><h4>${titles[i]}</h4><div class="slots">${col.map((p) => nodeHTML(p, i === 0)).join("")}</div></div>`).join("")}</div>
    <div class="kin">
      <h4>Children (${kids.length})</h4><div class="row">${kids.map((k) => nodeHTML(k)).join("") || `<span class="faint">None yet.</span>`}</div>
      <h4>Siblings (${sibs.length})</h4><div class="row">${sibs.map((k) => nodeHTML(k)).join("") || `<span class="faint">None.</span>`}</div>
    </div>`;
  herEl.hidden = false;
  if (dirty) save(true);
}

herEl.addEventListener("click", (e) => {
  if (e.target.closest("#her-close")) return closeHeritage();
  if (e.target.closest("#her-back")) { her.id = her.back.pop(); return renderHeritage(); }
  if (e.target.closest("#her-find")) { const id = her.id; closeHeritage(); return select(id); }
  const n = e.target.closest("[data-node]");
  if (n) { select(n.dataset.node); if (n.dataset.node !== her.id) openHeritage(n.dataset.node); }
});

// ---- New pet dialog --------------------------------------------------------------------------------

const dlg = $("#dlg");
const f = { name: $("#f-name"), type: $("#f-type"), species: $("#f-species"), custom: $("#f-custom"), sex: $("#f-sex") };
let salt = 0;

f.type.innerHTML = Object.entries(G.ANIMALS).map(([k, a]) => `<option value="${k}">${a.label}</option>`).join("");

const CUSTOM = "__custom";
const showCustom = () => {
  for (const el of document.querySelectorAll(".custom-row")) el.hidden = f.species.value !== CUSTOM;
};

function fillSpecies(choice) {
  const list = Object.keys(G.ANIMALS[f.type.value].species);
  f.species.innerHTML = list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("") +
    `<option value="${CUSTOM}">Custom…</option>`;
  f.species.value = choice || list[Math.floor(rnd() * list.length)];
  showCustom();
}

const speciesValue = () => (f.species.value === CUSTOM ? f.custom.value : f.species.value);

/** The pet the form describes: the same inputs always give the same pet, "Reroll" changes the draw. */
function draft() {
  const type = f.type.value;
  const species = G.normalizeSpecies(type, speciesValue());
  const name = f.name.value.trim() || "Pet";
  const rng = G.mulberry32(G.hashStr(`${name}|${type}|${species.toLowerCase()}|${salt}`));
  const genes = G.randomGenes(rng, type);
  const sexRoll = rng() < 0.5 ? "f" : "m";
  return {
    id: "draft" + salt, name, type, species, genes,
    pattern: G.founderPattern(type, species, rng), quirk: G.randomQuirk(rng),
    sex: f.sex.value === "r" ? sexRoll : f.sex.value,
  };
}

function preview() {
  const d = draft();
  const t = G.phenotype(d);
  $("#pv-art").innerHTML = petArt(d);
  const custom = !G.ANIMALS[d.type].species[d.species];
  $("#pv-text").innerHTML = `${sexSym(d)} ${t.temperament}<br>${t.quirk}<br>Lives about ${Math.round(t.lifespan)} days` +
    (custom ? `<br><span class="faint">New species</span>` : "");
}

function openNew() {
  salt = Math.floor(rnd() * 1e9);
  f.name.value = G.randomName();
  f.sex.value = "r";
  f.custom.value = "";
  fillSpecies();
  preview();
  dlg.showModal();
  f.name.select();
}

$("#new").addEventListener("click", openNew);
$("#new2").addEventListener("click", openNew);
$("#f-dice").addEventListener("click", () => { f.name.value = G.randomName(); preview(); });
$("#f-reroll").addEventListener("click", () => { salt++; preview(); });
$("#f-random").addEventListener("click", () => {
  const types = Object.keys(G.ANIMALS);
  f.type.value = types[Math.floor(rnd() * types.length)];
  fillSpecies();
  f.name.value = G.randomName();
  f.sex.value = "r";
  salt = Math.floor(rnd() * 1e9);
  preview();
});
$("#f-cancel").addEventListener("click", () => dlg.close());
f.type.addEventListener("change", () => { fillSpecies(); preview(); });
f.species.addEventListener("change", () => { showCustom(); if (f.species.value === CUSTOM) f.custom.focus(); preview(); });
for (const el of [f.name, f.custom, f.sex]) el.addEventListener("input", preview);
$("#form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!f.name.value.trim()) return f.name.focus();
  if (f.species.value === CUSTOM && !f.custom.value.trim()) return f.custom.focus();
  const d = draft();
  dlg.close();
  closeHeritage();
  addFounder(d);
});

// ---- Start -----------------------------------------------------------------------------------------

new ResizeObserver(() => {
  W = worldEl.clientWidth; H = worldEl.clientHeight;
  if (!sized()) return;
  for (const p of onScreen()) clampPos(p);
  for (const it of world.items) clampPos(it);
  renderPlaces();
  renderGround();
}).observe(worldEl);

/** Resolves once the scene has a real size (Octopus may load the page while its section is hidden). */
function whenSized() {
  W = worldEl.clientWidth; H = worldEl.clientHeight;
  if (sized()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      W = worldEl.clientWidth; H = worldEl.clientHeight;
      if (!sized()) return;
      ro.disconnect();
      clearInterval(timer);
      resolve();
    };
    const ro = new ResizeObserver(check);
    const timer = setInterval(check, 300);   // in case no resize is reported
    ro.observe(worldEl);
  });
}

async function main() {
  await octopus.ready();
  await whenSized();
  try {
    const saved = await octopus.storage.get(STORE_KEY);
    if (saved && saved.v === 1 && saved.pets) world = Object.assign(freshWorld(), saved);
  } catch (e) {
    console.error("Pets: load failed", e);
  }
  for (const p of onScreen()) {
    // Not a number, or pushed into the corner by an earlier version laying out a 0×0 scene.
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.x <= 60 && p.y <= 90)) { delete p.x; delete p.y; }
    mount(p);
  }
  for (const [id, f] of Object.entries(world.places)) {
    if (!Number.isFinite(f.fx) || !Number.isFinite(f.fy)) delete world.places[id];
  }
  world.items = world.items.filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y));
  for (const it of world.items) mountItem(it);
  renderTools();
  renderGround();
  renderEmpty();
  renderBar();
  renderSide();
  await loadProjects();
  await loadTerminals();
  octopus.on("terminals", (list) => { terminals = list; syncSites(); refreshSide(); });
  octopus.on("visible", (shown) => {
    last = performance.now();
    if (shown === false) save(true); else loadProjects();
  });
  setInterval(() => save(), 5000);
  setInterval(loadProjects, 60000);
  window.addEventListener("pagehide", () => save(true));
  requestAnimationFrame(loop);
}

main();
