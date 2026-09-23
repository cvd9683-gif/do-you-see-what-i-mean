// Node tests for the DOM-free modules. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuro, mapAxis, BrushMapper, pickShape } from '../js/mapping.js';
import { Calibrator, computeCalibration, STEPS, DEFAULT_CALIBRATION } from '../js/calibration.js';
import { createSession, createMark, parseSession, serializeSession } from '../js/session.js';

const face = (o = {}) => ({
  present: true, t: 0, headX: 0, headY: 0, tilt: 0, mouthOpen: 0.02,
  smileL: 0.05, smileR: 0.05, browDownL: 0.05, browDownR: 0.05, browUp: 0.1, blinkL: 0.1, blinkR: 0.1, ...o,
});

// Deterministic noise so the jitter test is repeatable.
function noise(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
}

test('1€ filter suppresses jitter on a still head', () => {
  const f = new OneEuro();
  const n = noise(3);
  const raw = [], out = [];
  for (let i = 0; i < 300; i++) {
    raw.push(600 + n() * 30); // ±15px frame-to-frame landmark noise at 30fps
    out.push(f.filter(raw[i], i / 30));
  }
  const sd = (a) => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const ratio = sd(out.slice(60)) / sd(raw.slice(60));
  assert.ok(ratio < 0.3, `smoothed jitter should be <30% of raw, got ${(ratio * 100).toFixed(0)}%`);
});

test('1€ filter still follows a fast head turn', () => {
  const f = new OneEuro();
  let y;
  for (let i = 0; i < 30; i++) y = f.filter(i < 5 ? 0 : 900, i / 30);
  assert.ok(y > 850, `should reach target within ~1s, got ${y}`);
});

test('mapAxis puts neutral at centre and calibrated extremes at the edges', () => {
  assert.equal(mapAxis(0, -0.2, 0, 0.2), 0.5);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  near(mapAxis(-0.15, -0.2, 0, 0.2), 0);
  near(mapAxis(0.15, -0.2, 0, 0.2), 1);
  near(mapAxis(0.5, -0.2, 0, 0.2), 1); // clamped
  // Works when the axis is inverted too (e.g. unusual camera placement).
  near(mapAxis(0.15, 0.2, 0, -0.2), 0);
});

test('calibration learns ranges from steps and flags unreliable blinks', () => {
  const cal = new Calibrator(STEPS);
  const byStep = {
    neutral: {}, left: { headX: -0.2 }, right: { headX: 0.22 }, up: { headY: -0.1 }, down: { headY: 0.12, blinkL: 0.3, blinkR: 0.3 },
    smile: { smileL: 0.8, smileR: 0.75 }, mouth: { mouthOpen: 0.7 }, brows: { browDownL: 0.6, browDownR: 0.55, browUp: 0.7 },
    eyes: { blinkL: 0.9, blinkR: 0.92 },
  };
  let t = 0, st;
  do {
    t += 33;
    st = cal.addSample(face({ t, ...byStep[cal.step.key] }));
  } while (!st.done);
  const c = cal.result();
  assert.ok(Math.abs(c.headX.neg + 0.2) < 1e-9 && Math.abs(c.headX.pos - 0.22) < 1e-9);
  assert.ok(c.mouthOpen.max > 0.6);
  assert.equal(c.blink.reliable, true);
  assert.ok(c.blink.threshold > 0.3, 'threshold clears the looking-down eyelid droop');

  const flat = computeCalibration({ neutral: [face()], eyes: [face({ blinkL: 0.2, blinkR: 0.2 })] });
  assert.equal(flat.blink.reliable, false);
  assert.equal(flat.headX.neg, DEFAULT_CALIBRATION.headX.neg, 'missing steps fall back to defaults');
});

test('mapper: mouth paints after a beat, smile/brow pick shape, long blink stamps once', () => {
  const m = new BrushMapper({ calibration: DEFAULT_CALIBRATION });
  let t = 0;
  const run = (o, frames) => {
    for (let i = 0; i < frames; i++) m.update(face({ t: (t += 33), ...o }));
    return m.state;
  };
  assert.equal(run({ mouthOpen: 0.5 }, 1).painting, false, 'no paint on a single-frame blip');
  assert.equal(run({ mouthOpen: 0.5 }, 10).painting, true);
  assert.ok(m.state.size > 50);
  assert.equal(run({ mouthOpen: 0.02 }, 10).painting, false);
  assert.equal(run({ smileL: 0.8, smileR: 0.8 }, 15).shape, 'rounded');
  assert.equal(run({ browDownL: 0.6, browDownR: 0.6 }, 15).shape, 'angular');

  m.drainEvents();
  run({ blinkL: 0.9, blinkR: 0.9 }, 3); // ~100ms natural blink
  run({}, 3);
  assert.equal(m.drainEvents().filter((e) => e.type === 'stamp').length, 0, 'natural blink ignored');
  run({ blinkL: 0.9, blinkR: 0.9 }, 15); // ~500ms deliberate blink
  assert.equal(m.drainEvents().filter((e) => e.type === 'stamp').length, 1, 'held blink stamps exactly once');
  assert.equal(pickShape(0.1, 0.1), 'line');
});

test('marks serialise to JSON and survive a round trip', () => {
  const s = createSession({ prompt: { id: 'fish', label: 'a fish' }, inputMode: 'face', calibration: DEFAULT_CALIBRATION });
  const brush = { x: 410.4, y: 260, shape: 'rounded', color: '#FF694D', size: 76, rotation: -12, opacity: 0.65 };
  s.marks.push(createMark({ brush, facialInput: { mouthOpen: 0.72, headTilt: -12 }, timestamp: 12450, strokeId: 'k1' }));
  const back = parseSession(serializeSession(s));
  assert.equal(back.marks.length, 1);
  assert.deepEqual(back.marks[0].visualOutput, { ...s.marks[0].visualOutput });
  assert.equal(back.marks[0].facialInput.mouthOpen, 0.72);
  assert.equal(back.prompt.id, 'fish');

  const junk = parseSession('{"prompt":{"id":"x"},"marks":[null,{"visualOutput":{"x":"a","color":"red"}}]}');
  assert.equal(junk.marks.length, 1);
  assert.equal(junk.marks[0].visualOutput.color, '#E8321E', 'invalid colours are repaired');
  assert.equal(parseSession('not json'), null);
});
