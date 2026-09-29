// Node tests for the DOM-free modules. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { OneEuro, mapAxis, BrushMapper, pickShape, DabTrail } from '../js/mapping.js';
import { Calibration, STEPS, DEFAULT_CALIBRATION, STRUGGLE_MS } from '../js/calibration.js';
import { createSession, createMark, parseSession, serializeSession, colorChangeEvent, colorAt } from '../js/session.js';
import { PALETTE } from '../js/config.js';
import { extractFeatures } from '../js/faceTracker.js';

const face = (o = {}) => ({
  present: true, t: 0, headX: 0, headY: 0, tilt: 0, mouthOpen: 0.03,
  smileL: 0.05, smileR: 0.05, browDownL: 0.05, browDownR: 0.05, browUp: 0.1, blinkL: 0.1, blinkR: 0.1, ...o,
});

// A scripted player: which pose to hold for the current calibration target.
const POSE = {
  still: {}, left: { headX: -0.1 }, right: { headX: 0.1 }, up: { headY: -0.06 }, down: { headY: 0.06, blinkL: 0.3, blinkR: 0.3 },
  open: { mouthOpen: 0.55 }, close: {}, smile: { smileL: 0.7, smileR: 0.7 }, relax: {},
  move: { browUp: 0.6 }, blink1: { blinkL: 0.9, blinkR: 0.9 }, blink2: { blinkL: 0.9, blinkR: 0.9 },
};

// Drives a Calibration with the scripted poses. For the second blink it alternates
// open/closed, so the "eyes must reopen between blinks" rule is exercised.
function runCalibration(cal, pose = POSE, maxFrames = 4000) {
  let t = 0, frames = 0;
  while (!cal.done && frames++ < maxFrames) {
    t += 33;
    const st = cal.status();
    if (st.complete) {
      cal.next();
      continue;
    }
    const target = st.targets.find((x) => !x.done);
    let p = pose[target.id] ?? {};
    if (target.id === 'blink2' && frames % 20 < 6) p = {};
    cal.update(face({ t, ...p }));
  }
  return t;
}

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
    raw.push(600 + n() * 30);
    out.push(f.filter(raw[i], i / 30));
  }
  const sd = (a) => {
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  assert.ok(sd(out.slice(60)) / sd(raw.slice(60)) < 0.3);
});

test('mapAxis: neutral is centre (with a dead zone), 80% of the comfortable turn reaches the edge', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  near(mapAxis(0, -0.1, 0, 0.1), 0.5);
  near(mapAxis(0.004, -0.1, 0, 0.1), 0.5); // inside the dead zone
  near(mapAxis(-0.08, -0.1, 0, 0.1), 0);
  near(mapAxis(0.08, -0.1, 0, 0.1), 1);
  near(mapAxis(0.3, -0.1, 0, 0.1), 1); // clamped
  near(mapAxis(-0.08, 0.1, 0, -0.1), 1); // inverted axis still works
});

test('calibration never advances before the action is detected and held', () => {
  const cal = new Calibration(STEPS);
  let t = 0;
  // Neutral: a still face completes it.
  for (let i = 0; i < 60 && !cal.status().complete; i++) cal.update(face({ t: (t += 33) }));
  assert.equal(cal.status().complete, true);
  assert.equal(cal.next(), true);
  assert.equal(cal.step.key, 'turn');
  // Five seconds of looking straight ahead: the turn step must not complete or advance.
  for (let i = 0; i < 150; i++) cal.update(face({ t: (t += 33) }));
  assert.equal(cal.status().complete, false);
  assert.equal(cal.next(), false, 'next() refuses an unfinished step');
  assert.equal(cal.step.key, 'turn');
  assert.equal(cal.status().struggling, false);
  // A quick flick left (< hold time) doesn't count either.
  for (let i = 0; i < 8; i++) cal.update(face({ t: (t += 33), headX: -0.1 }));
  assert.equal(cal.status().targets[0].done, false);
  // After STRUGGLE_MS a fallback is offered; choosing it completes the step explicitly.
  for (let i = 0; i < STRUGGLE_MS / 33; i++) cal.update(face({ t: (t += 33) }));
  assert.equal(cal.status().struggling, true);
  cal.useFallback();
  assert.equal(cal.next(), true);
  assert.equal(cal.step.key, 'nod');
});

test('turn step: the second side must be opposite to the first', () => {
  const cal = new Calibration(STEPS);
  runCalibration(cal, { ...POSE, left: { headX: -0.1 }, right: { headX: -0.1 } }, 400);
  assert.equal(cal.step.key, 'turn');
  assert.equal(cal.status().targets[0].done, true);
  assert.equal(cal.status().targets[1].done, false);
});

