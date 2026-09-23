// Session + mark data model and JSON (de)serialization.
// A painting is never flattened: it is a list of independent mark objects that can be re-rendered.

import { DEFAULT_SETTINGS, PALETTE, SHAPES, CANVAS_W, CANVAS_H } from './config.js';

export const SCHEMA_VERSION = 1;

export function uid(prefix = 'm') {
  const rand = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${rand.slice(0, 13)}`;
}

export function createSession({ prompt, inputMode, calibration, settings, discoveredControls = [] }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid('s'),
    prompt,
    inputMode, // 'face' | 'mouse'
    status: 'drawing', // 'drawing' | 'finished'
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: 0,
    canvas: { width: CANVAS_W, height: CANVAS_H },
    calibration: calibration ?? null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    discoveredControls: [...discoveredControls],
    marks: [],
  };
}

// Build one mark from the current brush state. `facialInput` is the snapshot of numbers
// that produced it (null in mouse mode) — never an image.
export function createMark({ brush, facialInput, timestamp, strokeId, trigger = 'paint', seed }) {
  const stamp = trigger === 'stamp';
  return {
    id: uid('m'),
    strokeId,
    timestamp: Math.round(timestamp),
    trigger, // 'paint' (mouth-open trail) | 'stamp' (long blink / dwell / space)
    source: facialInput ? 'face' : 'mouse',
    facialInput: facialInput ? { ...facialInput } : null,
    visualOutput: {
      x: Math.round(brush.x),
      y: Math.round(brush.y),
      shape: brush.shape,
      color: brush.color,
      size: Math.round(stamp ? brush.size * 1.45 + 18 : brush.size),
      rotation: Math.round(brush.rotation),
      opacity: Math.round((stamp ? Math.min(0.9, brush.opacity + 0.15) : brush.opacity) * 100) / 100,
      seed: seed ?? Math.floor(Math.random() * 2 ** 31),
    },
  };
}

const num = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const HEX = /^#[0-9a-f]{6}$/i;

// Defensive restore: anything malformed in storage is repaired or dropped, never trusted blindly.
export function sanitizeMark(m) {
  if (!m || typeof m !== 'object' || !m.visualOutput) return null;
  const v = m.visualOutput;
  return {
    id: typeof m.id === 'string' ? m.id : uid('m'),
    strokeId: m.strokeId ?? null,
    timestamp: num(m.timestamp, 0, 3_600_000, 0),
    trigger: m.trigger === 'stamp' ? 'stamp' : 'paint',
    source: m.source === 'face' ? 'face' : 'mouse',
    facialInput: m.facialInput && typeof m.facialInput === 'object' ? { ...m.facialInput } : null,
    visualOutput: {
      x: num(v.x, -200, CANVAS_W + 200, CANVAS_W / 2),
      y: num(v.y, -200, CANVAS_H + 200, CANVAS_H / 2),
      shape: SHAPES.includes(v.shape) ? v.shape : 'line',
      color: HEX.test(v.color) ? v.color : PALETTE[0],
      size: num(v.size, 4, 400, 30),
      rotation: num(v.rotation, -360, 360, 0),
      opacity: num(v.opacity, 0.05, 1, 0.7),
      seed: Number.isInteger(v.seed) ? v.seed : 1,
    },
  };
}

export function parseSession(raw) {
  let s = raw;
  if (typeof raw === 'string') {
    try {
      s = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!s || typeof s !== 'object' || !Array.isArray(s.marks) || !s.prompt) return null;
  return {
    ...s,
    schemaVersion: SCHEMA_VERSION,
    status: s.status === 'finished' ? 'finished' : 'drawing',
    elapsedMs: num(s.elapsedMs, 0, 3_600_000, 0),
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    discoveredControls: Array.isArray(s.discoveredControls) ? s.discoveredControls : [],
    marks: s.marks.map(sanitizeMark).filter(Boolean),
  };
}

export const serializeSession = (s, pretty = false) => JSON.stringify(s, null, pretty ? 2 : 0);
