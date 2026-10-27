// The page's side of the helper (server.py): starts it, reads its token from its log, and calls it.
const PORT = 47861;
const BASE = `http://127.0.0.1:${PORT}`;
let token = null;
let starting = null;

async function readToken() {
  const log = (await octopus.helpers.log("server", { lines: 200 })) || "";
  const text = Array.isArray(log) ? log.join("\n") : String(log);
  const ready = [...text.matchAll(/DBVIEWER_READY port=(\d+) token=(\S+)/g)].pop();
  const failed = [...text.matchAll(/DBVIEWER_ERROR (.*)/g)].pop();
  if (failed && (!ready || text.lastIndexOf(failed[0]) > text.lastIndexOf(ready[0]))) throw new Error(failed[1]);
  return ready ? ready[2] : null;
}

/** Starts the helper if needed and waits for its token. */
export function connectHelper(force = false) {
  if (starting && !force) return starting;
  starting = (async () => {
    token = null;
    const st = await octopus.helpers.status("server").catch(() => null);
    if (!st?.running) await octopus.helpers.start("server");
    for (let i = 0; i < 50; i++) {
      const t = await readToken();
      if (t) {
        token = t;
        const res = await octopus.http.fetch(`${BASE}/health`, { headers: { "X-Db-Viewer-Token": t }, timeoutMs: 3000 }).catch(() => null);
        if (res?.ok) return res.json();
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("The Db Viewer helper didn't start. Is python3 installed?");
  })();
  starting.catch(() => (starting = null));
  return starting;
}

export async function restartHelper() {
  await octopus.helpers.stop("server").catch(() => {});
  starting = null;
  return connectHelper(true);
}

/** POST to the helper. Rejects with an Error carrying the server's JSON (`.data`) and HTTP status. */
export async function call(path, body = {}, { timeoutMs = 120000 } = {}, retried = false) {
  if (!token) await connectHelper();
  let res;
  try {
    res = await octopus.http.fetch(BASE + path, {
      method: "POST",
      headers: { "X-Db-Viewer-Token": token, "Content-Type": "application/json" },
      body,
      timeoutMs,
    });
  } catch (e) {
    // A statement is never sent twice: it may have run (a write!) before the connection broke.
    if (retried || path === "/query") throw e;
    // The helper may have been restarted (new token) or have died: reconnect and try once more.
    await connectHelper(true);
    return call(path, body, { timeoutMs }, true);
  }
  if (res.status === 401 && !retried) {
    await connectHelper(true);
    return call(path, body, { timeoutMs }, true);
  }
  let data = null;
  try {
    data = res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** What the server needs of a connection: never its password (that's in the Keychain). */
export function wire(conn) {
  const { id, driver, host, port, user, database, tls, tlsCa, readOnly, timeoutMs, rowLimit, env, checkPlan, scanWarnRows } = conn;
  return { id, driver, host, port, user, database, tls, tlsCa, readOnly, timeoutMs, rowLimit, env, checkPlan, scanWarnRows };
}
