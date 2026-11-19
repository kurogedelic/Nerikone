"""Nerikone document model: a parametric feature timeline over the SMLib kernel.

Every user-visible operation is a *command* (id, typed params, schema). The UI, the HTTP API and the
MCP server all go through the same commands, so whatever a person can do, an agent can do too.

A document is an ordered list of features ``{id, cmd, params, suppressed}``. Rebuilding replays them;
editing any feature's params rebuilds from that point (parametric). Direct-modeling edits (push/pull,
fillet, ...) are features as well. Faces and edges are referenced by a *point on them* (not by index),
so references survive upstream changes as long as the geometry is still near that point.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
import os
import tempfile
from dataclasses import dataclass, field
from typing import Any, Callable

import smlibpy as sm

import vrml

# ---------------------------------------------------------------- command registry


@dataclass
class P:
    name: str
    type: str  # float int bool str enum vec3 points grid sections body bodies face_ref edge_refs blob
    default: Any = None
    doc: str = ""
    min: float | None = None
    max: float | None = None
    options: list | None = None

    def schema(self):
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class Command:
    id: str
    label: str
    group: str
    doc: str
    params: list[P]
    run: Callable[[dict, dict], None]  # (bodies, params) -> mutates bodies
    creates: bool = False  # creates a new body named params["name"]

    def schema(self):
        return {"id": self.id, "label": self.label, "group": self.group, "doc": self.doc,
                "creates": self.creates, "params": [p.schema() for p in self.params]}


COMMANDS: dict[str, Command] = {}


def command(id, label, group, doc, params, creates=False):
    def deco(fn):
        ps = list(params)
        if creates:
            ps.append(P("name", "str", "", "Name of the new body (auto if empty)"))
        COMMANDS[id] = Command(id, label, group, doc, ps, fn, creates)
        return fn
    return deco


class BadParams(ValueError):
    pass


def _vec(v, n=3):
    if not isinstance(v, (list, tuple)) or len(v) != n:
        raise BadParams(f"expected {n} numbers, got {v!r}")
    out = tuple(float(x) for x in v)
    if not all(math.isfinite(x) for x in out):
        raise BadParams("non-finite number")
    return out


def coerce(cmd: Command, params: dict) -> dict:
    """Validate and normalise params (hostile input: raise BadParams, never crash)."""
    out = {}
    known = {p.name for p in cmd.params}
    for k in params:
        if k not in known:
            raise BadParams(f"{cmd.id}: unknown param '{k}' (known: {sorted(known)})")
    for p in cmd.params:
        v = params.get(p.name, copy.deepcopy(p.default))
        if v is None:
            raise BadParams(f"{cmd.id}: param '{p.name}' is required")
        try:
            if p.type == "float":
                v = float(v)
                if not math.isfinite(v):
                    raise BadParams("non-finite")
            elif p.type == "int":
                v = int(v)
            elif p.type == "bool":
                v = bool(v)
            elif p.type in ("str", "body", "blob"):
                v = str(v)
            elif p.type == "enum":
                if v not in p.options:
                    raise BadParams(f"must be one of {p.options}")
            elif p.type in ("vec3", "face_ref"):
                v = list(_vec(v))
            elif p.type in ("points", "edge_refs"):
                v = [list(_vec(q, len(q) if len(q) in (2, 3) else 3)) for q in v]
            elif p.type == "grid":
                v = [[list(_vec(q)) for q in row] for row in v]
                if len(v) < 2 or len({len(r) for r in v}) != 1 or len(v[0]) < 2:
                    raise BadParams("grid must be rectangular, at least 2x2")
            elif p.type == "sections":
                v = [[str(s[0]), float(s[1]), float(s[2])] for s in v]
                if len(v) < 2:
                    raise BadParams("need at least 2 sections")
            elif p.type == "bodies":
                v = [str(x) for x in v]
        except BadParams as e:
            raise BadParams(f"{cmd.id}.{p.name}: {e}") from None
        except (TypeError, ValueError) as e:
            raise BadParams(f"{cmd.id}.{p.name}: {e}") from None
        if p.min is not None and isinstance(v, (int, float)) and v < p.min:
            raise BadParams(f"{cmd.id}.{p.name}: must be >= {p.min}")
        if p.max is not None and isinstance(v, (int, float)) and v > p.max:
            raise BadParams(f"{cmd.id}.{p.name}: must be <= {p.max}")
        out[p.name] = v
    return out


# ---------------------------------------------------------------- helpers


def _body(bodies, name, kinds=(sm.Part,)):
    if name not in bodies:
        raise BadParams(f"no body named '{name}' (have: {sorted(bodies)})")
    b = bodies[name]
    if not isinstance(b, kinds):
        raise BadParams(f"body '{name}' is a {type(b).__name__}; this needs {'/'.join(k.__name__ for k in kinds)}")
    return b


def face_at(part, pt):
    return min(part.faces(), key=lambda f: f.distance_to(tuple(pt)))


def edges_at(part, pts):
    es = part.edges()
    return [min(es, key=lambda e: e.distance_to(tuple(q))) for q in pts]


def _place(shape, at):
    return shape.translate(*at) if any(at) else shape


def _section(spec):
    kind, size, z = spec[0], spec[1], spec[2]
    sk = sm.Circle(size) if kind == "circle" else sm.Rectangle(size * 2, size * 2) if kind == "square" \
        else sm.RegularPolygon(size, int(kind[1:])) if kind.startswith("n") else None
    if sk is None:
        raise BadParams(f"section kind must be circle, square or nK (e.g. n6); got {kind}")
    return sk.moved(sm.Pos(0, 0, z))


# ---------------------------------------------------------------- commands: primitives

AT = P("at", "vec3", [0, 0, 0], "Centre position")


@command("body.box", "Box", "Create", "A box centred at `at`.",
         [P("length", "float", 2, "X size", 1e-6), P("width", "float", 2, "Y size", 1e-6),
          P("height", "float", 2, "Z size", 1e-6), AT], creates=True)
def _box(B, p):
    B[p["name"]] = _place(sm.Box(p["length"], p["width"], p["height"]), p["at"])


@command("body.cylinder", "Cylinder", "Create", "A cylinder along Z.",
         [P("radius", "float", 1, "", 1e-6), P("height", "float", 2, "", 1e-6), AT], creates=True)
def _cyl(B, p):
    B[p["name"]] = _place(sm.Cylinder(p["radius"], p["height"]), p["at"])


@command("body.sphere", "Sphere", "Create", "A sphere.", [P("radius", "float", 1, "", 1e-6), AT], creates=True)
def _sph(B, p):
    B[p["name"]] = _place(sm.Sphere(p["radius"]), p["at"])


@command("body.cone", "Cone", "Create", "A cone or frustum along Z.",
         [P("bottom_radius", "float", 1, "", 0), P("top_radius", "float", 0.3, "", 0),
          P("height", "float", 2, "", 1e-6), AT], creates=True)
def _cone(B, p):
    B[p["name"]] = _place(sm.Cone(p["bottom_radius"], p["top_radius"], p["height"]), p["at"])


@command("body.torus", "Torus", "Create", "A torus around Z.",
         [P("major_radius", "float", 1.5, "", 1e-6), P("minor_radius", "float", 0.4, "", 1e-6), AT], creates=True)
def _tor(B, p):
    B[p["name"]] = _place(sm.Torus(p["major_radius"], p["minor_radius"]), p["at"])


@command("sketch.extrude", "Extrude polygon", "Create",
         "Extrude a closed 2D polygon (XY points, on the plane z = `z`) by `height`. `fillet` rounds its corners.",
         [P("points", "points", [[-1, -1], [1, -1], [1, 0.2], [0, 1], [-1, 0.2]], "2D outline"),
          P("height", "float", 1, "", 1e-6), P("z", "float", 0), P("fillet", "float", 0, "corner radius", 0),
          P("taper", "float", 0, "draft angle in degrees")], creates=True)
def _ext(B, p):
    pts = [tuple(q[:2]) for q in p["points"]]
    if len(pts) < 3:
        raise BadParams("need at least 3 points")
    sk = sm.Polygon(*pts, fillet=p["fillet"]).moved(sm.Pos(0, 0, p["z"]))
    B[p["name"]] = sm.extrude(sk, p["height"], taper=p["taper"])


# ---------------------------------------------------------------- commands: sketch regions
# A region is a flat sheet (Sketch) lying on a plane: the ground or a planar face. Pushing/pulling it with
# region.extrude makes a solid, or adds to / cuts from the body it was drawn on.

PLANE = [P("origin", "vec3", [0, 0, 0], "plane origin"), P("normal", "vec3", [0, 0, 1], "plane normal"),
         P("xdir", "vec3", [1, 0, 0], "plane X direction"),
         P("on_body", "str", "", "body the sketch was drawn on (target of a later push/pull)")]


def _touching_body(B, region, own):
    """The solid whose surface the region lies on (so pushing it adds to / cuts from that solid)."""
    c = region.faces()[0].center()
    for name, b in B.items():
        if name != own and isinstance(b, sm.Part):
            try:
                if b.distance_to(c) < 1e-6:
                    return name
            except Exception:
                continue
    return ""


def _region(shape, p):
    """Remember which body a region was drawn on, so pushing it adds to / cuts from that body."""
    try:
        shape.nk_on_body = p["on_body"]
    except AttributeError:
        pass
    return shape


def _plane(p):
    n = sm.Vector(*p["normal"])
    if n.length < 1e-9:
        raise BadParams("normal must not be zero")
    x = sm.Vector(*p["xdir"])
    x = x - n.normalized() * x.dot(n.normalized())  # make X perpendicular to the normal
    if x.length < 1e-9:
        raise BadParams("xdir must not be parallel to the normal")
    return sm.Plane(tuple(p["origin"]), tuple(x.normalized()), tuple(n.normalized()))


@command("sketch.rect", "Rectangle", "Sketch", "A rectangular region on a plane; x, y is its centre in plane coordinates.",
         [*PLANE, P("x", "float", 0), P("y", "float", 0), P("width", "float", 1, "", 1e-6), P("height", "float", 1, "", 1e-6),
          P("fillet", "float", 0, "corner radius", 0)], creates=True)
def _srect(B, p):
    B[p["name"]] = _region(sm.Rectangle(p["width"], p["height"], fillet=p["fillet"]).translate(p["x"], p["y"], 0).on(_plane(p)), p)


@command("sketch.circle", "Circle", "Sketch", "A circular region on a plane; x, y is its centre in plane coordinates.",
         [*PLANE, P("x", "float", 0), P("y", "float", 0), P("radius", "float", 0.5, "", 1e-6)], creates=True)
def _scirc(B, p):
    B[p["name"]] = _region(sm.Circle(p["radius"]).translate(p["x"], p["y"], 0).on(_plane(p)), p)


@command("sketch.polygon", "Polygon", "Sketch", "A closed polygonal region on a plane (points in plane coordinates).",
         [*PLANE, P("points", "points", [[0, 0], [1, 0], [0.5, 1]], "[x, y] outline")], creates=True)
def _spoly(B, p):
    pts = [tuple(q[:2]) for q in p["points"]]
    if len(pts) < 3:
        raise BadParams("need at least 3 points")
    B[p["name"]] = _region(sm.Polygon(*pts, align=None).on(_plane(p)), p)


@command("region.extrude", "Push/pull region", "Sketch",
         "Extrude a sketch region by `amount` along its plane normal. mode auto: a region drawn on a body is added to "
         "it when pulled out (amount > 0) and cut from it when pushed in; otherwise it becomes a new solid.",
         [P("body", "body", "", "the region"), P("amount", "float", 1), P("mode", "enum", "auto", options=["auto", "new", "union", "cut"]),
          P("target", "str", "", "body to add to / cut from (default: the body it was drawn on)")])
def _rext(B, p):
    region = _body(B, p["body"], (sm.Sketch, sm.Shell))
    if abs(p["amount"]) < 1e-9:
        raise BadParams("amount must not be 0")
    solid = sm.extrude(region, p["amount"])
    target = p["target"] or getattr(region, "nk_on_body", "") or _touching_body(B, region, p["body"])
    mode = p["mode"]
    if mode == "auto":
        mode = ("union" if p["amount"] > 0 else "cut") if target and target in B else "new"
    if mode == "new":
        B[p["body"]] = solid
        return
    t = _body(B, target)
    B[target] = t.fuse(solid) if mode == "union" else t.cut(solid)
    B.pop(p["body"], None)


# ---------------------------------------------------------------- commands: NURBS

@command("nurbs.surface", "NURBS surface", "NURBS",
         "A freeform NURBS surface interpolating a grid of points (rows x cols of [x,y,z]). "
         "With thickness > 0 it is thickened into a solid.",
         [P("grid", "grid", [[[x - 1.5, y - 1.5, 0.6 if (x, y) in ((1, 1), (2, 2)) else 0] for x in range(4)] for y in range(4)],
            "control grid"), P("thickness", "float", 0.15, "0 keeps a sheet", 0)], creates=True)
def _surf(B, p):
    s = sm.surface([[tuple(q) for q in row] for row in p["grid"]])
    t = p["thickness"]
    if t <= 0:
        B[p["name"]] = s
        return
    # Offsetting into a tighter curvature than t fails; then grow the wall to both sides, then to the other side.
    err = None
    for args in ((t, False), (t, True), (-t, False)):
        try:
            B[p["name"]] = sm.thicken(s, args[0], both=args[1])
            return
        except Exception as e:
            err = e
    raise BadParams(f"cannot thicken this surface by {t} (curvature too tight); use a smaller thickness or 0") from err


@command("nurbs.loft", "Loft", "NURBS",
         "A smooth solid through cross sections. Each section is [kind, size, z] with kind circle, square or nK "
         "(regular K-gon).",
         [P("sections", "sections",[["circle", 1, 0], ["square", 0.8, 1.5], ["circle", 0.5, 3]], "sections"),
          P("ruled", "bool", False, "straight between sections")], creates=True)
def _loft(B, p):
    B[p["name"]] = sm.loft([_section(s) for s in p["sections"]], ruled=p["ruled"])


@command("nurbs.revolve", "Revolve", "NURBS",
         "Revolve a profile around Z. Points are [r, z] (r >= 0); the profile is closed through the axis.",
         [P("points", "points", [[1, 0], [1.2, 1], [0.6, 2], [0.8, 3]], "[r, z] profile"),
          P("angle", "float", 360, "", 1, 360)], creates=True)
def _rev(B, p):
    pts = [tuple(q[:2]) for q in p["points"]]
    if any(r < 0 for r, _ in pts):
        raise BadParams("radius must be >= 0")
    prof = [(0, pts[0][1])] + pts + [(0, pts[-1][1])]
    sk = sm.Polygon(*prof).rotate(sm.Axis.X, 90)
    B[p["name"]] = sm.revolve(sk, sm.Axis.Z, p["angle"])


# ---------------------------------------------------------------- commands: direct modeling

@command("face.move", "Push/pull face", "Modify",
         "Move the face nearest `at` by vector `by`; neighbouring faces extend or trim to follow.",
         [P("body", "body", "", ""), P("at", "face_ref", None, "a point on the face"), P("by", "vec3", None, "")])
def _mv(B, p):
    b = _body(B, p["body"])
    f = face_at(b, p["at"])
    try:
        B[p["body"]] = b.move_faces(f, tuple(p["by"]))
    except Exception:
        # Tangent neighbours (e.g. a fillet on the face) must move with it, as in any direct modeler.
        B[p["body"]] = b.move_faces(tangent_chain(b, f), tuple(p["by"]))


def tangent_chain(part, face):
    """The face plus every face reachable from it across tangent (G1/G2) edges."""
    key = lambda f: tuple(round(c, 6) for c in f.center()) + (round(f.area, 6),)
    faces = {key(f): f for f in part.faces()}
    seen, todo = {key(face)}, [face]
    while todo:
        f = todo.pop()
        for e in f.edges():
            try:
                if e.continuity().level not in ("G1", "G2"):
                    continue
                nbrs = e.faces()
            except Exception:
                continue
            for n in nbrs:
                k = key(n)
                if k not in seen and k in faces:
                    seen.add(k)
                    todo.append(faces[k])
    return [faces[k] for k in seen]


@command("edge.fillet", "Fillet", "Modify", "Round the edges nearest the given points.",
         [P("body", "body", ""), P("edges", "edge_refs", None, "points on the edges"), P("radius", "float", 0.2, "", 1e-6)])
def _fil(B, p):
    b = _body(B, p["body"])
    B[p["body"]] = b.fillet(edges_at(b, p["edges"]), p["radius"])


@command("edge.chamfer", "Chamfer", "Modify", "Bevel the edges nearest the given points.",
         [P("body", "body", ""), P("edges", "edge_refs", None), P("length", "float", 0.2, "", 1e-6)])
def _cha(B, p):
    b = _body(B, p["body"])
    B[p["body"]] = b.chamfer(edges_at(b, p["edges"]), p["length"])


@command("body.shell", "Shell", "Modify", "Hollow the body to walls of `thickness`, opening the face nearest `open_at`.",
         [P("body", "body", ""), P("thickness", "float", 0.1, "", 1e-6), P("open_at", "face_ref", None)])
def _shell(B, p):
    b = _body(B, p["body"])
    B[p["body"]] = b.shell(p["thickness"], face_at(b, p["open_at"]))


@command("body.boolean", "Boolean", "Modify",
         "Combine `tool` bodies into `target`: union, cut or intersect. Tools are consumed unless keep_tools.",
         [P("kind", "enum", "cut", options=["union", "cut", "intersect"]), P("target", "body", ""),
          P("tools", "bodies", []), P("keep_tools", "bool", False)])
def _bool(B, p):
    t = _body(B, p["target"])
    tools = [_body(B, n) for n in p["tools"]]
    if not tools:
        raise BadParams("no tools")
    B[p["target"]] = {"union": t.fuse, "cut": t.cut, "intersect": t.intersect}[p["kind"]](*tools)
    if not p["keep_tools"]:
        for n in p["tools"]:
            B.pop(n, None)


@command("body.transform", "Transform", "Modify",
         "Scale (uniform) and rotate (degrees about X, Y, Z) around `pivot`, then translate a body.",
         [P("body", "body", ""), P("translate", "vec3", [0, 0, 0]), P("rotate", "vec3", [0, 0, 0]),
          P("scale", "float", 1, "uniform factor", 1e-6), P("pivot", "vec3", [0, 0, 0], "centre of rotation/scale")])
def _tr(B, p):
    b = _body(B, p["body"], (sm.Part, sm.Shell, sm.Mesh))
    c = tuple(p["pivot"])
    if p["scale"] != 1:
        b = b.scale(p["scale"], c)
    if any(p["rotate"]):
        b = b.translate(*(-x for x in c)).moved(sm.Rot(*p["rotate"])).translate(*c)
    B[p["body"]] = b.translate(*p["translate"]) if any(p["translate"]) else b


@command("body.duplicate", "Duplicate", "Modify", "Copy a body, offset by `offset`.",
         [P("body", "body", ""), P("offset", "vec3", [0, 0, 0])], creates=True)
def _dup(B, p):
    b = _body(B, p["body"], (sm.Part, sm.Shell, sm.Mesh))
    B[p["name"]] = b.translate(*p["offset"]) if any(p["offset"]) else b.translate(0, 0, 0)


FINISHES = ["plastic", "metal", "glass", "rubber", "clay"]


@command("body.material", "Material", "Appearance",
         "Set a body's colour (kept in STEP / glTF / USD exports) and its finish (how the render view shades it).",
         [P("body", "body", ""), P("color", "str", "#9aa7bd", "CSS colour, e.g. #e0482f or steelblue"),
          P("finish", "enum", "plastic", options=FINISHES)])
def _mat(B, p):
    b = _body(B, p["body"], (sm.Part, sm.Shell, sm.Mesh))
    if not isinstance(b, sm.Mesh):  # meshes carry no colour in the kernel; the viewer still shows it
        try:
            b = b.colored(p["color"])
        except Exception as e:
            raise BadParams(f"bad colour {p['color']!r}: {e}") from None
    B[p["body"]] = b


@command("face.color", "Face colour", "Appearance", "Colour the face nearest `at` (kept through later edits and in exports).",
         [P("body", "body", ""), P("at", "face_ref", None), P("color", "str", "#e0482f")])
def _fcol(B, p):
    b = _body(B, p["body"], (sm.Part, sm.Shell))
    try:
        B[p["body"]] = b.colored(p["color"], faces=[face_at(b, p["at"])])
    except Exception as e:
        raise BadParams(f"bad colour {p['color']!r}: {e}") from None


@command("body.delete", "Delete body", "Modify", "Remove a body.", [P("body", "body", "")])
def _del(B, p):
    _body(B, p["body"], (sm.Part, sm.Shell, sm.Mesh))
    del B[p["body"]]


# ---------------------------------------------------------------- commands: files

BLOBS: dict[str, bytes] = {}  # content-addressed imported files (shared by all documents in the process)


def add_blob(data: bytes) -> str:
    h = hashlib.sha256(data).hexdigest()[:16]
    BLOBS[h] = data
    return h


@command("file.import", "Import STEP/STL", "File",
         "Bodies from an imported file (`blob` = id returned by the import endpoint). STEP gives exact B-rep "
         "solids/sheets; STL gives a display mesh unless to_solid.",
         [P("blob", "blob", ""), P("format", "enum", "step", options=["step", "stl", "wrl"]),
          P("to_solid", "bool", False, "STL only: convert the mesh to a solid")], creates=True)
def _imp(B, p):
    data = BLOBS.get(p["blob"])
    if data is None:
        raise BadParams(f"unknown blob {p['blob']}")
    if p["format"] in ("stl", "wrl"):
        m = sm.from_stl(data) if p["format"] == "stl" else sm.Mesh(*vrml.read(data))
        B[p["name"]] = m.to_part() if p["to_solid"] else m
        return
    r = sm.from_step(data)
    shapes = list(r) if isinstance(r, (list, tuple, sm.ShapeList)) else [r]
    for i, s in enumerate(shapes):
        B[p["name"] if i == 0 else f"{p['name']}.{i}"] = s


# ---------------------------------------------------------------- document

class Document:
    def __init__(self):
        self.features: list[dict] = []
        self.states: list[dict] = []  # bodies after each feature
        self.errors: dict[int, str] = {}
        self.next_id = 1
        self.undo_stack: list[str] = []
        self.redo_stack: list[str] = []

    # -- persistence
    def to_json(self, with_blobs=True):
        d = {"format": "nerikone/1", "features": self.features}
        if with_blobs:
            used = {f["params"].get("blob") for f in self.features if f["cmd"] == "file.import"}
            d["blobs"] = {h: base64.b64encode(BLOBS[h]).decode() for h in used if h in BLOBS}
        return d

    def load_json(self, d):
        for h, b in d.get("blobs", {}).items():
            BLOBS[h] = base64.b64decode(b)
        self._push_undo()
        self.features = d["features"]
        self.next_id = max([f["id"] for f in self.features] + [0]) + 1
        self.rebuild(0)

    def _push_undo(self):
        self.undo_stack.append(json.dumps(self.features))
        del self.undo_stack[:-100]
        self.redo_stack.clear()

    def undo(self):
        if self.undo_stack:
            self.redo_stack.append(json.dumps(self.features))
            self.features = json.loads(self.undo_stack.pop())
            self.rebuild(0)

    def redo(self):
        if self.redo_stack:
            self.undo_stack.append(json.dumps(self.features))
            self.features = json.loads(self.redo_stack.pop())
            self.rebuild(0)

    # -- evaluation
    @property
    def bodies(self) -> dict:
        return self.states[-1] if self.states else {}

    def _apply(self, bodies, f):
        out = dict(bodies)
        if not f.get("suppressed"):
            COMMANDS[f["cmd"]].run(out, f["params"])
        return out

    def rebuild(self, start=0):
        start = max(0, min(start, len(self.states)))
        self.states = self.states[:start]
        for i in range(start, len(self.features)):
            f = self.features[i]
            prev = self.states[-1] if self.states else {}
            self.errors.pop(f["id"], None)
            try:
                self.states.append(self._apply(prev, f))
            except Exception as e:  # a failed feature passes the model through, like any CAD timeline
                self.errors[f["id"]] = f"{type(e).__name__}: {e}"
                self.states.append(prev)

    def _auto_name(self, cmd, params):
        if cmd.creates and not params.get("name"):
            base = cmd.label.split()[0].replace("/", "")
            names = set(self.bodies) | {f["params"].get("name") for f in self.features}
            i = 1
            while f"{base}{i}" in names:
                i += 1
            params["name"] = f"{base}{i}"
        return params

    def preview(self, cmd_id, params):
        cmd = COMMANDS.get(cmd_id) or _unknown(cmd_id)
        p = coerce(cmd, self._auto_name(cmd, dict(params)))
        return self._apply(self.bodies, {"cmd": cmd_id, "params": p})

    def execute(self, cmd_id, params):
        """Append a feature. Raises (and appends nothing) if it fails."""
        cmd = COMMANDS.get(cmd_id) or _unknown(cmd_id)
        p = coerce(cmd, self._auto_name(cmd, dict(params)))
        f = {"id": self.next_id, "cmd": cmd_id, "params": p, "suppressed": False}
        new = self._apply(self.bodies, f)  # raises on failure
        self._push_undo()
        self.next_id += 1
        self.features.append(f)
        self.states.append(new)
        return f

    def _index(self, fid):
        for i, f in enumerate(self.features):
            if f["id"] == fid:
                return i
        raise BadParams(f"no feature {fid}")

    def update(self, fid, params=None, suppressed=None):
        i = self._index(fid)
        f = copy.deepcopy(self.features[i])
        if params is not None:
            cmd = COMMANDS[f["cmd"]]
            f["params"] = coerce(cmd, {**f["params"], **params})
        if suppressed is not None:
            f["suppressed"] = bool(suppressed)
        self._push_undo()
        self.features[i] = f
        self.rebuild(i)
        return f

    def limit(self, cmd_id, params, param, lo, hi, direction=None, iters=10):
        """The largest value of `param` in [lo, hi] for which the command builds (bisection; assumes that a value
        that works means smaller ones work too). None when even `lo` fails. With `direction`, the param is that
        vector scaled by the value (e.g. face.move `by`). iters=0 only checks `lo`."""
        def ok(v):
            p = dict(params)
            p[param] = (direction * v if isinstance(direction, (int, float)) else [d * v for d in direction]) if direction else v
            try:
                out = self.preview(cmd_id, p)
            except Exception:
                return False
            # a result the kernel built but that is degenerate (a face shrunk to a point, ...) counts as a failure
            before = self.bodies
            for name, body in out.items():
                if before.get(name) is not body and isinstance(body, sm.Part):
                    try:
                        if not body.is_valid(strict=True):
                            return False
                    except Exception:
                        return False
            return True
        # tiny values can fail where real ones work (a 0.001 deep cut is a zero-thickness sliver): probe upwards
        for start in (lo, lo * 10, lo * 100, hi * 0.05):
            if start <= hi and ok(start):
                lo = start
                break
        else:
            return None
        if iters <= 0:
            return lo
        if ok(hi):
            return hi
        a, b = lo, hi
        for _ in range(iters):
            m = (a + b) / 2
            if ok(m):
                a = m
            else:
                b = m
        return a

    def preview_update(self, fid, params):
        """Bodies as they would be with feature `fid`'s params changed (nothing is stored)."""
        i = self._index(fid)
        f = copy.deepcopy(self.features[i])
        f["params"] = coerce(COMMANDS[f["cmd"]], {**f["params"], **params})
        bodies = self.states[i - 1] if i else {}
        for g in [f] + self.features[i + 1:]:
            try:
                bodies = self._apply(bodies, g)
            except Exception:
                if g is f:
                    raise
        return bodies

    def delete(self, fid):
        i = self._index(fid)
        self._push_undo()
        del self.features[i]
        self.rebuild(i)

    # -- queries
    def _appearance(self, name):
        """Finish and (for meshes) colour from the latest working body.material feature of this body."""
        for f in reversed(self.features):
            if f["cmd"] == "body.material" and f["params"].get("body") == name and not f.get("suppressed") \
                    and f["id"] not in self.errors:
                return {"finish": f["params"]["finish"], "mat_color": f["params"]["color"]}
        return {}

    def summary(self):
        return {"features": [{**f, "label": COMMANDS[f["cmd"]].label, "error": self.errors.get(f["id"])}
                             for f in self.features],
                "bodies": {n: {**body_info(b), **self._appearance(n)} for n, b in self.bodies.items()},
                "can_undo": bool(self.undo_stack), "can_redo": bool(self.redo_stack)}


