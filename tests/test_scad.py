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
    assert sorted(round(K.inspect_body(b)["volume"], 4) for b in doc.bodies.values()) == sorted([30, round(4/3*3.141592653589793*8,4), round(3.141592653589793*4,4)])
    restored = K.Document()
    restored.load_json(doc.to_json())
    assert len(restored.bodies) == 3


def test_boolean():
    doc = load('difference() { cube([4,4,4],center=true); cube([2,2,2],center=true); }')
    assert len(doc.bodies) == 1
    assert K.inspect_body(next(iter(doc.bodies.values())))["volume"] == pytest.approx(56)


@pytest.mark.parametrize('source', ['import("secret.stl");', 'for(i=[1:100]) cube(1);', 'cube(1); nonsense();', 'cube(1); cube(1) garbage;', 'cube(10^1000000);'])
def test_reject_unsupported(source):
    with pytest.raises(K.BadParams): load(source)


def test_module_2d_extrusion_with_rounded_cutout():
    source = '''
    w=30; h=10; r=2; slot=0.2;
    module plate(x,y,rad) {
      hull() {
        translate([rad,rad]) circle(r=rad);
        translate([x-rad,rad]) circle(r=rad);
        translate([rad,y-rad]) circle(r=rad);
        translate([x-rad,y-rad]) circle(r=rad);
      }
    }
    module cutout(rad) {
      points=[[-2,-1],[2,-1],[3,1],[-1,1]];
      if (rad>0) offset(r=rad) offset(delta=-rad) polygon(points);
      else polygon(points);
    }
    linear_extrude(height=1,convexity=10)
    difference() { plate(w,h,r); translate([10,5]) cutout(slot); }
    '''
    doc=load(source)
    assert len(doc.bodies)==1
    info=K.inspect_body(next(iter(doc.bodies.values())))
    assert info['bbox'][0] == pytest.approx([0,0,0],abs=1e-6)
    assert info['bbox'][1] == pytest.approx([30,10,1],abs=1e-6)
    assert 285 < info['volume'] < 300


@pytest.mark.parametrize('source', [
    'cube(' + '[' * 3000 + '1' + ']' * 3000 + ');',  # nesting deep enough to exhaust the recursion limit
    'cube(' + '(' * 3000 + '1' + ')' * 3000 + ');',
    'translate([1,0,0])' * 500 + 'cube(1);',
    'include </etc/passwd>; cube(1);', 'surface(file="/etc/passwd");', 'cube(9**9**9);', 'cube(1/0);', 'cube(1);\x00',
])
def test_hostile_input_is_a_refusal_not_a_crash(source):
    with pytest.raises(K.BadParams): load(source)
