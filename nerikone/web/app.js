// Nerikone viewer: direct modeling on top of the command API (../kernel.py).
// Interaction: G R S modal transforms with X Y Z constraints and typed values,
// numpad views, F3 search; all shortcuts are remappable (keymap.js).
import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {icon, cmdIcon} from './icons.js';
import * as KM from './keymap.js';

const $ = id => document.getElementById(id);
const V = a => new T.Vector3(a[0], a[1], a[2]);
const arr = v => [+v.x.toFixed(5), +v.y.toFixed(5), +v.z.toFixed(5)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const AX = {X: new T.Vector3(1, 0, 0), Y: new T.Vector3(0, 1, 0), Z: new T.Vector3(0, 0, 1)};
const AXCOL = {X: 'var(--x)', Y: 'var(--y)', Z: 'var(--z)'};

// ------------------------------------------------------------------ API
async function req(method, url, body, raw) {
  const r = await fetch(url, {method, body: raw ? body : body && JSON.stringify(body)});
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}
const get = url => req('GET', url), post = (url, body) => req('POST', url, body ?? {});
let toastT;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block'; t.style.color = err ? 'var(--err)' : '';
  t.title = err ? 'クリックでコンソールを開く' : '';
  clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', err ? 5000 : 1600);
}
$('toast').onclick = () => { $('toast').style.display = 'none'; openConsole(true); };

// ------------------------------------------------------------------ console: an accumulating log of operations and errors
const LOG = [];
function log(kind, text, detail) {
  const last = LOG.at(-1);
  if (last && last.kind === kind && last.text === text && last.detail === detail) { last.count++; last.time = new Date(); }
  else { LOG.push({kind, text, detail, time: new Date(), count: 1}); if (LOG.length > 500) LOG.shift(); }
  if (kind === 'err') S.unseenErr = (S.unseenErr || 0) + 1;
  renderConsole();
}
function reportError(raw, ctx) {
  const short = friendly(raw);
  log('err', ctx ? `${ctx}: ${short}` : short, raw !== short ? raw : undefined);
  toast(short, true);
}
const fmtTime = d => d.toTimeString().slice(0, 8);
function renderConsole() {
  const b = $('consolebtn');
  if (b) { b.classList.toggle('alert', !!S.unseenErr); b.querySelector('.badge').textContent = S.unseenErr || ''; }
  const el = $('console'); if (el.hidden) return;
  const onlyErr = S.consoleFilter === 'err';
  const rows = LOG.filter(e => !onlyErr || e.kind === 'err');
  $('clog').innerHTML = rows.map((e, i) => `<div class="cl ${e.kind}"><span class="ct">${fmtTime(e.time)}</span>${icon(e.kind === 'err' ? 'alert-circle' : e.kind === 'ok' ? 'circle-check' : 'info')}
    <div class="cm"><div>${esc(e.text)}${e.count > 1 ? ` <span class="dim">×${e.count}</span>` : ''}</div>${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}</div>
    <button data-copy="${LOG.indexOf(e)}" data-tip="コピー">${icon('copy')}</button></div>`).join('') || '<div class="dim" style="padding:8px">ログはまだありません</div>';
  $('clog').scrollTop = $('clog').scrollHeight;
  $('cfilter').classList.toggle('on', onlyErr);
}
const entryText = e => `[${fmtTime(e.time)}] ${e.kind.toUpperCase()} ${e.text}${e.count > 1 ? ` (x${e.count})` : ''}${e.detail ? '\n' + e.detail : ''}`;
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('コピーしました'); } catch { prompt('コピーしてください', t); } }
function openConsole(show) {
  const el = $('console'); el.hidden = show === undefined ? !el.hidden : !show;
  if (!el.hidden) S.unseenErr = 0;
  renderConsole(); resize();
}

// ------------------------------------------------------------------ three.js
const view = $('view');
const R = new T.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
R.setPixelRatio(devicePixelRatio); R.shadowMap.enabled = true; R.shadowMap.type = T.PCFSoftShadowMap;
view.prepend(R.domElement);
const canvas = R.domElement;
const scene = new T.Scene();
const persp = new T.PerspectiveCamera(40, 1, 0.01, 2000);
const ortho = new T.OrthographicCamera(-1, 1, 1, -1, -1000, 2000);
persp.up.set(0, 0, 1); ortho.up.set(0, 0, 1); persp.position.set(6, -8, 5);
let cam = persp;
const orbit = new OrbitControls(cam, canvas);
orbit.enableDamping = true; orbit.dampingFactor = 0.2;
orbit.mouseButtons = {LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.ROTATE, RIGHT: T.MOUSE.PAN}; // Shift+drag pans
const hemi = new T.HemisphereLight(0xffffff, 0x404050, 1.3); scene.add(hemi);
const sun = new T.DirectionalLight(0xffffff, 1.4); sun.position.set(5, -4, 10); scene.add(sun, sun.target);
sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005;
const grid = new T.GridHelper(40, 40, 0x50535a, 0x323438); grid.rotation.x = Math.PI / 2; scene.add(grid);
const axesLines = new T.Group(); scene.add(axesLines);
for (const [a, c] of [['X', 0xe5534b], ['Y', 0x6cc04a]]) {
  const g = new T.BufferGeometry().setFromPoints([AX[a].clone().multiplyScalar(-20), AX[a].clone().multiplyScalar(20)]);
  axesLines.add(new T.Line(g, new T.LineBasicMaterial({color: c, transparent: true, opacity: 0.6})));
}
const ground = new T.Mesh(new T.PlaneGeometry(400, 400), new T.ShadowMaterial({opacity: 0.25}));
ground.receiveShadow = true; ground.visible = false; scene.add(ground);
const envTex = new T.PMREMGenerator(R).fromScene(new RoomEnvironment(), 0.04).texture;
const root = new T.Group(); scene.add(root);
const handles = new T.Group(); scene.add(handles);
const axisGuide = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({color: 0xffffff, depthTest: false}));
axisGuide.visible = false; axisGuide.renderOrder = 12; scene.add(axisGuide);
// RGB axis triad shown at the pivot while moving / rotating / scaling (X red, Y green, Z blue)
const AXHEX = {X: 0xe5534b, Y: 0x6cc04a, Z: 0x4d8fe8};
const triad = new T.Group(); triad.visible = false; triad.renderOrder = 12; scene.add(triad);
for (const a of ['X', 'Y', 'Z']) {
  const l = new T.Line(new T.BufferGeometry().setFromPoints([AX[a].clone().multiplyScalar(-1), AX[a].clone()]),
    new T.LineBasicMaterial({color: AXHEX[a], depthTest: false, transparent: true}));
  l.renderOrder = 12; l.userData.axis = a; l.raycast = () => {}; triad.add(l);
}
const moveLine = new T.Line(new T.BufferGeometry(), new T.LineDashedMaterial({color: 0xffffff, dashSize: 0.1, gapSize: 0.07, depthTest: false}));
moveLine.visible = false; moveLine.renderOrder = 12; scene.add(moveLine);
function showTriad(p, active) {
  const d = (cam === ortho ? (ortho.userData.dist ?? 10) / ortho.zoom : cam.position.distanceTo(p));
  triad.position.copy(p); triad.scale.setScalar(d * 0.18); triad.visible = true;
  for (const l of triad.children) l.material.opacity = !active ? 0.9 : l.userData.axis === active ? 1 : 0.18;
}
function showMoveLine(a, b) {
  if (a.distanceTo(b) < 1e-6) { moveLine.visible = false; return; }
  const d = cam.position.distanceTo(a);
  moveLine.geometry.setFromPoints([a, b]); moveLine.computeLineDistances();
  moveLine.material.dashSize = d * 0.012; moveLine.material.gapSize = d * 0.008; moveLine.visible = true;
}
const gizmo = new T.ArrowHelper(new T.Vector3(0, 0, 1), new T.Vector3(), 1, 0xf5a623, 0.25, 0.15);
gizmo.visible = false; scene.add(gizmo);
for (const part of [gizmo.line, gizmo.cone]) { // always drawn on top of the model
  part.renderOrder = 20; part.material.depthTest = false; part.material.depthWrite = false; part.material.transparent = true;
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  R.setSize(w, h); persp.aspect = w / h; persp.updateProjectionMatrix(); fitOrtho();
}
new ResizeObserver(resize).observe(view);

// materials and shading
const faceMat = c => new T.MeshStandardMaterial({color: c, roughness: 0.5, metalness: 0.05, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1});
const M = {base: faceMat(0x9aa7bd), mesh: faceMat(0xb8a68a), hover: faceMat(0xffd27f), sel: faceMat(0xf5a623),
  edge: new T.LineBasicMaterial({color: 0x15171a}), edgeHover: new T.LineBasicMaterial({color: 0xffd27f}), edgeSel: new T.LineBasicMaterial({color: 0xf5a623})};
M.mesh.flatShading = true;
const RENDER_MATS = {
  clay: new T.MeshPhysicalMaterial({color: 0xd9d4cc, roughness: 0.85, side: T.DoubleSide}),
  plastic: new T.MeshPhysicalMaterial({color: 0xe0482f, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2, side: T.DoubleSide}),
  metal: new T.MeshPhysicalMaterial({color: 0xc8ccd2, roughness: 0.22, metalness: 1, side: T.DoubleSide}),
  glass: new T.MeshPhysicalMaterial({color: 0xffffff, roughness: 0.03, transmission: 1, thickness: 0.6, ior: 1.5, side: T.DoubleSide}),
};
const SHADING = ['solid', 'wire', 'xray'];
const colorMats = new Map(), renderMats = new Map();
function colorMat(c) { // model-view material in a body / face colour
  if (!colorMats.has(c)) { const m = M.base.clone(); m.color.set(c); colorMats.set(c, m); applyShading(); }
  return colorMats.get(c);
}
const FINISH = {
  plastic: {roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2}, metal: {roughness: 0.22, metalness: 1},
  glass: {roughness: 0.03, transmission: 1, thickness: 0.6, ior: 1.5}, rubber: {roughness: 0.95}, clay: {roughness: 0.85},
};
const FINISH_JA = {plastic: 'プラスチック', metal: '金属', glass: 'ガラス', rubber: 'ゴム', clay: 'クレイ'};
function renderMat(finish, color) {
  const k = finish + color;
  if (!renderMats.has(k)) renderMats.set(k, new T.MeshPhysicalMaterial({color, side: T.DoubleSide, ...FINISH[finish]}));
  return renderMats.get(k);
}
function applyShading() {
  const s = S.shading;
  for (const m of [M.base, M.mesh, M.hover, M.sel, ...colorMats.values()]) {
    m.transparent = s !== 'solid'; m.opacity = s === 'wire' ? 0.06 : s === 'xray' ? 0.35 : 1; m.depthWrite = s === 'solid';
    m.needsUpdate = true;
  }
  for (const m of [M.edge, M.edgeHover, M.edgeSel]) { m.depthTest = s === 'solid'; m.needsUpdate = true; }
  M.edge.color.set(s === 'solid' ? 0x15171a : 0xb9c0cc);
}

// ------------------------------------------------------------------ state
const S = {
  cmds: {}, doc: {features: [], bodies: {}}, version: -1,
  mode: 'face', shading: 'solid', render: false, material: 'auto', renderBg: (() => { try { return localStorage.getItem('nerikone.renderBg') || 'dark'; } catch { return 'dark'; } })(),
  sel: {faces: [], edges: [], bodies: []},   // faces: {body, fi, point, normal}; edges: {body, ei, mid}
  hidden: new Set(), hover: null, feature: null, form: null,
  drag: null, modal: null, dialogOpen: (() => { try { return !!localStorage.getItem('nerikone.dialogOpen'); } catch { return false; } })(), groups: {}, faces: [], edges: [], framed: false, lastCmd: null,
};

function buildScene(sc) {
  root.clear(); S.groups = {}; S.faces = []; S.edges = [];
  for (const [name, b] of Object.entries(sc)) {
    const g = new T.Group(); g.userData.name = name; g.visible = !S.hidden.has(name); S.groups[name] = g; root.add(g);
    b.faces.forEach((f, fi) => {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(f.verts, 3));
      geo.setIndex(f.tris); geo.computeVertexNormals();
      const m = new T.Mesh(geo, M.base); m.castShadow = true;
      const info = S.doc.bodies[name] || {};
      m.userData = {body: name, fi, planar: f.planar, normal: f.normal, mesh: b.kind === 'Mesh',
        color: f.color || info.color || info.mat_color || null, finish: info.finish || null};
      S.faces.push(m); g.add(m);
    });
    b.edges.forEach((e, ei) => {
      const l = new T.Line(new T.BufferGeometry().setFromPoints(e.pts.map(V)), M.edge);
      l.userData = {body: name, ei, mid: e.mid}; S.edges.push(l); g.add(l);
    });
  }
  refresh();
}
const visibleFaces = () => S.faces.filter(m => !S.hidden.has(m.userData.body));
const visibleEdges = () => S.edges.filter(m => !S.hidden.has(m.userData.body));

function boxOf(names) {
  const box = new T.Box3();
  for (const n of names) if (S.groups[n] && !S.hidden.has(n)) box.expandByObject(S.groups[n]);
  return box;
}
function frame(names) {
  const box = names?.length ? boxOf(names) : boxOf(Object.keys(S.groups));
  if (box.isEmpty()) return;
  const c = box.getCenter(new T.Vector3()), r = Math.max(box.getSize(new T.Vector3()).length(), 1);
  const dir = cam.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(c); cam.position.copy(c).addScaledVector(dir, r * 1.6);
  if (cam === ortho) { ortho.userData.dist = r * 1.6; ortho.zoom = 1; }
  ground.position.z = boxOf(Object.keys(S.groups)).min.z - 1e-3;
  fitOrtho(); orbit.update();
}

