// Calibration: learn this player's neutral face and how far they can comfortably move.
// Pure logic (no DOM) so it can be unit tested.

export const STEPS = [
  { key: 'neutral', say: 'Look straight at the screen and relax your face.', ms: 2200 },
  { key: 'left', say: 'Turn your head to your left.', ms: 1800 },
  { key: 'right', say: 'Now turn to your right.', ms: 1800 },
  { key: 'up', say: 'Look up.', ms: 1600 },
  { key: 'down', say: 'Look down.', ms: 1600 },
  { key: 'smile', say: 'Smile as wide as you can.', ms: 1800 },
  { key: 'mouth', say: 'Open your mouth wide.', ms: 1800 },
  { key: 'brows', say: 'Furrow your brows. Then raise them high.', ms: 2600 },
  { key: 'eyes', say: 'Close both eyes until you hear a tone.', ms: 1600 },
];

// Ignore the first moments of each step while the player reacts to the instruction.
const SETTLE_MS = 550;

// Sensible fallbacks, used for mouse mode and for any step that produced unusable data.
export const DEFAULT_CALIBRATION = {
  neutral: { headX: 0, headY: 0, tilt: 0, mouthOpen: 0.02, smile: 0.05, browDown: 0.05, browUp: 0.1, blink: 0.1 },
  headX: { neg: -0.15, pos: 0.15 },
  headY: { neg: -0.08, pos: 0.1 },
  mouthOpen: { rest: 0.02, max: 0.6 },
  smile: { rest: 0.05, max: 0.7 },
  browDown: { rest: 0.05, max: 0.5 },
  browUp: { rest: 0.1, max: 0.6 },
  blink: { rest: 0.1, threshold: 0.45, max: 0.75, reliable: true },
  defaults: true,
};

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const smileOf = (f) => (f.smileL + f.smileR) / 2;
const browDownOf = (f) => (f.browDownL + f.browDownR) / 2;
const blinkOf = (f) => Math.min(f.blinkL, f.blinkR); // both eyes must close

// Value that sits ~85% of the way toward the most extreme sample, keeping its sign.
// Robust to one-frame spikes, and does not assume which direction the movement goes.
export function extreme(values, neutral, p = 0.85) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => Math.abs(a - neutral) - Math.abs(b - neutral));
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

export class Calibrator {
  constructor(steps = STEPS) {
    this.steps = steps;
    this.samples = Object.fromEntries(steps.map((s) => [s.key, []]));
    this.index = 0;
    this.stepElapsed = 0;
    this.lastT = null;
    this.done = false;
  }

  get step() {
    return this.steps[this.index];
  }

  // Feed one frame. Time only advances while a face is visible, so looking away pauses.
  addSample(f) {
    if (this.done) return this.status(false);
    const dt = this.lastT == null ? 0 : Math.min(100, f.t - this.lastT);
    this.lastT = f.t;
    if (!f.present) return this.status(false);
    this.stepElapsed += dt;
    if (this.stepElapsed > SETTLE_MS) this.samples[this.step.key].push(f);
    let advanced = false;
    if (this.stepElapsed >= this.step.ms + SETTLE_MS) {
      this.index += 1;
      this.stepElapsed = 0;
      advanced = true;
      if (this.index >= this.steps.length) this.done = true;
    }
    return this.status(true, advanced);
  }

  status(facePresent, advanced = false) {
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    return {
      facePresent,
      advanced,
      done: this.done,
      index: this.index,
      step,
      progress: this.done ? 1 : Math.min(1, this.stepElapsed / (step.ms + SETTLE_MS)),
    };
  }

  result() {
    return computeCalibration(this.samples);
  }
}

export function computeCalibration(s) {
  const d = DEFAULT_CALIBRATION;
  const n = s.neutral || [];
  if (!n.length) return structuredClone(d);

  const neutral = {
    headX: avg(n.map((f) => f.headX)),
    headY: avg(n.map((f) => f.headY)),
    tilt: avg(n.map((f) => f.tilt)),
    mouthOpen: avg(n.map((f) => f.mouthOpen)),
    smile: avg(n.map(smileOf)),
    browDown: avg(n.map(browDownOf)),
    browUp: avg(n.map((f) => f.browUp)),
    blink: avg(n.map(blinkOf)),
  };

  // Head axes: each side must land on the opposite side of neutral with a usable span.
  const axis = (key, negStep, posStep, fallback) => {
    const c = neutral[key];
    let neg = extreme((s[negStep] || []).map((f) => f[key]), c);
    let pos = extreme((s[posStep] || []).map((f) => f[key]), c);
    const MIN = 0.025;
    const ok = Number.isFinite(neg) && Number.isFinite(pos) && neg < c - MIN && pos > c + MIN;
    if (!ok) {
      // Movement may be inverted (e.g. an unusual camera angle); accept if clearly opposite.
      if (Number.isFinite(neg) && Number.isFinite(pos) && neg > c + MIN && pos < c - MIN) return { neg, pos };
      return { neg: c + fallback.neg, pos: c + fallback.pos };
    }
    return { neg, pos };
  };

  // Expressions: rest comes from the neutral step, max from the step that asked for it.
  const expr = (step, fn, rest, fallbackSpan) => {
    const max = extreme((s[step] || []).map(fn), rest);
    return Number.isFinite(max) && max - rest > 0.12 ? { rest, max } : { rest, max: Math.min(1, rest + fallbackSpan) };
  };

  // Blink: eyelids also drop when looking down, so the threshold must clear that too.
  const closed = extreme((s.eyes || []).map(blinkOf), neutral.blink);
  const lookingDown = extreme((s.down || []).map(blinkOf), neutral.blink);
  const floor = Math.max(neutral.blink, Number.isFinite(lookingDown) ? lookingDown : neutral.blink);
  const blinkReliable = Number.isFinite(closed) && closed - floor > 0.2;
  const blink = blinkReliable
    ? { rest: neutral.blink, threshold: floor + 0.55 * (closed - floor), max: closed, reliable: true }
    : { rest: neutral.blink, threshold: Math.min(0.9, floor + 0.3), max: 1, reliable: false };

  return {
    neutral,
    headX: axis('headX', 'left', 'right', d.headX),
    headY: axis('headY', 'up', 'down', d.headY),
    mouthOpen: expr('mouth', (f) => f.mouthOpen, neutral.mouthOpen, 0.5),
    smile: expr('smile', smileOf, neutral.smile, 0.5),
    browDown: expr('brows', browDownOf, neutral.browDown, 0.4),
    browUp: expr('brows', (f) => f.browUp, neutral.browUp, 0.4),
    blink,
    defaults: false,
  };
}
