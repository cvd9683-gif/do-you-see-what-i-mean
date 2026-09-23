// Results: chronological replay of a painting, and the per-mark editor.

import { drawMark, hitTest, Painter } from './renderer.js';
import { CANVAS_W, CANVAS_H } from './config.js';
import { clamp } from './mapping.js';

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Re-performs the marks in the order they were made, compressed to a few seconds.
export class Replay {
  constructor(canvas) {
    this.painter = new Painter(canvas);
    this._raf = 0;
  }

  showStatic(marks) {
    this.stop();
    this.painter.redraw(marks);
    this.painter.composite();
  }

  play(marks) {
    this.stop();
    const ordered = [...marks].sort((a, b) => a.timestamp - b.timestamp);
    if (!ordered.length || reduceMotion()) {
      this.showStatic(ordered);
      return Promise.resolve();
    }
    const span = Math.max(1, ordered[ordered.length - 1].timestamp);
    const duration = clamp(span / 8, 2500, 7000);
    const GROW = 260; // each mark blooms in over this long
    this.painter.clearLayer();
    return new Promise((resolve) => {
      const t0 = performance.now();
      let next = 0;
      const growing = [];
      const frame = (now) => {
        const t = now - t0;
        while (next < ordered.length && (ordered[next].timestamp / span) * duration <= t) {
          growing.push({ m: ordered[next], at: t });
          next++;
        }
        const c = this.painter.composite();
        c.globalCompositeOperation = 'multiply';
        for (let i = growing.length - 1; i >= 0; i--) {
          const g = growing[i];
          const p = (t - g.at) / GROW;
          if (p >= 1) {
            this.painter.addMark(g.m); // settle into the paint layer
            growing.splice(i, 1);
          } else drawMark(c, g.m, p);
        }
        c.globalCompositeOperation = 'source-over';
        if (next < ordered.length || growing.length) this._raf = requestAnimationFrame(frame);
        else {
          this.painter.composite();
          this._raf = 0;
          resolve();
        }
      };
      this._raf = requestAnimationFrame(frame);
    });
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
}

// Click a mark to select it, drag to move; recolor, resize, delete or replay it.
// Edits mutate the session's mark objects directly; onChange persists them.
export class MarkEditor {
  constructor(canvas, { onChange, onSelect }) {
    this.canvas = canvas;
    this.painter = new Painter(canvas);
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.marks = [];
    this.selected = null;
    this._drag = null;
    this._anim = 0;
    this._off = [];
  }

  open(marks) {
    this.marks = marks;
    this.selected = null;
    this.painter.redraw(marks);
    this.render();
    const on = (type, fn) => {
      this.canvas.addEventListener(type, fn);
      this._off.push(() => this.canvas.removeEventListener(type, fn));
    };
    on('pointerdown', (e) => this._down(e));
    on('pointermove', (e) => this._move(e));
    on('pointerup', () => this._up());
    on('pointercancel', () => this._up());
  }

  close() {
    this._off.forEach((f) => f());
    this._off = [];
    cancelAnimationFrame(this._anim);
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * CANVAS_W, y: ((e.clientY - r.top) / r.height) * CANVAS_H };
  }

  _down(e) {
    const p = this._pos(e);
    const hit = hitTest(this.marks, p.x, p.y);
    this.select(hit);
    if (hit) {
      this.canvas.setPointerCapture(e.pointerId);
      this._drag = { dx: p.x - hit.visualOutput.x, dy: p.y - hit.visualOutput.y, moved: false };
    }
  }

  _move(e) {
    const p = this._pos(e);
    if (this._drag && this.selected) {
      const v = this.selected.visualOutput;
      v.x = Math.round(clamp(p.x - this._drag.dx, 0, CANVAS_W));
      v.y = Math.round(clamp(p.y - this._drag.dy, 0, CANVAS_H));
      this._drag.moved = true;
      this.render();
      this.onSelect?.(this.selected);
    } else {
      this.canvas.style.cursor = hitTest(this.marks, p.x, p.y) ? 'grab' : 'default';
    }
  }

  _up() {
    if (this._drag?.moved) this.onChange?.();
    this._drag = null;
  }

  // The selected mark is lifted out of the cached layer so dragging only redraws one mark.
  select(mark) {
    this.selected = mark;
    this.painter.redraw(this.marks, mark);
    this.render();
    this.onSelect?.(mark);
  }

  selectRelative(step) {
    if (!this.marks.length) return;
    const i = this.selected ? this.marks.indexOf(this.selected) : -1;
    this.select(this.marks[(i + step + this.marks.length) % this.marks.length]);
  }

  render(progress = 1) {
    const c = this.painter.composite();
    if (!this.selected) return;
    c.globalCompositeOperation = 'multiply';
    drawMark(c, this.selected, progress);
    c.globalCompositeOperation = 'source-over';
    this.painter.drawSelection(this.selected);
  }

  update(patch) {
    if (!this.selected) return;
    Object.assign(this.selected.visualOutput, patch);
    this.render();
    this.onSelect?.(this.selected);
    this.onChange?.();
  }

  nudge(dx, dy) {
    if (!this.selected) return;
    const v = this.selected.visualOutput;
    this.update({ x: clamp(v.x + dx, 0, CANVAS_W), y: clamp(v.y + dy, 0, CANVAS_H) });
  }

  remove() {
    if (!this.selected) return;
    const i = this.marks.indexOf(this.selected);
    this.marks.splice(i, 1);
    this.selected = null;
    this.painter.redraw(this.marks);
    this.render();
    this.onSelect?.(null);
    this.onChange?.();
  }

  animateSelected() {
    if (!this.selected) return;
    cancelAnimationFrame(this._anim);
    const t0 = performance.now();
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / 900);
      this.render(p);
      if (p < 1) this._anim = requestAnimationFrame(frame);
    };
    this._anim = requestAnimationFrame(frame);
  }
}
