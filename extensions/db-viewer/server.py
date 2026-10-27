#!/usr/bin/env python3
"""Db Viewer's helper: a small HTTP server on 127.0.0.1 that the page calls through octopus.http.fetch, and that
talks to the databases (the page can't open sockets).

Security:
  - Passwords live in the macOS Keychain (keychain.py), written once from the connection form and only read here,
    when connecting. They're never sent back to the page, never logged, never on a command line.
  - Every request needs the token printed at start-up (`DBVIEWER_READY port=… token=…`): the page reads it from
    this helper's log, which only Octopus can see. Another program of this Mac can reach the port, not use it.
  - Connections are read-only unless the user turns that off for one: the session is `READ ONLY` on the server and
    statements other than SELECT/SHOW/DESCRIBE/EXPLAIN are refused here before reaching it.
  - No LOAD DATA LOCAL (the server can't read this Mac's files), no multi-statements.
  - A connection marked as production (`env: "prod"`) is always read-only and fetches at most PROD_MAX_ROWS rows,
    whatever the page sends.

Not tying up the database:
  - A SELECT without LIMIT gets one (the connection's row limit); rows are streamed and we stop at the limit:
    when the server had more, the connection is dropped and its thread killed instead of draining the rest.
  - Each statement has a timeout: max_execution_time asks the server to stop SELECTs itself, and a watchdog here
    runs `KILL <thread>` from a second connection when time is up (or when the user presses Stop).
  - Idle connections are closed after IDLE_S seconds; the page can close a connection's sessions at once.
  - With `checkPlan` (on by default in production), a SELECT is EXPLAINed first: a full scan of a big table under a
    WHERE / JOIN / GROUP BY / ORDER BY comes back as a warning (409 needsPlanConfirm) instead of running.

Endpoints (POST, JSON in and out; `conn` is a connection as the page stores it, without its password):
  GET /health · /status · /secret/set {id, password} · /secret/delete {id} · /secret/has {ids}
  /test {conn, password?} · /schemas {conn} · /objects {conn, schema} · /table {conn, schema, table}
  /columns {conn, schema, table} · /query {conn, sql, schema?, limit?, timeoutMs?, queryId, confirmed?}
  /cancel {queryId} · /disconnect {id}
  /processlist {conn} (the server's threads; ours marked) · /kill {conn, threadId, queryOnly}
  /dryrun {conn, sql, schema?, queryId}: an UPDATE / DELETE / INSERT / REPLACE run in a transaction, previewed (rows
    before → after) and rolled back; the session is then dropped, so nothing of it can be committed.
"""
import sys

sys.dont_write_bytecode = True  # Octopus reloads the page when a file of this folder changes: no __pycache__ here

import hmac
import json
import os
import secrets
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "vendor"))
sys.path.insert(0, str(HERE))

import keychain  # noqa: E402
import sqltext  # noqa: E402
from drivers import DRIVERS  # noqa: E402

PRODUCT = os.environ.get("OCTOPUS_PRODUCT", "").strip() or "octopus"
PORT = int(os.environ.get("DBVIEWER_PORT") or 47861)
SERVICE = f"Octopus Db Viewer ({PRODUCT})"
TOKEN = secrets.token_urlsafe(32)
IDLE_S = 60
MAX_ROWS = 50000
DEFAULT_ROWS = 200
DEFAULT_TIMEOUT_MS = 30000
PROD_MAX_ROWS = 1000
DEFAULT_SCAN_WARN_ROWS = 1000
MAX_BODY = 2 * 1024 * 1024


