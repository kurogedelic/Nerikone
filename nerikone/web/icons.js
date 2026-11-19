// Icon mapping: one place to swap the icon font. Currently Tabler Icons webfont (MIT), loaded in index.html.
// To switch a glyph to another font, change the entry here; the UI only uses icon('name').
export const ICONS = {
  // create
  add: 'plus', ruler: 'ruler-measure', palette: 'palette', bucket: 'bucket', rectangle: 'rectangle', circle: 'circle', polygon: 'polygon',
  box: 'cube', cylinder: 'cylinder', sphere: 'sphere', cone: 'cone', torus: 'chart-donut-4', extrude: 'arrow-autofit-up',
  // NURBS
  surface: 'vector-bezier-2', loft: 'stack-2', revolve: 'rotate-360', spline: 'vector-spline',
  // modify
  push: 'arrow-bar-to-up', fillet: 'border-radius', chamfer: 'border-corners', shell: 'box-model',
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
  // misc
  eye: 'eye', 'eye-off': 'eye-off', info: 'info-circle', warn: 'alert-triangle', close: 'x', check: 'check',
  mesh: 'polygon', part: 'cube', shell_body: 'shape-2', mouse: 'mouse',
};

export const icon = (name, cls = '') => `<i class="ti ti-${ICONS[name] || name} ${cls}" aria-hidden="true"></i>`;

export const CMD_ICON = {
  'body.box': 'box', 'body.cylinder': 'cylinder', 'body.sphere': 'sphere', 'body.cone': 'cone', 'body.torus': 'torus',
  'sketch.extrude': 'extrude', 'nurbs.surface': 'surface', 'nurbs.loft': 'loft', 'nurbs.revolve': 'revolve',
  'face.move': 'push', 'edge.fillet': 'fillet', 'edge.chamfer': 'chamfer', 'body.shell': 'shell',
  'body.boolean': 'union', 'body.transform': 'move', 'body.duplicate': 'duplicate', 'body.delete': 'trash',
  'file.import': 'import',
};
export const cmdIcon = (f) => f.cmd === 'body.boolean' ? (f.params?.kind || 'union') : (CMD_ICON[f.cmd || f] || 'box');
