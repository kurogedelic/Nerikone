"""Nerikone HTTP server: the viewer's backend and the API the MCP server drives.

Run:  .venv/bin/python nerikone/server.py   ->  http://localhost:8765
Standard library only (plus smlibpy through kernel.py).
"""
import collections
import json
import pathlib
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import kernel as K  # noqa: E402

WEB = (pathlib.Path(__file__).parent / "web").resolve()
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css"}
LOCK = threading.Lock()
DOC = K.Document()
VERSION = [0]  # bumps on every committed change, so open viewers follow edits made by agents
ERRORS: collections.deque = collections.deque(maxlen=200)  # recent failures, for the console and for agents


def log_error(path, body, msg):
    entry = {"time": time.strftime("%H:%M:%S"), "path": path, "cmd": (body or {}).get("cmd") or (body or {}).get("id"),
             "preview": bool((body or {}).get("preview")), "error": msg}
    last = ERRORS[-1] if ERRORS else None
    if last and last["error"] == msg and last["cmd"] == entry["cmd"]:
        last["count"] = last.get("count", 1) + 1
        last["time"] = entry["time"]
    else:
        ERRORS.append(entry)


def changed():
    VERSION[0] += 1


def state(with_scene=True):
    d = {"version": VERSION[0], "doc": DOC.summary()}
    if with_scene:
        d["scene"] = K.scene(DOC.bodies)
    return d


class H(BaseHTTPRequestHandler):
    def _send(self, code, data: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            with LOCK:
                if u.path == "/api/commands":
                    return self._json([c.schema() for c in K.COMMANDS.values()])
                if u.path == "/api/errors":
                    return self._json(list(ERRORS))
                if u.path == "/api/version":
                    return self._json({"version": VERSION[0]})
                if u.path == "/api/state":
                    return self._json(state(q.get("scene", "1") != "0"))
                if u.path == "/api/inspect":
                    name = q.get("body", "")
                    if name not in DOC.bodies:
                        raise K.BadParams(f"no body '{name}' (have: {sorted(DOC.bodies)})")
                    return self._json(K.inspect_body(DOC.bodies[name]))
                if u.path == "/api/export":
                    fmt = q.get("fmt", "step")
                    names = [n for n in q.get("bodies", "").split(",") if n]
                    data = K.export(DOC, fmt, names)
                    return self._send(200, data, K.EXPORTS.get(fmt, "application/octet-stream"),
                                      {"Content-Disposition": f'attachment; filename="nerikone.{fmt}"'})
        except Exception as e:
            return self._json({"error": str(e)}, 400)
        p = (WEB / ("index.html" if u.path in ("/", "") else u.path.lstrip("/"))).resolve()
        if not p.is_relative_to(WEB) or not p.is_file():
            return self._json({"error": "not found"}, 404)
        self._send(200, p.read_bytes(), TYPES.get(p.suffix, "application/octet-stream"))

    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        body = None
        try:
            with LOCK:
                if u.path == "/api/import":  # raw file bytes, ?filename=
                    data, name = self._body(), q.get("filename", "file.step")
                    ext = name.rsplit(".", 1)[-1].lower()
                    if ext == "nrk":
                        DOC.load_json(json.loads(data))
                    elif ext in ("step", "stp", "stl", "wrl", "wrz", "vrml"):
                        fmt = "stl" if ext == "stl" else "wrl" if ext in ("wrl", "wrz", "vrml") else "step"
                        stem = "".join(ch for ch in name.rsplit(".", 1)[0] if ch.isalnum() or ch in "_-")[:24] or "Import"
                        DOC.execute("file.import", {"blob": K.add_blob(data), "format": fmt, "name": stem,
                                                    "to_solid": q.get("to_solid") == "1"})
                    else:
                        raise K.BadParams("supported: .step .stp .stl .wrl .wrz .nrk")
                    changed()
                    return self._json(state())
                body = json.loads(self._body() or b"{}")
                if u.path == "/api/exec":
                    if body.get("preview"):
                        return self._json({"scene": K.scene(DOC.preview(body["cmd"], body.get("params", {})))})
                    f = DOC.execute(body["cmd"], body.get("params", {}))
                    changed()
                    return self._json({"feature": f, **state()})
                if u.path == "/api/limits":  # {cmd, params, param, lo, hi, direction?, iters?}
                    lim = DOC.limit(body["cmd"], body.get("params", {}), body["param"], float(body["lo"]), float(body["hi"]),
                                    body.get("direction"), int(body.get("iters", 10)))
                    return self._json({"max": lim})
                if u.path == "/api/feature":
                    if body.get("preview"):
                        return self._json({"scene": K.scene(DOC.preview_update(int(body["id"]), body.get("params", {})))})
                    if body.get("delete"):
                        DOC.delete(int(body["id"]))
                    else:
                        DOC.update(int(body["id"]), body.get("params"), body.get("suppressed"))
                    changed()
                    return self._json(state())
                if u.path in ("/api/undo", "/api/redo"):
                    (DOC.undo if u.path.endswith("undo") else DOC.redo)()
                    changed()
                    return self._json(state())
                if u.path == "/api/new":
                    DOC.load_json({"features": []})
                    changed()
                    return self._json(state())
            self._json({"error": "not found"}, 404)
        except Exception as e:  # kernel failures are expected while dragging; report, never crash
            msg = str(e) if isinstance(e, K.BadParams) else f"{type(e).__name__}: {e}"
            if "--debug" in sys.argv and not isinstance(e, K.BadParams):
                traceback.print_exc()
            log_error(u.path if not q.get("filename") else f"{u.path} {q['filename']}", body if isinstance(body, dict) else None, msg)
            self._json({"error": msg}, 400)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8765
    print(f"Nerikone: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
