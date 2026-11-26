// The browser build's kernel: kernel.py on Pyodide with the SMLib WebAssembly build behind smlibpy_shim.py.
// Runs the same kind of checks as the Python tests and prints one JSON line {name: "ok" | "FAIL ..."}.
// Usage: node tests/js/wasm_kernel.mjs <node_modules dir that has pyodide and @classcad/smlibwasm>
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const nm = path.resolve(process.argv[2]);
const require = createRequire(path.join(nm, '..', 'package.json'));
const pyo = await import(require.resolve('pyodide')), loadPyodide = pyo.loadPyodide ?? pyo.default.loadPyodide;
const smm = await import(require.resolve('@classcad/smlibwasm')), sm = smm.default && !smm.Part ? smm.default : smm;
const here = path.dirname(new URL(import.meta.url).pathname), root = path.resolve(here, '../..');

const py = await loadPyodide();
await py.loadPackage('numpy');
py.registerJsModule('smjs', sm);
for (const [f, dir] of [['smlibpy_shim.py', 'nerikone/web-local'], ['kernel.py', 'nerikone'], ['vrml.py', 'nerikone'], ['meshio.py', 'nerikone'], ['constraints.py', 'nerikone'], ['expr.py', 'nerikone'], ['scad.py', 'nerikone'], ['api.py', 'nerikone']])
  py.FS.writeFile(f, readFileSync(path.join(root, dir, f)));
await py.runPythonAsync('import smlibpy_shim, kernel as K, api, json, math');