async function load() { applyState(await get('/api/state')); }
function applyState(d) {
  S.doc = d.doc; S.version = d.version;
  buildScene(d.scene);
  if (!S.framed && S.faces.length) {
    cam.position.copy(new T.Vector3(0.75, -1, 0.65)); frame(); S.framed = true;
  }
  const names = Object.keys(S.doc.bodies);
  S.sel.faces = S.sel.faces.filter(f => names.includes(f.body));
  S.sel.edges = S.sel.edges.filter(e => names.includes(e.body));
  S.sel.bodies = S.sel.bodies.filter(b => names.includes(b));
  for (const h of [...S.hidden]) if (!names.includes(h)) S.hidden.delete(h);
  if (S.feature && !S.doc.features.some(f => f.id === S.feature)) S.feature = null;
  renderPanels();
}

// ------------------------------------------------------------------ cameras and views
function fitOrtho() {
  const w = view.clientWidth || 1, h = view.clientHeight || 1;
  const d = cam === ortho ? ortho.userData.dist ?? 10 : cam.position.distanceTo(orbit.target);
  const hh = d * Math.tan(T.MathUtils.degToRad(persp.fov / 2));
  ortho.left = -hh * w / h; ortho.right = hh * w / h; ortho.top = hh; ortho.bottom = -hh; ortho.updateProjectionMatrix();
}
function setCamera(c) {
  if (c === cam) return;
  const d = cam.position.distanceTo(orbit.target);
  c.position.copy(cam.position); c.quaternion.copy(cam.quaternion);
  if (c === ortho) { ortho.userData.dist = d; ortho.zoom = 1; fitOrtho(); }
  else { const dir = cam.position.clone().sub(orbit.target).normalize(); persp.position.copy(orbit.target).addScaledVector(dir, (ortho.userData.dist ?? d) / ortho.zoom); }
  cam = c; orbit.object = c; orbit.update(); renderTop();
}
const VIEWS = {
  front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0], top: [0, -1e-4, 1], bottom: [0, -1e-4, -1],
  iso: [0.75, -1, 0.65],
};
const VIEW_NAMES = {front: '正面', back: '背面', right: '右側面', left: '左側面', top: '上面', bottom: '下面', iso: 'アイソメ'};
function setView(name) {
  const d = cam === ortho ? (ortho.userData.dist ?? 10) : cam.position.distanceTo(orbit.target);
  cam.position.copy(orbit.target).addScaledVector(V(VIEWS[name]).normalize(), d);
  if (name !== 'iso' && cam === persp) { setCamera(ortho); S.autoPersp = true; }
  orbit.update(); S.orbitStart = null;
}
orbit.addEventListener('start', () => { // leaving an axis view by orbiting returns to perspective
  S.orbitStart = cam.quaternion.clone();
});
orbit.addEventListener('change', () => {
  if (S.autoPersp && S.orbitStart && cam.quaternion.angleTo(S.orbitStart) > 0.02 && cam === ortho) {
    S.autoPersp = false; setCamera(persp);
  }
});
function currentViewName() {
  const dir = cam.position.clone().sub(orbit.target).normalize();
  for (const [k, v] of Object.entries(VIEWS)) if (k !== 'iso' && dir.dot(V(v).normalize()) > 0.9995) return VIEW_NAMES[k];
  return 'ユーザー';
}
function updateViewLabel() {
  const dir = cam.position.clone().sub(orbit.target);
  const dist = cam === ortho ? (ortho.userData.dist ?? 10) / ortho.zoom : dir.length();
  const az = (T.MathUtils.radToDeg(Math.atan2(dir.x, -dir.y)) + 360) % 360;
  const el = T.MathUtils.radToDeg(Math.asin(dir.clone().normalize().z));
  const txt = `<b>${currentViewName()}</b> · ${cam === ortho ? '平行投影' : '透視投影'}<br>方位 ${az.toFixed(0)}° · 仰角 ${el.toFixed(0)}° · 距離 ${dist.toFixed(1)}`;
  if (txt !== S.lastLabel) { $('viewlabel').innerHTML = txt; S.lastLabel = txt; }
}

// navigation gizmo: world axes as seen by the camera; click a bubble to look along that axis
const NAV = [['X', 1, 'right'], ['Y', 1, 'back'], ['Z', 1, 'top'], ['X', -1, 'left'], ['Y', -1, 'front'], ['Z', -1, 'bottom']];
function drawNavGizmo() {
  const key = cam.quaternion.toArray().map(x => x.toFixed(4)).join();
  if (key === S.navKey) return; // redraw only when the view turns (keeps the bubbles clickable)
  S.navKey = key;
  const q = cam.quaternion.clone().invert();
  const items = NAV.map(([a, s, v]) => {
    const p = AX[a].clone().multiplyScalar(s).applyQuaternion(q);
    return {a, s, v, x: p.x * 34, y: -p.y * 34, z: p.z};
  }).sort((m, n) => m.z - n.z);
  $('navgizmo').innerHTML = '<circle class="bg" r="48"/>' + items.map(({a, s, v, x, y}) =>
    (s > 0 ? `<line x1="0" y1="0" x2="${x}" y2="${y}" stroke="${AXCOL[a]}" stroke-width="2"/>` : '') +
    `<g data-view="${v}" style="pointer-events:all;cursor:pointer"><title>${VIEW_NAMES[v]}</title><circle cx="${x}" cy="${y}" r="${s > 0 ? 8 : 6.5}" fill="${s > 0 ? AXCOL[a] : '#0000'}" stroke="${AXCOL[a]}" stroke-width="1.5" opacity="${s > 0 ? 1 : 0.8}"/>` +
    (s > 0 ? `<text x="${x}" y="${y}">${a}</text>` : '') + '</g>').join('');
}
$('navgizmo').addEventListener('pointerdown', e => { const g = e.target.closest('[data-view]'); if (g) setView(g.dataset.view); });

// ------------------------------------------------------------------ highlight
function isSelFace(u) {
  return S.sel.faces.some(f => f.body === u.body && f.fi === u.fi) || S.sel.bodies.includes(u.body);
}
function refresh() {
  const h = S.hover;
  for (const m of S.faces) {
    const u = m.userData;
    if (S.render) { // each body's own finish and colour, unless a global override is chosen
      m.material = S.material !== 'auto' ? RENDER_MATS[S.material] : renderMat(u.finish || 'clay', u.color || (u.finish ? '#9aa7bd' : '#d9d4cc'));
      continue;
    }
    const hov = h && ((h.kind === 'face' && h.body === u.body && h.fi === u.fi) || (h.kind === 'body' && h.body === u.body));
    m.material = isSelFace(u) ? M.sel : hov ? M.hover : u.color ? colorMat(u.color) : u.mesh ? M.mesh : M.base;
  }
  for (const l of S.edges) {
    const u = l.userData;
    l.visible = !S.render;
    const sel = S.sel.edges.some(e => e.body === u.body && e.ei === u.ei);
    l.material = sel ? M.edgeSel : h && h.kind === 'edge' && h.body === u.body && h.ei === u.ei ? M.edgeHover : M.edge;
  }
  const f = S.sel.faces.at(-1);
  gizmo.visible = !S.render && !!f && !S.drag && !S.modal;
  if (gizmo.visible) {
    const d = cam.position.distanceTo(V(f.point)) / (cam === ortho ? ortho.zoom : 1);
    gizmo.position.copy(V(f.point)); gizmo.setDirection(V(f.normal)); gizmo.setLength(d * 0.12, d * 0.025, d * 0.015);
  }
  renderCtx(); renderStatus();
}

// ------------------------------------------------------------------ picking
const ray = new T.Raycaster(), mouse = new T.Vector2();
function setRay(e) {
  const r = canvas.getBoundingClientRect();
  mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  scene.updateMatrixWorld();
  ray.setFromCamera(mouse, cam);
  const d = cam === ortho ? (ortho.userData.dist ?? 10) / ortho.zoom : cam.position.distanceTo(orbit.target);
  ray.params.Line.threshold = d * 0.012;
}
function pick() {
  if (S.mode === 'edge') {
    const h = ray.intersectObjects(visibleEdges())[0];
    return h && {kind: 'edge', body: h.object.userData.body, ei: h.object.userData.ei, mid: h.object.userData.mid, point: h.point};
  }
  const h = ray.intersectObjects(visibleFaces())[0];
  if (!h) return null;
  const u = h.object.userData;
  if (S.mode === 'body') return {kind: 'body', body: u.body, point: h.point};
  const n = u.planar && u.normal ? V(u.normal) : h.face.normal.clone();
  return {kind: 'face', body: u.body, fi: u.fi, point: arr(h.point), normal: arr(n), mesh: u.mesh};
}
const pickHandle = () => ray.intersectObjects(handles.children)[0]?.object;
function screenOf(p) {
  const v = p.clone().project(cam), r = canvas.getBoundingClientRect();
  return {x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height};
}
function closestOnAxis(p0, dir) { // parameter t of the point on line p0 + t*dir nearest the mouse ray
  const n = dir.clone().normalize(), u = ray.ray.direction, w = p0.clone().sub(ray.ray.origin);
  const b = n.dot(u), den = 1 - b * b;
  return den < 1e-5 ? null : (b * u.dot(w) - n.dot(w)) / den;
}

// ------------------------------------------------------------------ preview pipeline (latest input wins)
let busy = false, queued = null, lastPreview = null;
function preview(url, body) {
  queued = {url, body};
  if (busy) return;
  busy = true;
  (async () => {
    while (queued) {
      const q = queued; queued = null;
      const md = S.modal, v = md?.value;
      try {
        const d = await post(q.url, {...q.body, preview: true}); buildScene(d.scene); lastPreview = null;
        if (md) md.good = {body: q.body, v};
      } catch (e) { lastPreview = e.message; }
      if (md && md === S.modal) renderModalHud();
    }
    busy = false;
  })();
}

// Kernel messages are precise but long; show a short Japanese hint first (the full text stays in the console).
const HINTS = [
  [/chamfer: .*angle that changes along it/, 'この辺は面の角度が場所によって変わるため、面取りできません。フィレットを使ってください（エッジを右へドラッグ、または Ctrl+B）'],
  [/radius (is|may be) too large|rounds .* would overlap|setback|too large for/, '大きすぎます。値を小さくしてください'],
  [/thicken|offset this sheet|curvature too tight/, '曲がりがきつく、この厚みは付けられません。厚みを小さくしてください'],
  [/shell: .*(empty|thicker)/, '壁が厚すぎます。厚みを小さくしてください'],
  [/meets the moved .* tangentially/, '接している面も一緒に動かす必要があります'],
  [/could not build the round|failed inside the (chamfer|fillet)|NULL_POINTER/, 'この形ではカーネルが丸め・面取りを作れませんでした（細すぎる・つぶれかけた辺など）。値を変えるか、別のエッジで試してください'],
  [/no body named/, '対象のボディが見つかりません'],
  [/move_faces: .*(cannot|could not)/, 'この量では面を動かせません（周りの面と交差します）'],
];
function friendly(msg) {
  const h = HINTS.find(([re]) => re.test(msg));
  if (h) { console.info('[kernel]', msg); return h[1]; }
  return msg.replace(/^(ModelingError|KernelError|ValueError|BadParams): /, '');
}
const idle = async () => { while (busy) await new Promise(r => setTimeout(r, 15)); };

async function commit(cmd, params, {keepSel} = {}) {
  try {
    const d = await post('/api/exec', {cmd, params});
    S.feature = d.feature.id; S.form = null; S.lastCmd = cmd;
    if (!keepSel) S.sel = {faces: [], edges: [], bodies: []};
    applyState(d);
    toast(`${S.cmds[cmd]?.label || cmd} ✓`);
    log('ok', `${S.cmds[cmd]?.label || cmd}  ${summarize(params)}`);
    return d;
  } catch (e) { reportError(e.message, S.cmds[cmd]?.label || cmd); await load(); }
}
async function updateFeature(id, params, extra = {}) {
  try { applyState(await post('/api/feature', {id, params, ...extra})); }
  catch (e) { reportError(e.message, 'パラメータ変更'); await load(); }
}
function clearSel() { S.sel = {faces: [], edges: [], bodies: []}; refresh(); renderPanels(); }

