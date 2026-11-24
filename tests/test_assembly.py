"""Assembly: mates move one body onto another body's face; later edits carry the mate with them."""
import pytest

from conftest import K, bbox, build, info

approx = pytest.approx


def two(**kw):
    return build(("body.box", {"name": "A"}), ("body.box", {"length": 1, "width": 1, "height": 1, "at": [5, 5, 5], "name": "B", **kw}))


def mate(d, **p):
    d.execute("asm.mate", {"body": "B", "target": "A", **p})


def test_flush_sets_a_body_on_a_face_and_it_slides_on_the_plane():
    d = two()
    mate(d, at=[5, 5, 4.5], target_at=[0, 0, 1])  # B's underside onto A's top
    assert bbox(d, "B") == [[4.5, 4.5, 1], [5.5, 5.5, 2]]  # on the top, where it was sideways


def test_flush_with_a_gap_and_a_turn():
    d = two()
    mate(d, at=[5, 5, 5.5], target_at=[1, 0, 0], offset=0.5)  # B's top against A's +x side, 0.5 apart: B turns to lie on that side
    lo, hi = bbox(d, "B")
    assert lo[0] == approx(1.5) and hi[0] == approx(2.5) and info(d, "B")["volume"] == approx(1)


def test_center_brings_the_faces_together():
    d = two()
    mate(d, at=[5, 5, 4.5], target_at=[0, 0, 1], center=True)
    assert bbox(d, "B") == [[-0.5, -0.5, 1], [0.5, 0.5, 2]]


def test_align_puts_faces_on_one_plane_facing_the_same_way():
    d = build(("body.box", {"name": "A"}), ("body.box", {"length": 1, "width": 1, "height": 1, "at": [3, 0, 0], "name": "B"}))
    mate(d, at=[3, 0, -0.5], target_at=[0, 0, -1], kind="align", center=True)
    assert bbox(d, "B") == [[-0.5, -0.5, -1], [0.5, 0.5, 0]]


def test_concentric_shares_the_axis():
    d = build(("body.cylinder", {"radius": 1, "height": 2, "name": "A"}),
              ("body.cylinder", {"radius": 0.4, "height": 1, "at": [4, 3, 0], "name": "B"}),
              ("body.transform", {"body": "B", "rotate": [90, 0, 0], "pivot": [4, 3, 0]}))
    d.execute("asm.mate", {"body": "B", "at": [4.4, 3, 0], "target": "A", "target_at": [1, 0, 0], "kind": "concentric"})
    lo, hi = bbox(d, "B")
    assert (lo[0], hi[0], lo[1], hi[1]) == (approx(-0.4), approx(0.4), approx(-0.4), approx(0.4)) and hi[2] - lo[2] == approx(1)


def test_the_mate_follows_edits_of_the_bodies():
    d = two()
    mate(d, at=[5, 5, 4.5], target_at=[0, 0, 1])
    d.update(1, {"height": 6})  # A grows taller: B stays on its top
    assert not d.errors and bbox(d, "B")[0][2] == approx(3)
    d.update(1, {"height": 2})
    assert bbox(d, "B")[0][2] == approx(1)


def test_a_mate_keeps_to_its_face_when_the_target_changes_shape():
    d = two()
    mate(d, at=[5, 5, 4.5], target_at=[0.9, 0, 1])
    d.update(1, {"height": 8, "length": 1})  # the old target point is nearer A's +x side now
    assert not d.errors and bbox(d, "B")[0][2] == approx(4)


@pytest.mark.parametrize("p,why", [
    ({"body": "A"}, "itself"),
    ({"kind": "concentric", "at": [5, 5, 4.5], "target_at": [0, 0, 1]}, "round faces"),
    ({"at": [50, 50, 50], "target_at": [0, 0, 1]}, "no face near"),
])
def test_refusals(p, why):
    d = two()
    with pytest.raises(K.BadParams, match=why):
        d.execute("asm.mate", {"body": "B", "target": "A", "at": [5, 5, 4.5], "target_at": [0, 0, 1], **p})
    assert bbox(d, "B") == [[4.5, 4.5, 4.5], [5.5, 5.5, 5.5]]  # nothing moved


def test_a_sketch_or_missing_body_is_refused():
    d = build(("body.box", {"name": "A"}), ("sketch.rect", {"name": "S"}))
    for body in ("S", "Nope"):
        with pytest.raises(K.BadParams):
            d.execute("asm.mate", {"body": body, "target": "A", "at": [0, 0, 0], "target_at": [0, 0, 1]})


# ---------------------------------------------------------------- joints, groups, parts list

def test_mate_angle_turns_the_part_about_the_shared_axis():
    d = build(("body.cylinder", {"radius": 1, "height": 2, "name": "Pin"}), ("body.box", {"length": 3, "width": 0.5, "height": 0.5, "at": [0, 0, 3], "name": "Arm"}))
    d.execute("asm.mate", {"body": "Arm", "at": [0, 0, 2.75], "target": "Pin", "target_at": [0, 0, 1], "angle": 90})
    assert bbox(d, "Arm") == [[-0.25, -1.5, 1], [0.25, 1.5, 1.5]]  # was along x; now along y, still sitting on the pin


