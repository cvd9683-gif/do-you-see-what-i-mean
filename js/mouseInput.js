// Demo mode: the same brush, steered by a mouse, pen or finger instead of a face.
// Produces the same brush-state shape as BrushMapper so the game loop doesn't care which is used.

import { CANVAS_W, CANVAS_H, PALETTE } from './config.js';
import { clamp } from './mapping.js';

export class MouseInput {
  constructor(canvas) {
    this.canvas = canvas;
    this.colorIndex = 0;
    this.baseSize = 34;
    this.keys = new Set();
    this.events = [];
    this.facialInput = null;
    this.state = {
      present: false,
      x: CANVAS_W / 2,
      y: CANVAS_H / 2,
      size: this.baseSize,
      shape: 'line',
      rotation: 0,
      color: PALETTE[0],
      opacity: 0.7,
      painting: false,
      holdProgress: 0,
      signals: { mouth: 0, smile: 0, brow: 0, browUp: 0, blink: 0, tilt: 0 },
    };
    this._handlers = [];
  }

  attach() {
    const on = (el, type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      this._handlers.push(() => el.removeEventListener(type, fn, opts));
    };
    const toLogical = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.state.x = clamp(((e.clientX - r.left) / r.width) * CANVAS_W, 0, CANVAS_W);
      this.state.y = clamp(((e.clientY - r.top) / r.height) * CANVAS_H, 0, CANVAS_H);
      this.state.present = true;
    };
    on(this.canvas, 'pointermove', toLogical);
    on(this.canvas, 'pointerdown', (e) => {
      toLogical(e);
      this.canvas.setPointerCapture(e.pointerId);
      this.state.painting = true;
      e.preventDefault();
    });
    const up = () => (this.state.painting = false);
    on(this.canvas, 'pointerup', up);
    on(this.canvas, 'pointercancel', up);
    on(this.canvas, 'pointerleave', () => !this.state.painting && (this.state.present = false));
    on(this.canvas, 'wheel', (e) => {
      this.baseSize = clamp(this.baseSize - Math.sign(e.deltaY) * 6, 10, 130);
      e.preventDefault();
    }, { passive: false });
    on(window, 'keydown', (e) => {
      if (e.target.closest?.('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'c' && !e.repeat) this.nextColor('key');
      if (k === '=' || k === '+') this.baseSize = clamp(this.baseSize + 6, 10, 130);
      if (k === '-') this.baseSize = clamp(this.baseSize - 6, 10, 130);
      this.keys.add(k);
    });
    on(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
  }

  detach() {
    this._handlers.forEach((off) => off());
    this._handlers = [];
    this.keys.clear();
    this.state.painting = false;
  }

  // Called once per animation frame. Held keys stand in for expressions.
  tick(dt) {
    const s = this.state;
    s.shape = this.keys.has('s') ? 'rounded' : this.keys.has('f') ? 'angular' : 'line';
    if (this.keys.has('q')) s.rotation = clamp(s.rotation - dt * 0.12, -90, 90);
    if (this.keys.has('e')) s.rotation = clamp(s.rotation + dt * 0.12, -90, 90);
    s.size = this.baseSize;
    s.color = PALETTE[this.colorIndex];
    s.opacity = clamp(0.78 - s.size / 420, 0.45, 0.78);
    return s;
  }

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