// ------------------------------------------------------------------ modal operations (G R S E Ctrl+B ...)
// A modal follows the mouse, accepts typed numbers (and X/Y/Z for transforms), confirms with LMB/Enter and
// cancels with RMB/Esc. Direct drags on geometry use the same machinery and confirm on release.
function startModal(m) {
  S.modal = {typed: '', axis: null, ...m, x0: S.mouse?.x ?? 0, y0: S.mouse?.y ?? 0};
  orbit.enabled = false; gizmo.visible = false;
  m.init?.(S.modal);
  updateModal(); renderStatus();
  return S.modal;
}
function modalValue(md) {
  let v = md.compute(md), typed = false;
  if (md.typed && md.typed !== '-' && md.typed !== '.') { const t = parseFloat(md.typed); if (isFinite(t)) { v = t; typed = true; } }
  md.clamped = false;
  if (md.range && v != null) { // never go where the kernel cannot build: hold the value at the limit
    const c = Math.min(md.range.max, Math.max(md.range.min, v));
    md.clamped = c !== v; v = c;
  }
  return {v, typed};
}
// Ask the kernel how far an operation can go before it fails (bisection on the server, ~0.2 s).
async function fetchLimit(cmd, params, param, hi, direction, iters) {
  try { return (await post('/api/limits', {cmd, params, param, lo: 0.001, hi, direction, iters})).max; } catch { return null; }
}
// Which operations the current selection can take at all (checked once per selection and model version),
// so buttons for impossible operations are disabled instead of failing later.
function feasibility() {
  const s = S.sel;
  const key = S.version + '|' + s.edges.map(e => e.body + e.mid).join() + '|' + s.faces.map(f => f.body + f.point).join();
  if (S.feas?.key === key) return S.feas;
  S.feas = {key, pending: true};
  const jobs = [];
  if (s.edges.length) { const g = edgeGroup();
    jobs.push(fetchLimit('edge.fillet', g, 'radius', 1, null, 0).then(v => S.feas.key === key && (S.feas.fillet = v != null)),
              fetchLimit('edge.chamfer', g, 'length', 1, null, 0).then(v => S.feas.key === key && (S.feas.chamfer = v != null))); }
  if (s.faces.length) { const f = s.faces.at(-1);
    jobs.push(fetchLimit('body.shell', {body: f.body, open_at: f.point}, 'thickness', 1, null, 0).then(v => S.feas.key === key && (S.feas.shell = v != null))); }
  Promise.all(jobs).then(() => { if (S.feas.key === key) { S.feas.pending = false; renderCtx(); } });
  return S.feas;
}
const diagOf = body => { const b = S.doc.bodies[body]?.bbox; return b ? Math.hypot(...b[1].map((x, i) => x - b[0][i])) : 10; };
function setRange(m, min, max) {
  m.range = {min, max}; m.unbuildable = min === 0 && max === 0;
  if (S.modal === m) updateModal();
}
function updateModal() {
  const md = S.modal; if (!md) return;
  const {v, typed} = modalValue(md);
  if (v == null || !isFinite(v)) return;
  md.value = v;
  md.custom = md.apply(md, v);
  md.isTyped = typed || !!md.typed;
  renderModalHud();
}
// Dragging past what the kernel can build stops at the last value that worked (typed values are never altered).
async function finishPreviewed(m) {
  if (m.unbuildable || !m.cmd) { await load(); return; }
  if (!lastPreview) return commit(m.good ? m.good.body.cmd : m.cmd, m.good ? m.good.body.params : m.params); // previews are idle: good is the final value
  if (m.good) { log('info', `${m.label}: 作れる値 ${m.good.v.toFixed(3)} で確定`, lastPreview); return commit(m.good.body.cmd, m.good.body.params); }
  log('info', `${m.label}: 適用できませんでした`, lastPreview); await load(); // quiet: the range check should make this rare
}
function renderModalHud() {
  const md = S.modal; if (!md || md.value == null) return;
  const v = md.value;
  const ax = md.axis ? ` <span class="ax" style="color:${AXCOL[md.axis]}">${md.axis}</span>` : '';
  const lim = md.range && !md.unbuildable && md.limitText ? ` <span class="dim">${md.limitText(md.range)}</span>` : md.range || md.unbuildable || !md.limitText ? '' : ' <span class="dim">…</span>';
  hud(md.unbuildable ? `<span class="hud-err">${icon('warn')} ${esc(md.unbuildableText || 'この形には適用できません')}</span>`
    : `${md.label}${ax} ${md.custom ?? (md.fmt ? md.fmt(v) : v.toFixed(3))}${md.clamped ? ' <span class="lim">上限</span>' : ''}${lim}${md.isTyped ? ` <span class="dim">[${esc(md.typed)}_]</span>` : ''}`);
}
async function endModal(ok) {
  const md = S.modal; if (!md) return;
  S.modal = null; orbit.enabled = true; hud(''); axisGuide.visible = triad.visible = moveLine.visible = false;
  if (ok && md.value != null) { await idle(); await md.finish(md, md.value); }
  else { md.cancel?.(md); await idle(); await load(); }
  renderStatus();
}
function modalKey(e) {
  const md = S.modal, k = e.key;
  if (k === 'Escape') return endModal(false);
  if (k === 'Enter' || k === 'NumpadEnter') return endModal(true);
  if (md.axes && ['x', 'y', 'z'].includes(k.toLowerCase())) { const a = k.toUpperCase(); md.axis = md.axis === a ? null : a; md.onAxis?.(md); }
  else if (/^[0-9.]$/.test(k) || (k === '-' && !md.typed)) md.typed += k;
  else if (k === '-' && md.typed) md.typed = md.typed.startsWith('-') ? md.typed.slice(1) : '-' + md.typed;
  else if (k === 'Backspace') md.typed = md.typed.slice(0, -1);
  else return;
  e.preventDefault(); updateModal();
}
function showAxisGuide(p, a, color) { // a: 'X' | 'Y' | 'Z' or a direction vector
  if (!a) { axisGuide.visible = false; return; }
  const dir = typeof a === 'string' ? AX[a] : a.clone().normalize();
  axisGuide.geometry.setFromPoints([p.clone().addScaledVector(dir, -1000), p.clone().addScaledVector(dir, 1000)]);
  axisGuide.material.color.set(color ?? AXHEX[a]); axisGuide.visible = true;
}
const dominantAxis = v => ['X', 'Y', 'Z'].reduce((b, a) => Math.abs(v.dot(AX[a])) > Math.abs(v.dot(AX[b])) ? a : b, 'X');
function hud(html) {
  const h = $('hud'); h.hidden = !html; if (html) h.innerHTML = html;
  if (S.mouse) { h.style.left = S.mouse.x + 16 + 'px'; h.style.top = S.mouse.y + 16 + 'px'; }
}

const selBodies = () => S.sel.bodies.length ? [...S.sel.bodies] : [...new Set([...S.sel.faces, ...S.sel.edges].map(x => x.body))];
const pivotOf = names => boxOf(names).getCenter(new T.Vector3());
const unitScale = () => (cam === ortho ? (ortho.userData.dist ?? 10) / ortho.zoom : cam.position.distanceTo(orbit.target)) / 900;

