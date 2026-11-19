"""Minimal VRML (.wrl / .wrz) reader and writer for triangle meshes. Standard library + numpy only.

Reads VRML 2.0 / VRML97 and VRML 1.0 geometry: IndexedFaceSet with Coordinate / Coordinate3 points, nested in
Transform / Group / Separator nodes (translation, rotation, scale, center), with DEF / USE. Polygons are
triangulated as fans. Gzip-compressed files are accepted. Everything else (materials, textures, lights,
primitives such as Box or Sphere) is ignored.
"""
from __future__ import annotations

import gzip
import math
import re

import numpy as np

_TOKEN = re.compile(r'"(?:[^"\\]|\\.)*"|[\[\]{}]|[^\s\[\]{},"]+')


def _tokens(text: str):
    text = re.sub(r"#[^\n]*", " ", text)  # comments (also the "#VRML V2.0 utf8" header)
    return _TOKEN.findall(text)


class _Parser:
    def __init__(self, toks):
        self.t, self.i, self.defs = toks, 0, {}

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def next(self):
        tok = self.peek()
        self.i += 1
        return tok

    def node(self):
        """Parse `[DEF name] Type { fields }` or `USE name` into a dict."""
        tok = self.next()
        if tok == "USE":
            return self.defs.get(self.next(), {"type": "?"})
        name = None
        if tok == "DEF":
            name, tok = self.next(), self.next()
        n = {"type": tok, "fields": {}, "children": []}
        if self.peek() != "{":
            return n
        self.next()
        while self.peek() not in ("}", None):
            key = self.next()
            if key in ("ROUTE",):  # ROUTE a.b TO c.d
                self.i += 3
                continue
            if key[:1].isupper():
                # field names are lower case; an upper-case word here is a child node written directly inside its
                # parent, as VRML 1.0 does (Separator { Coordinate3 {...} IndexedFaceSet {...} }), or DEF / USE
                self.i -= 1
                n["children"].append(self.node())
                continue
            n["fields"][key] = self.value()
        self.next()  # }
        if name:
            self.defs[name] = n
        return n

    def value(self):
        tok = self.peek()
        if tok == "[":
            self.next()
            items = []
            while self.peek() not in ("]", None):
                p = self.peek()
                if p in ("DEF", "USE") or (p and p[:1].isupper() and self.t[self.i + 1:self.i + 2] == ["{"]):
                    items.append(self.node())
                else:
                    items.append(self.next())
            self.next()
            return items
        if tok in ("DEF", "USE") or (tok and tok[:1].isupper() and self.t[self.i + 1:self.i + 2] == ["{"]):
            return self.node()
        if tok == "NULL":
            self.next()
            return None
        # a single field value: SFVec3f etc. are several numbers in a row
        vals = []
        while self.peek() is not None and re.fullmatch(r"[-+0-9.eE]+", self.peek() or ""):
            vals.append(self.next())
        if vals:
            return vals
        return self.next()


def _num(v):
    return [float(x) for x in (v if isinstance(v, list) else [v]) if not isinstance(x, dict)]


