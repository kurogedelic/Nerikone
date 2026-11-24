"""The document: timeline, undo/redo, parametric edits, failures that change nothing, persistence, measuring."""
import json
import os
import signal

import pytest

from conftest import K, bbox, build, info

approx = pytest.approx


def snapshot(d):
    return json.dumps(d.to_json()), sorted(d.bodies), list(d.undo_stack)


# ---------------------------------------------------------------- failures change nothing

@pytest.mark.parametrize("cmd,params", [
    ("body.box", {"length": -1}),
    ("body.box", {"length": "wide"}),
    ("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]], "radius": 5}),
    ("face.move", {"body": "Box1", "at": [0, 0, 1], "by": [0, 0, -3]}),
    ("body.boolean", {"kind": "cut", "target": "Box1", "tools": ["Nope"]}),
    ("face.extrude", {"body": "Box1", "at": [50, 50, 50], "amount": 1}),  # far from every face
    ("no.such.command", {}),
])
def test_failure_leaves_document_unchanged(cube, cmd, params):
    before = snapshot(cube)
    with pytest.raises(K.BadParams):
        cube.execute(cmd, params)
    assert snapshot(cube) == before


def test_preview_stores_nothing(cube):
    before = snapshot(cube)
    out = cube.preview("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1})
    assert out["Box1"].volume == approx(12)
    assert snapshot(cube) == before and info(cube, "Box1")["volume"] == approx(8)


# ---------------------------------------------------------------- undo / redo

def test_undo_redo():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1}))
    d.undo()
    assert info(d, "Box1")["volume"] == approx(8) and len(d.features) == 1
    d.undo()
    assert d.bodies == {} and d.features == []
    d.undo()  # nothing left: harmless
    d.redo()
    d.redo()
    assert info(d, "Box1")["volume"] == approx(12)
    d.redo()  # nothing left: harmless
    assert len(d.features) == 2


def test_new_step_clears_redo(cube):
    cube.execute("body.sphere", {})
    cube.undo()
    cube.execute("body.cylinder", {})
    cube.redo()
    assert sorted(cube.bodies) == ["Box1", "Cylinder1"]


# ---------------------------------------------------------------- parametric edits

def test_edit_an_earlier_step_rebuilds_the_rest():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1}),
              ("edge.fillet", {"body": "Box1", "edges": [[1, 0, 2]], "radius": 0.2}))
    d.update(1, {"length": 4})
    assert not d.errors
    assert bbox(d, "Box1") == [[-2, -1, -1], [2, 1, 2]]
    assert info(d, "Box1")["faces"] == 7  # the fillet is still there


def test_edit_that_breaks_a_later_step_keeps_the_model():
    d = build(("body.box", {}), ("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]], "radius": 0.5}))
    d.update(1, {"length": 0.5, "width": 0.5, "height": 0.5})  # the fillet no longer fits, or misses its edge
    if d.errors:
        assert list(d.errors) == [2]
        assert info(d, "Box1")["volume"] == approx(0.125)  # the failed step passes the model through
    d.update(1, {"length": 2, "width": 2, "height": 2})
    assert not d.errors and info(d, "Box1")["faces"] == 7


def test_bad_edit_is_refused(cube):
    with pytest.raises(K.BadParams):
        cube.update(1, {"length": -2})
    assert info(cube, "Box1")["volume"] == approx(8)


def test_suppress_and_delete():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1}))
    d.update(2, suppressed=True)
    assert info(d, "Box1")["volume"] == approx(8)
    d.update(2, suppressed=False)
    assert info(d, "Box1")["volume"] == approx(12)
    d.delete(2)
    assert len(d.features) == 1 and info(d, "Box1")["volume"] == approx(8)
    with pytest.raises(K.BadParams):
        d.delete(99)


def test_preview_update(cube):
    out = cube.preview_update(1, {"height": 4})
    assert out["Box1"].volume == approx(16) and info(cube, "Box1")["volume"] == approx(8)


