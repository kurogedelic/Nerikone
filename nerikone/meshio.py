"""Readers for triangle meshes in OBJ, binary glTF (.glb) and 3MF. Standard library + numpy only (they run in the browser build too).

Each reader returns (vertices (n, 3) float, triangles (m, 3) int), everything in the file merged into one mesh. Materials, textures,
colours and animation are ignored; transforms of the scene graph (glTF nodes, 3MF build items and components) are applied.
"""
from __future__ import annotations

import io
import json
import struct
import zipfile
import xml.etree.ElementTree as ET

import numpy as np


class MeshError(ValueError):
    pass


def _merge(parts):
    parts = [(np.asarray(v, dtype=float).reshape(-1, 3), np.asarray(t, dtype=np.int64).reshape(-1, 3)) for v, t in parts if len(v) and len(t)]
    if not parts:
        raise MeshError("no triangles found in the file")
    verts, tris, off = [], [], 0
    for v, t in parts:
        verts.append(v)
        tris.append(t + off)
        off += len(v)
    return np.vstack(verts), np.vstack(tris)


# ---------------------------------------------------------------- OBJ

def read_obj(data: bytes):
    verts, tris = [], []
    for raw in data.decode("utf-8", errors="replace").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        k, _, rest = line.partition(" ")
        if k == "v":
            c = rest.split()
            if len(c) >= 3:
                verts.append([float(c[0]), float(c[1]), float(c[2])])
        elif k == "f":
            idx = []
            for tok in rest.split():
                i = int(tok.split("/")[0])
                idx.append(i - 1 if i > 0 else len(verts) + i)  # negative indices count from the end
            for j in range(1, len(idx) - 1):  # polygons become fans
                tris.append([idx[0], idx[j], idx[j + 1]])
    if not verts:
        raise MeshError("no vertices found in the OBJ file")
    if tris and max(max(t) for t in tris) >= len(verts):
        raise MeshError("the OBJ file refers to a vertex that does not exist")
    return _merge([(verts, tris)])


# ---------------------------------------------------------------- glTF binary

_COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _accessor(j, bufs, i):
    a = j["accessors"][i]
    view = j["bufferViews"][a["bufferView"]]
    dt, n = np.dtype(_COMP[a["componentType"]]), _NCOMP[a["type"]]
    base = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride") or dt.itemsize * n
    buf = bufs[view["buffer"]]
    count = a["count"]
    if stride == dt.itemsize * n:
        out = np.frombuffer(buf, dtype=dt, count=count * n, offset=base).reshape(count, n)
    else:  # interleaved
        out = np.stack([np.frombuffer(buf, dtype=dt, count=n, offset=base + k * stride) for k in range(count)])
    return out.astype(np.float64 if dt == np.float32 else np.int64)


def _node_matrix(nd):
    if "matrix" in nd:
        return np.array(nd["matrix"], dtype=float).reshape(4, 4).T  # column-major
    m = np.eye(4)
    if "scale" in nd:
        m = np.diag([*nd["scale"], 1.0]) @ m
    if "rotation" in nd:
        x, y, z, w = nd["rotation"]
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        q = np.eye(4)
        q[:3, :3] = r
        m = q @ m
    if "translation" in nd:
        t = np.eye(4)
        t[:3, 3] = nd["translation"]
        m = t @ m
    return m


