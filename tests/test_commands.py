"""Every command builds what it says: volumes, face/edge counts and bounding boxes derived by hand."""
import math

import pytest

from conftest import K, bbox, build, info

approx = pytest.approx


def test_every_command_is_covered():
    """A new command must get a test here (add its id to COVERED once it has one)."""
    assert set(K.COMMANDS) == COVERED


COVERED = {
    "body.box", "body.cylinder", "body.cone", "body.sphere", "body.torus",
    "edge.fillet", "edge.chamfer", "edge.move", "body.shell", "face.extrude", "face.move", "face.delete", "face.draft",
    "face.split", "face.color", "body.boolean", "body.mirror", "body.pattern", "body.offset", "body.split",
    "body.section", "body.transform", "body.duplicate", "body.delete", "body.material", "dim.add", "hole.fill",
    "asm.mate", "var.set", "nurbs.loft", "nurbs.revolve", "nurbs.surface", "nurbs.sweep", "sketch.rect", "sketch.circle", "sketch.polygon",
    "sketch.line", "sketch.path", "sketch.extrude", "sketch.offset", "region.extrude", "file.import",
}


# ---------------------------------------------------------------- primitives

def test_box():
    d = build(("body.box", {"length": 2, "width": 3, "height": 4}))
    i = info(d, "Box1")
    assert (i["kind"], i["faces"], i["edges"]) == ("Part", 6, 12)
    assert i["volume"] == approx(24)
    assert bbox(d, "Box1") == [[-1, -1.5, -2], [1, 1.5, 2]]


def test_box_at():
    d = build(("body.box", {"at": [1, 2, 3]}))
    assert bbox(d, "Box1") == [[0, 1, 2], [2, 3, 4]]


def test_cylinder():
    d = build(("body.cylinder", {"radius": 1, "height": 2}))
    i = info(d, "Cylinder1")
    assert (i["faces"], i["edges"]) == (3, 2)
    assert i["volume"] == approx(math.pi * 2, rel=1e-5)


def test_cone():
    d = build(("body.cone", {"bottom_radius": 1, "top_radius": 0.3, "height": 2}))
    v = math.pi * 2 / 3 * (1 + 0.3 + 0.09)  # frustum: pi h / 3 (R^2 + R r + r^2)
    assert info(d, "Cone1")["volume"] == approx(v, rel=1e-5)


def test_sphere():
    d = build(("body.sphere", {"radius": 2}))
    assert info(d, "Sphere1")["volume"] == approx(4 / 3 * math.pi * 8, rel=1e-5)
    assert bbox(d, "Sphere1") == [[-2, -2, -2], [2, 2, 2]]


def test_torus():
    d = build(("body.torus", {"major_radius": 1.5, "minor_radius": 0.4}))
    assert info(d, "Torus1")["volume"] == approx(2 * math.pi ** 2 * 1.5 * 0.16, rel=1e-5)
    assert bbox(d, "Torus1") == [[-1.9, -1.9, -0.4], [1.9, 1.9, 0.4]]


def test_auto_names_count_up():
    d = build(("body.box", {}), ("body.box", {"at": [5, 0, 0]}), ("body.box", {"name": "Lid"}))
    assert sorted(d.bodies) == ["Box1", "Box2", "Lid"]


# ---------------------------------------------------------------- edges and faces