test('calibration computes personal ranges, thresholds and blink reliability', () => {
  const cal = new Calibration(STEPS);
  runCalibration(cal);
  assert.equal(cal.done, true);
  const c = cal.result();
  assert.ok(Math.abs(c.headX.neg + 0.1) < 1e-9 && Math.abs(c.headX.pos - 0.1) < 1e-9, 'held head positions');
  assert.ok(Math.abs(c.headY.neg + 0.06) < 1e-9 && Math.abs(c.headY.pos - 0.06) < 1e-9);
  assert.ok(Math.abs(c.mouthOpen.max - 0.55) < 1e-9, 'comfortable mouth = held value');
  assert.ok(Math.abs(c.smile.max - 0.7) < 1e-9);
  assert.equal(c.brow.direction, 'raise');
  assert.equal(c.blink.reliable, true);
  assert.ok(c.blink.threshold > 0.3, 'blink threshold clears the looking-down eyelid droop');
  assert.deepEqual(c.fallbacks, []);
});

test('a skipped signal falls back instead of trapping the player', () => {
  const cal = new Calibration(STEPS);
  let t = 0;
  while (!cal.done && t < 200000) {
    const st = cal.status();
    if (st.complete) { cal.next(); continue; }
    if (st.step.key === 'smile') { cal.useFallback(); continue; }
    const target = st.targets.find((x) => !x.done);
    let p = POSE[target.id] ?? {};
    if (target.id === 'blink2' && (t / 33) % 20 < 6) p = {};
    cal.update(face({ t: (t += 33), ...p }));
  }
  const c = cal.result();
  assert.deepEqual(c.fallbacks, ['smile']);
  assert.ok(c.smile.max > c.smile.rest + 0.3, 'default smile span used');
});

function calibrated() {
  const cal = new Calibration(STEPS);
  runCalibration(cal);
  return cal.result();
}

test('mapper: a comfortable head movement reaches every edge of the canvas', () => {
  const m = new BrushMapper({ calibration: calibrated() });
  let t = 0;
  const hold = (o) => {
    for (let i = 0; i < 90; i++) m.update(face({ t: (t += 33), ...o }));
    return m.state;
  };
  // 80% of the held calibration pose is enough.
  assert.ok(hold({ headX: -0.08, headY: -0.048 }).x < 8 && m.state.y < 8, `top-left ${m.state.x},${m.state.y}`);
  assert.ok(hold({ headX: 0.08, headY: 0.048 }).x > 1192 && m.state.y > 792, `bottom-right ${m.state.x},${m.state.y}`);
  assert.ok(Math.abs(hold({}).x - 600) < 6 && Math.abs(m.state.y - 400) < 6, 'neutral returns to centre');
});

test('mapper: closed mouth moves without painting; paint starts only after a short hold', () => {
  const m = new BrushMapper({ calibration: calibrated() });
  const trail = new DabTrail();
  let t = 0, dabs = 0;
  const run = (o, frames) => {
    for (let i = 0; i < frames; i++) {
      m.update(face({ t: (t += 33), ...o }));
      if (trail.step(m.state, t, () => 'k')) dabs++;
    }
    return m.state;
  };
  // Sweep the whole canvas with the mouth closed, including talking-sized openings.
  for (let x = -0.1; x <= 0.1; x += 0.01) run({ headX: x, mouthOpen: x > 0 ? 0.15 : 0.03 }, 3);
  assert.equal(dabs, 0, 'no accidental paint while moving');
  run({ mouthOpen: 0.5 }, 2);
  assert.equal(m.state.painting, false, 'not before the activation hold');
  run({ mouthOpen: 0.5 }, 6);
  assert.equal(m.state.painting, true);
  run({ mouthOpen: 0.5, headX: 0.05 }, 20);
  assert.ok(dabs > 3);
  assert.equal(run({}, 6).painting, false);
});

test('mapper: expressions change the mark shape', () => {
  const m = new BrushMapper({ calibration: calibrated() });
  let t = 0;
  const run = (o) => { for (let i = 0; i < 15; i++) m.update(face({ t: (t += 33), ...o })); return m.state.shape; };
  assert.equal(run({ smileL: 0.6, smileR: 0.6 }), 'rounded');
  assert.equal(run({ browUp: 0.55 }), 'angular');
  assert.equal(run({}), 'line');
  assert.equal(pickShape(0.1, 0.1), 'line');
});

