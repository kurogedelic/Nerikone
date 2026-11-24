"""Nerikone's API without a web server: handle(method, path, query, body) -> (status, content_type, bytes, headers).

The browser build (WebAssembly kernel in a Web Worker, see tools/build-web-local.py) calls this directly; it mirrors the
endpoints of server.py for a single local document, without the public-mode limits. Standard library only, plus kernel.py.
"""
import collections
import json
import time

import kernel as K

doc = K.Document()
version = 0
errors: collections.deque = collections.deque(maxlen=200)


def _state(with_scene=True):
    d = {"version": version, "doc": doc.summary(), "public": False, "desktop": False}
    if with_scene:
        d["scene"] = K.scene(doc.bodies)
    return d


def _json(obj, code=200):
    return code, "application/json", json.dumps(obj).encode(), {}


def handle(method, path, query=None, body=b""):
    global version
    q = query or {}
    b = None
    try:
        if method == "GET":
            if path == "/api/commands":
                return _json([c.schema() for c in K.COMMANDS.values()])
            if path == "/api/errors":
                return _json(list(errors))
            if path == "/api/version":
                return _json({"version": version})
            if path == "/api/state":
                return _json(_state(q.get("scene", "1") != "0"))
            if path == "/api/step":
                i = int(q.get("i", "-1"))
                if not 0 <= i < len(doc.states):
                    raise K.BadParams("no such step")
                return _json({"scene": K.scene(doc.states[i])})
            if path == "/api/inspect":
                name = q.get("body", "")
                if name not in doc.bodies:
                    raise K.BadParams(f"no body '{name}' (have: {sorted(doc.bodies)})")
                return _json(K.inspect_body(doc.bodies[name]))
            if path == "/api/export":
                fmt = q.get("fmt", "step")
                names = [n for n in q.get("bodies", "").split(",") if n]
                try:
                    tol = float(q["tolerance"]) if q.get("tolerance") else None
                except ValueError:
                    raise K.BadParams("tolerance must be a number") from None
                data = K.export(doc, fmt, names, tol)
                return 200, K.EXPORTS.get(fmt, "application/octet-stream"), data, {"Content-Disposition": f'attachment; filename="nerikone.{fmt}"'}
            return _json({"error": "not found"}, 404)
        if path == "/api/import":  # raw file bytes, ?filename=
            name = q.get("filename", "file.step")
            ext = name.rsplit(".", 1)[-1].lower()
            if ext == "nrk":
                doc.load_json(json.loads(body))
            elif ext in ("step", "stp", "stl", "wrl", "wrz", "vrml", "obj", "glb", "3mf", "iges", "igs"):
                fmt = {"stl": "stl", "wrl": "wrl", "wrz": "wrl", "vrml": "wrl", "obj": "obj", "glb": "glb", "3mf": "3mf", "iges": "iges", "igs": "iges"}.get(ext, "step")
                stem = "".join(ch for ch in name.rsplit(".", 1)[0] if ch.isalnum() or ch in "_-")[:24] or "Import"
                doc.execute("file.import", {"blob": K.add_blob(bytes(body)), "format": fmt, "name": stem, "to_solid": q.get("to_solid") == "1"})
            else:
                raise K.BadParams("supported: .step .stp .iges .igs .stl .obj .glb .3mf .wrl .wrz .nrk")
            version += 1
            return _json(_state())
        b = json.loads(body or b"{}")
        if path == "/api/exec":
            if b.get("preview"):
                return _json({"scene": K.scene(doc.preview(b["cmd"], b.get("params", {})))})
            f = doc.execute(b["cmd"], b.get("params", {}))
            version += 1
            return _json({"feature": f, **_state()})
        if path == "/api/limits":
            lim = doc.limit(b["cmd"], b.get("params", {}), b["param"], float(b["lo"]), float(b["hi"]), b.get("direction"), min(int(b.get("iters", 10)), 12))
            return _json({"max": lim})
        if path == "/api/measure":
            return _json(K.measure(doc, str(b.get("kind", "")), b.get("params", {})))
        if path == "/api/settings":
            doc.set_units(b.get("units"))
            version += 1
            return _json(_state(False))
        if path == "/api/feature":
            if b.get("preview"):
                return _json({"scene": K.scene(doc.preview_update(int(b["id"]), b.get("params", {})))})
            if b.get("delete"):
                doc.delete(int(b["id"]))
            else:
                doc.update(int(b["id"]), b.get("params"), b.get("suppressed"))
            version += 1
            return _json(_state())
        if path in ("/api/undo", "/api/redo"):
            (doc.undo if path.endswith("undo") else doc.redo)()
            version += 1
            return _json(_state())
        if path == "/api/new":
            doc.load_json({"features": []})
            version += 1
            return _json(_state())
        return _json({"error": "not found"}, 404)
    except Exception as e:  # kernel failures are expected while dragging; report, never crash
        msg = str(e) if isinstance(e, K.BadParams) else f"{type(e).__name__}: {e}"
        errors.append({"time": time.strftime("%H:%M:%S"), "path": path, "cmd": (b or {}).get("cmd") if isinstance(b, dict) else None,
                       "preview": bool(isinstance(b, dict) and b.get("preview")), "error": msg})
        return _json({"error": msg}, 400)
