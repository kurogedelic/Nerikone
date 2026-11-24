"""Stable references: after an earlier step is edited, later steps still act on the face or edge they were made on."""
import json

import pytest

from conftest import K, bbox, build, info

approx = pytest.approx


def rounds(d, name="Box1"):
    """Centres of the curved faces (where the fillets are)."""
    return [[round(c, 2) + 0.0 for c in (f.center().x, f.center().y, f.center().z)] for f in d.bodies[name].faces() if not f.is_planar]


def test_pull_keeps_its_face_when_the_body_changes_shape():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0.9, 0, 1], "amount": 1}))
    d.update(1, {"height": 6, "length": 1})  # the old point is now nearer the +x side than the top
    assert not d.errors
    assert bbox(d, "Box1") == [[-0.5, -1, -3], [0.5, 1, 4]]


def test_shell_keeps_its_open_face():
    d = build(("body.box", {}), ("body.shell", {"body": "Box1", "open_at": [0, 0, 1], "thickness": 0.1}))
    d.update(1, {"height": 5})
    assert info(d, "Box1")["volume"] == approx(2 * 2 * 5 - 1.8 * 1.8 * 4.9)  # open at the top, not a side


def test_fillet_follows_its_edge_up():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1}),
              ("edge.fillet", {"body": "Box1", "edges": [[1, 0, 2]], "radius": 0.2}))
    d.update(2, {"amount": 3})  # the top edge it rounded moves from z=2 to z=4
    assert rounds(d) == [[0.93, 0, 3.93]]


def test_references_are_recorded_and_saved():
    d = build(("body.box", {}), ("edge.fillet", {"body": "Box1", "edges": [[1, 0, 1]], "radius": 0.2}))
    refs = d.features[1]["refs"]
    (sig,) = refs.values()
    assert sig["type"] == "line" and len(sig["faces"]) == 2
    e = K.Document()
    e.load_json(json.loads(json.dumps(d.to_json())))
    assert e.features[1]["refs"] == refs
    e.update(1, {"height": 4})
    assert rounds(e) == [[0.93, 0, 1.93]]


def test_editing_a_step_records_again():
    d = build(("body.box", {}), ("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1}))
    d.update(2, {"at": [1, 0, 0]})  # now the +x side
    (sig,) = d.features[1]["refs"].values()
    assert sig["n"] == [1, 0, 0]
    assert bbox(d, "Box1") == [[-1, -1, -1], [2, 1, 1]]


def test_old_documents_without_records_still_work():
    d = K.Document()
    d.load_json({"features": [
        {"id": 1, "cmd": "body.box", "params": {"length": 2, "width": 2, "height": 2, "at": [0, 0, 0], "name": "Box1"}},
        {"id": 2, "cmd": "face.extrude", "params": {"body": "Box1", "at": [0, 0, 1], "amount": 1, "keep_face": False}},
    ]})
    assert not d.errors and bbox(d, "Box1")[1][2] == 2


def test_a_turned_body_falls_back_to_nearness():
    """When the recorded direction no longer fits (the body was turned upstream), the nearest face wins, as before."""
    d = build(("body.box", {"length": 4, "width": 2, "height": 2}),
              ("body.transform", {"body": "Box1", "rotate": [0, 0, 0]}),
              ("face.extrude", {"body": "Box1", "at": [2, 0, 0], "amount": 1}))
    d.update(2, {"rotate": [0, 0, 45]})  # no face looks along +x any more
    assert not d.errors and info(d, "Box1")["volume"] > 16  # still pulled: the face nearest the point


def test_preview_and_measure_do_not_record(cube):
    cube.preview("face.extrude", {"body": "Box1", "at": [0, 0, 1], "amount": 1})
    K.measure(cube, "angle", {"a": "Box1", "at_a": [0, 0, 1], "b": "Box1", "at_b": [1, 0, 0]})
    assert "refs" not in cube.features[0]
    assert K._REFS.__dict__.get("ctx") is None
