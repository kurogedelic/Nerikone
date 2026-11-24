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
import threading
import zipfile
import io
from dataclasses import dataclass, field
from typing import Any, Callable

import smlibpy as sm

import meshio
import vrml

# ---------------------------------------------------------------- command registry


@dataclass
class P:
    name: str
    type: str  # float int bool str enum vec3 points floats grid sections body bodies face_ref edge_refs blob
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
            elif p.type == "floats":
                v = [float(x) for x in v]
                if not all(math.isfinite(x) for x in v):
                    raise BadParams("non-finite")
            elif p.type == "bodies":
                v = [str(x) for x in v]
        except BadParams as e:
            raise BadParams(f"{cmd.id}.{p.name}: {e}") from None
        except (TypeError, ValueError, ArithmeticError, IndexError, KeyError) as e:
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


def _reach(part):
    """How far from a surface a reference point may be and still mean that surface. Generous on purpose: when an earlier step is edited the
    surfaces move, and a later step must still find 'its' face by nearness; only a point clearly outside the body (more than half its
    size away) is refused instead of silently acting on some face."""
    try:
        bb = part.bbox()
        return 0.5 * math.dist(tuple(bb.min), tuple(bb.max)) + 1e-4
    except Exception:
        return float("inf")


# ---- stable references
# A step names faces and edges by a point on them. When an earlier step is edited the surfaces move, and the face
# nearest the old point may be another one (a pulled top that is now lower than a side). So when a step runs for the
# first time (or its own parameters change) it also records what it picked: a face's kind and, if flat, which way it
# faces; an edge's kind and the faces on either side of it. Later rebuilds look for the point's face among the faces
# that still match that record, and fall back to plain nearness when none does (a rotated body, an old document).
_REFS = threading.local()  # .ctx = {"hints": {...}, "record": {...} | None} while Document._apply runs a step


def _ref_key(kind, pt):
    return kind + ",".join(repr(float(c)) for c in pt)


def _face_sig(f):
    s = {"type": f.geom_type}
    if f.is_planar:
        try:
            s["n"] = _v(f.normal_at())
        except Exception:  # a degenerate face has no normal: its kind is all we keep
            pass
    return s


def _face_matches(f, sig):
    if f.geom_type != sig.get("type"):
        return False
    n = sig.get("n")
    if n is None:
        return True
    if not f.is_planar:
        return False
    try:
        v = f.normal_at()
    except Exception:
        return False
    return v.x * n[0] + v.y * n[1] + v.z * n[2] > 0.999


def _edge_sig(e):
    try:
        faces = [_face_sig(f) for f in e.faces()]
    except Exception:
        faces = []
    return {"type": e.geom_type, "faces": faces}


def _edge_matches(e, sig):
    if e.geom_type != sig.get("type"):
        return False
    want = list(sig.get("faces") or [])
    if not want:
        return True
    try:
        have = list(e.faces())
    except Exception:
        return False
    for w in want:  # each recorded neighbour matched by a different face
        hit = next((i for i, f in enumerate(have) if _face_matches(f, w)), None)
        if hit is None:
            return False
        del have[hit]
    return True


def _resolve(items, pt, part, kind, matches, sig_of, what):
    pt = tuple(pt)
    ctx = getattr(_REFS, "ctx", None)
    key = _ref_key(kind, pt)
    reach = _reach(part)
    best = min(items, key=lambda x: x.distance_to(pt))
    pick = best
    sig = ctx["hints"].get(key) if ctx else None
    if sig:
        pool = [x for x in items if matches(x, sig)]
        if pool:
            cand = min(pool, key=lambda x: x.distance_to(pt))
            # a match far beyond the point's own surroundings means the record is stale (the body turned): nearness wins
            if cand.distance_to(pt) <= reach:
                pick = cand
    if pick is best and best.distance_to(pt) > reach:
        raise BadParams(f"no {what} near {[round(c, 3) for c in pt]}: reference a point on the {what} (see inspect_body)")
    if ctx and ctx["record"] is not None:
        ctx["record"][key] = sig_of(pick)
    return pick


def face_at(part, pt):
    return _resolve(part.faces(), pt, part, "f", _face_matches, _face_sig, "face")


def edges_at(part, pts):
    es = part.edges()
    return [_resolve(es, q, part, "e", _edge_matches, _edge_sig, "edge") for q in pts]


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
    pts = _clean_outline([tuple(q[:2]) for q in p["points"]])
    try:
        B[p["name"]] = _region(sm.Polygon(*pts, align=None).on(_plane(p)), p)
    except sm.ModelingError as e:
        raise BadParams(f"these points do not make a region: {e}") from None


def _clean_outline(pts):
    """The corners of a closed outline, checked before the kernel sees them: repeated points (a closing click on the start point
    repeats it) are dropped, and an outline with no area or one that crosses itself is refused with a reason."""
    out = []
    for q in pts:
        if not out or math.dist(q, out[-1]) > 1e-9:
            out.append(q)
    if len(out) > 1 and math.dist(out[0], out[-1]) <= 1e-9:
        out.pop()
    if len(out) < 3:
        raise BadParams("need at least 3 different points")
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    n = len(out)
    for i in range(n):
        a, b = out[i], out[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # the first and last segments meet at a corner
            c, d = out[j], out[(j + 1) % n]
            if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0:
                raise BadParams("the outline crosses itself")
    area2 = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(out, out[1:] + out[:1]))
    size = max(math.dist(a, b) for a in out for b in out) or 1.0
    if abs(area2) < 1e-9 * size * size:
        raise BadParams("the points lie on one line: they enclose no area")
    return out


@command("region.extrude", "Push/pull region", "Sketch",
         "Extrude a sketch region by `amount` along its plane normal. mode auto: a region drawn on a body is added to "
         "it when pulled out (amount > 0) and cut from it when pushed in; otherwise it becomes a new solid.",
         [P("body", "body", "", "the region"), P("amount", "float", 1), P("mode", "enum", "auto", options=["auto", "new", "union", "cut"]),
          P("target", "str", "", "body to add to / cut from (default: the body it was drawn on)"),
          P("keep_face", "bool", False, "keep the region's outline as edges where it was")])
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
    out = t.fuse(solid) if mode == "union" else t.cut(solid)
    if p["keep_face"]:
        for w in region.wires() if hasattr(region, "wires") else []:
            out = _keep_outline(out, w if mode == "union" else w.translate(*(region.faces()[0].normal_at() * p["amount"])))
    B[target] = out
    B.pop(p["body"], None)


