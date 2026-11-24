// Keymap: actions are registered by id; bindings map action id -> list of key combos.
// Defaults follow common 3D-tool conventions (G R S, numpad views, F3). User overrides live in this browser (localStorage) and can be
// exported / imported as JSON from the shortcut editor.
//
// Combo syntax: [Mod+][Alt+][Shift+]Key, where Mod = Ctrl on Windows/Linux and Cmd on macOS, and Key is a letter
// (G), a digit (2), Numpad7, F3, Space, Delete, Escape, Enter, Slash, Period, Home ...

export const DEFAULT_KEYMAP = {
  'mode.edge': ['2'], 'mode.face': ['3'], 'mode.body': ['4'],
  'add.menu': ['A', 'Shift+A'], 'tool.ruler': [], 'tool.dim': ['D', 'M'], 'tool.pushpull': ['P'], 'tool.orbit': ['O'], 'sketch.line': ['L'], 'sketch.rect': ['Alt+R'], 'sketch.circle': ['Alt+C'], 'sketch.poly': ['Alt+P'], 'select.all': ['Mod+A'], 'select.none': ['Alt+A', 'Escape'],
  'transform.grab': ['G'], 'transform.rotate': ['R'], 'transform.scale': ['S'],
  'edit.extrude': ['E'], 'edit.fillet': ['Mod+B', 'F'], 'edit.chamfer': ['Shift+Mod+B'], 'edit.shell': ['Shift+S'],
  'edit.duplicate': ['Shift+D'], 'edit.delete': ['X', 'Delete', 'Backspace'],
  'bool.union': ['Mod+NumpadAdd', 'Shift+U'], 'bool.cut': ['Mod+NumpadSubtract', 'Shift+C'], 'bool.intersect': ['Shift+I'],
  'view.front': ['Numpad1', 'Alt+1'], 'view.back': ['Mod+Numpad1'], 'view.right': ['Numpad3', 'Alt+3'],
  'view.left': ['Mod+Numpad3'], 'view.top': ['Numpad7', 'Alt+7'], 'view.bottom': ['Mod+Numpad7'],
  'view.iso': ['Numpad0', 'Alt+0'], 'view.ortho': ['Numpad5', 'Alt+5'], 'view.frame': ['Home', 'Period', 'NumpadDecimal'],
  'view.shading': ['Z'], 'view.render': ['Shift+Z'],
  'hide.selected': ['H'], 'hide.unhide': ['Alt+H'],
  'panel.toolbar': ['T'], 'panel.side': ['Shift+N'], 'panel.inspector': ['N', 'F9'], 'panel.console': ['Backquote'],
  'history.undo': ['Mod+Z'], 'history.redo': ['Shift+Mod+Z', 'Mod+Y'], 'command.repeat': ['Shift+R'],
  'command.palette': ['F3', 'Space', 'Slash'],
  'file.new': ['Mod+N'], 'file.open': ['Mod+O'], 'file.save': ['Mod+S'], 'file.import': ['Mod+I'], 'file.export': ['Shift+Mod+E'],
  'help.keymap': ['F1', 'Shift+Slash'],
  'view.section': ['Alt+X'], 'snap.toggle': ['Shift+Tab'], 'measure.info': ['I'], 'sketch.offset': ['Alt+O'], 'edit.mirror': ['Alt+M'], 'file.saveas': ['Shift+Mod+S'],
};

const STORE = 'nerikone.keymap.v1';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const actions = new Map(); // id -> {id, label, group, run}
let overrides = {};
try { overrides = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { overrides = {}; }

export function register(id, label, group, run) { actions.set(id, {id, label, group, run}); }
export const allActions = () => [...actions.values()];
export const bindings = id => overrides[id] ?? DEFAULT_KEYMAP[id] ?? [];
export const isCustom = id => id in overrides;

function save() { try { localStorage.setItem(STORE, JSON.stringify(overrides)); } catch { /* private mode: session only */ } }
export function setBindings(id, combos) { overrides[id] = combos; save(); }
export function resetBindings(id) { if (id) delete overrides[id]; else overrides = {}; save(); }
export const exportKeymap = () => JSON.stringify({format: 'nerikone-keymap/1', overrides}, null, 2);
export function importKeymap(text) {
  const d = JSON.parse(text);
  if (!d || typeof d.overrides !== 'object') throw new Error('not a Nerikone keymap file');
  overrides = d.overrides; save();
}

// event -> combo string
export function comboOf(e) {
  let key;
  const c = e.code || '';
  if (c.startsWith('Key')) key = c.slice(3);
  else if (c.startsWith('Digit')) key = c.slice(5);
  else if (c.startsWith('Numpad')) key = c;
  else if (c === 'Slash' || c === 'Period' || c === 'Space' || c === 'Comma' || c === 'Backquote') key = c;
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  return (mod ? 'Mod+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + key;
}
const canon = s => { // accept "Shift+Mod+B" and "Mod+Shift+B" alike
  const parts = s.split('+'), key = parts.pop() || '+';
  const m = new Set(parts);
  return (m.has('Mod') ? 'Mod+' : '') + (m.has('Alt') ? 'Alt+' : '') + (m.has('Shift') ? 'Shift+' : '') + key;
};

export function lookup(combo) {
  for (const a of actions.values()) if (bindings(a.id).some(b => canon(b) === combo)) return a;
  return null;
}
export const pretty = combo => combo.replace('Mod+', isMac ? '⌘' : 'Ctrl+').replace('Alt+', isMac ? '⌥' : 'Alt+')
  .replace('Shift+', isMac ? '⇧' : 'Shift+').replace('Numpad', 'Num ').replace('Slash', '/').replace('Period', '.');
export const shortcutOf = id => bindings(id)[0] ? pretty(bindings(id)[0]) : '';

export function conflicts() {
  const seen = {}, out = [];
  for (const a of actions.values()) for (const b of bindings(a.id)) {
    const k = canon(b);
    if (seen[k] && seen[k] !== a.id) out.push([k, seen[k], a.id]); else seen[k] = a.id;
  }
  return out;
}
