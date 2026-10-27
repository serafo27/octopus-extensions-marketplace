"""API explorer's helper: sends the page's HTTP requests to any host, like Postman does.

Octopus only lets an extension reach the hosts its manifest lists, so the page talks to this program on
127.0.0.1 instead, and it makes the request.

- Listens on 127.0.0.1 only, on a port picked by OCTOPUS_PRODUCT (47871 for "octopus", 47872 otherwise), so
  another Octopus build on this Mac runs its own copy.
- Every request needs the token printed at start-up (`APIEXPLORER_READY port=… token=…`): the page reads it
  from this helper's log, which only Octopus can see. Another program of this Mac can reach the port, not use it.
- POST /send  {url, method, headers, body, bodyBase64, timeoutMs, followRedirects, verifyTls}
  -> {status, reason, headers: [[k, v]…], body, bodyBase64, size, ms, url, redirects}
  The body comes back as text when it is text, as base64 otherwise (images, PDFs…).
"""

import base64
import gzip
import hmac
import http.client
import json
import os
import secrets
import socket
import ssl
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin, urlsplit

PORT = 47871 if os.environ.get("OCTOPUS_PRODUCT", "octopus") == "octopus" else 47872
TOKEN = secrets.token_urlsafe(24)
MAX_BODY = 64 * 1024 * 1024
TEXT_TYPES = ("text/", "json", "xml", "javascript", "html", "x-www-form-urlencoded", "yaml", "csv", "graphql")


def decode_body(raw, encoding):
    enc = (encoding or "").lower().strip()
    try:
        if enc in ("gzip", "x-gzip"):
            return gzip.decompress(raw)
        if enc == "deflate":
            try:
                return zlib.decompress(raw)
            except zlib.error:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
    except Exception:
        pass
    return raw


def is_text(content_type, raw):
    ct = (content_type or "").lower()
    if any(t in ct for t in TEXT_TYPES):
        return True
    if ct:
        return False
    try:
        raw[:4096].decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def send(req):
    url = req["url"]
    method = (req.get("method") or "GET").upper()
    headers = {k: v for k, v in (req.get("headers") or {}).items() if k}
    # Brotli can't be decoded with the standard library: ask for what can.
    for k in list(headers):
        if k.lower() == "accept-encoding":
            kept = [e for e in headers[k].split(",") if e.strip().split(";")[0] in ("gzip", "deflate", "identity")]
            headers[k] = ", ".join(e.strip() for e in kept) or "identity"
    body = None
    if req.get("bodyBase64") is not None:
        body = base64.b64decode(req["bodyBase64"])
    elif req.get("body") is not None:
        body = req["body"].encode("utf-8")
    timeout = max(1, min(600, (req.get("timeoutMs") or 60000) / 1000))
    follow = req.get("followRedirects", True)
    ctx = ssl.create_default_context()
    if req.get("verifyTls") is False:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    redirects = []
    t0 = time.perf_counter()
    for _ in range(11):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"Not an http(s) URL: {url}")
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        if parts.scheme == "https":
            conn = http.client.HTTPSConnection(parts.hostname, parts.port, timeout=timeout, context=ctx)
        else:
            conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=timeout)
        try:
            h = dict(headers)
            if body is not None and not any(k.lower() == "content-length" for k in h):
                h["Content-Length"] = str(len(body))
            conn.request(method, path, body=body, headers=h)
            res = conn.getresponse()
            raw = res.read(MAX_BODY + 1)
        finally:
            conn.close()
        location = res.getheader("Location")
        if follow and res.status in (301, 302, 303, 307, 308) and location:
            redirects.append({"status": res.status, "url": url})
            url = urljoin(url, location)
            if res.status == 303 or (res.status in (301, 302) and method not in ("GET", "HEAD")):
                method, body = "GET", None
                headers = {k: v for k, v in headers.items() if k.lower() not in ("content-type", "content-length")}
            continue
        break
    ms = (time.perf_counter() - t0) * 1000
    if len(raw) > MAX_BODY:
        raise ValueError("The response is bigger than 64 MB")
    raw = decode_body(raw, res.getheader("Content-Encoding"))
    out = {
        "status": res.status,
        "reason": res.reason,
        "headers": [[k, v] for k, v in res.getheaders()],
        "size": len(raw),
        "ms": ms,
        "url": url,
        "redirects": redirects,
    }
    if is_text(res.getheader("Content-Type"), raw):
        out["body"] = raw.decode("utf-8", errors="replace")
    else:
        out["bodyBase64"] = base64.b64encode(raw).decode("ascii")
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, data):
        out = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def authorized(self):
        return hmac.compare_digest(self.headers.get("X-Token", ""), TOKEN)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "Not found"})
        if not self.authorized():
            return self.reply(401, {"error": "Bad token"})
        self.reply(200, {"ok": True, "version": 1})

    def do_POST(self):
        if self.path != "/send":
            return self.reply(404, {"error": "Not found"})
        if not self.authorized():
            return self.reply(401, {"error": "Bad token"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n))
            self.reply(200, send(req))
        except ssl.SSLCertVerificationError as e:
            self.reply(200, {"error": f"TLS certificate not trusted: {e.verify_message or e}", "tls": True})
        except (TimeoutError, OSError, http.client.HTTPException, ValueError) as e:
            self.reply(200, {"error": describe(e)})
        except Exception as e:  # noqa: BLE001 - reported to the page, which shows it
            self.reply(200, {"error": f"{type(e).__name__}: {e}"})


def describe(e):
    if isinstance(e, TimeoutError):
        return "Timed out"
    if isinstance(e, ConnectionRefusedError):
        return "Connection refused"
    if isinstance(e, socket.gaierror):
        return f"Host not found ({e.strerror or e})"
    return str(e) or type(e).__name__


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"APIEXPLORER_READY port={PORT} token={TOKEN}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