def test_limit_finds_the_largest_fillet(cube):
    r = cube.limit("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]]}, "radius", 0.01, 5)
    assert r is not None and 0.9 < r <= 2  # an edge between two 2-wide faces takes up to about half their width


def test_limit_none_when_nothing_works(cube):
    assert cube.limit("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]]}, "radius", 10, 20) is None


# ---------------------------------------------------------------- persistence

def test_json_round_trip():
    d = build(("body.box", {}), ("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]], "radius": 0.2}),
              ("sketch.circle", {"radius": 0.3, "origin": [0, 0, 1]}))
    d.set_units("cm")
    e = K.Document()
    e.load_json(json.loads(json.dumps(d.to_json())))
    assert e.units == "cm" and sorted(e.bodies) == sorted(d.bodies)
    assert info(e, "Box1")["volume"] == approx(info(d, "Box1")["volume"])
    assert e.next_id == d.next_id


def test_old_documents_get_new_parameters_by_default():
    d = K.Document()
    d.load_json({"features": [{"id": 1, "cmd": "body.box", "params": {"length": 2, "width": 2, "height": 2, "name": "Box1"}}]})
    assert info(d, "Box1")["volume"] == approx(8)  # `at` was added later


@pytest.mark.parametrize("junk", [{}, {"features": "x"}, [], "text"])
def test_load_rejects_junk(junk):
    with pytest.raises((K.BadParams, AttributeError)):
        K.Document().load_json(junk)


def test_units():
    d = K.Document()
    d.set_units("in")
    with pytest.raises(K.BadParams):
        d.set_units("furlong")
    assert d.units == "in"


def test_summary_shape(cube):
    s = cube.summary()
    assert s["can_undo"] and not s["can_redo"]
    assert s["features"][0]["label"] and s["features"][0]["error"] is None
    assert s["bodies"]["Box1"]["volume"] == approx(8)


def test_inspect_points_are_reusable(cube):
    """inspect_body hands out points; feeding a face point back must find that same face."""
    ins = K.inspect_body(cube.bodies["Box1"])
    assert len(ins["face_list"]) == 6 and len(ins["edge_list"]) == 12
    top = next(f for f in ins["face_list"] if f["normal"] == [0, 0, 1])
    cube.execute("face.extrude", {"body": "Box1", "at": top["point"], "amount": 1})
    assert bbox(cube, "Box1")[1][2] == 2


# ---------------------------------------------------------------- measuring

def test_measure_body(cube):
    m = K.measure(cube, "body", {"bodies": ["Box1"]})["bodies"]["Box1"]
    assert m["volume"] == approx(8) and m["area"] == approx(24) and m["center"] == [0, 0, 0] and m["size"] == [2, 2, 2]


def test_measure_distance():
    d = build(("body.box", {}), ("body.box", {"at": [5, 0, 0]}))
    assert K.measure(d, "distance", {"a": "Box1", "b": "Box2"})["distance"] == approx(3)


def test_measure_interference():
    d = build(("body.box", {}), ("body.box", {"at": [1, 0, 0]}), ("body.box", {"at": [10, 0, 0]}))
    pairs = K.measure(d, "interference", {})["pairs"]
    assert [(p["a"], p["b"]) for p in pairs] == [("Box1", "Box2")] and pairs[0]["volume"] == approx(4)


def test_measure_angle(cube):
    a = K.measure(cube, "angle", {"a": "Box1", "at_a": [0, 0, 1], "b": "Box1", "at_b": [1, 0, 0]})
    assert a["angle"] == approx(90)


def test_measure_draft(cube):
    m = K.measure(cube, "draft", {"body": "Box1", "direction": [0, 0, 1]})
    assert m  # sides are vertical: there is something to report


@pytest.mark.parametrize("kind,params", [("nope", {}), ("distance", {"a": "Box1", "b": "Ghost"}), ("body", "x"),
                                         ("draft", {"body": "Box1", "direction": [0, 0, 0]})])
def test_measure_refuses_bad_input(cube, kind, params):
    with pytest.raises(K.BadParams):
        K.measure(cube, kind, params)


# ---------------------------------------------------------------- hostile input never crashes

class Timeout(Exception):
    pass


# the quick set runs every time; NERIKONE_FUZZ=1 adds the slow extremes (huge and tiny numbers make the kernel work hard)
VALUES = [0, -1, float("nan"), "x", None, []] + ([1e-12, 1e9, float("inf"), {}] if os.environ.get("NERIKONE_FUZZ") else [])


def _fuzz_cases():
    for cid, cmd in sorted(K.COMMANDS.items()):
        for q in cmd.params:
            if q.name == "name":
                continue
            for v in VALUES:
                yield cid, q.name, v


def test_fuzz_every_parameter():
    """Each parameter of each command, set to junk: the answer is a result or BadParams, never another exception or a hang."""
    base = build(("body.box", {"length": 3, "width": 3, "height": 2}), ("sketch.rect", {"width": 2, "height": 2}))
    state = base.to_json()

    def alarm(*_):
        raise Timeout()

    old = signal.signal(signal.SIGALRM, alarm)
    bad = []
    try:
        for cid, pname, v in _fuzz_cases():
            cmd = K.COMMANDS[cid]
            params = {q.name: q.default for q in cmd.params if q.default is not None and q.name != "name"}
            for key in ("body", "target"):
                if any(q.name == key for q in cmd.params):
                    params[key] = "Rectangle1" if cid == "region.extrude" else "Box1"
            params[pname] = v
            d = K.Document()
            d.load_json(state)
            signal.alarm(20)
            try:
                d.execute(cid, params)
            except K.BadParams:
                pass
            except Timeout:
                bad.append((cid, pname, v, "timeout"))
            except Exception as e:  # noqa: BLE001
                bad.append((cid, pname, v, f"{type(e).__name__}: {e}"))
            finally:
                signal.alarm(0)
    finally:
        signal.signal(signal.SIGALRM, old)
    assert not bad, "\n".join(map(str, bad[:20]))


# ---------------------------------------------------------------- reuse of earlier results

def test_undo_redo_reuse_what_was_built():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1}))
    built = d.bodies["Box1"]
    d.undo()
    d.redo()
    assert d.bodies["Box1"] is built  # not built again


def test_an_edit_upstream_builds_again():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1}))
    d.update(1, {"height": 4})
    assert info(d, "Box1")["volume"] == approx(4 * 5)
    d.undo()
    assert info(d, "Box1")["volume"] == approx(12)


def test_failures_are_not_remembered():
    d = K.Document()
    d.load_json({"features": [{"id": 1, "cmd": "file.import", "params": {"blob": "f" * 16, "format": "stl", "name": "Imp"}}]})
    assert d.errors  # the file is not there yet
    K.BLOBS["f" * 16] = K.export(build(("body.box", {})), "stl")
    d.rebuild(0)
    assert not d.errors and "Imp" in d.bodies
    del K.BLOBS["f" * 16]