// client-side transform preview: move the body groups; commit body.transform per body
function transformModal(kind) {
  const names = selBodies().filter(n => !S.hidden.has(n) && S.groups[n]); // only bodies that are drawn
  if (!names.length) return toast(`ボディを選択してください（4 でボディモード、${KM.shortcutOf('select.all')} で全選択）`);
  const p = pivotOf(names), ps = screenOf(p);
  const sign = a => Math.sign(AX[a].dot(cam.position.clone().sub(p))) || 1;
  const camDir = cam.getWorldDirection(new T.Vector3());
  const plane = new T.Plane().setFromNormalAndCoplanarPoint(camDir, p);
  const startHit = () => ray.ray.intersectPlane(plane, new T.Vector3());
  const md = {
    kind, axes: true, label: {grab: '移動', rotate: '回転', scale: '拡大縮小'}[kind],
    fmt: kind === 'rotate' ? v => `${v.toFixed(1)}°` : kind === 'scale' ? v => `×${v.toFixed(3)}` : v => v.toFixed(3),
    init(m) { m.h0 = startHit(); m.a0 = Math.atan2(-(m.y0 - ps.y), m.x0 - ps.x); m.d0 = Math.hypot(m.x0 - ps.x, m.y0 - ps.y) || 1;
      if (kind === 'rotate') m.axis = 'Z';
      showTriad(p, m.axis); showAxisGuide(p, m.axis); },
    onAxis(m) { if (kind === 'rotate' && !m.axis) m.axis = 'Z'; showAxisGuide(p, m.axis); showTriad(p, m.axis);
      if (kind === 'grab' && m.axis) m.t0 = closestOnAxis(p, AX[m.axis]); },
    compute(m) {
      if (kind === 'scale') return Math.hypot(S.mouse.x - ps.x, S.mouse.y - ps.y) / m.d0;
      if (kind === 'rotate') { let a = T.MathUtils.radToDeg(Math.atan2(-(S.mouse.y - ps.y), S.mouse.x - ps.x) - m.a0); a = ((a + 540) % 360) - 180; return a * sign(m.axis); }
      if (m.axis) { const t = closestOnAxis(p, AX[m.axis]); return t == null ? 0 : t - (m.t0 ?? 0); }
      return 0; // free move: vector in m.vec
    },
    apply(m, v) {
      const M4 = new T.Matrix4();
      if (kind === 'grab') {
        let t;
        if (m.axis) t = AX[m.axis].clone().multiplyScalar(v);
        else if (m.typed) t = AX.X.clone().multiplyScalar(v);
        else { const h = startHit(); t = h && m.h0 ? h.sub(m.h0) : new T.Vector3(); }
        m.t = t; M4.makeTranslation(t.x, t.y, t.z);
        showTriad(p.clone().add(t), m.axis); showMoveLine(p, p.clone().add(t));
      } else {
        const R4 = kind === 'rotate' ? new T.Matrix4().makeRotationAxis(AX[m.axis || 'Z'], T.MathUtils.degToRad(v)) : new T.Matrix4().makeScale(v, v, v);
        M4.makeTranslation(p.x, p.y, p.z).multiply(R4).multiply(new T.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
      }
      for (const n of names) { const g = S.groups[n]; if (!g) continue; g.matrixAutoUpdate = false; g.matrix.copy(M4); g.matrixWorldNeedsUpdate = true; }
      if (kind === 'grab' && !m.axis && !m.typed) return arr(m.t).map(x => x.toFixed(2)).join(', ');
    },
    async finish(m, v) {
      const pv = arr(p);
      for (const n of names) {
        const params = {body: n, pivot: pv};
        if (kind === 'grab') params.translate = arr(m.t);
        if (kind === 'rotate') params.rotate = ['X', 'Y', 'Z'].map(a => a === (m.axis || 'Z') ? +v.toFixed(4) : 0);
        if (kind === 'scale') params.scale = +v.toFixed(5);
        await commit('body.transform', params, {keepSel: true});
      }
    },
  };
  startModal(md);
}

// value modal: one number from horizontal mouse travel (or typed), previewed through the kernel
function valueModal(label, build, {start = 0, scale = 1, limit, unbuildableText} = {}) {
  const m = startModal({
    label, unbuildableText, limitText: r => `最大 ${r.max.toFixed(3)}`,
    compute: m => start + (S.mouse.x - m.x0) * unitScale() * scale,
    apply: (m, v) => { if (m.unbuildable) return; const [cmd, params] = build(v); m.cmd = cmd; m.params = params; preview('/api/exec', {cmd, params}); },
    finish: finishPreviewed,
  });
  if (limit) limit().then(max => setRange(m, max == null ? 0 : 0.001, max ?? 0));
}
const edgeGroup = () => { const b = S.sel.edges[0]?.body; return {body: b, edges: S.sel.edges.filter(x => x.body === b).map(x => x.mid)}; };
function filletModal(chamfer) {
  if (!S.sel.edges.length) return toast('エッジを選択してください（2 でエッジモード）');
  const g = edgeGroup(), [cmd, key] = chamfer ? ['edge.chamfer', 'length'] : ['edge.fillet', 'radius'];
  valueModal(chamfer ? '面取り' : 'フィレット', v => [cmd, {...g, [key]: +v.toFixed(4)}],
    {start: 0.05, limit: () => fetchLimit(cmd, g, key, diagOf(g.body)), unbuildableText: `この辺には${chamfer ? '面取り' : 'フィレット'}をかけられません`});
}
function pushModal() {
  const f = S.sel.faces.at(-1);
  if (!f) return toast('面を選択してください（3 で面モード）');
  if (S.doc.bodies[f.body]?.kind === 'Sketch') return regionModal(f);
  const n = V(f.normal).normalize(), p0 = V(f.point);
  const m = startModal({
    label: '押し引き', init: m => { m.t0 = closestOnAxis(p0, n) ?? 0; const a = dominantAxis(n);
      showAxisGuide(p0, Math.abs(n.dot(AX[a])) > 0.999 ? a : n, Math.abs(n.dot(AX[a])) > 0.999 ? AXHEX[a] : 0xf5a623); },
    compute: m => { const t = closestOnAxis(p0, n); return t == null ? 0 : t - m.t0; },
    apply: (m, v) => { if (Math.abs(v) < 1e-4) { m.cmd = null; return; } m.cmd = 'face.move'; m.params = {body: f.body, at: f.point, by: arr(n.clone().multiplyScalar(v))}; preview('/api/exec', {cmd: 'face.move', params: m.params}); },
    finish: finishPreviewed, limitText: r => `${(-r.min).toFixed(2)} 〜 ${r.max.toFixed(2)}`,
  });
  const base = {body: f.body, at: f.point}, d = diagOf(f.body), nn = arr(n);
  Promise.all([fetchLimit('face.move', base, 'by', d * 3, nn), fetchLimit('face.move', base, 'by', d, nn.map(x => -x))])
    .then(([out, inn]) => setRange(m, -(inn ?? 0), out ?? 0));
}
function shellModal() {
  const f = S.sel.faces.at(-1);
  if (!f) return toast('開口する面を選択してください');
  const p = {body: f.body, open_at: f.point};
  valueModal('シェル厚', v => ['body.shell', {...p, thickness: +v.toFixed(4)}],
    {start: 0.1, limit: () => fetchLimit('body.shell', p, 'thickness', diagOf(f.body)), unbuildableText: 'このボディはシェルにできません'});
}

// ------------------------------------------------------------------ pointer
addEventListener('pointermove', e => { S.mouse = {x: e.clientX, y: e.clientY}; });
canvas.addEventListener('pointerdown', e => {
  setRay(e);
  if (S.modal) { // LMB confirms, RMB cancels
    e.preventDefault(); e.stopImmediatePropagation();
    endModal(e.button === 0); return;
  }
  if (S.tool === 'ruler' && e.button === 0) { e.stopImmediatePropagation(); rulerClick(e); return; }
  if (['rect', 'circle', 'poly'].includes(S.tool) && e.button === 0) { e.stopImmediatePropagation(); sketchClick(e); return; }
  if (e.button === 2) { S.rdown = {x: e.clientX, y: e.clientY}; return; }
  if (e.button !== 0) return;
  const hd = pickHandle();
  if (hd) { e.stopImmediatePropagation(); startHandleDrag(e, hd); return; }
  const h = pick();
  if (!h || e.altKey) { S.downEmpty = {x: e.clientX, y: e.clientY}; return; } // Alt+LMB / empty: orbit
  e.stopImmediatePropagation(); // geometry: never start an orbit
  S.drag = {h, x0: e.clientX, y0: e.clientY, moved: false, shift: e.shiftKey};
}, {capture: true});

addEventListener('pointermove', e => {
  setRay(e);
  if (S.modal) { updateModal(); return; }
  if (S.tool === 'ruler' && !S.drag) { if (e.target === canvas) rulerHover(e); return; }
  if (['rect', 'circle', 'poly'].includes(S.tool) && !S.drag) { if (e.target === canvas) sketchHover(e); return; }
  const d = S.drag;
  if (!d) {
    if (e.target !== canvas) return;
    const h = pickHandle() ? null : pick();
    const key = h && (h.kind + h.body + (h.fi ?? '') + (h.ei ?? ''));
    if (key !== S.hoverKey) { S.hover = h; S.hoverKey = key; refresh(); }
    canvas.style.cursor = pickHandle() || h ? 'pointer' : '';
    return;
  }
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
  if (!d.moved) {
    d.moved = true;
    if (d.handle) return;
    // turn the drag into a modal that confirms on release
    const h = d.h;
    if (h.kind === 'face' && !h.mesh) { S.sel.faces = [h]; S.sel.edges = []; S.sel.bodies = []; S.mouse = {x: d.x0, y: d.y0}; setRay(e); pushModal(); }
    else if (h.kind === 'edge') {
      if (!S.sel.edges.some(x => x.body === h.body && x.ei === h.ei)) { S.sel.edges = [h]; }
      const g = edgeGroup();
      S.mouse = {x: d.x0, y: d.y0};
      const em = startModal({label: 'フィレット', compute: m => (S.mouse.x - m.x0) * unitScale(),
        limitText: r => `面取り 最大 ${(-r.min).toFixed(3)} · フィレット 最大 ${r.max.toFixed(3)}`, unbuildableText: 'この辺にはフィレットも面取りもかけられません',
        apply: (m, v) => { if (m.unbuildable || Math.abs(v) < 1e-4) { m.cmd = null; return; } const ch = v < 0; m.label = ch ? '面取り' : 'フィレット'; const a = Math.max(Math.abs(v), 0.001);
          [m.cmd, m.params] = ch ? ['edge.chamfer', {...g, length: +a.toFixed(4)}] : ['edge.fillet', {...g, radius: +a.toFixed(4)}];
          preview('/api/exec', {cmd: m.cmd, params: m.params}); },
        finish: finishPreviewed});
      Promise.all([fetchLimit('edge.fillet', g, 'radius', diagOf(g.body)), fetchLimit('edge.chamfer', g, 'length', diagOf(g.body))])
        .then(([fil, cha]) => setRange(em, -(cha ?? 0), fil ?? 0));
    } else if (h.kind === 'body') {
      if (!S.sel.bodies.includes(h.body)) S.sel.bodies = [h.body];
      S.mouse = {x: d.x0, y: d.y0}; transformModal('grab');
    }
    if (S.modal) { S.modal.confirmOnUp = true; S.drag = null; S.mouse = {x: e.clientX, y: e.clientY}; updateModal(); }
    return;
  }
  if (d.handle) dragHandle(d, e);
});

addEventListener('pointerup', async e => {
  if (S.modal?.confirmOnUp && e.button === 0) return endModal(true);
  if (S.rdown && e.button === 2) {
    const moved = Math.hypot(e.clientX - S.rdown.x, e.clientY - S.rdown.y) > 4; S.rdown = null;
    if (!moved && e.target === canvas) contextMenu(e);
    return;
  }
  if (S.downEmpty) {
    if (Math.hypot(e.clientX - S.downEmpty.x, e.clientY - S.downEmpty.y) < 4 && !e.shiftKey) clearSel();
    S.downEmpty = null;
  }
  const d = S.drag; if (!d) return;
  S.drag = null; orbit.enabled = true;
  if (d.handle) return endHandleDrag(d);
  if (!d.moved) select(d.h, d.shift);
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

function select(h, add) {
  const sel = S.sel;
  if (!add) { sel.faces = []; sel.edges = []; sel.bodies = []; }
  const toggle = (list, match, item) => { const i = list.findIndex(match); i >= 0 ? list.splice(i, 1) : list.push(item); };
  if (h.kind === 'face') toggle(sel.faces, f => f.body === h.body && f.fi === h.fi, h);
  else if (h.kind === 'edge') toggle(sel.edges, x => x.body === h.body && x.ei === h.ei, h);
  else toggle(sel.bodies, b => b === h.body, h.body);
  S.form = null; S.feature = null; refresh(); renderPanels();
}

// ------------------------------------------------------------------ NURBS control-point handles
function showHandles() {
  handles.clear();
  const f = S.doc.features.find(x => x.id === S.feature);
  if (!f || f.cmd !== 'nurbs.surface' || f.suppressed || S.render) return;
  const r = cam.position.distanceTo(orbit.target) * 0.012 / (cam === ortho ? ortho.zoom : 1);
  const geo = new T.SphereGeometry(r, 12, 8), g = f.params.grid, lines = [];
  g.forEach((row, i) => row.forEach((p, j) => {
    const s = new T.Mesh(geo, new T.MeshBasicMaterial({color: 0x4fc3f7, depthTest: false}));
    s.renderOrder = 11; s.position.copy(V(p)); s.userData = {i, j}; handles.add(s);
    if (j + 1 < row.length) lines.push(V(p), V(row[j + 1]));
    if (i + 1 < g.length) lines.push(V(p), V(g[i + 1][j]));
  }));
  const net = new T.LineSegments(new T.BufferGeometry().setFromPoints(lines), new T.LineBasicMaterial({color: 0x4fc3f7, transparent: true, opacity: 0.5, depthTest: false}));
  net.renderOrder = 10; net.raycast = () => {}; handles.add(net);
}
function startHandleDrag(e, hd) {
  const f = S.doc.features.find(x => x.id === S.feature);
  orbit.enabled = false;
  S.drag = {handle: hd, feature: f, grid: JSON.parse(JSON.stringify(f.params.grid)), p0: hd.position.clone(), x0: e.clientX, y0: e.clientY, moved: false};
}
function dragHandle(d, e) {
  let p;
  if (e.shiftKey) { p = ray.ray.intersectPlane(new T.Plane(new T.Vector3(0, 0, 1), -d.p0.z), new T.Vector3()); if (!p) return; }
  else { const t = closestOnAxis(d.p0, AX.Z); if (t == null) return; p = d.p0.clone().addScaledVector(AX.Z, t); }
  d.handle.position.copy(p);
  const {i, j} = d.handle.userData;
  d.grid[i][j] = arr(p);
  preview('/api/feature', {id: d.feature.id, params: {grid: d.grid}});
  hud(`制御点 [${i},${j}] z ${p.z.toFixed(3)}`);
}
async function endHandleDrag(d) { hud(''); if (!d.moved) return; await idle(); await updateFeature(d.feature.id, {grid: d.grid}); }

// ------------------------------------------------------------------ actions (bindable)
const A = KM.register;
const needBodies = () => selBodies().length > 0;
A('mode.edge', 'エッジ選択モード', '選択', () => setMode('edge'));
A('mode.face', '面選択モード', '選択', () => setMode('face'));
A('mode.body', 'ボディ選択モード', '選択', () => setMode('body'));
A('add.menu', '追加メニュー', '作成', e => addMenu(e));
A('select.all', 'すべて選択', '選択', () => { S.mode = 'body'; S.sel = {faces: [], edges: [], bodies: Object.keys(S.doc.bodies).filter(n => !S.hidden.has(n))}; refresh(); renderPanels(); });
A('select.none', '選択解除', '選択', () => { S.form = null; S.feature = null; closeMenus(); clearSel(); });
A('transform.grab', '移動 (G)', '変形', () => (S.sel.faces.length && !S.sel.bodies.length) ? pushModal() : transformModal('grab'));
A('transform.rotate', '回転 (R)', '変形', () => transformModal('rotate'));
A('transform.scale', '拡大縮小 (S)', '変形', () => transformModal('scale'));
A('edit.extrude', '面の押し引き', '編集', pushModal);
const blocked = k => { const f = S.feas; if (f && !f.pending && f[k] === false) { toast(k === 'shell' ? 'このボディはシェルにできません' : 'この辺にはかけられません'); return true; } return false; };
A('edit.fillet', 'フィレット', '編集', () => blocked('fillet') || filletModal(false));
A('edit.chamfer', '面取り', '編集', () => blocked('chamfer') || filletModal(true));
A('edit.shell', 'シェル', '編集', () => blocked('shell') || shellModal());
A('edit.duplicate', '複製', '編集', async () => {
  const names = selBodies(); if (!names.length) return toast('ボディを選択してください');
  const made = [];
  for (const n of names) { const d = await commit('body.duplicate', {body: n}, {keepSel: true}); if (d) made.push(d.feature.params.name); }
  S.mode = 'body'; S.sel = {faces: [], edges: [], bodies: made}; refresh(); transformModal('grab');
});
A('edit.delete', '削除', '編集', async () => {
  if (S.sel.bodies.length) { for (const b of [...S.sel.bodies]) await commit('body.delete', {body: b}); }
  else if (S.feature) updateFeature(S.feature, null, {delete: true});
});
for (const [k, l] of [['union', '結合'], ['cut', '切り抜き'], ['intersect', '交差']])
  A('bool.' + k, `ブーリアン: ${l}`, '編集', () => {
    if (S.sel.bodies.length < 2) return toast('2 つ以上のボディを選択してください（最初に選んだものが対象）');
    commit('body.boolean', {kind: k, target: S.sel.bodies[0], tools: S.sel.bodies.slice(1)});
  });
for (const v of Object.keys(VIEWS)) A('view.' + v, `視点: ${VIEW_NAMES[v]}`, '表示', () => setView(v));
A('view.ortho', '透視 / 平行投影', '表示', () => { S.autoPersp = false; setCamera(cam === persp ? ortho : persp); });
A('view.frame', '選択にフレーム', '表示', () => frame(selBodies()));
A('view.shading', 'シェーディング切替', '表示', () => { setRender(false); S.shading = SHADING[(SHADING.indexOf(S.shading) + 1) % 3]; applyShading(); refresh(); renderTop(); });
A('view.render', 'レンダー表示', '表示', () => setRender(!S.render));
A('hide.selected', '選択を隠す', '表示', () => { for (const n of selBodies()) S.hidden.add(n); clearSel(); buildVis(); });
A('hide.unhide', 'すべて表示', '表示', () => { S.hidden.clear(); buildVis(); });
A('panel.toolbar', 'ツールバー表示', '表示', () => { document.body.classList.toggle('no-tools'); });
A('panel.lastop', '操作パネルの展開 / 折りたたみ', '表示', () => { S.dialogOpen = !S.dialogOpen; renderDialog(); });
A('panel.side', 'サイドパネル表示', '表示', () => { document.body.classList.toggle('no-side'); });
A('history.undo', '元に戻す', '履歴', async () => applyState(await post('/api/undo')));
A('history.redo', 'やり直し', '履歴', async () => applyState(await post('/api/redo')));
A('command.repeat', '直前のコマンドを繰り返す', '履歴', () => { if (S.lastCmd) openForm(S.lastCmd); });
A('command.palette', 'コマンド検索', 'アプリ', openPalette);
A('file.new', '新規', 'ファイル', async () => { if (confirm('新しいドキュメントを作りますか？（取り消しで戻せます）')) { S.framed = false; S.feature = null; applyState(await post('/api/new')); } });
A('file.open', '開く / 読み込み', 'ファイル', () => $('file').click());
A('file.import', '読み込み (STEP / STL / WRL)', 'ファイル', () => $('file').click());
A('file.save', '保存 (.nrk)', 'ファイル', () => download('nrk'));
A('file.export', '書き出し…', 'ファイル', e => exportMenu(e));
A('help.keymap', 'ショートカット一覧と変更', 'アプリ', openKeymap);
const run = (id, e) => { const a = KM.allActions().find(x => x.id === id); if (a) a.run(e); };

function setMode(m) { S.mode = m; S.form = null; clearSel(); renderTop(); }
function buildVis() { for (const [n, g] of Object.entries(S.groups)) g.visible = !S.hidden.has(n); renderPanels(); }

addEventListener('keydown', e => {
  if (S.capture) return; // keymap editor is recording
  if (e.target.matches?.('input,textarea,select')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (!$('modal').hidden) { if (e.key === 'Escape') { $('modal').hidden = true; renderPanels(); } return; }
  if (!$('palette').hidden) return;
  if (S.modal) return modalKey(e);
  if (['rect', 'circle', 'poly'].includes(S.tool) && sketchKey(e)) return;
  if (S.tool === 'ruler' && (e.key === 'Delete' || e.key === 'Backspace') && S.rulers.length) { e.preventDefault(); deleteRuler(S.rulers.length - 1); return; }
  if (S.tool === 'ruler' && e.key === 'Escape') { e.preventDefault(); if (S.rulerA) { S.rulerA = null; rulerPreview(null); } else setTool(null); return; }
  const combo = KM.comboOf(e); if (!combo) return;
  const a = KM.lookup(combo);
  if (a) { e.preventDefault(); closeMenus(); a.run(e); }
});

// ------------------------------------------------------------------ top bar, tools, panels
const btn = (id, ic, title, extra = '') => `<button data-act="${id}" data-tip="${esc(title)}" data-key="${esc(KM.shortcutOf(id))}" aria-label="${esc(title)}" ${extra}>${icon(ic)}</button>`;
function renderTop() {
  $('filebar').innerHTML = btn('file.new', 'new', '新規') + btn('file.open', 'open', '開く') + btn('file.save', 'save', '保存') +
    btn('file.export', 'export', '書き出し') + '<span class="sep"></span>' + btn('history.undo', 'undo', '元に戻す', S.doc.can_undo ? '' : 'disabled') +
    btn('history.redo', 'redo', 'やり直し', S.doc.can_redo ? '' : 'disabled');
  const on = c => c ? 'class="on"' : '';
  $('modebar').innerHTML = `<div class="seg">${btn('mode.edge', 'sel-edge', 'エッジ', on(S.mode === 'edge'))}${btn('mode.face', 'sel-face', '面', on(S.mode === 'face'))}${btn('mode.body', 'sel-body', 'ボディ', on(S.mode === 'body'))}</div>` +
    `<div class="seg">${SHADING.map(s => `<button data-shade="${s}" data-tip="${{solid: 'ソリッド', wire: 'ワイヤー', xray: 'X 線'}[s]}" data-key="${esc(KM.shortcutOf('view.shading'))}" ${on(!S.render && S.shading === s)}>${icon(s)}</button>`).join('')}${btn('view.render', 'render', 'レンダー', on(S.render))}</div>` +
    (S.render ? `<select id="material" style="width:auto">${['auto', 'clay', 'plastic', 'metal', 'glass'].map(m => `<option value="${m}" ${m === S.material ? 'selected' : ''}>${{auto: 'ボディごとの素材', clay: 'すべてクレイ', plastic: 'すべてプラスチック', metal: 'すべて金属', glass: 'すべてガラス'}[m]}</option>`).join('')}</select><select id="renderbg" style="width:auto">${Object.keys(BG).map(k => `<option value="${k}" ${k === S.renderBg ? 'selected' : ''}>${BG_JA[k]}</option>`).join('')}</select><button id="shot" data-tip="画像を保存">${icon('camera')}</button>` : '');
  $('appbar').innerHTML = btn('command.palette', 'search', 'コマンド検索') + btn('help.keymap', 'keyboard', 'ショートカット') +
    btn('panel.side', 'outliner', 'サイドパネル');
  $('viewbtns').innerHTML = btn('view.ortho', 'perspective', cam === persp ? '平行投影へ' : '透視投影へ', on(cam === ortho)) + btn('view.frame', 'fit', 'フレーム') + btn('view.iso', 'box', 'アイソメ');
  document.querySelectorAll('[data-shade]').forEach(b => b.onclick = () => { setRender(false); S.shading = b.dataset.shade; applyShading(); refresh(); renderTop(); });
  if ($('material')) $('material').onchange = e => { S.material = e.target.value; refresh(); };
  if ($('renderbg')) $('renderbg').onchange = e => { S.renderBg = e.target.value; try { localStorage.setItem('nerikone.renderBg', S.renderBg); } catch {} scene.background = renderBackground(S.renderBg); };
  if ($('shot')) $('shot').onclick = () => { R.render(scene, cam); const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = 'nerikone.png'; a.click(); };
}
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) run(b.dataset.act, e); });

function renderTools() {
  const on = t => S.tool === t ? 'class="on"' : '';
  $('toolsbody').innerHTML = btn('add.menu', 'add', '追加') + btn('tool.ruler', 'ruler', 'ルーラー', on('ruler')) +
    '<span class="sep"></span>' + btn('sketch.rect', 'rectangle', '矩形を描く', on('rect')) + btn('sketch.circle', 'circle', '円を描く', on('circle')) + btn('sketch.poly', 'polygon', '多角形を描く', on('poly')) +
    '<span class="sep"></span>' + btn('transform.grab', 'move', '移動') + btn('transform.rotate', 'rotate', '回転') + btn('transform.scale', 'scale', '拡大縮小') +
    '<span class="sep"></span>' + btn('edit.extrude', 'push', '押し引き') + btn('edit.fillet', 'fillet', 'フィレット') + btn('edit.chamfer', 'chamfer', '面取り') + btn('edit.shell', 'shell', 'シェル') +
    '<span class="sep"></span>' + btn('bool.union', 'union', '結合') + btn('bool.cut', 'cut', '切り抜き') + btn('bool.intersect', 'intersect', '交差');
}
// Add menu (A / Shift+A, or the + button). From the keyboard, the new body is placed
// on the ground (z = 0) under the mouse; from the button, next to the existing bodies.
const ADD_ITEMS = [{header: '基本形状'}, 'body.box', 'body.cylinder', 'body.sphere', 'body.cone', 'body.torus', 'sketch.extrude',
  {header: 'NURBS'}, 'nurbs.surface', 'nurbs.loft', 'nurbs.revolve'];
function addMenu(e) {
  const fromKey = e?.type === 'keydown', r = canvas.getBoundingClientRect();
  const atMouse = fromKey && S.mouse && S.mouse.x > r.left && S.mouse.x < r.right && S.mouse.y > r.top && S.mouse.y < r.bottom;
  let x, y, ground = null;
  if (atMouse) {
    x = S.mouse.x; y = S.mouse.y;
    setRay({clientX: x, clientY: y});
    ground = ray.ray.intersectPlane(new T.Plane(new T.Vector3(0, 0, 1), 0), new T.Vector3());
  } else { const b = (e?.target?.closest?.('button') || $('tools')).getBoundingClientRect(); x = b.right + 6; y = b.top; }
  showMenu(x, y, [...ADD_ITEMS.map(it => typeof it === 'string'
      ? {icon: cmdIcon(it), label: TOOL_JA[it] || S.cmds[it].label, run: () => create(it, ground)} : it),
    null, {icon: 'import', label: 'ファイルから読み込み (STEP / STL / WRL)', key: KM.shortcutOf('file.import'), run: () => $('file').click()}]);
}
function create(id, ground) {
  const box = boxOf(Object.keys(S.groups)), params = {};
  if (S.cmds[id].params.some(p => p.name === 'at')) {
    if (ground) params.at = [+ground.x.toFixed(2), +ground.y.toFixed(2), 0];
    else if (!box.isEmpty()) params.at = [+(box.max.x + 1.8).toFixed(2), 0, 0]; // next to the others, not on top
  }
  commit(id, params);
}

// context actions for the current selection (adaptive bar and right-click menu share this list)
function contextActions() {
  const s = S.sel, out = [];
  const fz = (s.faces.length || s.edges.length) ? feasibility() : {};
  const may = (id, ic, label, ok, why) => ok === false ? [id, ic, `${label}（${why}）`, true] : [id, ic, label];
  if (s.faces.length) out.push(['edit.extrude', 'push', '押し引き'], may('edit.shell', 'shell', 'シェル', fz.shell, 'このボディには不可'));
  if (s.edges.length) out.push(may('edit.fillet', 'fillet', 'フィレット', fz.fillet, 'この辺には不可'), may('edit.chamfer', 'chamfer', '面取り', fz.chamfer, 'この辺には不可'));
  if (selBodies().length) out.push(null, ['transform.grab', 'move', '移動'], ['transform.rotate', 'rotate', '回転'], ['transform.scale', 'scale', '拡大縮小'], ['edit.duplicate', 'duplicate', '複製']);
  if (s.bodies.length >= 2) out.push(null, ['bool.union', 'union', '結合'], ['bool.cut', 'cut', '切り抜き'], ['bool.intersect', 'intersect', '交差']);
  if (selBodies().length) out.push(['edit.material', 'palette', '素材と色']);
  if (s.faces.length) out.push(['edit.facecolor', 'bucket', '面の色']);
  if (selBodies().length) out.push(null, ['view.frame', 'fit', 'フレーム'], ['hide.selected', 'eye-off', '隠す']);
  if (s.bodies.length) out.push(['edit.delete', 'trash', '削除']);
  return out;
}
function renderCtx() {
  if (['rect', 'circle', 'poly'].includes(S.tool)) {
    const bar = $('ctxbar'); bar.hidden = false;
    bar.innerHTML = `<span class="lbl">${icon(SK_ICON[S.tool])} ${SK_JA[S.tool]}を描く</span>` +
      ['rect', 'circle', 'poly'].map(t => btn('sketch.' + t, SK_ICON[t], SK_JA[t], S.tool === t ? 'class="on"' : '')).join('') +
      `<button id="sk_exit" data-tip="終了" data-key="Esc">${icon('close')}</button>`;
    $('sk_exit').onclick = () => setTool(null);
    return;
  }
  if (S.tool === 'ruler') { // the tool's own bar replaces the selection actions
    const bar = $('ctxbar'); bar.hidden = false;
    bar.innerHTML = `<span class="lbl">${icon('ruler')} ルーラー ${S.rulers.length ? `(${S.rulers.length})` : ''}</span>` +
      `<button id="r_clear" data-tip="測定をすべて消す" ${S.rulers.length ? '' : 'disabled'}>${icon('trash')}</button>` +
      `<button id="r_exit" data-tip="ルーラーを終了" data-key="Esc">${icon('close')}</button>`;
    $('r_clear').onclick = () => { S.rulers = []; S.rulerA = null; drawRulers(); renderCtx(); };
    $('r_exit').onclick = () => setTool(null);
    return;
  }
  const acts = contextActions(), bar = $('ctxbar');
  bar.hidden = !acts.length || !!S.modal;
  if (bar.hidden) return;
  const n = S.sel.faces.length + S.sel.edges.length + S.sel.bodies.length;
  const what = S.sel.bodies.length ? 'ボディ' : S.sel.edges.length ? 'エッジ' : '面';
  bar.innerHTML = `<span class="lbl">${what} ${n}</span>` + acts.map(a => a ? btn(a[0], a[1], a[2], a[3] ? 'disabled' : '') : '<span class="sep"></span>').join('');
}
function contextMenu(e) {
  setRay(e);
  const h = pick();
  if (h && !(h.kind === 'face' ? isSelFace(h) : h.kind === 'edge' ? S.sel.edges.some(x => x.body === h.body && x.ei === h.ei) : S.sel.bodies.includes(h.body))) select(h, false);
  const items = contextActions();
  if (!items.length) items.push(['add.menu', 'add', '追加'], ['command.palette', 'search', 'コマンド検索'], ['view.frame', 'fit', 'すべてフレーム'], ['hide.unhide', 'eye', 'すべて表示'],
    ...(S.rulers.length ? [null, ['ruler.clear', 'trash', 'ルーラーをすべて消す']] : []));
  showMenu(e.clientX, e.clientY, items.map(a => a && {icon: a[1], label: a[2], key: KM.shortcutOf(a[0]), dis: a[3], run: () => run(a[0])}));
}
function showMenu(x, y, items) {
  const m = $('menu');
  m.innerHTML = items.map((it, i) => it?.header ? `<div class="mh">${esc(it.header)}</div>` : it ? `<div class="mi ${it.dis ? 'dis' : ''}" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span><span class="k">${esc(it.key || '')}</span></div>` : '<div class="msep"></div>').join('');
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + 'px'; m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + 'px';
  m.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { closeMenus(); items[+el.dataset.i].run(); });
}
function closeMenus() { $('menu').hidden = true; }
addEventListener('pointerdown', e => { if (!e.target.closest('#menu')) closeMenus(); });
function exportMenu(e) {
  const r = (e?.target?.closest?.('button') || $('filebar')).getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [['step', 'STEP (.step)'], ['stl', 'STL (.stl)'], ['glb', 'glTF (.glb)'], ['usda', 'USD (.usda)'], null, ['nrk', 'Nerikone (.nrk)']]
    .map(x => x && {icon: x[0] === 'nrk' ? 'save' : 'export', label: x[1], run: () => download(x[0])}));
}
async function download(fmt) {
  try {
    const r = await fetch('/api/export?fmt=' + fmt);
    if (!r.ok) throw new Error((await r.json()).error);
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'nerikone.' + fmt; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (err) { reportError(err.message, '書き出し'); }
}
$('file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try { S.framed = false; applyState(await req('POST', '/api/import?filename=' + encodeURIComponent(f.name), await f.arrayBuffer(), true)); toast(`${f.name} を読み込みました`); }
  catch (err) { reportError(err.message, '読み込み'); }
  e.target.value = '';
};

function renderPanels() {
  renderTop();
  const kindIcon = {Part: 'part', Shell: 'shell_body', Mesh: 'mesh'};
  $('outliner').innerHTML = Object.entries(S.doc.bodies).map(([n, b]) =>
    `<div class="orow ${S.sel.bodies.includes(n) ? 'sel' : ''} ${S.hidden.has(n) ? 'hidden' : ''}" data-body="${esc(n)}" title="${esc(b.kind)}">
      ${icon(kindIcon[b.kind] || 'part')}<span class="name">${esc(n)}</span><button class="swatch" data-mat="${esc(n)}" data-tip="素材と色" style="--c:${esc(b.color || b.mat_color || '#9aa7bd')}"></button><span class="vol">${b.volume != null ? b.volume.toFixed(2) : ''}</span>
      <button data-eye="${esc(n)}" data-tip="表示 / 非表示" data-key="${esc(KM.shortcutOf('hide.selected'))}">${icon(S.hidden.has(n) ? 'eye-off' : 'eye')}</button></div>`).join('') || '<div class="orow dim">ボディなし</div>';
  $('outliner').querySelectorAll('[data-body]').forEach(el => el.onclick = e => {
    const n = el.dataset.body;
    if (e.target.closest('[data-mat]')) { materialPopover(e.target.closest('[data-mat]'), [n]); return; }
    if (e.target.closest('[data-eye]')) { S.hidden.has(n) ? S.hidden.delete(n) : S.hidden.add(n); buildVis(); return; }
    S.mode = 'body'; select({kind: 'body', body: n}, e.shiftKey);
  });
  $('timeline').innerHTML = `<span class="dim" style="padding:0 6px">${icon('timeline')}</span>` + S.doc.features.map(f =>
    `<div class="chip ${f.id === S.feature ? 'sel' : ''} ${f.error ? 'err' : ''} ${f.suppressed ? 'off' : ''}" data-f="${f.id}" data-tip="${esc(f.label)}" data-sub="${esc(f.error ? friendly(f.error) : (f.params.name || f.params.body || ''))}">
      ${icon(cmdIcon(f))}<small>${esc(f.params.name || f.params.body || f.params.target || f.label)}</small></div>`).join('');
  $('timeline').querySelectorAll('[data-f]').forEach(el => {
    const id = +el.dataset.f;
    el.onclick = () => { S.feature = S.feature === id ? null : id; S.form = null; renderPanels(); };
    el.oncontextmenu = e => { e.preventDefault(); const f = S.doc.features.find(x => x.id === id);
      showMenu(e.clientX, e.clientY - 120, [{icon: 'settings', label: 'パラメータを編集', run: () => { S.feature = id; renderPanels(); }},
        {icon: f.suppressed ? 'eye' : 'eye-off', label: f.suppressed ? '抑制を解除' : '抑制', run: () => updateFeature(id, null, {suppressed: !f.suppressed})},
        null, {icon: 'trash', label: '削除', run: () => updateFeature(id, null, {delete: true})}]); };
  });
  renderDialog(); renderCtx(); showHandles(); renderStatus();
}

// floating parameter dialog (selected feature, or a command opened from the palette)
function openForm(id) { S.form = id; S.feature = null; renderPanels(); }
function renderDialog() {
  const el = $('dialog');
  const f = S.doc.features.find(x => x.id === S.feature);
  if (S.form) return renderForm(el, S.cmds[S.form], defaultsFromSelection(S.cmds[S.form]), p => commit(S.form, p), '実行', false);
  if (f) {
    renderForm(el, S.cmds[f.cmd], f.params, p => updateFeature(f.id, p), '適用', true, f);
    return;
  }
  el.hidden = true;
}
function defaultsFromSelection(cmd) {
  const p = {};
  for (const q of cmd.params) {
    if (q.type === 'body') p[q.name] = S.sel.bodies[0] || S.sel.faces[0]?.body || S.sel.edges[0]?.body || Object.keys(S.doc.bodies).at(-1) || '';
    else if (q.type === 'face_ref' && S.sel.faces.length) p[q.name] = S.sel.faces.at(-1).point;
    else if (q.type === 'edge_refs' && S.sel.edges.length) p[q.name] = S.sel.edges.map(e => e.mid);
    else if (q.type === 'bodies') p[q.name] = S.sel.bodies.slice(1);
    else if (q.name === 'target') p[q.name] = S.sel.bodies[0] || '';
    else if (q.name === 'pivot' && selBodies().length) p[q.name] = arr(pivotOf(selBodies()));
    else p[q.name] = q.default;
  }
  return p;
}
function renderForm(el, cmd, values, onSubmit, label, live, feature) {
  const bodies = Object.keys(S.doc.bodies);
  const field = q => {
    const v = values[q.name] ?? q.default, id = 'p_' + q.name;
    let input;
    if (q.type === 'float' || q.type === 'int') input = `<input id="${id}" type="number" step="${q.type === 'int' ? 1 : 0.1}" value="${v}">`;
    else if (q.type === 'bool') input = `<input id="${id}" type="checkbox" style="width:auto" ${v ? 'checked' : ''}>`;
    else if (q.type === 'enum') input = `<select id="${id}">${q.options.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    else if (q.type === 'body') input = `<select id="${id}">${[...new Set([v, ...bodies])].map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (q.type === 'str' || q.type === 'blob') input = `<input id="${id}" value="${esc(v ?? '')}" ${q.type === 'blob' ? 'readonly' : ''}>`;
    else if (q.type === 'vec3') input = `<div class="vec">${[0, 1, 2].map(k => `<input id="${id}_${k}" type="number" step="0.1" value="${v?.[k] ?? 0}" title="${'XYZ'[k]}">`).join('')}</div>`;
    else input = `<textarea id="${id}">${esc(JSON.stringify(v))}</textarea>`;
    return `<div class="field"><label title="${esc(q.doc || '')}">${esc(q.name)}${q.doc ? ` <span class="dim">· ${esc(q.doc)}</span>` : ''}</label>${input}</div>`;
  };
  // "Adjust last operation" panel: a tab at the bottom-left that expands only when clicked.
  // A command opened from search needs its parameters before it runs, so that one opens expanded.
  const open = !live || S.dialogOpen;
  el.hidden = false; el.classList.toggle('open', open);
  el.innerHTML = `<div class="dh" id="p_toggle" data-tip="${open ? '折りたたむ' : 'パラメータを開く'}" data-key="${esc(KM.shortcutOf('panel.lastop'))}">
      ${icon(open ? 'chevron-down' : 'chevron-right', 'chev')}${icon(feature ? cmdIcon(feature) : cmdIcon(cmd.id))}<span>${esc(cmd.label)}</span>
      ${feature?.error ? icon('warn', 'err') : ''}<button id="p_close" data-tip="閉じる" data-key="Esc">${icon('close')}</button></div>
    <div class="dbody">
    ${feature?.error ? `<div class="err" style="margin-bottom:6px">${icon('warn')} ${esc(friendly(feature.error))}</div>` : ''}
    <div class="doc">${esc(cmd.doc)}</div>${cmd.params.map(field).join('')}
    ${feature?.cmd === 'nurbs.surface' ? '<div class="doc">青い制御点をドラッグ: Z 方向（Shift で XY 平面）</div>' : ''}
    <div class="dfoot"><button class="pri txt" id="p_go">${icon('check')} ${label}</button></div><div id="p_err" class="err"></div></div>`;
  $('p_toggle').onclick = e => { if (e.target.closest('#p_close') || !live) return; S.dialogOpen = !S.dialogOpen; try { localStorage.setItem('nerikone.dialogOpen', S.dialogOpen ? '1' : ''); } catch {} renderDialog(); };
  const read = () => {
    const out = {};
    for (const q of cmd.params) {
      const id = 'p_' + q.name;
      if (q.type === 'float' || q.type === 'int') out[q.name] = +$(id).value;
      else if (q.type === 'bool') out[q.name] = $(id).checked;
      else if (['enum', 'body', 'str', 'blob'].includes(q.type)) out[q.name] = $(id).value;
      else if (q.type === 'vec3') out[q.name] = [0, 1, 2].map(k => +$(id + '_' + k).value);
      else out[q.name] = JSON.parse($(id).value);
    }
    return out;
  };
  const go = () => { try { onSubmit(read()); } catch (e) { $('p_err').textContent = e.message; } };
  $('p_go').onclick = go;
  $('p_close').onclick = () => { S.form = null; S.feature = null; renderPanels(); };
  if (live) el.querySelectorAll('input,select').forEach(i => i.addEventListener('change', go)); // parametric: rebuild on edit
}

function renderStatus() {
  const k = id => `<kbd>${esc(KM.shortcutOf(id))}</kbd>`;
  let h;
  if (['rect', 'circle', 'poly'].includes(S.tool)) h = `<kbd>LMB</kbd> ${sketchHint()} · 面の上で描くとその面に、空間では地面に · 頂点に吸着（<kbd>Shift</kbd> なし、<kbd>Ctrl</kbd> 0.1 刻み） · 数値を入力して <kbd>Enter</kbd> · <kbd>Esc</kbd> 取り消し / 終了`;
  else if (S.tool === 'ruler') h = `<kbd>LMB</kbd> ${S.rulerA ? '終点をクリック' : '始点をクリック'}（頂点に吸着、<kbd>Shift</kbd> で吸着なし） · <kbd>Delete</kbd> 最後の測定を消す · ラベルの × で個別に消す · <kbd>MMB</kbd> 回転 · <kbd>Esc</kbd> ${S.rulerA ? '取り消し' : '終了'}`;
  else if (S.modal) h = `<kbd>LMB</kbd>/<kbd>Enter</kbd> 確定 · <kbd>RMB</kbd>/<kbd>Esc</kbd> 取り消し · 数値を入力${S.modal.axes ? ' · <kbd>X</kbd> <kbd>Y</kbd> <kbd>Z</kbd> 軸を固定' : ''}`;
  else h = `<kbd>LMB</kbd> 選択・ドラッグで編集 · <kbd>MMB</kbd>/<kbd>Alt+LMB</kbd> 回転 · <kbd>Shift</kbd>+ドラッグ パン · ホイール ズーム · ` +
    `${k('transform.grab')} 移動 ${k('transform.rotate')} 回転 ${k('transform.scale')} 拡大 · ${k('command.palette')} 検索 · ${k('help.keymap')} ショートカット`;
  $('status').innerHTML = h;
}

// ------------------------------------------------------------------ command palette (actions + kernel commands)
function openPalette() {
  const pal = $('palette'), q = $('pq');
  pal.hidden = false; q.value = ''; q.focus();
  const all = [...KM.allActions().filter(a => a.id !== 'command.palette').map(a => ({icon: null, label: a.label, sub: a.group, key: KM.shortcutOf(a.id), run: () => a.run()})),
    ...Object.values(S.cmds).map(c => ({icon: cmdIcon(c.id), label: c.label, sub: c.id, key: '', run: () => openForm(c.id)}))];
  let items = [], hl = 0;
  const draw = () => {
    const s = q.value.toLowerCase();
    items = all.filter(c => !s || (c.label + c.sub).toLowerCase().includes(s)).slice(0, 60);
    hl = Math.max(0, Math.min(hl, items.length - 1));
    $('plist').innerHTML = items.map((c, i) => `<div class="mi ${i === hl ? 'hl' : ''}" data-i="${i}">${icon(c.icon || 'settings')}<span>${esc(c.label)} <span class="dim">${esc(c.sub)}</span></span><span class="k">${esc(c.key)}</span></div>`).join('');
    $('plist').querySelectorAll('[data-i]').forEach(r => r.onclick = () => choose(items[+r.dataset.i]));
    $('plist').querySelector('.hl')?.scrollIntoView({block: 'nearest'});
  };
  const choose = c => { close(); c?.run(); };
  const close = () => { pal.hidden = true; q.onkeydown = q.oninput = null; q.blur(); };
  q.oninput = () => { hl = 0; draw(); };
  q.onkeydown = e => {
    if (e.key === 'ArrowDown') { hl++; draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl--; draw(); e.preventDefault(); }
    else if (e.key === 'Enter') choose(items[hl]);
    else if (e.key === 'Escape') close();
    e.stopPropagation();
  };
  pal.onclick = e => e.stopPropagation();
  draw();
}

// ------------------------------------------------------------------ keymap editor
function openKeymap() {
  const m = $('modal');
  const draw = () => {
    const groups = {};
    for (const a of KM.allActions()) (groups[a.group] ||= []).push(a);
    const conf = KM.conflicts();
    m.innerHTML = `<div class="mbox"><h2>${icon('keyboard')} ショートカット<button id="km_close" style="margin-left:auto" title="閉じる">${icon('close')}</button></h2>
      <div class="dim">クリックで割り当てを追加、× で削除。変更はこのブラウザに保存され、JSON で書き出し・読み込みできます。<b>•</b> は変更済み。</div>
      <div class="mtools"><button class="txt" id="km_reset">${icon('undo')} すべて初期値に戻す</button><button class="txt" id="km_export">${icon('export')} 書き出し</button><button class="txt" id="km_import">${icon('import')} 読み込み</button></div>
      ${conf.length ? `<div class="err">${icon('warn')} 重複: ${conf.map(([k, a, b]) => `${esc(KM.pretty(k))} (${esc(a)} / ${esc(b)})`).join(', ')}</div>` : ''}
      <h4>マウス</h4><div class="krow"><span class="kl">選択 / ドラッグで直接編集（面: 押し引き、エッジ: 右へフィレット・左へ面取り、ボディ: 移動）</span><kbd>LMB</kbd></div>
      <div class="krow"><span class="kl">視点の回転</span><kbd>MMB</kbd> <kbd>Alt+LMB</kbd> <kbd>空白で LMB</kbd></div>
      <div class="krow"><span class="kl">パン / ズーム</span><kbd>Shift+ドラッグ</kbd> <kbd>RMB ドラッグ</kbd> <kbd>ホイール</kbd></div>
      <div class="krow"><span class="kl">コンテキストメニュー</span><kbd>RMB</kbd></div>
      ${Object.entries(groups).map(([g, list]) => `<h4>${esc(g)}</h4>` + list.map(a => `<div class="krow ${KM.isCustom(a.id) ? 'custom' : ''}" data-a="${a.id}"><span class="kl">${esc(a.label)} <span class="dim">${a.id}</span></span>
        ${KM.bindings(a.id).map((b, i) => `<span class="kchip"><kbd>${esc(KM.pretty(b))}</kbd><button data-rm="${i}" title="削除">${icon('close')}</button></span>`).join('')}
        <button class="add" data-add title="割り当てを追加">+</button>${KM.isCustom(a.id) ? `<button class="add" data-reset title="初期値に戻す">${icon('undo')}</button>` : ''}</div>`).join('')).join('')}</div>`;
    m.hidden = false;
    $('km_close').onclick = () => { m.hidden = true; renderPanels(); };
    $('km_reset').onclick = () => { if (confirm('すべてのショートカットを初期値に戻しますか？')) { KM.resetBindings(); draw(); } };
    $('km_export').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([KM.exportKeymap()], {type: 'application/json'})); a.download = 'nerikone-keymap.json'; a.click(); };
    $('km_import').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json'; i.onchange = async () => { try { KM.importKeymap(await i.files[0].text()); draw(); toast('読み込みました'); } catch (e) { toast(e.message, true); } }; i.click(); };
    m.querySelectorAll('[data-a]').forEach(row => {
      const id = row.dataset.a;
      row.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { const l = [...KM.bindings(id)]; l.splice(+b.dataset.rm, 1); KM.setBindings(id, l); draw(); });
      row.querySelector('[data-reset]')?.addEventListener('click', () => { KM.resetBindings(id); draw(); });
      row.querySelector('[data-add]').onclick = () => {
        row.classList.add('capture'); row.querySelector('.kl').insertAdjacentHTML('beforeend', ' <span class="err">キーを押してください（Esc で中止）</span>');
        S.capture = e => {
          if (e.key === 'Escape') { S.capture = null; draw(); return; }
          const c = KM.comboOf(e); if (!c) return;
          e.preventDefault(); S.capture = null; KM.setBindings(id, [...KM.bindings(id), c]); draw();
        };
      };
    });
  };
  draw();
}
addEventListener('keydown', e => { if (S.capture) S.capture(e); }, true);
$('modal').addEventListener('click', e => { if (e.target.id === 'modal') { $('modal').hidden = true; renderPanels(); } });

