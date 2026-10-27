// State of the extension and its persistence in Octopus's storage.

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export const state = {
  collections: [], // { id, type: "collection", name, items, variables, auth, extra }
  environments: [], // { id, name, variables: [{ key, value, enabled }] }
  activeEnv: null,
  history: [], // { id, at, req, status, ms }
  tabs: [], // { id, kind: "request" | "container" | "env", nodeId, envId, name, req, dirty, response }
  activeTab: null,
  ui: { side: "collections", sideWidth: 270, split: 0.45, expanded: {}, reqTab: "params", resTab: "body", pretty: true },
};

const KEYS = Object.keys(state);
const HISTORY_MAX = 200;
const KEEP_RESPONSE = 200_000;

export function newRequest(over = {}) {
  return {
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none", raw: "", form: [] },
    auth: { type: "inherit" },
    ...over,
  };
}

export async function load() {
  await Promise.all(
    KEYS.map(async (k) => {
      const v = await octopus.storage.get(k).catch(() => null);
      if (v != null) state[k] = k === "ui" ? { ...state.ui, ...v } : v;
    }),
  );
  if (!state.tabs.find((t) => t.id === state.activeTab)) state.activeTab = state.tabs[0]?.id ?? null;
}

const timers = {};
export function save(...keys) {
  for (const k of keys) {
    clearTimeout(timers[k]);
    timers[k] = setTimeout(() => {
      let v = state[k];
      if (k === "tabs")
        v = v.map((t) => ({
          ...t,
          sending: undefined,
          response: t.response && (t.response.body?.length ?? 0) < KEEP_RESPONSE ? t.response : undefined,
        }));
      octopus.storage.set(k, v).catch((e) => octopus.toast("Could not save: " + e.message, "error"));
    }, 300);
  }
}

export function addHistory(req, status, ms) {
  state.history.unshift({ id: uid(), at: Date.now(), req: structuredClone(req), status, ms });
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  save("history");
}

/** Finds a node anywhere in the collections: { node, parent, collection, ancestors (nearest first) }. */
export function findNode(id) {
  for (const c of state.collections) {
    if (c.id === id) return { node: c, parent: null, collection: c, ancestors: [] };
    const r = walkFind(c, id, [c]);
    if (r) return { ...r, collection: c };
  }
  return null;
}

function walkFind(parent, id, chain) {
  for (const n of parent.items ?? []) {
    if (n.id === id) return { node: n, parent, ancestors: [...chain].reverse() };
    if (n.items) {
      const r = walkFind(n, id, [...chain, n]);
      if (r) return r;
    }
  }
  return null;
}

/** A deep copy of a node with new ids. */
export function cloneNode(n) {
  const c = structuredClone(n);
  const reid = (x) => {
    x.id = uid();
    x.items?.forEach(reid);
  };
  reid(c);
  return c;
}

export function activeEnv() {
  return state.environments.find((e) => e.id === state.activeEnv) ?? null;
}
