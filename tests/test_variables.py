"""Variables (var.set) and expressions in parameters: change one number and every step that uses it follows."""
import math

import pytest

from conftest import K, bbox, build, info

import expr  # noqa: E402

approx = pytest.approx


def test_a_box_follows_its_variables():
    d = build(("var.set", {"var": "h", "value": 3}), ("var.set", {"var": "w", "value": "=h * 2"}),
              ("body.box", {"length": "=w", "width": 2, "height": "=h", "at": [0, 0, "=h / 2"]}))
    assert info(d, "Box1")["volume"] == approx(36) and bbox(d, "Box1")[0][2] == 0
    d.update(1, {"value": 1})
    assert not d.errors and info(d, "Box1")["volume"] == approx(4) and bbox(d, "Box1") == [[-1, -1, 0], [1, 1, 1]]
    assert d.variables == {"h": 1, "w": 2}
    assert d.summary()["variables"] == {"h": 1, "w": 2}


def test_expressions_in_sketch_points_and_later_steps():
    d = build(("var.set", {"var": "s", "value": 2}),
              ("sketch.polygon", {"points": [[0, 0], ["=s", 0], ["=s", "=s"], [0, "=s"]]}),
              ("region.extrude", {"body": "Polygon1", "amount": "=s / 2"}))
    assert info(d, "Polygon1")["volume"] == approx(4)
    d.update(1, {"value": 4})
    assert info(d, "Polygon1")["volume"] == approx(32)


def test_a_variable_is_only_seen_after_it_is_set():
    with pytest.raises(K.BadParams, match="no variable 'h'"):
        build(("body.box", {"height": "=h"}))


def test_a_variable_can_be_set_again():
    d = build(("var.set", {"var": "a", "value": 1}), ("body.box", {"length": "=a", "name": "A"}),
              ("var.set", {"var": "a", "value": 3}), ("body.box", {"length": "=a", "name": "B"}))
    assert bbox(d, "A")[1][0] == approx(0.5) and bbox(d, "B")[1][0] == approx(1.5)


def test_ranges_still_apply_after_working_out():
    with pytest.raises(K.BadParams, match=">="):
        build(("var.set", {"var": "h", "value": 1}), ("body.box", {"height": "=h - 5"}))


@pytest.mark.parametrize("bad", ["=__import__('os')", "=h.real", "=[1]", "='x'", "=lambda: 1", "=open('f')", "=1 if 1 else 2",
                                 "=2 ** 999", "=True", "=" + "1+" * 300 + "1", "=sqrt(-1)", "=1/0"])
def test_hostile_expressions_are_refused(bad):
    with pytest.raises(K.BadParams):
        build(("var.set", {"var": "h", "value": 1}), ("body.box", {"length": bad}))


@pytest.mark.parametrize("name", ["", "1a", "a b", "sqrt", "pi", "x" * 50, "a-b"])
def test_bad_variable_names(name):
    with pytest.raises(K.BadParams):
        build(("var.set", {"var": name, "value": 1}))


def test_functions_and_constants():
    v = {"r": 2}
    assert expr.evaluate("=2 * pi * r", v) == approx(4 * math.pi)
    assert expr.evaluate("=sin(30) + cos(60)", v) == approx(1)
    assert expr.evaluate("=max(r, 5) - min(1, r) + sqrt(16) + round(2.6) + abs(-1)", v) == approx(5 - 1 + 4 + 3 + 1)
    assert expr.names("=w * 2 + sqrt(h) + pi") == ["h", "w"]


def test_saved_and_loaded_with_expressions():
    d = build(("var.set", {"var": "h", "value": 2}), ("body.box", {"height": "=h"}))
    e = K.Document()
    e.load_json(d.to_json())
    assert e.features[1]["params"]["height"] == "=h" and info(e, "Box1")["volume"] == approx(8)
