"""Export every format, and read the ones Nerikone imports back in: the model survives the round trip."""
import io
import json
import zipfile

import pytest

from conftest import K, bbox, build, info

approx = pytest.approx


@pytest.fixture
def two():
    return build(("body.box", {}), ("body.cylinder", {"radius": 0.5, "height": 1, "at": [4, 0, 0]}))


@pytest.mark.parametrize("fmt", sorted(K.EXPORTS))
def test_every_export_format(two, fmt):
    data = K.export(two, fmt)
    assert isinstance(data, bytes) and len(data) > 50


def test_export_one_body(two):
    whole, one = K.export(two, "stl"), K.export(two, "stl", ["Box1"])
    assert len(one) < len(whole)


def test_export_refuses(two):
    with pytest.raises(K.BadParams):
        K.export(two, "pdf")
    with pytest.raises(K.BadParams):
        K.export(two, "stl", tolerance=0)
    with pytest.raises(K.BadParams):
        K.export(K.Document(), "step")  # nothing to export


def test_finer_tolerance_gives_more_facets(two):
    assert len(K.export(two, "stl", tolerance=0.001)) > len(K.export(two, "stl", tolerance=0.1))


def test_3mf_package(two):
    two.set_units("cm")
    z = zipfile.ZipFile(io.BytesIO(K.export(two, "3mf")))
    model = z.read("3D/3dmodel.model").decode()
    assert 'unit="centimeter"' in model and model.count("<object ") == 2


def test_step_units(two):
    two.set_units("in")
    assert b"INCH" in K.export(two, "step").upper()


def imported(data, fmt, **params):
    d = K.Document()
    d.execute("file.import", {"blob": K.add_blob(data), "format": fmt, "name": "Imp", **params})
    return d


def test_step_round_trip(two):
    d = imported(K.export(two, "step"), "step")
    vols = sorted(round(b.volume, 4) for b in d.bodies.values())
    assert vols == approx(sorted([8, 3.14159 * 0.25]), rel=1e-4)


@pytest.mark.parametrize("fmt", ["stl", "obj", "glb", "3mf", "wrl"])
def test_mesh_round_trip(fmt):
    d0 = build(("body.box", {"at": [1, 2, 3]}))
    d = imported(K.export(d0, fmt), fmt)
    assert info(d, "Imp")["kind"] == "Mesh"
    assert bbox(d, "Imp", 4) == [[0, 1, 2], [2, 3, 4]]


@pytest.mark.parametrize("fmt", ["stl", "obj", "3mf"])
def test_mesh_to_solid(fmt):
    d = imported(K.export(build(("body.box", {})), fmt), fmt, to_solid=True)
    assert info(d, "Imp")["kind"] == "Part" and info(d, "Imp")["volume"] == approx(8, rel=1e-6)


def test_import_scale_and_place():
    data = K.export(build(("body.box", {"at": [10, 10, 10]})), "step")
    assert bbox(imported(data, "step", scale=10, place="ground"), "Imp") == [[-10, -10, 0], [10, 10, 20]]
    assert bbox(imported(data, "step", place="origin"), "Imp") == [[-1, -1, -1], [1, 1, 1]]
    assert bbox(imported(data, "step"), "Imp") == [[9, 9, 9], [11, 11, 11]]


def test_import_is_saved_with_the_document():
    d = imported(K.export(build(("body.box", {})), "stl"), "stl")
    j = json.loads(K.export(d, "nrk"))
    assert len(j["blobs"]) == 1
    e = K.Document()
    e.load_json(j)
    assert bbox(e, "Imp", 4) == bbox(d, "Imp", 4)


@pytest.mark.parametrize("fmt", ["step", "stl", "obj", "glb", "3mf", "wrl", "iges"])
@pytest.mark.parametrize("junk", [b"", b"garbage" * 10, bytes(range(256))])
def test_import_junk_is_refused(fmt, junk):
    with pytest.raises(K.BadParams):
        imported(junk, fmt)


def test_unknown_blob():
    with pytest.raises(K.BadParams):
        K.Document().execute("file.import", {"blob": "0" * 16, "format": "stl"})


def test_drawing_views(two):
    svg = K.export(two, "svg").decode()
    assert svg.lstrip().startswith("<") and "<svg" in svg
    assert b"SECTION" in K.export(two, "dxf")
