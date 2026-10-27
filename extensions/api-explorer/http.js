// Variables, building and sending a request, cURL in and out.

import { proxySend } from "./helper.js";

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const DYNAMIC = {
  $guid: () => crypto.randomUUID(),
  $randomUUID: () => crypto.randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};

export const isDynamic = (name) => Object.hasOwn(DYNAMIC, name);

/** A lookup over variable lists, the first list winning: environment, then collection. */
export function scope(...lists) {
  const map = new Map();
  for (const list of lists.reverse()) for (const v of list ?? []) if (v.enabled !== false && v.key) map.set(v.key, v.value ?? "");
  return map;
}

export function resolve(str, vars, depth = 0) {
  if (!str || !str.includes("{{")) return str ?? "";
  const out = str.replace(VAR_RE, (m, name) => {
    if (vars.has(name)) return vars.get(name);
    if (DYNAMIC[name]) return DYNAMIC[name]();
    return m;
  });
  return out !== str && depth < 5 ? resolve(out, vars, depth + 1) : out;
}

/** Names of {{variables}} in `str` that `vars` doesn't define. */
export function unresolved(str, vars) {
  return [...(str ?? "").matchAll(VAR_RE)].map((m) => m[1]).filter((n) => !vars.has(n) && !DYNAMIC[n]);
}

// --- URL and query params -------------------------------------------------------------------------

export function splitUrl(url) {
  const i = url.indexOf("?");
  return i < 0 ? [url, ""] : [url.slice(0, i), url.slice(i + 1)];
}

export function parseQuery(qs) {
  if (!qs) return [];
  return qs.split("&").map((p) => {
    const i = p.indexOf("=");
    return i < 0 ? { key: p, value: "", enabled: true } : { key: p.slice(0, i), value: p.slice(i + 1), enabled: true };
  });
}

export function buildQuery(params) {
  return params
    .filter((p) => p.enabled !== false && (p.key || p.value))
    .map((p) => (p.value === "" && !p.key.includes("=") ? p.key : `${p.key}=${p.value}`))
    .join("&");
}

/** The params list after the URL was edited: enabled ones from the URL, disabled ones kept. */
export function paramsFromUrl(url, old = []) {
  return [...parseQuery(splitUrl(url)[1]), ...old.filter((p) => p.enabled === false)];
}

export function urlFromParams(url, params) {
  const q = buildQuery(params);
  return splitUrl(url)[0] + (q ? "?" + q : "");
}

// --- Building and sending -------------------------------------------------------------------------

/** The auth that applies: the request's, or the nearest folder's/collection's when it inherits. */
export function effectiveAuth(auth, ancestors = []) {
  if (auth && auth.type !== "inherit") return auth;
  for (const a of ancestors) if (a.auth && a.auth.type !== "inherit") return a.auth;
  return { type: "none" };
}

const has = (headers, name) => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

