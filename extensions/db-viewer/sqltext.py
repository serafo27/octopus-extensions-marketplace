"""Reading SQL text without a parser: tokens at the top level (outside strings, comments and parentheses), enough to
tell what a statement does, whether it already has a LIMIT, and where to add one."""
import re

_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")

# Statements that only read. Anything else is a write (or DDL, or a session change) and needs a writable connection.
READ_KINDS = {"SELECT", "WITH", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "TABLE", "VALUES", "HELP"}
# Read statements that return rows we can bound with LIMIT.
LIMITABLE = {"SELECT", "WITH", "TABLE", "VALUES"}


def top_level_words(sql):
    """Yields (WORD, start, end) for each keyword/identifier outside quotes, comments and parentheses, plus
    (";", i, i+1) for a top-level semicolon."""
    i, n, depth = 0, len(sql), 0
    while i < n:
        c = sql[i]
        if c in "'\"`":
            j = i + 1
            while j < n:
                if sql[j] == "\\" and c != "`":
                    j += 2
                    continue
                if sql[j] == c:
                    if j + 1 < n and sql[j + 1] == c:  # doubled quote
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
        elif c == "#" or (c == "-" and sql.startswith("--", i) and (i + 2 >= n or sql[i + 2] in " \t\r\n")):
            j = sql.find("\n", i)
            i = n if j < 0 else j + 1
        elif c == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif c == "(":
            depth += 1
            i += 1
        elif c == ")":
            depth = max(0, depth - 1)
            i += 1
        elif c == ";" and depth == 0:
            yield ";", i, i + 1
            i += 1
        else:
            m = _WORD.match(sql, i)
            if m:
                if depth == 0:
                    yield m.group(0).upper(), m.start(), m.end()
                i = m.end()
            else:
                i += 1


def strip_trailing(sql):
    """The statement without trailing semicolons, whitespace and comments."""
    keep, i, n = 0, 0, len(sql)
    while i < n:
        c = sql[i]
        if c in "'\"`":
            j = i + 1
            while j < n and sql[j] != c:
                j += 2 if sql[j] == "\\" and c != "`" else 1
            i = keep = min(n, j + 1)
        elif c == "#" or (c == "-" and sql.startswith("--", i)):
            j = sql.find("\n", i)
            i = n if j < 0 else j + 1
        elif c == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            if not c.isspace() and c != ";":
                keep = i + 1
            i += 1
    return sql[:keep].strip()


def statement_count(sql):
    count, has_content = 0, False
    for w, _, _ in top_level_words(sql):
        if w == ";":
            if has_content:
                count += 1
            has_content = False
        else:
            has_content = True
    return count + (1 if has_content else 0)


def kind(sql):
    """The first keyword of the statement (SELECT, UPDATE, …), or "" when there's none."""
    for w, _, _ in top_level_words(sql):
        if w != ";":
            return w
    return ""


def is_read_only(sql):
    k = kind(sql)
    if k not in READ_KINDS:
        return False
    words = [w for w, _, _ in top_level_words(sql)]
    # WITH … UPDATE/DELETE is a write in MySQL 8; SELECT … INTO OUTFILE writes files; FOR UPDATE takes locks.
    for bad in ("INSERT", "UPDATE", "DELETE", "REPLACE", "INTO", "OUTFILE", "DUMPFILE"):
        if bad in words and not (bad == "UPDATE" and _after(words, "FOR", "UPDATE")):
            return False
    if _after(words, "FOR", "UPDATE") or _after(words, "FOR", "SHARE") or _after(words, "LOCK", "IN"):
        return False
    if k == "EXPLAIN" and "ANALYZE" in words:  # EXPLAIN ANALYZE runs the statement
        return len(words) > 2 and words[2] in LIMITABLE
    return True


def _after(words, a, b):
    return any(words[i] == a and words[i + 1] == b for i in range(len(words) - 1))


def apply_limit(sql, limit):
    """Adds `LIMIT <limit>` to a row-returning statement that has no top-level LIMIT. Returns (sql, added)."""
    sql = strip_trailing(sql)
    if kind(sql) not in LIMITABLE or not is_read_only(sql):
        return sql, False
    words = [w for w, _, _ in top_level_words(sql)]
    if "LIMIT" in words:
        return sql, False
    # A LIMIT can't go after these clauses: leave the statement as it is, the row cap still applies while fetching.
    if _after(words, "FOR", "UPDATE") or _after(words, "FOR", "SHARE") or _after(words, "LOCK", "IN") or "INTO" in words:
        return sql, False
    return f"{sql}\nLIMIT {int(limit)}", True


