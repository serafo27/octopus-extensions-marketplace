"""Connections found in other apps of this Mac (MySQL Workbench, IntelliJ and the other JetBrains IDEs), for the
page's "Import from other apps" preview.

Read-only, and never a password: Workbench and JetBrains keep those in their own Keychain items, which this helper
doesn't touch. Their files aren't a public format: an entry or a file that doesn't read as expected is skipped
(with why), never the whole scan.
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qs, unquote

HOME = Path.home()
SUPPORT = HOME / "Library" / "Application Support"
WORKBENCH = SUPPORT / "MySQL" / "Workbench" / "connections.xml"
JETBRAINS = SUPPORT / "JetBrains"

# Workbench's useSSL: 0 no, 1 if available, 2 require, 3 require and verify CA, 4 also verify identity.
WB_TLS = {"0": "disabled", "1": "preferred", "2": "required", "3": "verify", "4": "verify"}
WB_DRIVERS = {
    "com.mysql.rdbms.mysql.driver.native": None,
    "com.mysql.rdbms.mysql.driver.native_socket": "connects through a local socket",
    "com.mysql.rdbms.mysql.driver.native_sshtunnel": "goes through an SSH tunnel",
}
# Connector/J's sslMode, and MariaDB's.
JDBC_TLS = {"disabled": "disabled", "preferred": "preferred", "required": "required", "verify_ca": "verify",
            "verify_identity": "verify", "disable": "disabled", "trust": "required", "verify-ca": "verify",
            "verify-full": "verify"}
JDBC_URL = re.compile(r"^jdbc:(mysql|mariadb)(?::[a-z]+)?://([^/?]*)(?:/([^?]*))?(?:\?(.*))?$", re.I)


def _entry(source, name, host, port, user, database, tls="preferred", tlsCa=""):
    return {"source": source, "name": (name or "").strip(), "host": (host or "").strip(), "port": int(port or 3306),
            "user": (user or "").strip(), "database": (database or "").strip(), "tls": tls, "tlsCa": tlsCa or ""}


def _skip(source, name, why):
    return {"source": source, "name": name or "(no name)", "reason": why}


def workbench(found, skipped, sources):
    if not WORKBENCH.is_file():
        return
    src = {"app": "MySQL Workbench", "path": str(WORKBENCH), "count": 0}
    sources.append(src)
    try:
        root = ET.parse(WORKBENCH).getroot()
    except (ET.ParseError, OSError) as e:
        src["error"] = f"Unreadable: {e}"
        return
    for c in root.iter("value"):
        if c.get("struct-name") != "db.mgmt.Connection":
            continue
        name = (c.findtext("value[@key='name']") or "").strip()
        try:
            driver = (c.findtext("link[@key='driver']") or "").strip()
            if driver not in WB_DRIVERS:
                skipped.append(_skip("MySQL Workbench", name, f"unknown driver {driver or '(none)'}"))
                continue
            if WB_DRIVERS[driver]:
                skipped.append(_skip("MySQL Workbench", name, WB_DRIVERS[driver]))
                continue
            p = {v.get("key"): (v.text or "") for v in c.findall("value[@key='parameterValues']/value")}
            if not p.get("hostName"):
                skipped.append(_skip("MySQL Workbench", name, "no host"))
                continue
            found.append(_entry("MySQL Workbench", name, p["hostName"], p.get("port"), p.get("userName"),
                                p.get("schema"), WB_TLS.get(p.get("useSSL", "1"), "preferred"), p.get("sslCA")))
            src["count"] += 1
        except (ValueError, TypeError) as e:
            skipped.append(_skip("MySQL Workbench", name, f"unreadable ({e})"))


def _jdbc(url):
    """(host, port, database, user, tls) of a MySQL / MariaDB JDBC URL, or None for another database. A password in
    the URL (`user:pw@host`, `?password=`) is dropped."""
    m = JDBC_URL.match((url or "").strip())
    if not m:
        return None
    first, database, query = m.group(2).split(",")[0], unquote(m.group(3) or ""), parse_qs(m.group(4) or "")
    q = {k.lower(): v[-1] for k, v in query.items()}
    user = q.get("user", "")
    if "@" in first:
        info, first = first.rsplit("@", 1)
        user = unquote(info.split(":")[0])
    hp = re.match(r"^\[?([^\]]*?)\]?(?::(\d+))?$", first)
    host, port = (hp.group(1), hp.group(2)) if hp else (first, None)
    tls = JDBC_TLS.get((q.get("sslmode") or "").lower())
    if not tls and q.get("usessl", "").lower() == "false":
        tls = "disabled"
    return host or "127.0.0.1", int(port) if port else 3306, database, user, tls or "preferred"


def _jetbrains_file(path, label, found, skipped, sources):
    """A dataSources.xml (project or global) and the dataSources.local.xml beside it (user names, SSH)."""
    src = {"app": label, "path": str(path), "count": 0}
    try:
        shared = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as e:
        src["error"] = f"Unreadable: {e}"
        sources.append(src)
        return
    local = {}
    try:
        lp = path.with_name("dataSources.local.xml")
        if lp.is_file():
            local = {d.get("uuid"): d for d in ET.parse(lp).getroot().iter("data-source")}
    except (ET.ParseError, OSError):
        pass
    for d in shared.iter("data-source"):
        name = d.get("name") or ""
        url = d.findtext("jdbc-url") or ""
        parsed = _jdbc(url)
        if not parsed:
            if not url:
                skipped.append(_skip(label, name, "no JDBC URL"))
            continue  # else another kind of database: not ours to list
        loc = local.get(d.get("uuid"))
        if loc is not None and (loc.findtext("ssh-properties/enabled") or "").strip() == "true":
            skipped.append(_skip(label, name, "goes through an SSH tunnel"))
            continue
        host, port, database, user, tls = parsed
        if loc is not None and (loc.findtext("ssl-config/enabled") or "").strip() == "true":
            mode = (loc.findtext("ssl-config/mode") or "").lower()
            tls = "verify" if "verify" in mode else "required"
        if loc is not None and loc.findtext("user-name"):
            user = loc.findtext("user-name")
        found.append(_entry(label, name, host, port, user, database, tls,
                            loc.findtext("ssl-config/ca-cert") if loc is not None else ""))
        src["count"] += 1
    if src["count"] or src.get("error"):
        sources.append(src)


def jetbrains(found, skipped, sources):
    """Global data sources of each JetBrains IDE, and those of its recent projects (each project once)."""
    if not JETBRAINS.is_dir():
        return
    projects = {}
    for ide in sorted(JETBRAINS.iterdir(), reverse=True):  # the newest version names a project seen by several
        options = ide / "options"
        if not options.is_dir():
            continue
        product = re.sub(r"(\d{4}\.\d+)$", r" \1", ide.name).replace("IntelliJIdea", "IntelliJ IDEA ")
        product = re.sub(r"\s+", " ", product)
        g = options / "dataSources.xml"
        if g.is_file():
            _jetbrains_file(g, f"{product} (global)", found, skipped, sources)
        recent = options / "recentProjects.xml"
        if not recent.is_file():
            continue
        try:
            entries = ET.parse(recent).getroot().iter("entry")
            for e in entries:
                p = (e.get("key") or "").replace("$USER_HOME$", str(HOME))
                if p.startswith("/"):
                    projects.setdefault(p, product)
        except (ET.ParseError, OSError):
            continue
    for p, product in sorted(projects.items()):
        f = Path(p) / ".idea" / "dataSources.xml"
        if f.is_file():
            _jetbrains_file(f, f"{product} · {Path(p).name}", found, skipped, sources)


def scan():
    found, skipped, sources = [], [], []
    workbench(found, skipped, sources)
    jetbrains(found, skipped, sources)
    # The same server and user from two places (two IDE versions, Workbench and IntelliJ): one row, every source.
    merged = {}
    for f in found:
        src = f.pop("source")
        k = (_host_key(f["host"]), f["port"], f["user"].lower(), f["database"].lower())
        if k not in merged:
            merged[k] = {**f, "sources": []}
        if src not in merged[k]["sources"]:
            merged[k]["sources"].append(src)
    return {"found": list(merged.values()), "skipped": skipped, "sources": sources}


def _host_key(h):
    h = h.lower()
    return "127.0.0.1" if h in ("localhost", "127.0.0.1", "::1") else h
