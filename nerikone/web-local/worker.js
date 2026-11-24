// The kernel in the browser: Pyodide (Python) runs kernel.py on smlibwasm (SMLib compiled to WebAssembly).
// The page talks to it with {id, method, path, query, body}; api.py answers like the HTTP server does.
import {loadPyodide} from './vendor/pyodide/pyodide.mjs';
import * as sm from './vendor/smlibwasm/dist/index.js';

let py = null;
const ready = (async () => {
  postMessage({progress: 'Python を読み込み中…'});
  py = await loadPyodide({indexURL: new URL('./vendor/pyodide/', import.meta.url).href});
  postMessage({progress: 'numpy を読み込み中…'});
  await py.loadPackage('numpy');
  py.registerJsModule('smjs', sm);
  postMessage({progress: 'カーネルを準備中…'});
  for (const f of ['smlibpy_shim.py', 'vrml.py', 'kernel.py', 'api.py']) {
    const r = await fetch(new URL('./py/' + f, import.meta.url)); py.FS.writeFile(f, new Uint8Array(await r.arrayBuffer()));
  }
  await py.runPythonAsync('import smlibpy_shim\nimport api');
  postMessage({ready: true});
})().catch(e => postMessage({fatal: String(e && e.message || e)}));

onmessage = async ev => {
  const {id, method, path, query, body} = ev.data;
  try {
    await ready;
    py.globals.set('_req', py.toPy({method, path, query: query || {}, body: body ? new Uint8Array(body) : new Uint8Array(0)}));
    const out = py.runPython(`
_r = _req.to_py() if hasattr(_req, 'to_py') else _req
_s, _t, _d, _h = api.handle(_r['method'], _r['path'], _r['query'], bytes(_r['body']))
(_s, _t, bytes(_d), _h)`).toJs({dict_converter: Object.fromEntries});
    const [status, ctype, data, headers] = out;
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    postMessage({id, status, ctype, headers, data: buf}, [buf]);
  } catch (e) {
    postMessage({id, status: 500, ctype: 'application/json', headers: {}, data: new TextEncoder().encode(JSON.stringify({error: String(e && e.message || e).slice(0, 600)})).buffer});
  }
};
