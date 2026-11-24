// Nerikone viewer: direct modeling on top of the command API (../kernel.py).
// Interaction: G R S modal transforms with X Y Z constraints and typed values,
// numpad views, F3 search; all shortcuts are remappable (keymap.js).
import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {icon, cmdIcon, ICONS, glyphFor} from './icons.js';
import * as KM from './keymap.js';
import {LANG, setLang, startTranslating} from './i18n.js';
import {sfx, soundOn, setSound, soundVolume, setVolume, dragStart, dragValue, dragStop} from './sound.js';

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
  const t = $('toast'); t.innerHTML = `${icon(err ? 'warn' : 'info')}<span>${esc(msg)}</span>`;
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show'); t.classList.toggle('err', !!err); // restart the entrance
  t.title = err ? 'クリックでコンソールを開く' : '';
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 5000 : Math.max(1800, msg.length * 90));
}
$('toast').onclick = () => { const t = $('toast'); t.classList.remove('show'); if (t.classList.contains('err')) openConsole(true); };

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
  toast(short, true); sfx('error');
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
    <button data-copy="${LOG.indexOf(e)}" data-tip="コピー">${icon('copy')}</button></div>`).join('') || '<div class="none">ログはまだありません</div>';
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
// snapping settings (kept in this browser). on: the master switch; grid: drawn points land on the grid; inc: dragged
// lengths, angles and factors move in steps. Holding Ctrl while moving turns snapping the other way for that moment.
const SNAP_KEY = 'nerikone.snap.v1';
const snapCfg = {on: true, grid: true, step: 0.5, inc: true, len: 0.1, angle: 15, factor: 0.1};
try { Object.assign(snapCfg, JSON.parse(localStorage.getItem(SNAP_KEY) || '{}')); } catch { /* defaults */ }
const saveSnap = () => { try { localStorage.setItem(SNAP_KEY, JSON.stringify(snapCfg)); } catch { /* session only */ } };
const snapOn = k => (S.snap.on && S.snap[k]) !== !!S.ctrlKey;
const roundTo = (v, st) => st > 0 ? Math.round(v / st) * st : v;
// the grid: fine lines every snap step, strong lines every 10 steps
const grid = new T.Group(); grid.rotation.x = Math.PI / 2; scene.add(grid);
function buildGrid() {
  grid.clear();
  const st = snapCfg.step, size = st * 100;
  const fine = new T.GridHelper(size, 100, 0x2c2e33, 0x2c2e33), major = new T.GridHelper(size, 10, 0x55585f, 0x45484e);
  fine.material.transparent = true; fine.material.opacity = 0.7; fine.position.y = -1e-4;
  grid.add(fine, major);
}
buildGrid();
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
// sketch regions: translucent blue, pulled towards the camera so they show on top of the face they were drawn on
M.region = new T.MeshBasicMaterial({color: 0x4fc3f7, transparent: true, opacity: 0.45, side: T.DoubleSide, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
M.regionHi = M.region.clone(); M.regionHi.color.set(0xf5a623); M.regionHi.opacity = 0.7;
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
S.snap = snapCfg;

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
      m.userData = {body: name, fi, planar: f.planar, normal: f.normal, mesh: b.kind === 'Mesh', region: b.kind === 'Sketch',
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
// The section view hides one side of a plane; what is hidden cannot be picked either. Without a face under the
// pointer, drawing and measuring land on the work plane (the ground unless another was set).
const notClipped = h => !S.section || S.section.plane.distanceToPoint(h.point) >= -1e-6;
const firstHit = objs => ray.intersectObjects(objs).filter(notClipped)[0];
const basePlane = () => S.workPlane ? new T.Plane().setFromNormalAndCoplanarPoint(S.workPlane.n, S.workPlane.o) : new T.Plane(new T.Vector3(0, 0, 1), 0);
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
  orbit.target.copy(c); cam.position.copy(c).addScaledVector(dir, r * 2.4);
  if (cam === ortho) { ortho.userData.dist = r * 2.4; ortho.zoom = 1; }
  ground.position.z = boxOf(Object.keys(S.groups)).min.z - 1e-3;
  fitOrtho(); orbit.update();
}

async function load() { applyState(await get('api/state')); }
function applyState(d) {
  S.doc = d.doc; S.version = d.version; if ('public' in d) S.public = d.public; if ('desktop' in d) S.desktop = d.desktop;
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
  renderPanels(); applySection(); autosave(); drawDims();
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
  S.navDrag = true;
  if (NAV_TOOLS[S.tool] !== undefined) setCursor(S.tool === 'pan' ? 'grab' : TOOL_CURSOR[S.tool], 'hot'); // the hand closes while panning
});
orbit.addEventListener('end', () => { S.navDrag = false; if (NAV_TOOLS[S.tool] !== undefined) applyToolCursor(); });
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
  const txt = `<b>${currentViewName()}</b><br>${cam === ortho ? '平行投影' : '透視投影'}`; void az; void el; void dist;
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
    m.material = u.region ? (isSelFace(u) || hov ? M.regionHi : M.region)
      : isSelFace(u) ? M.sel : hov ? M.hover : u.color ? colorMat(u.color) : u.mesh ? M.mesh : M.base;
    if (u.region) m.renderOrder = 2; // drawn after (in front of) the face it lies on
  }
  for (const l of S.edges) {
    const u = l.userData;
    l.visible = !S.render;
    const sel = S.sel.edges.some(e => e.body === u.body && e.ei === u.ei);
    l.material = sel ? M.edgeSel : h && h.kind === 'edge' && h.body === u.body && h.ei === u.ei ? M.edgeHover : M.edge;
  }
  const f = S.sel.faces.at(-1);
  gizmo.visible = false; // the pull arrow on a selected face is gone: pulling starts from the push/pull tool, not from the selection
  if (gizmo.visible) {
    const d = cam.position.distanceTo(V(f.point)) / (cam === ortho ? ortho.zoom : 1);
    gizmo.position.copy(V(f.point)); gizmo.setDirection(V(f.normal)); gizmo.setLength(d * 0.12, d * 0.025, d * 0.015);
  }
  renderCtx(); renderStatus();
}

// ------------------------------------------------------------------ picking
const ray = new T.Raycaster(), mouse = new T.Vector2();
function setRay(e) {
  if (e && 'ctrlKey' in e) S.ctrlKey = e.ctrlKey;
  const r = canvas.getBoundingClientRect();
  mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  scene.updateMatrixWorld();
  ray.setFromCamera(mouse, cam);
  const d = cam === ortho ? (ortho.userData.dist ?? 10) / ortho.zoom : cam.position.distanceTo(orbit.target);
  ray.params.Line.threshold = d * 0.012;
}
function pick() {
  if (S.mode === 'edge') {
    const h = firstHit(visibleEdges());
    return h && {kind: 'edge', body: h.object.userData.body, ei: h.object.userData.ei, mid: h.object.userData.mid, point: h.point};
  }
  const h = faceHit();
  if (!h) return null;
  const u = h.object.userData;
  if (S.mode === 'body') return {kind: 'body', body: u.body, point: h.point};
  const n = u.planar && u.normal ? V(u.normal) : h.face.normal.clone();
  return {kind: 'face', body: u.body, fi: u.fi, point: arr(h.point), normal: arr(n), mesh: u.mesh};
}
// nearest face hit; a sketch region lying on a solid's face wins over that face (they are at the same depth)
function faceHit() {
  const hits = ray.intersectObjects(visibleFaces()).filter(notClipped);
  if (!hits.length) return null;
  const eps = Math.max(1e-4, hits[0].distance * 1e-4);
  return hits.find(h => h.distance - hits[0].distance <= eps && h.object.userData.region) || hits[0];
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
  queued = {url, body, md: S.modal, v: S.modal?.value}; // remember which operation and value this is for: the modal may end before it runs
  if (busy) return;
  busy = true;
  (async () => {
    while (queued) {
      const q = queued; queued = null;
      const {md, v} = q;
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
    const d = await post('api/exec', {cmd, params});
    S.feature = d.feature.id; S.form = null; S.lastCmd = cmd;
    if (!keepSel) S.sel = {faces: [], edges: [], bodies: []};
    applyState(d);
    toast(`${TOOL_JA[cmd] || S.cmds[cmd]?.label || cmd} ✓`); sfx('commit');
    log('ok', `${S.cmds[cmd]?.label || cmd}  ${summarize(params)}`);
    return d;
  } catch (e) { reportError(e.message, S.cmds[cmd]?.label || cmd); await load(); }
}
async function updateFeature(id, params, extra = {}) {
  try { applyState(await post('api/feature', {id, params, ...extra})); }
  catch (e) { reportError(e.message, 'パラメータ変更'); await load(); }
}
function clearSel() { S.sel = {faces: [], edges: [], bodies: []}; refresh(); renderPanels(); }

// ------------------------------------------------------------------ modal operations (G R S E Ctrl+B ...)
// A modal follows the mouse, accepts typed numbers (and X/Y/Z for transforms), confirms with LMB/Enter and
// cancels with RMB/Esc. Direct drags on geometry use the same machinery and confirm on release.
function startModal(m) {
  S.modal = {typed: '', axis: null, ...m, x0: S.mouse?.x ?? 0, y0: S.mouse?.y ?? 0};
  if (m.icon) setCursor(m.icon, 'hot');
  orbit.enabled = false; gizmo.visible = false; dragStart();
  m.init?.(S.modal);
  updateModal(); renderStatus();
  return S.modal;
}
function modalValue(md) {
  let v = md.compute(md), typed = false;
  if (v != null && snapOn('inc')) { // dragged values move in steps: lengths, degrees, factors
    const st = md.snapKind === 'angle' ? S.snap.angle : md.snapKind === 'factor' ? S.snap.factor : S.snap.len;
    v = md.snapKind === 'factor' ? Math.max(st, roundTo(v, st)) : roundTo(v, st);
  }
  if (md.typed && md.typed !== '-' && md.typed !== '.') { const t = parseFloat(md.typed); if (isFinite(t)) { v = t; typed = true; } }
  md.clamped = false;
  if (md.range && v != null) { // never go where the kernel cannot build: hold the value at the limit
    const c = Math.min(md.range.max, Math.max(md.range.min, v));
    md.clamped = c !== v; v = c;
  }
  return {v, typed};
}
// The page keeps working while the server is away (e.g. restarting), but says so plainly instead of guessing.
function setOffline(on) {
  if (S.offline === on) return;
  const was = S.offline; S.offline = on;
  let b = $('offline');
  if (!b) { b = Object.assign(document.createElement('div'), {id: 'offline'}); document.body.append(b); }
  b.innerHTML = `${icon('warn')} サーバーに接続できません`;
  b.hidden = !on;
  if (!on && was) toast('サーバーに再接続しました'); // only after it was really away, not on the first poll
}
// Ask the kernel how far an operation can go before it fails (bisection on the server, ~0.2 s).
async function fetchLimit(cmd, params, param, hi, direction, iters) {
  // null: the kernel cannot build any value; undefined: we could not ask (no server), so nothing is concluded
  try { return (await post('api/limits', {cmd, params, param, lo: 0.001, hi, direction, iters})).max; }
  catch (e) { if (e instanceof TypeError) setOffline(true); return undefined; }
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
    jobs.push(fetchLimit('edge.fillet', g, 'radius', 1, null, 0).then(v => S.feas.key === key && (S.feas.fillet = v === undefined ? undefined : v != null)),
              fetchLimit('edge.chamfer', g, 'length', 1, null, 0).then(v => S.feas.key === key && (S.feas.chamfer = v === undefined ? undefined : v != null))); }
  if (s.faces.length) { const f = s.faces.at(-1);
    jobs.push(fetchLimit('body.shell', {body: f.body, open_at: f.point}, 'thickness', 1, null, 0).then(v => S.feas.key === key && (S.feas.shell = v === undefined ? undefined : v != null))); }
  Promise.all(jobs).then(() => { if (S.feas.key === key) { S.feas.pending = false; renderCtx(); } });
  return S.feas;
}
const diagOf = body => { const b = S.doc.bodies[body]?.bbox; return b ? Math.hypot(...b[1].map((x, i) => x - b[0][i])) : 10; };
function setRange(m, min, max) {
  if (Number.isNaN(min) || Number.isNaN(max)) { m.offline = S.offline; if (S.modal === m) updateModal(); return; }
  m.range = {min, max}; m.unbuildable = min === 0 && max === 0;
  if (S.modal === m) updateModal();
}
function updateModal() {
  const md = S.modal; if (!md) return;
  const {v, typed} = modalValue(md);
  if (v == null || !isFinite(v)) return;
  md.value = v; dragValue(md.kind === 'scale' ? (v - 1) * 2 : v, md.kind === 'rotate' ? 90 : md.kind === 'scale' ? 1 : 5);
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
  hud(S.offline ? `<span class="hud-err">${icon('warn')} サーバーに接続できません</span>` : md.unbuildable ? `<span class="hud-err">${icon('warn')} ${esc(md.unbuildableText || 'この形には適用できません')}</span>`
    : `${md.label}${ax} ${md.custom ?? (md.fmt ? md.fmt(v) : v.toFixed(3))}${md.clamped ? ' <span class="lim">上限</span>' : ''}${lim}${md.isTyped ? ` <span class="dim">[${esc(md.typed)}_]</span>` : ''}`);
}
async function endModal(ok) {
  const md = S.modal; if (!md) return;
  S.modal = null; dragStop(); orbit.enabled = true; hud(''); md.ghosts?.forEach(g => g.parent?.remove(g)); md.ghosts = null; if (md.kind === 'grab') S.plus = false; S.cursorKey = null; // push/pull keeps its + while the tool stays active axisGuide.visible = triad.visible = moveLine.visible = false;
  canvas.style.cursor = ''; S.cursorKey = null; applyToolCursor();
  if (ok && md.value != null) { await idle(); await md.finish(md, md.value); }
  else { md.cancel?.(md); await idle(); await load(); }
  renderStatus();
}
function modalKey(e) {
  const md = S.modal, k = e.key;
  if (k === 'Escape') return endModal(false);
  if (k === 'Enter' || k === 'NumpadEnter') return endModal(true);
  if (k === 'Alt' && e.repeat) return;
  if (k === 'Alt' && md.pp) { sfx('plus'); md.keep = !md.keep; e.preventDefault(); updateModal(); renderStatus(); setCursor(md.icon, 'hot'); return; } // Option during push/pull: keep the face or not
  if (k === 'Alt' && md.kind === 'grab') { md.copy = !md.copy; e.preventDefault(); md.onCopy?.(md); updateModal(); renderStatus(); setCursor(md.icon, 'hot'); return; } // Option during move: copy
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
  if (!names.length) return toast('ボディを選択');
  const p = pivotOf(names), ps = screenOf(p);
  const sign = a => Math.sign(AX[a].dot(cam.position.clone().sub(p))) || 1;
  const camDir = cam.getWorldDirection(new T.Vector3());
  const plane = new T.Plane().setFromNormalAndCoplanarPoint(camDir, p);
  const startHit = () => ray.ray.intersectPlane(plane, new T.Vector3());
  const md = {
    kind, axes: true, snapKind: {rotate: 'angle', scale: 'factor'}[kind], label: {grab: '移動', rotate: '回転', scale: '拡大縮小'}[kind], icon: {grab: 'move', rotate: 'rotate', scale: 'scale'}[kind],
    fmt: kind === 'rotate' ? v => `${v.toFixed(1)}°` : kind === 'scale' ? v => `×${v.toFixed(3)}` : v => v.toFixed(3),
    onCopy(m) { // copy: the originals stay put (ghosts), the moved ones are the copies
      m.ghosts?.forEach(g => g.parent?.remove(g)); m.ghosts = null;
      if (m.copy) m.ghosts = names.map(n => { const gh = S.groups[n].clone(); gh.matrixAutoUpdate = false; gh.matrix.identity(); gh.matrixWorldNeedsUpdate = true; gh.userData = {}; root.add(gh); return gh; }); },
    init(m) { if (S.plus) { m.copy = true; m.onCopy(m); } m.h0 = startHit(); m.a0 = Math.atan2(-(m.y0 - ps.y), m.x0 - ps.x); m.d0 = Math.hypot(m.x0 - ps.x, m.y0 - ps.y) || 1;
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
        m.label = m.copy ? '移動（コピー）' : '移動';
        let t;
        if (m.axis) t = AX[m.axis].clone().multiplyScalar(v);
        else if (m.typed) t = AX.X.clone().multiplyScalar(v);
        else { const h = startHit(); t = h && m.h0 ? h.sub(m.h0) : new T.Vector3(); if (snapOn('inc')) t.set(roundTo(t.x, S.snap.len), roundTo(t.y, S.snap.len), roundTo(t.z, S.snap.len)); }
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
      if (kind === 'grab' && m.copy) { // Option: copy the bodies to where they were moved
        const made = []; for (const n of names) { const d = await commit('body.duplicate', {body: n, offset: arr(m.t)}, {keepSel: true}); if (d) made.push(d.feature.params.name); }
        if (made.length) { S.mode = 'body'; S.sel = {faces: [], edges: [], bodies: made}; refresh(); renderPanels(); }
        return;
      }
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
function valueModal(label, build, {start = 0, scale = 1, limit, unbuildableText, icon} = {}) {
  const m = startModal({
    label, unbuildableText, icon, limitText: r => `最大 ${r.max.toFixed(3)}`,
    compute: m => start + ((S.mouse?.x ?? m.x0) - m.x0) * unitScale() * scale, // keyboard-only: the start value until the mouse moves
    apply: (m, v) => { if (m.unbuildable) return; const [cmd, params] = build(v); m.cmd = cmd; m.params = params; preview('api/exec', {cmd, params}); },
    finish: finishPreviewed,
  });
  if (limit) limit().then(max => max === undefined ? setRange(m, NaN, NaN) : setRange(m, max == null ? 0 : 0.001, max ?? 0));
}
const edgeGroup = () => { const b = S.sel.edges[0]?.body; return {body: b, edges: S.sel.edges.filter(x => x.body === b).map(x => x.mid)}; };
function filletModal(chamfer) {
  if (!S.sel.edges.length) return toast('エッジを選択');
  const g = edgeGroup(), [cmd, key] = chamfer ? ['edge.chamfer', 'length'] : ['edge.fillet', 'radius'];
  valueModal(chamfer ? '面取り' : 'フィレット', v => [cmd, {...g, [key]: +v.toFixed(4)}],
    {start: 0.05, icon: chamfer ? 'chamfer' : 'fillet', limit: () => fetchLimit(cmd, g, key, diagOf(g.body)), unbuildableText: `この辺には${chamfer ? '面取り' : 'フィレット'}をかけられません`});
}
function pushModal() {
  const f = S.sel.faces.at(-1);
  if (!f) return toast('面を選択');
  if (S.doc.bodies[f.body]?.kind === 'Sketch') return regionModal(f);
  const n = V(f.normal).normalize(), p0 = V(f.point);
  const m = startModal({
    label: '押し引き', icon: 'push', init: m => { m.t0 = closestOnAxis(p0, n) ?? 0; const a = dominantAxis(n);
      showAxisGuide(p0, Math.abs(n.dot(AX[a])) > 0.999 ? a : n, Math.abs(n.dot(AX[a])) > 0.999 ? AXHEX[a] : 0xf5a623); },
    compute: m => { const t = closestOnAxis(p0, n); return t == null ? 0 : t - m.t0; },
    apply: (m, v) => { if (Math.abs(v) < 1e-4) { m.cmd = null; return; } m.cmd = 'face.move'; m.params = {body: f.body, at: f.point, by: arr(n.clone().multiplyScalar(v))}; preview('api/exec', {cmd: 'face.move', params: m.params}); },
    finish: finishPreviewed, limitText: r => `${(-r.min).toFixed(2)} 〜 ${r.max.toFixed(2)}`,
  });
  const base = {body: f.body, at: f.point}, d = diagOf(f.body), nn = arr(n);
  Promise.all([fetchLimit('face.move', base, 'by', d * 3, nn), fetchLimit('face.move', base, 'by', d, nn.map(x => -x))])
    .then(([out, inn]) => setRange(m, inn === undefined ? NaN : -(inn ?? 0), out === undefined ? NaN : out ?? 0));
  return m;
}
// Move one straight edge: its two faces tilt to follow (a line across a box top, raised, becomes a roof ridge).
// Free in the view plane, or along X / Y / Z (pressed during the move); the kernel's limit keeps it buildable.
function edgeMoveModal(ed) {
  const p = V(ed.mid), camDir = cam.getWorldDirection(new T.Vector3());
  const plane = new T.Plane().setFromNormalAndCoplanarPoint(camDir, p), hit = () => ray.ray.intersectPlane(plane, new T.Vector3());
  const base = {body: ed.body, at: ed.mid};
  const m = startModal({
    label: 'エッジを移動', icon: 'move', axes: true,
    init(m) { m.h0 = hit(); showTriad(p, null); },
    onAxis(m) {
      showAxisGuide(p, m.axis); showTriad(p, m.axis); m.range = null; m.unbuildable = false;
      if (!m.axis) return;
      m.t0 = closestOnAxis(p, AX[m.axis]) ?? 0;
      const d = diagOf(ed.body) * 3, dir = arr(AX[m.axis]);
      Promise.all([fetchLimit('edge.move', base, 'by', d, dir), fetchLimit('edge.move', base, 'by', d, dir.map(x => -x))])
        .then(([out, inn]) => { if (S.modal === m && m.axis) setRange(m, inn === undefined ? NaN : -(inn ?? 0), out === undefined ? NaN : out ?? 0); });
    },
    compute(m) { if (!m.axis) return 0; const t = closestOnAxis(p, AX[m.axis]); return t == null ? 0 : t - (m.t0 ?? 0); },
    apply(m, v) {
      let t;
      if (m.axis) t = AX[m.axis].clone().multiplyScalar(v);
      else if (m.typed) t = AX.Z.clone().multiplyScalar(v); // a typed number with no axis: up
      else { const h = hit(); t = h && m.h0 ? h.sub(m.h0) : new T.Vector3(); if (snapOn('inc')) t.set(roundTo(t.x, S.snap.len), roundTo(t.y, S.snap.len), roundTo(t.z, S.snap.len)); }
      showTriad(p.clone().add(t), m.axis); showMoveLine(p, p.clone().add(t));
      if (t.length() < 1e-4) { m.cmd = null; return; }
      m.cmd = 'edge.move'; m.params = {...base, by: arr(t)}; preview('api/exec', {cmd: m.cmd, params: m.params});
      if (!m.axis && !m.typed) return arr(t).map(x => x.toFixed(2)).join(', ');
    },
    finish: finishPreviewed, limitText: r => `${(-r.min).toFixed(2)} 〜 ${r.max.toFixed(2)}`,
  });
  return m;
}
function shellModal() {
  const f = S.sel.faces.at(-1);
  if (!f) return toast('開ける面を選択');
  const p = {body: f.body, open_at: f.point};
  valueModal('シェル厚', v => ['body.shell', {...p, thickness: +v.toFixed(4)}],
    {start: 0.1, icon: 'shell', limit: () => fetchLimit('body.shell', p, 'thickness', diagOf(f.body)), unbuildableText: 'このボディはシェルにできません'});
}

// ------------------------------------------------------------------ pointer
addEventListener('pointermove', e => { S.mouse = {x: e.clientX, y: e.clientY}; });
function altChanged() { // redraw the cursor when the + toggles
  S.cursorKey = null;
  if (S.modal) { if (S.modal.icon) setCursor(S.modal.icon, 'hot'); }
  else if (S.tool === 'pushpull') ppHover();
}
// Option is a toggle (like SketchUp): tap it to switch + on or off. Before the click it sets what the operation starts with; once one
// is running (push/pull, move) a tap flips it for that operation. A finished operation or another tool switches it off again.
addEventListener('keydown', e => {
  if (e.key !== 'Alt' || e.repeat || S.modal || S.tool !== 'pushpull') return;
  S.plus = !S.plus; e.preventDefault(); altChanged(); renderStatus(); sfx('plus');
});
for (const t of ['keydown', 'keyup']) addEventListener(t, e => { // Ctrl flips snapping while it is held
  if (e.key !== 'Control' || S.ctrlKey === (t === 'keydown')) return;
  S.ctrlKey = t === 'keydown';
  if (S.modal) updateModal();
  else if (S.mouse && S.tool) canvas.dispatchEvent(new PointerEvent('pointermove', {clientX: S.mouse.x, clientY: S.mouse.y, ctrlKey: S.ctrlKey, bubbles: true}));
});
canvas.addEventListener('pointerdown', e => {
  setRay(e);
  if (S.modal) { // LMB confirms, RMB cancels
    e.preventDefault(); e.stopImmediatePropagation();
    // push/pull: a second click right after the first (a double-click) repeats the last distance
    if (S.modal.pp && e.button === 0 && performance.now() - S.modal.started < 400 && S.ppLast != null) {
      S.modal.typed = String(+S.ppLast.toFixed(5)); updateModal();
    }
    endModal(e.button === 0); return;
  }
  if (NAV_TOOLS[S.tool] !== undefined) return; // orbit / pan / zoom tool: the view controls handle the drag
  if (S.tool === 'pushpull' && e.button === 0) { e.stopImmediatePropagation(); ppClick(e); return; }
  if (S.tool === 'ruler' && e.button === 0) { e.stopImmediatePropagation(); rulerClick(e); return; }
  if (S.tool === 'dim' && e.button === 0) { e.stopImmediatePropagation(); dimClick(e); return; }
  if (SK_TOOLS.includes(S.tool) && e.button === 0) { e.stopImmediatePropagation(); sketchClick(e); return; }
  if (e.button === 2) { S.rdown = {x: e.clientX, y: e.clientY}; return; }
  if (e.button !== 0) return;
  const hd = pickHandle();
  if (hd) { e.stopImmediatePropagation(); startHandleDrag(e, hd); return; }
  const h = pick();
  if (!h || e.altKey) { S.downEmpty = {x: e.clientX, y: e.clientY}; return; } // Alt+LMB / empty: orbit
  e.stopImmediatePropagation(); // geometry: never start an orbit
  S.drag = {h, x0: e.clientX, y0: e.clientY, moved: false, shift: e.shiftKey};
}, {capture: true});

const DRAG_EDIT = false; // true: a drag on a face / edge in the select tool starts push/pull / fillet
addEventListener('pointermove', e => {
  setRay(e);
  if (S.modal) { updateModal(); return; }
  if (S.tool === 'ruler' && !S.drag) { if (e.target === canvas) rulerHover(e); return; }
  if (S.tool === 'dim' && !S.drag) { if (e.target === canvas) dimHover(e); return; }
  if (S.tool === 'pushpull' && !S.drag) { if (e.target === canvas) ppHover(); return; }
  if (SK_TOOLS.includes(S.tool) && !S.drag) { if (e.target === canvas) sketchHover(e); return; }
  const d = S.drag;
  if (!d) {
    if (e.target !== canvas) return;
    const h = pickHandle() ? null : pick();
    const key = h && (h.kind + h.body + (h.fi ?? '') + (h.ei ?? ''));
    if (key !== S.hoverKey) { S.hover = h; S.hoverKey = key; if (h) sfx('hover'); refresh(); }
    if (S.tool) { if (!S.navDrag) applyToolCursor(); } else canvas.style.cursor = pickHandle() || h ? 'pointer' : '';
    return;
  }
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
  if (!d.moved) {
    d.moved = true;
    if (d.handle) return;
    // Dragging a face or an edge used to start a push/pull or a fillet by itself; operations now start only from a tool or a key
    if (!DRAG_EDIT) return;
    const h = d.h;
    if (h.kind === 'face' && !h.mesh) { S.sel.faces = [h]; S.sel.edges = []; S.sel.bodies = []; S.mouse = {x: d.x0, y: d.y0}; setRay(e); pushModal(); }
    else if (h.kind === 'edge') {
      if (!S.sel.edges.some(x => x.body === h.body && x.ei === h.ei)) { S.sel.edges = [h]; }
      const g = edgeGroup();
      S.mouse = {x: d.x0, y: d.y0};
      const em = startModal({label: 'フィレット', icon: 'fillet', compute: m => (S.mouse.x - m.x0) * unitScale(),
        limitText: r => `面取り 最大 ${(-r.min).toFixed(3)} · フィレット 最大 ${r.max.toFixed(3)}`, unbuildableText: 'この辺にはフィレットも面取りもかけられません',
        apply: (m, v) => { if (m.unbuildable || Math.abs(v) < 1e-4) { m.cmd = null; return; } const ch = v < 0; m.label = ch ? '面取り' : 'フィレット'; const a = Math.max(Math.abs(v), 0.001);
          [m.cmd, m.params] = ch ? ['edge.chamfer', {...g, length: +a.toFixed(4)}] : ['edge.fillet', {...g, radius: +a.toFixed(4)}];
          preview('api/exec', {cmd: m.cmd, params: m.params}); },
        finish: finishPreviewed});
      Promise.all([fetchLimit('edge.fillet', g, 'radius', diagOf(g.body)), fetchLimit('edge.chamfer', g, 'length', diagOf(g.body))])
        .then(([fil, cha]) => setRange(em, cha === undefined ? NaN : -(cha ?? 0), fil === undefined ? NaN : fil ?? 0));
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
  const sel = S.sel; sfx('click');
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
  preview('api/feature', {id: d.feature.id, params: {grid: d.grid}});
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
A('transform.grab', '移動 (G)', '変形', () => S.sel.edges.length === 1 && !S.sel.faces.length && !S.sel.bodies.length ? edgeMoveModal(S.sel.edges[0])
  : (S.sel.faces.length && !S.sel.bodies.length) ? pushModal() : transformModal('grab'));
A('transform.rotate', '回転 (R)', '変形', () => transformModal('rotate'));
A('transform.scale', '拡大縮小 (S)', '変形', () => transformModal('scale'));
A('edit.extrude', '面を動かす', '編集', pushModal);
const blocked = k => { const f = S.feas; if (f && !f.pending && f[k] === false) { toast(k === 'shell' ? 'このボディはシェルにできません' : 'この辺にはかけられません'); return true; } return false; };
A('edit.fillet', 'フィレット', '編集', () => blocked('fillet') || filletModal(false));
A('edit.chamfer', '面取り', '編集', () => blocked('chamfer') || filletModal(true));
A('edit.shell', 'シェル', '編集', () => blocked('shell') || shellModal());
A('edit.duplicate', '複製', '編集', async () => {
  const names = selBodies(); if (!names.length) return toast('ボディを選択');
  const made = [];
  for (const n of names) { const d = await commit('body.duplicate', {body: n}, {keepSel: true}); if (d) made.push(d.feature.params.name); }
  S.mode = 'body'; S.sel = {faces: [], edges: [], bodies: made}; refresh(); transformModal('grab');
});
A('edit.delete', '削除', '編集', async e => {
  if (e?.code === 'KeyX' && (S.tool || S.modal)) return; // X is an axis key inside tools and operations, never a delete there
  if (S.sel.bodies.length) { for (const b of [...S.sel.bodies]) await commit('body.delete', {body: b}); return; }
  if (S.sel.faces.length || S.sel.edges.length) return deleteMenu(); // like other 3D tools: ask what to delete
  if (S.feature) updateFeature(S.feature, null, {delete: true});
});
function deleteMenu() {
  const bodies = selBodies(), faces = [...S.sel.faces];
  const items = [{icon: 'trash', label: bodies.length > 1 ? `ボディを削除（${bodies.length} 個）` : `ボディを削除（${bodies[0]}）`,
    run: async () => { for (const b of bodies) await commit('body.delete', {body: b}); }}];
  if (faces.length && faces.every(f => S.doc.bodies[f.body]?.kind === 'Part')) {
    const byBody = {}; for (const f of faces) (byBody[f.body] ||= []).push(f.point);
    items.push({icon: 'close', label: `面を削除して周りでふさぐ（${faces.length} 面）`,
      run: async () => { for (const [b, pts] of Object.entries(byBody)) await commit('face.delete', {body: b, faces: pts}); }});
  }
  showMenu(S.mouse?.x ?? innerWidth / 2, S.mouse?.y ?? innerHeight / 2, [{header: '削除'}, ...items]);
}
for (const [k, l] of [['union', '結合'], ['cut', '切り抜き'], ['intersect', '交差']])
  A('bool.' + k, `ブーリアン: ${l}`, '編集', () => {
    if (S.sel.bodies.length < 2) return toast('ボディを 2 つ以上選択');
    commit('body.boolean', {kind: k, target: S.sel.bodies[0], tools: S.sel.bodies.slice(1)});
  });
for (const v of Object.keys(VIEWS)) A('view.' + v, `視点: ${VIEW_NAMES[v]}`, '表示', () => setView(v));
A('view.ortho', '透視 / 平行投影', '表示', () => { S.autoPersp = false; setCamera(cam === persp ? ortho : persp); });
A('view.frame', '選択にフレーム', '表示', () => frame(selBodies()));
A('view.shading', 'シェーディング切替', '表示', () => { setRender(false); S.shading = SHADING[(SHADING.indexOf(S.shading) + 1) % 3]; applyShading(); refresh(); renderTop(); });
A('view.render', 'レンダー表示', '表示', () => setRender(!S.render));
A('hide.selected', '選択を隠す', '表示', () => { for (const n of selBodies()) S.hidden.add(n); clearSel(); buildVis(); });
A('hide.unhide', 'すべて表示', '表示', () => { S.hidden.clear(); buildVis(); });
A('panel.toolbar', 'ツール表示', '表示', () => { document.body.classList.toggle('no-tools'); savePanes(); });
// The right column stacks three panels (items / info / history). A click on a title folds one away; the panel buttons
// open or fold that panel. Which are folded, their heights and the column's width are remembered.
const RPANES = {side: 'side', insp: 'inspector', hist: 'histpane'}, RKEY = 'nerikone.rcol.v1';
const rstate = (() => { try { return JSON.parse(localStorage.getItem(RKEY)) || {}; } catch { return {}; } })();
rstate.shut = rstate.shut || ['hist']; rstate.h = rstate.h || {}; rstate.w = rstate.w || 276;
const rsave = () => { try { localStorage.setItem(RKEY, JSON.stringify(rstate)); } catch { /* session only */ } };
function rapply() {
  document.body.style.setProperty('--inw', rstate.w + 'px');
  for (const [k, id] of Object.entries(RPANES)) {
    const el = document.getElementById(id); if (!el) continue;
    el.classList.toggle('shut', rstate.shut.includes(k));
    el.style.flexGrow = rstate.h[k] || 1;
  }
}
function showTab(t, toggle) { // open the panel (or, from a button, fold it when it is already open)
  const hidden = document.body.classList.contains('no-rcol'), open = !hidden && !rstate.shut.includes(t);
  document.body.classList.remove('no-rcol');
  rstate.shut = rstate.shut.filter(x => x !== t);
  if (toggle && open) rstate.shut.push(t);
  rsave(); savePanes(); rapply(); renderTop();
}
const tabShown = t => !document.body.classList.contains('no-rcol') && !rstate.shut.includes(t);
A('sound.toggle', '効果音', '表示', () => { setSound(!soundOn()); if (soundOn()) sfx('toggle'); });
A('panel.column', '右パネル表示', '表示', () => { document.body.classList.toggle('no-rcol'); rsave(); savePanes(); renderTop(); });
A('panel.inspector', '情報パネル表示', '表示', () => showTab('insp', true));
A('panel.side', 'アイテム表示', '表示', () => showTab('side', true));
A('panel.history', '履歴パネル表示', '表示', () => showTab('hist', true));
A('history.undo', '元に戻す', '履歴', async () => { applyState(await post('api/undo')); sfx('undo'); });
A('history.redo', 'やり直し', '履歴', async () => { applyState(await post('api/redo')); sfx('redo'); });
A('command.repeat', '直前のコマンドを繰り返す', '履歴', () => { if (S.lastCmd) openForm(S.lastCmd); });
A('command.palette', 'コマンド検索', 'アプリ', openPalette);
A('file.new', '新規', 'ファイル', async () => { if (confirm('新しいドキュメントを作りますか？（取り消しで戻せます）')) { S.framed = false; S.feature = null; applyState(await post('api/new')); } });
A('file.open', '開く / 読み込み', 'ファイル', () => $('file').click());
A('file.import', '読み込み (STEP / STL / WRL)', 'ファイル', () => $('file').click());
A('file.save', '保存 (.nrk)', 'ファイル', () => download('nrk'));
A('file.export', '書き出し…', 'ファイル', e => exportMenu(e));
A('help.keymap', 'ショートカット一覧と変更', 'アプリ', openKeymap);
const run = (id, e) => { const a = KM.allActions().find(x => x.id === id); if (a) a.run(e); };

function setMode(m) { S.mode = m; S.form = null; clearSel(); renderTop(); }
function buildVis() { for (const [n, g] of Object.entries(S.groups)) g.visible = !S.hidden.has(n); renderPanels(); drawDims(); }

addEventListener('keydown', e => {
  if (S.capture) return; // keymap editor is recording
  if (e.target.matches?.('input,textarea,select')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (!$('modal').hidden) { if (e.key === 'Escape') { $('modal').hidden = true; renderPanels(); } return; }
  if (!$('palette').hidden) return;
  if (S.modal) return modalKey(e);
  if (SK_TOOLS.includes(S.tool) && sketchKey(e)) return;
  if ((S.tool === 'pushpull' || NAV_TOOLS[S.tool] !== undefined) && e.key === 'Escape') { e.preventDefault(); setTool(null); return; }
  if (S.tool === 'ruler' && (e.key === 'Delete' || e.key === 'Backspace') && S.rulers.length) { e.preventDefault(); deleteRuler(S.rulers.length - 1); return; }
  if (S.tool === 'dim' && dimKey(e)) return;
  if (S.tool === 'ruler' && e.key === 'Escape') { e.preventDefault(); if (S.rulerA) { S.rulerA = null; rulerPreview(null); } else setTool(null); return; }
  const combo = KM.comboOf(e); if (!combo) return;
  const a = KM.lookup(combo);
  if (a) { e.preventDefault(); closeMenus(); a.run(e); }
});

// ------------------------------------------------------------------ top bar, tools, panels
const btn = (id, ic, title, extra = '') => `<button data-act="${id}" data-tip="${esc(title)}" data-key="${esc(KM.shortcutOf(id))}" aria-label="${esc(title)}" ${extra}>${icon(ic)}</button>`;
function renderTop() {
  const on = c => c ? 'class="on"' : '';
  // leading: sidebar, the document (its name opens the document menu), history
  $('leadbar').innerHTML = `<button id="doctitle" data-tip="ドキュメント">${icon('doc')}<span class="name">${esc(S.docName && S.docName !== 'nerikone' ? S.docName : '名称未設定')}</span>${icon('chevron-down')}</button>` +
    '<span class="sep"></span>' + btn('history.undo', 'undo', '元に戻す', S.doc.can_undo ? '' : 'disabled') + btn('history.redo', 'redo', 'やり直し', S.doc.can_redo ? '' : 'disabled');
  // centre: add, what a click selects, how the model is shown
  $('modebar').innerHTML = `<button id="addbtn" data-act="add.menu" data-tip="形を追加" data-key="${esc(KM.shortcutOf('add.menu'))}">${icon('add')}<span>追加</span></button>` +
    `<div class="seg">${btn('mode.edge', 'sel-edge', 'エッジ', on(S.mode === 'edge'))}${btn('mode.face', 'sel-face', '面', on(S.mode === 'face'))}${btn('mode.body', 'sel-body', 'ボディ', on(S.mode === 'body'))}</div>` +
    `<div class="seg">${SHADING.map(s => `<button data-shade="${s}" data-tip="${{solid: 'ソリッド', wire: 'ワイヤー', xray: 'X 線'}[s]}" data-key="${esc(KM.shortcutOf('view.shading'))}" ${on(!S.render && S.shading === s)}>${icon(s)}</button>`).join('')}${btn('view.render', 'render', 'レンダー', on(S.render))}</div>` +
    (S.render ? `<select id="material" style="width:auto">${['auto', 'clay', 'plastic', 'metal', 'glass'].map(m => `<option value="${m}" ${m === S.material ? 'selected' : ''}>${{auto: 'ボディごとの素材', clay: 'すべてクレイ', plastic: 'すべてプラスチック', metal: 'すべて金属', glass: 'すべてガラス'}[m]}</option>`).join('')}</select><select id="renderbg" style="width:auto">${Object.keys(BG).map(k => `<option value="${k}" ${k === S.renderBg ? 'selected' : ''}>${BG_JA[k]}</option>`).join('')}</select><button id="shot" data-tip="画像を保存">${icon('camera')}</button>` : '') +
    `<button id="snapmenu" class="menu ${S.snap.on ? 'on' : ''}" data-tip="スナップ" data-key="${esc(KM.shortcutOf('snap.toggle'))}">${icon('magnet')}<span>${S.snap.on ? (S.snap.grid ? S.snap.step : '入') : '切'}</span>${icon('chevron-down')}</button>` +
    `<div class="seg" id="axseg">${['X', 'Y', 'Z'].map(ax => `<button data-axbtn="${ax}" style="color:var(--${ax.toLowerCase()});font-weight:600" data-tip="${ax} 軸に固定（もう一度で解除）" data-key="${ax}">${ax}</button>`).join('')}</div>` +
    `<button id="viewmenu" class="menu" data-tip="表示">${icon('view')}<span>表示</span>${icon('chevron-down')}</button>`;
  // trailing: search, language, inspector
  $('appbar').innerHTML = btn('command.palette', 'search', 'コマンド検索') +
    `<button id="langbtn" data-tip="${LANG === 'en' ? '日本語に切り替え' : 'Switch to English'}">${icon('language')}<span class="lang">${LANG === 'en' ? 'EN' : 'JA'}</span></button>` +
    btn('panel.column', 'inspector', '右パネル', on(!document.body.classList.contains('no-rcol')));
  $('langbtn').onclick = () => setLang(LANG === 'en' ? 'ja' : 'en');
  updateAxisChips();
  $('doctitle').onclick = e => docMenu(e);
  $('viewmenu').onclick = e => viewMenu(e);
  $('snapmenu').onclick = e => snapMenu(e);
  document.querySelectorAll('[data-shade]').forEach(b => b.onclick = () => { setRender(false); S.shading = b.dataset.shade; applyShading(); refresh(); renderTop(); });
  if ($('material')) $('material').onchange = e => { S.material = e.target.value; refresh(); };
  if ($('renderbg')) $('renderbg').onchange = e => { S.renderBg = e.target.value; try { localStorage.setItem('nerikone.renderBg', S.renderBg); } catch {} scene.background = renderBackground(S.renderBg); };
  if ($('shot')) $('shot').onclick = () => { R.render(scene, cam); canvas.toBlob(b => saveFile((S.docName || 'nerikone') + '.png', b), 'image/png'); };
}
function snapMenu(e) {
  const [x, y] = below(e), sn = S.snap, chk = b => b ? 'check' : 'blank';
  const set = (k, v) => () => { sn[k] = v; saveSnap(); if (k === 'step') buildGrid(); renderTop(); S.inspKey = null; renderInspector(); };
  showMenu(x, y, [
    {icon: chk(sn.on), label: 'スナップ', key: KM.shortcutOf('snap.toggle'), run: set('on', !sn.on)},
    null, {header: 'グリッド'},
    {icon: chk(sn.grid), label: 'グリッドに合わせる', run: set('grid', !sn.grid)},
    ...SNAP_STEPS.map(v => ({icon: chk(sn.step === v), label: `グリッド間隔 ${v} ${S.doc.units || 'mm'}`, run: set('step', v)})),
    null, {header: '刻み'},
    {icon: chk(sn.inc), label: '刻みで動かす', run: set('inc', !sn.inc)},
    ...SNAP_LENS.map(v => ({icon: chk(sn.len === v), label: `長さ ${v} ${S.doc.units || 'mm'}`, run: set('len', v)})),
    ...SNAP_ANGLES.map(v => ({icon: chk(sn.angle === v), label: `角度 ${v}°`, run: set('angle', v)})),
  ]);
}
const SNAP_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10], SNAP_LENS = [0.01, 0.05, 0.1, 0.5, 1], SNAP_ANGLES = [1, 5, 15, 45];
A('snap.toggle', 'スナップの入 / 切', '表示', () => { S.snap.on = !S.snap.on; saveSnap(); renderTop(); S.inspKey = null; renderInspector(); toast(S.snap.on ? 'スナップ: 入' : 'スナップ: 切'); });
const below = e => { const r = (e?.currentTarget || e?.target?.closest?.('button') || $('top')).getBoundingClientRect(); return [r.left, r.bottom + 4]; };
function docMenu(e) {
  const [x, y] = below(e), u = S.doc.units || 'mm', K = id => KM.shortcutOf(id);
  showMenu(x, y, [
    {icon: 'new', label: '新規', key: K('file.new'), run: () => run('file.new')},
    {icon: 'open', label: '開く…', key: K('file.open'), run: () => run('file.open')},
    {icon: 'save', label: '保存', key: K('file.save'), run: () => run('file.save')},
    {icon: 'save', label: '名前を付けて保存…', key: K('file.saveas'), run: () => run('file.saveas')},
    null,
    {icon: 'import', label: '読み込み (STEP / STL / WRL)…', key: K('file.import'), run: () => run('file.import')},
    {icon: 'export', label: '書き出し…', key: K('file.export'), run: () => exportMenu({target: $('doctitle')})},
    ...(savedCopy() ? [{icon: 'restore', label: '自動保存から復元', run: () => run('file.restore')}] : []),
    null, {header: `単位（今: ${u}）`},
    ...[['mm', 'ミリメートル'], ['cm', 'センチメートル'], ['m', 'メートル'], ['in', 'インチ']].map(([k, l]) => ({icon: k === u ? 'check' : 'blank', label: `${l} (${k})`, run: () => setUnits(k)})),
    null,
    {icon: 'keyboard', label: 'ショートカット一覧と変更', key: K('help.keymap'), run: () => run('help.keymap')},
  ]);
}
async function setUnits(u) { try { const d = await post('api/settings', {units: u}); S.doc = d.doc; S.version = d.version; renderPanels(); } catch (err) { reportError(err.message, '単位'); } }
function viewMenu(e) {
  const [x, y] = below(e), K = id => KM.shortcutOf(id), has = c => !document.body.classList.contains(c);
  showMenu(x, y, [
    {header: '視点'}, ...['front', 'back', 'right', 'left', 'top', 'bottom', 'iso'].map(v => ({icon: v === 'iso' ? 'box' : 'camera', label: VIEW_NAMES[v], key: K('view.' + v), run: () => setView(v)})),
    {icon: 'perspective', label: cam === persp ? '平行投影にする' : '透視投影にする', key: K('view.ortho'), run: () => run('view.ortho')},
    {icon: 'fit', label: '全体を表示（フレーム）', key: K('view.frame'), run: () => frame(selBodies())},
    null,
    {icon: S.section ? 'check' : 'section', label: '断面表示', key: K('view.section'), run: () => run('view.section')},
    {icon: S.workPlane ? 'check' : 'workplane', label: '作業平面を設定…', run: () => run('plane.set')},
    ...(S.workPlane ? [{icon: 'blank', label: '作業平面を地面に戻す', run: () => run('plane.clear')}] : []),
    {icon: 'eye', label: 'すべて表示', key: K('hide.unhide'), run: () => run('hide.unhide')},
    {icon: soundOn() ? 'check' : 'blank', label: '効果音', run: () => run('sound.toggle')},
    null, {header: 'パネル'},
    {icon: tabShown('side') ? 'check' : 'blank', label: 'アイテム', key: K('panel.side'), run: () => run('panel.side')},
    {icon: tabShown('insp') ? 'check' : 'blank', label: '情報', key: K('panel.inspector'), run: () => run('panel.inspector')},
    {icon: tabShown('hist') ? 'check' : 'blank', label: '履歴', run: () => run('panel.history')},
    {icon: has('no-tools') ? 'check' : 'blank', label: 'ツール', key: K('panel.toolbar'), run: () => run('panel.toolbar')},
    {icon: $('console').hidden ? 'blank' : 'check', label: 'コンソール', key: K('panel.console'), run: () => run('panel.console')},
  ]);
}
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) run(b.dataset.act, e); });
// interface sounds: a tick when the pointer enters a button, a pop when one is pressed
let hoverBtn = null;
document.addEventListener('mouseover', e => {
  const b = e.target.closest?.('button, .orow, .mi, .chip'); if (b === hoverBtn) return; hoverBtn = b;
  if (b && !b.disabled) sfx('hover');
});
document.addEventListener('pointerdown', e => { const b = e.target.closest?.('button, .orow, .mi, .chip'); if (b && !b.disabled && e.button === 0) sfx('click'); }, true);

// Tool strip, two columns, in the order work usually goes: draw, push/pull it into a solid, refine, arrange, combine,
// check; the view tools last. Commands that need a selection look dimmed until there is one (they stay clickable and
// say what to select).
const TOOL_GROUPS = [
  [['tool.select', 'select', '選択', 'tool', null], ['add.menu', 'add', '形を追加']],
  [['sketch.line', 'pencil', 'ライン', 'tool', 'line'], ['sketch.rect', 'rectangle', '矩形', 'tool', 'rect'],
    ['sketch.circle', 'circle', '円', 'tool', 'circle'], ['sketch.poly', 'polygon', '多角形', 'tool', 'poly']],
  [['tool.pushpull', 'push', 'プッシュ/プル', 'tool', 'pushpull'], ['sketch.offset', 'offset', 'オフセット', 'face1'],
    ['edit.fillet', 'fillet', 'フィレット', 'edge'], ['edit.chamfer', 'chamfer', '面取り', 'edge'],
    ['edit.shell', 'shell', 'シェル', 'face'], ['edit.extrude', 'facemove', '面を動かす', 'face']],
  [['transform.grab', 'move', '移動', 'move'], ['transform.rotate', 'rotate', '回転', 'body'],
    ['transform.scale', 'scale', '拡大縮小', 'body'], ['edit.duplicate', 'duplicate', '複製', 'body'],
    ['edit.mirror', 'mirror', 'ミラー', 'body'], ['edit.pattern', 'pattern', '配列複写', 'body']],
  [['bool.union', 'union', '結合', 'two'], ['bool.cut', 'cut', '切り抜き', 'two'],
    ['bool.intersect', 'intersect', '交差', 'two'], ['edit.split', 'split', '平面で分割', 'body']],
  [['tool.ruler', 'ruler', 'ルーラー', 'tool', 'ruler'], ['tool.dim', 'dimension', '寸法', 'tool', 'dim'], ['measure.info', 'measure', '計測'],
    ['view.section', 'section', '断面表示', 'toggle', 'section'], ['plane.set', 'workplane', '作業平面', 'toggle', 'workplane'], ['view.frame', 'fit', 'フレーム']],
  [['tool.orbit', 'orbit', 'オービット', 'tool', 'orbit'], ['tool.pan', 'pan', 'パン', 'tool', 'pan'],
    ['tool.zoom', 'zoom', 'ズーム', 'tool', 'zoom'], ['view.iso', 'box', 'アイソメ']],
];
function renderTools() {
  const s = S.sel, bodies = selBodies().length, f1 = s.faces.length === 1 && (s.faces[0].normal || S.doc.bodies[s.faces[0].body]?.kind === 'Sketch');
  const ready = {move: bodies > 0 || s.edges.length === 1, body: bodies > 0, two: s.bodies.length >= 2, face: s.faces.length > 0, face1: f1, edge: s.edges.length > 0};
  const html = TOOL_GROUPS.map(g => g.map(([id, ic, label, kind, arg]) => {
    const on = kind === 'tool' ? (S.tool ?? null) === arg : kind === 'toggle' ? !!(arg === 'section' ? S.section : S.workPlane) : false;
    const idle = kind in ready && !ready[kind];
    return btn(id, ic, label, `class="${on ? 'on' : ''} ${idle ? 'idle' : ''}"`);
  }).join('')).join('<span class="sep"></span>');
  if (html !== S.toolsHtml) { $('toolsbody').innerHTML = html; S.toolsHtml = html; }
  renderTop();
}
A('tool.select', '選択', 'ツール', () => setTool(null));
// Add menu (A / Shift+A, or the + button). From the keyboard, the new body is placed
// on the ground (z = 0) under the mouse; from the button, next to the existing bodies.
const ADD_ITEMS = [{header: '基本形状'}, 'body.box', 'body.cylinder', 'body.sphere', 'body.cone', 'body.torus', 'sketch.extrude',
  {header: 'NURBS'}, 'nurbs.surface', 'nurbs.loft', 'nurbs.revolve', 'nurbs.sweep'];
function addMenu(e) {
  const fromKey = e?.type === 'keydown', r = canvas.getBoundingClientRect();
  const atMouse = fromKey && S.mouse && S.mouse.x > r.left && S.mouse.x < r.right && S.mouse.y > r.top && S.mouse.y < r.bottom;
  let x, y, ground = null;
  if (atMouse) {
    x = S.mouse.x; y = S.mouse.y;
    setRay({clientX: x, clientY: y});
    ground = ray.ray.intersectPlane(new T.Plane(new T.Vector3(0, 0, 1), 0), new T.Vector3());
  } else { const b = (e?.target?.closest?.('button') || $('addbtn') || $('tools')).getBoundingClientRect(); [x, y] = b.top < 60 ? [b.left, b.bottom + 4] : [b.right + 6, b.top]; }
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
  if (s.faces.length) out.push(['edit.extrude', 'facemove', '面を動かす'], may('edit.shell', 'shell', 'シェル', fz.shell, 'このボディには不可'));
  if (s.edges.length === 1 && !s.faces.length && !s.bodies.length) out.push(['transform.grab', 'move', 'エッジを動かす']);
  if (s.edges.length) out.push(may('edit.fillet', 'fillet', 'フィレット', fz.fillet, 'この辺には不可'), may('edit.chamfer', 'chamfer', '面取り', fz.chamfer, 'この辺には不可'));
  // whole-body moves only for selected bodies: with a face or an edge selected, G moves that face or edge
  if (s.bodies.length) out.push(null, ['transform.grab', 'move', '移動'], ['transform.rotate', 'rotate', '回転'], ['transform.scale', 'scale', '拡大縮小'], ['edit.duplicate', 'duplicate', '複製']);
  if (s.bodies.length >= 2) out.push(null, ['bool.union', 'union', '結合'], ['bool.cut', 'cut', '切り抜き'], ['bool.intersect', 'intersect', '交差']);
  if (s.faces.length === 1 && (s.faces[0].normal || S.doc.bodies[s.faces[0].body]?.kind === 'Sketch')) out.push(['sketch.offset', 'offset', 'オフセット']);
  if (s.bodies.length) out.push(null, ['edit.mirror', 'mirror', 'ミラー'], ['edit.pattern', 'pattern', '配列複写'], ['edit.split', 'split', '平面で分割']);
  if (selBodies().length) out.push(['measure.info', 'measure', '計測']);
  if (selBodies().length) out.push(null, ['view.frame', 'fit', 'フレーム'], ['hide.selected', 'eye-off', '隠す']);
  if (s.bodies.length) out.push(['edit.delete', 'trash', '削除']);
  // less common: behind the More button of the bar (all of them stay in the right-click menu)
  const more = [];
  if (s.faces.length) more.push(['edit.facecolor', 'bucket', '面の色'], ['edit.draft', 'perspective', '抜き勾配']);
  if (s.bodies.length) more.push(['edit.grow', 'scale', '太らせる / 痩せさせる'], ['edit.section', 'section', '断面を取り出す']);
  if (selBodies().length) more.push(['edit.material', 'palette', '素材と色']);
  out.more = more;
  return out;
}
function renderCtx() {
  if (S.tool === 'pushpull') {
    const bar = $('ctxbar'); bar.hidden = false;
    bar.innerHTML = `<span class="lbl">${icon('push')} プッシュ/プル${S.ppLast != null ? ` <span class="dim">前回 ${S.ppLast.toFixed(3)}</span>` : ''}</span>` +
      `<button id="pp_exit" data-tip="終了" data-key="Esc">${icon('close')}</button>`;
    $('pp_exit').onclick = () => setTool(null);
    return;
  }
  if (SK_TOOLS.includes(S.tool)) {
    const bar = $('ctxbar'); bar.hidden = false;
    bar.innerHTML = `<span class="lbl">${icon(SK_ICON[S.tool])} ${SK_JA[S.tool]}を描く</span>` +
      SK_TOOLS.map(t => btn('sketch.' + t, SK_ICON[t], SK_JA[t], S.tool === t ? 'class="on"' : '')).join('') +
      (S.tool === 'line' ? ['X', 'Y', 'Z'].map(ax => `<button data-lockax="${ax}" class="${S.sk?.lock === ax ? 'on' : ''}" ${S.sk ? '' : 'disabled'} style="color:var(--${ax.toLowerCase()});font-weight:600" data-tip="${ax} 軸に固定（もう一度で解除）" data-key="${ax}">${ax}</button>`).join('') : '') +
      `<button id="sk_exit" data-tip="終了" data-key="Esc">${icon('close')}</button>`;
    bar.querySelectorAll('[data-lockax]').forEach(b => b.onclick = () => { if (S.sk) lockAxis(b.dataset.lockax); });
    $('sk_exit').onclick = () => setTool(null);
    return;
  }
  if (S.tool === 'dim') {
    const bar = $('ctxbar'); bar.hidden = false;
    bar.innerHTML = `<span class="lbl">${icon('dimension')} 寸法${S.dimAxis ? ` <span class="dim">${S.dimAxis} 方向</span>` : ''}</span>` +
      ['X', 'Y', 'Z'].map(a => `<button data-dimax="${a}" class="${S.dimAxis === a ? 'on' : ''}" style="color:var(--${a.toLowerCase()});font-weight:600" data-tip="${a} 方向の長さだけ測る" data-key="${a}">${a}</button>`).join('') +
      `<button id="dim_exit" data-tip="終了" data-key="Esc">${icon('close')}</button>`;
    bar.querySelectorAll('[data-dimax]').forEach(b => b.onclick = () => { S.dimAxis = S.dimAxis === b.dataset.dimax ? null : b.dataset.dimax; dimRefresh(); });
    $('dim_exit').onclick = () => setTool(null);
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
  bar.innerHTML = `<span class="lbl">${what} ${n}</span>` + acts.map(a => a ? btn(a[0], a[1], a[2], a[3] ? 'disabled' : '') : '<span class="sep"></span>').join('') +
    (acts.more?.length ? `<span class="sep"></span><button id="ctxmore" data-tip="その他">${icon('more')}</button>` : '');
  if ($('ctxmore')) $('ctxmore').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); showMenu(r.left, r.top - 8 - 32 * acts.more.length, acts.more.map(a => ({icon: a[1], label: a[2], key: KM.shortcutOf(a[0]), run: () => run(a[0])}))); };
}
function contextMenu(e) {
  setRay(e);
  const h = pick();
  if (h && !(h.kind === 'face' ? isSelFace(h) : h.kind === 'edge' ? S.sel.edges.some(x => x.body === h.body && x.ei === h.ei) : S.sel.bodies.includes(h.body))) select(h, false);
  const ca = contextActions(), items = ca.more?.length ? [...ca, null, ...ca.more] : ca;
  if (!items.length) items.push(['measure.info', 'measure', '計測（干渉チェック）'], ['plane.set', 'workplane', '作業平面を設定'], ['view.section', 'section', '断面表示'], null, ['add.menu', 'add', '追加'], ['command.palette', 'search', 'コマンド検索'], ['view.frame', 'fit', 'すべてフレーム'], ['hide.unhide', 'eye', 'すべて表示'],
    ...(S.rulers.length ? [null, ['ruler.clear', 'trash', 'ルーラーをすべて消す']] : []));
  showMenu(e.clientX, e.clientY, items.map(a => a && {icon: a[1], label: a[2], key: KM.shortcutOf(a[0]), dis: a[3], run: () => run(a[0])}));
}
let menuItems = null, menuHl = -1; // the open menu's items, for arrow keys / Enter
function showMenu(x, y, items) {
  const m = $('menu');
  m.innerHTML = items.map((it, i) => it?.header ? `<div class="mh">${esc(it.header)}</div>` : it ? `<div class="mi ${it.dis ? 'dis' : ''}" data-i="${i}">${icon(it.icon)}<span>${esc(it.label)}</span><span class="k">${esc(it.key || '')}</span></div>` : '<div class="msep"></div>').join('');
  m.hidden = false; menuItems = items; menuHl = -1;
  m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px'; m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px';
  m.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { closeMenus(); items[+el.dataset.i].run(); });
}
function closeMenus() { $('menu').hidden = true; menuItems = null; }
addEventListener('pointerdown', e => { if (!e.target.closest('#menu')) closeMenus(); });
addEventListener('keydown', e => { // an open menu takes the arrow keys, Enter and Esc before anything else
  if (!menuItems || $('menu').hidden || e.target.matches?.('input,textarea,select')) return;
  const rows = [...$('menu').querySelectorAll('.mi:not(.dis)')];
  if (e.key === 'Escape') closeMenus();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!rows.length) return;
    menuHl = (menuHl + (e.key === 'ArrowDown' ? 1 : menuHl < 0 ? 0 : -1) + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('hl', i === menuHl)); rows[menuHl].scrollIntoView({block: 'nearest'});
  } else if (e.key === 'Enter' && menuHl >= 0) rows[menuHl]?.click();
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
const MESH_Q = {coarse: ['粗い', 0.02], normal: ['標準', 0], fine: ['細かい', 0.0005]}; // facet tolerance as a fraction of the model's size
function exportMenu(e) {
  const r = (e?.target?.closest?.('button') || $('doctitle')).getBoundingClientRect();
  const q = S.meshQ || 'normal';
  showMenu(r.left, r.bottom + 4, [{header: '形状（正確）'}, ['step', 'STEP (.step)'],
    {header: `メッシュ（細かさ: ${MESH_Q[q][0]}）`}, ['stl', 'STL (.stl)'], ['3mf', '3MF (.3mf)'], ['obj', 'OBJ (.obj)'], ['glb', 'glTF (.glb)'], ['usda', 'USD (.usda)'], ['wrl', 'VRML (.wrl)'],
    {header: '2D 図面（正面・上面・側面）'}, ['svg', 'SVG (.svg)'], ['dxf', 'DXF (.dxf)'], null, ['nrk', 'Nerikone (.nrk)']]
    .map(x => Array.isArray(x) ? {icon: x[0] === 'nrk' ? 'save' : x[0] === 'svg' || x[0] === 'dxf' ? 'drawing' : 'export', label: x[1], run: () => download(x[0])} : x)
    .concat([null, {icon: 'settings', label: `メッシュの細かさを変える（今: ${MESH_Q[q][0]}）`, run: () => {
      S.meshQ = {coarse: 'normal', normal: 'fine', fine: 'coarse'}[q]; try { localStorage.setItem('nerikone.meshQ', S.meshQ); } catch {} toast(`メッシュの細かさ: ${MESH_Q[S.meshQ][0]}`); }}]));
}
// Save a file: a normal browser download, or, in the desktop app (where the web view has no downloads), written
// straight into the user's Downloads folder by the local server.
async function saveFile(name, blob) {
  if (S.desktop) {
    const d = await req('POST', 'api/save-download?filename=' + encodeURIComponent(name), await blob.arrayBuffer(), true);
    toast(`ダウンロードに保存しました: ${d.name}`); log('ok', `保存  ${d.path}`);
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function download(fmt) {
  try {
    const f = MESH_Q[S.meshQ || 'normal'][1], size = boxOf(Object.keys(S.groups)).getSize(new T.Vector3()).length() || 1;
    const r = await fetch('api/export?fmt=' + fmt + (f && ['stl', '3mf', 'wrl'].includes(fmt) ? '&tolerance=' + (size * f).toPrecision(3) : ''));
    if (!r.ok) throw new Error((await r.json()).error);
    await saveFile((S.docName || 'nerikone') + '.' + fmt, await r.blob());
  } catch (err) { reportError(err.message, '書き出し'); }
}
const IMPORTABLE = /\.(step|stp|stl|wrl|wrz|vrml|nrk)$/i;
async function importFiles(files) {
  for (const f of files) {
    if (!IMPORTABLE.test(f.name)) { reportError(`${f.name}: 読み込めない形式です（STEP / STL / WRL / .nrk）`, '読み込み'); continue; }
    try {
      S.framed = false;
      applyState(await req('POST', 'api/import?filename=' + encodeURIComponent(f.name), await f.arrayBuffer(), true));
      if (/\.nrk$/i.test(f.name)) setDocName(f.name.replace(/\.nrk$/i, ''));
      toast(`${f.name} を読み込みました`); log('ok', `読み込み  ${f.name}`);
    } catch (err) { reportError(err.message, `読み込み ${f.name}`); }
  }
}
$('file').onchange = async e => { await importFiles([...e.target.files]); e.target.value = ''; };
// drag & drop files anywhere on the window
const dropZone = Object.assign(document.createElement('div'), {id: 'dropzone', hidden: true,
  innerHTML: `<div>${icon('import')}<b>ここにドロップして読み込み</b><span>STEP / STL / WRL / .nrk</span></div>`});
document.body.append(dropZone);
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropZone.hidden = false; });
addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; dropZone.hidden = true; } });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropZone.hidden = true;
  importFiles([...e.dataTransfer.files]);
});

function renderPanels() {
  renderTop();
  const kindIcon = {Part: 'part', Shell: 'shell_body', Mesh: 'mesh', Dimension: 'dimension', Sketch: 'rectangle'};
  $('outliner').innerHTML = Object.entries(S.doc.bodies).map(([n, b]) =>
    `<div class="orow ${S.sel.bodies.includes(n) ? 'sel' : ''} ${S.hidden.has(n) ? 'hidden' : ''}" data-body="${esc(n)}" title="${esc(b.kind)}">
      ${icon(kindIcon[b.kind] || 'part')}<span class="name">${esc(n)}</span><button class="swatch" data-mat="${esc(n)}" data-tip="素材と色" style="--c:${esc(b.color || b.mat_color || '#9aa7bd')}"></button><span class="vol">${b.volume != null ? b.volume.toFixed(2) : ''}</span>
      <button data-eye="${esc(n)}" data-tip="表示 / 非表示" data-key="${esc(KM.shortcutOf('hide.selected'))}">${icon(S.hidden.has(n) ? 'eye-off' : 'eye')}</button></div>`).join('') || '<div class="orow none">ボディはまだありません</div>';
  $('ocount').textContent = Object.keys(S.doc.bodies).length || '';
  $('outliner').querySelectorAll('[data-body]').forEach(el => el.onclick = e => {
    const n = el.dataset.body;
    if (e.target.closest('[data-mat]')) { materialPopover(e.target.closest('[data-mat]'), [n]); return; }
    if (e.target.closest('[data-eye]')) { S.hidden.has(n) ? S.hidden.delete(n) : S.hidden.add(n); buildVis(); return; }
    S.mode = 'body'; select({kind: 'body', body: n}, e.shiftKey);
  });
  $('outliner').querySelectorAll('[data-body]').forEach(el => el.ondblclick = e => { if (!e.target.closest('button')) frame([el.dataset.body]); });
  $('hcount').textContent = S.doc.features.length || '';
  $('timeline').innerHTML = S.doc.features.map((f, i) =>
    `<div class="chip ${f.id === S.feature ? 'sel' : ''} ${f.error ? 'err' : ''} ${f.suppressed ? 'off' : ''}" data-f="${f.id}" data-tip="${esc(f.error ? friendly(f.error) : (TOOL_JA[f.cmd] || f.label))}">
      <span class="n">${i + 1}</span>${icon(cmdIcon(f))}<small>${esc(TOOL_JA[f.cmd] || f.label)}${f.params.name || f.params.body ? ' · ' + esc(f.params.name || f.params.body) : ''}</small></div>`).join('') || '<div class="none">履歴はまだありません</div>';
  $('timeline').querySelectorAll('[data-f]').forEach(el => {
    const id = +el.dataset.f;
    el.onclick = () => { S.feature = S.feature === id ? null : id; S.form = null; if (S.feature) showTab('insp'); renderPanels(); };
    el.oncontextmenu = e => { e.preventDefault(); const f = S.doc.features.find(x => x.id === id);
      showMenu(e.clientX, e.clientY - 120, [{icon: 'settings', label: 'パラメータを編集', run: () => { S.feature = id; showTab('insp'); renderPanels(); }},
        {icon: f.suppressed ? 'eye' : 'eye-off', label: f.suppressed ? '抑制を解除' : '抑制', run: () => updateFeature(id, null, {suppressed: !f.suppressed})},
        null, {icon: 'trash', label: '削除', run: () => updateFeature(id, null, {delete: true})}]); };
  });
  renderInspector(); renderCtx(); showHandles(); renderStatus(); renderEmpty(); renderTools();
}
// An empty document says how to begin, instead of showing a bare grid.
const emptyEl = Object.assign(document.createElement('div'), {id: 'empty', hidden: true}); view.append(emptyEl);
function renderEmpty() {
  const show = !S.doc.features.length && !Object.keys(S.doc.bodies).length && !S.tool && !S.modal && !S.form;
  if (show && !emptyEl.innerHTML) {
    emptyEl.innerHTML = `<div><div class="row"><button class="pri txt" data-act="add.menu">${icon('add')} 形を追加 <kbd>${esc(KM.shortcutOf('add.menu'))}</kbd></button>
      <button class="txt" data-act="file.open">${icon('open')} 開く</button>${savedCopy() ? `<button class="txt" data-act="file.restore" data-tip="${new Date(savedCopy().time).toLocaleString()}">${icon('restore')} 復元</button>` : ''}</div></div>`;
  }
  emptyEl.hidden = !show;
}

// ------------------------------------------------------------------ inspector: everything about the selection, in one pane
// What it shows follows the selection: a command waiting for its parameters, a timeline step, bodies, faces or edges,
// and with nothing selected, the document.
function openForm(id) { S.form = id; S.feature = null; showTab('insp'); renderPanels(); }
const KIND_JA = {Part: 'ソリッド', Shell: 'サーフェス', Mesh: 'メッシュ', Sketch: 'スケッチ', Dimension: '寸法'};
function inspectorFeature() { // the timeline step shown: the selected one, else what made the one selected body
  if (S.feature) return S.doc.features.find(f => f.id === S.feature);
  const n = S.sel.bodies.length === 1 && !S.sel.faces.length && !S.sel.edges.length ? S.sel.bodies[0] : null;
  return n ? S.doc.features.findLast(f => f.params.name === n) : null;
}
function renderInspector() {
  const head = $('insphead'), body = $('inspbody'), u = S.doc.units || 'mm';
  const f = S.form ? null : inspectorFeature(), bodies = selBodies(), s = S.sel;
  // keep what is being typed: do not rebuild while the same thing is shown and a field has focus
  const key = JSON.stringify([S.form, f?.id, f?.params, f?.error, bodies, s.faces.length, s.edges.length, S.version, u]);
  if (body.contains(document.activeElement) && key === S.inspKey) return;
  S.inspKey = key;
  const sec = (id, title, ic, html, extra = '') => `<div class="isec" id="${id}"><h5>${icon(ic)} ${esc(title)}${extra}</h5>${html}</div>`;
  const rows = list => list.filter(Boolean).map(([k, v]) => `<div class="irow"><span>${esc(k)}</span><span>${v}</span></div>`).join('');
  let h = '', title, sub = '', ic;
  if (S.form) {
    const cmd = S.cmds[S.form]; ic = cmdIcon(cmd.id); title = TOOL_JA[cmd.id] || cmd.label; sub = '新しく実行';
    h += `<div class="isec" id="i_form"></div>`;
  } else if (f) {
    ic = cmdIcon(f); title = f.params.name || TOOL_JA[f.cmd] || f.label; sub = S.feature ? `履歴 ${S.doc.features.indexOf(f) + 1} / ${S.doc.features.length}` : (KIND_JA[S.doc.bodies[f.params.name]?.kind] || '');
    h += `<div class="isec" id="i_form"></div>`;
  }
  if (bodies.length && !S.form) {
    const info = bodies.map(n => S.doc.bodies[n]).filter(Boolean);
    if (!f) { ic = bodies.length > 1 ? 'duplicate' : 'part'; title = bodies.length > 1 ? `${bodies.length} ボディ` : bodies[0]; sub = info.length === 1 ? KIND_JA[info[0].kind] || '' : ''; }
    const bb = info.reduce((b, x) => b ? [[0, 1, 2].map(i => Math.min(b[0][i], x.bbox[0][i])), [0, 1, 2].map(i => Math.max(b[1][i], x.bbox[1][i]))] : x.bbox, null);
    const vol = info.reduce((a, x) => a + (x.volume || 0), 0);
    h += sec('i_size', '大きさ', 'measure', rows([
      bb && ['幅 × 奥行 × 高さ', `${[0, 1, 2].map(i => fmtN(bb[1][i] - bb[0][i])).join(' × ')} ${u}`],
      info.some(x => x.volume != null) && ['体積', `${fmtN(vol)} ${u}³`],
      info.length === 1 && info[0].faces != null && ['面 / エッジ', `${info[0].faces} / ${info[0].edges}`],
      info.length === 1 && info[0].dim && ['寸法', `${fmtN(info[0].dim.value)} ${u}${info[0].dim.axis !== 'aligned' ? `（${info[0].dim.axis} 方向）` : ''}`],
    ]) + '<div id="i_measure"></div>', `<button id="i_measure_go">計測</button>`);
    if (info.some(x => x.kind === 'Part' || x.kind === 'Shell')) {
      const b0 = info[0], fin = b0.finish || 'plastic';
      h += sec('i_mat', '素材と色', 'palette', `<div class="irow"><span>色</span><input type="color" id="i_color" value="${esc((b0.color || b0.mat_color || '#9aa7bd').slice(0, 7))}"></div>
        <div class="ibtns">${Object.keys(FINISH).map(k => `<button data-fin="${k}" class="${k === fin ? 'on' : ''}">${esc(FINISH_JA[k])}</button>`).join('')}</div>`);
    }
  }
  if (!S.form && !bodies.length) {
    ic = 'doc'; title = S.docName && S.docName !== 'nerikone' ? S.docName : '名称未設定'; sub = 'ドキュメント';
    const all = Object.values(S.doc.bodies);
    h += sec('i_doc', 'ドキュメント', 'doc', rows([['ボディ', all.length], ['履歴', `${S.doc.features.length} 手順`]]) +
      `<div class="irow"><span>単位</span><select id="i_units">${['mm', 'cm', 'm', 'in'].map(k => `<option ${k === u ? 'selected' : ''}>${k}</option>`).join('')}</select></div>`);
    const lb = (id, ic2, label, extra = '') => `<button data-act="${id}" ${extra}>${icon(ic2)} ${esc(label)}</button>`;
    h += sec('i_view', '作業', 'workplane', rows([['作業平面', S.workPlane ? `原点 ${arr(S.workPlane.o).map(fmtN).join(', ')}` : '地面 (Z = 0)'], ['断面表示', S.section ? `${S.section.axis} = ${fmtN(S.section.pos)}` : 'オフ']]) +
      `<div class="ibtns">${lb('plane.set', 'workplane', '作業平面')}${lb('view.section', 'section', '断面', S.section ? 'class="on"' : '')}${all.length > 1 ? lb('measure.info', 'measure', '干渉チェック') : ''}</div><div id="i_measure"></div>`);
    const opt = (id, list, cur, unit = '') => `<select id="${id}">${list.map(v => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}${unit}</option>`).join('')}</select>`;
    const sn = S.snap, ck = (id, on) => `<input type="checkbox" id="${id}" ${on ? 'checked' : ''}>`;
    h += sec('i_snap', 'スナップ', 'magnet', `<div class="irow"><span>スナップ</span>${ck('i_snap_on', sn.on)}</div>
      <div class="irow"><span>グリッドに合わせる</span>${ck('i_snap_grid', sn.grid)}</div><div class="irow"><span>グリッド間隔</span>${opt('i_snap_step', SNAP_STEPS, sn.step, ' ' + u)}</div>
      <div class="irow"><span>刻みで動かす</span>${ck('i_snap_inc', sn.inc)}</div><div class="irow"><span>長さの刻み</span>${opt('i_snap_len', SNAP_LENS, sn.len, ' ' + u)}</div>
      <div class="irow"><span>角度の刻み</span>${opt('i_snap_angle', SNAP_ANGLES, sn.angle, '°')}</div>`);
  }
  if (s.faces.length && !S.form) {
    if (!bodies.length || !f) { ic = 'sel-face'; title = `面 ${s.faces.length}`; sub = s.faces[0].body; }
    h += sec('i_face', '面の色', 'bucket', `<div class="irow"><span>色</span><input type="color" id="i_fcolor" value="#4fc3f7"></div><div class="ibtns"><button id="i_fpaint">${icon('bucket')} 塗る</button></div>`);
  }
  if (s.edges.length && !s.faces.length && !S.form && !f) { ic = 'sel-edge'; title = `エッジ ${s.edges.length}`; sub = s.edges[0].body; }
  head.innerHTML = `${icon(ic || 'info')}<span>${esc(title || '')}</span><span class="sub">${esc(sub)}</span>`;
  body.innerHTML = h;
  if (S.form) renderForm($('i_form'), S.cmds[S.form], defaultsFromSelection(S.cmds[S.form]), p => commit(S.form, p), '実行', false);
  else if (f) renderForm($('i_form'), S.cmds[f.cmd], f.params, p => updateFeature(f.id, p), '適用', true, f);
  $('i_measure_go')?.addEventListener('click', () => measureInto($('i_measure')));
  $('i_units')?.addEventListener('change', e => setUnits(e.target.value));
  for (const [id, k, num] of [['i_snap_on', 'on'], ['i_snap_grid', 'grid'], ['i_snap_inc', 'inc'], ['i_snap_step', 'step', 1], ['i_snap_len', 'len', 1], ['i_snap_angle', 'angle', 1]])
    $(id)?.addEventListener('change', e => { S.snap[k] = num ? +e.target.value : e.target.checked; saveSnap(); if (k === 'step') buildGrid(); renderTop(); });
  const matApply = async finish => { const color = $('i_color').value; for (const n of bodies) await commit('body.material', {body: n, color, finish: finish || S.doc.bodies[n]?.finish || 'plastic'}, {keepSel: true}); };
  $('i_color')?.addEventListener('change', () => matApply());
  body.querySelectorAll('[data-fin]').forEach(b => b.onclick = () => matApply(b.dataset.fin));
  $('i_fpaint')?.addEventListener('click', async () => { const color = $('i_fcolor').value, faces = [...S.sel.faces]; for (const x of faces) await commit('face.color', {body: x.body, at: x.point, color}); });
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
  // commands that take a plane (mirror, split, section, draft): the selected flat face, else through the body
  const f = S.sel.faces.at(-1), names = cmd.params.map(q => q.name), body = p.body && S.groups[p.body] ? p.body : null;
  if (names.includes('origin') && names.includes('normal') && !names.includes('xdir')) {
    if (f?.normal) { p.origin = f.point.map(x => +x.toFixed(5)); p.normal = f.normal.map(x => +x.toFixed(5)); }
    else if (body) { const bx = boxOf([body]), c = bx.getCenter(new T.Vector3()); p.origin = arr(cmd.id === 'body.mirror' ? new T.Vector3(bx.max.x, c.y, c.z) : c).map(x => +x.toFixed(5)); }
  }
  if (cmd.id === 'face.draft' && S.sel.faces.length) { p.faces = S.sel.faces.map(x => x.point); const bx = body && boxOf([body]); if (bx) { p.origin = [0, 0, +bx.min.z.toFixed(5)]; p.normal = [0, 0, 1]; } }
  if (cmd.id === 'body.pattern' && body) { const sz = boxOf([body]).getSize(new T.Vector3()); p.step = [+(sz.x * 1.5).toFixed(3), 0, 0]; p.axis_origin = [0, 0, 0]; }
  return p;
}
function renderForm(el, cmd, values, onSubmit, label, live, feature) {
  const bodies = Object.keys(S.doc.bodies), simple = q => ['float', 'int', 'bool', 'enum', 'body', 'vec3', 'str'].includes(q.type);
  const field = q => {
    const v = values[q.name] ?? q.default, id = 'p_' + q.name;
    let input;
    if (q.type === 'float' || q.type === 'int') input = `<input id="${id}" type="number" step="${q.type === 'int' ? 1 : 0.1}" value="${typeof v === 'number' ? +v.toFixed(6) : v}">`;
    else if (q.type === 'bool') input = `<input id="${id}" type="checkbox" ${v ? 'checked' : ''}>`;
    else if (q.type === 'enum') input = `<select id="${id}">${q.options.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    else if (q.type === 'body') input = `<select id="${id}">${[...new Set([v, ...bodies])].map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (q.type === 'str' || q.type === 'blob') input = `<input id="${id}" value="${esc(v ?? '')}" ${q.type === 'blob' ? 'readonly' : ''}>`;
    else if (q.type === 'vec3') input = `<div class="vec">${[0, 1, 2].map(k => `<input id="${id}_${k}" type="number" step="0.1" value="${v?.[k] ?? 0}" title="${'XYZ'[k]}">`).join('')}</div>`;
    else input = `<textarea id="${id}">${esc(JSON.stringify(v))}</textarea>`;
    const name = DIM_JA[q.name] || q.name;
    return `<div class="field ${simple(q) ? '' : 'wide'}"><label data-tip="${esc(q.name)}" data-sub="${esc(q.doc || '')}">${esc(name)}</label>${input}</div>`;
  };
  const shown = cmd.params.filter(q => q.type !== 'blob' && !(live && q.name === 'name'));
  el.innerHTML = (feature?.error ? `<div class="err">${icon('warn')} ${esc(friendly(feature.error))}</div>` : '') +
    `<h5 data-tip="${esc(cmd.doc)}">${icon('settings')} パラメータ</h5>` +
    shown.filter(simple).map(field).join('') +
    (shown.some(q => !simple(q)) ? `<details class="more"><summary>データ</summary>${shown.filter(q => !simple(q)).map(field).join('')}</details>` : '') +
    `<div class="dfoot">${live ? `<button class="txt" id="p_sup">${icon(feature.suppressed ? 'eye' : 'eye-off')} ${feature.suppressed ? '抑制を解除' : '抑制'}</button><button class="txt" id="p_del">${icon('trash')} 削除</button>`
      : `<button class="txt" id="p_cancel">取り消し</button><button class="pri txt" id="p_go">${icon('check')} ${label}</button>`}</div><div id="p_err" class="err"></div>`;
  const read = () => {
    const out = {};
    for (const q of cmd.params) {
      const id = 'p_' + q.name;
      if (!$(id) && !$(id + '_0')) { out[q.name] = values[q.name] ?? q.default; continue; }
      if (q.type === 'float' || q.type === 'int') out[q.name] = +$(id).value;
      else if (q.type === 'bool') out[q.name] = $(id).checked;
      else if (['enum', 'body', 'str', 'blob'].includes(q.type)) out[q.name] = $(id).value;
      else if (q.type === 'vec3') out[q.name] = [0, 1, 2].map(k => +$(id + '_' + k).value);
      else out[q.name] = JSON.parse($(id).value);
    }
    return out;
  };
  const go = () => { try { onSubmit(read()); } catch (e) { $('p_err').textContent = e.message; } };
  if (live) {
    el.querySelectorAll('input,select,textarea').forEach(i => i.addEventListener('change', go)); // parametric: rebuild on edit
    el.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') i.blur(); }));
    $('p_sup').onclick = () => updateFeature(feature.id, null, {suppressed: !feature.suppressed});
    $('p_del').onclick = () => { S.feature = null; updateFeature(feature.id, null, {delete: true}); };
  } else {
    $('p_go').onclick = go;
    $('p_cancel').onclick = () => { S.form = null; renderPanels(); };
    el.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }));
  }
}

