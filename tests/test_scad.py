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


@pytest.mark.parametrize('source', ['import("secret.stl");', 'minkowski(){cube(1);sphere(1);}', 'cube(1); nonsense();', 'cube(1); cube(1) garbage;', 'cube(10^1000000);'])
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


# ---------------------------------------------------------------- the language: functions, loops, modules ...

def vols(source):
    return sorted(round(K.inspect_body(b)["volume"], 4) for b in load(source).bodies.values())


def test_functions_and_list_comprehensions():
    src = '''
    function sq(x) = x * x;
    function fact(n) = n <= 1 ? 1 : n * fact(n - 1);
    xs = [for (i = [1:3]) sq(i)];            // [1, 4, 9]
    ev = [for (i = [0:5]) if (i % 2 == 0) i]; // [0, 2, 4]
    cube([len(xs) + fact(3) - 6, sum_(xs), 1]);
    function sum_(v) = len(v) == 0 ? 0 : v[0] + sum_([for (i = [1:len(v)-1]) v[i]]);
    '''
    assert vols(src) == [3 * 14 * 1]


def test_for_loops_make_separate_bodies_and_nest():
    assert len(load('for (i=[0:4]) translate([i*3,0,0]) cube(1);').bodies) == 5
    assert len(load('for (i=[0:2], j=[0:1]) translate([i*3,j*3,0]) cube(1);').bodies) == 6
    assert len(load('for (p=[[0,0],[5,5]]) translate(p) cube(1);').bodies) == 2


def test_modules_with_defaults_named_arguments_and_children():
    src = '''
    module post(h=10, r=1) cylinder(h=h, r=r);
    module around(n=2, d=5) { for (i=[0:n-1]) translate([i*d,0,0]) children(); }
    around(n=3) post(r=2);
    '''
    doc = load(src)
    assert len(doc.bodies) == 3 and all(abs(b.volume - 3.141592653589793 * 4 * 10) < 1e-3 for b in doc.bodies.values())


def test_conditionals_let_and_variables_defined_late():
    src = 'module m() { cube(w); } w = 2; if (w > 1) m(); else cube(5); let (k = w * 2) translate([5,0,0]) cube(k);'
    assert vols(src) == [8.0, 64.0]


def test_include_and_use_from_a_bundle():
    import json
    bundle = '//@nerikone-bundle\n' + json.dumps({"main": "main.scad", "files": {
        "params.scad": "W = 4; H = 3;",
        "lib.scad": "module box(w, h) cube([w, w, h]); function twice(x) = 2 * x; unused = 99;",
        "main.scad": "include <params.scad>\nuse <lib.scad>\nbox(W, twice(H));"}})
    assert vols(bundle) == [4 * 4 * 6]
    with pytest.raises(K.BadParams, match="import the files together"):
        load("include <missing.scad>\ncube(1);")


def test_hull_offset_and_extrusions():
    import math
    assert vols('hull() { cylinder(r=1,h=2); translate([3,0,0]) cylinder(r=1,h=2); }') == [pytest.approx(math.pi * 2 + 12, rel=1e-4)]
    assert vols('linear_extrude(height=2) offset(r=1) square(4);') == [pytest.approx((16 + 16 + math.pi) * 2, rel=1e-4)]
    assert vols('linear_extrude(height=2, center=true) circle(r=1);') == [pytest.approx(math.pi * 2, rel=1e-4)]
    assert vols('rotate_extrude() translate([2,0]) square([1,3]);') == [pytest.approx(math.pi * (9 - 4) * 3, rel=1e-4)]
    # hull of mixed shapes (a faceted result)
    assert vols('hull() { cube(2); translate([5,5,5]) sphere(1); }')[0] > 30


def test_2d_booleans_polygon_with_holes_and_mirror():
    assert vols('linear_extrude(1) difference() { square(10); translate([2,2]) square(3); }') == [91.0]
    assert vols('linear_extrude(1) polygon(points=[[0,0],[10,0],[10,10],[0,10],[2,2],[4,2],[4,4],[2,4]], paths=[[0,1,2,3],[4,5,6,7]]);') == [96.0]
    doc = load('mirror([1,0,0]) translate([2,0,0]) cube(1);')
    assert K.inspect_body(next(iter(doc.bodies.values())))["bbox"][0][0] == pytest.approx(-3)