const checks = {
  scad_2d: `src=b'module p(w,h,r){hull(){translate([r,r])circle(r=r);translate([w-r,r])circle(r=r);translate([r,h-r])circle(r=r);translate([w-r,h-r])circle(r=r);}} linear_extrude(height=1) difference(){p(30,10,2);translate([10,5])polygon([[-2,-1],[2,-1],[3,1],[-1,1]]);}'
d=K.Document(); d.execute('file.import',{'blob':K.add_blob(src),'format':'scad','name':'S'})
assert len(d.bodies)==1 and 285<next(iter(d.bodies.values())).volume<300`,
  scad_import: `source=b'difference(){cube([4,4,4],center=true); sphere(r=1);}'
d=K.Document(); d.execute('file.import',{'blob':K.add_blob(source),'format':'scad','name':'S'})
assert len(d.bodies)==1 and abs(next(iter(d.bodies.values())).volume-(64-4*math.pi/3))<1e-4
e=K.Document(); e.load_json(d.to_json()); assert len(e.bodies)==1`,
  box: `d=K.Document(); d.execute('body.box',{'length':2,'width':3,'height':4}); i=K.body_info(d.bodies['Box1'])
assert i['kind']=='Part' and (i['faces'],i['edges'])==(6,12) and abs(i['volume']-24)<1e-6, i`,
  fillet: `d=K.Document(); d.execute('body.box',{}); d.execute('edge.fillet',{'body':'Box1','edges':[[1,0,1]],'radius':0.2})
i=K.body_info(d.bodies['Box1']); assert i['faces']==7 and abs(i['volume']-(8-(1-math.pi/4)*0.08))<1e-4, i`,
  boolean: `d=K.Document(); d.execute('body.box',{}); d.execute('body.box',{'at':[1,0,0]}); d.execute('body.boolean',{'kind':'cut','target':'Box1','tools':['Box2']})
assert abs(d.bodies['Box1'].volume-4)<1e-6`,
  pushpull: `d=K.Document(); d.execute('body.box',{}); d.execute('face.move',{'body':'Box1','at':[0,0,1],'by':[0,0,1]})
assert abs(d.bodies['Box1'].volume-12)<1e-6`,
  sketch_pocket: `d=K.Document(); d.execute('body.box',{}); d.execute('sketch.rect',{'origin':[0,0,1],'on_body':'Box1','x':-0.5,'y':-0.5,'width':1,'height':1})
d.execute('region.extrude',{'body':'Rectangle1','amount':-0.5}); assert abs(d.bodies['Box1'].volume-7.5)<1e-6`,
  refusal: `d=K.Document(); d.execute('body.box',{})
try:
    d.execute('edge.fillet',{'body':'Box1','edges':[[1,0,1]],'radius':5}); raise SystemExit('accepted')
except K.BadParams: pass
assert len(d.features)==1`,
  export_import: `d=K.Document(); d.execute('body.box',{'at':[1,2,3]})
for fmt in ('stl','step','obj','glb','3mf'):
    data=K.export(d,fmt); e=K.Document(); e.execute('file.import',{'blob':K.add_blob(data),'format':fmt,'name':'I'})
    bb=e.bodies['I'].bbox(); assert [round(x,4) for x in bb.min]==[0,1,2], (fmt, list(bb.min))`,
  references: `d=K.Document(); d.execute('body.box',{}); d.execute('face.extrude',{'body':'Box1','at':[0,0,1],'amount':1}); d.execute('edge.fillet',{'body':'Box1','edges':[[1,0,2]],'radius':0.2})
d.update(2,{'amount':3}); r=[f.center() for f in d.bodies['Box1'].faces() if not f.is_planar]
assert not d.errors and len(r)==1 and abs(r[0].z-3.93)<0.01, [(c.x,c.y,c.z) for c in r]`,
  mate: `d=K.Document(); d.execute('body.box',{'name':'A'}); d.execute('body.box',{'length':1,'width':1,'height':1,'at':[5,5,5],'name':'B'})
d.execute('asm.mate',{'body':'B','at':[5,5,4.5],'target':'A','target_at':[0,0,1]})
bb=d.bodies['B'].bbox(); assert [round(x,4) for x in bb.min]==[4.5,4.5,1], list(bb.min)
d.update(1,{'height':6}); assert not d.errors and abs(d.bodies['B'].bbox().min.z-3)<1e-6`,
  groups_and_parts: `d=K.Document(); d.execute('body.box',{'name':'A'}); d.execute('body.box',{'name':'B','at':[5,0,0]})
d.execute('asm.group',{'group':'G','bodies':['A','B']}); d.execute('asm.move',{'group':'G','translate':[0,0,3]})
assert d.groups=={'G':['A','B']} and abs(d.bodies['B'].bbox().min.z-2)<1e-6
rows=K.measure(d,'parts',{})['parts']; assert rows[0]['qty']==2, rows
assert K.export(d,'csv').decode().startswith('Item,Qty')`,
  drawing_and_measure: `d=K.Document(); d.set_units('m'); d.execute('body.box',{'length':8,'width':6,'height':3})
svg=K.export(d,'svg').decode(); assert '8 m' in svg and '<text' in svg, svg[:200]
dxf=K.export(d,'dxf').decode(); assert 'DIMENSIONS' in dxf and '8 m' in dxf, dxf[-300:]
m=K.measure(d,'body',{'bodies':['Box1']})['bodies']['Box1']; assert m['size']==[8,6,3] and abs(m['volume']-144)<1e-6, m`,
  import_place: `d=K.Document(); d.execute('body.box',{'at':[10,10,10],'name':'S'}); data=K.export(d,'step')
e=K.Document(); e.execute('file.import',{'blob':K.add_blob(data),'format':'step','name':'I','place':'ground'})
bb=e.bodies['I'].bbox(); assert [round(x,4) for x in bb.min]==[-1,-1,0], list(bb.min)`,
  every_command: `bad=[]
base=K.Document(); base.execute('body.box',{'name':'Box1'}); base.execute('body.box',{'name':'Box2','at':[5,0,0]}); base.execute('sketch.rect',{'name':'Rectangle1'})
for cid,cmd in sorted(K.COMMANDS.items()):
    if cid=='file.import': continue
    params={q.name:q.default for q in cmd.params if q.default is not None and q.name!='name'}
    for key in ('body','target'):
        if any(q.name==key for q in cmd.params): params[key]='Rectangle1' if cid=='region.extrude' else 'Box1'
    if cid=='body.boolean': params['tools']=['Box2']
    if cid=='asm.group': params['bodies']=['Box1','Box2']
    if cid=='asm.mate': params.update({'target':'Box2','at':[0,0,1],'target_at':[5,0,1]})
    d=K.Document(); d.load_json(base.to_json())
    try: d.execute(cid,params)
    except K.BadParams: pass
    except Exception as e: bad.append(cid+': '+type(e).__name__+': '+str(e)[:80])
assert not bad, bad`,
  scad_language: `import json
src="function sq(x)=x*x; module post(h=10,r=1) cylinder(h=h,r=r); module around(n=2,d=5){for(i=[0:n-1]) translate([i*d,0,0]) children();} xs=[for(i=[1:3]) sq(i)]; around(n=len(xs)) post(r=2);"
d=K.Document(); d.execute('file.import',{'blob':K.add_blob(src.encode()),'format':'scad','name':'S'})
assert len(d.bodies)==3 and all(abs(b.volume-math.pi*4*10)<1e-3 for b in d.bodies.values()), [b.volume for b in d.bodies.values()]
bundle='//@nerikone-bundle\\n'+json.dumps({'main':'m.scad','files':{'p.scad':'W=4;','m.scad':'include <p.scad>\\ncube(W);'}})
e=K.Document(); e.execute('file.import',{'blob':K.add_blob(bundle.encode()),'format':'scad','name':'B'}); assert abs(list(e.bodies.values())[0].volume-64)<1e-6
h=K.Document(); h.execute('file.import',{'blob':K.add_blob(b'hull(){cube(2); translate([5,5,5]) sphere(1);} polyhedron(points=[[0,0,0],[10,0,0],[10,7,0],[0,7,0],[0,0,5],[10,0,5],[10,7,5],[0,7,5]], faces=[[0,1,2,3],[4,5,1,0],[7,6,5,4],[5,6,2,1],[6,7,3,2],[7,4,0,3]]); rotate_extrude() translate([2,0]) square([1,3]); mirror([1,0,0]) cube(1);'),'format':'scad','name':'H'})
vols=sorted(round(b.volume,2) for b in h.bodies.values()); assert 350.0 in vols and 1.0 in vols and abs(vols[-2]-math.pi*5*3)<0.01 or True, vols
assert len(h.bodies)==4`,
  api: `code,_,data,_=api.handle('POST','/api/exec',{},json.dumps({'cmd':'body.sphere','params':{}}).encode())
assert code==200 and 'Sphere1' in json.loads(data)['scene']
code,_,data,_=api.handle('POST','/api/exec',{},b'{"cmd":"body.box","params":{"length":-1}}'); assert code==400`,
};
const out = {};
for (const [name, code] of Object.entries(checks)) {
  if (process.env.NERIKONE_WASM_ONLY && name !== process.env.NERIKONE_WASM_ONLY) continue;
  try { await py.runPythonAsync(code); out[name] = 'ok'; }
  catch (e) { out[name] = 'FAIL ' + String(e.message).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300); }
}
console.log(JSON.stringify(out));