/** The request as it goes on the wire: { method, url, headers, body }. */
export function prepare(req, vars, ancestors = []) {
  const r = (s) => resolve(s, vars);
  let url = r(req.url.trim());
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "http://" + url;
  const headers = {};
  for (const h of req.headers) if (h.enabled !== false && h.key.trim()) headers[r(h.key.trim())] = r(h.value);

  const auth = effectiveAuth(req.auth, ancestors);
  if (auth.type === "bearer" && auth.token && !has(headers, "authorization")) headers.Authorization = "Bearer " + r(auth.token);
  if (auth.type === "basic" && !has(headers, "authorization"))
    headers.Authorization = "Basic " + b64(r(auth.username ?? "") + ":" + r(auth.password ?? ""));
  if (auth.type === "apikey" && auth.key) {
    if (auth.in === "query") url += (url.includes("?") ? "&" : "?") + encodeURIComponent(r(auth.key)) + "=" + encodeURIComponent(r(auth.value ?? ""));
    else headers[r(auth.key)] = r(auth.value ?? "");
  }

  let body;
  const b = req.body ?? { mode: "none" };
  if (b.mode === "json" || b.mode === "text") {
    body = r(b.raw ?? "");
    if (!has(headers, "content-type")) headers["Content-Type"] = b.mode === "json" ? "application/json" : "text/plain";
  } else if (b.mode === "urlencoded") {
    body = (b.form ?? [])
      .filter((f) => f.enabled !== false && f.key)
      .map((f) => encodeURIComponent(r(f.key)) + "=" + encodeURIComponent(r(f.value)))
      .join("&");
    if (!has(headers, "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (b.mode === "form") {
    const boundary = "----ApiExplorer" + Math.random().toString(36).slice(2);
    body =
      (b.form ?? [])
        .filter((f) => f.enabled !== false && f.key)
        .map((f) => `--${boundary}\r\nContent-Disposition: form-data; name="${r(f.key).replace(/"/g, "%22")}"\r\n\r\n${r(f.value)}\r\n`)
        .join("") + `--${boundary}--\r\n`;
    for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-type") delete headers[k];
    headers["Content-Type"] = "multipart/form-data; boundary=" + boundary;
  }
  return { method: req.method, url: url.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c)), headers, body };
}