// Axis constraints (X Y Z) live in the header for every tool and operation that has them: the current lock lights up, a second
// press releases it. Which one applies: a running move / rotate / scale, the line tool while a line is being drawn, the dimension tool.
function axisCtx() {
  if (S.modal?.axes) return {lock: S.modal.axis, set: a => { S.modal.axis = S.modal.axis === a ? null : a; S.modal.onAxis?.(S.modal); updateModal(); renderStatus(); }};
  if (S.tool === 'line' && S.sk) return {lock: S.sk.lock, set: a => lockAxis(a)};
  if (S.tool === 'dim') return {lock: S.dimAxis, set: a => { S.dimAxis = S.dimAxis === a ? null : a; dimRefresh(); renderCtx(); renderStatus(); }};
  return null;
}
function updateAxisChips() {
  const c = axisCtx();
  document.querySelectorAll('[data-axbtn]').forEach(b => { b.classList.toggle('on', !!c && c.lock === b.dataset.axbtn); b.disabled = !c; });
}
document.addEventListener('click', e => { const b = e.target.closest('[data-axbtn]'); if (b && !b.disabled) axisCtx()?.set(b.dataset.axbtn); });
function renderStatus() { // the state only: what tool, what is selected, how many bodies, units (no instructions)
  const n = S.sel.faces.length + S.sel.edges.length + S.sel.bodies.length;
  const toolName = {pushpull: 'プッシュ/プル', ruler: 'ルーラー', dim: '寸法', line: 'ライン', rect: '矩形', circle: '円', poly: '多角形', orbit: 'オービット', pan: 'パン', zoom: 'ズーム'}[S.tool];
  const info = [toolName ? `<span class="tool">${esc(toolName)}</span>` : `<span>${{edge: 'エッジ', face: '面', body: 'ボディ'}[S.mode] || ''}モード</span>`,
    n ? `<span>選択 <b>${n}</b></span>` : '', `<span>ボディ <b>${Object.keys(S.doc?.bodies || {}).length}</b></span>`,
    S.section ? '<span class="tool">断面表示</span>' : '', (S.modal ? S.modal.keep || S.modal.copy : S.plus && S.tool === 'pushpull') ? `<span class="tool">+ ${S.modal?.copy || S.tool !== 'pushpull' ? 'コピー' : '面を残す'}</span>` : '', S.workPlane ? '<span class="tool">作業平面</span>' : '',
    `<span>${esc(S.doc?.units || 'mm')}</span>`].filter(Boolean).join('');
  updateAxisChips();
  $('status').innerHTML = `<button id="consolebtn" data-act="panel.console" data-tip="コンソール" data-key="${esc(KM.shortcutOf('panel.console'))}">${icon('terminal')}<span class="badge">${S.unseenErr || ''}</span></button><div class="hints"></div><div class="sinfo">${info}</div>`;
  $('consolebtn').classList.toggle('alert', !!S.unseenErr);
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
    $('plist').innerHTML = items.map((c, i) => `<div class="mi ${i === hl ? 'hl' : ''}" data-i="${i}">${icon(c.icon || 'settings')}<span>${esc(c.label)} <span class="dim">${esc(c.sub)}</span></span><span class="k">${esc(c.key)}</span></div>`).join('') || '<div class="none">見つかりません</div>';
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
        $('km_export').onclick = () => saveFile('nerikone-keymap.json', new Blob([KM.exportKeymap()], {type: 'application/json'}));
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
// folding by title, resizing by grips
$('rcol').addEventListener('click', e => {
  const h = e.target.closest('.dhead'); if (!h || e.target.closest('button, input, select')) return;
  const k = Object.keys(RPANES).find(x => RPANES[x] === h.parentElement.id); if (!k) return;
  rstate.shut = rstate.shut.includes(k) ? rstate.shut.filter(x => x !== k) : [...rstate.shut, k]; rsave(); rapply(); renderTop();
});
function drag(el, move) { // pointer drag helper: move(dx, dy, start) on every move
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; e.preventDefault(); const start = {x: e.clientX, y: e.clientY, ...(move.init?.(e) || {})};
    const mv = ev => move(ev.clientX - start.x, ev.clientY - start.y, start), up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); rsave(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
}
document.querySelectorAll('.rgrip').forEach(g => {
  const dock = g.nextElementSibling, k = Object.keys(RPANES).find(x => RPANES[x] === dock.id);
  const mv = (dx, dy, s) => { if (!s.prev) return; const a = Math.max(70, s.ha + dy), b = Math.max(70, s.hb - dy); if (a + b !== s.ha + s.hb) return;
    rstate.h[s.pk] = a; rstate.h[k] = b; s.prev.style.flexGrow = a; dock.style.flexGrow = b; };
  mv.init = () => { // the nearest open panel above, and the two heights to trade
    let p = g.previousElementSibling; while (p && !(p.classList.contains('dock') && !p.classList.contains('shut'))) p = p.previousElementSibling;
    if (!p || dock.classList.contains('shut')) return {};
    const pk = Object.keys(RPANES).find(x => RPANES[x] === p.id);
    for (const [kk, id] of Object.entries(RPANES)) { const el = document.getElementById(id); if (!el.classList.contains('shut')) rstate.h[kk] = el.getBoundingClientRect().height; }
    return {prev: p, pk, ha: p.getBoundingClientRect().height, hb: dock.getBoundingClientRect().height};
  };
  drag(g, mv);
});
drag($('rwidth'), Object.assign((dx, dy, s) => { rstate.w = Math.round(Math.max(220, Math.min(520, s.w - dx))); document.body.style.setProperty('--inw', rstate.w + 'px'); }, {init: () => ({w: rstate.w})}));
$('cclose').onclick = () => openConsole(false);
$('cfilter').onclick = () => { S.consoleFilter = S.consoleFilter === 'err' ? '' : 'err'; renderConsole(); };
$('cclear').onclick = () => { LOG.length = 0; S.unseenErr = 0; renderConsole(); };
$('ccopy').onclick = () => copyText(LOG.map(entryText).join('\n'));
$('cserver').onclick = async () => {
  const list = await get('api/errors');
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
  if (t !== S.tool) sfx('tool');
  S.tool = t; S.plus = false; S.dimA = S.dimB = null; S.dimLive = null; showSnap(null); midHint.visible = false; S.snapRef = null; S.rulerA = null; rulerPreview(null); S.sk = null; sketchPreview();
  if (t) { S.sel = {faces: [], edges: [], bodies: []}; S.hover = null; }
  if (t === 'pushpull') S.mode = 'face';
  orbit.mouseButtons.LEFT = NAV_TOOLS[t] ?? T.MOUSE.ROTATE;
  applyToolCursor();
  renderTools(); refresh(); renderPanels();
}
// a point under the mouse: an edge end (vertex) within 12 px, else the surface, else the ground plane
// Snapping ("inference"): the pointer looks for geometry near it and locks on, in this order:
// an edge's end, an edge's midpoint, any point along an edge; then the surface under it; then the ground.
// Candidates hidden behind a face are skipped. What it found is marked in the view and named next to the pointer.
const SNAP = {end: {px: 12, color: 0x4fc3f7, label: '端点'}, mid: {px: 12, color: 0x6fcf97, label: '中点'}, edge: {px: 8, color: 0xffd27f, label: 'エッジ上'}};
const snapDot = new T.Points(new T.BufferGeometry(), new T.PointsMaterial({size: 11, sizeAttenuation: false, depthTest: false}));
const snapEdge = new T.Line(new T.BufferGeometry(), new T.LineBasicMaterial({depthTest: false, transparent: true, opacity: 0.9}));
snapDot.renderOrder = 15; snapEdge.renderOrder = 12; snapDot.visible = snapEdge.visible = false; scene.add(snapEdge, snapDot);
const midHint = new T.Points(new T.BufferGeometry(), new T.PointsMaterial({color: 0x6fcf97, size: 7, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.65}));
midHint.renderOrder = 15; midHint.visible = false; scene.add(midHint);
const snapLabel = Object.assign(document.createElement('div'), {id: 'snaplabel', hidden: true}); view.append(snapLabel);
function showSnap(sp, e) {
  const k = sp?.snap && SNAP[sp.kind];
  snapDot.visible = snapEdge.visible = !!k; snapLabel.hidden = !k;
  if (!k) { S.snapSeen = null; return; }
  const sk = sp.kind + (sp.p.x + ',' + sp.p.y + ',' + sp.p.z); if (S.snapSeen !== sk) { S.snapSeen = sk; sfx('snap'); }
  snapDot.geometry.setFromPoints([sp.p]); snapDot.material.color.set(k.color);
  snapEdge.geometry.copy(sp.edge.geometry); snapEdge.matrix.copy(sp.edge.matrixWorld); snapEdge.matrixAutoUpdate = false; snapEdge.matrixWorldNeedsUpdate = true; snapEdge.material.color.set(k.color);
  const r = view.getBoundingClientRect();
  snapLabel.textContent = k.label; snapLabel.style.color = '#' + k.color.toString(16).padStart(6, '0');
  snapLabel.style.left = e.clientX - r.left + 18 + 'px'; snapLabel.style.top = e.clientY - r.top - 22 + 'px';
}
const occRay = new T.Raycaster();
function occluded(p) { // is a face between the camera and p?
  const n = p.clone().project(cam);
  occRay.setFromCamera(new T.Vector2(n.x, n.y), cam);
  const h = occRay.intersectObjects(visibleFaces()).filter(notClipped)[0], d = occRay.ray.origin.distanceTo(p);
  return !!h && h.distance < d - Math.max(1e-4, d * 2e-3);
}
function snapPoint(e) {
  setRay(e);
  if (!e.shiftKey) {
    const cands = [], mx = e.clientX, my = e.clientY, a = new T.Vector3(), b = new T.Vector3(), q = new T.Vector3();
    for (const l of visibleEdges()) {
      const pos = l.geometry.attributes.position, n = pos.count;
      if (n < 2) continue;
      const near = (p, kind) => { const s = screenOf(p), d = Math.hypot(s.x - mx, s.y - my); if (d < SNAP[kind].px) cands.push({p: p.clone(), kind, d, edge: l}); };
      near(a.fromBufferAttribute(pos, 0).applyMatrix4(l.matrixWorld), 'end');
      near(a.fromBufferAttribute(pos, n - 1).applyMatrix4(l.matrixWorld), 'end');
      if (l.userData.mid) near(a.fromArray(l.userData.mid).applyMatrix4(l.matrixWorld), 'mid');
      let best = null;
      for (let i = 0; i < n - 1; i++) {
        a.fromBufferAttribute(pos, i).applyMatrix4(l.matrixWorld); b.fromBufferAttribute(pos, i + 1).applyMatrix4(l.matrixWorld);
        ray.ray.distanceSqToSegment(a, b, undefined, q); // the point of this segment nearest the pointer's ray: exact, not from the screen
        const s = screenOf(q), d = Math.hypot(s.x - mx, s.y - my);
        if (d < SNAP.edge.px && (!best || d < best.d)) best = {p: q.clone(), kind: 'edge', d, edge: l, dir: b.clone().sub(a).normalize()};
      }
      if (best) cands.push(best);
    }
    // the lines being drawn and the rulers: their ends and midpoints (but not the point being placed)
    const segs = [];
    if (S.sk?.pts.length) { const P = S.sk.pts; for (let i = 0; i + 1 < P.length; i++) segs.push([P[i], P[i + 1]]); if (P.length === 1) segs.push([P[0], P[0]]); }
    for (const r of S.rulers || []) segs.push([r.a, r.b]);
    for (const [u, w] of segs) {
      const line = new T.Line(new T.BufferGeometry().setFromPoints([u, w]));
      const near = (p, kind) => { const sc = screenOf(p), d = Math.hypot(sc.x - mx, sc.y - my); if (d < SNAP[kind].px) cands.push({p: p.clone(), kind, d, edge: line, own: true}); };
      near(u, 'end'); if (u !== w) { near(w, 'end'); near(u.clone().add(w).multiplyScalar(0.5), 'mid'); }
    }
    const rank = {end: 0, mid: 1, edge: 2};
    cands.sort((x, y) => rank[x.kind] - rank[y.kind] || x.d - y.d);
    for (const c of cands.slice(0, 8)) if (c.own || !occluded(c.p)) {
      const pos = c.edge.geometry.attributes.position; // a straight edge gives a direction the line tool can follow
      const straight = pos.count === 2 ? new T.Vector3().fromBufferAttribute(pos, 1).sub(new T.Vector3().fromBufferAttribute(pos, 0)).transformDirection(c.edge.matrixWorld) : null;
      if (straight) S.snapRef = straight;
      const sp = {p: c.p, snap: true, kind: c.kind, edge: c.edge};
      showSnap(sp, e);
      const mid = c.kind === 'edge' && (c.edge.userData.mid ? new T.Vector3().fromArray(c.edge.userData.mid).applyMatrix4(c.edge.matrixWorld) : null);
      midHint.visible = !!mid; if (mid) midHint.geometry.setFromPoints([mid]);
      return sp;
    }
  }
  showSnap(null); midHint.visible = false;
  const h = firstHit(visibleFaces());
  if (h) { showGridDot(null); return {p: h.point.clone(), snap: false}; }
  const g = ray.ray.intersectPlane(basePlane(), new T.Vector3());
  if (g && !e.shiftKey && snapOn('grid')) { const n = basePlane().normal, gp = gridPoint(g, {o: S.workPlane?.o || new T.Vector3(), n}); showGridDot(gp); return {p: gp, snap: false, grid: true}; }
  showGridDot(null);
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
  applyToolCursor(sp?.snap ? 'snap' : sp ? 'hot' : 'idle');
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
A('tool.ruler', 'ルーラー', 'ツール', () => setTool(S.tool === 'ruler' ? null : 'ruler'));
function deleteRuler(i) { S.rulers.splice(i, 1); drawRulers(); renderCtx(); }
A('ruler.clear', 'ルーラーをすべて消す', 'ツール', () => { S.rulers = []; S.rulerA = null; rulerPreview(null); drawRulers(); renderCtx(); });
// labels are rebuilt every frame, so act on pointerdown (the element is still the one under the pointer)
rulerLabels.addEventListener('pointerdown', e => { const b = e.target.closest('[data-rdel]'); if (b) { e.stopPropagation(); e.preventDefault(); deleteRuler(+b.dataset.rdel); } });

// ------------------------------------------------------------------ materials and colours
function popover(anchorEl, html, onReady) {
  const m = $('menu'); m.innerHTML = `<div class="pop">${html}</div>`; m.hidden = false; menuItems = null;
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
  const faces = [...S.sel.faces]; if (!faces.length) return toast('面を選択');
  popover($('ctxbar'), `<div class="ph">${icon('bucket')} 面の色 <span class="dim">${faces.length} 面</span></div>
    <input type="color" id="fc" value="#4fc3f7" style="height:30px;padding:2px"><div class="dfoot"><button class="pri txt" id="fapply">${icon('check')} 塗る</button></div>`, () => {
    $('fapply').onclick = async () => { const color = $('fc').value; closeMenus(); for (const f of faces) await commit('face.color', {body: f.body, at: f.point, color}); };
  });
}
A('edit.material', '素材と色', '編集', () => { const n = selBodies(); if (!n.length) return toast('ボディを選択'); materialPopover($('ctxbar'), n); });
A('edit.facecolor', '面の色', '編集', faceColorPopover);

// ------------------------------------------------------------------ sketch: rectangle / circle / polygon regions
// Draw on a planar face (the region is then added to / cut from that body when pushed or pulled) or on the ground.
// The line tool draws an outline segment by segment: each segment shows its length, follows the plane's axes when
// close to one (Shift: free), takes a typed length, and closing the outline makes the region.
const SK_JA = {line: 'ライン', rect: '矩形', circle: '円', poly: '多角形'}, SK_ICON = {line: 'pencil', rect: 'rectangle', circle: 'circle', poly: 'polygon'};
const SK_TOOLS = ['line', 'rect', 'circle', 'poly'];
const isPath = t => t === 'poly' || t === 'line';
// arcs, in plane coordinates. bulge = sagitta / half chord, positive to the right of a -> b (as the kernel's sketch.path)
function bulgeAt(a, b, m) { // the bulge that makes the arc from a to b pass (nearly) through m
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy); if (len < 1e-9) return 0;
  const s = ((m[0] - (a[0] + b[0]) / 2) * dy - (m[1] - (a[1] + b[1]) / 2) * dx) / len;
  return Math.max(-20, Math.min(20, s / (len / 2)));
}
function arcPoints(a, b, bulge, n = 24) { // points strictly between a and b along the arc
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), h = len / 2, sg = bulge * h;
  if (len < 1e-9 || Math.abs(sg) < 1e-9) return [];
  const rx = dy / len, ry = -dx / len, R = (h * h + sg * sg) / (2 * Math.abs(sg)), off = sg - Math.sign(sg) * R;
  const cx = (a[0] + b[0]) / 2 + rx * off, cy = (a[1] + b[1]) / 2 + ry * off;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx), a1 = Math.atan2(b[1] - cy, b[0] - cx);
  let d = a1 - a0; // bowing right of a -> b turns anticlockwise
  if (sg > 0) { while (d <= 0) d += 2 * Math.PI; } else { while (d >= 0) d -= 2 * Math.PI; }
  return Array.from({length: n - 1}, (_, i) => { const t = a0 + d * (i + 1) / n; return [cx + R * Math.cos(t), cy + R * Math.sin(t)]; });
}
const SK_BLUE = 0x4fc3f7;
// line tool: bend the cursor point onto an axis of the sketch plane (within 7 degrees), then apply a typed length
// X / Y / Z in the line tool: lock the next segment to a world axis (press again to release). An axis square to the
// sketch plane cannot be drawn in it; on the first segment the plane then turns upright around the axis, facing the view.
// Is p the outline's start (within a few pixels)? Joining up there closes the outline and ends the line tool.
function atStart(p) {
  const k = S.sk; if (!k?.pts.length || k.pts.length < 2) return false;
  const a = screenOf(k.pts[0]), b = screenOf(p);
  return p.distanceTo(k.pts[0]) < 1e-6 || Math.hypot(a.x - b.x, a.y - b.y) < 10;
}
const canClose = () => S.sk && S.sk.pts.length >= (S.sk.bulges?.some(Boolean) ? 2 : 3);
function lockAxis(a) {
  const k = S.sk, L = AX[a];
  if (k.lock === a) k.lock = null;
  else {
    if (Math.hypot(L.dot(k.plane.u), L.dot(k.plane.v)) < 1e-6) {
      if (k.pts.length !== 1) { toast(`${a} 軸はこの面の上にありません`); return; }
      // the upright plane is a world plane (XZ or YZ for Z ...), the one seen most face-on, so the other axes stay exact
      const view = cam.getWorldDirection(new T.Vector3()), n = ['X', 'Y', 'Z'].filter(b => b !== a).map(b => AX[b])
        .reduce((p, q) => Math.abs(q.dot(view)) > Math.abs(p.dot(view)) ? q : p).clone();
      if (n.dot(view) > 0) n.negate();
      k.plane = withBasis({o: k.pts[0].clone(), n, on_body: ''}); k.pending = false; k.dir = null;
    }
    k.lock = a;
  }
  if (S.skCur) S.skCur = lineAim({p: S.skCur}, {shiftKey: true})?.p;
  sketchPreview(S.skCur); renderStatus(); renderCtx();
}
function lineAim(q, e) {
  const k = S.sk; k.axis = null; k.seg = null;
  if (S.tool !== 'line' || !k.pts.length || !q) return q;
  const pl = k.plane, last = k.pts.at(-1), [a0, b0] = uvOf(last, pl);
  let [a, b] = uvOf(q.p, pl); a -= a0; b -= b0;
  let len = Math.hypot(a, b);
  if (k.lock) { // X / Y / Z pressed: the segment runs along that world axis; its length is how far the pointer reaches along it
    const L = AX[k.lock], du = L.dot(pl.u), dv = L.dot(pl.v), m = Math.hypot(du, dv);
    const along = (a * du + b * dv) / m, sg = Math.sign(along) || Math.sign(k.dir ? k.dir[0] * du + k.dir[1] * dv : 1) || 1;
    k.dir = [sg * du / m, sg * dv / m]; len = Math.abs(along);
    k.axis = L.clone().multiplyScalar(sg); k.axisKind = 'lock';
  } else if (len < 1e-9) { if (!k.dir) return q; [a, b] = k.dir; len = 0; } // typing a length before moving: keep the last direction
  else {
    if (!q.snap && !e?.shiftKey) {
      // directions it will lock onto: the plane's two axes, and along / square to the last straight edge the pointer touched
      const ang = Math.atan2(b, a), opts = [[0, 'axis'], [Math.PI / 2, 'axis']];
      const ref = S.snapRef && [S.snapRef.dot(pl.u), S.snapRef.dot(pl.v)];
      if (ref && Math.hypot(...ref) > 0.5) { const ra = Math.atan2(ref[1], ref[0]); opts.push([ra, 'par'], [ra + Math.PI / 2, 'perp']); }
      let hit = null;
      for (const [base, kind] of opts) {
        const near = base + Math.round((ang - base) / Math.PI) * Math.PI, d = Math.abs(ang - near);
        if (d < 7 * Math.PI / 180 && (!hit || d < hit.d - 1e-9)) hit = {near, kind, d};
      }
      if (hit) { a = Math.cos(hit.near) * len; b = Math.sin(hit.near) * len; k.axis = fromUV(pl, a, b).sub(pl.o).normalize(); k.axisKind = hit.kind; }
    }
    k.dir = [a / len, b / len];
  }
  const t = parseFloat(k.typed);
  // lengths move in steps, unless the end already sits on the grid (and the segment follows no locked direction)
  if (!(isFinite(t) && t > 0) && !q.snap && (!q.grid || k.axis) && len > 0 && snapOn('inc')) len = Math.max(S.snap.len, roundTo(len, S.snap.len));
  if (isFinite(t) && t > 0) { a = k.dir[0] * t; b = k.dir[1] * t; len = t; }
  else { a = k.dir[0] * len; b = k.dir[1] * len; }
  k.seg = {len, angle: (Math.atan2(k.dir[1], k.dir[0]) * 180 / Math.PI + 360) % 360};
  return {p: fromUV(pl, a0 + a, b0 + b), snap: q.snap};
}
const skLine = new T.LineLoop(new T.BufferGeometry(), new T.LineBasicMaterial({color: 0x4fc3f7, depthTest: false}));
skLine.renderOrder = 14; skLine.visible = false; scene.add(skLine);
const skDots = new T.Points(new T.BufferGeometry(), new T.PointsMaterial({color: 0x4fc3f7, size: 7, sizeAttenuation: false, depthTest: false}));
skDots.renderOrder = 14; skDots.visible = false; scene.add(skDots);
function planeUnder(e) {
  setRay(e);
  const h = firstHit(visibleFaces()), u = h?.object.userData;
  if (h && u.planar && u.normal && S.doc.bodies[u.body]?.kind === 'Part') return {o: h.point.clone(), n: V(u.normal).normalize(), on_body: u.body};
  return S.workPlane ? {o: S.workPlane.o.clone(), n: S.workPlane.n.clone(), on_body: ''} : {o: new T.Vector3(), n: new T.Vector3(0, 0, 1), on_body: ''};
}
function withBasis(pl) {
  pl.u = Math.abs(pl.n.z) > 0.9 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 0, 1).cross(pl.n).normalize();
  pl.v = pl.n.clone().cross(pl.u);
  return pl;
}
// The grid of a plane: lines S.snap.step apart through the world origin (or the work plane's origin) projected onto it.
function gridPoint(p, pl) {
  const W = S.workPlane?.o || new T.Vector3(), n = pl.n.clone().normalize();
  const g0 = W.clone().addScaledVector(n, n.dot(pl.o.clone().sub(W))); // that origin, moved onto the plane
  const u = Math.abs(n.z) > 0.9 ? new T.Vector3(1, 0, 0) : new T.Vector3(0, 0, 1).cross(n).normalize(), v = n.clone().cross(u);
  const d = p.clone().sub(g0), st = S.snap.step;
  return g0.addScaledVector(u, roundTo(d.dot(u), st)).addScaledVector(v, roundTo(d.dot(v), st));
}
const gridDot = new T.Points(new T.BufferGeometry(), new T.PointsMaterial({color: 0xffffff, size: 6, sizeAttenuation: false, depthTest: false}));
gridDot.renderOrder = 15; gridDot.visible = false; scene.add(gridDot);
function showGridDot(p) { gridDot.visible = !!p; if (p) gridDot.geometry.setFromPoints([p]); }
function onPlane(e, pl) { // mouse -> point on the sketch plane (vertex snap projected onto it; grid snap; Shift: neither)
  const sp = e.shiftKey ? (showSnap(null), null) : snapPoint(e);
  let p = sp?.snap ? sp.p.clone() : (setRay(e), ray.ray.intersectPlane(new T.Plane().setFromNormalAndCoplanarPoint(pl.n, pl.o), new T.Vector3()));
  if (!p) return null;
  p.addScaledVector(pl.n, -p.clone().sub(pl.o).dot(pl.n));
  let onGrid = false;
  if (!sp?.snap && !e.shiftKey && snapOn('grid')) { p = gridPoint(p, pl); onGrid = true; }
  showGridDot(onGrid ? p : null);
  return {p, snap: !!sp?.snap, grid: onGrid};
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
    let r = t.length ? t[0] : Math.hypot(c[0] - a0, c[1] - b0);
    if (!t.length && snapOn('inc')) r = Math.max(S.snap.len, roundTo(r, S.snap.len));
    k.circle = {x: a0, y: b0, radius: r};
    return Array.from({length: 64}, (_, i) => fromUV(pl, a0 + r * Math.cos(i / 32 * Math.PI), b0 + r * Math.sin(i / 32 * Math.PI)));
  }
  if (isPath(S.tool)) { // corners, with arc segments sampled
    const out = [], pl = k.plane, n = k.pts.length;
    for (let i = 0; i < n; i++) { out.push(k.pts[i]); const b = k.bulges?.[i]; if (b && i + 1 < n) out.push(...arcPoints(uvOf(k.pts[i], pl), uvOf(k.pts[i + 1], pl), b).map(([x, y]) => fromUV(pl, x, y))); }
    if (k.arcEnd && cur) { const a = uvOf(k.pts.at(-1), pl), e = uvOf(k.arcEnd, pl); k.arcBulge = bulgeAt(a, e, uvOf(cur, pl)); out.push(...arcPoints(a, e, k.arcBulge).map(([x, y]) => fromUV(pl, x, y)), k.arcEnd); }
    else if (cur) out.push(cur);
    return out;
  }
  return [];
}
function sketchPreview(cur) {
  updateAxisChips();
  const pts = S.sk ? shapePoints(cur) : [];
  skLine.visible = pts.length > 1; if (skLine.visible) skLine.geometry.setFromPoints(pts);
  const dots = S.sk ? [...S.sk.pts, ...(cur ? [cur] : [])] : cur ? [cur] : [];
  skDots.visible = dots.length > 0; if (skDots.visible) skDots.geometry.setFromPoints(dots);
  const k = S.sk;
  const ax = k?.axis && S.tool === 'line' ? dominantAxis(k.axis) : null; // on a world axis: its colour, as in the gizmo
  skLine.material.color.set(!ax ? SK_BLUE : k.axisKind === 'lock' ? AXHEX[k.lock] : k.axisKind !== 'axis' ? 0xe879f9 : Math.abs(k.axis.dot(AX[ax])) > 0.999 ? AXHEX[ax] : SK_BLUE);
  if (!k?.pts.length) { if (!S.modal) hud(''); return; }
  const t = k.typed ? ` <span class="dim">[${esc(k.typed)}_]</span>` : '';
  if (S.tool === 'rect' && k.rect) hud(`矩形 ${k.rect.width.toFixed(3)} × ${k.rect.height.toFixed(3)}${t}`);
  else if (S.tool === 'circle' && k.circle) hud(`円 半径 ${k.circle.radius.toFixed(3)}${t}`);
  else if (S.tool === 'line' && k.arcEnd) { const a = uvOf(k.pts.at(-1), k.plane), e = uvOf(k.arcEnd, k.plane), h = Math.hypot(e[0] - a[0], e[1] - a[1]) / 2, sg = Math.abs(k.arcBulge || 0) * h;
    hud(`円弧 R ${sg > 1e-9 ? ((h * h + sg * sg) / (2 * sg)).toFixed(3) : '∞'}`); }
  else if (S.tool === 'line' && cur && atStart(cur) && canClose()) hud(`<span class="lim">閉じる</span>`);
  else if (S.tool === 'line') hud((k.arcNext ? '<span class="lim">円弧</span> ' : '') + (k.seg ? `長さ ${k.seg.len.toFixed(3)} <span class="dim">· ${k.seg.angle.toFixed(0)}°${k.axis ? ' · ' + {axis: '軸', par: 'エッジに平行', perp: 'エッジに直角', lock: `${k.lock} 軸に固定`}[k.axisKind] : ''} · ${k.pts.length} 点</span>${t}` : `ライン ${k.pts.length} 点${t}`));
  else if (S.tool === 'poly') hud(`多角形 ${k.pts.length} 点${t}`);
}
function sketchHint() {
  const n = S.sk?.pts.length || 0;
  return S.tool === 'rect' ? (n ? '対角の角をクリック（幅,高さ を入力可）' : '最初の角をクリック')
    : S.tool === 'circle' ? (n ? '半径の点をクリック（半径を入力可）' : '中心をクリック')
    : S.tool === 'line' ? (n ? '次の点をクリック（ダブルクリック / 始点クリックで閉じて面に、<kbd>X</kbd> <kbd>Y</kbd> <kbd>Z</kbd> で軸に固定、<kbd>A</kbd> で次を円弧に、端点・中点・エッジ上に吸着、触れたエッジに平行 / 直角、長さを入力して Enter、Shift で吸着なし）' : '始点をクリック')
    : (n ? '次の点をクリック（始点クリック / Enter で閉じる、Backspace で 1 つ戻す）' : '最初の点をクリック');
}
// A first point snapped to an edge or a corner lies on several faces. Which one is meant shows only when the pointer
// moves on, so until the second point the plane follows the face under the pointer (if it contains the first point).
const onPlaneOf = (pl, p) => Math.abs(pl.n.dot(p.clone().sub(pl.o))) < 1e-4;
function settlePlane(e) {
  const k = S.sk; if (!k?.pending || k.pts.length !== 1) return;
  const alt = planeUnder(e);
  if (onPlaneOf(alt, k.pts[0]) && (alt.on_body !== k.plane.on_body || Math.abs(alt.n.dot(k.plane.n)) < 0.999)) { k.plane = withBasis(alt); k.dir = null; }
}
function startPlane(e) {
  const pl = withBasis(planeUnder(e)), sp = e.shiftKey ? null : snapPoint(e);
  // snapped to something off the face under the pointer (a corner seen against the ground, say): keep the point, sketch level through it
  return sp?.snap && !onPlaneOf(pl, sp.p) ? withBasis({o: sp.p.clone(), n: new T.Vector3(0, 0, 1), on_body: ''}) : pl;
}
function sketchHover(e) {
  settlePlane(e);
  const pl = S.sk?.plane || startPlane(e);
  const q = S.sk ? lineAim(onPlane(e, pl), e) : onPlane(e, pl);
  S.skCur = q?.p; sketchPreview(q?.p);
  applyToolCursor(q?.snap ? 'snap' : q ? 'hot' : 'no');
}
function sketchClick(e) {
  if (!S.sk) {
    const pl = startPlane(e), q = onPlane(e, pl); if (!q) return;
    S.sk = {plane: pl, pts: [q.p], typed: '', pending: q.snap, startSnap: q.snap, lastClick: {t: performance.now(), x: e.clientX, y: e.clientY}}; renderStatus(); sketchPreview(q.p); return;
  }
  settlePlane(e);
  const first = screenOf(S.sk.pts[0]);
  if (isPath(S.tool) && !S.sk.arcEnd && canClose() && Math.hypot(first.x - e.clientX, first.y - e.clientY) < 12) return finishSketch(); // back at the start: done
  // line: a double-click ends the outline (closed back to the start)
  const lc = S.sk.lastClick, now = performance.now();
  S.sk.lastClick = {t: now, x: e.clientX, y: e.clientY};
  if (S.tool === 'line' && !S.sk.arcEnd && lc && now - lc.t < 400 && Math.hypot(lc.x - e.clientX, lc.y - e.clientY) < 6) {
    if (S.sk.pts.length >= (S.sk.bulges?.some(Boolean) ? 2 : 3)) { shapePoints(null); return finishSketch(); }
    toast('3 点以上必要'); return;
  }
  if (S.sk.arcEnd) { // third click of an arc: the bend
    const k = S.sk, q = onPlane(e, k.plane); if (!q) return;
    shapePoints(q.p); (k.bulges ||= [])[k.pts.length - 1] = +(k.arcBulge || 0).toFixed(5);
    if (k.arcCloses) { k.arcEnd = null; return finishSketch(); } // the arc came back to the start: the outline is closed
    k.pts.push(k.arcEnd); k.arcEnd = null; k.arcNext = false; sketchPreview(q.p); renderStatus(); return;
  }
  const q = lineAim(onPlane(e, S.sk.plane), e); if (!q) return;
  if (isPath(S.tool)) {
    if (q.p.distanceTo(S.sk.pts.at(-1)) < 1e-6) return; // a double-click must not add a zero-length segment
    const closing = atStart(q.p);
    if (S.tool === 'line' && S.sk.arcNext) { // arc: end point first, then the bend
      if (closing && S.sk.pts.length < 2) return;
      S.sk.arcEnd = closing ? S.sk.pts[0].clone() : q.p; S.sk.arcCloses = closing; S.sk.typed = ''; sketchPreview(q.p); renderStatus(); return;
    }
    if (closing) { if (canClose()) finishSketch(); return; } // joined up with the start: that is the end of the outline
    // from the border of a face to its border: split the face along the line (each half can then be pushed or
    // pulled, and the line moved, say into the ridge of a roof)
    if (S.tool === 'line' && S.sk.pts.length === 1 && S.sk.startSnap && q.snap && S.sk.plane.on_body) {
      const body = S.sk.plane.on_body, pts = [arr(S.sk.pts[0]), arr(q.p)];
      S.sk = null; sketchPreview(); hud('');
      commit('face.split', {body, points: pts}).then(() => { renderStatus(); renderTools(); });
      return;
    }
    S.sk.pts.push(q.p); S.sk.typed = ''; S.sk.lock = null; sketchPreview(q.p); renderStatus(); return;
  }
  shapePoints(q.p); finishSketch();
}
function sketchKey(e) {
  const k = S.sk;
  if (e.key === 'Escape') { e.preventDefault(); if (k && k.lock) { lockAxis(k.lock); return true; } if (k) { S.sk = null; sketchPreview(); hud(''); renderStatus(); } else setTool(null); return true; }
  if (!k) return false;
  if (S.tool === 'line' && !k.arcEnd && ['KeyX', 'KeyY', 'KeyZ'].includes(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); lockAxis(e.code.slice(3)); return true;
  }
  if (S.tool === 'line' && e.code === 'KeyA' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (k.arcEnd) k.arcEnd = null; else k.arcNext = !k.arcNext; sketchPreview(S.skCur); renderStatus(); return true; }
  const reaim = () => { if (S.tool === 'line' && S.skCur) S.skCur = lineAim({p: S.skCur}, {shiftKey: true})?.p; sketchPreview(S.skCur); };
  if (e.key === 'Enter') {
    e.preventDefault();
    if (S.tool === 'line' && k.typed) { // a typed length places the next point along the current direction
      if (!k.dir) { toast('向きを先に決める'); return true; }
      reaim();
      if (S.skCur && atStart(S.skCur) && canClose()) { k.typed = ''; finishSketch(); return true; } // the typed length lands on the start
      if (S.skCur && S.skCur.distanceTo(k.pts.at(-1)) > 1e-6) k.pts.push(S.skCur.clone());
      k.typed = ''; k.lock = null; reaim(); renderStatus(); return true;
    }
    if (isPath(S.tool) ? k.pts.length >= (k.bulges?.some(Boolean) ? 2 : 3) : (k.typed || S.skCur)) { shapePoints(S.skCur); finishSketch(); }
    else if (isPath(S.tool)) toast('3 点以上必要');
    return true;
  }
  if (e.key === 'Backspace') { e.preventDefault(); if (k.typed) k.typed = k.typed.slice(0, -1); else if (k.arcEnd) k.arcEnd = null; else if (isPath(S.tool) && k.pts.length > 1) { k.pts.pop(); if (k.bulges) k.bulges.length = Math.min(k.bulges.length, k.pts.length - 1); } reaim(); renderStatus(); return true; }
  if (/^[0-9.,\- ]$/.test(e.key) && S.tool !== 'poly' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); k.typed += e.key; reaim(); return true; }
  return false;
}
async function finishSketch() {
  const k = S.sk; if (!k) return;
  const pl = k.plane, base = {origin: arr(pl.o), normal: arr(pl.n), xdir: arr(pl.u), on_body: pl.on_body};
  let cmd, params;
  if (S.tool === 'rect') { if (!k.rect || k.rect.width < 1e-4 || k.rect.height < 1e-4) return; cmd = 'sketch.rect'; params = {...base, ...k.rect}; }
  else if (S.tool === 'circle') { if (!k.circle || k.circle.radius < 1e-4) return; cmd = 'sketch.circle'; params = {...base, ...k.circle}; }
  else if (k.bulges?.some(Boolean)) { if (k.pts.length < 2) return; cmd = 'sketch.path'; params = {...base, points: k.pts.map(p => uvOf(p, pl).map(x => +x.toFixed(5))), bulges: k.pts.map((_, i) => k.bulges[i] || 0)}; }
  else { if (k.pts.length < 3) return; cmd = 'sketch.polygon'; params = {...base, points: k.pts.map(p => uvOf(p, pl).map(x => +x.toFixed(5)))}; }
  for (const key of ['x', 'y', 'width', 'height', 'radius']) if (key in params) params[key] = +params[key].toFixed(5);
  S.sk = null; sketchPreview(); hud('');
  const d = await commit(cmd, params);
  if (!d) return;
  // the tool stays on for the next shape; push/pull (P) or Esc then Select to work with the new region
  renderStatus(); renderTools();
}
// push / pull a sketch region: a new solid, or added to / cut from the body it was drawn on
function regionModal(f) {
  const feat = S.doc.features.find(x => x.params?.name === f.body && x.cmd.startsWith('sketch.'));
  const pn = feat ? V(feat.params.normal).normalize() : V(f.normal).normalize();
  const n = V(f.normal).normalize(), sgn = Math.sign(n.dot(pn)) || 1, p0 = V(f.point);
  const m = startModal({
    label: '押し出し', icon: 'push', init: m => { m.t0 = closestOnAxis(p0, n) ?? 0; showAxisGuide(p0, n, 0x4fc3f7); },
    compute: m => { const t = closestOnAxis(p0, n); return t == null ? 0 : t - m.t0; },
    apply: (m, v) => { m.label = (v >= 0 ? '押し出し' : '押し込み') + (m.keep ? '（面を残す）' : ''); if (Math.abs(v) < 1e-4) { m.cmd = null; return; }
      m.cmd = 'region.extrude'; m.params = {body: f.body, amount: +(v * sgn).toFixed(5), keep_face: !!m.keep}; preview('api/exec', {cmd: m.cmd, params: m.params}); },
    finish: finishPreviewed, limitText: r => `${(-r.min).toFixed(2)} 〜 ${r.max.toFixed(2)}`,
  });
  const d = Math.max(diagOf(f.body), diagOf(feat?.params.on_body) || 0, 1) * 3;
  Promise.all([fetchLimit('region.extrude', {body: f.body}, 'amount', d, sgn), fetchLimit('region.extrude', {body: f.body}, 'amount', d, -sgn)])
    .then(([out, inn]) => setRange(m, inn === undefined ? NaN : -(inn ?? 0), out === undefined ? NaN : out ?? 0));
  return m;
}
// ------------------------------------------------------------------ tool cursors
// The pointer becomes the active tool's icon (drawn from the icon font, so it matches the toolbar; the click point
// is its centre), at 1x/2x/3x. Its colour tells what a click would do:
//   idle  white          nothing to act on here
//   hot   accent         a click acts on what is under the pointer (also while an operation runs)
//   snap  blue           snapped to a vertex / edge
//   no    dim + red mark the tool cannot work on this
const cursorCache = {};
let iconFontReady = false;
Promise.all([document.fonts?.load('16px tabler-icons'), document.fonts?.load('16px Fukiai')]).then(() => { iconFontReady = true; S.cursorKey = null; applyToolCursor(); });
function glyphOf(name) { // {ch, font} for the cursor: the icon's glyph and the font to draw it in
  const g = glyphFor(name);
  if (g.fk) return {ch: g.ch, font: 'Fukiai'};
  const i = document.createElement('i'); i.className = `ti ti-${g.tabler}`; i.style.position = 'absolute'; i.style.visibility = 'hidden';
  document.body.append(i);
  const c = getComputedStyle(i, '::before').content; i.remove();
  return c && c !== 'none' ? {ch: c.replace(/^["']|["']$/g, ''), font: 'tabler-icons'} : null;
}
const CURSOR_FILL = {idle: '#ffffff', hot: '#f5a623', snap: '#4fc3f7', no: '#9aa0a8'};
function cursorImage({ch: glyph, font}, scale, state, plus = false) {
  const c = document.createElement('canvas'); c.width = c.height = 32 * scale;
  const g = c.getContext('2d'); g.scale(scale, scale);
  g.font = `22px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  // a soft shadow under a thin dark rim keeps the icon readable on light and dark surfaces alike
  g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 3; g.shadowOffsetY = 1;
  g.strokeStyle = 'rgba(12,13,15,.9)'; g.lineWidth = 3; g.strokeText(glyph, 16, 16);
  g.shadowColor = 'transparent';
  g.fillStyle = CURSOR_FILL[state] || CURSOR_FILL.idle; g.fillText(glyph, 16, 16);
  if (state === 'no') { // a small "not here" badge at the lower right, clear of the click point
    g.beginPath(); g.arc(25, 25, 5.5, 0, Math.PI * 2); g.fillStyle = '#ff6b6b'; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(12,13,15,.9)'; g.stroke();
    g.beginPath(); g.moveTo(22, 25); g.lineTo(28, 25); g.lineWidth = 2; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.stroke();
  }
  if (plus) { // Option held: a "+" to the right of the icon (push/pull keeps the face, move copies)
    g.lineCap = 'round';
    for (const [w, col] of [[4.5, 'rgba(12,13,15,.9)'], [2, '#ffffff']]) { g.lineWidth = w; g.strokeStyle = col; g.beginPath(); g.moveTo(22.5, 16); g.lineTo(29.5, 16); g.moveTo(26, 12.5); g.lineTo(26, 19.5); g.stroke(); }
  }
  return c.toDataURL('image/png');
}
function toolCursor(name, state = 'idle', plus = false) {
  if (!name) return '';
  if (!iconFontReady) return state === 'no' ? 'not-allowed' : 'crosshair';
  const key = name + ':' + state + (plus ? '+' : '');
  if (!cursorCache[key]) {
    const glyph = glyphOf(name); if (!glyph) return 'crosshair';
    const [a, b, c] = [1, 2, 3].map(k => cursorImage(glyph, k, state, plus));
    const hot = (CURSOR_HOT[name] || [16, 16]).join(' '); // where a click lands: the icon's centre, or its tip
    cursorCache[key] = {plain: `url("${a}") ${hot}, crosshair`,
      set: `-webkit-image-set(url("${a}") 1x, url("${b}") 2x, url("${c}") 3x) ${hot}, crosshair`};
  }
  return cursorCache[key];
}
// Option is the "+" modifier: the cursor gets a + while it will keep the face (push/pull) or copy (move)
const plusOn = () => S.modal ? !!(S.modal.keep || S.modal.copy) : !!(S.plus && S.tool === 'pushpull');
function setCursor(name, state = 'idle') {
  const plus = plusOn(), key = name + ':' + state + (plus ? '+' : '');
  if (key === S.cursorKey && canvas.style.cursor) return; // unchanged: skip re-assigning large data URLs on every move
  S.cursorKey = key;
  const c = toolCursor(name, state, plus);
  if (typeof c === 'string') { canvas.style.cursor = c; if (!c) S.cursorKey = null; return; }
  canvas.style.cursor = c.plain; canvas.style.cursor = c.set; // the second only takes where image-set is understood
}
const CURSOR_HOT = {pencil: [7, 23], rotate: [16, 15]}; // the pencil's tip (Fukiai's pencil; measured from the glyph)
const TOOL_CURSOR = {dim: 'dimension', line: 'pencil', pushpull: 'push', ruler: 'ruler', rect: 'rectangle', circle: 'circle', poly: 'polygon', orbit: 'orbit', pan: 'pan', zoom: 'zoom'};
function applyToolCursor(state = 'idle') { if (!S.modal) setCursor(TOOL_CURSOR[S.tool], state); }

// ------------------------------------------------------------------ view tools: orbit / pan / zoom with the left button
const NAV_TOOLS = {orbit: T.MOUSE.ROTATE, pan: T.MOUSE.PAN, zoom: T.MOUSE.DOLLY};
for (const [t, label] of [['orbit', 'オービット'], ['pan', 'パン'], ['zoom', 'ズーム']])
  A('tool.' + t, `視点: ${label}`, 'ツール', () => setTool(S.tool === t ? null : t));

// ------------------------------------------------------------------ push/pull tool
// Click a flat face (of a solid or a sketch region), move the mouse, click again (or type a distance + Enter).
// Pulling adds a prism of the face's shape, pushing cuts one; the body stays a closed solid. The tool stays on,
// and a double-click on a face repeats the last distance.
function ppPick() {
  const h = faceHit(), u = h?.object.userData;
  if (!h || u.mesh) return null;
  const n = u.planar && u.normal ? V(u.normal) : h.face.normal.clone();
  return {kind: 'face', body: u.body, fi: u.fi, point: arr(h.point), normal: arr(n), planar: u.planar};
}
function ppHover() {
  const h = ppPick(), key = h && h.body + h.fi;
  if (key !== S.hoverKey) { S.hover = h; S.hoverKey = key; if (h) sfx('hover'); refresh(); }
  setCursor('push', !h ? 'idle' : h.planar || S.doc.bodies[h.body]?.kind === 'Sketch' ? 'hot' : 'no');
}
function ppClick(e) {
  setRay(e);
  const h = ppPick(); if (!h) return;
  S.sel = {faces: [h], edges: [], bodies: []}; S.hover = null;
  let m;
  if (S.doc.bodies[h.body]?.kind === 'Sketch') m = regionModal(h);
  else if (h.planar) m = extrudeModal(h);
  else { toast('曲面は押し出せません'); return; }
  m.pp = true; m.started = performance.now(); m.keep = !!S.plus; // Option: keep the starting face (a new segment on top)
  if (m.keep) updateModal();
  const finish = m.finish;
  m.finish = async (md, v) => { if (md.cmd) { S.ppLast = v; } await finish(md, v); refresh(); };
}
function extrudeModal(f) {
  const n = V(f.normal).normalize(), p0 = V(f.point);
  const m = startModal({
    label: '引き出し', icon: 'push', init: m => { m.t0 = closestOnAxis(p0, n) ?? 0; const a = dominantAxis(n);
      showAxisGuide(p0, Math.abs(n.dot(AX[a])) > 0.999 ? a : n, Math.abs(n.dot(AX[a])) > 0.999 ? AXHEX[a] : 0xf5a623); },
    compute: m => { const t = closestOnAxis(p0, n); return t == null ? 0 : t - m.t0; },
    apply: (m, v) => { m.label = (v >= 0 ? '引き出し' : '押し込み') + (m.keep ? '（面を残す）' : ''); if (Math.abs(v) < 1e-4) { m.cmd = null; return; }
      m.cmd = 'face.extrude'; m.params = {body: f.body, at: f.point, amount: +v.toFixed(5), keep_face: !!m.keep}; preview('api/exec', {cmd: m.cmd, params: m.params}); },
    finish: finishPreviewed, limitText: r => `${(-r.min).toFixed(2)} 〜 ${r.max.toFixed(2)}`,
  });
  const base = {body: f.body, at: f.point}, d = diagOf(f.body);
  Promise.all([fetchLimit('face.extrude', base, 'amount', d * 3, 1), fetchLimit('face.extrude', base, 'amount', d, -1)])
    .then(([out, inn]) => setRange(m, inn === undefined ? NaN : -(inn ?? 0), out === undefined ? NaN : out ?? 0));
  return m;
}
A('tool.pushpull', 'プッシュ/プル', 'ツール', () => setTool(S.tool === 'pushpull' ? null : 'pushpull'));
for (const t of SK_TOOLS) A('sketch.' + t, `スケッチ: ${SK_JA[t]}`, 'スケッチ', () => setTool(S.tool === t ? null : t));

// ------------------------------------------------------------------ dimensions (tool D): dimension lines kept in the document
// Click two points (they snap like the ruler), then where the dimension line goes. X / Y / Z measures only along that
// axis (a horizontal or vertical dimension). Each one is a dim.add step, so it is saved, undone and edited like any.
S.dimA = null; S.dimB = null; S.dimAxis = null; S.dimLive = null;
const dimGroup = new T.Group(); scene.add(dimGroup);
const dimMat = new T.LineBasicMaterial({color: 0xe6e8ec, depthTest: false, transparent: true, opacity: 0.95});
const dimLiveMat = new T.LineBasicMaterial({color: 0x4fc3f7, depthTest: false});
const dimLabels = Object.assign(document.createElement('div'), {id: 'dimlabels'}); view.append(dimLabels);
function dimGeom(d) {
  const a = V(d.a), b = V(d.b), off = V(d.offset);
  let dir, t;
  if (AX[d.axis]) { dir = AX[d.axis].clone(); t = b.clone().sub(a).dot(dir); } else { dir = b.clone().sub(a); t = dir.length(); dir.normalize(); }
  const D1 = a.clone().add(off), D2 = D1.clone().addScaledVector(dir, t), len = Math.abs(t);
  const side = off.lengthSq() > 1e-18 ? off.clone().normalize() : new T.Vector3(), over = side.clone().multiplyScalar(len * 0.04);
  const segs = [a, D1.clone().add(over), b, D2.clone().add(over), D1, D2];
  const tk = len * 0.03, u = dir.clone().multiplyScalar(Math.sign(t) || 1).add(side).normalize().multiplyScalar(tk); // 45° ticks at both ends
  for (const D of [D1, D2]) segs.push(D.clone().sub(u), D.clone().add(u));
  return {segs, mid: D1.clone().add(D2).multiplyScalar(0.5), value: len};
}
function drawDims() {
  dimGroup.clear();
  const add = (d, live) => { const g = dimGeom(d); const l = new T.LineSegments(new T.BufferGeometry().setFromPoints(g.segs), live ? dimLiveMat : dimMat);
    l.renderOrder = 13; l.userData = {mid: g.mid, value: g.value, name: d.name, axis: d.axis, live}; dimGroup.add(l); };
  for (const [n, b] of Object.entries(S.doc.bodies)) if (b.kind === 'Dimension' && !S.hidden.has(n)) add({...b.dim, name: n});
  if (S.dimLive) add(S.dimLive, true);
  placeDimLabels();
}
function placeDimLabels() {
  const list = dimGroup.children;
  if (!list.length) { if (dimLabels.innerHTML) dimLabels.innerHTML = ''; return; }
  const vr = view.getBoundingClientRect(), u = S.doc.units || 'mm';
  const html = list.map(l => { const m = screenOf(l.userData.mid), ax = AX[l.userData.axis] ? l.userData.axis : '';
    return `<div class="dlabel ${l.userData.live ? 'live' : ''}" style="left:${(m.x - vr.left).toFixed(1)}px;top:${(m.y - vr.top).toFixed(1)}px">` +
      (ax ? `<i style="color:var(--${ax.toLowerCase()})">${ax}</i>` : '') + `<b>${fmtN(l.userData.value)}</b><span>${u}</span>` +
      (l.userData.live ? '' : `<button data-ddel="${esc(l.userData.name)}" title="この寸法を消す">${icon('close')}</button>`) + '</div>'; }).join('');
  if (html !== S.dimHtml) { dimLabels.innerHTML = html; S.dimHtml = html; }
}
dimLabels.addEventListener('click', e => { const b = e.target.closest('[data-ddel]'); if (b) commit('body.delete', {body: b.dataset.ddel}); });
function dimDir(a, b) { return AX[S.dimAxis] ? AX[S.dimAxis].clone() : b.clone().sub(a).normalize(); }
function dimOffset(e) { // where the dimension line goes: the pointer, on the plane through the points that faces the view best
  setRay(e);
  const a = S.dimA, dir = dimDir(a, S.dimB), view_ = cam.getWorldDirection(new T.Vector3());
  let n = view_.clone().addScaledVector(dir, -view_.dot(dir)); if (n.lengthSq() < 1e-9) n = new T.Vector3(0, 0, 1);
  // a dimension along a world axis is pulled out along one of the other two axes: the one the pointer moves along on
  // screen (Shift: free, in the plane facing the view)
  const along = ['X', 'Y', 'Z'].find(k => Math.abs(AX[k].dot(dir)) > 0.9999);
  if (along && !e.shiftKey) {
    const M = a.clone().add(S.dimB).multiplyScalar(0.5), s0 = screenOf(M), mx = e.clientX - s0.x, my = e.clientY - s0.y, ml = Math.hypot(mx, my) || 1;
    let best = null;
    for (const k of ['X', 'Y', 'Z'].filter(k => k !== along)) {
      const s1 = screenOf(M.clone().add(AX[k])), dx = s1.x - s0.x, dy = s1.y - s0.y, dl = Math.hypot(dx, dy);
      if (dl < 1e-6) continue; // seen end-on
      const c = Math.abs((mx * dx + my * dy) / (ml * dl));
      if (!best || c > best.c) best = {k, c};
    }
    if (best) {
      const t = closestOnAxis(M, AX[best.k]) ?? 0;
      let off = AX[best.k].clone().multiplyScalar(t);
      if (snapOn('inc')) off = AX[best.k].clone().multiplyScalar(Math.sign(t) * Math.max(S.snap.len, roundTo(Math.abs(t), S.snap.len)));
      return off;
    }
  }
  const h = ray.ray.intersectPlane(new T.Plane().setFromNormalAndCoplanarPoint(n.normalize(), a), new T.Vector3()); if (!h) return new T.Vector3();
  const v = h.sub(a);
  let off = v.addScaledVector(dir, -v.dot(dir));
  // lay the dimension in a principal plane when the pointer is close to one (within 20°): X, Y or Z square to it
  const L0 = off.length();
  if (L0 > 1e-9 && !e.shiftKey) {
    let best = null;
    for (const k of ['X', 'Y', 'Z']) { const ax = AX[k]; if (Math.abs(ax.dot(dir)) > 1e-6) continue; const c = off.dot(ax) / L0; if (!best || Math.abs(c) > Math.abs(best.c)) best = {ax, c}; }
    if (best && Math.abs(best.c) > Math.cos(T.MathUtils.degToRad(20))) off = best.ax.clone().multiplyScalar(Math.sign(best.c) * L0);
  }
  if (snapOn('inc')) { const L = off.length(); if (L > 1e-9) off.multiplyScalar(Math.max(S.snap.len, roundTo(L, S.snap.len)) / L); }
  return off;
}
function dimRefresh(e) {
  const ev = e || (S.mouse && {clientX: S.mouse.x, clientY: S.mouse.y, shiftKey: false});
  if (S.dimA && S.dimB && ev) S.dimLive = {a: arr(S.dimA), b: arr(S.dimB), offset: arr(dimOffset(ev)), axis: S.dimAxis || 'aligned'};
  else if (S.dimA && ev) { const sp = snapPoint(ev); S.dimLive = sp && sp.p.distanceTo(S.dimA) > 1e-9 ? {a: arr(S.dimA), b: arr(sp.p), offset: [0, 0, 0], axis: S.dimAxis || 'aligned'} : null; }
  else S.dimLive = null;
  drawDims(); renderCtx(); renderStatus();
}
function dimHover(e) {
  if (!S.dimB) { const sp = snapPoint(e); applyToolCursor(sp?.snap ? 'snap' : sp ? 'hot' : 'idle'); }
  dimRefresh(e);
}
function dimClick(e) {
  if (!S.dimA) { const sp = snapPoint(e); if (sp) S.dimA = sp.p.clone(); }
  else if (!S.dimB) { const sp = snapPoint(e); if (sp && sp.p.distanceTo(S.dimA) > 1e-9) S.dimB = sp.p.clone(); }
  else {
    const params = {a: arr(S.dimA), b: arr(S.dimB), offset: arr(dimOffset(e)), axis: S.dimAxis || 'aligned'};
    S.dimA = S.dimB = null; S.dimLive = null; showSnap(null);
    commit('dim.add', params).then(() => { drawDims(); renderStatus(); });
    return;
  }
  dimRefresh(e);
}
function dimKey(e) {
  if (['KeyX', 'KeyY', 'KeyZ'].includes(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); const a = e.code.slice(3); S.dimAxis = S.dimAxis === a ? null : a; dimRefresh(); return true; }
  if (e.key === 'Escape') { e.preventDefault(); if (S.dimB) S.dimB = null; else if (S.dimA) S.dimA = null; else { setTool(null); return true; } dimRefresh(); return true; }
  return false;
}
A('tool.dim', '寸法', 'ツール', () => setTool(S.tool === 'dim' ? null : 'dim'));

// ------------------------------------------------------------------ WebMCP: the same commands for in-browser AI agents
// Registered only where the browser offers a model context (an origin-trial API; its home moved from navigator to
// document in the draft, so both are tried). Nothing changes for other browsers.
function registerWebMCP() {
  const mc = document.modelContext || navigator.modelContext;
  if (!mc || typeof mc.registerTool !== 'function') return;
  const num = {type: 'number'}, vec3 = {type: 'array', items: num, minItems: 3, maxItems: 3};
  const schemaOf = p => ({
    float: num, int: {type: 'integer'}, bool: {type: 'boolean'}, enum: {type: 'string', enum: p.options}, vec3, face_ref: vec3,
    bodies: {type: 'array', items: {type: 'string'}}, edge_refs: {type: 'array', items: vec3},
    points: {type: 'array', items: {type: 'array', items: num}}, grid: {type: 'array', items: {type: 'array', items: vec3}},
    sections: {type: 'array', items: {type: 'array'}},
  }[p.type] || {type: 'string'});
  const text = obj => ({content: [{type: 'text', text: JSON.stringify(obj)}]});
  const tool = (name, description, inputSchema, execute) => {
    try { mc.registerTool({name, description, inputSchema, execute: async args => { try { return text(await execute(args || {})); } catch (e) { return text({error: e.message}); } }}); }
    catch (e) { console.info('[webmcp]', name, e.message); }
  };
  for (const c of Object.values(S.cmds)) {
    const properties = {};
    for (const p of c.params) properties[p.name] = {...schemaOf(p), ...(p.doc ? {description: p.doc} : {}), ...(p.default != null ? {default: p.default} : {})};
    tool('nerikone_' + c.id.replace(/\./g, '_'), `${c.label}: ${c.doc} Faces and edges are referenced by a point on them (see nerikone_inspect_body). Z is up.`,
      {type: 'object', properties}, async args => { const d = await post('api/exec', {cmd: c.id, params: args}); applyState(d); return {feature: d.feature, bodies: d.doc.bodies}; });
  }
  tool('nerikone_get_document', 'The feature timeline and the bodies (kind, bounding box, volume).', {type: 'object', properties: {}},
    async () => (await get('api/state?scene=0')).doc);
  tool('nerikone_inspect_body', "A body's faces and edges with a point on each (pass it as face_ref / edge_refs).",
    {type: 'object', properties: {name: {type: 'string'}}, required: ['name']}, async ({name}) => get('api/inspect?body=' + encodeURIComponent(name)));
  tool('nerikone_undo', 'Undo the last change.', {type: 'object', properties: {}}, async () => { const d = await post('api/undo'); applyState(d); return d.doc.bodies; });
  log('info', `WebMCP: ${Object.keys(S.cmds).length + 3} 個のツールを登録しました`);
}

// ------------------------------------------------------------------ panes: which are open is remembered
const PANES = 'nerikone.panes.v2';
function savePanes() { try { localStorage.setItem(PANES, JSON.stringify(['no-rcol', 'no-tools'].filter(c => document.body.classList.contains(c)))); } catch { /* session only */ } }
try { for (const c of JSON.parse(localStorage.getItem(PANES) || '[]')) if (['no-rcol', 'no-tools'].includes(c)) document.body.classList.add(c); } catch { /* defaults */ }
if (innerWidth < 900) document.body.classList.add('no-rcol'); // a narrow window keeps the view free
rapply();

// ------------------------------------------------------------------ tooltips (data-tip, data-key, data-sub)
const TOOL_JA = {'body.box': '直方体', 'body.cylinder': '円柱', 'body.sphere': '球', 'body.cone': '円錐', 'body.torus': 'トーラス',
  'sketch.extrude': '多角形を押し出し', 'nurbs.surface': 'NURBS 曲面', 'nurbs.loft': 'ロフト', 'nurbs.revolve': '回転体', 'nurbs.sweep': 'スイープ',
  'body.mirror': 'ミラー', 'body.pattern': '配列複写', 'body.split': '平面で分割', 'body.offset': '太らせる / 痩せさせる', 'face.draft': '抜き勾配', 'body.section': '断面を取り出す',
  'sketch.offset': 'オフセット', 'sketch.path': 'ライン', 'sketch.polygon': '多角形', 'sketch.rect': '矩形', 'sketch.circle': '円', 'region.extrude': '押し出し', 'face.extrude': 'プッシュ/プル',
  'face.move': '面を動かす', 'dim.add': '寸法', 'face.split': '面を分割', 'edge.move': 'エッジを移動', 'edge.fillet': 'フィレット', 'edge.chamfer': '面取り', 'body.shell': 'シェル', 'body.boolean': 'ブーリアン', 'body.transform': '移動・回転・拡大', 'body.duplicate': '複製',
  'body.material': '素材と色', 'face.color': '面の色', 'face.delete': '面を削除', 'body.delete': 'ボディを削除', 'file.import': '読み込み'};
const tipEl = Object.assign(document.createElement('div'), {id: 'tip'}); document.body.append(tipEl);
let tipT, tipFor = null;
function placeTip(el) {
  const r = el.getBoundingClientRect(), t = tipEl.getBoundingClientRect(), gap = 8;
  let x, y;
  if (el.closest('#tools, #side')) { x = r.right + gap; y = r.top + r.height / 2 - t.height / 2; }
  else if (el.closest('#inspector')) { x = r.left - t.width - gap; y = r.top + r.height / 2 - t.height / 2; }
  else if (el.closest('#ctxbar')) { x = r.left + r.width / 2 - t.width / 2; y = r.top - t.height - gap; }
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
  try { const {version} = await get('api/version'); setOffline(false); if (version !== S.version) await load(); }
  catch (e) { if (e instanceof TypeError) setOffline(true); }
}, 1000);

// ------------------------------------------------------------------ more modelling actions (forms, offset, measure)
for (const [id, label, cmd] of [['edit.mirror', 'ミラー', 'body.mirror'], ['edit.pattern', '配列複写', 'body.pattern'], ['edit.split', '平面で分割', 'body.split'],
  ['edit.sweep', 'スイープ', 'nurbs.sweep'], ['edit.grow', '太らせる / 痩せさせる', 'body.offset'], ['edit.draft', '抜き勾配', 'face.draft'], ['edit.section', '断面を取り出す', 'body.section']])
  A(id, label, '編集', () => { if (S.cmds[cmd].params.some(q => q.name === 'body' && q.type === 'body') && !selBodies().length) return toast('ボディか面を選択'); openForm(cmd); });
A('sketch.offset', '輪郭をオフセット', 'スケッチ', () => {
  const f = S.sel.faces.at(-1);
  if (!f || !(f.normal || S.doc.bodies[f.body]?.kind === 'Sketch')) return toast('平らな面を 1 つ選択');
  valueModal('オフセット', v => ['sketch.offset', {body: f.body, at: f.point, distance: +v.toFixed(4)}], {start: -0.05, icon: 'offset', unbuildableText: 'この輪郭はオフセットできません'});
});
const fmtN = x => (+x.toFixed(3)).toString();
async function measureInto(el) {
  if (!el) return;
  const names = selBodies(), u = S.doc.units || 'mm';
  el.innerHTML = '<div class="ihint">計測しています…</div>';
  try {
    const rows = [];
    const row = (k, v, cls = '') => `<div class="irow ${cls}"><span>${esc(k)}</span><span>${v}</span></div>`;
    if (names.length) {
      const d = await post('api/measure', {kind: 'body', params: {bodies: names}});
      for (const [n, b] of Object.entries(d.bodies)) {
        if (names.length > 1) rows.push(`<div class="irow"><b>${esc(n)}</b></div>`);
        if (b.area != null) rows.push(row('表面積', `${fmtN(b.area)} ${u}²`));
        if (b.center) rows.push(row('重心', b.center.map(fmtN).join(', ')));
      }
    }
    if (names.length === 2) { try { const d = await post('api/measure', {kind: 'distance', params: {a: names[0], b: names[1]}}); rows.push(row('最短距離', `${fmtN(d.distance)} ${u}`)); } catch { /* not both solids */ } }
    if (S.sel.faces.length === 2) { const [fa, fb] = S.sel.faces; const d = await post('api/measure', {kind: 'angle', params: {a: fa.body, at_a: fa.point, b: fb.body, at_b: fb.point}}); rows.push(row('2 面の法線の角度', `${fmtN(d.angle)}°`)); }
    const it = await post('api/measure', {kind: 'interference', params: names.length >= 2 ? {bodies: names} : {}});
    rows.push(row('干渉チェック', `${it.checked.length} ボディ`));
    rows.push(it.pairs.length ? it.pairs.map(x => row(`${x.a} ⇄ ${x.b}`, `${fmtN(x.volume)} ${u}³`, 'err')).join('') : row('重なり', 'なし'));
    if (names.length === 1 && S.doc.bodies[names[0]]?.kind === 'Part') {
      const dr = await post('api/measure', {kind: 'draft', params: {body: names[0]}});
      rows.push(row('抜き勾配（Z、1° 以上）', ''), row('抜ける / 不足', `${dr.counts.positive} / ${dr.counts.insufficient}`), row('垂直 / アンダーカット', `${dr.counts.vertical} / ${dr.counts.undercut}`));
    }
    el.innerHTML = rows.join('');
  } catch (err) { el.innerHTML = ''; reportError(err.message, '計測'); }
}
A('measure.info', '計測', 'ツール', () => {
  showTab('insp'); renderInspector();
  measureInto($('i_measure'));
});

// ------------------------------------------------------------------ section view: hide everything on one side of a plane
function applySection() {
  const k = S.section;
  R.clippingPlanes = k ? [k.plane] : [];
  if (k) { const n = AX[k.axis].clone().multiplyScalar(k.flip ? 1 : -1); k.plane.setFromNormalAndCoplanarPoint(n, AX[k.axis].clone().multiplyScalar(k.pos)); }
  renderSection();
}
const sectionBar = Object.assign(document.createElement('div'), {id: 'sectionbar', hidden: true}); view.append(sectionBar);
function renderSection() {
  const k = S.section; sectionBar.hidden = !k; if (!k) return;
  const box = boxOf(Object.keys(S.groups)), i = 'XYZ'.indexOf(k.axis);
  const lo = box.isEmpty() ? -5 : box.min.getComponent(i), hi = box.isEmpty() ? 5 : box.max.getComponent(i), pad = (hi - lo) * 0.02 + 1e-3;
  sectionBar.innerHTML = `<span class="lbl">${icon('section')} 断面</span>` + ['X', 'Y', 'Z'].map(a => `<button data-sax="${a}" class="${a === k.axis ? 'on' : ''}" style="color:var(--${a.toLowerCase()})">${a}</button>`).join('') +
    `<input type="range" id="sec_pos" min="${lo - pad}" max="${hi + pad}" step="${(hi - lo + 2 * pad) / 400}" value="${k.pos}"><span class="val">${k.pos.toFixed(2)}</span>` +
    `<button id="sec_flip" data-tip="反対側を見る">${icon('flip')}</button><button id="sec_off" data-tip="断面表示を終了">${icon('close')}</button>`;
  sectionBar.querySelectorAll('[data-sax]').forEach(b => b.onclick = () => { k.axis = b.dataset.sax; k.pos = boxOf(Object.keys(S.groups)).getCenter(new T.Vector3()).getComponent('XYZ'.indexOf(k.axis)) || 0; applySection(); });
  $('sec_pos').oninput = e => { k.pos = +e.target.value; R.clippingPlanes = [k.plane]; k.plane.setFromNormalAndCoplanarPoint(AX[k.axis].clone().multiplyScalar(k.flip ? 1 : -1), AX[k.axis].clone().multiplyScalar(k.pos)); sectionBar.querySelector('.val').textContent = k.pos.toFixed(2); };
  $('sec_flip').onclick = () => { k.flip = !k.flip; applySection(); };
  $('sec_off').onclick = () => run('view.section');
}
A('view.section', '断面表示', '表示', () => {
  if (S.section) S.section = null;
  else { const c = boxOf(Object.keys(S.groups)).getCenter(new T.Vector3()); S.section = {axis: 'X', pos: c.x || 0, flip: false, plane: new T.Plane()}; }
  applySection(); renderStatus(); renderTools();
});

// ------------------------------------------------------------------ work plane: where drawing lands when no face is under the pointer
function applyWorkPlane() {
  const w = S.workPlane;
  grid.position.copy(w ? w.o : new T.Vector3());
  grid.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), w ? w.n : new T.Vector3(0, 0, 1)); // the grid helper lies in its own XZ plane
  renderStatus(); renderTools();
}
A('plane.set', '作業平面を設定', 'スケッチ', () => {
  const f = S.sel.faces.at(-1);
  const d = parseFloat(prompt(f?.normal ? '選択した面からの距離（0 でその面の上）' : '地面からの高さ', '0'));
  if (!isFinite(d)) return;
  const n = f?.normal ? V(f.normal).normalize() : new T.Vector3(0, 0, 1), o = (f?.normal ? V(f.point) : new T.Vector3()).addScaledVector(n, d);
  S.workPlane = (!f?.normal && Math.abs(d) < 1e-9) ? null : {o, n};
  applyWorkPlane(); toast(S.workPlane ? '作業平面を設定' : '作業平面: 地面');
});
A('plane.clear', '作業平面を地面に戻す', 'スケッチ', () => { S.workPlane = null; applyWorkPlane(); toast('作業平面: 地面'); });

// labels for parameters in the inspector
const DIM_JA = {at: '位置', pivot: '中心', origin: '原点', normal: '向き', xdir: 'X の向き', on_body: '描いた面', body: 'ボディ', target: '対象', tools: '道具', kind: '種類', mode: 'モード', name: '名前', translate: '移動', rotate: '回転', offset: 'ずらす', merge: '元と結合', keep: '残す側', step: '間隔', axis_origin: '軸の位置', axis_dir: '軸の向き', corners: '角', ring: '帯にする', profile: '断面', smooth: 'なめらか', color: '色', finish: '仕上げ', points: '点', bulges: '円弧', faces: '面', edges: 'エッジ', open_at: '開ける面', to_solid: 'ソリッドにする', format: '形式', sections: '断面', grid: '制御点', width: '幅', depth: '奥行', height: '高さ', radius: '半径', radius_top: '上の半径', radius_bottom: '下の半径', major_radius: '大半径', minor_radius: '小半径',
  keep_face: '面を残す', by: '動かす量', surface: '面の形', a: '始点', b: '終点', axis: '向き', ruled: '直線でつなぐ', top_radius: '上の半径', bottom_radius: '下の半径', keep_tools: '道具を残す', blob: 'データ', thickness: '厚み', amount: '距離', distance: '距離', length: '長さ', angle: '角度', size: 'サイズ', scale: '倍率', fillet: '角の丸み', taper: '勾配', count: '個数', twist: 'ねじり', x: 'X', y: 'Y', z: 'Z'};

// ------------------------------------------------------------------ document name and autosave
function setDocName(n) { S.docName = (n || '').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 60) || 'nerikone'; document.title = S.docName === 'nerikone' ? 'Nerikone' : `${S.docName} · Nerikone`;  renderTop(); }
A('file.saveas', '名前を付けて保存 (.nrk)', 'ファイル', () => { const n = prompt('ファイル名', S.docName || 'nerikone'); if (n == null) return; setDocName(n); download('nrk'); });
// Keep a copy of the document in this browser, so a restart of the app (or a lost session) does not lose the work.
const AUTOSAVE = 'nerikone.autosave.v1';
let autosaveT;
function autosave() {
  clearTimeout(autosaveT);
  autosaveT = setTimeout(async () => {
    try {
      if (!S.doc.features.length) return; // an empty document never replaces a saved one
      const r = await fetch('api/export?fmt=nrk'); if (!r.ok) return;
      const text = await r.text();
      if (text.length < 3e6) localStorage.setItem(AUTOSAVE, JSON.stringify({time: Date.now(), name: S.docName || 'nerikone', features: S.doc.features.length, doc: text}));
    } catch { /* storage full or offline: skip */ }
  }, 1500);
}
function savedCopy() { try { const d = JSON.parse(localStorage.getItem(AUTOSAVE) || 'null'); return d?.doc ? d : null; } catch { return null; } }
A('file.restore', '自動保存から復元', 'ファイル', async () => {
  const d = savedCopy(); if (!d) return toast('自動保存はありません');
  try { S.framed = false; applyState(await req('POST', 'api/import?filename=autosave.nrk', d.doc, true)); setDocName(d.name); toast('自動保存から復元しました'); }
  catch (err) { reportError(err.message, '復元'); }
});
try { S.meshQ = localStorage.getItem('nerikone.meshQ') || 'normal'; } catch { S.meshQ = 'normal'; }

// ------------------------------------------------------------------ start
startTranslating();
S.cmds = Object.fromEntries((await get('api/commands')).map(c => [c.id, c]));
resize(); renderTools(); applyShading();
await load();
registerWebMCP();
if (S.public) setTimeout(() => toast('公開版: 使わないとモデルは消えます'), 1200);
const tick = () => { orbit.update(); drawNavGizmo(); updateViewLabel(); placeRulerLabels(); placeDimLabels(); R.render(scene, cam); };
R.setAnimationLoop(tick);
window.nerikone = {S, get cam() { return cam; }, orbit, handles, setMode, setRender, setView, frame, run, tick, registerWebMCP}; // debugging / UI tests
