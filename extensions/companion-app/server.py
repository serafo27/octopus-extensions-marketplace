"""Companion App's helper: serves the phone page on the local network and runs the extension's own terminals.

- Listens on every interface (the phone reaches it over Wi-Fi), on a port picked by OCTOPUS_PRODUCT (8765 for
  "octopus", 8766 otherwise), so another Octopus build on this Mac runs its own copy.
- Two kinds of callers:
  - the phone: paired once with /pair?t=<phone token> (the QR code in Octopus), then a cookie. The phone token is
    kept in $OCTOPUS_HOME/companion-app.json so pairing survives restarts; "New pairing code" replaces it.
  - the extension page, from 127.0.0.1 only, with the local token printed at start-up
    (`COMPANION_READY port=… token=…`): the page reads it from this helper's log, which only Octopus can see.
- Octopus's own terminals are read-only for extensions: the page pushes their list and the text of those a phone
  is looking at (/local/push), and runs what the phone asks Octopus to do (a new Claude session) from the reply.
- Sessions of its own (a login shell or `claude` in a project's folder) run here in a pseudo-terminal: the phone
  reads them as a stream (Server-Sent Events) and types into them, when typing is allowed.
"""

import base64
import fcntl
import hmac
import json
import mimetypes
import os
import pty
import secrets
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PORT = 8765 if os.environ.get("OCTOPUS_PRODUCT", "octopus") == "octopus" else 8766
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(os.environ.get("OCTOPUS_HOME") or os.path.expanduser("~/.octopus"), "companion-app.json")
LOCAL_TOKEN = secrets.token_urlsafe(24)
COOKIE = "companion"
BUFFER_MAX = 512 * 1024
STATIC = {
    "/": "mobile/index.html",
    "/app.js": "mobile/app.js",
    "/style.css": "mobile/style.css",
    "/manifest.webmanifest": "mobile/manifest.webmanifest",
    "/vendor/xterm.js": "vendor/xterm.js",
    "/vendor/xterm.css": "vendor/xterm.css",
    "/vendor/addon-fit.js": "vendor/addon-fit.js",
}

lock = threading.Lock()


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


state = load_state()
if not state.get("phoneToken"):
    state["phoneToken"] = secrets.token_urlsafe(24)
    save_state(state)

# What the page last pushed about Octopus.
octo = {"terminals": [], "projects": [], "accounts": [], "snapshots": {}, "previews": {}, "allowInput": True, "pushedAt": 0}
previews_wanted_at = 0  # when a phone last showed the grid, which needs every terminal's last lines
watching = {}  # Octopus terminal id -> when a phone last asked for it
actions = []  # for the page to run: [{id, type, …}]
phones = {}  # client address -> {"seenAt", "agent", "viewing": {"kind", "id", "at"}, "streams": open streams}
sessions = {}  # id -> Session


def phone_list(now, max_age):
    """Phones seen in the last `max_age` seconds, with what each is looking at now. Call with `lock` held."""
    out = []
    for address, p in phones.items():
        if now - p["seenAt"] > max_age:
            continue
        v = p.get("viewing")
        if v and not (v["kind"] == "session" and p["streams"]) and not (v["kind"] == "octo" and now - v["at"] < 5):
            v = None
        out.append({"address": address, "seenAt": int(p["seenAt"] * 1000), "agent": p["agent"], "viewing": v and {"kind": v["kind"], "id": v["id"]}})
    return sorted(out, key=lambda x: -x["seenAt"])


def computer_name():
    try:
        name = subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        name = ""
    return name or socket.gethostname().split(".")[0]


HOST_NAME = computer_name()


def lan_addresses():
    found = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent: only picks the interface of the default route
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    for iface in ("en0", "en1", "en2"):
        try:
            ip = subprocess.run(["ipconfig", "getifaddr", iface], capture_output=True, text=True, timeout=2).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            ip = ""
        if ip and ip not in found:
            found.append(ip)
    return [ip for ip in found if not ip.startswith("127.")]