test('mapper: deliberate blink changes color once; natural or rapid blinks do not repeat it', () => {
  const m = new BrushMapper({ calibration: calibrated() });
  let t = 0;
  const run = (o, frames) => { for (let i = 0; i < frames; i++) m.update(face({ t: (t += 33), ...o })); };
  const closed = { blinkL: 0.9, blinkR: 0.9 };
  const colors = () => m.drainEvents().filter((e) => e.type === 'color').length;
  run({}, 20);
  run(closed, 3); run({}, 20); // ~100 ms natural blink
  assert.equal(colors(), 0, 'natural blink ignored');
  run(closed, 9); // ~300 ms deliberate blink
  assert.equal(colors(), 1);
  run(closed, 30); // keeping eyes shut doesn't repeat
  run({}, 4); run(closed, 9); // reopened only briefly → not re-armed yet
  assert.equal(colors(), 0, 'protected against rapid repeats');
  run({}, 20); run(closed, 9);
  assert.equal(colors(), 1, 'a new deliberate blink after reopening works');
});

test('mapper: blink color is disabled when calibration found blinks unreliable', () => {
  const m = new BrushMapper({ calibration: DEFAULT_CALIBRATION });
  let t = 0;
  for (let i = 0; i < 40; i++) m.update(face({ t: (t += 33), blinkL: 0.95, blinkR: 0.95 }));
  assert.equal(m.drainEvents().length, 0);
});

test('session JSON: v2 fields, timestamped marks, and no video data', () => {
  const s = createSession({ prompt: { id: 'fish', label: 'a fish', level: 'beginner' }, inputMode: 'face', calibration: DEFAULT_CALIBRATION });
  assert.equal(s.roundDurationMs, 90000);
  assert.ok(s.timing && s.recording && s.mappings.mouthOpen);
  const brush = { x: 420.4, y: 270, shape: 'rounded', color: '#F04D3A', size: 64, rotation: -8, opacity: 0.68 };
  s.marks.push(createMark({ brush, facialInput: { mouthOpen: 0.74, smile: 0.61, browMovement: 0.18, headX: 0.44, headY: 0.52, headTilt: -8 }, timestamp: 4280, strokeId: 'k1' }));
  s.recording = { enabled: true, mimeType: 'video/webm', durationMs: 90010, videoLeadMs: 3, blobUrl: 'blob:http://x/abc', data: 'AAAA' };
  const back = parseSession(serializeSession(s));
  assert.equal(back.marks[0].timestamp, 4280);
  assert.equal(back.marks[0].facialInput.smile, 0.61);
  assert.equal(back.recording.enabled, true);
  assert.equal(back.recording.durationMs, 90010);
  assert.ok(!('blobUrl' in back.recording) && !('data' in back.recording), 'media fields are stripped on load');

  const v1 = parseSession('{"prompt":{"id":"x"},"settings":{"roundMs":60000},"marks":[{"visualOutput":{"x":1,"color":"red"}}]}');
  assert.equal(v1.roundDurationMs, 60000, 'old sessions migrate');
  assert.equal(v1.marks[0].visualOutput.color, '#E8321E');
  assert.equal(parseSession('not json'), null);
});

test('mapper: color events carry previous/new color and input; palette click works', () => {
  const m = new BrushMapper({ calibration: calibrated() });
  let t = 0;
  const run = (o, frames) => { for (let i = 0; i < frames; i++) m.update(face({ t: (t += 33), ...o })); };
  run({}, 20);
  run({ blinkL: 0.9, blinkR: 0.9 }, 9);
  const [ev] = m.drainEvents();
  assert.deepEqual(ev, { type: 'color', via: 'blink', previousColor: PALETTE[0], newColor: PALETTE[1] });
  m.setColor(3, 'click');
  assert.deepEqual(m.drainEvents()[0], { type: 'color', via: 'click', previousColor: PALETTE[1], newColor: PALETTE[3] });
  m.setColor(3, 'click');
  assert.equal(m.drainEvents().length, 0, 'choosing the current color is not a change');
  assert.equal(m.state.color, PALETTE[3]);
});

test('mapper: one eye closing (a wink or glance) never changes color', () => {
  const m = new BrushMapper({ calibration: calibrated() });
  let t = 0;
  for (let i = 0; i < 40; i++) m.update(face({ t: (t += 33), blinkL: 0.95, blinkR: 0.15 }));
  assert.equal(m.drainEvents().length, 0);
});