class Refused(Exception):
    """An error that is the request's fault (bad input, read-only, …): status 400, message shown as it is."""

    def __init__(self, message, status=400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


# ---- Sessions: idle connections kept for a minute, running statements and how to kill them ----

_lock = threading.Lock()
_idle = {}  # pool key -> [(conn, driver, last_used)]
_running = {}  # queryId -> {...}
_open_count = {}  # connection id -> sessions open (idle + busy)


def _effective(cfg):
    cfg = dict(cfg or {})
    if cfg.get("env") == "prod":
        cfg["readOnly"] = True
        cfg.setdefault("checkPlan", True)
    return cfg


def _pool_key(cfg):
    return json.dumps([cfg.get(k) for k in ("id", "driver", "host", "port", "user", "database", "tls", "tlsCa",
                                            "readOnly", "env")])


def _driver(cfg):
    d = DRIVERS.get(cfg.get("driver") or "mysql")
    if not d:
        raise Refused(f"Unsupported database: {cfg.get('driver')}")
    for k in ("id", "host", "user"):
        if not cfg.get(k):
            raise Refused(f"The connection has no {k}")
    return d


def _password(cfg, body):
    if body.get("password") is not None:  # testing a form that isn't saved yet
        return body["password"]
    return keychain.get(SERVICE, cfg["id"]) or ""


def _count(cid, delta):
    with _lock:
        _open_count[cid] = max(0, _open_count.get(cid, 0) + delta)


def _acquire(cfg, password, timeout_s):
    d = _driver(cfg)
    key = _pool_key(cfg)
    while True:
        with _lock:
            pool = _idle.get(key) or []
            item = pool.pop() if pool else None
        if not item:
            break
        conn, _, last = item
        try:
            if time.time() - last > 10:
                d.ping(conn)
            return d, conn
        except Exception:
            d.force_close(conn)
            _count(cfg["id"], -1)
    conn = d.connect(cfg, password, timeout_s)
    _count(cfg["id"], 1)
    return d, conn


def _release(cfg, d, conn, keep):
    if keep:
        with _lock:
            _idle.setdefault(_pool_key(cfg), []).append((conn, d, time.time()))
    else:
        d.force_close(conn)
        _count(cfg["id"], -1)


def _reaper():
    while True:
        time.sleep(5)
        now = time.time()
        closing = []
        with _lock:
            for key, pool in _idle.items():
                keep = [it for it in pool if now - it[2] < IDLE_S]
                closing += [(key, it) for it in pool if now - it[2] >= IDLE_S]
                pool[:] = keep
        for key, (conn, d, _) in closing:
            d.close(conn)
            _count(json.loads(key)[0], -1)


def _kill(entry, reason):
    """Kills a running statement's server thread (and so its connection), from another connection."""
    with _lock:
        if entry.get("stopping") or entry.get("done"):
            return
        entry["stopping"] = reason
    try:
        entry["driver"].kill(entry["cfg"], entry["password"], entry["tid"])
        entry["killed"] = True
    except Exception as e:  # the statement may have ended meanwhile
        entry["killError"] = entry["driver"].error_message(e)
    finally:
        # Unblocks our side too, in case the server is unreachable.
        entry["driver"].force_close(entry["conn"])
        entry["stopped"].set()


def with_session(cfg, body, fn, timeout_ms, query_id=None):
    """Runs fn(driver, conn) on a session of the connection, under a watchdog that kills it at timeout_ms."""
    password = _password(cfg, body)
    d, conn = _acquire(cfg, password, timeout_ms / 1000)
    entry = {"cfg": cfg, "password": password, "driver": d, "conn": conn, "tid": d.thread_id(conn),
             "started": time.time(), "connId": cfg["id"], "sql": body.get("sql", "")[:300] if query_id else None,
             "stopped": threading.Event()}
    qid = query_id or f"internal-{secrets.token_hex(6)}"
    with _lock:
        _running[qid] = entry
    # A little after the timeout: for a SELECT the server's max_execution_time stops it first, cleanly.
    timer = threading.Timer(timeout_ms / 1000 + 1.5, _kill, (entry, "timeout"))
    timer.daemon = True
    timer.start()
    keep = False
    try:
        out = fn(d, conn, entry)
        with _lock:
            entry["done"] = True  # the watchdog can't kill it from now on
            keep = not entry.get("stopping") and not entry.get("drop")
        return out
    except Exception as e:
        if entry.get("stopping"):
            entry["stopped"].wait(15)  # the KILL's outcome, for the message
            secs = round(time.time() - entry["started"], 1)
            how = (f"killed on the server (thread {entry['tid']})" if entry.get("killed")
                   else f"dropped (KILL failed: {entry.get('killError')})")
            what = f"Timed out after {secs} s" if entry["stopping"] == "timeout" else f"Stopped after {secs} s"
            raise Refused(f"{what}: the statement and its connection were {how}.", status=408,
                          stopped=entry["stopping"]) from e
        keep = not d.is_connection_error(e) and not entry.get("drop")
        raise
    finally:
        timer.cancel()
        with _lock:
            _running.pop(qid, None)
        _release(cfg, d, conn, keep)


# ---- Endpoints ----

def ep_health(body):
    return {"ok": True, "product": PRODUCT, "drivers": sorted(DRIVERS), "pid": os.getpid()}


def ep_status(body):
    now = time.time()
    with _lock:
        running = [{"queryId": q, "connId": e["connId"], "seconds": round(now - e["started"], 1), "sql": e["sql"],
                    "threadId": e["tid"]} for q, e in _running.items() if not q.startswith("internal-")]
        sessions = {k: v for k, v in _open_count.items() if v}
    return {"running": running, "sessions": sessions}


def ep_secret_set(body):
    if not body.get("id"):
        raise Refused("No connection id")
    pw = body.get("password")
    if pw:
        keychain.set(SERVICE, body["id"], pw)
    else:
        keychain.delete(SERVICE, body["id"])
    return {"ok": True}


def ep_secret_delete(body):
    keychain.delete(SERVICE, body.get("id") or "")
    _close_idle(body.get("id"))
    return {"ok": True}


def ep_secret_has(body):
    return {i: keychain.has(SERVICE, i) for i in body.get("ids") or []}


def _timeout(cfg, body):
    t = body.get("timeoutMs") or cfg.get("timeoutMs") or DEFAULT_TIMEOUT_MS
    return max(1000, min(int(t), 3600 * 1000))


def ep_test(body):
    cfg = _effective(body["conn"])
    started = time.time()
    # A test always opens a fresh connection (that's what it tests) and closes it.
    d = _driver(cfg)
    conn = d.connect(cfg, _password(cfg, body), 15)
    try:
        info = d.server_info(conn)
    finally:
        d.close(conn)
    info["ms"] = round((time.time() - started) * 1000)
    return info


def ep_schemas(body):
    cfg = _effective(body["conn"])
    return with_session(cfg, body, lambda d, c, e: d.schemas(c), _timeout(cfg, {}))


def ep_objects(body):
    cfg = _effective(body["conn"])
    return with_session(cfg, body, lambda d, c, e: d.objects(c, body["schema"]), _timeout(cfg, {}))


def ep_table(body):
    cfg = _effective(body["conn"])
    return with_session(cfg, body, lambda d, c, e: d.table(c, body["schema"], body["table"]), _timeout(cfg, {}))


def ep_columns(body):
    cfg = _effective(body["conn"])
    return with_session(cfg, body, lambda d, c, e: d.columns(c, body["schema"], body["table"]), _timeout(cfg, {}))


def ep_query(body):
    cfg = _effective(body["conn"])
    sql = (body.get("sql") or "").strip()
    if not sqltext.kind(sql):
        raise Refused("Nothing to run")
    if sqltext.statement_count(sql) > 1:
        raise Refused("One statement at a time: select the one to run, or put the cursor in it.")
    read = sqltext.is_read_only(sql)
    read_only = cfg.get("readOnly", True)
    if not read and read_only:
        raise Refused(f"This connection is read-only: {sqltext.kind(sql)} isn't allowed. "
                      "Turn off “Read-only” in the connection's settings to change data.", status=403)
    if not read and not body.get("confirmed"):
        raise Refused(f"{sqltext.kind(sql)} changes the database.", status=409, needsConfirm=True,
                      kind=sqltext.kind(sql))
    cap = PROD_MAX_ROWS if cfg.get("env") == "prod" else MAX_ROWS
    limit = max(1, min(int(body.get("limit") or cfg.get("rowLimit") or DEFAULT_ROWS), cap))
    check_plan = (read and cfg.get("checkPlan") and not body.get("planChecked")
                  and sqltext.kind(sql) in ("SELECT", "WITH") and sqltext.may_scan(sql))
    executed, added = sqltext.apply_limit(sql, limit) if read else (sqltext.strip_trailing(sql), False)
    timeout_ms = _timeout(cfg, body)

    def go(d, conn, entry):
        if read:
            d.set_statement_timeout(conn, timeout_ms)
        d.use(conn, body.get("schema"))
        if check_plan:
            warnings, plan = _plan_warnings(d, conn, executed, int(cfg.get("scanWarnRows") or DEFAULT_SCAN_WARN_ROWS))
            if warnings:
                raise Refused("The plan looks expensive.", status=409, needsPlanConfirm=True, warnings=warnings,
                              plan=plan)
        started = time.time()
        result, more = d.run(conn, executed, limit)
        result["elapsedMs"] = round((time.time() - started) * 1000)
        if more:
            # Don't drain what's left: kill the thread on the server and drop the connection.
            entry["drop"] = True
            threading.Thread(target=_kill, args=(entry, "limit"), daemon=True).start()
        result.update(executedSql=executed, limitApplied=added, limit=limit, truncated=more,
                      threadId=entry["tid"], kind=sqltext.kind(sql))
        return result

    return with_session(cfg, body, go, timeout_ms, query_id=body.get("queryId") or secrets.token_hex(8))


def _plan_warnings(d, conn, sql, threshold):
    """EXPLAIN the statement; warnings for full scans (or filesorts/temporary tables) over `threshold` rows."""
    try:
        plan = d.explain(conn, sql)
    except Exception:
        return [], None  # EXPLAIN can't say: don't stand in the way
    warnings = []
    for r in plan["rows"]:
        rows = int(r.get("rows") or 0)
        if rows < threshold:
            continue
        table = r.get("table") or "?"
        extra = r.get("Extra") or ""
        if r.get("type") == "ALL":
            warnings.append(f"Full scan of {table}: ≈{rows:,} rows read, no index used.")
        elif r.get("type") == "index":
            warnings.append(f"Full index scan of {table}: ≈{rows:,} rows.")
        elif "Using filesort" in extra or "Using temporary" in extra:
            warnings.append(f"{table}: ≈{rows:,} rows sorted or grouped in a temporary table ({extra}).")
    return warnings, plan


DRY_RUN_CAP = 200


def ep_dryrun(body):
    cfg = _effective(body["conn"])
    sql = (body.get("sql") or "").strip()
    kind = sqltext.kind(sql)
    if not kind:
        raise Refused("Nothing to run")
    if sqltext.statement_count(sql) > 1:
        raise Refused("One statement at a time: select the one to preview, or put the cursor in it.")
    if cfg.get("readOnly", True):
        raise Refused("This connection is read-only: a dry run executes the statement (then rolls it back), so it "
                      "needs a connection that can write.", status=403)
    if kind in sqltext.IMPLICIT_COMMIT:
        raise Refused(f"{kind} can't be dry-run: MySQL commits it immediately, there's no rollback. To try it, "
                      "copy the table first (CREATE TABLE t_copy LIKE t; INSERT INTO t_copy SELECT * FROM t).")
    info = sqltext.parse_dml(sql)
    if not info:
        raise Refused(f"Only UPDATE, DELETE, INSERT and REPLACE can be dry-run{'' if kind != 'SELECT' else ': a SELECT changes nothing'}.")
    timeout_ms = _timeout(cfg, body)

    def go(d, conn, entry):
        entry["drop"] = True  # never reused: the rollback is final, the session goes
        d.use(conn, body.get("schema"))
        started = time.time()
        try:
            out = d.dry_run(conn, sqltext.strip_trailing(sql), info, DRY_RUN_CAP)
        except d.DryRunRefused as e:
            raise Refused(str(e))
        out.update(elapsedMs=round((time.time() - started) * 1000), cap=DRY_RUN_CAP, rolledBack=True)
        return out

    return with_session(cfg, body, go, timeout_ms, query_id=body.get("queryId") or secrets.token_hex(8))


def ep_processlist(body):
    cfg = _effective(body["conn"])
    with _lock:
        ours = {e["tid"]: q for q, e in _running.items() if e["connId"] == cfg["id"]}
        idle = {d.thread_id(c) for k, pool in _idle.items() if json.loads(k)[0] == cfg["id"] for c, d, _ in pool}

    def go(d, conn, entry):
        out = d.processlist(conn)
        for r in out["threads"]:
            tid = r["id"]
            r["ours"] = tid in ours or tid in idle or tid == entry["tid"]
            r["queryId"] = ours.get(tid) if not str(ours.get(tid, "")).startswith("internal-") else None
            r["self"] = tid == entry["tid"]
        return out

    return with_session(cfg, body, go, _timeout(cfg, {}))


def ep_kill(body):
    cfg = _effective(body["conn"])
    tid = int(body["threadId"])
    # One of ours: stop it through its entry, so the page that runs it learns why.
    with _lock:
        entry = next((e for e in _running.values() if e["connId"] == cfg["id"] and e["tid"] == tid), None)
    if entry and not body.get("queryOnly"):
        _kill(entry, "cancel")
        return {"ok": True, "killed": entry.get("killed", False), "error": entry.get("killError")}
    d = _driver(cfg)
    d.kill(cfg, _password(cfg, {}), tid, query_only=bool(body.get("queryOnly")))
    return {"ok": True, "killed": True}


def ep_cancel(body):
    with _lock:
        entry = _running.get(body.get("queryId") or "")
    if not entry:
        return {"ok": False, "message": "Not running"}
    _kill(entry, "cancel")
    return {"ok": True, "killed": entry.get("killed", False), "error": entry.get("killError")}


def _close_idle(cid):
    closing = []
    with _lock:
        for key, pool in _idle.items():
            if json.loads(key)[0] == cid:
                closing += pool
                pool.clear()
    for conn, d, _ in closing:
        d.close(conn)
        _count(cid, -1)
    return len(closing)


def ep_disconnect(body):
    cid = body.get("id")
    with _lock:
        busy = [e for e in _running.values() if e["connId"] == cid]
    for e in busy:
        _kill(e, "cancel")
    return {"closed": _close_idle(cid), "killed": len(busy)}


ROUTES = {
    "/health": ep_health, "/status": ep_status, "/secret/set": ep_secret_set, "/secret/delete": ep_secret_delete,
    "/secret/has": ep_secret_has, "/test": ep_test, "/schemas": ep_schemas, "/objects": ep_objects,
    "/table": ep_table, "/columns": ep_columns, "/query": ep_query, "/cancel": ep_cancel,
    "/disconnect": ep_disconnect, "/processlist": ep_processlist, "/kill": ep_kill,
    "/dryrun": ep_dryrun,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DbViewer"

    def log_message(self, *args):  # no request log: it would carry schema and table names
        pass

    def _send(self, status, obj):
        data = json.dumps(obj, default=str, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, body_allowed):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):  # DNS rebinding
            return self._send(403, {"error": "Bad host"})
        if not hmac.compare_digest(self.headers.get("X-Db-Viewer-Token") or "", TOKEN):
            return self._send(401, {"error": "Bad token"})
        fn = ROUTES.get(self.path.split("?")[0])
        if not fn:
            return self._send(404, {"error": "Not found"})
        body = {}
        if body_allowed:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                return self._send(413, {"error": "Request too large"})
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                return self._send(400, {"error": "Bad JSON"})
        try:
            self._send(200, fn(body))
        except Refused as e:
            self._send(e.status, {"error": str(e), **e.extra})
        except keychain.KeychainError as e:
            self._send(500, {"error": str(e)})
        except Exception as e:
            d = DRIVERS.get(((body.get("conn") or {}).get("driver")) or "mysql")
            msg = d.error_message(e) if d else str(e)
            if not d or not getattr(e, "args", None):
                traceback.print_exc()
            if d and d.is_timeout(e):
                return self._send(408, {"error": msg, "stopped": "timeout"})
            self._send(502, {"error": msg})

    def do_GET(self):
        self._handle(False)

    def do_POST(self):
        self._handle(True)


def main():
    threading.Thread(target=_reaper, daemon=True).start()
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print(f"DBVIEWER_ERROR port {PORT} unavailable: {e}", flush=True)
        sys.exit(1)
    srv.daemon_threads = True
    print(f"DBVIEWER_READY port={PORT} token={TOKEN}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