# ---------------------------------------------------------------- commands: outlines with arcs, offset


def _arc_mid(a, b, bulge):
    """Middle point of the arc from a to b. bulge = sagitta / half chord; positive bows to the right of a -> b."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    return ((a[0] + b[0]) / 2 + dy * bulge / 2, (a[1] + b[1]) / 2 - dx * bulge / 2)


def _outline(pts, bulges):
    """A closed planar region from corner points; segment i (point i to i + 1) is an arc when bulges[i] != 0."""
    if len(pts) < 2 or (len(pts) < 3 and not any(bulges)):
        raise BadParams("need at least 3 points (or 2 with an arc)")
    edges = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        if math.dist(a, b) < 1e-9:
            raise BadParams(f"points {i} and {(i + 1) % len(pts)} coincide")
        k = bulges[i] if i < len(bulges) else 0.0
        if abs(k) > 50:
            raise BadParams("bulge must be between -50 and 50")
        edges.append(sm.ThreePointArc(a, _arc_mid(a, b, k), b) if abs(k) > 1e-9 else sm.Line(a, b))
    return sm.make_face(sm.Wire(edges))


@command("sketch.path", "Outline", "Sketch",
         "A closed region from straight and arc segments on a plane. `points` are the corners in plane coordinates; "
         "`bulges[i]` bends the segment from point i to the next into an arc (sagitta / half chord: 0 straight, 1 a "
         "half circle; positive bows to the right of the direction of travel).",
         [*PLANE, P("points", "points", [[0, 0], [2, 0], [2, 1], [0, 1]], "[x, y] corners"),
          P("bulges", "floats", [0, 1, 0, 0], "one per segment; missing ones are straight")], creates=True)
def _spath(B, p):
    B[p["name"]] = _region(_outline([tuple(q[:2]) for q in p["points"]], p["bulges"]).on(_plane(p)), p)


@command("sketch.line", "Line", "Sketch",
         "An open polyline of straight segments on a plane (2 or more points, plane coordinates). It is not a region: "
         "it has edges only, to measure from, snap to or use as a guide.",
         [*PLANE, P("points", "points", [[0, 0], [2, 0]], "[x, y] points, in order")], creates=True)
def _sline(B, p):
    pts = [tuple(q[:2]) for q in p["points"]]
    if len(pts) < 2:
        raise BadParams("a line needs at least 2 points")
    segs = []
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        if math.dist(a, b) < 1e-9:
            raise BadParams(f"points {i} and {i + 1} coincide")
        segs.append(sm.Line(a, b))
    B[p["name"]] = sm.Wire(segs).on(_plane(p))


@command("sketch.offset", "Offset outline", "Sketch",
         "A new region whose outline is that of a sketch region, or of the flat face of a body nearest `at`, moved "
         "outwards (positive) or inwards (negative) by `distance`. `ring` keeps only the band between the two outlines.",
         [P("body", "body", "", "a region, or a body with a flat face"), P("at", "face_ref", [0, 0, 0], "a point on the face (bodies only)"),
          P("distance", "float", -0.2), P("corners", "enum", "sharp", options=["sharp", "round", "chamfer"]),
          P("ring", "bool", False, "keep the band between the old and the new outline")], creates=True)
def _soff(B, p):
    src = _body(B, p["body"], (sm.Part, sm.Sketch))
    if abs(p["distance"]) < 1e-9:
        raise BadParams("distance must not be 0")
    if isinstance(src, sm.Sketch):
        base, on = src, getattr(src, "nk_on_body", "")
    else:
        f = face_at(src, p["at"])
        if not f.is_planar:
            raise BadParams("offset works on flat faces")
        base, on = sm.make_face(f.outer_wire(), *f.inner_wires()), p["body"]
    out = base.offset(p["distance"], corners=p["corners"])
    if p["ring"]:
        out = out.cut(base) if p["distance"] > 0 else base.cut(out)
    if out.area < 1e-12:
        raise BadParams("nothing is left: the distance is too large for this outline")
    B[p["name"]] = _region(out, {"on_body": on})


# ---------------------------------------------------------------- commands: copies, sweep, split


def _cut_plane(p):
    n = sm.Vector(*p["normal"])
    if n.length < 1e-9:
        raise BadParams("normal must not be zero")
    return sm.Plane(tuple(p["origin"]), z_dir=tuple(n.normalized()))


CUTPLANE = [P("origin", "vec3", [0, 0, 0], "a point on the plane"), P("normal", "vec3", [1, 0, 0], "plane normal")]
SOLIDS = (sm.Part, sm.Shell, sm.Mesh)


@command("body.mirror", "Mirror", "Modify",
         "A mirrored copy of a body in the plane through `origin` with `normal`. `merge` joins the copy to the "
         "original instead (a symmetric part from one half).",
         [P("body", "body", ""), *CUTPLANE, P("merge", "bool", False, "join the copy to the original")], creates=True)
def _mir(B, p):
    b = _body(B, p["body"], SOLIDS)
    m = b.mirror(_cut_plane(p))
    if p["merge"]:
        if not isinstance(b, sm.Part):
            raise BadParams("merge needs a solid body")
        B[p["body"]] = b.fuse(m)
    else:
        B[p["name"]] = m


@command("body.pattern", "Pattern", "Modify",
         "Copies of a body. linear: `count` bodies in a row, each `step` from the last. circular: `count` bodies "
         "around the axis through `axis_origin` along `axis_dir`, spread over `angle` degrees (360: evenly all "
         "around). `merge` joins the copies to the original.",
         [P("body", "body", ""), P("kind", "enum", "linear", options=["linear", "circular"]),
          P("count", "int", 3, "bodies in all, the original included", 2, 200), P("step", "vec3", [3, 0, 0], "linear: spacing"),
          P("axis_origin", "vec3", [0, 0, 0], "circular: a point on the axis"), P("axis_dir", "vec3", [0, 0, 1], "circular: axis direction"),
          P("angle", "float", 360, "circular: total angle", -360, 360), P("merge", "bool", False, "join the copies to the original")],
         creates=True)
def _pat(B, p):
    b = _body(B, p["body"], SOLIDS)
    n = p["count"]
    if p["kind"] == "linear":
        if not any(p["step"]):
            raise BadParams("step must not be zero")
        copies = [b.translate(*(x * i for x in p["step"])) for i in range(1, n)]
    else:
        d = sm.Vector(*p["axis_dir"])
        if d.length < 1e-9 or abs(p["angle"]) < 1e-9:
            raise BadParams("axis_dir and angle must not be zero")
        axis = sm.Axis(tuple(p["axis_origin"]), tuple(d.normalized()))
        full = abs(abs(p["angle"]) - 360) < 1e-9
        da = p["angle"] / (n if full else n - 1)
        copies = [b.rotate(axis, da * i) for i in range(1, n)]
    if p["merge"]:
        if not isinstance(b, sm.Part):
            raise BadParams("merge needs a solid body")
        for c in copies:
            b = b.fuse(c)
        B[p["body"]] = b
    else:
        for i, c in enumerate(copies, 2):
            B[f"{p['name']}_{i}"] = c


@command("nurbs.sweep", "Sweep", "NURBS",
         "Sweep a profile along a path through 3D `points` (a smooth curve, or straight runs with `smooth` off). "
         "The profile is centred on the start of the path, square to it.",
         [P("points", "points", [[0, 0, 0], [0, 0, 2], [1, 0, 3], [3, 0, 3]], "[x, y, z] path"),
          P("profile", "enum", "circle", options=["circle", "square", "hexagon"]), P("size", "float", 0.3, "radius / half width", 1e-6),
          P("smooth", "bool", True, "a curve through the points"), P("twist", "float", 0, "degrees of twist along the path")], creates=True)
def _swp(B, p):
    pts = [tuple(_vec(q)) for q in p["points"]]
    if len(pts) < 2:
        raise BadParams("need at least 2 points")
    if any(math.dist(a, b) < 1e-9 for a, b in zip(pts, pts[1:])):
        raise BadParams("two path points coincide")
    path = sm.Spline(*pts) if p["smooth"] and len(pts) > 2 else sm.Polyline(*pts) if len(pts) > 2 else sm.Line(*pts)
    r = p["size"]
    prof = sm.Circle(r) if p["profile"] == "circle" else sm.Rectangle(2 * r, 2 * r) if p["profile"] == "square" else sm.RegularPolygon(r, 6)
    out = sm.sweep(prof, path, twist=p["twist"])
    if not isinstance(out, sm.Part) or not out.is_valid():
        raise BadParams("the sweep does not make a closed solid (the profile is too large for the path's bends)")
    B[p["name"]] = out


@command("body.split", "Split", "Modify",
         "Cut a body with the plane through `origin` with `normal`. keep: the side the normal points to (above), "
         "the other (below), or both (the second piece becomes a new body).",
         [P("body", "body", ""), *CUTPLANE, P("keep", "enum", "both", options=["above", "below", "both"])], creates=True)
def _split(B, p):
    b = _body(B, p["body"])
    out = b.split(_cut_plane(p), p["keep"])
    parts = [x for x in (out if isinstance(out, (list, tuple)) else [out]) if x is not None and x.volume > 1e-12]
    if not parts or (p["keep"] == "both" and len(parts) < 2):
        raise BadParams("the plane does not cut this body")
    B[p["body"]] = parts[0]
    for i, x in enumerate(parts[1:]):
        B[p["name"] if i == 0 else f"{p['name']}_{i + 1}"] = x


@command("body.offset", "Grow / shrink", "Modify",
         "Move every face of a body outwards (positive) or inwards (negative) by `distance`.",
         [P("body", "body", ""), P("distance", "float", 0.1), P("corners", "enum", "sharp", options=["sharp", "round"])])
def _boff(B, p):
    out = _body(B, p["body"]).offset(p["distance"], corners=p["corners"])
    if not out.is_valid() or out.volume < 1e-12:
        raise BadParams("nothing valid is left at this distance")
    B[p["body"]] = out


@command("face.draft", "Draft", "Modify",
         "Tilt the faces nearest the given points by `angle` degrees, hinged on the plane through `origin` with "
         "`normal` (the pull direction of a mold).",
         [P("body", "body", ""), P("faces", "edge_refs", None, "points on the faces"), P("angle", "float", 3, "", -89, 89),
          P("origin", "vec3", [0, 0, 0], "a point on the neutral plane"), P("normal", "vec3", [0, 0, 1], "pull direction")])
def _draft(B, p):
    b = _body(B, p["body"])
    if not p["faces"]:
        raise BadParams("give at least one face")
    out = b.draft([face_at(b, q) for q in p["faces"]], p["angle"], _cut_plane(p))
    if not out.is_valid():
        raise BadParams("the draft does not give a closed solid")
    B[p["body"]] = out


@command("body.section", "Cross-section", "Sketch",
         "The cross-section of a body in the plane through `origin` with `normal`, as a new region.",
         [P("body", "body", ""), *CUTPLANE], creates=True)
def _sect(B, p):
    sk = _body(B, p["body"]).section(_cut_plane(p))
    if sk.area < 1e-12:
        raise BadParams("the plane does not cut this body")
    B[p["name"]] = sk


# ---------------------------------------------------------------- commands: lines on faces, moving an edge


@command("face.split", "Split face", "Modify",
         "Draw a line across a face, from its border to its border, and split the face in two along it (the shape "
         "stays the same). `points` are the line's corners in 3D; each half can then be pushed or pulled on its own.",
         [P("body", "body", ""), P("points", "points", [[-1, 0, 1], [1, 0, 1]], "[x, y, z] along the line")])
def _fsplit(B, p):
    b = _body(B, p["body"])
    pts = [tuple(_vec(q)) for q in p["points"]]
    if len(pts) < 2:
        raise BadParams("need at least 2 points")
    if any(math.dist(a, c) < 1e-9 for a, c in zip(pts, pts[1:])):
        raise BadParams("two points of the line coincide")
    try:  # snapping and the pointer leave the points a hair off the surface: put them exactly on it
        pts = [tuple(b.closest_point(q)) for q in pts]
    except Exception:  # keep the points as given
        pass
    tool = sm.Line(*pts) if len(pts) == 2 else sm.Polyline(*pts)
    try:
        out = b.imprint(tool)
    except sm.ModelingError:
        raise BadParams("the line does not cross a face from one side to the other") from None
    except ValueError:
        raise BadParams("the line does not lie on one face (it leaves the surface); draw it from one edge of a face to another") from None
    if len(out.faces()) <= len(b.faces()):
        raise BadParams("the line does not cross a face from one side to the other")
    B[p["body"]] = out


def _face_loop(face):
    """The corners of a flat face with straight sides, in order around it."""
    if not face.is_planar:
        raise BadParams("the faces on both sides of the edge must be flat")
    if face.inner_wires():
        raise BadParams("a face beside the edge has a hole; this is not supported yet")
    pts = []
    for e in face.outer_wire().edges():
        if e.geom_type != "line":
            raise BadParams("the faces beside the edge must have straight sides")
        pts.append(tuple(e.start))
    return pts


def _flat(pts, tol=1e-7):
    if len(pts) <= 3:
        return True
    a, b, c = (sm.Vector(*q) for q in pts[:3])
    n = (b - a).cross(c - a)
    if n.length < 1e-12:
        return False
    n = n.normalized()
    return all(abs(n.dot(sm.Vector(*q) - a)) < tol * max(1.0, (b - a).length) for q in pts[3:])


def _wedge(loop, P, Q, by, curved):
    """The solid between a face (its corners `loop`, one side of it the edge P-Q) and the same face with that edge
    moved by `by`: what moving the edge adds to the body (or takes away from it)."""
    n = len(loop)
    i = next(k for k in range(n) if math.dist(loop[k], P) < 1e-7)
    a = loop[i:] + loop[:i]  # starts at P
    if math.dist(a[1], Q) < 1e-7:  # walk away from Q, so the path is P -> ... -> Q around the rest of the face
        a = [a[0]] + a[1:][::-1]
    if math.dist(a[-1], Q) > 1e-7:
        raise BadParams("the edge is not a side of the faces next to it")
    up = lambda q: (q[0] + by[0], q[1] + by[1], q[2] + by[2])
    Pu, Qu = up(P), up(Q)
    poly = lambda *q: sm.make_face(sm.Polyline(*q, close=True))
    faces = [poly(*a), poly(P, Q, Qu, Pu), poly(P, Pu, a[1]), poly(Q, a[-2], Qu)]
    mid = a[1:-1]  # the corners away from the edge
    if len(mid) == 1:
        faces.append(poly(Pu, Qu, mid[0]))
    elif len(mid) == 2 and _flat([Pu, Qu, mid[1], mid[0]]):
        faces.append(poly(Pu, Qu, mid[1], mid[0]))
    elif len(mid) == 2 and curved:  # a twisted side: one smooth ruled face between the moved edge and the far side
        faces.append(sm.ruled(sm.Line(Pu, Qu), sm.Line(mid[0], mid[1])))
    else:  # flat triangles: from the moved P over the first half, from the moved Q over the rest
        h = len(mid) // 2
        for k in range(len(mid) - 1):
            faces.append(poly(Pu if k < h else Qu, mid[k], mid[k + 1]))
        faces.append(poly(Pu, Qu, mid[h]))
    w = sm.stitch(faces)
    if not isinstance(w, sm.Part):
        raise BadParams("the moved edge does not close up with the faces around it")
    return w


@command("edge.move", "Move edge", "Modify",
         "Move a straight edge between two flat faces by `by`; the two faces tilt to follow it (a line drawn across "
         "the top of a box and raised becomes the ridge of a roof). Where a tilted face cannot stay flat it becomes "
         "one smooth twisted face (`surface: curved`) or two flat triangles (`surface: flat`).",
         [P("body", "body", ""), P("at", "face_ref", None, "a point on the edge"), P("by", "vec3", [0, 0, 1]),
          P("surface", "enum", "curved", options=["curved", "flat"])])
def _emove(B, p):
    b = _body(B, p["body"])
    by = tuple(p["by"])
    if math.hypot(*by) < 1e-9:
        raise BadParams("by must not be zero")
    e = edges_at(b, [p["at"]])[0]
    if e.geom_type != "line":
        raise BadParams("only straight edges can be moved")
    fs = list(e.faces())
    if len(fs) != 2:
        raise BadParams("the edge must lie between two faces")
    P, Q = tuple(e.start), tuple(e.end)
    out, moved = b, False
    for f in fs:
        nrm = f.normal_at(f.center())
        along = nrm.x * by[0] + nrm.y * by[1] + nrm.z * by[2]
        if abs(along) < 1e-9 * max(1.0, math.hypot(*by)):
            continue  # moving within this face's plane: it does not tilt
        w = _wedge(_face_loop(f), P, Q, by, p["surface"] == "curved")
        # what is added must lie outside the body, what is taken away inside it; otherwise the edge went through it
        inside = b.intersect(w).volume if w.volume > 1e-12 else 0.0
        if (along > 0 and inside > 1e-6 * w.volume) or (along < 0 and inside < w.volume * (1 - 1e-6)):
            raise BadParams("the edge would pass through the body; move it less far")
        out = out.fuse(w) if along > 0 else out.cut(w)
        moved = True
    if not moved:
        raise BadParams("moving the edge along both of its faces changes nothing; move it out of them (for example along Z)")
    if not out.is_valid(strict=True):
        raise BadParams("the result would not be a closed solid (the edge moves too far)")
    B[p["body"]] = out


# ---------------------------------------------------------------- annotations: dimensions


@dataclass
class Dimension:
    """A dimension line: what is measured (a to b, the true distance or along one axis) and where its line is drawn
    (offset from the measured points). It is kept in the document like a body, but has no geometry of its own."""
    a: tuple
    b: tuple
    offset: tuple
    axis: str  # "aligned" or "X" / "Y" / "Z"
    kind: str = "length"  # "length", "radius" (a = centre, b = a point on the curve), "diameter" (a, b opposite points on it) or "area" (a = a point on the face)
    amount: float = 0.0  # the area, for kind "area"

    @property
    def value(self):
        if self.kind == "area":
            return self.amount
        if self.axis in ("X", "Y", "Z"):
            i = "XYZ".index(self.axis)
            return abs(self.b[i] - self.a[i])
        return math.dist(self.a, self.b)


@command("dim.add", "Dimension", "Annotate",
         "A dimension between the points `a` and `b`: their distance (axis aligned) or how far apart they are along X, Y "
         "or Z. `offset` moves the dimension line away from the points (the extension lines run back to them).",
         [P("a", "vec3", [0, 0, 0]), P("b", "vec3", [1, 0, 0]), P("offset", "vec3", [0, -0.5, 0]),
          P("axis", "enum", "aligned", options=["aligned", "X", "Y", "Z"]),
          P("kind", "enum", "length", "length, the radius / diameter of a round shape (a, b as described by the kind), or the area of a face (a: a point on it)",
            options=["length", "radius", "diameter", "area"]),
          P("amount", "float", 0, "the area, for kind area (square model units)", 0)], creates=True)
def _dim(B, p):
    d = Dimension(tuple(p["a"]), tuple(p["b"]), tuple(p["offset"]), p["axis"], p["kind"], float(p["amount"]))
    if d.kind == "area" and d.amount <= 0:
        raise BadParams("an area dimension needs an amount above 0")
    if d.kind != "area" and d.value < 1e-9:
        raise BadParams("the two points are at the same place" + ("" if p["axis"] == "aligned" else f" along {p['axis']}"))
    B[p["name"]] = d


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
    if len(pts) < 2:
        raise BadParams("need at least 2 profile points")
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


@command("face.extrude", "Push/pull (extrude face)", "Modify",
         "Extrude the planar face nearest `at` along its outward normal by `amount`: pulling (amount > 0) adds that "
         "prism to the body, pushing (amount < 0) cuts it away. The body stays one closed solid.",
         [P("body", "body", ""), P("at", "face_ref", None, "a point on the face"), P("amount", "float", 1),
          P("keep_face", "bool", False, "keep the starting face's outline as edges (a new segment on top of the old)")])
def _fext(B, p):
    b = _body(B, p["body"])
    f = face_at(b, p["at"])
    if not f.is_planar:
        raise BadParams("push/pull works on flat faces; use face.move for curved ones")
    if abs(p["amount"]) < 1e-9:
        raise BadParams("amount must not be 0")
    prism = sm.extrude(f, p["amount"])
    try:
        out = b.fuse(prism) if p["amount"] > 0 else b.cut(prism)
    except sm.ModelingError as e:
        if "touch only along" in str(e) or "not a closed" in str(e):
            raise BadParams("the kernel could not join the new block to the body here (the block's side lies exactly on an existing wall, "
                            "and the faces around this one are at the same height). Try pulling a neighbouring face, or undo the "
                            "last steps around this spot") from None
        raise
    if not out.is_valid():
        raise BadParams("the result would not be a closed solid (the cut goes all the way through)")
    if p["keep_face"]:
        out = _keep_outline(out, f if p["amount"] > 0 else f.translate(*(f.normal_at() * p["amount"])), b)
    B[p["body"]] = out


def _keep_outline(body, tool, old=None):
    """Split the faces the outline lies on along it (where the old face was, or where a pushed face went), so that the
    step stays visible as edges. `tool` is the old face (it lies inside the result and cuts the faces it meets exactly along
    its outline, also where the outline runs over steps) or a wire (which must lie wholly on faces). Edges that are already
    there need nothing."""
    out = body
    for t in ([tool] if not hasattr(tool, "outer_wire") else [tool, tool.outer_wire()]):
        try:
            out = body.imprint(t)
            break
        except (sm.ModelingError, ValueError, AttributeError):
            continue
    if old is not None:  # edges of the old shape that the merge swallowed (a pulled face flush with its neighbours) come back
        try:
            restored = out.imprint(old)
            if restored.is_valid():
                out = restored
        except (sm.ModelingError, ValueError, AttributeError):
            pass  # "crosses no face": nothing was swallowed
    return out


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


@command("hole.fill", "Fill hole", "Modify",
         "Close an open hole in a sheet with a face. `at` is a point on one of the edges around the hole (the free edges of "
         "the sheet that join up into a closed loop). A flat loop gets a flat face, any other loop a smooth patch. When the "
         "sheet then closes around a volume, it becomes a solid.",
         [P("body", "body", ""), P("at", "face_ref", None, "a point on an edge of the hole")])
def _fillhole(B, p):
    b = _body(B, p["body"], (sm.Shell,))
    free = [e for e in b.edges() if len(e.faces()) == 1]
    if not free:
        raise BadParams("this sheet has no open edges: there is no hole to fill")
    at = tuple(p["at"])
    key = lambda v: tuple(round(c, 5) for c in v)  # noqa: E731
    seed = min(free, key=lambda e: e.distance_to(at))
    loop, used = [seed], {id(seed)}
    end = key(seed.end)
    start = key(seed.start)
    for _ in range(len(free)):
        if end == start:
            break
        nxt = next((e for e in free if id(e) not in used and (key(e.start) == end or key(e.end) == end)), None)
        if nxt is None:
            break
        used.add(id(nxt))
        loop.append(nxt)
        end = key(nxt.end) if key(nxt.start) == end else key(nxt.start)
    if end != start:
        raise BadParams("the open edges around that point do not form a closed loop")
    pts = [tuple(v) for e in loop for v in (e.start, e.end)]
    flat = False
    if len(pts) >= 3:
        o = sm.Vector(*pts[0])
        n = None
        for q in pts[1:]:
            for r in pts[2:]:
                c = (sm.Vector(*q) - o).cross(sm.Vector(*r) - o)
                if c.length > 1e-9:
                    n = c.normalized()
                    break
            if n is not None:
                break
        size = max(math.dist(pts[0], q) for q in pts[1:]) or 1.0
        flat = n is not None and all(abs((sm.Vector(*q) - o).dot(n)) < 1e-6 * size for q in pts)
    try:
        patch = sm.make_face(sm.Wire(loop)) if flat else sm.fill(loop)
        out = sm.stitch([b, patch])
    except sm.ModelingError as e:
        raise BadParams(f"the hole could not be filled: {e}") from None
    B[p["body"]] = out


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


@command("face.delete", "Delete faces", "Modify",
         "Remove the faces nearest the given points (a hole, a boss, a fillet...) and close the gap with the faces around them.",
         [P("body", "body", ""), P("faces", "edge_refs", None, "points on the faces")])
def _fdel(B, p):
    b = _body(B, p["body"])
    faces = []
    for q in p["faces"]:
        f = face_at(b, q)
        if not any(f is g for g in faces):
            faces.append(f)
    B[p["body"]] = b.remove_faces(faces)


@command("body.delete", "Delete body", "Modify", "Remove a body.", [P("body", "body", "")])
def _del(B, p):
    _body(B, p["body"], (sm.Part, sm.Shell, sm.Mesh, sm.Sketch, sm.Wire, Dimension))
    del B[p["body"]]


# ---------------------------------------------------------------- commands: files

BLOBS: dict[str, bytes] = {}  # content-addressed imported files (shared by all documents in the process)


def add_blob(data: bytes) -> str:
    h = hashlib.sha256(data).hexdigest()[:16]
    BLOBS[h] = data
    return h


@command("file.import", "Import file", "File",
         "Bodies from an imported file (`blob` = id returned by the import endpoint). STEP and IGES give exact B-rep "
         "solids/sheets; STL, WRL, OBJ, GLB and 3MF give a display mesh unless to_solid.",
         [P("blob", "blob", ""), P("format", "enum", "step", options=["step", "stl", "wrl", "obj", "glb", "3mf", "iges"]),
          P("to_solid", "bool", False, "mesh formats only: convert the mesh to a solid"),
          P("scale", "float", 1, "multiplies the file's coordinates (1000 for a file in metres, into a millimetre document)", 1e-9),
          P("place", "enum", "asis", "asis: where the file puts it; origin: its centre on the origin; ground: centred on the origin "
            "and resting on the ground (its lowest point at z = 0)", options=["asis", "origin", "ground"])], creates=True)
def _imp(B, p):
    data = BLOBS.get(p["blob"])
    if data is None:
        raise BadParams(f"unknown blob {p['blob']}")
    if p["format"] in ("stl", "wrl", "obj", "glb", "3mf"):
        try:
            m = sm.from_stl(data) if p["format"] == "stl" else sm.Mesh(*{"wrl": vrml.read, "obj": meshio.read_obj, "glb": meshio.read_glb,
                                                                           "3mf": meshio.read_3mf}[p["format"]](data))
        except meshio.MeshError as e:
            raise BadParams(str(e)) from None
        shapes = [m.to_part() if p["to_solid"] else m]
    else:
        r = sm.from_iges(data) if p["format"] == "iges" else sm.from_step(data)
        shapes = list(r) if isinstance(r, (list, tuple, sm.ShapeList)) else [r]
    shapes = _fit_import(shapes, p["scale"], p["place"])
    for i, s in enumerate(shapes):
        B[p["name"] if i == 0 else f"{p['name']}.{i}"] = s


def _fit_import(shapes, scale, place):
    """The imported shapes scaled about the origin, then placed: as the file has them, centred on the origin, or on the ground."""
    if abs(scale - 1) > 1e-12:
        shapes = [s.scale(scale) for s in shapes]
    if place == "asis" or not shapes:
        return shapes
    lo, hi = [1e300] * 3, [-1e300] * 3
    for s in shapes:
        bb = s.bbox()
        lo = [min(lo[i], bb.min[i]) for i in range(3)]
        hi = [max(hi[i], bb.max[i]) for i in range(3)]
    dx, dy = -(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2
    dz = -lo[2] if place == "ground" else -(lo[2] + hi[2]) / 2
    return [s.translate(dx, dy, dz) for s in shapes]


# ---------------------------------------------------------------- document

UNITS = {"mm": "millimeter", "cm": "centimeter", "m": "meter", "in": "inch"}  # unit -> its 3MF name


class Document:
    def __init__(self):
        self.features: list[dict] = []
        self.states: list[dict] = []  # bodies after each feature
        self.errors: dict[int, str] = {}
        self.next_id = 1
        self.undo_stack: list[str] = []
        self.redo_stack: list[str] = []
        self.units = "mm"  # what one model unit means, for display and export

    def set_units(self, units):
        if units not in UNITS:
            raise BadParams(f"units must be one of {list(UNITS)}")
        self.units = units

    # -- persistence
    def to_json(self, with_blobs=True):
        d = {"format": "nerikone/1", "units": self.units, "features": self.features}
        if with_blobs:
            used = {f["params"].get("blob") for f in self.features if f["cmd"] == "file.import"}
            d["blobs"] = {h: base64.b64encode(BLOBS[h]).decode() for h in used if h in BLOBS}
        return d

    def load_json(self, d):
        for h, b in d.get("blobs", {}).items():
            BLOBS[h] = base64.b64decode(b)
        if not isinstance(d, dict) or not isinstance(d.get("features"), list):
            raise BadParams("not a Nerikone document")
        self._push_undo()
        self.units = d.get("units") if d.get("units") in UNITS else "mm"
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

    def _apply(self, bodies, f, record=False):
        """Run step `f` on `bodies`. With `record`, the faces and edges it picks are kept in f["refs"] (see face_at)."""
        out = dict(bodies)
        if not f.get("suppressed"):
            cmd = COMMANDS[f["cmd"]]
            params = f["params"]
            # steps saved before a parameter existed run with its default (documents stay readable as commands grow)
            if any(q.name not in params for q in cmd.params):
                params = {**{q.name: copy.deepcopy(q.default) for q in cmd.params if q.name not in params}, **params}
            refs = f.get("refs")
            _REFS.ctx = {"hints": refs if isinstance(refs, dict) else {}, "record": {} if record else None}
            try:
                cmd.run(out, params)
            except BadParams:
                raise
            except (sm.ModelingError, ValueError, ArithmeticError) as e:
                # whatever the kernel (or a numeric check inside it) refuses is a refusal of these parameters: one kind of error, its reason kept
                raise BadParams(f"{cmd.label}: {e}") from None
            finally:
                ctx, _REFS.ctx = _REFS.ctx, None
            if record:
                if ctx["record"]:
                    f["refs"] = ctx["record"]
                else:
                    f.pop("refs", None)
        return out

    def rebuild(self, start=0, record=None):
        """Evaluate the steps from `start` on. The step whose id is `record` keeps what it picks (its own inputs changed)."""
        start = max(0, min(start, len(self.states)))
        self.states = self.states[:start]
        for i in range(start, len(self.features)):
            f = self.features[i]
            prev = self.states[-1] if self.states else {}
            self.errors.pop(f["id"], None)
            try:
                self.states.append(self._apply(prev, f, record=f["id"] == record))
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
        new = self._apply(self.bodies, f, record=True)  # raises on failure
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
        self.rebuild(i, record=fid if params is not None else None)
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
            if lo <= start <= hi and ok(start):  # never below the lower bound asked for
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
                "units": self.units, "can_undo": bool(self.undo_stack), "can_redo": bool(self.redo_stack)}


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
    if isinstance(b, Dimension):
        lo = [min(b.a[i], b.b[i], b.a[i] + b.offset[i]) for i in range(3)]
        hi = [max(b.a[i], b.b[i], b.a[i] + b.offset[i]) for i in range(3)]
        return {"kind": "Dimension", "bbox": [lo, hi], "color": None,
                "dim": {"a": list(b.a), "b": list(b.b), "offset": list(b.offset), "axis": b.axis, "kind": b.kind, "amount": b.amount, "value": round(b.value, 9)}}
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


# ---------------------------------------------------------------- measuring (read-only queries)


def measure(doc: "Document", kind: str, p: dict) -> dict:
    """Exact measurements from the kernel. kind:
    body          {bodies}                  volume, area, centre of mass and size of each
    distance      {a, b}                    the shortest distance between two bodies and the points it is between
    interference  {bodies?}                 pairs of solids that overlap, with the shared volume (all solids if omitted)
    draft         {body, direction?, min_angle?}  how each face releases from a mold pulled along `direction`
    angle         {a, at_a, b, at_b}        the angle between the faces nearest the two points
    """
    B = doc.bodies
    if not isinstance(p, dict):
        raise BadParams("params must be an object")

    def names(key="bodies", kinds=SOLIDS + (sm.Sketch,)):
        ns = p.get(key) or [n for n, b in B.items() if isinstance(b, kinds)]
        if not isinstance(ns, list):
            raise BadParams(f"{key} must be a list of body names")
        return [str(n) for n in ns]

    if kind == "body":
        out = {}
        for n in names():
            b = _body(B, n, SOLIDS + (sm.Sketch,))
            bb = b.bbox()
            d = {"kind": type(b).__name__, "size": [round(bb.max[i] - bb.min[i], 6) for i in range(3)]}
            if isinstance(b, sm.Part):
                mp = b.mass_properties()
                d.update(volume=round(mp.volume, 6), area=round(mp.area, 6), center=_v(mp.center))
            elif isinstance(b, (sm.Sketch, sm.Shell)):
                d.update(area=round(b.area, 6))
            out[n] = d
        return {"bodies": out}
    if kind == "distance":
        a, b = _body(B, str(p.get("a", "")), (sm.Part, sm.Shell)), _body(B, str(p.get("b", "")), (sm.Part, sm.Shell))
        cp = a.closest_points(b)
        return {"distance": round(cp.distance, 6), "point_a": _v(cp.point), "point_b": _v(cp.other_point)}
    if kind == "interference":
        ns = [n for n in names(kinds=(sm.Part,)) if isinstance(_body(B, n, SOLIDS + (sm.Sketch,)), sm.Part)]
        if len(ns) > 40:
            raise BadParams("too many bodies to compare at once (40 at most)")
        pairs = []
        for i, x in enumerate(ns):
            bx = B[x].bbox()
            for y in ns[i + 1:]:
                by = B[y].bbox()
                if any(bx.min[k] > by.max[k] or by.min[k] > bx.max[k] for k in range(3)):
                    continue  # their boxes do not even touch
                try:
                    v = B[x].intersect(B[y]).volume
                except Exception:
                    continue
                if v > 1e-9:
                    pairs.append({"a": x, "b": y, "volume": round(v, 6)})
        return {"checked": ns, "pairs": pairs}
    if kind == "draft":
        b = _body(B, str(p.get("body", "")))
        try:
            d = _vec(p.get("direction", [0, 0, 1]))
            min_angle = float(p.get("min_angle", 1.0))
        except (TypeError, ValueError) as e:
            raise BadParams(f"draft: {e}") from None
        if not any(d) or not (0 <= min_angle < 90):
            raise BadParams("direction must not be zero; min_angle must be within 0..90")
        da = b.draft_analysis(tuple(d), min_angle=min_angle)
        groups = {}
        for g in ("positive", "insufficient", "vertical", "undercut"):
            groups[g] = [_v(_face_point(f)) for f in getattr(da, g)]
        return {"direction": list(d), "min_angle": min_angle, "ok": bool(da.ok), "counts": {g: len(v) for g, v in groups.items()}, "faces": groups}
    if kind == "angle":
        try:
            fa = face_at(_body(B, str(p.get("a", "")), (sm.Part, sm.Shell)), _vec(p.get("at_a")))
            fb = face_at(_body(B, str(p.get("b", "")), (sm.Part, sm.Shell)), _vec(p.get("at_b")))
        except (TypeError, ValueError) as e:
            raise BadParams(f"angle: {e}") from None
        na, nb = fa.normal_at(), fb.normal_at()
        c = max(-1.0, min(1.0, na.dot(nb) / (na.length * nb.length)))
        return {"angle": round(math.degrees(math.acos(c)), 6), "normal_a": _v(na), "normal_b": _v(nb)}
    if kind == "face":  # {body, at}: the area of the face nearest `at`, and a point on it
        b = _body(B, p.get("body", ""), SOLIDS + (sm.Sketch,))
        f = min(b.faces(), key=lambda x: x.distance_to(tuple(sm.Vector(*p["at"]))))
        return {"type": "face", "area": round(f.area, 9), "point": _v(_face_point(f)), "planar": bool(f.is_planar)}
    if kind == "round":  # {body, at}: the round shape (sphere, cylinder, circle or arc edge) nearest `at`, for radius / diameter dimensions
        b = _body(B, p.get("body", ""), SOLIDS + (sm.Sketch,))
        at = sm.Vector(*p["at"])
        edges = list(b.edges())
        e = min(edges, key=lambda x: x.distance_to(tuple(at))) if edges else None
        f = min(b.faces(), key=lambda x: x.distance_to(tuple(at)))
        if e is not None and e.distance_to(tuple(at)) < 1e-3 and e.geom_type in ("circle", "arc", "ellipse"):  # a round edge under the pointer
            c, r = e.arc_center, e.radius
            v = at - c
            v = v - e.normal * v.dot(e.normal)
            v = v.normalized() if v.length > 1e-9 else e.normal.cross(sm.Vector(1, 0, 0))
            return {"type": "circle" if e.is_closed else "arc", "radius": round(r, 9), "center": _v(c), "point": _v(c + v * r), "axis": _v(e.normal)}
        if f.geom_type in ("sphere", "cylinder", "cone"):
            ax = f.axis
            o, d = sm.Vector(*ax.origin), sm.Vector(*ax.direction)
            c = o if f.geom_type == "sphere" else o + d * (at - o).dot(d)
            v = at - c
            if f.geom_type != "sphere":
                v = v - d * v.dot(d)
            if v.length < 1e-9:
                raise BadParams("the point is on the axis")
            r = f.radius if f.geom_type != "cone" else v.length
            return {"type": f.geom_type, "radius": round(r, 9), "center": _v(c), "point": _v(c + v.normalized() * r),
                    "axis": None if f.geom_type == "sphere" else _v(d)}
        return {"type": "none"}
    raise BadParams("kind must be one of: body, distance, interference, draft, angle, round, face")


# ---------------------------------------------------------------- tessellation for the viewer

_mesh_cache: dict[int, tuple[Any, dict]] = {}


def mesh_body(b):
    key = id(b)
    hit = _mesh_cache.get(key)
    if hit and hit[0] is b:
        return hit[1]
    if isinstance(b, sm.Wire):  # an open line: edges only
        d = {"faces": [], "edges": [{"pts": [_v(e.point_at(j / (1 if e.geom_type == "line" else 40))) for j in range((1 if e.geom_type == "line" else 40) + 1)],
                                     "mid": _v(e.point_at(0.5))} for e in b.edges()]}
    elif isinstance(b, sm.Mesh):
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
    return {n: {**mesh_body(b), "kind": type(b).__name__} for n, b in bodies.items() if not isinstance(b, Dimension)}


# ---------------------------------------------------------------- export

EXPORTS = {"wrl": "model/vrml", "step": "model/step", "stl": "model/stl", "glb": "model/gltf-binary", "usda": "model/vnd.usda",
           "nrk": "application/json", "3mf": "model/3mf", "obj": "model/obj", "svg": "image/svg+xml", "dxf": "image/vnd.dxf"}


def write_3mf(meshes, unit="millimeter") -> bytes:
    """A 3MF package (core specification): one object per body, as (name, vertices, triangles)."""
    from xml.sax.saxutils import quoteattr
    objs, items = [], []
    for i, (name, verts, tris) in enumerate(meshes, 1):
        vs = "".join(f'<vertex x="{x:.6g}" y="{y:.6g}" z="{z:.6g}"/>' for x, y, z in verts.tolist())
        ts = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris.tolist())
        objs.append(f'<object id="{i}" type="model" name={quoteattr(name)}><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>')
        items.append(f'<item objectid="{i}"/>')
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             f'<model unit="{unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             f'<resources>{"".join(objs)}</resources><build>{"".join(items)}</build></model>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", model)
    return buf.getvalue()


def export(doc: Document, fmt: str, names: list[str] | None = None, tolerance: float | None = None) -> bytes:
    """`tolerance` (model units) sets how finely curved faces are faceted in the mesh formats (stl, 3mf, obj, wrl)."""
    if fmt == "nrk":
        return json.dumps(doc.to_json()).encode()
    if tolerance is not None and not (1e-6 <= tolerance <= 1e3):
        raise BadParams("tolerance must be between 0.000001 and 1000")
    shapes = [b for n, b in doc.bodies.items() if (not names or n in names) and not isinstance(b, (sm.Sketch, sm.Wire, Dimension))]
    if not shapes:
        raise BadParams("nothing to export")
    step_unit = {"in": "inch"}.get(doc.units, doc.units)
    if fmt == "step":
        return sm.to_step([s for s in shapes if not isinstance(s, sm.Mesh)], unit=step_unit).encode()
    if fmt == "stl":
        return sm.to_stl(shapes, tolerance=tolerance)
    if fmt == "obj":
        return sm.to_obj(shapes).encode()
    if fmt == "3mf":
        meshes = []
        for n, b in doc.bodies.items():
            if (names and n not in names) or isinstance(b, (sm.Sketch, sm.Wire, Dimension)):
                continue
            m = b if isinstance(b, sm.Mesh) else b.mesh(tolerance)
            meshes.append((n, m.vertices, m.triangles))
        return write_3mf(meshes, UNITS[doc.units])
    if fmt in ("svg", "dxf"):  # a 2D drawing: front, top and side views with hidden lines
        parts = [s for s in shapes if isinstance(s, (sm.Part, sm.Shell))]
        if not parts:
            raise BadParams("a drawing needs at least one solid or surface body")
        views = sm.drawing_views(parts)
        return (sm.to_svg(views) if fmt == "svg" else sm.to_dxf(views, unit=step_unit)).encode()
    if fmt == "wrl":
        meshes = []
        for n, b in doc.bodies.items():
            if names and n not in names:
                continue
            if isinstance(b, (sm.Sketch, sm.Wire, Dimension)):
                continue
            m = b if isinstance(b, sm.Mesh) else b.mesh(tolerance)
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