test('mapper: when blinks are unreliable a held brow raise changes color, and only a furrow is angular', () => {
  const cal = { ...calibrated(), blink: { rest: 0.1, threshold: 0.6, closed: null, reliable: false } };
  const m = new BrushMapper({ calibration: cal });
  assert.equal(m.colorInput, 'browRaise');
  let t = 0;
  const run = (o, frames) => { for (let i = 0; i < frames; i++) m.update(face({ t: (t += 33), ...o })); return m.state; };
  run({}, 20);
  run({ browUp: 0.6 }, 3); // brief flash of the brows: nothing
  assert.equal(m.drainEvents().length, 0);
  run({}, 20);
  const st = run({ browUp: 0.6, mouthOpen: 0.5 }, 20); // held raise
  const evs = m.drainEvents();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].via, 'browRaise');
  assert.notEqual(st.shape, 'angular', 'raise no longer makes angular marks in this mode');
  assert.equal(run({ browDownL: 0.5, browDownR: 0.5 }, 20).shape, 'angular', 'furrow still does');
});

test('session JSON: color changes are stored and replayable by timestamp', () => {
  const s = createSession({ prompt: { id: 'sun', label: 'a sun' }, inputMode: 'face', calibration: DEFAULT_CALIBRATION });
  assert.equal(s.initialColor, PALETTE[0]);
  assert.match(s.mappings.colorChange, /eyebrow raise/, 'mapping reflects the fallback gesture');
  s.events.push(colorChangeEvent({ timestamp: 8420.4, previousColor: '#E8321E', newColor: '#2340D8', input: 'blink' }));
  s.events.push(colorChangeEvent({ timestamp: 12000, previousColor: '#2340D8', newColor: '#FFB400', input: 'click' }));
  const back = parseSession(serializeSession(s));
  assert.deepEqual(back.events[0], { type: 'colorChange', timestamp: 8420, previousColor: '#E8321E', newColor: '#2340D8', input: 'blink' });
  assert.equal(colorAt(back, 0), '#E8321E');
  assert.equal(colorAt(back, 8419), '#E8321E');
  assert.equal(colorAt(back, 8420), '#2340D8');
  assert.equal(colorAt(back, 90000), '#FFB400');
  const junk = parseSession(JSON.stringify({ ...s, events: [{ type: 'colorChange', newColor: 'blue' }, { type: 'other' }] }));
  assert.equal(junk.events.length, 0, 'invalid events are dropped');
});

// Builds a MediaPipe-shaped result from points given in mirrored (on-screen) 0..1 space,
// optionally rolled (tilted) by `deg` around the face centre.
function fakeResult(points, deg = 0) {
  const a = (deg * Math.PI) / 180;
  const lms = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const [i, [x, y]] of Object.entries(points)) {
    const rx = 0.5 + (x - 0.5) * Math.cos(a) - (y - 0.5) * Math.sin(a);
    const ry = 0.5 + (x - 0.5) * Math.sin(a) + (y - 0.5) * Math.cos(a);
    lms[i] = { x: 1 - rx, y: ry, z: 0 };
  }
  return { faceLandmarks: [lms], faceBlendshapes: [{ categories: [] }] };
}
const TURNED_LEFT = { 1: [0.45, 0.5], 234: [0.65, 0.5], 454: [0.35, 0.5], 10: [0.5, 0.25], 152: [0.5, 0.75], 33: [0.6, 0.4], 263: [0.4, 0.4] };

test('extractFeatures: a head turn on a tilted head does not read as a nod', () => {
  const level = extractFeatures(fakeResult(TURNED_LEFT), 1, 1, 0);
  assert.ok(level.headX < -0.1, `turned left reads as left (${level.headX})`);
  assert.ok(Math.abs(level.headY) < 1e-9);
  for (const deg of [-15, 15]) {
    const tilted = extractFeatures(fakeResult(TURNED_LEFT, deg), 1, 1, 0);
    assert.ok(Math.abs(tilted.headY) < 1e-9, `tilt ${deg}°: headY ${tilted.headY}`);
    assert.ok(Math.abs(tilted.headX - level.headX) < 1e-9, `tilt ${deg}°: headX ${tilted.headX}`);
    assert.ok(Math.abs(tilted.tilt - deg) < 1e-6, `tilt ${deg}° is still reported as roll`);
  }
});

test('nod step: turning the head does not count as looking up or down', () => {
  const cal = new Calibration(STEPS);
  // Turning sideways with a little vertical leak must not satisfy the nod.
  runCalibration(cal, { ...POSE, up: { headX: -0.1, headY: -0.03 }, down: { headX: 0.1, headY: 0.03 } }, 400);
  assert.equal(cal.step.key, 'nod');
  assert.equal(cal.status().targets[0].done, false);
});
