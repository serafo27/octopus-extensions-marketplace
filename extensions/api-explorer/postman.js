// Postman collection v2.0/v2.1 and environment import and export.

import { uid } from "./store.js";
import { splitUrl, parseQuery } from "./http.js";

const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** { collection } or { environment } from a Postman export (an object or its JSON text). */
export function fromPostman(json) {
  if (typeof json === "string") json = JSON.parse(json);
  if (json?.collection?.info) json = json.collection; // as returned by Postman's API
  if (json?.environment?.values) json = json.environment;
  if (json?.info && Array.isArray(json.item)) return { collection: collectionIn(json) };
  if (Array.isArray(json?.values))
    return { environment: { id: uid(), name: json.name || "Imported environment", variables: json.values.map(kvIn) } };
  throw new Error("Not a Postman collection (v2.x) or environment");
}

function collectionIn(c) {
  return {
    id: uid(),
    type: "collection",
    name: c.info.name || "Imported collection",
    variables: (c.variable ?? []).map(kvIn),
    auth: authIn(c.auth, false),
    items: c.item.map(itemIn),
    extra: pick(c, ["event", "description"]),
    description: typeof c.info.description === "string" ? c.info.description : c.info.description?.content,
  };
}

function itemIn(it) {
  if (Array.isArray(it.item))
    return { id: uid(), type: "folder", name: it.name || "Folder", auth: authIn(it.auth, true), items: it.item.map(itemIn), extra: pick(it, ["event", "description"]) };
  const r = typeof it.request === "string" ? { url: it.request, method: "GET" } : (it.request ?? {});
  const url = urlIn(r.url);
  const disabledQuery = (typeof r.url === "object" ? (r.url?.query ?? []) : []).filter((p) => p.disabled).map(kvIn);
  return {
    id: uid(),
    type: "request",
    name: it.name || url || "Request",
    req: {
      method: (r.method || "GET").toUpperCase(),
      url,
      params: [...parseQuery(splitUrl(url)[1]), ...disabledQuery],
      headers: (Array.isArray(r.header) ? r.header : []).map(kvIn),
      body: bodyIn(r.body),
      auth: authIn(r.auth, true),
      ...settingsIn(it.protocolProfileBehavior),
    },
    extra: pick(it, ["event", "response", "description"]),
  };
}

/** Postman's per-request behaviour, as the settings this extension keeps (only what isn't the default). */
function settingsIn(b) {
  const s = {};
  if (b?.followRedirects === false) s.followRedirects = false;
  if (b?.strictSSL === false) s.verifyTls = false;
  return Object.keys(s).length ? { settings: s } : {};
}

const kvIn = (v) => ({ key: v.key ?? "", value: v.value == null ? "" : typeof v.value === "string" ? v.value : JSON.stringify(v.value), enabled: !v.disabled && v.enabled !== false });

function urlIn(u) {
  if (!u) return "";
  if (typeof u === "string") return u;
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join(".") : (u.host ?? "");
  const path = Array.isArray(u.path) ? u.path.map((p) => (typeof p === "string" ? p : p.value)).join("/") : (u.path ?? "");
  const query = (u.query ?? []).filter((p) => !p.disabled).map((p) => (p.value == null ? p.key : `${p.key}=${p.value}`)).join("&");
  return (u.protocol ? u.protocol + "://" : "") + host + (u.port ? ":" + u.port : "") + (path ? "/" + path : "") + (query ? "?" + query : "");
}

