// Canvas rendering. Marks are drawn from their JSON on demand; the pixels are a view, not the data.

import { CANVAS_W, CANVAS_H } from './config.js';

export const SCALE = 1.5; // backing-store pixels per logical unit (crisp on high-DPI screens)
const PAPER = '#F5F0E6';

// Deterministic PRNG so a mark looks identical every time it is re-rendered from its seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const makeCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

// Paper with grain and faint fibres, generated once.
let paperCache = null;
export function paperTexture() {
  if (paperCache) return paperCache;
  const w = CANVAS_W * SCALE, h = CANVAS_H * SCALE;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const r = rng(7);
  for (let i = 0; i < d.length; i += 4) {
    const g = (r() - 0.5) * 16;
    d[i] += g;
    d[i + 1] += g;
    d[i + 2] += g - 1;
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const x = r() * w, y = r() * h, a = r() * Math.PI, l = 6 + r() * 26;
    ctx.strokeStyle = r() > 0.5 ? 'rgba(90,70,40,0.07)' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 0.6 + r();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + r() * 4, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  paperCache = c;
  return c;
}

// Closed wobbly curve through points (midpoint quadratic smoothing).
function smoothClosed(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i], m = mid(p, pts[(i + 1) % n]);
    ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  ctx.closePath();
}

// Watercolor-ish blob: several translucent wobbly layers, a darker pooled edge, granulation.
function drawRounded(ctx, v, r) {
  const R = v.size / 2;
  let last;
  for (let layer = 0; layer < 4; layer++) {
    const n = 22, ph = r() * 6.28, amp = 0.06 + r() * 0.12, ox = (r() - 0.5) * R * 0.18, oy = (r() - 0.5) * R * 0.18;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rad = R * (0.86 + amp * Math.sin(a * 3 + ph) + (r() - 0.5) * 0.1) * (1 - layer * 0.06);
      pts.push([ox + Math.cos(a) * rad, oy + Math.sin(a) * rad * 0.94]);
    }
    smoothClosed(ctx, pts);
    ctx.fillStyle = rgba(v.color, 0.26);
    ctx.fill();
    last = pts;
  }
  smoothClosed(ctx, last);
  ctx.strokeStyle = rgba(v.color, 0.4);
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.stroke();
  const dots = Math.min(90, 8 + R * 0.9);
  ctx.fillStyle = rgba(v.color, 0.35);
  for (let i = 0; i < dots; i++) {
    const a = r() * 6.28, d = Math.sqrt(r()) * R * 0.85;
    ctx.fillRect(Math.cos(a) * d, Math.sin(a) * d, 0.6 + r() * 1.6, 0.6 + r() * 1.6);
  }
}

// Sharp shard pointing along the mark's rotation, with scratched hatching.
function drawAngular(ctx, v, r) {
  const R = v.size / 2;
  let pts;
  for (let layer = 0; layer < 3; layer++) {
    const j = () => (r() - 0.5) * R * 0.25;
    pts = [
      [R * 1.25 + j(), j() * 0.4],
      [-R * 0.55 + j(), -R * (0.45 + r() * 0.45) + j()],
      [-R * (0.2 + r() * 0.3) + j(), j() * 0.5],
      [-R * 0.7 + j(), R * (0.4 + r() * 0.45) + j()],
    ];
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fillStyle = rgba(v.color, 0.3);
    ctx.fill();
  }
  ctx.strokeStyle = rgba(v.color, 0.7);
  ctx.lineCap = 'round';
  const scratches = 3 + Math.floor(r() * 5);
  for (let i = 0; i < scratches; i++) {
    const t = r() - 0.5;
    ctx.lineWidth = 0.6 + r() * 1.6;
    ctx.beginPath();
    ctx.moveTo(-R * 0.5, t * R * 1.1);
    ctx.lineTo(R * (0.5 + r() * 0.7), t * R * 0.25);
    ctx.stroke();
  }
}

// Dry-brush stroke: many thin bristle lines with breaks, so paper shows through.
function drawLine(ctx, v, r) {
  const L = v.size * 1.6, W = Math.max(3, v.size * 0.34);
  const bristles = Math.round(8 + W * 0.7);
  const sag = (r() - 0.5) * W * 0.8;
  ctx.lineCap = 'round';
  for (let b = 0; b < bristles; b++) {
    const off = (b / (bristles - 1) - 0.5) * W + (r() - 0.5) * 2;
    ctx.strokeStyle = rgba(v.color, 0.25 + r() * 0.45);
    ctx.lineWidth = 0.7 + r() * 2.2;
    let x = -L / 2 + r() * L * 0.12;
    const end = L / 2 - r() * L * 0.15;
    while (x < end) {
      const seg = L * (0.15 + r() * 0.45);
      const x2 = Math.min(end, x + seg);
      const y1 = off + sag * (1 - ((2 * x) / L) ** 2);
      const y2 = off + sag * (1 - ((2 * x2) / L) ** 2);
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      x = x2 + r() * L * 0.08; // a gap where the brush skipped
    }
  }
}

const easeOut = (t) => 1 - (1 - t) ** 3;

