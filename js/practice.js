// Practice: an untimed sandbox between calibration and the real round.
// Its marks live only in this object and are thrown away before the round starts.

import { Painter } from './renderer.js';
import { DabTrail } from './mapping.js';
import { createMark, uid } from './session.js';

const TARGETS = [
  { x: 230, y: 200 },
  { x: 970, y: 600 },
];
const TARGET_R = 70;
const TARGET_DWELL_MS = 250;
const PAINT_GOAL = 6;

export class Practice {
  constructor(canvas) {
    this.painter = new Painter(canvas);
    this.reset();
  }

  reset() {
    this.targets = TARGETS.map((p) => ({ ...p, hit: false, dwell: 0 }));
    this.objectives = { targets: 0, paint: false, expression: false };
    this.painted = 0;
    this.lastT = null;
    this.clearMarks();
  }

  // "Clear practice": wipes the canvas but keeps completed objectives.
  clearMarks() {
    this.marks = [];
    this.trail = new DabTrail();
    this.painter.clearLayer();
  }

  get allDone() {
    const o = this.objectives;
    return o.targets === this.targets.length && o.paint && o.expression;
  }

  tick(now, brush) {
    const dt = this.lastT == null ? 0 : Math.min(100, now - this.lastT);
    this.lastT = now;

    // Objective 1: steer into both circles (a short dwell so passing through doesn't count).
    for (const tg of this.targets) {
      if (tg.hit) continue;
      const inside = brush.present && Math.hypot(brush.x - tg.x, brush.y - tg.y) <= TARGET_R;
      tg.dwell = inside ? tg.dwell + dt : 0;
      if (tg.dwell >= TARGET_DWELL_MS) tg.hit = true;
    }
    this.objectives.targets = this.targets.filter((t) => t.hit).length;

    // Objectives 2 and 3: paint, and change the mark with an expression.
    const strokeId = this.trail.step(brush, now, () => uid('k'));
    if (strokeId) {
      const mark = createMark({ brush, facialInput: null, timestamp: 0, strokeId });
      this.marks.push(mark);
      this.painter.addMark(mark);
      this.painted++;
      if (this.painted >= PAINT_GOAL) this.objectives.paint = true;
      if (mark.visualOutput.shape !== 'line') this.objectives.expression = true;
    }

    const c = this.painter.composite();
    this.targets.forEach((tg, i) => drawTarget(c, tg, i + 1));
    this.painter.drawCursor(brush);
  }
}

function drawTarget(c, tg, n) {
  c.save();
  c.lineWidth = 3;
  c.strokeStyle = '#141414';
  c.setLineDash(tg.hit ? [] : [8, 7]);
  c.fillStyle = tg.hit ? 'rgba(19,138,91,0.28)' : 'rgba(255,255,255,0.35)';
  c.beginPath();
  c.arc(tg.x, tg.y, TARGET_R, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = '#141414';
  c.font = '800 34px "Bricolage Grotesque", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(tg.hit ? '✓' : String(n), tg.x, tg.y);
  c.restore();
}
