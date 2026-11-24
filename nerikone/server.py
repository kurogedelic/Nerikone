"""Nerikone HTTP server: the viewer's backend and the API the MCP server drives.

  .venv/bin/python nerikone/server.py                 # local: one shared document  -> http://localhost:8765
  .venv/bin/python nerikone/server.py --public        # web: one document per visitor, with limits
Options: --port N, --host ADDR (default 127.0.0.1), --base /prefix (serve under a sub-path), --debug,
--reload (development: restart when kernel.py / server.py / vrml.py change, keeping the open document).
Standard library only (plus smlibpy through kernel.py).
"""
import collections
import json
import os
import pathlib
import secrets
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import kernel as K  # noqa: E402


def _arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else os.environ.get("NERIKONE_" + name[2:].upper(), default)


PUBLIC = "--public" in sys.argv or os.environ.get("NERIKONE_PUBLIC") == "1"
DESKTOP = os.environ.get("NERIKONE_DESKTOP") == "1" and not PUBLIC  # the desktop app: may write into ~/Downloads
BASE = _arg("--base", "").rstrip("/")
WEB = (pathlib.Path(__file__).parent / "web").resolve()
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
         ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png"}

# Limits (public mode). The kernel runs one operation at a time, so these keep one visitor from starving others.
MAX_UPLOAD = 25 * 1024 * 1024        # bytes per imported file
MAX_JSON = 2 * 1024 * 1024           # bytes per API request
MAX_FEATURES = 400                   # timeline length per document
MAX_SESSIONS = 200                   # documents kept in memory
SESSION_IDLE = 2 * 3600              # seconds before an idle document is dropped
MAX_BLOBS = 400 * 1024 * 1024        # imported files kept in memory, all sessions together

LOCK = threading.Lock()  # one kernel operation at a time (the kernel is not known to be thread-safe)


class Session:
    def __init__(self):
        self.doc = K.Document()
        self.version = 0
        self.errors: collections.deque = collections.deque(maxlen=200)
        self.seen = time.time()


SESSIONS: dict[str, Session] = {}
SHARED = Session()  # local mode: everyone (the viewer, agents over MCP) edits this one document