def _rot(axis_angle):
    x, y, z, a = axis_angle
    n = math.sqrt(x * x + y * y + z * z) or 1.0
    x, y, z = x / n, y / n, z / n
    c, s, t = math.cos(a), math.sin(a), 1 - math.cos(a)
    return np.array([[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                     [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                     [t * x * z - s * y, t * y * z + s * x, t * z * z + c]])


def _matrix(f):
    M = np.eye(4)
    T = _num(f.get("translation", [0, 0, 0])) or [0, 0, 0]
    C = _num(f.get("center", [0, 0, 0])) or [0, 0, 0]
    S = _num(f.get("scale", f.get("scaleFactor", [1, 1, 1]))) or [1, 1, 1]
    Rv = _num(f.get("rotation", [0, 0, 1, 0])) or [0, 0, 1, 0]
    m = np.eye(4); m[:3, 3] = T; M = M @ m
    m = np.eye(4); m[:3, 3] = C; M = M @ m
    m = np.eye(4); m[:3, :3] = _rot(Rv); M = M @ m
    m = np.eye(4); m[:3, :3] = np.diag(S); M = M @ m
    m = np.eye(4); m[:3, 3] = [-c for c in C]; M = M @ m
    return M


def _children(n):
    out = list(n.get("children", []))
    for key in ("children", "geometry", "coord", "choice", "level"):
        v = n.get("fields", {}).get(key)
        if isinstance(v, dict):
            out.append(v)
        elif isinstance(v, list):
            out.extend(x for x in v if isinstance(x, dict))
    return out


def read(data: bytes) -> tuple[np.ndarray, np.ndarray]:
    """Vertices (n, 3) and triangles (m, 3) of all faces in a VRML file."""
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    text = data.decode("utf-8", "replace")
    if not text.lstrip().startswith("#VRML"):
        raise ValueError("not a VRML file (no #VRML header)")
    p = _Parser(_tokens(text))
    roots = []
    while p.peek() is not None:
        tok = p.peek()
        if tok in ("ROUTE",):
            p.i += 4
            continue
        if tok in ("PROTO", "EXTERNPROTO"):
            raise ValueError("VRML PROTO definitions are not supported")
        roots.append(p.node())

    verts, tris = [], []

    def walk(n, M, state):
        t = n.get("type")
        f = n.get("fields", {})
        if t in ("Transform", "MatrixTransform"):
            M = M @ _matrix(f) if t == "Transform" else M @ np.array(_num(f.get("matrix", []))).reshape(4, 4).T
        if t in ("Separator", "TransformSeparator"):
            state = dict(state)
        if t in ("Translation", "Rotation", "Scale"):  # VRML 1.0 transforms apply to the following siblings
            state["M"] = state["M"] @ _matrix(f)
        if t in ("Coordinate", "Coordinate3"):
            state["coord"] = np.array(_num(f.get("point", [])), float).reshape(-1, 3)
        if t == "IndexedFaceSet":
            coord_node = f.get("coord")
            pts = np.array(_num(coord_node["fields"].get("point", [])), float).reshape(-1, 3) if isinstance(coord_node, dict) \
                else state.get("coord")
            if pts is not None and len(pts):
                Mt = M @ state["M"]
                pts = (np.c_[pts, np.ones(len(pts))] @ Mt.T)[:, :3]
                base = sum(len(v) for v in verts)
                verts.append(pts)
                face = []
                for x in _num(f.get("coordIndex", [])) + [-1]:
                    i = int(x)
                    if i < 0:
                        tris.extend([base + face[0], base + face[k], base + face[k + 1]] for k in range(1, len(face) - 1))
                        face = []
                    elif i < len(pts):
                        face.append(i)
        for c in _children(n):
            if c is not f.get("coord"):
                walk(c, M, state)

    state = {"M": np.eye(4), "coord": None}
    for r in roots:
        walk(r, np.eye(4), state)
    if not tris:
        raise ValueError("no IndexedFaceSet geometry found in the VRML file")
    return np.vstack(verts), np.array(tris, dtype=np.int64)


def write(meshes: list[tuple[str, np.ndarray, np.ndarray]]) -> bytes:
    """VRML97 text with one Shape per (name, vertices, triangles)."""
    out = ["#VRML V2.0 utf8", "# written by Nerikone"]
    for name, v, t in meshes:
        safe = re.sub(r"[^A-Za-z0-9_]", "_", name) or "body"
        pts = ",\n".join(f"{a:.6g} {b:.6g} {c:.6g}" for a, b, c in v)
        idx = ",\n".join(f"{a}, {b}, {c}, -1" for a, b, c in t)
        out.append(f"DEF {safe} Shape {{\n appearance Appearance {{ material Material {{ diffuseColor 0.7 0.72 0.76 }} }}\n"
                   f" geometry IndexedFaceSet {{\n  solid FALSE\n  coord Coordinate {{ point [\n{pts}\n  ] }}\n"
                   f"  coordIndex [\n{idx}\n  ]\n }}\n}}")
    return ("\n".join(out) + "\n").encode()