function b64(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

/** Sends a prepared request (through the helper, so any host works). Resolves with
 * { status, reason, headers, body, ms, size, type, at, image?, binary? }; rejects when it can't connect. */
export async function send(p, opts = {}) {
  const r = await proxySend(p, opts);
  const headers = r.headers ?? [];
  const type = contentType(headers);
  const out = { status: r.status, reason: r.reason, headers, body: r.body ?? "", ms: r.ms, size: r.size, type, at: Date.now(), redirects: r.redirects ?? [] };
  if (r.bodyBase64 != null) {
    if (/^image\//.test(type)) out.image = `data:${type};base64,${r.bodyBase64}`;
    else out.binary = true;
  }
  return out;
}

export function contentType(headers) {
  const h = headers.find(([k]) => k.toLowerCase() === "content-type");
  return h ? String(h[1]).split(";")[0].trim().toLowerCase() : "";
}

export function statusText(code, reason) {
  return STATUS[code] ?? reason ?? "";
}

const STATUS = {
  100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information",
  204: "No Content", 206: "Partial Content", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
  307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized", 402: "Payment Required",
  403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 408: "Request Timeout", 409: "Conflict",
  410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 415: "Unsupported Media Type",
  418: "I'm a teapot", 422: "Unprocessable Entity", 425: "Too Early", 428: "Precondition Required", 429: "Too Many Requests",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

// --- cURL -----------------------------------------------------------------------------------------

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function toCurl(p) {
  const parts = ["curl"];
  if (p.method !== "GET" || p.body) parts.push("-X " + p.method);
  parts.push(q(p.url));
  for (const [k, v] of Object.entries(p.headers)) parts.push("-H " + q(`${k}: ${v}`));
  if (p.body) parts.push("--data-raw " + q(p.body));
  return parts.join(" \\\n  ");
}

export function looksLikeCurl(text) {
  return /^\s*curl\s/i.test(text);
}

/** A request from a curl command line (as copied from a browser's dev tools, bash or zsh flavour). */
export function fromCurl(cmd) {
  const toks = shellSplit(cmd.replace(/\\\r?\n/g, " "));
  if (toks[0]?.toLowerCase() !== "curl") throw new Error("Not a curl command");
  let method, url, user, get = false, isJson = false;
  const headers = [], data = [], form = [];
  const SKIP_ARG = new Set(["-o", "--output", "-e", "--referer", "--connect-timeout", "-m", "--max-time", "-x", "--proxy",
    "-w", "--write-out", "--cacert", "--cert", "--key", "-r", "--range", "--retry", "-c", "--cookie-jar", "--resolve"]);
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    const next = () => toks[++i] ?? "";
    if (t === "-X" || t === "--request") method = next().toUpperCase();
    else if (/^-X\w+$/.test(t)) method = t.slice(2).toUpperCase();
    else if (t === "-H" || t === "--header") {
      const v = next();
      const c = v.indexOf(":");
      if (c > 0) headers.push({ key: v.slice(0, c).trim(), value: v.slice(c + 1).trim(), enabled: true });
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"].includes(t)) data.push(next());
    else if (t === "--json") (data.push(next()), (isJson = true));
    else if (t === "-F" || t === "--form") form.push(next());
    else if (t === "-u" || t === "--user") user = next();
    else if (t === "-G" || t === "--get") get = true;
    else if (t === "--url") url = next();
    else if (t === "-A" || t === "--user-agent") headers.push({ key: "User-Agent", value: next(), enabled: true });
    else if (t === "-b" || t === "--cookie") headers.push({ key: "Cookie", value: next(), enabled: true });
    else if (SKIP_ARG.has(t)) next();
    else if (t.startsWith("-")) continue;
    else if (!url) url = t;
  }
  url = url ?? "";
  const req = { method: method ?? (data.length || form.length ? (get ? "GET" : "POST") : "GET"), url, headers, auth: { type: "inherit" } };
  req.body = { mode: "none", raw: "", form: [] };
  if (get && data.length) {
    req.url += (url.includes("?") ? "&" : "?") + data.join("&");
  } else if (form.length) {
    req.body = { mode: "form", raw: "", form: form.filter((f) => !/^[^=]*=@/.test(f)).map(kv) };
  } else if (data.length) {
    const raw = data.join("&");
    const ct = headers.find((h) => h.key.toLowerCase() === "content-type")?.value.toLowerCase() ?? "";
    if (isJson || ct.includes("json") || (!ct && /^\s*[[{]/.test(raw))) {
      req.body = { mode: "json", raw: prettyIfJson(raw), form: [] };
      if (isJson && !ct) headers.push({ key: "Content-Type", value: "application/json", enabled: true });
    } else if ((!ct || ct.includes("x-www-form-urlencoded")) && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(raw)) {
      req.body = { mode: "urlencoded", raw: "", form: raw.split("&").map((p) => decodeKv(kv(p))) };
      dropHeader(headers, "content-type");
    } else req.body = { mode: "text", raw, form: [] };
  }
  if (user != null) {
    const c = user.indexOf(":");
    req.auth = { type: "basic", username: c < 0 ? user : user.slice(0, c), password: c < 0 ? "" : user.slice(c + 1) };
  }
  // Headers curl adds by itself or that Octopus sets.
  dropHeader(headers, "content-length");
  if (req.body.mode === "form") dropHeader(headers, "content-type");
  req.params = paramsFromUrl(req.url);
  return req;
}

const kv = (s) => {
  const i = s.indexOf("=");
  return i < 0 ? { key: s, value: "", enabled: true } : { key: s.slice(0, i), value: s.slice(i + 1), enabled: true };
};
const decodeKv = (r) => ({ ...r, key: safeDecode(r.key), value: safeDecode(r.value) });
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};
const dropHeader = (headers, name) => {
  for (let i = headers.length - 1; i >= 0; i--) if (headers[i].key.toLowerCase() === name) headers.splice(i, 1);
};
const prettyIfJson = (s) => {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

function shellSplit(s) {
  const out = [];
  let cur = null;
  let i = 0;
  const ESC = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur), (cur = null);
      i++;
      continue;
    }
    cur ??= "";
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j;
      cur += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\") {
          const n = s[i + 1];
          cur += ESC[n] ?? "\\" + n;
          i += 2;
        } else cur += s[i++];
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
        } else cur += s[i++];
      }
      i++;
    } else if (c === "\\") {
      cur += s[i + 1] ?? "";
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}