def read_glb(data: bytes):
    if len(data) < 20 or data[:4] != b"glTF":
        raise MeshError("not a binary glTF (.glb) file")
    j, binchunk, pos = None, None, 12
    while pos + 8 <= len(data):
        ln, kind = struct.unpack_from("<II", data, pos)
        body = data[pos + 8: pos + 8 + ln]
        if kind == 0x4E4F534A:
            j = json.loads(body.decode("utf-8"))
        elif kind == 0x004E4942 and binchunk is None:
            binchunk = body
        pos += 8 + ln + (-ln % 4)
    if j is None:
        raise MeshError("the glTF file has no JSON chunk")
    if any("KHR_draco_mesh_compression" in (p.get("extensions") or {}) for m in j.get("meshes", []) for p in m.get("primitives", [])):
        raise MeshError("Draco-compressed glTF is not supported")
    bufs = [binchunk if "uri" not in b else b"" for b in j.get("buffers", [])]
    parts = []

    def visit(i, parent):
        nd = j["nodes"][i]
        m = parent @ _node_matrix(nd)
        if "mesh" in nd:
            for prim in j["meshes"][nd["mesh"]]["primitives"]:
                if prim.get("mode", 4) != 4:
                    continue
                v = _accessor(j, bufs, prim["attributes"]["POSITION"])
                t = _accessor(j, bufs, prim["indices"]).reshape(-1) if "indices" in prim else np.arange(len(v))
                v = (np.hstack([v, np.ones((len(v), 1))]) @ m.T)[:, :3]
                parts.append((v, t.reshape(-1, 3)))
        for c in nd.get("children", []):
            visit(c, m)

    scenes = j.get("scenes") or []
    roots = scenes[j.get("scene", 0)]["nodes"] if scenes else range(len(j.get("nodes", [])))
    # glTF is Y-up and in metres. A node named "z-up, mm" (as smlibpy writes it) says the file was made Z-up in millimetres:
    # undo that wrapper (its rotation and its 0.001 scale) so the model comes back as it was modelled.
    for r in roots:
        nd = j["nodes"][r]
        if str(nd.get("name", "")).startswith("z-up") and nd.get("children"):
            for c in nd["children"]:
                visit(c, np.eye(4))
        else:
            visit(r, np.eye(4))
    return _merge(parts)


# ---------------------------------------------------------------- 3MF

def _tr(txt):
    if not txt:
        return np.eye(4)
    v = [float(x) for x in txt.split()]
    if len(v) != 12:
        return np.eye(4)
    m = np.eye(4)
    m[:3, :3] = np.array(v[:9]).reshape(3, 3).T  # 3MF uses row vectors: [x y z 1] * M
    m[:3, 3] = v[9:12]
    return m


def read_3mf(data: bytes):
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise MeshError("not a 3MF file (not a zip archive)") from None
    names = z.namelist()
    model = next((n for n in names if n.lower().endswith("3d/3dmodel.model")), None) or next((n for n in names if n.lower().endswith(".model")), None)
    if model is None:
        raise MeshError("the 3MF file has no model part")
    root = ET.fromstring(z.read(model))
    ns = root.tag[1:root.tag.index("}")] if root.tag.startswith("{") else ""
    q = lambda t: f"{{{ns}}}{t}" if ns else t  # noqa: E731
    objs = {}
    for o in root.iter(q("object")):
        mesh = o.find(q("mesh"))
        entry = {"mesh": None, "comps": []}
        if mesh is not None:
            vs = [[float(v.get("x")), float(v.get("y")), float(v.get("z"))] for v in mesh.iter(q("vertex"))]
            ts = [[int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))] for t in mesh.iter(q("triangle"))]
            entry["mesh"] = (vs, ts)
        for c in o.iter(q("component")):
            entry["comps"].append((c.get("objectid"), _tr(c.get("transform"))))
        objs[o.get("id")] = entry
    parts = []

    def emit(oid, m, depth=0):
        o = objs.get(oid)
        if o is None or depth > 8:
            return
        if o["mesh"]:
            v = np.asarray(o["mesh"][0], dtype=float).reshape(-1, 3)
            parts.append(((np.hstack([v, np.ones((len(v), 1))]) @ m.T)[:, :3], o["mesh"][1]))
        for cid, cm in o["comps"]:
            emit(cid, m @ cm, depth + 1)

    items = list(root.iter(q("item")))
    for it in items:
        emit(it.get("objectid"), _tr(it.get("transform")))
    if not items:  # no build section: take every mesh object
        for oid in objs:
            emit(oid, np.eye(4))
    return _merge(parts)
