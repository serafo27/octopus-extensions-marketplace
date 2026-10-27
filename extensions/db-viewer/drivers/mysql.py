"""MySQL (and MariaDB) through the vendored PyMySQL (pure Python, vendor/pymysql).

A driver gives the server what it needs from a kind of database: connect, run a statement with a row cap, kill a
running one from another connection, and read the catalog (schemas, objects, a table's details). Another database
(PostgreSQL, …) is another module with the same functions, listed in drivers/__init__.py.
"""
import datetime
import decimal
import ssl

import pymysql
from pymysql.constants import FIELD_TYPE

NAME = "mysql"
DEFAULT_PORT = 3306

_TYPE_NAMES = {v: k for k, v in vars(FIELD_TYPE).items() if k.isupper()}
MAX_CELL = 20000  # characters of one value sent to the page


def _ssl_context(cfg):
    mode = (cfg.get("tls") or "preferred").lower()
    if mode == "disabled":
        return None, True
    if mode == "verify":
        ctx = ssl.create_default_context(cafile=cfg.get("tlsCa") or None)
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
        return ctx, False
    if mode == "required":
        ctx = ssl.create_default_context(cafile=cfg.get("tlsCa") or None)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
        return ctx, False
    return None, False  # preferred: TLS when the server offers it (PyMySQL's default)


def connect(cfg, password, timeout_s):
    ctx, disabled = _ssl_context(cfg)
    conn = pymysql.connect(
        host=cfg["host"],
        port=int(cfg.get("port") or DEFAULT_PORT),
        user=cfg["user"],
        password=password or "",
        database=cfg.get("database") or None,
        charset="utf8mb4",
        connect_timeout=10,
        # A backstop: the watchdog kills a statement at its timeout, this only frees us if the server vanishes.
        read_timeout=timeout_s + 15,
        write_timeout=30,
        autocommit=True,
        local_infile=False,  # never let a server read files from this Mac
        client_flag=0,  # no MULTI_STATEMENTS: one statement per call
        ssl=ctx,
        ssl_disabled=disabled,
        program_name="octopus-db-viewer",
        defer_connect=False,
    )
    try:
        if cfg.get("readOnly", True):
            # The server refuses writes in this session, whatever the statement looks like.
            conn.query("SET SESSION TRANSACTION READ ONLY")
    except Exception:
        conn.close()
        raise
    return conn


def thread_id(conn):
    return conn.thread_id()


def kill(cfg, password, tid, query_only=False):
    """Kills the server thread `tid` (the statement and its connection, or only its statement) from a short-lived
    connection of its own. KILL isn't a write: a read-only session can run it."""
    conn = connect({**cfg, "database": None}, password, 10)
    try:
        conn.query(f"KILL {'QUERY ' if query_only else ''}{int(tid)}")
    finally:
        conn.close()


def explain(conn, sql):
    """The traditional EXPLAIN of a statement: {columns, rows: [dict]}."""
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute("EXPLAIN " + sql)
        rows = [{k: value(v) for k, v in r.items()} for r in cur.fetchall()]
        cols = [d[0] for d in cur.description]
    return {"columns": cols, "rows": rows}


def processlist(conn):
    """The server's threads (all of them with the PROCESS privilege, else this user's), longest running first."""
    rows = _rows(conn, """
        SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS seconds,
               STATE AS state, LEFT(INFO, 4000) AS info
        FROM information_schema.PROCESSLIST ORDER BY COMMAND = 'Sleep', TIME DESC LIMIT 1000""")
    with conn.cursor() as cur:
        cur.execute("SELECT CURRENT_USER()")
        me = cur.fetchone()[0]
    return {"threads": rows, "currentUser": me}


