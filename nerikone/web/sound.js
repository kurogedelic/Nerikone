// Nerikone's interface sounds, synthesized with the Web Audio API (oscillators and envelopes; no sample files).
// sfx(name) plays one; they are short, quiet and rate-limited. The on/off switch is remembered.
const KEY = 'nerikone.sound';
let ctx = null, master = null, enabled = true, volume = 0.5;
try { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); if (typeof s.on === 'boolean') enabled = s.on; if (typeof s.volume === 'number') volume = s.volume; } catch { /* defaults */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({on: enabled, volume})); } catch { /* session only */ } };

export const soundOn = () => enabled;
export const soundVolume = () => volume;
export function setSound(on) { enabled = !!on; save(); if (master) master.gain.value = enabled ? 0.18 * volume * 2 : 0; }
export const VOLUMES = [['1/3', 0.25], ['2/3', 0.5], ['3/3', 0.85]];
export const volumeLabel = () => (VOLUMES.reduce((p, q) => Math.abs(q[1] - volume) < Math.abs(p[1] - volume) ? q : p))[0];
export function nextVolume() { const i = VOLUMES.findIndex(v => v[0] === volumeLabel()); setVolume(VOLUMES[(i + 1) % VOLUMES.length][1]); return volumeLabel(); }
export function setVolume(v) { volume = Math.max(0, Math.min(1, v)); save(); if (master) master.gain.value = enabled ? 0.18 * volume * 2 : 0; }

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = enabled ? 0.18 * volume * 2 : 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; // soften every voice
    master.connect(lp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// one voice: a note with a fast attack and an exponential decay; optional pitch glide and a second, quieter partial
function note(t, {f, f2 = f, dur = 0.08, type = 'sine', gain = 1, partial = 0, delay = 0}) {
  const a = audio(); if (!a) return;
  const start = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, start); if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, start + dur);
  g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(gain, start + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(master); o.start(start); o.stop(start + dur + 0.02);
  if (partial) note(t, {f: f * 2.01, f2: f2 * 2.01, dur: dur * 0.7, gain: gain * partial, delay});
}

// the palette: pentatonic-ish, so any order of sounds stays pleasant
const SOUNDS = {
  // ぽりん: a quick upward bubble, then a bright pluck
  click:   () => { note(0, {f: 420, f2: 900, dur: 0.07, gain: 0.5}); note(0, {f: 1480, f2: 1320, dur: 0.1, gain: 0.45, partial: 0.3, delay: 0.05}); },
  // チキ: a tiny two-part tick, its pitch varying a little so a run of them does not sound mechanical
  hover:   () => { const k = 0.92 + Math.random() * 0.16; note(0, {f: 2300 * k, dur: 0.012, gain: 0.28, type: 'triangle'}); note(0, {f: 3100 * k, dur: 0.01, gain: 0.2, type: 'triangle', delay: 0.016}); },
  snap:    () => note(0, {f: 1568, dur: 0.03, gain: 0.25}),
  tool:    () => note(0, {f: 660, f2: 990, dur: 0.07, gain: 0.45, partial: 0.3}),
  plus:    () => { note(0, {f: 988, dur: 0.05, gain: 0.4}); note(0, {f: 1319, dur: 0.07, gain: 0.4, delay: 0.045}); },
  commit:  () => { note(0, {f: 659, dur: 0.07, gain: 0.55, partial: 0.25}); note(0, {f: 988, dur: 0.13, gain: 0.55, partial: 0.25, delay: 0.065}); },
  undo:    () => note(0, {f: 740, f2: 494, dur: 0.1, gain: 0.45}),
  redo:    () => note(0, {f: 494, f2: 740, dur: 0.1, gain: 0.45}),
  error:   () => { note(0, {f: 196, f2: 147, dur: 0.16, type: 'sawtooth', gain: 0.35}); note(0, {f: 98, dur: 0.16, type: 'square', gain: 0.18}); },
  point:   () => { note(0, {f: 1175, f2: 1047, dur: 0.05, gain: 0.5, partial: 0.25}); note(0, {f: 2350, dur: 0.02, gain: 0.15, type: 'triangle', delay: 0.01}); },
  delete:  () => { note(0, {f: 440, f2: 220, dur: 0.12, gain: 0.45, type: 'triangle'}); note(0, {f: 330, f2: 165, dur: 0.14, gain: 0.3, type: 'triangle', delay: 0.05}); },
  cancel:  () => note(0, {f: 520, f2: 330, dur: 0.09, gain: 0.35, partial: 0.15}),
  file:    () => { note(0, {f: 392, dur: 0.07, gain: 0.4, partial: 0.2}); note(0, {f: 523, dur: 0.07, gain: 0.4, partial: 0.2, delay: 0.06}); note(0, {f: 784, dur: 0.12, gain: 0.4, partial: 0.2, delay: 0.12}); },
  toggle:  () => note(0, {f: 740, dur: 0.04, gain: 0.4}),
  open:    () => note(0, {f: 523, f2: 784, dur: 0.09, gain: 0.35, partial: 0.2}),
  close:   () => note(0, {f: 784, f2: 523, dur: 0.09, gain: 0.35, partial: 0.2}),
};
const last = {};
// ニュ〜ン: a held tone while something is being stretched; its pitch follows the value (up when pulling out, down when pushing in)
let drone = null;
export function dragStart() {
  if (!enabled || volume <= 0) return; const a = audio(); if (!a || drone) return;
  const o = a.createOscillator(), g = a.createGain(), lfo = a.createOscillator(), lg = a.createGain();
  o.type = 'sine'; o.frequency.value = 330; g.gain.value = 0.0001;
  lfo.frequency.value = 5.5; lg.gain.value = 3; lfo.connect(lg).connect(o.frequency); // a little vibrato
  const o2 = a.createOscillator(), g2 = a.createGain(); o2.type = 'triangle'; o2.frequency.value = 330 * 2.005; g2.gain.value = 0.18; // a thin octave above
  o.connect(g).connect(master); o2.connect(g2).connect(g);
  g.gain.setTargetAtTime(0.32, a.currentTime, 0.04); o.start(); o2.start(); lfo.start();
  drone = {o, o2, lfo, g, a};
}
export function dragValue(v, scale = 5) { // v: the value being changed; scale: how much of it is "a lot"
  if (!drone) return; const {a, o, o2} = drone;
  const st = 18 * Math.tanh(v / scale), f = 330 * Math.pow(2, st / 12);
  o.frequency.setTargetAtTime(f, a.currentTime, 0.035); o2.frequency.setTargetAtTime(f * 2.005, a.currentTime, 0.035);
}
export function dragStop() {
  if (!drone) return; const {a, o, o2, lfo, g} = drone; drone = null;
  g.gain.cancelScheduledValues(a.currentTime); g.gain.setTargetAtTime(0.0001, a.currentTime, 0.05);
  for (const x of [o, o2, lfo]) x.stop(a.currentTime + 0.3);
}
export function sfx(name) {
  if (!enabled || volume <= 0 || !SOUNDS[name]) return;
  const now = performance.now(); if (now - (last[name] || 0) < 45) return; last[name] = now;
  try { SOUNDS[name](); } catch { /* audio is a nicety, never a failure */ }
}
