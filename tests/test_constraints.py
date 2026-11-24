"""Sketch constraints: the solver, and the sketch commands that use it."""
import math

import pytest

from conftest import K, bbox, build, info

import constraints as C  # noqa: E402

approx = pytest.approx
RECT = [[0, 0], [2.1, 0.1], [2, 1.2], [-0.1, 0.9]]
HV = [["horizontal", 0], ["vertical", 1], ["horizontal", 2], ["vertical", 3]]


def close(a, b, tol=1e-6):
    return all(math.dist(p, q) < tol for p, q in zip(a, b))


def test_squares_up_a_rough_rectangle():
    pts, dof = C.solve(RECT, HV)
    assert pts[0][1] == approx(pts[1][1]) and pts[1][0] == approx(pts[2][0])
    assert dof == 4  # where it is (2) and how wide and tall (2)


def test_fully_constrained():
    pts, dof = C.solve(RECT, HV + [["length", 0, 3], ["length", 1, 2], ["fix", 0]])
    assert dof == 0
    fixed = (RECT[0][0], RECT[0][1])
    assert close(pts, [fixed, (fixed[0] + 3, fixed[1]), (fixed[0] + 3, fixed[1] + 2), (fixed[0], fixed[1] + 2)])


def test_nothing_drawn_moves_without_reason():
    pts, _ = C.solve(RECT, [["fix", 0]])
    assert close(pts, [tuple(p) for p in RECT])


def test_equilateral_triangle():
    pts, dof = C.solve([[0, 0], [2, 0], [1, 1.5]], [["equal", 0, 1], ["equal", 1, 2], ["length", 0, 2], ["horizontal", 0], ["fix", 0]])
    assert dof == 0 and pts[2][1] == approx(math.sqrt(3))


@pytest.mark.parametrize("cons,check", [
    ([["parallel", 0, 2]], lambda p: (p[1][1] - p[0][1]) * (p[2][0] - p[3][0]) == approx((p[1][0] - p[0][0]) * (p[2][1] - p[3][1]), abs=1e-7)),
    ([["perpendicular", 0, 1]], lambda p: (p[1][0] - p[0][0]) * (p[2][0] - p[1][0]) + (p[1][1] - p[0][1]) * (p[2][1] - p[1][1]) == approx(0, abs=1e-7)),
    ([["distance", 0, 2, 3]], lambda p: math.dist(p[0], p[2]) == approx(3)),
    ([["x", 1, 5]], lambda p: p[1][0] == approx(5)),
    ([["y", 2, -1]], lambda p: p[2][1] == approx(-1)),
    ([["equal", 0, 1]], lambda p: math.dist(p[0], p[1]) == approx(math.dist(p[1], p[2]))),
])
def test_each_kind(cons, check):
    pts, _ = C.solve(RECT, cons)
    assert check(pts)


@pytest.mark.parametrize("deg", [30, 90, 135, -60])
def test_angle(deg):
    pts, _ = C.solve([[0, 0], [2, 0], [3, 1]], [["angle", 0, 1, deg]], closed=False)
    a = math.degrees(math.atan2(pts[2][1] - pts[1][1], pts[2][0] - pts[1][0]) - math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]))
    assert (a - deg + 180) % 360 - 180 == approx(0, abs=1e-5)


def test_arc_radius():
    pts, _ = C.solve([[0, 0], [2, 0], [2, 1], [0, 1]], [["radius", 1, 1]], bulges=[0, 1, 0, 0])
    assert math.dist(pts[1], pts[2]) == approx(2)  # a half circle of radius 1 spans 2


@pytest.mark.parametrize("cons", [
    [["length", 0, 3], ["length", 0, 4]],
    [["horizontal", 0], ["vertical", 0], ["length", 0, 1]],
])
def test_conflicts_are_refused(cons):
    with pytest.raises(C.ConstraintError, match="cannot all hold"):
        C.solve(RECT, cons)


@pytest.mark.parametrize("bad", [
    "x", [["nope", 0]], [["length", 0]], [["length", 0, -1]], [["length", 0, float("nan")]], [["horizontal", -1]],
    [["horizontal", 1.5]], [["horizontal", True]], [["horizontal", 9]], [["distance", 0, 7, 1]], [["radius", 0, 1]], [[]],
])
def test_junk_is_refused(bad):
    with pytest.raises(C.ConstraintError):
        C.solve(RECT, bad)


def test_redundant_constraints_are_fine():
    pts, dof = C.solve(RECT, HV + [["parallel", 0, 2], ["parallel", 1, 3], ["perpendicular", 0, 1]])
    assert dof == 4


# ---------------------------------------------------------------- in the sketch commands

def test_polygon_with_constraints_drives_a_solid():
    d = build(("sketch.polygon", {"points": RECT, "constraints": HV + [["length", 0, 3], ["length", 1, 2], ["fix", 0]]}),
              ("region.extrude", {"body": "Polygon1", "amount": 1}))
    assert info(d, "Polygon1")["volume"] == approx(6)
    d.update(1, {"constraints": HV + [["length", 0, 5], ["length", 1, 2], ["fix", 0]]})  # a dimension changed
    assert not d.errors and info(d, "Polygon1")["volume"] == approx(10)


def test_summary_reports_the_solution():
    d = build(("sketch.polygon", {"points": RECT, "constraints": HV}))
    s = d.summary()["features"][0]["solved"]
    assert s["dof"] == 4 and len(s["points"]) == 4
    assert "solved" not in build(("sketch.polygon", {"points": RECT})).summary()["features"][0]


def test_path_and_line():
    d = build(("sketch.path", {"points": [[0, 0], [2, 0], [2, 1], [0, 1]], "bulges": [0, 1, 0, 0], "constraints": [["radius", 1, 1]]}),
              ("sketch.line", {"points": [[0, 0], [2, 0.3]], "constraints": [["horizontal", 0], ["length", 0, 4]]}))
    lo, hi = bbox(d, "Line1")
    assert hi[1] - lo[1] == approx(0, abs=1e-9) and hi[0] - lo[0] == approx(4)
    (x0, y0, _), (x1, y1, _) = bbox(d, "Outline1")
    assert (x1 - x0, y1 - y0) == (approx(3), approx(2))  # the right side became a half circle of radius 1: 2 tall, 1 out


def test_conflicting_sketch_is_refused():
    with pytest.raises(K.BadParams, match="cannot all hold"):
        build(("sketch.polygon", {"points": RECT, "constraints": [["length", 0, 3], ["length", 0, 4]]}))
    with pytest.raises(K.BadParams):
        build(("sketch.polygon", {"points": RECT, "constraints": [["bogus"]]}))


def test_a_constraint_that_becomes_redundant_does_not_collapse_the_shape():
    """equal on two opposite sides of an axis-aligned rectangle is true by itself once the others hold: the free height must stay as drawn."""
    pts, dof = C.solve(RECT, HV + [["length", 0, 3], ["equal", 1, 3]])
    assert pts[1][0] - pts[0][0] == approx(3)
    assert abs(pts[2][1] - pts[1][1]) == approx(abs(RECT[2][1] - RECT[1][1]), abs=0.3)  # about as tall as it was drawn
    assert dof == 2


def test_redundant_sets_keep_what_was_drawn():
    base, _ = C.solve(RECT, HV)
    pts, _ = C.solve(RECT, HV + [["parallel", 0, 2], ["parallel", 1, 3], ["perpendicular", 0, 1], ["equal", 1, 3], ["equal", 0, 2]])
    assert close(pts, base, 0.15)