def _unknown(cid):
    raise BadParams(f"unknown command '{cid}' (see list_commands)")


def _v(v):
    return [round(v.x, 6), round(v.y, 6), round(v.z, 6)]


def hex_color(c):
    """Kernel colours come back as '#rrggbb', a CSS name or (r, g, b) floats; the viewer wants '#rrggbb'."""
    if c is None:
        return None
    if isinstance(c, str):
        return c if c.startswith("#") else c
    try:
        return "#" + "".join(f"{max(0, min(255, round(float(x) * 255))):02x}" for x in list(c)[:3])
    except Exception:
        return None


def body_info(b):
    bb = b.bbox()
    d = {"kind": type(b).__name__, "bbox": [list(bb.min), list(bb.max)], "color": hex_color(getattr(b, "color", None))}
    if isinstance(b, (sm.Part, sm.Shell)):
        d.update(faces=len(b.faces()), edges=len(b.edges()))
    if isinstance(b, sm.Part):
        d["volume"] = round(b.volume, 6)
    return d


def _face_point(f):
    try:
        return f.interior_point()
    except Exception:  # degenerate faces have no interior point
        return f.center()


def inspect_body(b):
    """Faces and edges with points an agent can pass back as face_ref / edge_refs."""
    d = body_info(b)
    if isinstance(b, (sm.Part, sm.Shell)):
        d["face_list"] = [{"type": f.geom_type, "point": _v(_face_point(f)),
                           "normal": _v(f.normal_at()) if f.is_planar else None, "area": round(f.area, 6)}
                          for f in b.faces()]
        d["edge_list"] = [{"type": e.geom_type, "point": _v(e.point_at(0.5)), "length": round(e.length, 6),
                           "convex": bool(e.is_convex) if hasattr(e, "is_convex") else None} for e in b.edges()]
    return d


