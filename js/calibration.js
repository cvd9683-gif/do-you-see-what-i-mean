// Calibration: a guided, gated sequence run before every round.
//
// It does NOT train or modify the MediaPipe model. The model is fixed; calibration only
// measures how *this* player's signals look (at rest and at a comfortable extreme), so the
// brush thresholds in mapping.js can be expressed relative to them.
//
// Each step advances only after its action is detected and held, or after the player
// explicitly chooses a fallback. Pure logic (no DOM) so it can be unit tested.

export const HOLD_MS = 1000; // main actions are held about one second
const SIDE_HOLD_MS = 800; // each side of a head turn/nod (two sides ≈ 1.6 s total)
const RELAX_MS = 400; // returning to neutral
const BLINK_MS = 300; // a deliberate blink: well past a natural ~120 ms blink
export const STRUGGLE_MS = 10_000; // after this long without success, offer a fallback
export const COMPLETE_SHOW_MS = 1200; // how long "COMPLETE" stays up before the next step

// Detection thresholds, as offsets from the player's own neutral values.
const T = { headX: 0.035, headY: 0.022, mouth: 0.18, mouthClosed: 0.08, smile: 0.2, smileRelax: 0.1, browUp: 0.16, browDown: 0.13, blinkOpen: 0.15 };

export const smileOf = (f) => (f.smileL + f.smileR) / 2;
export const browDownOf = (f) => (f.browDownL + f.browDownR) / 2;
export const blinkOf = (f) => Math.min(f.blinkL, f.blinkR); // both eyes must close

// One instruction per step. `say` is the large primary instruction, `hint` the short secondary line,
// `short` names the step in the progress bar, target labels become "LEFT DETECTED" etc.
export const STEPS = [
  {
    key: 'neutral', short: 'Face', demo: 'neutral', signal: 'head',
    say: 'Look at the screen and relax your face.',
    hint: 'Hold still for a moment.',
    targets: [{ id: 'still', label: 'Neutral', hold: 1200 }],
  },
  {
    key: 'turn', short: 'Turn', demo: 'turn', signal: 'headX',
    say: 'Slowly turn your head left and right.',
    hint: 'Move comfortably. You do not need to turn very far.',
    targets: [{ id: 'left', label: 'Left', hold: SIDE_HOLD_MS }, { id: 'right', label: 'Right', hold: SIDE_HOLD_MS }],
  },
  {
    key: 'nod', short: 'Nod', demo: 'nod', signal: 'headY',
    say: 'Slowly look up and down.',
    hint: 'A small, comfortable nod is enough.',
    targets: [{ id: 'up', label: 'Up', hold: SIDE_HOLD_MS }, { id: 'down', label: 'Down', hold: SIDE_HOLD_MS }],
  },
  {
    key: 'mouth', short: 'Mouth', demo: 'mouth', signal: 'mouth',
    say: 'Open your mouth, then close it.',
    hint: 'Open as wide as feels comfortable and hold for a second.',
    targets: [{ id: 'open', label: 'Mouth open', hold: HOLD_MS }, { id: 'close', label: 'Mouth closed', hold: RELAX_MS }],
  },
  {
    key: 'smile', short: 'Smile', demo: 'smile', signal: 'smile',
    say: 'Smile, then relax.',
    hint: 'Hold the smile for a second.',
    targets: [{ id: 'smile', label: 'Smile', hold: HOLD_MS }, { id: 'relax', label: 'Relaxed', hold: RELAX_MS }],
  },
  {
    key: 'brows', short: 'Brows', demo: 'brows', signal: 'brow',
    say: 'Raise your eyebrows, then relax.',
    hint: 'Or pull them into a frown, whichever is easier.',
    targets: [{ id: 'move', label: 'Brows', hold: HOLD_MS }, { id: 'relax', label: 'Relaxed', hold: RELAX_MS }],
  },
  {
    key: 'blink', short: 'Blink', demo: 'blink', signal: 'blink',
    say: 'Close both eyes slowly. Twice.',
    hint: 'A deliberate blink. Open your eyes in between.',
    targets: [{ id: 'blink1', label: 'Blink', hold: BLINK_MS }, { id: 'blink2', label: 'Second blink', hold: BLINK_MS }],
  },
];

