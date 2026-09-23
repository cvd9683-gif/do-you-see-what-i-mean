// Session + mark data model and JSON (de)serialization.
// A painting is never flattened: it is a list of independent mark objects that can be re-rendered.
// The face video is never part of this JSON; only metadata about whether one was recorded.

import { DEFAULT_SETTINGS, PALETTE, SHAPES, CANVAS_W, CANVAS_H, ROUND_MS, mappingsFor } from './config.js';

export const SCHEMA_VERSION = 2;

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
    roundDurationMs: ROUND_MS,
    elapsedMs: 0,
    // One shared clock for the timer, the recording and every mark. `perfMs` is the page's
    // performance.now() value at the moment the round began (only meaningful in that page load);
    // every mark timestamp is milliseconds since that moment.
    timing: { clock: 'performance.now', sharedStartEpochMs: null, sharedStartPerfMs: null, drawingDurationMs: null },
    recording: { enabled: false, mimeType: null, durationMs: null, videoLeadMs: null, storedIn: 'memory only (never saved)' },
    canvas: { width: CANVAS_W, height: CANVAS_H },
    calibration: calibration ?? null,
    mappings:
      inputMode === 'face'
        ? mappingsFor(calibration?.blink?.reliable ? 'blink' : 'browRaise')
        : { pointer: 'cursor', button: 'paint', keys: 'S rounded, F angular, Q/E rotate, C next color', palette: 'click a color' },
    // The color active at timestamp 0; every later change is a timestamped event below.
    initialColor: PALETTE[0],
    events: [], // [{ type: 'colorChange', timestamp, previousColor, newColor, input }]
    settings: { ...DEFAULT_SETTINGS, ...settings },
    discoveredControls: [...discoveredControls],
    marks: [],
  };
}

// Build one mark from the current brush state. `facialInput` is the snapshot of numbers
// that produced it (null in mouse mode) — never an image.
export function createMark({ brush, facialInput, timestamp, strokeId, seed }) {
  return {
    id: uid('mark'),
    strokeId,
    timestamp: Math.max(0, Math.round(timestamp)), // ms since the shared round start
    trigger: 'paint',
    source: facialInput ? 'face' : 'mouse',
    facialInput: facialInput ? { ...facialInput } : null,
    visualOutput: {
      x: Math.round(brush.x),
      y: Math.round(brush.y),
      shape: brush.shape,
      color: brush.color,
      size: Math.round(brush.size),
      rotation: Math.round(brush.rotation),
      opacity: Math.round(brush.opacity * 100) / 100,
      seed: seed ?? Math.floor(Math.random() * 2 ** 31),
    },
  };
}

const num = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const HEX = /^#[0-9a-f]{6}$/i;
const COLOR_INPUTS = ['blink', 'browRaise', 'click', 'key'];

export function colorChangeEvent({ timestamp, previousColor, newColor, input }) {
  return { type: 'colorChange', timestamp: Math.max(0, Math.round(timestamp)), previousColor, newColor, input };
}

function sanitizeEvent(e) {
  if (!e || e.type !== 'colorChange' || !HEX.test(e.newColor)) return null;
  return {
    type: 'colorChange',
    timestamp: num(e.timestamp, 0, 3_600_000, 0),
    previousColor: HEX.test(e.previousColor) ? e.previousColor : null,
    newColor: e.newColor,
    input: COLOR_INPUTS.includes(e.input) ? e.input : 'click',
  };
}

// Which color was active at round time t (ms)?
export function colorAt(session, t) {
  let c = session.initialColor || PALETTE[0];
  for (const e of session.events || []) if (e.timestamp <= t) c = e.newColor;
  return c;
}

// Defensive restore: anything malformed in storage is repaired or dropped, never trusted blindly.
export function sanitizeMark(m) {
  if (!m || typeof m !== 'object' || !m.visualOutput) return null;
  const v = m.visualOutput;
  return {
    id: typeof m.id === 'string' ? m.id : uid('mark'),
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
  const roundDurationMs = num(s.roundDurationMs ?? s.settings?.roundMs, 1000, 600_000, ROUND_MS);
  const elapsedMs = num(s.elapsedMs, 0, roundDurationMs, 0);
  return {
    ...s,
    schemaVersion: SCHEMA_VERSION,
    status: s.status === 'finished' ? 'finished' : 'drawing',
    roundDurationMs,
    elapsedMs,
    timing: { clock: 'performance.now', sharedStartEpochMs: null, sharedStartPerfMs: null, drawingDurationMs: null, ...(s.timing || {}) },
    // Anything that looks like media is dropped: the JSON must never carry video.
    recording: {
      enabled: !!s.recording?.enabled,
      mimeType: typeof s.recording?.mimeType === 'string' ? s.recording.mimeType : null,
      durationMs: Number.isFinite(s.recording?.durationMs) ? s.recording.durationMs : null,
      videoLeadMs: Number.isFinite(s.recording?.videoLeadMs) ? s.recording.videoLeadMs : null,
      storedIn: 'memory only (never saved)',
    },
    mappings: s.mappings && typeof s.mappings === 'object' ? s.mappings : {},
    initialColor: HEX.test(s.initialColor) ? s.initialColor : PALETTE[0],
    events: (Array.isArray(s.events) ? s.events : []).map(sanitizeEvent).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp),
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    discoveredControls: Array.isArray(s.discoveredControls) ? s.discoveredControls : [],
    marks: s.marks.map(sanitizeMark).filter(Boolean),
  };
}

export const serializeSession = (s, pretty = false) => JSON.stringify(s, null, pretty ? 2 : 0);