def server_info(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT VERSION(), CURRENT_USER(), @@hostname, CONNECTION_ID()")
        version, user, host, cid = cur.fetchone()
    cipher = None
    try:
        sock = conn._sock
        if isinstance(sock, ssl.SSLSocket):
            cipher = f"{sock.version()} {sock.cipher()[0]}"
    except Exception:
        pass
    return {"version": version, "user": user, "serverHost": host, "threadId": cid, "tls": cipher}


def set_statement_timeout(conn, timeout_ms):
    """Asks the server itself to stop long SELECTs (MySQL max_execution_time, MariaDB max_statement_time)."""
    for stmt in (f"SET SESSION max_execution_time = {int(timeout_ms)}",
                 f"SET SESSION max_statement_time = {max(1, int(timeout_ms) // 1000)}"):
        try:
            conn.query(stmt)
            return
        except pymysql.err.MySQLError:
            continue


def use(conn, schema):
    if schema:
        conn.select_db(schema)


def value(v, binary=False):
    """A cell as JSON: text, number, bool, None; long or binary values (bytes that aren't UTF-8) cut, with a marker."""
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v if -(2 ** 53) < v < 2 ** 53 else str(v)
    if isinstance(v, float):
        return v if v == v and v not in (float("inf"), float("-inf")) else str(v)
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
        return v.isoformat(sep=" ") if isinstance(v, datetime.datetime) else v.isoformat()
    if isinstance(v, datetime.timedelta):
        total = int(v.total_seconds())
        sign = "-" if total < 0 else ""
        total = abs(total)
        return f"{sign}{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"
    if isinstance(v, (bytes, bytearray)):
        if not binary:
            try:
                return _cut(v.decode("utf-8"))
            except UnicodeDecodeError:
                pass
        hexed = v[: MAX_CELL // 2].hex()
        return {"$binary": f"0x{hexed}", "bytes": len(v), "cut": len(v) > MAX_CELL // 2}
    return _cut(str(v))


def _cut(s):
    return s if len(s) <= MAX_CELL else {"$text": s[:MAX_CELL], "chars": len(s), "cut": True}


def run(conn, sql, max_rows):
    """Runs one statement and reads at most max_rows rows (unbuffered: the server streams, we stop reading).
    Returns (result, more): `more` is True when the server had more rows than max_rows (the caller must then
    drop the connection rather than drain the rest)."""
    cur = conn.cursor(pymysql.cursors.SSCursor)
    cur.execute(sql)
    if cur.description is None:
        result = {"columns": [], "rows": [], "affectedRows": cur.rowcount, "insertId": cur.lastrowid,
                  "warnings": conn.warning_count if hasattr(conn, "warning_count") else 0}
        cur.close()
        return result, False
    cols = [{"name": d[0], "type": _TYPE_NAMES.get(d[1], str(d[1])), "nullable": bool(d[6])}
            for d in cur.description]
    rows = cur.fetchmany(max_rows + 1)
    more = len(rows) > max_rows
    rows = rows[:max_rows]
    out = [[value(v) for v in r] for r in rows]
    if not more:
        cur.close()
    return {"columns": cols, "rows": out}, more


def force_close(conn):
    try:
        conn._force_close()
    except Exception:
        pass


def close(conn):
    try:
        conn.close()
    except Exception:
        force_close(conn)


def ping(conn):
    conn.ping(reconnect=False)


# ---- Dry run ----

class DryRunRefused(Exception):
    """The statement can't be dry-run safely (the message says why)."""


_TABLES_IN = None


def _tables_in(sql):
    """(schema|None, table) of every table a statement names after FROM / JOIN / UPDATE / INTO / USING."""
    import re
    global _TABLES_IN
    if _TABLES_IN is None:
        ident = r"(`(?:[^`]|``)+`|[A-Za-z_$][\w$]*)"
        _TABLES_IN = re.compile(rf"\b(?:FROM|JOIN|UPDATE|INTO|USING)\s+{ident}(?:\s*\.\s*{ident})?", re.I)
    unq = lambda n: n[1:-1].replace("``", "`") if n and n.startswith("`") else n
    out = []
    for m in _TABLES_IN.finditer(sql):
        a, b = m.group(1), m.group(2)
        out.append((unq(a), unq(b)) if b else (None, unq(a)))
    return out


def _engines(conn, tables):
    """{(schema, table): (engine, type)} for the tables that exist (names that are aliases don't)."""
    out = {}
    with conn.cursor() as cur:
        for schema, table in set(tables):
            cur.execute("SELECT TABLE_SCHEMA, ENGINE, TABLE_TYPE FROM information_schema.TABLES "
                        "WHERE TABLE_SCHEMA = COALESCE(%s, DATABASE()) AND TABLE_NAME = %s", (schema, table))
            row = cur.fetchone()
            if row:
                out[(row[0], table)] = (row[1], row[2])
    return out


def _key(conn, schema, table):
    """The primary key's columns, and whether it's a single AUTO_INCREMENT column."""
    with conn.cursor() as cur:
        cur.execute("""SELECT k.COLUMN_NAME, c.EXTRA FROM information_schema.KEY_COLUMN_USAGE k
                       JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = k.TABLE_SCHEMA
                        AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
                       WHERE k.TABLE_SCHEMA = COALESCE(%s, DATABASE()) AND k.TABLE_NAME = %s
                         AND k.CONSTRAINT_NAME = 'PRIMARY' ORDER BY k.ORDINAL_POSITION""", (schema, table))
        rows = cur.fetchall()
    cols = [r[0] for r in rows]
    return cols, len(rows) == 1 and "auto_increment" in (rows[0][1] or "").lower()


def _select(conn, sql, args=None, cap=None):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        rows = cur.fetchmany(cap) if cap else cur.fetchall()
        cols = [{"name": d[0], "type": _TYPE_NAMES.get(d[1], str(d[1]))} for d in cur.description]
    return cols, [list(r) for r in rows]


def dry_run(conn, sql, info, cap):
    """Runs a data-changing statement inside a transaction, reads what it changed, and rolls it back.
    `info` is sqltext.parse_dml(sql). Returns the preview: {mode, table, columns, rows, matched, affected, shown,
    notes}. Rows are op ("~" changed, "=" unchanged, "−" deleted, "+" inserted) then cells; a changed cell is
    {"$diff": [before, after]}. The caller drops the connection afterwards, whatever happens."""
    notes = []
    targets = [(info["schema"], info["table"])] if info["table"] else _tables_in(sql)
    found = _engines(conn, targets)
    if info["table"] and not found:
        raise DryRunRefused(f"No table {info['table']} here.")
    for (schema, table), (engine, kind) in found.items():
        if kind == "VIEW":
            raise DryRunRefused(f"{table} is a view: a dry run works on tables (it needs their engine's rollback).")
        if (engine or "").lower() != "innodb":
            raise DryRunRefused(f"{schema}.{table} uses {engine}, which can't roll back: a dry run would really "
                                f"change it. Only InnoDB tables can be dry-run.")
    try:
        conn.query("SET SESSION innodb_lock_wait_timeout = 5")  # don't queue for long behind others' locks
    except pymysql.err.MySQLError:
        pass
    kind = info["kind"]
    qtable = (_ident(info["schema"]) + "." if info["schema"] else "") + _ident(info["table"]) if info["table"] else None
    pk, auto = _key(conn, info["schema"], info["table"]) if info["table"] else ([], False)
    before_cols, before, matched = None, [], None
    single = info["table"] and not info["multi"] and kind in ("UPDATE", "DELETE")
    conn.begin()
    try:
        if single:
            tail = (f" WHERE {info['where']}" if info["where"] else "") + \
                   (f" ORDER BY {info['order']}" if info["order"] else "")
            with conn.cursor() as cur:
                cur.execute(f"SELECT COUNT(*) FROM (SELECT 1 FROM {info['ref']}{tail}"
                            f"{' LIMIT ' + info['limit'] if info['limit'] else ''}) AS m")
                matched = cur.fetchone()[0]
            before_cols, before = _select(conn, f"SELECT * FROM {info['ref']}{tail} LIMIT "
                                                + (f"{min(cap, int(info['limit']))}" if (info["limit"] or "").isdigit() else str(cap)))
        with conn.cursor() as cur:
            cur.execute(sql)
            affected, last_id = cur.rowcount, cur.lastrowid
            warnings = conn.warning_count if hasattr(conn, "warning_count") else 0
        after_cols, after = None, []
        if single and kind == "UPDATE" and pk and before:
            names = [c["name"] for c in before_cols]
            ki = [names.index(k) for k in pk]
            keys = [tuple(r[i] for i in ki) for r in before]
            cond = (f"{_ident(pk[0])} IN ({', '.join(['%s'] * len(keys))})" if len(pk) == 1 else
                    f"({', '.join(map(_ident, pk))}) IN ({', '.join(['(' + ', '.join(['%s'] * len(pk)) + ')'] * len(keys))})")
            args = [k[0] for k in keys] if len(pk) == 1 else [v for k in keys for v in k]
            after_cols, after = _select(conn, f"SELECT * FROM {qtable} WHERE {cond}", args)
        elif kind in ("INSERT", "REPLACE") and auto and last_id and affected > 0:
            after_cols, after = _select(conn, f"SELECT * FROM {qtable} WHERE {_ident(pk[0])} >= %s "
                                              f"ORDER BY {_ident(pk[0])} LIMIT %s", (last_id, min(affected, cap)))
    finally:
        conn.rollback()

    out = {"mode": "count", "table": info["table"], "kind": kind, "affected": affected, "matched": matched,
           "warnings": warnings, "columns": [], "rows": [], "notes": notes}
    if single and kind == "UPDATE":
        out["unchanged"] = (matched or 0) - affected
        if not pk:
            notes.append(f"{info['table']} has no primary key: the changed values can't be matched, only counted.")
        elif before:
            names = [c["name"] for c in before_cols]
            ki = [names.index(k) for k in pk]
            by_key = {tuple(r[i] for i in ki): r for r in after}
            changed_cols = set()
            pairs = []
            for r in before:
                a = by_key.get(tuple(r[i] for i in ki))
                diff = {j for j in range(len(r)) if a is not None and r[j] != a[j]}
                changed_cols |= diff
                pairs.append((r, a, diff))
            show = ki + [j for j in range(len(names)) if j in changed_cols and j not in ki]
            out["mode"] = "update"
            out["columns"] = [{"name": "", "type": "op"}] + [before_cols[j] for j in show]
            for r, a, diff in pairs:
                op = "~" if diff else ("=" if a is not None else "?")
                out["rows"].append([{"$op": op}] + [
                    {"$diff": [value(r[j]), value(a[j])]} if j in diff else value(r[j]) for j in show])
            if any(names[j] in pk for j in changed_cols):
                notes.append("The statement changes the primary key: rows are matched by their old key.")
    elif single and kind == "DELETE" and before:
        out["mode"] = "delete"
        out["columns"] = [{"name": "", "type": "op"}] + before_cols
        out["rows"] = [[{"$op": "−"}] + [value(v) for v in r] for r in before]
    elif after_cols is not None and kind in ("INSERT", "REPLACE"):
        out["mode"] = "insert"
        out["columns"] = [{"name": "", "type": "op"}] + after_cols
        out["rows"] = [[{"$op": "+"}] + [value(v) for v in r] for r in after]
        notes.append("The AUTO_INCREMENT counter isn't rolled back by MySQL: real inserts will get later ids.")
        if kind == "REPLACE":
            notes.append("REPLACE counts a replaced row twice (deleted + inserted).")
    elif kind in ("INSERT", "REPLACE"):
        notes.append("The new rows can't be shown: the table has no single AUTO_INCREMENT key to find them by.")
    elif info["multi"]:
        notes.append("Several tables are involved: only the number of changed rows can be previewed.")
    out["shown"] = len(out["rows"])
    notes.append("Triggers and ON DELETE/UPDATE CASCADE ran too and were rolled back; their effects aren't listed.")
    return out


# ---- Catalog ----

def _rows(conn, sql, args=None):
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        cur.execute(sql, args)
        return [{k: value(v, False) for k, v in r.items()} for r in cur.fetchall()]


def schemas(conn):
    rows = _rows(conn, """
        SELECT s.SCHEMA_NAME AS name, s.DEFAULT_CHARACTER_SET_NAME AS charset, s.DEFAULT_COLLATION_NAME AS collation,
               (SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) AS tables
        FROM information_schema.SCHEMATA s ORDER BY s.SCHEMA_NAME""")
    system = {"information_schema", "mysql", "performance_schema", "sys"}
    for r in rows:
        r["system"] = r["name"] in system
    return rows


def objects(conn, schema):
    tables = _rows(conn, """
        SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS `rows`,
               DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes, TABLE_COMMENT AS comment
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s ORDER BY TABLE_NAME""", (schema,))
    routines = _rows(conn, """
        SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns, ROUTINE_COMMENT AS comment
        FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = %s ORDER BY ROUTINE_NAME""", (schema,))
    return {
        "tables": [t for t in tables if t["type"] != "VIEW"],
        "views": [t for t in tables if t["type"] == "VIEW"],
        "routines": routines,
    }


def columns(conn, schema, table):
    return _rows(conn, """
        SELECT COLUMN_NAME AS name, ORDINAL_POSITION AS position, COLUMN_TYPE AS type, DATA_TYPE AS dataType,
               IS_NULLABLE = 'YES' AS nullable, COLUMN_DEFAULT AS `default`, COLUMN_KEY AS `key`, EXTRA AS extra,
               CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, COLUMN_COMMENT AS comment,
               GENERATION_EXPRESSION AS generation
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
        ORDER BY ORDINAL_POSITION""", (schema, table))


def table(conn, schema, name):
    info = _rows(conn, """
        SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, ROW_FORMAT AS rowFormat,
               TABLE_ROWS AS `rows`, AVG_ROW_LENGTH AS avgRowBytes, DATA_LENGTH AS dataBytes,
               INDEX_LENGTH AS indexBytes, DATA_FREE AS freeBytes, AUTO_INCREMENT AS autoIncrement,
               CREATE_TIME AS created, UPDATE_TIME AS updated, TABLE_COLLATION AS collation,
               CREATE_OPTIONS AS options, TABLE_COMMENT AS comment
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s""", (schema, name))
    if not info:
        raise LookupError(f"No table {schema}.{name}")
    indexes = {}
    for r in _rows(conn, """
            SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col,
                   SUB_PART AS subPart, INDEX_TYPE AS type, CARDINALITY AS cardinality, INDEX_COMMENT AS comment,
                   EXPRESSION AS expression
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
            ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX""" if _has_expression(conn) else """
            SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col,
                   SUB_PART AS subPart, INDEX_TYPE AS type, CARDINALITY AS cardinality, INDEX_COMMENT AS comment,
                   NULL AS expression
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
            ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX""", (schema, name)):
        ix = indexes.setdefault(r["name"], {"name": r["name"], "unique": not int(r["nonUnique"]), "type": r["type"],
                                            "columns": [], "cardinality": r["cardinality"], "comment": r["comment"]})
        col = r["col"] or f"({r['expression']})"
        ix["columns"].append(f"{col}({r['subPart']})" if r["subPart"] else col)
    fks = {}
    for r in _rows(conn, """
            SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refSchema,
                   k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol,
                   r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
            FROM information_schema.KEY_COLUMN_USAGE k
            JOIN information_schema.REFERENTIAL_CONSTRAINTS r
              ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
             AND r.TABLE_NAME = k.TABLE_NAME
            WHERE k.TABLE_SCHEMA = %s AND k.TABLE_NAME = %s AND k.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION""", (schema, name)):
        fk = fks.setdefault(r["name"], {"name": r["name"], "columns": [], "refSchema": r["refSchema"],
                                        "refTable": r["refTable"], "refColumns": [], "onUpdate": r["onUpdate"],
                                        "onDelete": r["onDelete"]})
        fk["columns"].append(r["col"])
        fk["refColumns"].append(r["refCol"])
    referenced_by = _rows(conn, """
        SELECT k.TABLE_SCHEMA AS `schema`, k.TABLE_NAME AS `table`, k.CONSTRAINT_NAME AS name,
               GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS columns,
               GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION) AS refColumns
        FROM information_schema.KEY_COLUMN_USAGE k
        WHERE k.REFERENCED_TABLE_SCHEMA = %s AND k.REFERENCED_TABLE_NAME = %s
        GROUP BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME ORDER BY k.TABLE_NAME""", (schema, name))
    triggers = _rows(conn, """
        SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
               ACTION_STATEMENT AS statement
        FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = %s AND EVENT_OBJECT_TABLE = %s
        ORDER BY TRIGGER_NAME""", (schema, name))
    is_view = info[0]["type"] == "VIEW"
    ddl = None
    try:
        q = _ident(schema) + "." + _ident(name)
        with conn.cursor() as cur:
            cur.execute(f"SHOW CREATE {'VIEW' if is_view else 'TABLE'} {q}")
            row = cur.fetchone()
            ddl = value(row[1], False) if row else None
    except pymysql.err.MySQLError as e:
        ddl = f"-- SHOW CREATE failed: {e.args[-1] if e.args else e}"
    return {
        "info": info[0],
        "columns": columns(conn, schema, name),
        "indexes": list(indexes.values()),
        "foreignKeys": list(fks.values()),
        "referencedBy": referenced_by,
        "triggers": triggers,
        "ddl": ddl,
    }


_expression_cache = {}


def _has_expression(conn):
    """MySQL 8.0.13+ has STATISTICS.EXPRESSION (functional indexes); older servers and MariaDB don't."""
    key = conn.get_server_info()
    if key not in _expression_cache:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT EXPRESSION FROM information_schema.STATISTICS LIMIT 0")
            _expression_cache[key] = True
        except pymysql.err.MySQLError:
            _expression_cache[key] = False
    return _expression_cache[key]


def _ident(name):
    return "`" + str(name).replace("`", "``") + "`"


def quote_ident(name):
    return _ident(name)


def error_message(e):
    if isinstance(e, pymysql.err.MySQLError) and e.args and e.args[0] in (3024, 1969):
        return "Timed out: the server stopped the statement at the connection's time limit (max_execution_time)."
    if isinstance(e, pymysql.err.MySQLError) and len(e.args) >= 2:
        return f"{e.args[1]} (MySQL error {e.args[0]})"
    return str(e) or e.__class__.__name__


def is_timeout(e):
    return isinstance(e, pymysql.err.MySQLError) and bool(e.args) and e.args[0] in (3024, 1969)


def is_connection_error(e):
    return isinstance(e, (pymysql.err.OperationalError, pymysql.err.InterfaceError, OSError)) and not (
        isinstance(e, pymysql.err.OperationalError) and e.args and e.args[0] in (1044, 1045, 1049, 1142, 1227))
