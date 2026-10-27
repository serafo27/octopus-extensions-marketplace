// The page's side of the helper (proxy.py): starts it, reads its token from its log, and sends requests through it.

const READY = /APIEXPLORER_READY port=(\d+) token=(\S+)/g;
let conn = null; // { base, token }
let starting = null;

async function readReady() {
  const log = (await octopus.helpers.log("proxy", { lines: 200 })) || "";
  const text = Array.isArray(log) ? log.join("\n") : String(log);
  const m = [...text.matchAll(READY)].pop();
  return m ? { base: `http://127.0.0.1:${m[1]}`, token: m[2] } : null;
}

/** Starts the helper if needed and waits until it answers. */
export function connectHelper(force = false) {
  if (starting && !force) return starting;
  starting = (async () => {
    conn = null;
    const st = await octopus.helpers.status("proxy").catch(() => null);
    if (!st?.running) await octopus.helpers.start("proxy");
    for (let i = 0; i < 50; i++) {
      const c = await readReady().catch(() => null);
      if (c) {
        const res = await octopus.http.fetch(c.base + "/health", { headers: { "X-Token": c.token }, timeoutMs: 3000 }).catch(() => null);
        if (res?.ok) return (conn = c);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const log = await octopus.helpers.log("proxy", { lines: 20 }).catch(() => "");
    throw new Error("The API explorer helper (proxy.py) didn't start. Is python3 installed?" + (log ? "\n" + log : ""));
  })();
  starting.catch(() => (starting = null));
  return starting;
}

/**
 * Sends a prepared request ({ method, url, headers, body }) through the helper. Resolves with its answer
 * ({ status, reason, headers, body | bodyBase64, size, ms, url, redirects }); rejects when the request couldn't be made.
 */
export async function proxySend(p, { timeoutMs = 60000, followRedirects = true, verifyTls = true } = {}, retried = false) {
  if (!conn) await connectHelper();
  let res;
  try {
    res = await octopus.http.fetch(conn.base + "/send", {
      method: "POST",
      headers: { "X-Token": conn.token, "Content-Type": "application/json" },
      body: { url: p.url, method: p.method, headers: p.headers, body: p.body ?? null, timeoutMs, followRedirects, verifyTls },
      timeoutMs: timeoutMs + 5000,
    });
  } catch (e) {
    // Only when the helper couldn't be reached (so the request wasn't sent): restart it and try once more.
    if (retried || !/refused|connect/i.test(e.message)) throw e;
    await connectHelper(true);
    return proxySend(p, { timeoutMs, followRedirects, verifyTls }, true);
  }
  if (res.status === 401 && !retried) {
    await connectHelper(true);
    return proxySend(p, { timeoutMs, followRedirects, verifyTls }, true);
  }
  const data = res.json();
  if (data.error) {
    const err = new Error(data.error);
    err.tls = !!data.tls;
    throw err;
  }
  return data;
}