def session_for(handler) -> tuple[Session, str | None]:
    """The caller's session, and a cookie to set when a new one was made (public mode only)."""
    if not PUBLIC:
        return SHARED, None
    sid = None
    for part in (handler.headers.get("Cookie") or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == "nk_sid" and v in SESSIONS:
            sid = v
    now = time.time()
    for k in [k for k, s in SESSIONS.items() if now - s.seen > SESSION_IDLE]:
        del SESSIONS[k]
    if sid is None:
        if len(SESSIONS) >= MAX_SESSIONS:  # drop the least recently used
            del SESSIONS[min(SESSIONS, key=lambda k: SESSIONS[k].seen)]
        sid = secrets.token_urlsafe(18)
        SESSIONS[sid] = Session()
        cookie = f"nk_sid={sid}; Path={BASE or '/'}; HttpOnly; SameSite=Lax; Max-Age={SESSION_IDLE}"
    else:
        cookie = None
    s = SESSIONS[sid]
    s.seen = now
    return s, cookie


def trim_blobs():
    """Keep imported files under MAX_BLOBS, dropping ones no live document uses."""
    total = sum(len(b) for b in K.BLOBS.values())
    if total <= MAX_BLOBS:
        return
    live = {f["params"].get("blob") for s in [SHARED, *SESSIONS.values()] for f in s.doc.features if f["cmd"] == "file.import"}
    for h in list(K.BLOBS):
        if total <= MAX_BLOBS:
            break
        if h not in live:
            total -= len(K.BLOBS.pop(h))


def log_error(s: Session, path, body, msg):
    entry = {"time": time.strftime("%H:%M:%S"), "path": path, "cmd": (body or {}).get("cmd") or (body or {}).get("id"),
             "preview": bool((body or {}).get("preview")), "error": msg}
    last = s.errors[-1] if s.errors else None
    if last and last["error"] == msg and last["cmd"] == entry["cmd"]:
        last["count"] = last.get("count", 1) + 1
        last["time"] = entry["time"]
    else:
        s.errors.append(entry)


def state(s: Session, with_scene=True):
    d = {"version": s.version, "doc": s.doc.summary(), "public": PUBLIC, "desktop": DESKTOP}
    if with_scene:
        d["scene"] = K.scene(s.doc.bodies)
    return d


def save_download(name, data):
    safe = "".join(ch for ch in os.path.basename(name) if ch.isalnum() or ch in "._- ").strip(". ") or "nerikone.bin"
    folder = pathlib.Path.home() / "Downloads"
    folder.mkdir(exist_ok=True)
    stem, dot, ext = safe.rpartition(".")
    stem, ext = (stem, "." + ext) if dot else (safe, "")
    target, n = folder / safe, 1
    while target.exists():
        n += 1
        target = folder / f"{stem} ({n}){ext}"
    target.write_bytes(data)
    return {"name": target.name, "path": str(target)}


class TooLarge(Exception):
    pass


class H(BaseHTTPRequestHandler):
    cookie = None

    def _send(self, code, data: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if self.cookie:
            self.send_header("Set-Cookie", self.cookie)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _body(self, limit):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if PUBLIC and n > limit:
            raise TooLarge(f"too large ({n // 1024} KB; the limit is {limit // (1024 * 1024)} MB)")
        return self.rfile.read(n)

    def _path(self):
        u = urlparse(self.path)
        path = u.path
        if BASE and (path == BASE or path.startswith(BASE + "/")):
            path = path[len(BASE):] or "/"
        return path, {k: v[0] for k, v in parse_qs(u.query).items()}

    def do_GET(self):
        path, q = self._path()
        if path == "/health":  # readiness probe for container hosts
            return self._send(200, b"ok", "text/plain")
        if path.startswith("/api/"):
            try:
                with LOCK:
                    s, self.cookie = session_for(self)
                    doc = s.doc
                    if path == "/api/commands":
                        return self._json([c.schema() for c in K.COMMANDS.values()])
                    if path == "/api/errors":
                        return self._json(list(s.errors))
                    if path == "/api/version":
                        return self._json({"version": s.version})
                    if path == "/api/state":
                        return self._json(state(s, q.get("scene", "1") != "0"))
                    if path == "/api/inspect":
                        name = q.get("body", "")
                        if name not in doc.bodies:
                            raise K.BadParams(f"no body '{name}' (have: {sorted(doc.bodies)})")
                        return self._json(K.inspect_body(doc.bodies[name]))
                    if path == "/api/export":
                        fmt = q.get("fmt", "step")
                        names = [n for n in q.get("bodies", "").split(",") if n]
                        try:
                            tol = float(q["tolerance"]) if q.get("tolerance") else None
                        except ValueError:
                            raise K.BadParams("tolerance must be a number") from None
                        data = K.export(doc, fmt, names, tol)
                        return self._send(200, data, K.EXPORTS.get(fmt, "application/octet-stream"),
                                          {"Content-Disposition": f'attachment; filename="nerikone.{fmt}"'})
            except Exception as e:
                return self._json({"error": str(e)}, 400)
            return self._json({"error": "not found"}, 404)
        p = (WEB / ("index.html" if path in ("/", "") else path.lstrip("/"))).resolve()
        if not p.is_relative_to(WEB) or not p.is_file():
            return self._json({"error": "not found"}, 404)
        self._send(200, p.read_bytes(), TYPES.get(p.suffix, "application/octet-stream"),
                   {"Cache-Control": "no-cache"})

    def do_POST(self):
        path, q = self._path()
        body, s = None, SHARED
        try:
            with LOCK:
                s, self.cookie = session_for(self)
                doc = s.doc
                full = PUBLIC and len(doc.features) >= MAX_FEATURES
                cap = f"this document reached {MAX_FEATURES} steps; save it (.nrk) and start a new one"
                if full and path == "/api/import":
                    raise K.BadParams(cap)
                if path == "/api/save-download" and DESKTOP:  # raw bytes -> ~/Downloads/<name> (desktop app only)
                    return self._json(save_download(q.get("filename", "nerikone.bin"), self._body(1 << 31)))
                if path == "/api/import":  # raw file bytes, ?filename=
                    data, name = self._body(MAX_UPLOAD), q.get("filename", "file.step")
                    ext = name.rsplit(".", 1)[-1].lower()
                    if ext == "nrk":
                        doc.load_json(json.loads(data))
                    elif ext in ("step", "stp", "stl", "wrl", "wrz", "vrml"):
                        fmt = "stl" if ext == "stl" else "wrl" if ext in ("wrl", "wrz", "vrml") else "step"
                        stem = "".join(ch for ch in name.rsplit(".", 1)[0] if ch.isalnum() or ch in "_-")[:24] or "Import"
                        doc.execute("file.import", {"blob": K.add_blob(data), "format": fmt, "name": stem,
                                                    "to_solid": q.get("to_solid") == "1"})
                        trim_blobs()
                    else:
                        raise K.BadParams("supported: .step .stp .stl .wrl .wrz .nrk")
                    s.version += 1
                    return self._json(state(s))
                body = json.loads(self._body(MAX_JSON) or b"{}")
                if path == "/api/exec":
                    if full and not body.get("preview"):
                        raise K.BadParams(cap)
                    if body.get("preview"):
                        return self._json({"scene": K.scene(doc.preview(body["cmd"], body.get("params", {})))})
                    f = doc.execute(body["cmd"], body.get("params", {}))
                    s.version += 1
                    return self._json({"feature": f, **state(s)})
                if path == "/api/limits":  # {cmd, params, param, lo, hi, direction?, iters?}
                    lim = doc.limit(body["cmd"], body.get("params", {}), body["param"], float(body["lo"]), float(body["hi"]),
                                    body.get("direction"), min(int(body.get("iters", 10)), 12))
                    return self._json({"max": lim})
                if path == "/api/measure":  # {kind, params}: exact measurements, nothing changes
                    return self._json(K.measure(doc, str(body.get("kind", "")), body.get("params", {})))
                if path == "/api/settings":  # {units}
                    doc.set_units(body.get("units"))
                    s.version += 1
                    return self._json(state(s, False))
                if path == "/api/feature":
                    if body.get("preview"):
                        return self._json({"scene": K.scene(doc.preview_update(int(body["id"]), body.get("params", {})))})
                    if body.get("delete"):
                        doc.delete(int(body["id"]))
                    else:
                        doc.update(int(body["id"]), body.get("params"), body.get("suppressed"))
                    s.version += 1
                    return self._json(state(s))
                if path in ("/api/undo", "/api/redo"):
                    (doc.undo if path.endswith("undo") else doc.redo)()
                    s.version += 1
                    return self._json(state(s))
                if path == "/api/new":
                    doc.load_json({"features": []})
                    s.version += 1
                    return self._json(state(s))
            self._json({"error": "not found"}, 404)
        except Exception as e:  # kernel failures are expected while dragging; report, never crash
            msg = str(e) if isinstance(e, (K.BadParams, TooLarge)) else f"{type(e).__name__}: {e}"
            if "--debug" in sys.argv and not isinstance(e, K.BadParams):
                traceback.print_exc()
            log_error(s, path if not q.get("filename") else f"{path} {q['filename']}", body if isinstance(body, dict) else None, msg)
            self._json({"error": msg}, 413 if isinstance(e, TooLarge) else 400)

    def log_message(self, *a):
        pass


def watch_and_reload():
    """--reload: when the Python files change, save the shared document, restart this process, and load it back.
    The viewer files (web/) need no restart: reload the page."""
    here = pathlib.Path(__file__).parent
    files = [here / n for n in ("kernel.py", "server.py", "vrml.py")]
    stamp = lambda: [f.stat().st_mtime if f.exists() else 0 for f in files]
    seen = stamp()
    while True:
        time.sleep(1)
        now = stamp()
        if now == seen:
            continue
        time.sleep(0.3)  # let the editor finish writing
        try:
            compile((here / "kernel.py").read_text(encoding="utf-8"), "kernel.py", "exec")
            compile((here / "server.py").read_text(encoding="utf-8"), "server.py", "exec")
        except SyntaxError as e:
            print(f"reload: not restarting, syntax error: {e}", flush=True)
            seen = now
            continue
        keep = pathlib.Path(tempfile.gettempdir()) / f"nerikone-reload-{os.getpid()}.nrk"
        with LOCK:
            keep.write_text(json.dumps(SHARED.doc.to_json()), encoding="utf-8")
        print("reload: restarting with the new code", flush=True)
        args = [a for a in sys.argv if not a.startswith("--restore=")] + [f"--restore={keep}"]
        os.execv(sys.executable, [sys.executable, *args])


if __name__ == "__main__":
    for a in sys.argv:
        if a.startswith("--restore="):  # coming back from a --reload restart
            keep = pathlib.Path(a.split("=", 1)[1])
            try:
                SHARED.doc.load_json(json.loads(keep.read_text(encoding="utf-8")))
                SHARED.doc.undo_stack.clear()
                SHARED.version = int(time.time())  # viewers see a new version and fetch the model again
                print(f"reload: document restored ({len(SHARED.doc.features)} steps)", flush=True)
            except Exception as e:  # never lose the server over a restore
                print(f"reload: could not restore the document: {e}", flush=True)
            keep.unlink(missing_ok=True)
    if "--reload" in sys.argv and not PUBLIC:
        threading.Thread(target=watch_and_reload, daemon=True).start()
    port = int(_arg("--port", "8765"))
    host = _arg("--host", "127.0.0.1")
    print(f"Nerikone{' (public)' if PUBLIC else ''}: http://{host}:{port}{BASE or ''}/")
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer((host, port), H).serve_forever()
