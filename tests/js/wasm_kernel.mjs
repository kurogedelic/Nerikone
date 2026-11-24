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
for (const [f, dir] of [['smlibpy_shim.py', 'nerikone/web-local'], ['kernel.py', 'nerikone'], ['vrml.py', 'nerikone'], ['meshio.py', 'nerikone'], ['constraints.py', 'nerikone'], ['expr.py', 'nerikone'], ['api.py', 'nerikone']])
  py.FS.writeFile(f, readFileSync(path.join(root, dir, f)));
await py.runPythonAsync('import smlibpy_shim, kernel as K, api, json, math');

const checks = {
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
  api: `code,_,data,_=api.handle('POST','/api/exec',{},json.dumps({'cmd':'body.sphere','params':{}}).encode())
assert code==200 and 'Sphere1' in json.loads(data)['scene']
code,_,data,_=api.handle('POST','/api/exec',{},b'{"cmd":"body.box","params":{"length":-1}}'); assert code==400`,
};
const out = {};
for (const [name, code] of Object.entries(checks)) {
  try { await py.runPythonAsync(code); out[name] = 'ok'; }
  catch (e) { out[name] = 'FAIL ' + String(e.message).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300); }
}
console.log(JSON.stringify(out));