def may_scan(sql):
    """Whether a full scan would really read the whole table: a bare `SELECT … FROM t LIMIT n` stops after n rows,
    while a WHERE, JOIN, GROUP BY, ORDER BY, DISTINCT or an aggregate can read everything before returning a row."""
    words = {w for w, _, _ in top_level_words(sql)}
    return bool(words & {"WHERE", "JOIN", "GROUP", "ORDER", "DISTINCT", "HAVING", "UNION", "COUNT", "SUM", "AVG",
                         "MIN", "MAX"})


# ---- Dry run: what a data-changing statement targets ----

DRY_RUN_KINDS = {"UPDATE", "DELETE", "INSERT", "REPLACE"}
# Statements MySQL commits by itself (DDL and the like): a transaction can't take them back.
IMPLICIT_COMMIT = {"ALTER", "CREATE", "DROP", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "LOCK", "UNLOCK", "LOAD",
                   "OPTIMIZE", "REPAIR", "ANALYZE", "FLUSH", "INSTALL", "UNINSTALL", "SET", "START", "BEGIN",
                   "COMMIT", "ROLLBACK", "CALL", "DO", "HANDLER", "IMPORT", "CACHE", "RESET", "PURGE", "CHANGE"}
_MODIFIERS = {"LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "QUICK", "IGNORE"}
_IDENT = r"(?:`(?:[^`]|``)+`|[A-Za-z_$][\w$]*)"
_TABLE_REF = re.compile(rf"^\s*({_IDENT})(?:\s*\.\s*({_IDENT}))?(?:\s+(?:AS\s+)?({_IDENT}))?\s*$", re.I)


def _unquote(name):
    return name[1:-1].replace("``", "`") if name and name.startswith("`") else name


def _table_ref(text):
    """`db`.`t` [AS] alias → (schema|None, table, alias|None), or None when it isn't a single table."""
    m = _TABLE_REF.match(text)
    if not m:
        return None
    a, b, alias = m.group(1), m.group(2), m.group(3)
    schema, table = (a, b) if b else (None, a)
    if alias and alias.upper() in {"SET", "WHERE", "ORDER", "LIMIT", "PARTITION"}:
        return None
    return _unquote(schema), _unquote(table), _unquote(alias)


def parse_dml(sql):
    """What an UPDATE / DELETE / INSERT / REPLACE changes, enough to preview it:
    {kind, schema, table, ref (the table as written, alias included), where, order, limit, multi}.
    `multi` (several tables, JOINs, USING) means rows can only be counted, not shown."""
    sql = strip_trailing(sql)
    words = [(w, s, e) for w, s, e in top_level_words(sql) if w != ";"]
    if not words:
        return None
    kind = words[0][0]
    if kind not in DRY_RUN_KINDS:
        return None
    pos = {}
    for w, s, e in words:
        pos.setdefault(w, (s, e))
    out = {"kind": kind, "schema": None, "table": None, "ref": None, "where": None, "order": None, "limit": None,
           "multi": False}
    i = 1
    while i < len(words) and words[i][0] in _MODIFIERS:
        i += 1
    if kind == "UPDATE":
        if "SET" not in pos:
            return None
        ref_text = sql[words[i - 1][2]:pos["SET"][0]]
    elif kind == "DELETE":
        if i >= len(words) or words[i][0] != "FROM" or "USING" in pos:
            out["multi"] = True
            return out
        ends = [pos[w][0] for w in ("WHERE", "ORDER", "LIMIT", "PARTITION") if w in pos and pos[w][0] > words[i][2]]
        ref_text = sql[words[i][2]:min(ends) if ends else len(sql)]
    else:  # INSERT / REPLACE [INTO] t [(cols)] VALUES | SELECT | SET
        if i < len(words) and words[i][0] == "INTO":
            i += 1
        m = re.match(rf"\s*({_IDENT})(?:\s*\.\s*({_IDENT}))?", sql[words[i - 1][2]:])
        if not m:
            return None
        a, b = m.group(1), m.group(2)
        out["schema"], out["table"] = (_unquote(a), _unquote(b)) if b else (None, _unquote(a))
        return out
    if "JOIN" in pos or "," in re.sub(r"`(?:[^`]|``)*`", "", ref_text):
        out["multi"] = True
        return out
    ref = _table_ref(ref_text)
    if not ref:
        out["multi"] = True
        return out
    out["schema"], out["table"], alias = ref
    out["ref"] = ref_text.strip()

    def clause(word, stops):
        if word not in pos:
            return None
        start = pos[word][1]
        ends = [pos[w][0] for w in stops if w in pos and pos[w][0] > start]
        return sql[start:min(ends) if ends else len(sql)].strip()

    out["where"] = clause("WHERE", ("ORDER", "LIMIT"))
    order = clause("ORDER", ("LIMIT",))
    out["order"] = re.sub(r"^BY\b", "", order, flags=re.I).strip() if order else None
    out["limit"] = clause("LIMIT", ())
    return out
