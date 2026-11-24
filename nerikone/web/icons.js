// Icon mapping: one place to choose each icon's glyph. The UI only uses icon('name').
// Fukiai (MIT; vendor/fukiai) is the first choice: FK maps an icon name to a Fukiai glyph. Whatever Fukiai does not
// have yet falls back to Tabler Icons (MIT; loaded in index.html) through ICONS below. Draw the missing ones in
// Fukiai, run tools/sync-fukiai.py, and add them to FK; ICONS then never needs them.
import {PICTO} from './pictos.js';
import {FUKIAI} from './fukiai.js';
export const FK = {
  // already in Fukiai
  add: 'plus', close: 'xmark', check: 'checkmark', undo: 'undo', redo: 'redo', trash: 'trash', search: 'search',
  settings: 'gear', info: 'info', warn: 'warning', help: 'help', duplicate: 'duplicate', copy: 'duplicate', pencil: 'pencil',
  save: 'floppy', open: 'folder_open', new: 'document', export: 'upload', import: 'download', eye: 'eye', doc: 'document',
  'chevron-down': 'caret_down', 'chevron-right': 'caret_right', filter: 'funnel', more: 'ellipsis', circle: 'circle',
  // wanted: the names to draw in Fukiai. Each one switches over by itself once Fukiai has a glyph of that name
  // (tools/sync-fukiai.py); until then the Tabler glyph in ICONS stands in. `python3 tools/fukiai-wanted.py` lists them.
  select: 'cursor', orbit: 'orbit', pan: 'hand', grab: 'hand_grab', zoom: 'zoom_in', ruler: 'ruler', dimension: 'dimension',
  rectangle: 'rectangle', polygon: 'polygon', fit: 'fit', move: 'move', rotate: 'rotate', scale: 'resize',
  facemove: 'move_vertical', push: 'push_pull', shell: 'shell', fillet: 'fillet', chamfer: 'chamfer',
  union: 'union', cut: 'subtract', intersect: 'intersect', palette: 'palette', bucket: 'bucket', offset: 'offset',
  mirror: 'mirror', pattern: 'pattern', split: 'split', section: 'section', measure: 'measure', workplane: 'work_plane', sweep: 'sweep',
  box: 'cube', cylinder: 'cylinder', sphere: 'sphere', cone: 'cone', torus: 'torus', extrude: 'extrude', surface: 'surface',
  loft: 'loft', revolve: 'revolve', spline: 'spline', part: 'cube', shell_body: 'surface_body', mesh: 'mesh',
  'sel-edge': 'select_edge', 'sel-face': 'select_face', 'sel-body': 'select_body',
  solid: 'view_solid', wire: 'view_wire', xray: 'view_xray', render: 'render', camera: 'camera', perspective: 'perspective',
  language: 'language', keyboard: 'shortcut', sidebar: 'sidebar_left', inspector: 'sidebar_right', outliner: 'outliner',
  view: 'view', magnet: 'magnet', 'eye-off': 'eye_slash', timeline: 'history', restore: 'history', flip: 'flip',
  drawing: 'drawing', terminal: 'terminal', 'terminal-log': 'terminal_log', 'clear-all': 'clear_all',
  'alert-circle': 'warning_circle', 'circle-check': 'checkmark_circle', mouse: 'mouse', toolbar: 'toolbar',
};
export const ICONS = {
  // create
  add: 'plus', orbit: 'rotate-3d', pan: 'hand-move', grab: 'hand-grab', zoom: 'zoom-in', ruler: 'ruler-measure', palette: 'palette', bucket: 'bucket', rectangle: 'rectangle', circle: 'circle', polygon: 'polygon',
  box: 'cube', cylinder: 'cylinder', sphere: 'sphere', cone: 'cone', torus: 'chart-donut-4', extrude: 'arrow-autofit-up',
  // NURBS
  surface: 'vector-bezier-2', loft: 'stack-2', revolve: 'rotate-360', spline: 'vector-spline',
  // modify
  push: 'arrow-bar-to-up', facemove: 'arrows-move-vertical', select: 'pointer', fillet: 'border-radius', chamfer: 'border-corners', shell: 'box-model',
  union: 'layers-union', cut: 'layers-subtract', intersect: 'layers-intersect',
  move: 'arrows-move', rotate: 'rotate', scale: 'resize', duplicate: 'box-multiple', trash: 'trash', import: 'file-import',
  // file / app
  new: 'file-plus', open: 'folder-open', export: 'file-export', save: 'device-floppy',
  undo: 'arrow-back-up', redo: 'arrow-forward-up', render: 'sun', camera: 'camera', search: 'search',
  help: 'help', keyboard: 'keyboard', settings: 'settings',
  // selection / view
  'sel-face': 'shape', 'sel-edge': 'line', 'sel-body': 'box',
  solid: 'sphere', wire: 'grid-dots', xray: 'circle-dashed', perspective: 'perspective', fit: 'focus-2',
  outliner: 'list-tree', timeline: 'history', toolbar: 'layout-sidebar',
  offset: 'layers-difference', mirror: 'flip-vertical', pattern: 'grid-dots', split: 'cut', measure: 'ruler-2', section: 'square-half', workplane: 'grid-4x4', flip: 'switch-horizontal', drawing: 'file-vector', restore: 'history', sweep: 'route',
  language: 'world', sidebar: 'layout-sidebar', inspector: 'layout-sidebar-right', doc: 'file', view: 'view-360', more: 'dots', magnet: 'magnet', dimension: 'ruler-3', blank: 'blank',
  // misc
  eye: 'eye', 'eye-off': 'eye-off', info: 'info-circle', warn: 'alert-triangle', close: 'x', check: 'check',
  mesh: 'polygon', part: 'cube', shell_body: 'shape-2', mouse: 'mouse',
  pencil: 'pencil', copy: 'copy', 'chevron-down': 'chevron-down', 'chevron-right': 'chevron-right', 'alert-circle': 'alert-circle',
  'circle-check': 'circle-check', filter: 'filter', terminal: 'terminal-2', 'terminal-log': 'terminal', 'clear-all': 'clear-all',
};