const summarize = p => Object.entries(p || {}).filter(([k]) => !['edges', 'grid', 'points', 'sections', 'blob'].includes(k))
  .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.map(x => typeof x === 'number' ? +x.toFixed(3) : x).join(', ')}]` : typeof v === 'number' ? +v.toFixed(4) : v}`).join(' ');
A('panel.console', 'コンソール', '表示', () => openConsole());
$('consolebtn').onclick = () => openConsole();
$('cclose').onclick = () => openConsole(false);
$('cfilter').onclick = () => { S.consoleFilter = S.consoleFilter === 'err' ? '' : 'err'; renderConsole(); };
$('cclear').onclick = () => { LOG.length = 0; S.unseenErr = 0; renderConsole(); };
$('ccopy').onclick = () => copyText(LOG.map(entryText).join('\n'));
$('cserver').onclick = async () => {
  const list = await get('/api/errors');
  copyText(list.map(e => `[${e.time}] ${e.path} ${e.cmd ?? ''}${e.preview ? ' (preview)' : ''}${e.count ? ` x${e.count}` : ''}\n${e.error}`).join('\n'));
};
$('clog').onclick = e => { const b = e.target.closest('[data-copy]'); if (b) copyText(entryText(LOG[+b.dataset.copy])); };

// ------------------------------------------------------------------ ruler (measure distances)
S.rulers = []; S.rulerA = null;
const rulerGroup = new T.Group(); scene.add(rulerGroup);
const rulerMat = new T.LineBasicMaterial({color: 0xffd27f, depthTest: false});
const dotMat = new T.PointsMaterial({color: 0xffd27f, size: 7, sizeAttenuation: false, depthTest: false});
const rulerLabels = Object.assign(document.createElement('div'), {id: 'rulerlabels'}); view.append(rulerLabels);
function setTool(t) {
  S.tool = t; S.rulerA = null; rulerPreview(null); S.sk = null; sketchPreview();
  if (t) { S.sel = {faces: [], edges: [], bodies: []}; S.hover = null; }
  canvas.style.cursor = t ? 'crosshair' : '';
  renderTools(); refresh(); renderPanels();
}
// a point under the mouse: an edge end (vertex) within 12 px, else the surface, else the ground plane
function snapPoint(e) {
  setRay(e);
  if (!e.shiftKey) {
    let best = null, bd = 12;
    for (const l of visibleEdges()) {
      const pos = l.geometry.attributes.position;
      for (const i of [0, pos.count - 1]) {
        const p = new T.Vector3().fromBufferAttribute(pos, i).applyMatrix4(l.matrixWorld), s = screenOf(p);
        const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (best) return {p: best, snap: true};
  }
  const h = ray.intersectObjects(visibleFaces())[0];
  if (h) return {p: h.point.clone(), snap: false};
  const g = ray.ray.intersectPlane(new T.Plane(new T.Vector3(0, 0, 1), 0), new T.Vector3());
  return g ? {p: g, snap: false} : null;
}
function rulerClick(e) {
  const sp = snapPoint(e); if (!sp) return;
  if (!S.rulerA) { S.rulerA = sp.p; }
  else { S.rulers.push({a: S.rulerA, b: sp.p}); log('info', `ルーラー: ${fmtDist(S.rulerA, sp.p)}`); S.rulerA = null; rulerPreview(null); drawRulers(); }
  renderCtx(); renderStatus();
}
function rulerHover(e) {
  const sp = snapPoint(e);
  S.rulerSnap = sp;
  rulerPreview(S.rulerA && sp ? {a: S.rulerA, b: sp.p} : null, sp);
}
const fmtDist = (a, b) => { const d = b.clone().sub(a); return `${d.length().toFixed(3)}  (Δx ${d.x.toFixed(3)}, Δy ${d.y.toFixed(3)}, Δz ${d.z.toFixed(3)})`; };
let previewObj = null, hoverDot = null;
function rulerPreview(r, sp) {
  if (previewObj) { scene.remove(previewObj); previewObj = null; }
  if (hoverDot) { scene.remove(hoverDot); hoverDot = null; }
  if (sp && S.tool === 'ruler') {
    hoverDot = new T.Points(new T.BufferGeometry().setFromPoints([sp.p]), new T.PointsMaterial({color: sp.snap ? 0x4fc3f7 : 0xffffff, size: sp.snap ? 11 : 6, sizeAttenuation: false, depthTest: false}));
    hoverDot.renderOrder = 13; scene.add(hoverDot);
  }
  if (r) { previewObj = rulerObject(r); scene.add(previewObj); }
  placeRulerLabels();
}
function rulerObject({a, b}) {
  const g = new T.Group();
  const l = new T.Line(new T.BufferGeometry().setFromPoints([a, b]), rulerMat); l.renderOrder = 13;
  const p = new T.Points(new T.BufferGeometry().setFromPoints([a, b]), dotMat); p.renderOrder = 13;
  g.add(l, p); g.userData.r = {a, b}; return g;
}
function drawRulers() { rulerGroup.clear(); for (const r of S.rulers) rulerGroup.add(rulerObject(r)); placeRulerLabels(); }
function placeRulerLabels() {
  const list = [...S.rulers, ...(previewObj ? [previewObj.userData.r] : [])];
  if (!list.length) { if (rulerLabels.innerHTML) rulerLabels.innerHTML = ''; return; }
  const vr = view.getBoundingClientRect();
  rulerLabels.innerHTML = list.map(({a, b}, i) => {
    const m = screenOf(a.clone().add(b).multiplyScalar(0.5)), d = b.clone().sub(a);
    return `<div class="rlabel ${i >= S.rulers.length ? 'live' : ''}" style="left:${m.x - vr.left}px;top:${m.y - vr.top}px">
      <b>${d.length().toFixed(3)}</b><span style="color:var(--x)">${d.x.toFixed(2)}</span><span style="color:var(--y)">${d.y.toFixed(2)}</span><span style="color:var(--z)">${d.z.toFixed(2)}</span>${i < S.rulers.length ? `<button data-rdel="${i}" title="この測定を消す">${icon('close')}</button>` : ''}</div>`;
  }).join('');
}
A('tool.ruler', 'ルーラー（距離を測る）', 'ツール', () => setTool(S.tool === 'ruler' ? null : 'ruler'));
function deleteRuler(i) { S.rulers.splice(i, 1); drawRulers(); renderCtx(); }
A('ruler.clear', 'ルーラーをすべて消す', 'ツール', () => { S.rulers = []; S.rulerA = null; rulerPreview(null); drawRulers(); renderCtx(); });
// labels are rebuilt every frame, so act on pointerdown (the element is still the one under the pointer)
rulerLabels.addEventListener('pointerdown', e => { const b = e.target.closest('[data-rdel]'); if (b) { e.stopPropagation(); e.preventDefault(); deleteRuler(+b.dataset.rdel); } });

// ------------------------------------------------------------------ materials and colours
function popover(anchorEl, html, onReady) {
  const m = $('menu'); m.innerHTML = `<div class="pop">${html}</div>`; m.hidden = false;
  const r = anchorEl ? anchorEl.getBoundingClientRect() : {left: S.mouse?.x ?? 200, bottom: S.mouse?.y ?? 200, top: S.mouse?.y ?? 200};
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)) + 'px';
  onReady(m);
}
function materialPopover(anchorEl, names) {
  const b = S.doc.bodies[names[0]] || {};
  let finish = b.finish || 'plastic';
  popover(anchorEl, `<div class="ph">${icon('palette')} 素材と色 <span class="dim">${esc(names.join(', '))}</span></div>
    <div class="vec"><input type="color" id="mc" value="${esc((b.color || b.mat_color || '#9aa7bd').slice(0, 7))}" style="height:30px;padding:2px"></div>
    <div class="fin">${Object.keys(FINISH).map(f => `<button data-fin="${f}" class="${f === finish ? 'on' : ''}">${esc(FINISH_JA[f])}</button>`).join('')}</div>
    <div class="dfoot"><button class="pri txt" id="mapply">${icon('check')} 適用</button></div>`, m => {
    m.querySelectorAll('[data-fin]').forEach(x => x.onclick = () => { finish = x.dataset.fin; m.querySelectorAll('[data-fin]').forEach(y => y.classList.toggle('on', y === x)); });
    $('mapply').onclick = async () => { const color = $('mc').value; closeMenus(); for (const n of names) await commit('body.material', {body: n, color, finish}, {keepSel: true}); };
  });
}
function faceColorPopover() {
  const faces = [...S.sel.faces]; if (!faces.length) return toast('面を選択してください');
  popover($('ctxbar'), `<div class="ph">${icon('bucket')} 面の色 <span class="dim">${faces.length} 面</span></div>
    <input type="color" id="fc" value="#4fc3f7" style="height:30px;padding:2px"><div class="dfoot"><button class="pri txt" id="fapply">${icon('check')} 塗る</button></div>`, () => {
    $('fapply').onclick = async () => { const color = $('fc').value; closeMenus(); for (const f of faces) await commit('face.color', {body: f.body, at: f.point, color}); };
  });
}
A('edit.material', '素材と色', '編集', () => { const n = selBodies(); if (!n.length) return toast('ボディを選択してください'); materialPopover($('ctxbar'), n); });
A('edit.facecolor', '面の色', '編集', faceColorPopover);