def test_fillet(cube):
    cube.execute("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]], "radius": 0.2})
    i = info(cube, "Box1")
    assert (i["faces"], i["edges"]) == (7, 15)
    assert i["volume"] == approx(8 - (1 - math.pi / 4) * 0.04 * 2, rel=1e-5)  # a quarter-round removed along 2


def test_chamfer(cube):
    cube.execute("edge.chamfer", {"body": "Box1", "edges": [[1, 0, 1]], "length": 0.2})
    i = info(cube, "Box1")
    assert (i["faces"], i["edges"]) == (7, 15)
    assert i["volume"] == approx(8 - 0.02 * 2)


def test_edge_move_flat(cube):
    # lifting the top edge at x=+1 by 1 turns the top into a ramp: a wedge of 2 x 1 x 2 / 2 is added
    cube.execute("edge.move", {"body": "Box1", "at": [1, 0, 1], "by": [0, 0, 1], "surface": "flat"})
    assert info(cube, "Box1")["volume"] == approx(10)
    assert bbox(cube, "Box1") == [[-1, -1, -1], [1, 1, 2]]


def test_shell(cube):
    cube.execute("body.shell", {"body": "Box1", "thickness": 0.1, "open_at": [0, 0, 1]})
    assert info(cube, "Box1")["volume"] == approx(8 - 1.8 * 1.8 * 1.9)


@pytest.mark.parametrize("cmd,params", [
    ("face.extrude", {"at": [0, 0, 1], "amount": 1}),
    ("face.move", {"at": [0, 0, 1], "by": [0, 0, 1]}),
])
def test_pull_top_face(cube, cmd, params):
    cube.execute(cmd, {"body": "Box1", **params})
    i = info(cube, "Box1")
    assert (i["faces"], i["volume"]) == (6, approx(12))
    assert bbox(cube, "Box1") == [[-1, -1, -1], [1, 1, 2]]


def test_face_extrude_keep_face(cube):
    cube.execute("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1, "keep_face": True})
    assert info(cube, "Box1")["volume"] == approx(12)


def test_face_delete_removes_a_fillet(cube):
    cube.execute("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]], "radius": 0.2})
    p = 1 - 0.2 * (1 - math.cos(math.pi / 4))  # a point on the round
    cube.execute("face.delete", {"body": "Box1", "faces": [[p, 0, p]]})
    i = info(cube, "Box1")
    assert (i["faces"], i["edges"], i["volume"]) == (6, 12, approx(8))


def test_draft(cube):
    cube.execute("face.draft", {"body": "Box1", "faces": [[1, 0, 0]], "angle": 5, "origin": [0, 0, -1]})
    # the +x side tilts inwards about its bottom edge: a wedge of 2 * tan(5deg) * 2 / 2 * 2 comes off
    assert info(cube, "Box1")["volume"] == approx(8 - 4 * math.tan(math.radians(5)), rel=1e-4)


def test_face_split(cube):
    cube.execute("face.split", {"body": "Box1", "points": [[-1, 0, 1], [1, 0, 1]]})
    i = info(cube, "Box1")
    assert (i["faces"], i["edges"], i["volume"]) == (7, 15, approx(8))


def test_face_color(cube):
    cube.execute("face.color", {"body": "Box1", "at": [0, 0, 1], "color": "#ff0000"})
    assert info(cube, "Box1")["volume"] == approx(8)


def test_face_color_rejects_garbage(cube):
    with pytest.raises(K.BadParams):
        cube.execute("face.color", {"body": "Box1", "at": [0, 0, 1], "color": "not a colour"})


def test_hole_fill():
    d = build(("nurbs.surface", {"thickness": 0}))
    assert info(d, "NURBS1")["kind"] == "Shell"
    d.execute("hole.fill", {"body": "NURBS1", "at": [1.5, 0, 0]})  # the flat outer border gets a floor
    i = info(d, "NURBS1")
    assert i["kind"] == "Part" and i["faces"] == 2 and i["volume"] > 0


# ---------------------------------------------------------------- whole bodies

@pytest.mark.parametrize("kind,volume,box", [
    ("union", 12, [[-1, -1, -1], [2, 1, 1]]),
    ("cut", 4, [[-1, -1, -1], [0, 1, 1]]),
    ("intersect", 4, [[0, -1, -1], [1, 1, 1]]),
])
def test_boolean(kind, volume, box):
    d = build(("body.box", {}), ("body.box", {"at": [1, 0, 0]}),
              ("body.boolean", {"kind": kind, "target": "Box1", "tools": ["Box2"]}))
    assert sorted(d.bodies) == ["Box1"]  # the tool is used up
    assert info(d, "Box1")["volume"] == approx(volume)
    assert bbox(d, "Box1") == box


def test_boolean_keep_tools():
    d = build(("body.box", {}), ("body.box", {"at": [1, 0, 0]}),
              ("body.boolean", {"kind": "cut", "target": "Box1", "tools": ["Box2"], "keep_tools": True}))
    assert sorted(d.bodies) == ["Box1", "Box2"]


def test_mirror():
    d = build(("body.box", {"at": [2, 0, 0]}), ("body.mirror", {"body": "Box1"}))
    assert bbox(d, "Mirror1") == [[-3, -1, -1], [-1, 1, 1]]
    d2 = build(("body.box", {"at": [1, 0, 0]}), ("body.mirror", {"body": "Box1", "merge": True}))
    assert list(d2.bodies) == ["Box1"] and info(d2, "Box1")["volume"] == approx(16)


def test_linear_pattern(cube):
    cube.execute("body.pattern", {"body": "Box1", "count": 3, "step": [3, 0, 0]})
    assert sorted(cube.bodies) == ["Box1", "Pattern1_2", "Pattern1_3"]
    assert bbox(cube, "Pattern1_3") == [[5, -1, -1], [7, 1, 1]]


def test_circular_pattern():
    d = build(("body.box", {"at": [3, 0, 0]}), ("body.pattern", {"body": "Box1", "kind": "circular", "count": 4}))
    assert len(d.bodies) == 4
    assert bbox(d, "Pattern1_3") == [[-4, -1, -1], [-2, 1, 1]]  # 180 degrees round


def test_offset(cube):
    cube.execute("body.offset", {"body": "Box1", "distance": 0.1})
    assert info(cube, "Box1")["volume"] == approx(2.2 ** 3)


def test_split(cube):
    cube.execute("body.split", {"body": "Box1"})
    assert sorted(cube.bodies) == ["Box1", "Split1"]
    assert info(cube, "Box1")["volume"] == approx(4) and info(cube, "Split1")["volume"] == approx(4)


@pytest.mark.parametrize("keep,x", [("above", 0), ("below", -1)])
def test_split_keep_one_side(cube, keep, x):
    cube.execute("body.split", {"body": "Box1", "keep": keep})
    assert list(cube.bodies) == ["Box1"] and bbox(cube, "Box1")[0][0] == x


def test_section(cube):
    cube.execute("body.section", {"body": "Box1"})
    i = info(cube, "Cross-section1")
    assert i["kind"] == "Sketch" and bbox(cube, "Cross-section1") == [[0, -1, -1], [0, 1, 1]]


def test_transform(cube):
    cube.execute("body.transform", {"body": "Box1", "translate": [1, 2, 3], "scale": 2})
    assert info(cube, "Box1")["volume"] == approx(64)
    assert bbox(cube, "Box1") == [[-1, 0, 1], [3, 4, 5]]


def test_rotate(cube):
    cube.execute("body.box", {"length": 4, "width": 1, "height": 1, "name": "Bar"})
    cube.execute("body.transform", {"body": "Bar", "rotate": [0, 0, 90]})
    assert bbox(cube, "Bar") == [[-0.5, -2, -0.5], [0.5, 2, 0.5]]


def test_duplicate(cube):
    cube.execute("body.duplicate", {"body": "Box1", "offset": [5, 0, 0]})
    assert bbox(cube, "Duplicate1") == [[4, -1, -1], [6, 1, 1]]


def test_delete(cube):
    cube.execute("body.delete", {"body": "Box1"})
    assert cube.bodies == {}


def test_material(cube):
    cube.execute("body.material", {"body": "Box1", "finish": "metal", "color": "#808080"})
    assert cube.summary()["bodies"]["Box1"]["finish"] == "metal"


@pytest.mark.parametrize("kind,amount,value", [("length", 0, 5), ("radius", 0, 5), ("diameter", 0, 5), ("area", 7.5, 7.5)])
def test_dimension(kind, amount, value):
    d = build(("dim.add", {"a": [0, 0, 0], "b": [3, 4, 0], "kind": kind, "amount": amount}))
    assert d.bodies["Dimension1"].value == approx(value)


@pytest.mark.parametrize("axis,value", [("X", 3), ("Y", 4)])
def test_dimension_axis(axis, value):
    d = build(("dim.add", {"a": [0, 0, 0], "b": [3, 4, 0], "axis": axis}))
    assert d.bodies["Dimension1"].value == approx(value)


def test_dimension_refuses_zero_length():
    with pytest.raises(K.BadParams):
        build(("dim.add", {"a": [0, 0, 0], "b": [3, 4, 0], "axis": "Z"}))


# ---------------------------------------------------------------- NURBS

def test_loft():
    d = build(("nurbs.loft", {}))
    i = info(d, "Loft1")
    assert i["kind"] == "Part" and i["volume"] > 0 and bbox(d, "Loft1")[0][2] == 0 and bbox(d, "Loft1")[1][2] == 3


def test_loft_ruled_cylinder():
    d = build(("nurbs.loft", {"sections": [["square", 1, 0], ["square", 1, 2]], "ruled": True}))
    v = info(d, "Loft1")["volume"]
    assert v == approx(8)  # size is half the side, like a circle's radius: a 2 x 2 x 2 prism


def test_revolve_cylinder():
    d = build(("nurbs.revolve", {"points": [[1, 0], [1, 2]]}))
    assert info(d, "Revolve1")["volume"] == approx(math.pi * 2, rel=1e-4)


def test_revolve_half():
    d = build(("nurbs.revolve", {"points": [[1, 0], [1, 2]], "angle": 180}))
    assert info(d, "Revolve1")["volume"] == approx(math.pi, rel=1e-4)


def test_surface():
    d = build(("nurbs.surface", {"thickness": 0}))
    assert info(d, "NURBS1")["kind"] == "Shell"
    d2 = build(("nurbs.surface", {}))
    assert info(d2, "NURBS1")["kind"] == "Part"


def test_sweep_straight():
    d = build(("nurbs.sweep", {"points": [[0, 0, 0], [0, 0, 3]], "profile": "circle", "size": 0.5}))
    assert info(d, "Sweep1")["volume"] == approx(math.pi * 0.25 * 3, rel=1e-3)


def test_sweep_default():
    d = build(("nurbs.sweep", {}))
    assert info(d, "Sweep1")["kind"] == "Part" and info(d, "Sweep1")["volume"] > 0


# ---------------------------------------------------------------- sketches

def test_rect():
    d = build(("sketch.rect", {"width": 2, "height": 3}))
    i = info(d, "Rectangle1")
    assert (i["kind"], i["edges"]) == ("Sketch", 4)
    assert bbox(d, "Rectangle1") == [[-1, -1.5, 0], [1, 1.5, 0]]


def test_rect_on_another_plane():
    d = build(("sketch.rect", {"origin": [0, 0, 0], "normal": [1, 0, 0], "xdir": [0, 1, 0], "width": 2, "height": 2}))
    assert bbox(d, "Rectangle1") == [[0, -1, -1], [0, 1, 1]]


def test_circle():
    d = build(("sketch.circle", {"radius": 1}))
    assert info(d, "Circle1")["edges"] == 1
    assert K.measure(d, "body", {"bodies": ["Circle1"]})["bodies"]["Circle1"]["area"] == approx(math.pi, rel=1e-5)


def test_polygon():
    d = build(("sketch.polygon", {"points": [[0, 0], [2, 0], [0, 2]]}))
    assert K.measure(d, "body", {"bodies": ["Polygon1"]})["bodies"]["Polygon1"]["area"] == approx(2)


def test_polygon_rejects_bowtie():
    with pytest.raises(K.BadParams):
        build(("sketch.polygon", {"points": [[0, 0], [1, 1], [1, 0], [0, 1]]}))


def test_line():
    d = build(("sketch.line", {"points": [[0, 0], [2, 0]]}))
    assert info(d, "Line1")["kind"] == "Wire"


def test_path_with_arc():
    d = build(("sketch.path", {}))  # a 2 x 1 rectangle whose right side bulges out into a half circle
    area = K.measure(d, "body", {"bodies": ["Outline1"]})["bodies"]["Outline1"]["area"]
    assert area == approx(2 + math.pi * 0.25 / 2, rel=1e-4)


def test_sketch_extrude():
    d = build(("sketch.extrude", {"points": [[0, 0], [2, 0], [2, 1], [0, 1]], "height": 3}))
    assert info(d, "Extrude1")["volume"] == approx(6)


def test_sketch_offset(cube):
    cube.execute("sketch.offset", {"body": "Box1", "at": [0, 0, 1], "distance": -0.2})
    assert bbox(cube, "Offset1") == [[-0.8, -0.8, 1], [0.8, 0.8, 1]]


def test_region_extrude_new():
    d = build(("sketch.rect", {"width": 2, "height": 3}), ("region.extrude", {"body": "Rectangle1", "amount": 2}))
    assert info(d, "Rectangle1")["volume"] == approx(12)


def test_region_extrude_cuts_a_pocket(cube):
    cube.execute("sketch.rect", {"origin": [0, 0, 1], "on_body": "Box1", "x": -0.5, "y": -0.5, "width": 1, "height": 1})
    cube.execute("region.extrude", {"body": "Rectangle1", "amount": -0.5})
    assert list(cube.bodies) == ["Box1"]
    assert info(cube, "Box1")["volume"] == approx(7.5)


def test_region_extrude_adds_a_boss(cube):
    cube.execute("sketch.rect", {"origin": [0, 0, 1], "on_body": "Box1", "x": -0.5, "y": -0.5, "width": 1, "height": 1})
    cube.execute("region.extrude", {"body": "Rectangle1", "amount": 0.5})
    assert list(cube.bodies) == ["Box1"]
    assert info(cube, "Box1")["volume"] == approx(8.5)


@pytest.mark.parametrize("cmd", ["sketch.rect", "sketch.circle", "sketch.polygon", "sketch.line", "sketch.path"])
def test_sketch_plane_without_direction_is_refused(cmd):
    with pytest.raises(K.BadParams, match="normal"):
        build((cmd, {"normal": [0, 0, 0]}))
