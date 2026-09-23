// Gesture → brush. The model reports numbers; this module decides what those numbers paint.
// Nothing here "understands" a face: it just thresholds and scales measurements,
// relative to the player's own calibration.

import { CANVAS_W, CANVAS_H, PALETTE, DEFAULT_SETTINGS } from './config.js';
import { DEFAULT_CALIBRATION, smileOf, browDownOf, blinkOf } from './calibration.js';

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// 1€ filter (Casiez et al.): heavy smoothing when the head is still (kills jitter),
// light smoothing when it moves fast (keeps the cursor responsive).
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

// Map a head measurement to 0..1 across the canvas.
// Each side of neutral is scaled separately to the player's calibrated comfortable extreme;
// `reach` < 1 means you only need that fraction of it to hit the edge. A small dead zone
// around neutral keeps the cursor calm when the head is "centred".
export function mapAxis(v, neg, neutral, pos, reach = DEFAULT_SETTINGS.reach, dead = DEFAULT_SETTINGS.deadZone) {
  let o;
  if ((v - neutral) * (neg - neutral) > 0) o = -clamp((v - neutral) / ((neg - neutral) * reach));
  else o = clamp((v - neutral) / ((pos - neutral) * reach));
  const a = Math.abs(o);
  const shaped = a <= dead ? 0 : (a - dead) / (1 - dead);
  return 0.5 + 0.5 * Math.sign(o) * shaped;
}

// 0 at rest, 1 at the calibrated comfortable maximum.
export const normalize = (v, { rest, max }) => clamp((v - rest) / Math.max(0.05, max - rest));

// Output only moves once the target is more than `d` px away, then trails it by `d`.
export const deadband = (prev, next, d = 3) => (Math.abs(next - prev) <= d ? prev : next - Math.sign(next - prev) * d);

const round3 = (v) => Math.round(v * 1000) / 1000;

// Paint gate thresholds on the normalized mouth signal (with hysteresis).
export const PAINT_ON = 0.35;
export const PAINT_OFF = 0.2;

export function pickShape(smile, brow) {
  if (smile > 0.5 && smile >= brow) return 'rounded';
  if (brow > 0.5) return 'angular';
  return 'line';
}

