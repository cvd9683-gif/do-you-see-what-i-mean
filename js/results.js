// Results: the synchronized face + painting replay, and the per-mark editor.

import { drawMark, hitTest, Painter } from './renderer.js';
import { CANVAS_W, CANVAS_H } from './config.js';
import { clamp } from './mapping.js';

// Synchronized replay: the face video and the painting share one clock.
// Round time t (ms since the shared start) ↔ video time (t + videoLeadMs) / 1000.
// While the video is playing it is the master clock (smooth, no drift); otherwise
// (no recording, paused, scrubbing, or past the end of the video) an internal clock is used.
export class SyncReplay {
  constructor({ canvas, video, onTime }) {
    this.painter = new Painter(canvas);
    this.video = video;
    this.onTime = onTime;
    this.marks = [];
    this.duration = 0;
    this.useVideo = false;
    this.lead = 0;
    this.t = 0;
    this.playing = false;
    this._drawnIdx = 0; // marks[0.._drawnIdx) are settled in the paint layer
    this._raf = 0;
    this._last = 0;
    this.GROW = 220; // each mark blooms in over this long, ending at its timestamp + GROW
  }

  // recording: { url, videoLeadMs } or null
  async load(marks, durationMs, recording) {
    this.stop();
    this.marks = [...marks].sort((a, b) => a.timestamp - b.timestamp);
    const lastMark = this.marks.length ? this.marks[this.marks.length - 1].timestamp : 0;
    this.duration = Math.max(durationMs || 0, lastMark + this.GROW, 1000);
    this.useVideo = !!recording;
    this.lead = recording?.videoLeadMs || 0;
    const v = this.video;
    v.pause();
    if (this.useVideo) {
      v.muted = true;
      v.playsInline = true;
      v.src = recording.url;
      await fixWebmDuration(v);
    } else {
      v.removeAttribute('src');
      v.load();
    }
    this.t = 0;
    this._rebuild(0);
    this._render();
  }

  get visibleCount() {
    let n = 0;
    while (n < this.marks.length && this.marks[n].timestamp <= this.t) n++;
    return n;
  }

  _videoTimeFor(t) {
    const d = Number.isFinite(this.video.duration) ? this.video.duration : Infinity;
    return Math.min(d, Math.max(0, (t + this.lead) / 1000));
  }

  _videoRunning() {
    const v = this.video;
    return this.useVideo && !v.paused && !v.ended && v.readyState >= 2;
  }

  play() {
    if (this.t >= this.duration) this.seek(0);
    this.playing = true;
    if (this.useVideo) {
      const target = this._videoTimeFor(this.t);
      if (Math.abs(this.video.currentTime - target) > 0.05) this.video.currentTime = target;
      if (this.video.currentTime < (this.video.duration || Infinity)) this.video.play().catch(() => {});
    }
    this._last = performance.now();
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame((n) => this._tick(n));
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    if (this.useVideo) {
      this.video.pause();
      // Snap both to the exact same instant.
      this.t = Math.min(this.duration, Math.max(this.t, this.video.currentTime * 1000 - this.lead));
      this.video.currentTime = this._videoTimeFor(this.t);
    }
    this._render();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  restart() {
    this.seek(0);
    this.play();
  }

  seek(ms) {
    this.t = Math.min(this.duration, Math.max(0, ms));
    if (this.useVideo) this.video.currentTime = this._videoTimeFor(this.t);
    this._render();
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this.video?.pause();
  }

  // Detach the video element from the (soon to be revoked) blob URL.
  destroy() {
    this.stop();
    if (this.video) {
      this.video.removeAttribute('src');
      this.video.load();
    }
  }

  _tick(now) {
    if (!this.playing) return;
    const dt = now - this._last;
    this._last = now;
    if (this._videoRunning()) this.t = this.video.currentTime * 1000 - this.lead;
    else this.t += dt; // no video, or the video has ended before the drawing did
    if (this.t >= this.duration) {
      this.t = this.duration;
      this.playing = false;
      this.video.pause();
      this._render();
      this.onEnd?.();
      return;
    }
    this._render();
    this._raf = requestAnimationFrame((n) => this._tick(n));
  }

  _rebuild(t) {
    this.painter.clearLayer();
    this._drawnIdx = 0;
    this._settle(t);
  }

  // Move every mark that has finished blooming into the cached paint layer.
  _settle(t) {
    while (this._drawnIdx < this.marks.length && this.marks[this._drawnIdx].timestamp + this.GROW <= t) {
      this.painter.addMark(this.marks[this._drawnIdx++]);
    }
  }

  _render() {
    const t = this.t;
    // Scrubbed backwards: rebuild from scratch. Forwards: just add what's new.
    if (this._drawnIdx > 0 && this.marks[this._drawnIdx - 1].timestamp + this.GROW > t) this._rebuild(t);
    else this._settle(t);
    const c = this.painter.composite();
    c.globalCompositeOperation = 'multiply';
    for (let i = this._drawnIdx; i < this.marks.length && this.marks[i].timestamp <= t; i++) {
      drawMark(c, this.marks[i], (t - this.marks[i].timestamp) / this.GROW);
    }
    c.globalCompositeOperation = 'source-over';
    this.onTime?.(t, this.duration);
  }
}

// MediaRecorder WebM files often have no duration in their header (duration = Infinity),
// which breaks seeking. Seeking far past the end forces the browser to compute it.
function fixWebmDuration(v) {
  return new Promise((resolve) => {
    const finish = () => {
      v.removeEventListener('durationchange', onDur);
      v.currentTime = 0;
      resolve();
    };
    const onDur = () => Number.isFinite(v.duration) && finish();
    const onMeta = () => {
      if (Number.isFinite(v.duration)) return finish();
      v.addEventListener('durationchange', onDur);
      v.currentTime = 1e7;
    };
    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta, { once: true });
    setTimeout(resolve, 3000); // never hang the results screen
  });
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
