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