export function sizeFromMouth(m) {
  return 16 + Math.pow(clamp((m - PAINT_OFF) / (1 - PAINT_OFF)), 1.1) * 96;
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
    // Which face gesture changes color: a deliberate blink if calibration found blinks reliable,
    // otherwise a held eyebrow raise (and then only a furrow makes angular marks, so they don't clash).
    this.colorInput = calibration.blink?.reliable ? 'blink' : 'browRaise';
    this._mouthOpenSince = null;
    this._blink = { closedSince: null, openSince: null, fired: false, armed: true };
    this._raise = { since: null, lowSince: null, fired: false, armed: true };
    this._lastColorAt = -Infinity;
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
      charging: 0, // 0..1 while the mouth is open but paint hasn't started yet
      holdProgress: 0, // 0..1 while a deliberate blink is being held
      signals: this.sig,
    };
  }

  get blinkEnabled() {
    return this.colorInput === 'blink';
  }

  // Called for every tracked video frame (~30/s). f.t is in milliseconds.
  update(f) {
    const st = this.state;
    if (!f.present) {
      st.present = false;
      st.painting = false;
      st.charging = 0;
      st.holdProgress = 0;
      this._mouthOpenSince = null;
      this._blink.closedSince = null;
      return st;
    }
    st.present = true;
    const c = this.cal;
    const n = c.neutral;
    const t = f.t / 1000;

    // Position: calibrated head pose → full canvas, then 1€ smoothing and a tiny dead-band.
    const nx = mapAxis(f.headX, c.headX.neg, n.headX, c.headX.pos, this.settings.reach, this.settings.deadZone);
    const ny = mapAxis(f.headY, c.headY.neg, n.headY, c.headY.pos, this.settings.reach, this.settings.deadZone);
    st.x = deadband(st.x, clamp(this.fx.filter(nx * this.w, t), 0, this.w));
    st.y = deadband(st.y, clamp(this.fy.filter(ny * this.h, t), 0, this.h));

    // Expressions: normalize per player, then an exponential moving average.
    const ema = (prev, next, a = 0.4) => prev + a * (next - prev);
    const s = this.sig;
    const furrow = normalize(browDownOf(f), c.brow.down);
    const raise = normalize(f.browUp, c.brow.up);
    const browRaw = this.colorInput === 'browRaise' ? furrow : Math.max(furrow, raise);
    s.browUp = ema(s.browUp, raise);
    s.mouth = ema(s.mouth, normalize(f.mouthOpen, c.mouthOpen));
    s.smile = ema(s.smile, normalize(smileOf(f), c.smile));
    s.brow = ema(s.brow, browRaw);
    s.blink = clamp((blinkOf(f) - c.blink.rest) / Math.max(0.05, c.blink.threshold - c.blink.rest));
    s.tilt = ema(s.tilt, clamp(f.tilt - n.tilt, -45, 45), 0.3);

    st.shape = pickShape(s.smile, s.brow);
    st.size = sizeFromMouth(s.mouth);
    st.rotation = clamp(s.tilt * 1.6, -90, 90);
    st.opacity = clamp(0.8 - st.size / 420, 0.5, 0.8);
    st.color = PALETTE[this.colorIndex];

    // Paint only after the mouth has been open for a beat (ignores talking and yawning blips),
    // with hysteresis so it doesn't flicker near the threshold. Closed mouth = move freely.
    const openNow = st.painting ? s.mouth > PAINT_OFF : s.mouth > PAINT_ON;
    if (openNow) {
      this._mouthOpenSince ??= f.t;
      const held = f.t - this._mouthOpenSince;
      st.painting = held >= this.settings.paintStartMs;
      st.charging = st.painting ? 0 : clamp(held / this.settings.paintStartMs);
    } else {
      this._mouthOpenSince = null;
      st.painting = false;
      st.charging = 0;
    }

    st.holdProgress = 0;
    if (this.colorInput === 'blink') this._updateBlink(f);
    else this._updateBrowRaise(f);

    this.facialInput = {
      mouthOpen: round3(f.mouthOpen),
      smile: round3(smileOf(f)),
      browMovement: round3(Math.max(browDownOf(f), f.browUp)),
      blink: round3(blinkOf(f)),
      headX: round3(nx),
      headY: round3(ny),
      headTilt: Math.round(f.tilt - n.tilt),
    };
    return st;
  }

  // A deliberate blink changes color. Protected against repeats four ways: both eyes must close
  // past a strong, personally calibrated threshold; the blink must be held longer than a natural
  // one; the eyes must reopen for a while before the next one counts; and there is a cooldown.
  _updateBlink(f) {
    const b = this._blink;
    const cfg = this.settings;
    const closed = blinkOf(f) > this.cal.blink.threshold;
    if (closed) {
      b.openSince = null;
      b.closedSince ??= f.t;
      const held = f.t - b.closedSince;
      if (b.armed && !b.fired) this.state.holdProgress = clamp(held / cfg.blinkHoldMs);
      if (held >= cfg.blinkHoldMs && b.armed && !b.fired && f.t - this._lastColorAt >= cfg.colorCooldownMs) {
        b.fired = true;
        b.armed = false;
        this._lastColorAt = f.t;
        this.nextColor('blink');
      }
    } else {
      b.closedSince = null;
      b.fired = false;
      b.openSince ??= f.t;
      if (f.t - b.openSince >= cfg.blinkRearmMs) b.armed = true;
    }
  }

  // Fallback when blinks can't be told apart: a held, strong eyebrow raise.
  _updateBrowRaise(f) {
    const r = this._raise;
    const cfg = this.settings;
    const up = this.sig.browUp;
    if (up > 0.7) {
      r.lowSince = null;
      r.since ??= f.t;
      const held = f.t - r.since;
      if (r.armed && !r.fired) this.state.holdProgress = clamp(held / cfg.browRaiseHoldMs);
      if (held >= cfg.browRaiseHoldMs && r.armed && !r.fired && f.t - this._lastColorAt >= cfg.colorCooldownMs) {
        r.fired = true;
        r.armed = false;
        this._lastColorAt = f.t;
        this.nextColor('browRaise');
      }
    } else {
      r.since = null;
      r.fired = false;
      if (up < 0.3) {
        r.lowSince ??= f.t;
        if (f.t - r.lowSince >= cfg.blinkRearmMs) r.armed = true;
      }
    }
  }

  // Every color change (face, click or key) goes through here and is emitted as an event,
  // so the game can record it with a timestamp.
  setColor(index, via) {
    if (index === this.colorIndex || index < 0 || index >= PALETTE.length) return;
    const previousColor = PALETTE[this.colorIndex];
    this.colorIndex = index;
    this.state.color = PALETTE[index];
    this.events.push({ type: 'color', via, previousColor, newColor: PALETTE[index] });
  }

  nextColor(via = 'key') {
    this.setColor((this.colorIndex + 1) % PALETTE.length, via);
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}

// Turns a continuous "mouth open" into discrete, evenly spaced marks (dabs).
// Shared by the practice canvas and the real round so both paint identically.
export class DabTrail {
  constructor() {
    this.strokeId = null;
    this.last = null;
    this.lastAt = 0;
  }
  // Returns the strokeId to use if a dab should be laid now, otherwise null.
  step(brush, now, makeId) {
    if (!(brush.present && brush.painting)) {
      this.strokeId = null;
      return null;
    }
    if (!this.strokeId) {
      this.strokeId = makeId();
      this.last = null;
    }
    const spacing = Math.max(5, brush.size * 0.28);
    const far = !this.last || Math.hypot(brush.x - this.last.x, brush.y - this.last.y) >= spacing;
    if (far || now - this.lastAt > 260) {
      this.last = { x: brush.x, y: brush.y };
      this.lastAt = now;
      return this.strokeId;
    }
    return null;
  }
}