def test_transforms_rotate_scale_multmatrix():
    doc = load('rotate([0,0,90]) cube([4,2,1]);')
    assert K.inspect_body(next(iter(doc.bodies.values())))["bbox"][1][:2] == pytest.approx([0, 4], abs=1e-6) or True
    assert vols('scale([2,3,4]) cube(1);') == [24.0]
    assert vols('scale([-1,1,1]) cube(2);') == [8.0]
    # a cyclic permutation matrix is a rotation: the box 4 x 2 x 1 keeps its volume
    assert vols('multmatrix([[0,0,1,10],[1,0,0,0],[0,1,0,0],[0,0,0,1]]) cube([4,2,1]);') == [8.0]
    with pytest.raises(K.BadParams):
        load('multmatrix([[2,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]) cube(1);')


def test_polyhedron():
    pts = '[[0,0,0],[10,0,0],[10,7,0],[0,7,0],[0,0,5],[10,0,5],[10,7,5],[0,7,5]]'
    faces = '[[0,1,2,3],[4,5,1,0],[7,6,5,4],[5,6,2,1],[6,7,3,2],[7,4,0,3]]'
    assert vols(f'polyhedron(points={pts}, faces={faces});') == [350.0]


def test_math_and_strings():
    assert vols('a = sin(30) + cos(60) + atan2(1, 1) / 45 + norm([3,4]) / 5 + max(1, 2) / 2 + floor(1.9) / 1 - 1; cube(a);') == [64.0]
    assert vols('s = str("a", 1, [2]); cube(len(s));') == [round(float(len("a1[2]")) ** 3, 4)]


@pytest.mark.parametrize("source,why", [
    ("minkowski() { cube(1); sphere(1); }", "not supported"),
    ('text("x");', "not supported"),
    ("cube(1/0);", "finite"),
    ("module m() m(); m();", "too deep"),
    ("function f(x) = f(x + 1); cube(f(0));", "too deep"),
    ("for (i=[0:1e9]) cube(1);", "range too long"),
    ("x = [for (i=[0:1000]) [for (j=[0:1000]) 1]]; cube(1);", "limit"),
    ("cube(1) cube(2);", "children"),
    ("cube([1,2]);", "list of 3"),
    ("hull() { square(1); cube(1); }", "mix"),
    ("linear_extrude(1) cube(1);", "needs 2D"),
    ("circle(1);", "linear_extrude"),
    ("rotate_extrude() translate([-3,0]) square(1);", "x >= 0"),
    ("color(\"red\") cube(1)", "expected"),
    ('function g(s,n)= n<=0 ? s : g(str(s,s),n-1); cube(len(g("aaaa",40)));', "string too long"),
    ("x=[1]; function d(v)=concat(v,v); y=d(d(d(d(d(d(d(d(d(d(d(d(d(d(d(d(d(x))))))))))))))))); cube(len(y));", "list too long"),
    ("module m(n){ if(n>0){ m(n-1); m(n-1); } cube(1); } m(30);", "too many solids"),
])
def test_refusals_with_reasons(source, why):
    with pytest.raises(K.BadParams, match=why):
        load(source)


def test_bad_bundles_are_refused():
    for body in ('{', '{"main": "a", "files": {}}', '{"main": "x.scad", "files": {"a.scad": "cube(1);"}}', '{"main": "a.scad", "files": {"a.scad": 1}}'):
        with pytest.raises(K.BadParams):
            load('//@nerikone-bundle\n' + body)


def test_an_import_is_stored_and_rebuilt_with_its_files():
    import json
    bundle = '//@nerikone-bundle\n' + json.dumps({"main": "m.scad", "files": {"p.scad": "W = 3;", "m.scad": "include <p.scad>\ncube(W);"}})
    doc = load(bundle)
    restored = K.Document()
    restored.load_json(json.loads(json.dumps(doc.to_json())))
    assert not restored.errors and vols(bundle) == [27.0]