// ------------------------------------------------------------------ sketch: rectangle / circle / polygon regions
// Draw on a planar face (the region is then added to / cut from that body when pushed or pulled) or on the ground.
const SK_JA = {rect: '矩形', circle: '円', poly: '多角形'}, SK_ICON = {rect: 'rectangle', circle: 'circle', poly: 'polygon'};
const skLine = new T.LineLoop(new T.BufferGeometry(), new T.LineBasicMaterial({color: 0x4fc3f7, depthTest: false}));
skLine.renderOrder = 14; skLine.visible = false; scene.add(skLine);
const skDots = new T.Points(new T.BufferGeometry(), new T.PointsMaterial({color: 0x4fc3f7, size: 7, sizeAttenuation: false, depthTest: false}));
skDots.renderOrder = 14; skDots.visible = false; scene.add(skDots);
function planeUnder(e) {
  setRay(e);
  const h = ray.intersectObjects(visibleFaces())[0], u = h?.object.userData;
  if (h && u.planar && u.normal && S.doc.bodies[u.body]?.kind === 'Part') return {o: h.point.clone(), n: V(u.normal).normalize(), on_body: u.body};
  return {o: new T.Vector3(), n: new T.Vector3(0, 0, 1), on_body: ''};
}
function withBasis(pl) {
  pl.u = Math.abs(pl.n.z) > 0.9 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 0, 1).cross(pl.n).normalize();
  pl.v = pl.n.clone().cross(pl.u);
  return pl;
}
function onPlane(e, pl) { // mouse -> point on the sketch plane (vertex snap projected onto it; Ctrl = 0.1 grid)
  const sp = e.shiftKey ? null : snapPoint(e);
  let p = sp?.snap ? sp.p.clone() : (setRay(e), ray.ray.intersectPlane(new T.Plane().setFromNormalAndCoplanarPoint(pl.n, pl.o), new T.Vector3()));
  if (!p) return null;
  p.addScaledVector(pl.n, -p.clone().sub(pl.o).dot(pl.n));
  if (e.ctrlKey || e.metaKey) { const [a, b] = uvOf(p, pl).map(x => Math.round(x * 10) / 10); p = pl.o.clone().addScaledVector(pl.u, a).addScaledVector(pl.v, b); }
  return {p, snap: !!sp?.snap};
}
const uvOf = (p, pl) => { const d = p.clone().sub(pl.o); return [d.dot(pl.u), d.dot(pl.v)]; };
const fromUV = (pl, a, b) => pl.o.clone().addScaledVector(pl.u, a).addScaledVector(pl.v, b);
function typedNums() { return (S.sk?.typed || '').split(/[ ,x×]+/).map(parseFloat).filter(isFinite); }
function shapePoints(cur) { // world outline of what would be built now
  const k = S.sk; if (!k?.pts.length) return [];
  const pl = k.plane, [a0, b0] = uvOf(k.pts[0], pl), c = cur ? uvOf(cur, pl) : null, t = typedNums();
  if (S.tool === 'rect' && (c || t.length)) {
    let [a1, b1] = c ?? [a0 + 1, b0 + 1];
    if (t.length) { const sx = Math.sign(a1 - a0) || 1, sy = Math.sign(b1 - b0) || 1; a1 = a0 + sx * t[0]; b1 = b0 + sy * (t[1] ?? t[0]); }
    k.rect = {x: (a0 + a1) / 2, y: (b0 + b1) / 2, width: Math.abs(a1 - a0), height: Math.abs(b1 - b0)};
    return [[a0, b0], [a1, b0], [a1, b1], [a0, b1]].map(([a, b]) => fromUV(pl, a, b));
  }
  if (S.tool === 'circle' && (c || t.length)) {
    const r = t.length ? t[0] : Math.hypot(c[0] - a0, c[1] - b0);
    k.circle = {x: a0, y: b0, radius: r};
    return Array.from({length: 64}, (_, i) => fromUV(pl, a0 + r * Math.cos(i / 32 * Math.PI), b0 + r * Math.sin(i / 32 * Math.PI)));
  }
  if (S.tool === 'poly') return [...k.pts, ...(cur ? [cur] : [])];
  return [];
}
function sketchPreview(cur) {
  const pts = S.sk ? shapePoints(cur) : [];
  skLine.visible = pts.length > 1; if (skLine.visible) skLine.geometry.setFromPoints(pts);
  const dots = S.sk ? [...S.sk.pts, ...(cur ? [cur] : [])] : cur ? [cur] : [];
  skDots.visible = dots.length > 0; if (skDots.visible) skDots.geometry.setFromPoints(dots);
  const k = S.sk;
  if (!k?.pts.length) { if (!S.modal) hud(''); return; }
  const t = k.typed ? ` <span class="dim">[${esc(k.typed)}_]</span>` : '';
  if (S.tool === 'rect' && k.rect) hud(`矩形 ${k.rect.width.toFixed(3)} × ${k.rect.height.toFixed(3)}${t}`);
  else if (S.tool === 'circle' && k.circle) hud(`円 半径 ${k.circle.radius.toFixed(3)}${t}`);
  else if (S.tool === 'poly') hud(`多角形 ${k.pts.length} 点${t} <span class="dim">· 始点クリック / Enter で閉じる</span>`);
}
function sketchHint() {
  const n = S.sk?.pts.length || 0;
  return S.tool === 'rect' ? (n ? '対角の角をクリック（幅,高さ を入力可）' : '最初の角をクリック')
    : S.tool === 'circle' ? (n ? '半径の点をクリック（半径を入力可）' : '中心をクリック')
    : (n ? '次の点をクリック（始点クリック / Enter で閉じる、Backspace で 1 つ戻す）' : '最初の点をクリック');
}
function sketchHover(e) {
  const pl = S.sk?.plane || withBasis(planeUnder(e));
  const q = onPlane(e, pl);
  S.skCur = q?.p; sketchPreview(q?.p);
}
function sketchClick(e) {
  if (!S.sk) { const pl = withBasis(planeUnder(e)); const q = onPlane(e, pl); if (!q) return; S.sk = {plane: pl, pts: [q.p], typed: ''}; renderStatus(); sketchPreview(q.p); return; }
  const q = onPlane(e, S.sk.plane); if (!q) return;
  if (S.tool === 'poly') {
    const first = screenOf(S.sk.pts[0]);
    if (S.sk.pts.length >= 3 && Math.hypot(first.x - e.clientX, first.y - e.clientY) < 12) return finishSketch();
    S.sk.pts.push(q.p); sketchPreview(q.p); renderStatus(); return;
  }
  shapePoints(q.p); finishSketch();
}
function sketchKey(e) {
  const k = S.sk;
  if (e.key === 'Escape') { e.preventDefault(); if (k) { S.sk = null; sketchPreview(); hud(''); renderStatus(); } else setTool(null); return true; }
  if (!k) return false;
  if (e.key === 'Enter') { e.preventDefault(); if (S.tool === 'poly' ? k.pts.length >= 3 : (k.typed || S.skCur)) { shapePoints(S.skCur); finishSketch(); } return true; }
  if (e.key === 'Backspace') { e.preventDefault(); if (k.typed) k.typed = k.typed.slice(0, -1); else if (S.tool === 'poly' && k.pts.length > 1) k.pts.pop(); sketchPreview(S.skCur); return true; }
  if (/^[0-9.,\- ]$/.test(e.key) && S.tool !== 'poly') { e.preventDefault(); k.typed += e.key; sketchPreview(S.skCur); return true; }
  return false;
}
async function finishSketch() {
  const k = S.sk; if (!k) return;
  const pl = k.plane, base = {origin: arr(pl.o), normal: arr(pl.n), xdir: arr(pl.u), on_body: pl.on_body};
  let cmd, params;
  if (S.tool === 'rect') { if (!k.rect || k.rect.width < 1e-4 || k.rect.height < 1e-4) return; cmd = 'sketch.rect'; params = {...base, ...k.rect}; }
  else if (S.tool === 'circle') { if (!k.circle || k.circle.radius < 1e-4) return; cmd = 'sketch.circle'; params = {...base, ...k.circle}; }
  else { if (k.pts.length < 3) return; cmd = 'sketch.polygon'; params = {...base, points: k.pts.map(p => uvOf(p, pl).map(x => +x.toFixed(5)))}; }
  for (const key of ['x', 'y', 'width', 'height', 'radius']) if (key in params) params[key] = +params[key].toFixed(5);
  S.sk = null; sketchPreview(); hud('');
  const d = await commit(cmd, params);
  if (!d) return;
  // select the new region so it can be pushed / pulled right away (drag it, or E)
  const name = d.feature.params.name, c = S.groups[name] ? boxOf([name]).getCenter(new T.Vector3()) : pl.o;
  setTool(null); S.mode = 'face'; S.sel = {faces: [{body: name, fi: 0, point: arr(c), normal: arr(pl.n)}], edges: [], bodies: []};
  refresh(); renderPanels(); toast('ドラッグか E で押し出し / 押し込み');
}
// push / pull a sketch region: a new solid, or added to / cut from the body it was drawn on
function regionModal(f) {
  const feat = S.doc.features.find(x => x.params?.name === f.body && x.cmd.startsWith('sketch.'));
  const pn = feat ? V(feat.params.normal).normalize() : V(f.normal).normalize();
  const n = V(f.normal).normalize(), sgn = Math.sign(n.dot(pn)) || 1, p0 = V(f.point);
  const m = startModal({
    label: '押し出し', init: m => { m.t0 = closestOnAxis(p0, n) ?? 0; showAxisGuide(p0, n, 0x4fc3f7); },
    compute: m => { const t = closestOnAxis(p0, n); return t == null ? 0 : t - m.t0; },
    apply: (m, v) => { if (Math.abs(v) < 1e-4) { m.cmd = null; return; } m.label = v > 0 ? '押し出し' : '押し込み';
      m.cmd = 'region.extrude'; m.params = {body: f.body, amount: +(v * sgn).toFixed(5)}; preview('/api/exec', {cmd: m.cmd, params: m.params}); },
    finish: finishPreviewed, limitText: r => `${(-r.min).toFixed(2)} 〜 ${r.max.toFixed(2)}`,
  });
  const d = Math.max(diagOf(f.body), diagOf(feat?.params.on_body) || 0, 1) * 3;
  Promise.all([fetchLimit('region.extrude', {body: f.body}, 'amount', d, sgn), fetchLimit('region.extrude', {body: f.body}, 'amount', d, -sgn)])
    .then(([out, inn]) => setRange(m, -(inn ?? 0), out ?? 0));
}
for (const t of ['rect', 'circle', 'poly']) A('sketch.' + t, `スケッチ: ${SK_JA[t]}`, 'スケッチ', () => setTool(S.tool === t ? null : t));