// Fallback spans, relative to neutral, used when a step is skipped or produced unusable data.
export const FALLBACK = { headX: 0.12, headY: 0.07, mouth: 0.45, smile: 0.4, browUp: 0.35, browDown: 0.3 };

export const DEFAULT_CALIBRATION = {
  neutral: { headX: 0, headY: 0, tilt: 0, mouthOpen: 0.02, smile: 0.05, browDown: 0.05, browUp: 0.1, blink: 0.1 },
  headX: { neg: -0.12, pos: 0.12 },
  headY: { neg: -0.07, pos: 0.07 },
  mouthOpen: { rest: 0.02, max: 0.47 },
  smile: { rest: 0.05, max: 0.45 },
  brow: { down: { rest: 0.05, max: 0.35 }, up: { rest: 0.1, max: 0.45 }, direction: 'default' },
  blink: { rest: 0.1, threshold: 0.45, closed: 0.75, reliable: false },
  fallbacks: ['all'],
  defaults: true,
};

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class Calibration {
  constructor(steps = STEPS) {
    this.steps = steps;
    this.index = 0;
    this.samples = {}; // `${step}.${target}` → frames recorded while that target was held
    this.fallbacks = [];
    this.neutral = null;
    this._resetStep();
  }

  get step() {
    return this.steps[this.index];
  }
  get done() {
    return this.index >= this.steps.length;
  }

  _resetStep() {
    this.targetIndex = 0;
    this.held = 0;
    this.stepStartT = null;
    this.stepElapsed = 0;
    this.lastT = null;
    this.complete = false;
    this.dir = null; // sign of the first head movement (left / up), so the second must be opposite
    this.eyesReopened = true;
    this.prev = null;
    this.face = false;
    this.lastMeter = { value: 0, threshold: 0.5 };
    if (!this.done) for (const t of this.step.targets) this.samples[`${this.step.key}.${t.id}`] = [];
  }

  retry() {
    this._resetStep();
  }

  // Player chose to continue without this signal. Neutral can't be skipped without *some* face data,
  // so it falls back to defaults entirely.
  useFallback() {
    if (this.done) return;
    this.fallbacks.push(this.step.key);
    if (this.step.key === 'neutral') this.neutral = { ...DEFAULT_CALIBRATION.neutral };
    this.complete = true;
  }

  next() {
    if (!this.complete) return false; // never advance past an unfinished step
    this.index += 1;
    this._resetStep();
    return true;
  }

  // Feed one tracked frame; returns what the UI should show.
  update(f) {
    if (this.done || this.complete) return this.status();
    const dt = this.lastT == null ? 0 : Math.min(100, f.t - this.lastT);
    this.lastT = f.t;
    this.stepStartT ??= f.t;
    this.stepElapsed = f.t - this.stepStartT;
    this.face = !!f.present;
    if (!f.present) {
      this.held = Math.max(0, this.held - dt * 2);
      return this.status();
    }
    const target = this.step.targets[this.targetIndex];
    const ok = this._detect(target.id, f);
    this.held = ok ? this.held + dt : Math.max(0, this.held - dt * 2); // brief flickers don't reset fully
    if (ok) this.samples[`${this.step.key}.${target.id}`].push(f);
    if (this.held >= target.hold) {
      this._onTargetDone(target.id, f);
      this.targetIndex += 1;
      this.held = 0;
      if (this.targetIndex >= this.step.targets.length) {
        this.complete = true;
        if (this.step.key === 'neutral') this.neutral = neutralFrom(this.samples['neutral.still']);
      }
    }
    this.prev = f;
    return this.status();
  }

  // Is the current target's action happening in this frame? Also sets the live meter.
  _detect(id, f) {
    const n = this.neutral || DEFAULT_CALIBRATION.neutral;
    const meter = (value, threshold) => (this.lastMeter = { value: clamp01(value), threshold: clamp01(threshold) });
    switch (id) {
      case 'still': {
        const p = this.prev;
        const move = p ? Math.abs(f.headX - p.headX) + Math.abs(f.headY - p.headY) : 1;
        meter(1 - Math.min(1, move / 0.03), 0.5);
        return !!p && move < 0.015 && f.mouthOpen < 0.35;
      }
      case 'left': case 'right': case 'up': case 'down': {
        const key = id === 'left' || id === 'right' ? 'headX' : 'headY';
        const th = T[key];
        const d = f[key] - n[key];
        meter(Math.abs(d) / (th * 3), 1 / 3);
        // First side accepts either sign (we learn the direction); the second must be opposite.
        if (Math.abs(d) < th) return false;
        // The asked-for axis must be the main movement, so a turn can't pass as a nod (or vice versa).
        const other = key === 'headX' ? 'headY' : 'headX';
        if (Math.abs(f[other] - n[other]) / T[other] > Math.abs(d) / th) return false;
        return this.dir == null || Math.sign(d) !== this.dir;
      }
      case 'open':
        meter((f.mouthOpen - n.mouthOpen) / (T.mouth * 2.5), 0.4);
        return f.mouthOpen > n.mouthOpen + T.mouth;
      case 'close':
        meter(1 - (f.mouthOpen - n.mouthOpen) / (T.mouth * 2.5), 0.6);
        return f.mouthOpen < n.mouthOpen + T.mouthClosed;
      case 'smile': {
        const need = Math.min(n.smile + T.smile, 0.97);
        meter((smileOf(f) - n.smile) / (T.smile * 2.5), 0.4);
        return smileOf(f) > need;
      }
      case 'relax':
        if (this.step.key === 'smile') {
          meter(1 - (smileOf(f) - n.smile) / (T.smile * 2.5), 0.6);
          return smileOf(f) < n.smile + T.smileRelax;
        }
        meter(1 - Math.max((f.browUp - n.browUp) / (T.browUp * 2.5), (browDownOf(f) - n.browDown) / (T.browDown * 2.5)), 0.6);
        return f.browUp < n.browUp + T.browUp * 0.6 && browDownOf(f) < n.browDown + T.browDown * 0.6;
      case 'move': {
        const up = (f.browUp - n.browUp) / T.browUp;
        const down = (browDownOf(f) - n.browDown) / T.browDown;
        meter(Math.max(up, down) / 2.5, 0.4);
        return up > 1 || down > 1;
      }
      case 'blink1': case 'blink2': {
        const b = blinkOf(f);
        const need = Math.max(0.4, n.blink + 0.3);
        meter(b, need);
        if (b < n.blink + T.blinkOpen) this.eyesReopened = true;
        return b > need && this.eyesReopened;
      }
    }
    return false;
  }

  _onTargetDone(id, f) {
    if (id === 'left') this.dir = Math.sign(f.headX - (this.neutral?.headX ?? 0));
    if (id === 'up') this.dir = Math.sign(f.headY - (this.neutral?.headY ?? 0));
    if (id === 'blink1') this.eyesReopened = false; // must open before the second blink counts
  }

  status() {
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    return {
      index: Math.min(this.index, this.steps.length - 1),
      total: this.steps.length,
      step,
      done: this.done,
      complete: this.complete,
      facePresent: this.face,
      struggling: !this.complete && (this.stepElapsed ?? 0) > STRUGGLE_MS,
      meter: this.lastMeter,
      targets: step.targets.map((t, i) => ({
        ...t,
        done: this.complete || i < this.targetIndex,
        progress: this.complete || i < this.targetIndex ? 1 : i === this.targetIndex ? Math.min(1, this.held / t.hold) : 0,
      })),
    };
  }

  result() {
    return computeCalibration(this.samples, this.fallbacks, this.neutral);
  }
}