// Draw one mark into a context already scaled to logical units. progress < 1 animates it in.
export function drawMark(ctx, mark, progress = 1) {
  const v = mark.visualOutput;
  const r = rng(v.seed);
  const p = easeOut(Math.min(1, Math.max(0, progress)));
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.rotate((v.rotation * Math.PI) / 180);
  const s = 0.3 + 0.7 * p;
  ctx.scale(s, s);
  ctx.globalAlpha = v.opacity * Math.min(1, p * 1.4);
  if (v.shape === 'rounded') drawRounded(ctx, v, r);
  else if (v.shape === 'angular') drawAngular(ctx, v, r);
  else drawLine(ctx, v, r);
  ctx.restore();
}

// Approximate hit area in the mark's local (rotated) frame.
export function hitTest(marks, x, y) {
  for (let i = marks.length - 1; i >= 0; i--) {
    const v = marks[i].visualOutput;
    const a = (-v.rotation * Math.PI) / 180;
    const dx = x - v.x, dy = y - v.y;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    const R = v.size / 2 + 4;
    if (v.shape === 'line') {
      if (Math.abs(lx) <= v.size * 0.8 + 4 && Math.abs(ly) <= Math.max(8, v.size * 0.2 + 4)) return marks[i];
    } else if (v.shape === 'angular') {
      if (lx >= -R * 0.8 && lx <= R * 1.3 && Math.abs(ly) <= R * 0.85) return marks[i];
    } else if (lx * lx + ly * ly <= R * R) return marks[i];
  }
  return null;
}

// A painting surface: paper + an offscreen paint layer + a per-frame overlay (cursor, selection).
export class Painter {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = CANVAS_W * SCALE;
    canvas.height = CANVAS_H * SCALE;
    this.ctx = canvas.getContext('2d');
    this.layer = makeCanvas(canvas.width, canvas.height);
    this.lctx = this.layer.getContext('2d');
    this.lctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    this.lctx.globalCompositeOperation = 'multiply'; // overlapping pigment darkens like real paint
  }

  clearLayer() {
    this.lctx.save();
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lctx.clearRect(0, 0, this.layer.width, this.layer.height);
    this.lctx.restore();
  }

  addMark(mark, progress = 1) {
    drawMark(this.lctx, mark, progress);
  }

  // Full rebuild from JSON (after undo, edits, restore).
  redraw(marks, skip = null) {
    this.clearLayer();
    for (const m of marks) if (m !== skip) drawMark(this.lctx, m);
  }

  // Composite paper + paint to the visible canvas. Returns ctx in logical units for overlays.
  composite() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.drawImage(paperTexture(), 0, 0);
    c.globalCompositeOperation = 'multiply';
    c.drawImage(this.layer, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    return c;
  }

  // The cursor: always a high-contrast ring (so you can find it), plus a ghost of the mark
  // you'd make — dashed while moving, solid in color while painting.
  drawCursor(brush) {
    const c = this.ctx;
    const { x, y, size, rotation, shape, color, painting, charging = 0, holdProgress = 0, present } = brush;
    if (!present) return;
    const R = size / 2;
    c.save();
    c.translate(x, y);
    c.rotate((rotation * Math.PI) / 180);
    c.strokeStyle = painting ? color : 'rgba(20,20,20,0.55)';
    c.lineWidth = painting ? 2.5 : 1.5;
    c.setLineDash(painting ? [] : [5, 5]);
    c.beginPath();
    if (shape === 'rounded') c.arc(0, 0, R, 0, Math.PI * 2);
    else if (shape === 'angular') {
      c.moveTo(R * 1.25, 0);
      c.lineTo(-R * 0.6, -R * 0.7);
      c.lineTo(-R * 0.6, R * 0.7);
      c.closePath();
    } else {
      c.moveTo(-size * 0.8, 0);
      c.lineTo(size * 0.8, 0);
    }
    c.stroke();
    c.restore();

    // Locator ring: light halo under a dark ring reads on any paint color.
    c.save();
    c.lineWidth = 7;
    c.strokeStyle = 'rgba(245,240,230,0.9)';
    c.beginPath();
    c.arc(x, y, 13, 0, Math.PI * 2);
    c.stroke();
    c.lineWidth = 3;
    c.strokeStyle = '#141414';
    c.stroke();
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, painting ? 8 : 5, 0, Math.PI * 2);
    c.fill();
    if (charging > 0) {
      // Mouth is open: paint is about to start.
      c.strokeStyle = color;
      c.lineWidth = 4;
      c.beginPath();
      c.arc(x, y, 20, -Math.PI / 2, -Math.PI / 2 + charging * Math.PI * 2);
      c.stroke();
    }
    if (holdProgress > 0) {
      // A deliberate blink is being held (color change).
      c.strokeStyle = '#141414';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(x, y, 27, -Math.PI / 2, -Math.PI / 2 + holdProgress * Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  drawSelection(mark) {
    const c = this.ctx;
    const v = mark.visualOutput;
    const R = (v.shape === 'line' ? v.size * 0.85 : v.size * 0.7) + 8;
    c.save();
    c.strokeStyle = '#141414';
    c.lineWidth = 2;
    c.setLineDash([6, 5]);
    c.beginPath();
    c.arc(v.x, v.y, R, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  toBlob() {
    this.composite();
    return new Promise((res) => this.canvas.toBlob(res, 'image/png'));
  }
}

// Small preview (gallery thumbnails) rendered straight from JSON.
export function renderThumbnail(canvas, marks) {
  const k = canvas.width / CANVAS_W;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(paperTexture(), 0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.setTransform(k, 0, 0, k, 0, 0);
  for (const m of marks) drawMark(ctx, m);
  ctx.restore();
}