// ------------------------------------------------------------------ floating panels
const FLOAT_KEY = 'nerikone.floats.v1';
let floatState = {};
try { floatState = JSON.parse(localStorage.getItem(FLOAT_KEY) || '{}'); } catch { floatState = {}; }
const saveFloats = () => { try { localStorage.setItem(FLOAT_KEY, JSON.stringify(floatState)); } catch { /* session only */ } };
function placeFloat(el, st) {
  const r = el.getBoundingClientRect();
  const x = Math.max(0, Math.min(st.x, innerWidth - Math.min(r.width, 80))), y = Math.max(0, Math.min(st.y, innerHeight - 30));
  Object.assign(el.style, {left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto'});
}
for (const el of document.querySelectorAll('.float')) {
  const id = el.dataset.float, st = floatState[id] || {};
  if (st.x != null) placeFloat(el, st);
  if (st.collapsed) el.classList.add('collapsed');
  const handle = el.querySelector(':scope > .fhead, :scope > .fgrip');
  handle?.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    el.classList.add('dragging'); handle.setPointerCapture?.(e.pointerId);
    const move = ev => placeFloat(el, {x: ev.clientX - dx, y: ev.clientY - dy});
    const up = () => {
      el.classList.remove('dragging'); removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const r2 = el.getBoundingClientRect(); floatState[id] = {...floatState[id], x: r2.left, y: r2.top}; saveFloats();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
    e.preventDefault();
  });
  handle?.addEventListener('dblclick', e => { if (!e.target.closest('button')) toggleCollapse(el); });
  el.querySelector('[data-collapse]')?.addEventListener('click', () => toggleCollapse(el));
}
function toggleCollapse(el) {
  el.classList.toggle('collapsed');
  floatState[el.dataset.float] = {...floatState[el.dataset.float], collapsed: el.classList.contains('collapsed')}; saveFloats();
}
A('panel.reset', 'パネルの位置を元に戻す', '表示', () => {
  floatState = {}; saveFloats();
  for (const el of document.querySelectorAll('.float')) { el.style.left = el.style.top = el.style.right = el.style.bottom = ''; el.classList.remove('collapsed'); }
});

// ------------------------------------------------------------------ tooltips (data-tip, data-key, data-sub)
const TOOL_JA = {'body.box': '直方体', 'body.cylinder': '円柱', 'body.sphere': '球', 'body.cone': '円錐', 'body.torus': 'トーラス',
  'sketch.extrude': '多角形を押し出し', 'nurbs.surface': 'NURBS 曲面', 'nurbs.loft': 'ロフト', 'nurbs.revolve': '回転体'};
const tipEl = Object.assign(document.createElement('div'), {id: 'tip'}); document.body.append(tipEl);
let tipT, tipFor = null;
function placeTip(el) {
  const r = el.getBoundingClientRect(), t = tipEl.getBoundingClientRect(), gap = 8;
  let x, y;
  if (el.closest('#tools')) { x = r.right + gap; y = r.top + r.height / 2 - t.height / 2; }
  else if (el.closest('#viewbtns, #side')) { x = r.left - t.width - gap; y = r.top + r.height / 2 - t.height / 2; }
  else if (el.closest('#ctxbar, #timelinebar')) { x = r.left + r.width / 2 - t.width / 2; y = r.top - t.height - gap; }
  else { x = r.left + r.width / 2 - t.width / 2; y = r.bottom + gap; }
  tipEl.style.left = Math.max(4, Math.min(x, innerWidth - t.width - 4)) + 'px';
  tipEl.style.top = Math.max(4, Math.min(y, innerHeight - t.height - 4)) + 'px';
}
document.addEventListener('pointerover', e => {
  const el = e.target.closest?.('[data-tip]');
  if (el === tipFor) return;
  tipFor = el; clearTimeout(tipT); tipEl.classList.remove('on');
  if (!el || S.modal || S.drag) return;
  tipT = setTimeout(() => {
    if (tipFor !== el || !el.isConnected) return;
    tipEl.innerHTML = `${esc(el.dataset.tip)}${el.dataset.key ? `<kbd>${esc(el.dataset.key)}</kbd>` : ''}` +
      (el.dataset.sub ? `<div class="dim" style="white-space:normal;max-width:260px;margin-top:2px">${esc(el.dataset.sub)}</div>` : '');
    placeTip(el); tipEl.classList.add('on');
  }, 250);
});
document.addEventListener('pointerdown', () => { clearTimeout(tipT); tipEl.classList.remove('on'); tipFor = null; }, true);

// ------------------------------------------------------------------ render mode
// render backdrop: a soft vertical gradient (dark by default; the light one was too glaring)
const BG = {dark: ['#3b3e45', '#16171a'], gray: ['#9a9da3', '#5c5f66'], white: ['#ffffff', '#d9dadd']};
const BG_JA = {dark: '背景: 暗い', gray: '背景: グレー', white: '背景: 白'};
const bgTex = {};
function renderBackground(k) {
  if (!bgTex[k]) {
    const c = document.createElement('canvas'); c.width = 2; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, BG[k][0]); gr.addColorStop(1, BG[k][1]); g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    bgTex[k] = new T.CanvasTexture(c); bgTex[k].colorSpace = T.SRGBColorSpace;
  }
  ground.material.opacity = k === 'dark' ? 0.45 : 0.25;
  return bgTex[k];
}
function setRender(on) {
  S.render = on;
  scene.environment = on ? envTex : null;
  scene.background = on ? renderBackground(S.renderBg) : null;
  R.setClearColor(0x1d1e21);
  R.toneMapping = on ? T.ACESFilmicToneMapping : T.NoToneMapping;
  grid.visible = axesLines.visible = !on; ground.visible = on; sun.castShadow = on; hemi.intensity = on ? 0.4 : 1.3;
  if (on) {
    S.shading = 'solid'; applyShading();
    const b = boxOf(Object.keys(S.groups));
    if (!b.isEmpty()) {
      ground.position.z = b.min.z - 1e-3;
      const c = b.getCenter(new T.Vector3()), r = b.getSize(new T.Vector3()).length();
      sun.position.set(c.x + r, c.y - r * 0.8, c.z + r * 2); sun.target.position.copy(c);
      const sc = sun.shadow.camera; sc.left = sc.bottom = -r; sc.right = sc.top = r; sc.far = r * 6; sc.updateProjectionMatrix();
    }
  }
  refresh(); showHandles(); renderTop();
}

// follow changes made elsewhere (e.g. an AI agent over MCP)
setInterval(async () => {
  if (S.drag || S.modal || busy || document.hidden) return;
  try { const {version} = await get('/api/version'); if (version !== S.version) await load(); } catch { /* server restarting */ }
}, 1000);

// ------------------------------------------------------------------ start
S.cmds = Object.fromEntries((await get('/api/commands')).map(c => [c.id, c]));
resize(); renderTools(); applyShading();
await load();
const tick = () => { orbit.update(); drawNavGizmo(); updateViewLabel(); placeRulerLabels(); R.render(scene, cam); };
R.setAnimationLoop(tick);
window.nerikone = {S, get cam() { return cam; }, orbit, handles, setMode, setRender, setView, frame, run, tick}; // debugging / UI tests