function neutralFrom(frames) {
  if (!frames?.length) return { ...DEFAULT_CALIBRATION.neutral };
  return {
    headX: avg(frames.map((f) => f.headX)),
    headY: avg(frames.map((f) => f.headY)),
    tilt: avg(frames.map((f) => f.tilt)),
    mouthOpen: avg(frames.map((f) => f.mouthOpen)),
    smile: avg(frames.map(smileOf)),
    browDown: avg(frames.map(browDownOf)),
    browUp: avg(frames.map((f) => f.browUp)),
    blink: avg(frames.map(blinkOf)),
  };
}

// Turn the held samples into personal ranges. "Comfortable" values are the median of what the
// player actually held, not a one-frame extreme, so a normal-sized movement reaches full effect.
export function computeCalibration(samples, fallbacks = [], neutral = null) {
  const n = neutral || neutralFrom(samples['neutral.still']);
  const get = (k) => samples[k] || [];
  const skipped = (step) => fallbacks.includes(step);

  const axis = (key, negId, posId, step, span) => {
    const neg = median(get(`${step}.${negId}`).map((f) => f[key]));
    const pos = median(get(`${step}.${posId}`).map((f) => f[key]));
    const opposite = Number.isFinite(neg) && Number.isFinite(pos) && (neg - n[key]) * (pos - n[key]) < 0;
    if (skipped(step) || !opposite) return { neg: n[key] - span, pos: n[key] + span, fallback: true };
    return { neg, pos };
  };

  const expr = (step, id, fn, rest, span) => {
    const held = median(get(`${step}.${id}`).map(fn));
    if (skipped(step) || !Number.isFinite(held) || held - rest < 0.08) return { rest, max: Math.min(1, rest + span), fallback: true };
    return { rest, max: held };
  };

  // Brows: the player may have raised OR furrowed. Use whichever they did; default the other.
  const moved = get('brows.move');
  const upHeld = median(moved.map((f) => f.browUp));
  const downHeld = median(moved.map(browDownOf));
  const upOk = !skipped('brows') && upHeld - n.browUp > 0.1;
  const downOk = !skipped('brows') && downHeld - n.browDown > 0.08;
  const brow = {
    up: upOk ? { rest: n.browUp, max: upHeld } : { rest: n.browUp, max: Math.min(1, n.browUp + FALLBACK.browUp) },
    down: downOk ? { rest: n.browDown, max: downHeld } : { rest: n.browDown, max: Math.min(1, n.browDown + FALLBACK.browDown) },
    direction: upOk && downOk ? 'both' : upOk ? 'raise' : downOk ? 'furrow' : 'default',
  };

  // Blink: eyelids also drop when looking down, so the threshold must clear that as well.
  const closedFrames = [...get('blink.blink1'), ...get('blink.blink2')].map(blinkOf);
  const closed = median(closedFrames);
  const lookingDown = pct(get('nod.down').map(blinkOf), 0.9);
  const floor = Math.max(n.blink, Number.isFinite(lookingDown) ? lookingDown : n.blink);
  const reliable = !skipped('blink') && Number.isFinite(closed) && closed - floor > 0.2;
  const blink = reliable
    ? { rest: n.blink, threshold: floor + 0.65 * (closed - floor), closed, reliable: true }
    : { rest: n.blink, threshold: Math.min(0.95, floor + 0.35), closed: Number.isFinite(closed) ? closed : null, reliable: false };

  return {
    neutral: n,
    headX: axis('headX', 'left', 'right', 'turn', FALLBACK.headX),
    headY: axis('headY', 'up', 'down', 'nod', FALLBACK.headY),
    mouthOpen: expr('mouth', 'open', (f) => f.mouthOpen, n.mouthOpen, FALLBACK.mouth),
    smile: expr('smile', 'smile', smileOf, n.smile, FALLBACK.smile),
    brow,
    blink,
    fallbacks: [...fallbacks],
    calibratedAt: new Date().toISOString(),
    defaults: false,
  };
}