# ---------------------------------------------------------------- tessellation for the viewer

_mesh_cache: dict[int, tuple[Any, dict]] = {}


def mesh_body(b):
    key = id(b)
    hit = _mesh_cache.get(key)
    if hit and hit[0] is b:
        return hit[1]
    if isinstance(b, sm.Mesh):
        d = {"faces": [{"verts": b.vertices.round(5).ravel().tolist(), "tris": b.triangles.ravel().tolist(),
                        "type": "mesh", "planar": False, "normal": None}], "edges": []}
    else:
        faces = []
        for f in b.faces():
            m = f.mesh()
            faces.append({"verts": m.vertices.round(5).ravel().tolist(), "tris": m.triangles.ravel().tolist(),
                          "type": f.geom_type, "planar": bool(f.is_planar), "color": hex_color(getattr(f, "color", None)),
                          "normal": _v(f.normal_at()) if f.is_planar else None})
        edges = []
        for e in b.edges():
            if getattr(e, "is_seam", False):
                continue
            k = 1 if e.geom_type == "line" else 40
            edges.append({"pts": [_v(e.point_at(j / k)) for j in range(k + 1)], "mid": _v(e.point_at(0.5))})
        d = {"faces": faces, "edges": edges}
    if len(_mesh_cache) > 256:
        _mesh_cache.clear()
    _mesh_cache[key] = (b, d)
    return d


