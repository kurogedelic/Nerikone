"""SCAD import is an exact B-rep feature and survives document serialization."""
import pytest
import kernel as K


def load(source):
    doc = K.Document()
    blob = K.add_blob(source.encode())
    doc.execute('file.import', {'blob': blob, 'format': 'scad', 'name': 'sample'})
    return doc


def test_primitives_and_variables():
    doc = load('size=2+3; cube([size,2,3]); translate([10,0,0]) sphere(r=2); cylinder(h=4,r=1);')
    assert len(doc.bodies) == 3
    assert sorted(round(b.volume(), 4) for b in doc.bodies.values()) == sorted([30, round(4/3*3.141592653589793*8,4), round(3.141592653589793*4,4)])
    restored = K.Document()
    restored.load_json(doc.to_json())
    assert len(restored.bodies) == 3


def test_boolean():
    doc = load('difference() { cube([4,4,4],center=true); cube([2,2,2],center=true); }')
    assert len(doc.bodies) == 1
    assert next(iter(doc.bodies.values())).volume() == pytest.approx(56)


@pytest.mark.parametrize('source', ['import("secret.stl");', 'for(i=[1:100]) cube(1);', 'cube(1); nonsense();', 'cube(1); cube(1) garbage;', 'cube(10^1000000);'])
def test_reject_unsupported(source):
    with pytest.raises(K.BadParams): load(source)