def test_the_angle_can_be_a_variable_so_the_joint_can_be_driven():
    d = build(("var.set", {"var": "open", "value": 0}), ("body.cylinder", {"radius": 1, "height": 2, "name": "Pin"}),
              ("body.box", {"length": 3, "width": 0.5, "height": 0.5, "at": [0, 0, 3], "name": "Arm"}))
    d.execute("asm.mate", {"body": "Arm", "at": [0, 0, 2.75], "target": "Pin", "target_at": [0, 0, 1], "angle": "=open"})
    assert bbox(d, "Arm")[1][0] == approx(1.5)
    d.update(1, {"value": 90})
    assert not d.errors and bbox(d, "Arm") == [[-0.25, -1.5, 1], [0.25, 1.5, 1.5]]


def groups():
    return build(("body.box", {"name": "Arm"}), ("body.box", {"name": "Flag", "at": [0, 0, 8]}), ("body.box", {"name": "Base", "at": [20, 0, 0]}),
                 ("asm.group", {"group": "Hand", "bodies": ["Arm", "Flag"]}))


def test_group_moves_together():
    d = groups()
    d.execute("asm.move", {"group": "Hand", "translate": [10, 0, 0]})
    assert bbox(d, "Arm")[0][0] == approx(9) and bbox(d, "Flag")[0][0] == approx(9) and bbox(d, "Base")[0][0] == approx(19)
    assert d.groups == {"Hand": ["Arm", "Flag"]} and d.summary()["groups"] == d.groups


def test_group_rotates_about_a_pivot_and_one_body_can_be_moved_by_name():
    d = groups()
    d.execute("asm.move", {"group": "Hand", "rotate": [0, 0, 90], "pivot": [5, 0, 0]})
    assert bbox(d, "Arm") == [[4, -6, -1], [6, -4, 1]]
    d.execute("asm.move", {"group": "Base", "translate": [0, 0, 1]})
    assert bbox(d, "Base")[0][2] == approx(0)


def test_group_follows_edits_and_loses_deleted_bodies():
    d = groups()
    d.execute("body.delete", {"body": "Flag"})
    assert d.groups == {"Hand": ["Arm"]}
    d.undo()
    assert d.groups == {"Hand": ["Arm", "Flag"]}


@pytest.mark.parametrize("cmd,p", [
    ("asm.group", {"group": "Bad Name", "bodies": ["Arm"]}), ("asm.group", {"group": "G", "bodies": []}),
    ("asm.group", {"group": "G", "bodies": ["Nope"]}), ("asm.group", {"group": "Arm", "bodies": ["Arm"]}),
    ("asm.move", {"group": "Nope"}),
])
def test_group_refusals(cmd, p):
    d = groups()
    before = list(d.features)
    with pytest.raises(K.BadParams):
        d.execute(cmd, p)
    assert d.features == before


def test_parts_list_counts_identical_parts():
    d = build(*[("body.box", {"length": 10, "width": 20, "height": 5, "at": [i * 30, 0, 0], "name": f"Plate{i}"}) for i in range(3)],
              ("body.cylinder", {"radius": 3, "height": 8, "at": [0, 50, 0], "name": "Pin"}), ("body.material", {"body": "Pin", "finish": "metal"}),
              ("sketch.rect", {"name": "S"}), ("asm.group", {"group": "Stack", "bodies": ["Plate0", "Plate1"]}))
    rows = K.measure(d, "parts", {})["parts"]
    assert [(r["qty"], r["names"]) for r in rows] == [(1, ["Pin"]), (3, ["Plate0", "Plate1", "Plate2"])]  # the sketch is not a part
    assert rows[1]["groups"] == ["Stack"] and rows[0]["finish"] == "metal"
    csv = K.export(d, "csv").decode().splitlines()
    assert csv[0].startswith("Item,Qty,Names") and csv[2].startswith("2,3,Plate0 Plate1 Plate2,Part,1000,")


def test_parts_list_with_nothing_to_list():
    with pytest.raises(K.BadParams):
        K.export(K.Document(), "csv")


def test_example_arm_swings_with_its_variable():
    import json
    import pathlib
    d = K.Document()
    d.load_json(json.loads((pathlib.Path(__file__).parent.parent / "examples" / "arm.nrk").read_text()))
    assert not d.errors and d.groups == {"Lever": ["Arm", "Knob"]}
    var = next(f for f in d.features if f["cmd"] == "var.set")
    d.update(var["id"], {"value": 0})
    knob = bbox(d, "Knob")
    assert knob[0][0] == approx(56) and knob[1][2] == approx(60) and knob[0][2] == approx(46)  # straight out along x, on the arm