def scene(bodies):
    return {n: {**mesh_body(b), "kind": type(b).__name__} for n, b in bodies.items()}


# ---------------------------------------------------------------- export

EXPORTS = {"wrl": "model/vrml", "step": "model/step", "stl": "model/stl", "glb": "model/gltf-binary", "usda": "model/vnd.usda", "nrk": "application/json"}


def export(doc: Document, fmt: str, names: list[str] | None = None) -> bytes:
    if fmt == "nrk":
        return json.dumps(doc.to_json()).encode()
    shapes = [b for n, b in doc.bodies.items() if not names or n in names]
    if not shapes:
        raise BadParams("nothing to export")
    if fmt == "step":
        return sm.to_step([s for s in shapes if not isinstance(s, sm.Mesh)]).encode()
    if fmt == "stl":
        return sm.to_stl(shapes)
    if fmt == "wrl":
        meshes = []
        for n, b in doc.bodies.items():
            if names and n not in names:
                continue
            m = b if isinstance(b, sm.Mesh) else b.mesh()
            meshes.append((n, m.vertices, m.triangles))
        return vrml.write(meshes)
    if fmt == "glb":
        return sm.to_glb(shapes)
    if fmt == "usda":
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "model.usda")
            sm.export_usd(shapes, path)
            with open(path, "rb") as fh:
                return fh.read()
    raise BadParams(f"format must be one of {sorted(EXPORTS)}")