// the glyph to draw for an icon name: {fk: true, ch} for Fukiai (a code point), else {fk: false, tabler} (a class name)
export function glyphFor(name) {
  const code = FUKIAI[FK[name]];
  return code ? {fk: true, ch: String.fromCodePoint(parseInt(code, 16))} : {fk: false, tabler: ICONS[name] || name};
}
export const icon = (name, cls = '') => {
  if (PICTO[name]) return PICTO[name].replace('class="pic"', `class="pic ti ${cls}"`);
  const g = glyphFor(name);
  return g.fk ? `<i class="ti fk ${cls}" aria-hidden="true">${g.ch}</i>` : `<i class="ti ti-${g.tabler} ${cls}" aria-hidden="true"></i>`;
};

export const CMD_ICON = {
  'body.box': 'box', 'body.cylinder': 'cylinder', 'body.sphere': 'sphere', 'body.cone': 'cone', 'body.torus': 'torus',
  'sketch.extrude': 'extrude', 'nurbs.surface': 'surface', 'nurbs.loft': 'loft', 'nurbs.revolve': 'revolve',
  'face.move': 'push', 'edge.fillet': 'fillet', 'edge.chamfer': 'chamfer', 'body.shell': 'shell',
  'body.boolean': 'union', 'body.transform': 'move', 'body.duplicate': 'duplicate', 'body.delete': 'trash',
  'file.import': 'import', 'face.split': 'pencil', 'dim.add': 'dimension', 'edge.move': 'move', 'sketch.line': 'pencil', 'hole.fill': 'surface', 'sketch.path': 'pencil', 'sketch.polygon': 'polygon', 'sketch.rect': 'rectangle', 'sketch.circle': 'circle', 'sketch.offset': 'offset',
  'body.mirror': 'mirror', 'body.pattern': 'pattern', 'body.split': 'split', 'nurbs.sweep': 'sweep', 'body.offset': 'scale', 'face.draft': 'perspective', 'body.section': 'section',
  'region.extrude': 'push', 'face.extrude': 'push',
};
export const cmdIcon = (f) => f.cmd === 'body.boolean' ? (f.params?.kind || 'union') : (CMD_ICON[f.cmd || f] || 'box');