class Session:
    def __init__(self, kind, project, account_dir):
        self.id = secrets.token_hex(4)
        self.kind = kind
        self.project_id = project["id"]
        self.title = ("Claude" if kind == "claude" else "Shell") + " · " + project["name"]
        self.cwd = project["path"]
        self.created_at = time.time()
        self.last_output_at = self.created_at
        self.buffer = bytearray()
        self.seq = 0  # bytes written since the start; buffer holds the last len(buffer) of them
        self.exited = False
        self.exit_code = None
        self.cond = threading.Condition()
        shell = os.environ.get("SHELL") or "/bin/zsh"
        argv = [shell, "-l"] if kind == "shell" else [shell, "-l", "-c", "claude"]
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        if account_dir:
            env["CLAUDE_CONFIG_DIR"] = account_dir
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.chdir(self.cwd)
            except OSError:
                pass
            os.execvpe(argv[0], argv, env)
        self.pid, self.fd = pid, fd
        self.cols, self.rows = 100, 30
        self.resize(100, 30)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            with self.cond:
                self.buffer += data
                if len(self.buffer) > BUFFER_MAX:
                    del self.buffer[: len(self.buffer) - BUFFER_MAX]
                self.seq += len(data)
                self.last_output_at = time.time()
                self.cond.notify_all()
        try:
            _, status = os.waitpid(self.pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            code = None
        try:
            os.close(self.fd)
        except OSError:
            pass
        with self.cond:
            self.exited, self.exit_code = True, code
            self.cond.notify_all()

    def since(self, seq):
        """The output after `seq` still in the buffer, and the seq it ends at."""
        start = self.seq - len(self.buffer)
        seq = max(seq, start)
        return bytes(self.buffer[seq - start :]), self.seq

    def write(self, text):
        if not self.exited:
            os.write(self.fd, text.encode("utf-8"))

    def resize(self, cols, rows):
        if self.exited:
            return
        cols, rows = max(20, min(500, int(cols))), max(5, min(300, int(rows)))
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def close(self):
        if self.exited:
            return
        try:
            os.killpg(os.getpgid(self.pid), signal.SIGHUP)
        except OSError:
            pass

        def kill_later():
            time.sleep(3)
            if not self.exited:
                try:
                    os.killpg(os.getpgid(self.pid), signal.SIGKILL)
                except OSError:
                    pass

        threading.Thread(target=kill_later, daemon=True).start()

    def info(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "projectId": self.project_id,
            "cwd": self.cwd,
            "createdAt": int(self.created_at * 1000),
            "lastOutputAt": int(self.last_output_at * 1000),
            "exited": self.exited,
            "exitCode": self.exit_code,
            "cols": self.cols,
            "rows": self.rows,
        }


def public_state():
    now = time.time()
    with lock:
        return {
            "terminals": octo["terminals"],
            "projects": [{"id": p["id"], "name": p["name"], "color": p.get("color")} for p in octo["projects"]],
            "accounts": [{"id": a["id"], "name": a["name"], "current": a.get("current")} for a in octo["accounts"]],
            "sessions": [s.info() for s in sessions.values()],
            "allowInput": octo["allowInput"],
            "relaying": now - octo["pushedAt"] < 10,
            "previews": octo["previews"],
            "host": HOST_NAME,
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Companion"

    def log_message(self, fmt, *args):
        pass

    # --- helpers

    def reply(self, status, body=b"", ctype="application/json", headers=None):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def error(self, status, message):
        self.reply(status, {"error": message})

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 4 * 1024 * 1024:
            raise ValueError("body too large")
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw or b"{}")

    def is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1") and hmac.compare_digest(
            self.headers.get("X-Local-Token", ""), LOCAL_TOKEN
        )

    def cookie_token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return ""

    def is_phone(self):
        with lock:
            token = state["phoneToken"]
        ok = hmac.compare_digest(self.cookie_token(), token)
        if ok:
            with lock:
                phone = phones.setdefault(self.client_address[0], {"viewing": None, "streams": 0})
                phone.update(seenAt=time.time(), agent=self.headers.get("User-Agent", ""))
        return ok

    # --- routing

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        if path == "/pair":
            return self.pair(query.get("t", [""])[0])
        if path in STATIC:
            if path == "/" and not self.is_phone():
                return self.static("mobile/unpaired.html")
            return self.static(STATIC[path])
        if path.startswith("/local/"):
            if not self.is_local():
                return self.error(403, "forbidden")
            if path == "/local/info":
                return self.reply(200, self.local_info())
            return self.error(404, "not found")
        if not path.startswith("/api/"):
            return self.error(404, "not found")
        local = self.is_local()
        if not local and not self.is_phone():
            return self.error(401, "not paired")
        parts = path.strip("/").split("/")  # api, …
        if parts == ["api", "state"]:
            if query.get("previews") == ["1"]:
                global previews_wanted_at
                previews_wanted_at = time.time()
            return self.reply(200, public_state())
        if len(parts) == 3 and parts[1] == "octo":
            return self.octo_snapshot(parts[2])
        if len(parts) == 4 and parts[1] == "sessions":
            session = sessions.get(parts[2])
            if not session:
                return self.error(404, "no such session")
            if parts[3] == "stream":
                return self.stream(session, int(query.get("from", ["0"])[0] or 0))
            if parts[3] == "read":
                with session.cond:
                    data, seq = session.since(int(query.get("from", ["0"])[0] or 0))
                return self.reply(200, {"data": base64.b64encode(data).decode(), "seq": seq, "exited": session.exited})
        return self.error(404, "not found")

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            data = self.body()
        except ValueError as e:
            return self.error(400, str(e))
        if path.startswith("/local/"):
            if not self.is_local():
                return self.error(403, "forbidden")
            if path == "/local/push":
                return self.reply(200, self.push(data))
            if path == "/local/rotate":
                with lock:
                    state["phoneToken"] = secrets.token_urlsafe(24)
                    save_state(state)
                    phones.clear()
                return self.reply(200, self.local_info())
            return self.error(404, "not found")
        local = self.is_local()
        if not local:
            # A form on another site can't set this header: no cross-site requests with the phone's cookie.
            if self.headers.get("X-Companion") != "1" or not self.is_phone():
                return self.error(401, "not paired")
        parts = path.strip("/").split("/")
        if parts == ["api", "octo", "open"]:
            return self.octo_open(data)
        if parts == ["api", "sessions"]:
            return self.session_create(data)
        if len(parts) == 4 and parts[1] == "sessions":
            session = sessions.get(parts[2])
            if not session:
                return self.error(404, "no such session")
            action = parts[3]
            if action == "resize":
                session.resize(data.get("cols", 100), data.get("rows", 30))
                return self.reply(200, {"ok": True})
            if action == "input":
                if not local and not octo["allowInput"]:
                    return self.error(403, "typing from the phone is turned off in Octopus")
                session.write(str(data.get("data", "")))
                return self.reply(200, {"ok": True})
            if action == "close":
                session.close()
                return self.reply(200, {"ok": True})
            if action == "forget":
                with lock:
                    if session.exited:
                        sessions.pop(session.id, None)
                return self.reply(200, {"ok": True})
        return self.error(404, "not found")

    # --- handlers

    def pair(self, token):
        with lock:
            good = token and hmac.compare_digest(token, state["phoneToken"])
        if not good:
            time.sleep(1)  # slows guessing down
            return self.static("mobile/unpaired.html", status=401)
        cookie = f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
        self.reply(302, b"", "text/plain", {"Location": "/", "Set-Cookie": cookie})

    def static(self, rel, status=200):
        full = os.path.join(HERE, rel)
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            return self.error(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if rel.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.reply(status, body, ctype)

    def local_info(self):
        with lock:
            token = state["phoneToken"]
            now = time.time()
            seen = phone_list(now, 24 * 3600)
        return {
            "port": PORT,
            "pairUrls": [f"http://{ip}:{PORT}/pair?t={token}" for ip in lan_addresses()],
            "phones": seen,
            "sessions": [s.info() for s in sessions.values()],
        }

    def push(self, data):
        now = time.time()
        with lock:
            octo["terminals"] = data.get("terminals") or []
            octo["projects"] = data.get("projects") or []
            octo["accounts"] = data.get("accounts") or []
            octo["allowInput"] = bool(data.get("allowInput", True))
            octo["pushedAt"] = now
            if data.get("previews") is not None:
                octo["previews"] = data["previews"]
            for tid, text in (data.get("snapshots") or {}).items():
                octo["snapshots"][tid] = {"text": text, "at": int(now * 1000)}
            alive = {t["id"] for t in octo["terminals"]}
            for tid in list(octo["snapshots"]):
                if tid not in alive:
                    del octo["snapshots"][tid]
            octo["previews"] = {k: v for k, v in octo["previews"].items() if k in alive}
            for tid in list(watching):
                if now - watching[tid] > 10:
                    del watching[tid]
            todo = actions[:]
            actions.clear()
            seen = phone_list(now, 24 * 3600)
        return {
            "watching": list(watching),
            "previews": now - previews_wanted_at < 6,
            "actions": todo,
            "phones": seen,
            "sessions": [s.info() for s in sessions.values()],
        }

    def octo_snapshot(self, tid):
        with lock:
            watching[tid] = time.time()
            phone = phones.get(self.client_address[0])
            if phone:
                phone["viewing"] = {"kind": "octo", "id": tid, "at": time.time()}
            snap = octo["snapshots"].get(tid)
        return self.reply(200, snap or {"text": None, "at": 0})

    def octo_open(self, data):
        prompt = str(data.get("prompt", "")).strip()
        if not prompt:
            return self.error(400, "a prompt is needed")
        if not octo["allowInput"]:
            return self.error(403, "typing from the phone is turned off in Octopus")
        with lock:
            if time.time() - octo["pushedAt"] > 10:
                return self.error(503, "Octopus isn't relaying: open the Companion App section on the Mac")
            actions.append({"id": secrets.token_hex(4), "type": "open", "prompt": prompt[:20000], "projectId": data.get("projectId"), "account": data.get("account")})
        return self.reply(200, {"ok": True})

    def session_create(self, data):
        if not self.is_local() and not octo["allowInput"]:
            return self.error(403, "typing from the phone is turned off in Octopus")
        kind = "claude" if data.get("kind") == "claude" else "shell"
        with lock:
            project = next((p for p in octo["projects"] if p["id"] == data.get("projectId")), None)
            account = next((a for a in octo["accounts"] if a["id"] == data.get("account")), None)
        if not project or not os.path.isdir(project.get("path") or ""):
            return self.error(400, "pick one of Octopus's projects")
        account_dir = account.get("configDir") if account and not account.get("default") else None
        session = Session(kind, project, account_dir)
        with lock:
            sessions[session.id] = session
        return self.reply(200, session.info())

    def stream(self, session, seq):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        with lock:
            phone = phones.get(self.client_address[0])
            if phone:
                phone["streams"] += 1
                phone["viewing"] = {"kind": "session", "id": session.id, "at": time.time()}
        try:
            while True:
                with session.cond:
                    if session.seq <= seq and not session.exited:
                        session.cond.wait(15)
                    data, end = session.since(seq)
                    exited = session.exited
                if data:
                    payload = json.dumps({"d": base64.b64encode(data).decode()})
                    self.wfile.write(f"id: {end}\ndata: {payload}\n\n".encode())
                    seq = end
                elif exited:
                    self.wfile.write(f"event: exit\ndata: {json.dumps({'code': session.exit_code})}\n\n".encode())
                    self.wfile.flush()
                    return
                else:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            with lock:
                if phone:
                    phone["streams"] = max(0, phone["streams"] - 1)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    server = Server(("0.0.0.0", PORT), Handler)

    def stop(*_):
        for s in list(sessions.values()):
            s.close()
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    print(f"COMPANION_READY port={PORT} token={LOCAL_TOKEN}", flush=True)
    try:
        server.serve_forever()
    finally:
        stop()


if __name__ == "__main__":
    sys.exit(main())
