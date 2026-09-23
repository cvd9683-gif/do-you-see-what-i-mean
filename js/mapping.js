// Gesture → brush. The model reports numbers; this module decides what those numbers paint.
// Nothing here "understands" a face: it just thresholds and scales measurements.

import { CANVAS_W, CANVAS_H, PALETTE, DEFAULT_SETTINGS } from './config.js';
import { DEFAULT_CALIBRATION } from './calibration.js';

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// 1€ filter (Casiez et al.): heavy smoothing when the head is still (kills jitter),
// light smoothing when it moves fast (keeps the brush responsive).
export class OneEuro {
  constructor({ minCutoff = 0.3, beta = 0.002, dCutoff = 1.0 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

// Map a head measurement to 0..1 using the calibrated range on each side of neutral.
// `reach` < 1 means you only need ~75% of your calibrated turn to hit the edge.
export function mapAxis(v, neg, neutral, pos, reach = 0.75) {
  if ((v - neutral) * (neg - neutral) > 0) {
    return 0.5 - 0.5 * clamp((v - neutral) / ((neg - neutral) * reach));
  }
  return 0.5 + 0.5 * clamp((v - neutral) / ((pos - neutral) * reach));
}

// 0 at rest, 1 at ~80% of the calibrated maximum.
export const normalize = (v, { rest, max }, reach = 0.8) => clamp((v - rest) / Math.max(0.05, (max - rest) * reach));

// Output only moves once the target is more than `d` px away, then trails it by `d`.
export const deadband = (prev, next, d = 4) => (Math.abs(next - prev) <= d ? prev : next - Math.sign(next - prev) * d);

const round3 = (v) => Math.round(v * 1000) / 1000;

export function pickShape(smile, brow) {
  if (smile > 0.42 && smile >= brow) return 'rounded';
  if (brow > 0.42) return 'angular';
  return 'line';
}

export function sizeFromMouth(m) {
  return 12 + Math.pow(m, 1.15) * 108;
}

export class BrushMapper {
  constructor({ calibration = DEFAULT_CALIBRATION, settings = DEFAULT_SETTINGS, width = CANVAS_W, height = CANVAS_H } = {}) {
    this.cal = calibration;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.w = width;
    this.h = height;
    this.fx = new OneEuro();
    this.fy = new OneEuro();
    this.colorIndex = 0;
    this.events = [];
    this.sig = { mouth: 0, smile: 0, brow: 0, browUp: 0, blink: 0, tilt: 0 };
    this._mouthOpenSince = null;
    this._blinkSince = null;
    this._blinkFired = false;
    this._browUpArmed = true;
    this._lastColorAt = -Infinity;
    this._dwell = { x: 0, y: 0, since: null, fired: false };
    this.facialInput = null;
    this.state = {
      present: false,
      x: width / 2,
      y: height / 2,
      size: 20,
      shape: 'line',
      rotation: 0,
      color: PALETTE[0],
      opacity: 0.7,
      painting: false,
      holdProgress: 0,
      signals: this.sig,
    };
  }

  get stampMode() {
    return this.settings.stampMode === 'dwell' || !this.cal.blink?.reliable ? 'dwell' : 'blink';
  }

  setStampMode(mode) {
    this.settings.stampMode = mode;
  }

  // Called for every tracked video frame (~30/s). f.t is in milliseconds.
  update(f) {
    const st = this.state;
    if (!f.present) {
      st.present = false;
      st.painting = false;
      st.holdProgress = 0;
      this._mouthOpenSince = null;
      this._blinkSince = null;
      return st;
    }
    st.present = true;
    const c = this.cal;
    const t = f.t / 1000;

    // Position: calibrated head pose → canvas, then 1€ smoothing in canvas pixels.
    const nx = mapAxis(f.headX, c.headX.neg, c.neutral.headX, c.headX.pos);
    const ny = mapAxis(f.headY, c.headY.neg, c.neutral.headY, c.headY.pos);
    // A small dead-band on top absorbs the residual tremble of a head that is "holding still".
    st.x = deadband(st.x, clamp(this.fx.filter(nx * this.w, t), 0, this.w));
    st.y = deadband(st.y, clamp(this.fy.filter(ny * this.h, t), 0, this.h));

    // Expressions: normalize per player, then an exponential moving average.
    const ema = (prev, next, a = 0.35) => prev + a * (next - prev);
    const s = this.sig;
    s.mouth = ema(s.mouth, normalize(f.mouthOpen, c.mouthOpen));
    s.smile = ema(s.smile, normalize((f.smileL + f.smileR) / 2, c.smile));
    s.brow = ema(s.brow, normalize((f.browDownL + f.browDownR) / 2, c.browDown));
    s.browUp = ema(s.browUp, normalize(f.browUp, c.browUp));
    s.blink = Math.min(f.blinkL, f.blinkR);
    s.tilt = ema(s.tilt, clamp(f.tilt - c.neutral.tilt, -45, 45), 0.3);

    st.shape = pickShape(s.smile, s.brow);
    st.size = sizeFromMouth(s.mouth);
    st.rotation = clamp(s.tilt * 1.6, -90, 90);
    st.opacity = clamp(0.78 - st.size / 420, 0.45, 0.78);
    st.color = PALETTE[this.colorIndex];

    // Painting only starts after the mouth has been open for a beat (ignores talking blips),
    // and has hysteresis so it doesn't flicker on and off near the threshold.
    const openNow = st.painting ? s.mouth > 0.1 : s.mouth > 0.18;
    if (openNow) {
      this._mouthOpenSince ??= f.t;
      st.painting = f.t - this._mouthOpenSince >= this.settings.paintStartMs;
    } else {
      this._mouthOpenSince = null;
      st.painting = false;
    }

    // Color: rising edge of a brow raise, with a cooldown.
    if (s.browUp > 0.65 && this._browUpArmed && f.t - this._lastColorAt > 900) {
      this._browUpArmed = false;
      this._lastColorAt = f.t;
      this.nextColor();
      this.events.push({ type: 'color' });
    } else if (s.browUp < 0.35) {
      this._browUpArmed = true;
    }

    st.holdProgress = 0;
    if (this.stampMode === 'blink') this._updateBlink(f);
    else this._updateDwell(f);

    this.facialInput = {
      mouthOpen: round3(f.mouthOpen),
      smileLeft: round3(f.smileL),
      smileRight: round3(f.smileR),
      browDown: round3((f.browDownL + f.browDownR) / 2),
      browUp: round3(f.browUp),
      blinkLeft: round3(f.blinkL),
      blinkRight: round3(f.blinkR),
      headX: round3(nx),
      headY: round3(ny),
      headTilt: Math.round(f.tilt - c.neutral.tilt),
    };
    return st;
  }

  // A normal blink lasts ~100–150 ms. Only a held blink (both eyes) counts as a stamp.
  _updateBlink(f) {
    const closed = Math.min(f.blinkL, f.blinkR) > this.cal.blink.threshold;
    if (closed) {
      this._blinkSince ??= f.t;
      const held = f.t - this._blinkSince;
      this.state.holdProgress = clamp(held / this.settings.blinkHoldMs);
      if (held >= this.settings.blinkHoldMs && !this._blinkFired) {
        this._blinkFired = true;
        this.events.push({ type: 'stamp', via: 'blink' });
      }
    } else {
      this._blinkSince = null;
      this._blinkFired = false;
    }
  }

  // Fallback when blinks can't be told apart: hold the brush still (mouth closed) to stamp.
  _updateDwell(f) {
    const d = this._dwell;
    const st = this.state;
    const moved = Math.hypot(st.x - d.x, st.y - d.y);
    if (st.painting || moved > 22) {
      d.x = st.x;
      d.y = st.y;
      d.since = f.t;
      d.fired = false; // moving away re-arms the next dwell stamp
      return;
    }
    d.since ??= f.t;
    if (d.fired) return;
    const held = f.t - d.since;
    st.holdProgress = clamp(held / this.settings.dwellMs);
    if (held >= this.settings.dwellMs) {
      d.fired = true;
      this.events.push({ type: 'stamp', via: 'dwell' });
    }
  }

  nextColor() {
    this.colorIndex = (this.colorIndex + 1) % PALETTE.length;
    this.state.color = PALETTE[this.colorIndex];
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