function bodyIn(b) {
  const empty = { mode: "none", raw: "", form: [] };
  if (!b?.mode || b.disabled) return empty;
  if (b.mode === "raw") {
    const lang = b.options?.raw?.language;
    const raw = b.raw ?? "";
    return { ...empty, mode: lang === "json" || (!lang && /^\s*[[{]/.test(raw)) ? "json" : "text", raw };
  }
  if (b.mode === "urlencoded") return { ...empty, mode: "urlencoded", form: (b.urlencoded ?? []).map(kvIn) };
  if (b.mode === "formdata") return { ...empty, mode: "form", form: (b.formdata ?? []).filter((f) => f.type !== "file").map(kvIn) };
  if (b.mode === "graphql") {
    let variables;
    try {
      variables = b.graphql?.variables ? JSON.parse(b.graphql.variables) : undefined;
    } catch {}
    return { ...empty, mode: "json", raw: JSON.stringify({ query: b.graphql?.query ?? "", variables }, null, 2) };
  }
  return empty;
}

function authIn(a, inherit) {
  if (!a) return { type: inherit ? "inherit" : "none" };
  const get = (list, key) => {
    if (!list) return "";
    if (!Array.isArray(list)) return list[key] ?? "";
    return list.find((x) => x.key === key)?.value ?? "";
  };
  switch (a.type) {
    case "noauth":
      return { type: "none" };
    case "bearer":
      return { type: "bearer", token: get(a.bearer, "token") };
    case "basic":
      return { type: "basic", username: get(a.basic, "username"), password: get(a.basic, "password") };
    case "apikey":
      return { type: "apikey", key: get(a.apikey, "key"), value: get(a.apikey, "value"), in: get(a.apikey, "in") || "header" };
    default:
      return { type: "other", raw: a };
  }
}

const pick = (o, keys) => {
  const out = {};
  for (const k of keys) if (o[k] != null) out[k] = o[k];
  return out;
};

// --- Export ---------------------------------------------------------------------------------------

export function toPostman(c) {
  return {
    info: { _postman_id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}), schema: SCHEMA },
    item: c.items.map(itemOut),
    ...(c.variables?.length ? { variable: c.variables.map(kvOut) } : {}),
    ...(authOut(c.auth) ? { auth: authOut(c.auth) } : {}),
    ...(c.extra ?? {}),
  };
}

function itemOut(n) {
  if (n.type === "folder")
    return { name: n.name, item: n.items.map(itemOut), ...(authOut(n.auth) ? { auth: authOut(n.auth) } : {}), ...(n.extra ?? {}) };
  const r = n.req;
  const request = { method: r.method, header: r.headers.map(kvOut), url: urlOut(r) };
  const body = bodyOut(r.body);
  if (body) request.body = body;
  if (authOut(r.auth)) request.auth = authOut(r.auth);
  const behavior = {};
  if (r.settings?.followRedirects === false) behavior.followRedirects = false;
  if (r.settings?.verifyTls === false) behavior.strictSSL = false;
  return {
    name: n.name,
    ...(n.extra ?? {}),
    ...(Object.keys(behavior).length ? { protocolProfileBehavior: behavior } : {}),
    request,
    response: n.extra?.response ?? [],
  };
}

const kvOut = (v) => ({ key: v.key, value: v.value, ...(v.enabled === false ? { disabled: true } : {}) });

function urlOut(r) {
  const [base] = splitUrl(r.url);
  const m = base.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]*)(.*)$/i);
  const out = { raw: r.url };
  if (m[1]) out.protocol = m[1];
  let host = m[2];
  const port = host.match(/:(\d+)$/);
  if (port) (out.port = port[1]), (host = host.slice(0, -port[0].length));
  if (host) out.host = host.startsWith("{{") ? [host] : host.split(".");
  const path = m[3].replace(/^\//, "");
  if (path) out.path = path.split("/");
  if (r.params?.length) out.query = r.params.map(kvOut);
  return out;
}

function bodyOut(b) {
  switch (b?.mode) {
    case "json":
      return { mode: "raw", raw: b.raw, options: { raw: { language: "json" } } };
    case "text":
      return { mode: "raw", raw: b.raw };
    case "urlencoded":
      return { mode: "urlencoded", urlencoded: b.form.map(kvOut) };
    case "form":
      return { mode: "formdata", formdata: b.form.map((f) => ({ ...kvOut(f), type: "text" })) };
    default:
      return null;
  }
}

function authOut(a) {
  if (!a || a.type === "inherit") return null;
  const s = (key, value) => ({ key, value: value ?? "", type: "string" });
  switch (a.type) {
    case "none":
      return { type: "noauth" };
    case "bearer":
      return { type: "bearer", bearer: [s("token", a.token)] };
    case "basic":
      return { type: "basic", basic: [s("username", a.username), s("password", a.password)] };
    case "apikey":
      return { type: "apikey", apikey: [s("key", a.key), s("value", a.value), s("in", a.in ?? "header")] };
    case "other":
      return a.raw;
  }
  return null;
}

export function envToPostman(e) {
  return {
    id: e.id,
    name: e.name,
    values: e.variables.map((v) => ({ key: v.key, value: v.value, type: "default", enabled: v.enabled !== false })),
    _postman_variable_scope: "environment",
  };
}
