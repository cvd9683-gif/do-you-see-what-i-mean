// Game state + screen flow. Wires the tracker, calibration, mapper, painter, recorder and storage.
//
// Per round (face mode):
//   consent → camera → calibration (every round) → practice → record choice → prompt → round → results
// Mouse mode skips calibration, practice and recording.

import { CANVAS_W, CANVAS_H, PALETTE, COLOR_NAMES, CONTROLS, DEFAULT_SETTINGS, BEGINNER_ROUNDS } from './config.js';
import { FaceTracker, drawFaceOutline } from './faceTracker.js';
import { Calibration, STEPS, DEFAULT_CALIBRATION, COMPLETE_SHOW_MS, smileOf, browDownOf, blinkOf } from './calibration.js';
import { BrushMapper, DabTrail, clamp } from './mapping.js';
import { MouseInput } from './mouseInput.js';
import { Painter, renderThumbnail } from './renderer.js';
import { createSession, createMark, serializeSession, uid, colorChangeEvent, colorAt } from './session.js';
import { storage } from './storage.js';
import { SyncReplay, MarkEditor } from './results.js';
import { Practice } from './practice.js';
import { FaceRecorder } from './recorder.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const app = {
  screen: 'landing',
  prompts: [],
  session: null,
  inputMode: null, // 'face' | 'mouse'
  tracker: new FaceTracker($('video')),
  settings: { ...DEFAULT_SETTINGS },
  discovered: new Set(storage.loadDiscovered()),
  calibration: null, // this round's calibration (recomputed every round)
  calib: null, // the running Calibration
  mapper: null,
  mouse: null,
  painter: null,
  practice: null,
  replay: null,
  editor: null,
  wantRecording: false,
  recorder: null, // active FaceRecorder during a round
  recording: null, // { sessionId, url, mimeType, durationMs, videoLeadMs } — in memory only
  resuming: false,
  skipPractice: false, // Restart Game goes calibration → record choice, without the warm-up
  loop: 0,
  flowToken: 0, // bumps whenever the flow is interrupted, cancelling pending async steps
};

// Exposed for debugging and automated checks. Holds data and a blob: URL — never frames.
window.__dysw = app;

/* ---------- screens ---------- */

function show(name) {
  app.screen = name;
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== `screen-${name}`));
  document.querySelector('.wordmark').hidden = name === 'landing';
  document.body.dataset.screen = name;
  const heading = $(`screen-${name}`).querySelector('h1, h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

function setCameraPill() {
  $('camera-pill').hidden = !app.tracker.cameraOn;
  const recording = !!app.recorder?.active;
  $('camera-pill').classList.toggle('recording', recording);
  $('camera-pill-text').textContent = recording ? 'Camera on · Recording' : 'Camera on';
  $('rec-badge').hidden = !recording;
}

function moveVideoTo(slotId) {
  $(slotId).appendChild($('video-wrap'));
  $('video').play().catch(() => {});
}

function stopCamera() {
  app.tracker.stop();
  app.tracker.onFrame = null;
  $('video-holder').appendChild($('video-wrap'));
  setCameraPill();
}

// Free the in-memory face video. Called on delete, new game, leaving, and page hide.
function discardRecording() {
  if (!app.recording) return;
  if (app.replay?.useVideo) app.replay.destroy();
  URL.revokeObjectURL(app.recording.url);
  app.recording = null;
}

/* ---------- landing ---------- */

function renderLanding() {
  const cur = storage.loadCurrent();
  const cont = $('btn-continue');
  if (cur && cur.status === 'drawing' && cur.elapsedMs < cur.roundDurationMs) {
    const left = Math.ceil((cur.roundDurationMs - cur.elapsedMs) / 1000);
    cont.textContent = `Continue ${cur.prompt.label} (${left}s left)`;
    cont.hidden = false;
  } else cont.hidden = true;

  const gallery = storage.loadGallery();
  $('gallery').hidden = !gallery.length;
  const list = $('gallery-list');
  list.replaceChildren();
  for (const s of gallery) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'thumb';
    b.setAttribute('aria-label', `Open your painting of ${s.prompt.label}`);
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 160;
    renderThumbnail(c, s.marks);
    const cap = document.createElement('span');
    cap.textContent = s.prompt.label;
    b.append(c, cap);
    b.addEventListener('click', () => showResults(s, { autoplay: false }));
    li.append(b);
    list.append(li);
  }
  paintHero();
}

// The one orchestrated moment: the landing title gets painted over by the game's own brush.
let heroPainter = null;
function paintHero() {
  heroPainter ??= new Painter($('hero-canvas'));
  const marks = [];
  let seed = 11;
  const shapes = ['rounded', 'line', 'angular', 'rounded', 'line'];
  for (let i = 0; i < 34; i++) {
    const a = Math.abs((Math.sin(seed++ * 12.9898) * 43758.5453) % 1);
    const b = Math.abs((Math.sin(seed++ * 78.233) * 12345.678) % 1);
    marks.push({
      timestamp: i * 60,
      visualOutput: {
        x: 620 + Math.cos(i * 0.7) * (160 + a * 420),
        y: 400 + Math.sin(i * 1.3) * (110 + b * 270),
        shape: shapes[i % shapes.length],
        color: PALETTE[i % PALETTE.length],
        size: 30 + a * 120,
        rotation: (b - 0.5) * 120,
        opacity: 0.5,
        seed: 1000 + i,
      },
    });
  }
  heroPainter.clearLayer();
  if (reduceMotion()) {
    marks.forEach((m) => heroPainter.addMark(m));
    heroPainter.composite();
    return;
  }
  let i = 0;
  const step = () => {
    if (app.screen !== 'landing') return;
    if (i < marks.length) heroPainter.addMark(marks[i++]);
    heroPainter.composite();
    if (i < marks.length) setTimeout(() => requestAnimationFrame(step), 70);
  };
  step();
}

/* ---------- starting a game ---------- */

// A small in-page confirm (never a browser alert). Resolves true/false.
function confirmDialog({ title, text, yes, no }) {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('btn-confirm-yes').textContent = yes;
  $('btn-confirm-no').textContent = no;
  return new Promise((resolve) => {
    const close = (ok) => {
      $('btn-confirm-yes').onclick = $('btn-confirm-no').onclick = dlg.oncancel = null;
      dlg.close();
      resolve(ok);
    };
    $('btn-confirm-yes').onclick = () => close(true);
    $('btn-confirm-no').onclick = () => close(false);
    dlg.oncancel = (e) => {
      e.preventDefault();
      close(false);
    };
    dlg.showModal();
  });
}

// NEW GAME: a genuinely new drawing experience. Calibration always runs first (face mode).
// Replaying a finished performance never comes through here.
async function newGame() {
  if (app.recording) {
    const ok = await confirmDialog({
      title: 'Discard your face replay?',
      text: 'Starting a new game deletes the temporary video of your last round. Your painting stays saved.',
      yes: 'Discard and start',
      no: 'Keep watching',
    });
    if (!ok) return;
  }
  discardRecording();
  app.replay?.stop();
  app.session = null;
  app.resuming = false;
  app.skipPractice = false;
  if (app.inputMode === 'face') chooseCamera(); // already consented this visit: straight to calibration
  else show('consent');
}

// RESTART GAME: throw away the round in progress and begin again, recalibrating first.
async function restartGame() {
  const ok = await confirmDialog({
    title: 'Restart the game?',
    text: `This discards the current painting${app.recorder ? ' and its recording' : ''}. ${app.inputMode === 'face' ? 'You’ll recalibrate, then start a fresh round.' : 'You’ll get a fresh round.'}`,
    yes: 'Restart game',
    no: 'Keep drawing',
  });
  if (!ok || app.screen !== 'draw') return;
  ++app.flowToken;
  stopRound();
  app.recorder?.cancel(); // nothing from the discarded round is kept
  app.recorder = null;
  setCameraPill();
  storage.clearCurrent();
  app.session = null;
  app.resuming = false;
  app.skipPractice = true;
  if (app.inputMode !== 'face') return showPrompt();
  if (app.tracker.cameraOn && app.tracker.landmarker) runCalibration();
  else chooseCamera();
}

/* ---------- camera + calibration ---------- */

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow it from the camera icon in the address bar and try again, or play with a mouse.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Connect one and try again, or play with a mouse.';
    case 'NotReadableError':
      return 'The camera is busy in another app. Close that app and try again, or play with a mouse.';
    default:
      return err?.message === 'unsupported'
        ? 'This browser can’t use a camera here. Try a current Chrome, Edge, Firefox or Safari over https or localhost, or play with a mouse.'
        : 'The camera didn’t start. Try again, or play with a mouse.';
  }
}

async function chooseCamera() {
  const token = ++app.flowToken;
  $('consent-error').textContent = '';
  $('btn-camera').disabled = true;
  try {
    await app.tracker.startCamera();
  } catch (err) {
    console.warn('Camera failed', err);
    if (app.screen !== 'consent') show('consent');
    $('consent-error').textContent = cameraErrorMessage(err);
    return;
  } finally {
    $('btn-camera').disabled = false;
  }
  if (token !== app.flowToken) return stopCamera();
  app.inputMode = 'face';
  setCameraPill();
  show('calibrate');
  moveVideoTo('calib-video-slot');
  setCalibLoading('Loading the face model…', 'This takes a few seconds the first time.');
  try {
    await app.tracker.loadModel();
  } catch (err) {
    console.error('Face model failed to load', err);
    setCalibLoading('The face model didn’t load.', 'Check your internet connection and reload, or play with a mouse instead.');
    return;
  }
  if (token !== app.flowToken) return;
  runCalibration();
}

function setCalibLoading(title, say) {
  $('calib-count').textContent = 'Getting ready';
  $('calib-title').textContent = title;
  $('calib-say').textContent = say;
  $('calib-targets').replaceChildren();
  $('calib-status').textContent = '';
  $('btn-calib-retry').hidden = $('btn-calib-fallback').hidden = true;
}

const DETECTED_SHOW_MS = 600;
let calibPhase = null; // null while detecting; 'detected' then 'complete' while a finished step is on show

// Calibration runs before every round. Each step waits for a detected, held action.
function runCalibration() {
  const token = ++app.flowToken;
  show('calibrate');
  moveVideoTo('calib-video-slot');
  const cal = (app.calib = new Calibration(STEPS));
  const overlay = $('face-overlay').getContext('2d');
  let shownIndex = -1;
  let advancing = false;

  // Finishing a step: show "<LAST> DETECTED", then "COMPLETE", then move on. Never instant.
  const advance = (skipped = false) => {
    advancing = true;
    calibPhase = skipped ? 'complete' : 'detected';
    render(cal.status());
    setTimeout(() => {
      if (token !== app.flowToken) return;
      calibPhase = 'complete';
      render(cal.status());
    }, skipped ? 0 : DETECTED_SHOW_MS);
    setTimeout(() => {
      if (token !== app.flowToken) return;
      cal.next();
      advancing = false;
      calibPhase = null;
      if (cal.done) finishCalibration();
      else render(cal.status());
    }, (skipped ? 0 : DETECTED_SHOW_MS) + COMPLETE_SHOW_MS);
  };

  const render = (st) => {
    if (st.index !== shownIndex) {
      shownIndex = st.index;
      renderCalibStep(st);
    }
    renderCalibLive(st);
  };

  app.calibUI = {
    retry: () => {
      cal.retry();
      render(cal.status());
    },
    fallback: () => {
      cal.useFallback();
      advance(true);
    },
  };

  render(cal.status());
  app.tracker.onFrame = (f, lms) => {
    if (token !== app.flowToken) return;
    drawFaceOutline(overlay, lms, app.tracker.connections);
    renderSignalPanel(f, cal.step?.signal);
    if (advancing || cal.done) return;
    const st = cal.update(f);
    render(st);
    if (st.complete) advance();
  };
  app.tracker.startLoop();
}

function renderCalibStep(st) {
  $('calib-count').textContent = `CALIBRATION · ${st.index + 1} OF ${st.total}`;
  $('calib-dots').replaceChildren(
    ...STEPS.map((step, i) => {
      const li = document.createElement('li');
      li.className = i < st.index ? 'done' : i === st.index ? 'current' : '';
      if (i === st.index) li.setAttribute('aria-current', 'step');
      li.innerHTML = '<span class="n"></span><span class="s"></span>';
      li.querySelector('.n').textContent = i < st.index ? '✓' : String(i + 1);
      li.querySelector('.s').textContent = step.short;
      return li;
    }),
  );
  $('calib-demo').dataset.demo = st.step.demo;
  $('calib-title').textContent = st.step.say; // the one large instruction
  $('calib-say').textContent = st.step.hint; // short, secondary
  $('calib-targets').replaceChildren(
    ...st.targets.map((t) => {
      const li = document.createElement('li');
      li.dataset.id = t.id;
      li.innerHTML = '<span class="ring" aria-hidden="true"></span><span class="label"></span>';
      li.querySelector('.label').textContent = t.label;
      return li;
    }),
  );
}

function renderCalibLive(st) {
  const side = $('calib-side');
  side.classList.toggle('complete', st.complete && calibPhase !== 'detected');
  st.targets.forEach((t) => {
    const li = $('calib-targets').querySelector(`[data-id="${t.id}"]`);
    if (!li) return;
    li.classList.toggle('done', t.done);
    li.style.setProperty('--p', t.progress);
  });
  const current = $('calib-dots').querySelector('.current');
  if (current) current.classList.toggle('done-now', st.complete);
  const meter = $('calib-meter');
  meter.querySelector('.fill').style.width = `${Math.round(st.meter.value * 100)}%`;
  meter.querySelector('.mark').style.left = `${Math.round(st.meter.threshold * 100)}%`;
  meter.classList.toggle('over', st.meter.value >= st.meter.threshold);

  // One large status line: what was just detected, what is being held, or what's wrong.
  const holding = st.targets.find((t) => !t.done && t.progress > 0);
  const lastDone = [...st.targets].reverse().find((t) => t.done);
  let msg = '', state = '';
  if (st.complete && calibPhase === 'detected' && lastDone) {
    msg = `${lastDone.label.toUpperCase()} DETECTED`;
    state = 'ok';
  } else if (st.complete) {
    const skipped = app.calib.fallbacks.includes(st.step.key);
    msg = skipped ? 'SKIPPED · USING A STANDARD SETTING' : 'COMPLETE';
    state = 'complete';
  } else if (!st.facePresent) {
    msg = 'CAN’T SEE YOUR FACE';
    state = 'warn';
  } else if (holding) {
    msg = `HOLD ${holding.label.toUpperCase()}…`;
    state = 'hold';
  } else if (lastDone) {
    msg = `${lastDone.label.toUpperCase()} DETECTED`;
    state = 'ok';
  } else if (st.struggling) {
    msg = 'NOT DETECTED YET';
    state = 'warn';
  } else {
    msg = 'WAITING…';
    state = 'idle';
  }
  const status = $('calib-status');
  if (status.textContent !== msg) status.textContent = msg;
  status.dataset.state = state;
  $('btn-calib-retry').hidden = !st.struggling || st.complete;
  $('btn-calib-fallback').hidden = !st.struggling || st.complete;
}

// Live, labelled view of what MediaPipe is measuring. These are movements, not emotions.
function renderSignalPanel(f, active) {
  const panel = $('calib-signals');
  const on = (key) => active === key || (key === 'head' && /^head/.test(active || ''));
  panel.querySelectorAll('.sig').forEach((el) => el.classList.toggle('active', on(el.dataset.sig)));
  panel.classList.toggle('lost', !f.present);
  if (!f.present) return;
  const bar = (key, v) => (panel.querySelector(`[data-sig="${key}"] i`).style.width = `${Math.round(clamp(v) * 100)}%`);
  bar('mouth', f.mouthOpen * 1.4);
  bar('smile', smileOf(f));
  bar('brow', Math.max(browDownOf(f), f.browUp) * 1.3);
  bar('blink', blinkOf(f));
  const dot = panel.querySelector('[data-sig="head"] i');
  dot.style.left = `${Math.round(clamp(0.5 + f.headX * 3) * 100)}%`;
  dot.style.top = `${Math.round(clamp(0.5 + f.headY * 4) * 100)}%`;
}

function finishCalibration() {
  app.calibration = app.calib.result();
  storage.saveCalibration(app.calibration); // numbers only
  if (app.resuming) {
    app.wantRecording = false; // the first part of a resumed round was never recorded
    showPrompt();
  } else if (app.skipPractice) {
    app.skipPractice = false;
    showRecordChoice();
  } else startPractice();
}

function chooseMouse() {
  ++app.flowToken;
  stopCamera();
  app.inputMode = 'mouse';
  app.wantRecording = false;
  showPrompt();
}

/* ---------- practice ---------- */

function startPractice() {
  const token = ++app.flowToken;
  show('practice');
  moveVideoTo('practice-video-slot');
  app.mapper = new BrushMapper({ calibration: app.calibration, settings: app.settings });
  app.practice ??= new Practice($('practice-canvas'));
  app.practice.reset();
  renderObjectives();
  const overlay = $('face-overlay').getContext('2d');
  app.tracker.onFrame = (f, lms) => {
    if (token !== app.flowToken) return;
    app.mapper.update(f);
    drawFaceOutline(overlay, lms, app.tracker.connections);
  };
  app.tracker.startLoop();
  cancelAnimationFrame(app.loop);
  const loop = () => {
    if (token !== app.flowToken) return;
    app.loop = requestAnimationFrame(loop);
    app.mapper.drainEvents();
    app.practice.tick(performance.now(), app.mapper.state);
    renderObjectives();
  };
  app.loop = requestAnimationFrame(loop);
}

function renderObjectives() {
  const o = app.practice.objectives;
  const set = (key, done) => $('objectives').querySelector(`[data-obj="${key}"]`).classList.toggle('done', done);
  set('targets', o.targets === 2);
  set('paint', o.paint);
  set('expression', o.expression);
  $('obj-targets-count').textContent = `${o.targets}/2`;
  const all = app.practice.allDone;
  const note = all ? 'All three done. Keep experimenting, or start when you’re ready.' : 'Everything else is yours to discover.';
  if ($('practice-note').textContent !== note) $('practice-note').textContent = note;
  $('btn-ready').classList.toggle('pulse', all);
}

function leavePractice() {
  ++app.flowToken;
  cancelAnimationFrame(app.loop);
  app.tracker.onFrame = null;
  app.practice.reset(); // practice marks are discarded, never saved
  showRecordChoice();
}

function showRecordChoice() {
  const supported = FaceRecorder.supported();
  $('record-unsupported').hidden = supported;
  $('btn-record-yes').disabled = !supported;
  show('record');
}

/* ---------- prompt ---------- */

// Concrete beginner prompts until the player has finished a few rounds.
function pickPrompt() {
  const played = storage.loadGallery().length;
  const pool0 = played < BEGINNER_ROUNDS ? app.prompts.filter((p) => p.level === 'beginner') : app.prompts;
  const last = storage.loadGallery()[0]?.prompt?.id;
  const pool = pool0.filter((p) => p.id !== last);
  return pool[Math.floor(Math.random() * pool.length)] || app.prompts[0];
}

async function showPrompt() {
  const token = ++app.flowToken;
  if (app.session?.status !== 'drawing') app.session = null;
  const prompt = app.session?.prompt ?? pickPrompt();
  app.pendingPrompt = prompt;
  $('prompt-word').textContent = prompt.label;
  $('prompt-rec-note').hidden = !app.wantRecording;
  show('prompt');
  for (const n of ['3', '2', '1']) {
    $('prompt-count').textContent = n;
    await wait(800);
    if (token !== app.flowToken) return;
  }
  startRound();
}

/* ---------- the round ---------- */

const round = { base: 0, segmentStart: 0, trail: null, range: null, faceLostAt: null, newlyFound: new Set(), saveAt: 0, finishing: false };

async function startRound() {
  const token = ++app.flowToken;
  const face = app.inputMode === 'face';
  if (!app.session) {
    app.session = createSession({
      prompt: app.pendingPrompt,
      inputMode: app.inputMode,
      calibration: face ? app.calibration : null,
      settings: app.settings,
    });
  }
  const s = app.session;
  s.inputMode = app.inputMode;
  if (face) s.calibration = app.calibration;

  show('draw');
  $('draw-prompt').textContent = `Draw ${s.prompt.label}`;
  $('timer').textContent = String(Math.ceil((s.roundDurationMs - s.elapsedMs) / 1000));
  app.painter ??= new Painter($('paint-canvas'));
  app.painter.redraw(s.marks);

  Object.assign(round, {
    trail: new DabTrail(),
    range: { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
    faceLostAt: null,
    newlyFound: new Set(),
    finishing: false,
  });
  renderFound();

  $('mouse-help').hidden = face;
  document.querySelector('#screen-draw .preview-wrap').hidden = !face;
  $('signals').hidden = !face;
  $('face-status').textContent = '';

  if (face) {
    moveVideoTo('draw-video-slot');
    app.mapper = new BrushMapper({ calibration: app.calibration || DEFAULT_CALIBRATION, settings: app.settings });
    const overlay = $('face-overlay').getContext('2d');
    app.tracker.onFrame = (f, lms) => {
      if (token !== app.flowToken) return;
      app.mapper.update(f);
      drawFaceOutline(overlay, lms, app.tracker.connections);
    };
    app.tracker.startLoop();
  } else {
    app.mouse = new MouseInput($('paint-canvas'));
    app.mouse.attach();
  }
  // Resuming? Continue with the color that was active when the page closed (no new event).
  const input = currentInput();
  const idx = PALETTE.indexOf(colorAt(s, s.elapsedMs));
  if (idx > 0) {
    input.colorIndex = idx;
    input.state.color = PALETTE[idx];
  }
  $('palette-hint').textContent = !face
    ? 'Click a color or press C.'
    : app.mapper.colorInput === 'blink'
      ? 'Blink slowly with both eyes to switch.'
      : 'Blinks weren’t readable, so raise your eyebrows and hold to switch.';
  renderPalette(input.state.color);

  // Shared clock: recording starts first; the timer starts the instant the recorder reports it's running.
  let recStartPerf = null;
  if (face && app.wantRecording && app.tracker.stream && FaceRecorder.supported()) {
    try {
      app.recorder = new FaceRecorder(app.tracker.stream);
      recStartPerf = await app.recorder.start();
    } catch (err) {
      console.warn('Recording could not start; continuing without it', err);
      app.recorder = null;
    }
    if (token !== app.flowToken) return;
  }
  const start = performance.now();
  round.base = s.elapsedMs;
  round.segmentStart = start;
  round.saveAt = start + 1500;
  if (!s.timing.sharedStartEpochMs) s.timing.sharedStartEpochMs = Date.now();
  s.timing.sharedStartPerfMs = start - s.elapsedMs;
  if (app.recorder) {
    s.recording = { ...s.recording, enabled: true, mimeType: app.recorder.mimeType, videoLeadMs: Math.round(start - recStartPerf), durationMs: null };
  }
  setCameraPill();
  storage.saveCurrent(s);
  cancelAnimationFrame(app.loop);
  app.loop = requestAnimationFrame(() => tick(token));
}

function currentInput() {
  return app.inputMode === 'face' ? app.mapper : app.mouse;
}

function tick(token) {
  if (token !== app.flowToken) return;
  app.loop = requestAnimationFrame(() => tick(token));
  const now = performance.now();
  const s = app.session;
  // One monotonic clock drives the timer, the video sync and every mark timestamp.
  s.elapsedMs = Math.min(s.roundDurationMs, round.base + (now - round.segmentStart));

  const input = currentInput();
  const brush = app.inputMode === 'face' ? input.state : input.tick(16);

  for (const ev of input.drainEvents()) if (ev.type === 'color') onColorChange(ev);
  if (renderPalette.current !== brush.color) renderPalette(brush.color);

  if (brush.present) {
    const r = round.range;
    r.x0 = Math.min(r.x0, brush.x); r.x1 = Math.max(r.x1, brush.x);
    r.y0 = Math.min(r.y0, brush.y); r.y1 = Math.max(r.y1, brush.y);
    if (r.x1 - r.x0 > CANVAS_W * 0.4) discover('moveX');
    if (r.y1 - r.y0 > CANVAS_H * 0.4) discover('moveY');
  }

  const strokeId = round.trail.step(brush, now, () => uid('k'));
  if (strokeId) addMark(brush, strokeId, s.elapsedMs);

  if (app.inputMode === 'face') {
    if (!brush.present) round.faceLostAt ??= now;
    else round.faceLostAt = null;
    const lost = round.faceLostAt && now - round.faceLostAt > 600;
    const msg = lost ? 'Can’t see your face. Move back into the frame.' : '';
    if ($('face-status').textContent !== msg) $('face-status').textContent = msg;
    const sig = brush.signals;
    const bars = $('signals').children;
    [sig.mouth, sig.smile, sig.brow, sig.blink].forEach((v, i) => (bars[i].style.transform = `scaleY(${Math.max(0.06, Math.min(1, v))})`));
  }

  app.painter.composite();
  app.painter.drawCursor(brush);

  const left = Math.max(0, s.roundDurationMs - s.elapsedMs);
  const secs = String(Math.ceil(left / 1000));
  const timer = $('timer');
  if (timer.textContent !== secs) timer.textContent = secs;
  timer.classList.toggle('urgent', left < 10_000);

  if (now > round.saveAt) {
    storage.saveCurrent(s);
    round.saveAt = now + 1500;
  }
  if (left <= 0) finishRound();
}

function addMark(brush, strokeId, timestamp) {
  const s = app.session;
  const mark = createMark({ brush, facialInput: currentInput().facialInput, timestamp, strokeId });
  s.marks.push(mark);
  app.painter.addMark(mark);
  discover('paint');
  if (mark.visualOutput.shape !== 'line') discover(mark.visualOutput.shape);
  if (Math.abs(mark.visualOutput.rotation) >= 20) discover('rotate');
}

// Discoveries only count in face mode: in mouse mode the rules are printed on screen.
function discover(id) {
  if (app.inputMode !== 'face') return;
  const s = app.session;
  if (!s.discoveredControls.includes(id)) s.discoveredControls.push(id);
  if (!app.discovered.has(id)) {
    app.discovered.add(id);
    round.newlyFound.add(id);
    storage.saveDiscovered([...app.discovered]);
  }
  renderFound();
}

// Seven unlabeled glyphs that fill in as rules are found. No words, on purpose.
function renderFound() {
  const el = $('found');
  if (!el.children.length) {
    CONTROLS.forEach((c) => {
      const g = document.createElement('span');
      g.dataset.id = c.id;
      el.append(g);
    });
  }
  const found = app.session?.discoveredControls ?? [];
  for (const g of el.children) {
    g.classList.toggle('on', found.includes(g.dataset.id) || app.discovered.has(g.dataset.id));
    g.classList.toggle('new', round.newlyFound.has(g.dataset.id));
  }
  const n = CONTROLS.filter((c) => app.discovered.has(c.id)).length;
  el.setAttribute('aria-label', `${n} of ${CONTROLS.length} hidden controls found`);
  el.hidden = app.inputMode !== 'face';
}

// Every color change is stored with its round-relative timestamp so the replay can reproduce it.
function onColorChange(ev) {
  const s = app.session;
  s.events.push(colorChangeEvent({ timestamp: s.elapsedMs, previousColor: ev.previousColor, newColor: ev.newColor, input: ev.via }));
  if (ev.via === 'blink' || ev.via === 'browRaise') discover('color');
  showToast($('color-toast'), ev.newColor);
}

function buildPalette() {
  $('palette').replaceChildren(
    ...PALETTE.map((hex, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal';
      b.style.setProperty('--c', hex);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', COLOR_NAMES[hex]);
      b.title = COLOR_NAMES[hex];
      // Clicking only changes the color: tracking and the timer keep running.
      b.addEventListener('click', () => currentInput()?.setColor(i, 'click'));
      return b;
    }),
  );
  $('replay-palette').replaceChildren(
    ...PALETTE.map((hex) => {
      const sw = document.createElement('span');
      sw.className = 'pal';
      sw.style.setProperty('--c', hex);
      sw.dataset.color = hex;
      return sw;
    }),
  );
}

function renderPalette(color) {
  renderPalette.current = color;
  [...$('palette').children].forEach((b, i) => b.setAttribute('aria-checked', String(PALETTE[i] === color)));
  $('color-name').textContent = COLOR_NAMES[color] || color;
}

function showToast(el, color) {
  el.querySelector('.chip').style.background = color;
  el.querySelector('.name').textContent = COLOR_NAMES[color] || color;
  el.classList.remove('show');
  void el.offsetWidth; // restart the animation
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1100);
}

function undo() {
  const s = app.session;
  if (!s) return;
  if (!s.marks.length && app.clearedMarks?.length) {
    s.marks = app.clearedMarks;
    app.clearedMarks = null;
  } else if (s.marks.length) {
    const last = s.marks[s.marks.length - 1].strokeId;
    s.marks = s.marks.filter((m) => m.strokeId !== last);
  }
  app.painter.redraw(s.marks);
  storage.saveCurrent(s);
}

let clearArmed = 0;
function clearCanvas() {
  const btn = $('btn-clear');
  if (!clearArmed) {
    btn.textContent = 'Clear all?';
    clearArmed = setTimeout(() => {
      clearArmed = 0;
      btn.textContent = 'Clear';
    }, 2500);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = 0;
  btn.textContent = 'Clear';
  const s = app.session;
  if (s.marks.length) app.clearedMarks = s.marks;
  s.marks = [];
  app.painter.redraw(s.marks);
  storage.saveCurrent(s);
}

function stopRound() {
  cancelAnimationFrame(app.loop);
  app.loop = 0;
  app.mouse?.detach();
  app.mouse = null;
  app.tracker.stopLoop();
  app.tracker.onFrame = null;
}

async function finishRound() {
  if (round.finishing || app.screen !== 'draw') return;
  round.finishing = true;
  ++app.flowToken;
  const s = app.session;
  s.elapsedMs = Math.min(s.roundDurationMs, round.base + (performance.now() - round.segmentStart));
  stopRound();
  // Stop recording at the same moment as the timer, then release the camera.
  if (app.recorder) {
    const recorder = app.recorder;
    const rec = await recorder.stop();
    if (app.recorder !== recorder) {
      // The player left while the file was being assembled: throw it away.
      if (rec) URL.revokeObjectURL(rec.url);
      return;
    }
    app.recorder = null;
    if (rec) {
      app.recording = { sessionId: s.id, url: rec.url, mimeType: rec.mimeType, durationMs: rec.durationMs, videoLeadMs: s.recording.videoLeadMs || 0 };
      s.recording.durationMs = rec.durationMs;
    }
  }
  stopCamera();
  s.status = 'finished';
  s.finishedAt = new Date().toISOString();
  s.timing.drawingDurationMs = Math.round(s.elapsedMs);
  storage.saveCurrent(s);
  storage.saveToGallery(s);
  showResults(s, { autoplay: true });
}

// Leave the experience from anywhere: keep unfinished work, release camera, recorder and video.
function goHome() {
  ++app.flowToken;
  if (app.screen === 'draw' && app.session) storage.saveCurrent(app.session);
  stopRound();
  app.recorder?.cancel();
  app.recorder = null;
  discardRecording();
  stopCamera();
  app.replay?.destroy();
  app.editor?.close();
  app.session = null;
  show('landing');
  renderLanding();
}

/* ---------- results: synchronized replay ---------- */

let resultSession = null;
let reflectTimer = 0;
const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function showResults(s, { autoplay }) {
  ++app.flowToken;
  resultSession = s;
  replayColor = null;
  show('results');
  $('result-prompt').textContent = s.prompt.label;
  const secs = Math.round(Math.min(s.elapsedMs, s.roundDurationMs) / 1000);
  $('result-stats').textContent =
    `${s.marks.length} marks in ${secs} seconds` +
    (s.inputMode === 'face' ? `. ${s.discoveredControls.length} of ${CONTROLS.length} controls used.` : ', painted in mouse mode.');
  renderControlsList(s, false);

  const rec = app.recording?.sessionId === s.id ? app.recording : null;
  let note = '';
  if (!rec) {
    if (s.recording?.enabled) note = 'The face video was only kept in memory for that session, so it’s no longer available (it’s cleared on reload, when you leave, or when you delete it). The painting was restored from its saved JSON.';
    else if (s.inputMode === 'mouse') note = 'Mouse rounds aren’t recorded, so this replay shows the painting only.';
    else note = 'You played without recording, so this replay shows the painting only.';
  }
  $('replay-note').hidden = !note;
  $('replay-note').textContent = note;
  $('video-empty').hidden = !!rec;
  $('video-empty').textContent = 'No face video for this painting.';
  $('btn-delete-rec').hidden = !rec;
  document.querySelectorAll('#modes input').forEach((i) => (i.disabled = !rec && i.value !== 'paint'));
  setMode(rec ? 'side' : 'paint');

  app.replay?.destroy();
  app.replay = new SyncReplay({ canvas: $('replay-canvas'), video: $('replay-video'), onTime: updateTransport });
  app.replay.onEnd = () => {
    updateTransport(app.replay.t, app.replay.duration);
    $('reflection').classList.add('shown');
  };
  const duration = s.timing?.drawingDurationMs || s.elapsedMs;
  await app.replay.load(s.marks, duration, rec);
  if (resultSession !== s || app.screen !== 'results') return;
  $('timeline').max = String(Math.round(app.replay.duration));

  clearTimeout(reflectTimer);
  $('reflection').classList.toggle('shown', !autoplay);
  if (autoplay) {
    app.replay.play();
    reflectTimer = setTimeout(() => $('reflection').classList.add('shown'), 6000);
  } else app.replay.seek(app.replay.duration);
  updateTransport(app.replay.t, app.replay.duration);
}

let replayColor = null;
function updateTransport(t, duration) {
  // Show which color was active at this moment of the performance.
  if (resultSession) {
    const c = colorAt(resultSession, t);
    if (c !== replayColor) {
      if (replayColor && app.replay?.playing) showToast($('replay-toast'), c);
      replayColor = c;
      $('replay-palette').querySelectorAll('.pal').forEach((sw) => sw.classList.toggle('on', sw.dataset.color === c));
      $('replay-palette').setAttribute('aria-label', `Color at this moment: ${COLOR_NAMES[c] || c}`);
    }
  }
  const tl = $('timeline');
  if (document.activeElement !== tl || !tl.dataset.dragging) tl.value = String(Math.round(t));
  $('time-label').textContent = `${fmt(t)} / ${fmt(duration)}`;
  $('btn-playpause').textContent = app.replay?.playing ? 'Pause' : 'Play';
}

function setMode(mode) {
  $('stage').dataset.mode = mode;
  document.querySelectorAll('#modes input').forEach((i) => (i.checked = i.value === mode));
}

function renderControlsList(s, revealAll) {
  const mouse = s.inputMode === 'mouse';
  $('controls-title').textContent = mouse ? 'With a camera, your face would do this' : 'What your face was doing';
  revealAll ||= mouse;
  const list = $('controls-list');
  list.replaceChildren();
  let hidden = 0;
  for (const c of CONTROLS) {
    const li = document.createElement('li');
    const used = s.discoveredControls.includes(c.id);
    const known = used || app.discovered.has(c.id);
    if (known || revealAll) {
      li.textContent = c.label;
      li.className = used ? 'used' : 'known';
    } else {
      li.textContent = 'Something you haven’t found yet.';
      li.className = 'unknown';
      hidden++;
    }
    list.append(li);
  }
  $('btn-reveal').hidden = !hidden;
}

function saveResultSession() {
  const s = resultSession;
  if (!s) return;
  storage.saveToGallery(s);
  const cur = storage.loadCurrent();
  if (cur?.id === s.id) storage.saveCurrent(s);
}

function openEditor() {
  const s = resultSession;
  app.replay?.stop();
  show('editor');
  app.editor?.close();
  app.editor = new MarkEditor($('editor-canvas'), { onChange: saveResultSession, onSelect: renderMarkPanel });
  app.editor.open(s.marks);
  renderMarkPanel(null);
}

function renderMarkPanel(mark) {
  $('editor-empty').hidden = !!mark;
  $('editor-controls').hidden = !mark;
  $('editor-title').textContent = `Your marks: ${resultSession?.marks.length ?? 0}`;
  if (!mark) return;
  const v = mark.visualOutput;
  for (const input of $('swatches').querySelectorAll('input')) input.checked = input.value === v.color;
  $('mark-size').value = v.size;
  $('mark-json').textContent = JSON.stringify(mark, null, 2);
}

function buildSwatches() {
  const fs = $('swatches');
  PALETTE.forEach((hex, i) => {
    const label = document.createElement('label');
    label.className = 'swatch';
    label.style.setProperty('--c', hex);
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'mark-color';
    input.value = hex;
    input.setAttribute('aria-label', `Color ${i + 1} (${hex})`);
    input.addEventListener('change', () => app.editor?.update({ color: hex }));
    label.append(input);
    fs.append(label);
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Full painting, independent of where the replay is paused.
async function saveImage() {
  const p = new Painter(document.createElement('canvas'));
  p.redraw(resultSession.marks);
  download(await p.toBlob(), `do-you-see-what-i-mean-${resultSession.prompt.id}.png`);
}

/* ---------- wiring ---------- */

function bind() {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('btn-start', () => {
    app.inputMode = null; // first visit: explain the camera before asking for it
    newGame();
  });
  on('btn-continue', () => {
    app.session = storage.loadCurrent();
    app.resuming = true;
    show('consent');
  });
  on('btn-camera', chooseCamera);
  on('btn-mouse', chooseMouse);
  on('btn-calib-mouse', chooseMouse);
  on('btn-calib-retry', () => app.calibUI?.retry());
  on('btn-calib-fallback', () => app.calibUI?.fallback());
  on('btn-practice-clear', () => app.practice?.clearMarks());
  on('btn-ready', leavePractice);
  on('btn-record-yes', () => {
    app.wantRecording = true;
    showPrompt();
  });
  on('btn-record-no', () => {
    app.wantRecording = false;
    showPrompt();
  });
  on('btn-undo', undo);
  on('btn-clear', clearCanvas);
  on('btn-finish', finishRound);
  on('btn-restart-game', restartGame);
  on('btn-playpause', () => {
    app.replay?.toggle();
    updateTransport(app.replay.t, app.replay.duration);
  });
  // REPLAY PERFORMANCE: plays the existing video + painting from the start. Never recalibrates.
  on('btn-replay', () => app.replay?.restart());
  on('btn-delete-rec', () => {
    discardRecording();
    showResults(resultSession, { autoplay: false });
  });
  on('btn-save', saveImage);
  on('btn-explore', openEditor);
  on('btn-again', newGame);
  on('btn-reveal', () => renderControlsList(resultSession, true));
  on('btn-editor-done', () => {
    app.editor?.close();
    showResults(resultSession, { autoplay: false });
  });
  on('btn-download-json', () => {
    const blob = new Blob([serializeSession(resultSession, true)], { type: 'application/json' });
    download(blob, `do-you-see-what-i-mean-${resultSession.prompt.id}.json`);
  });
  on('btn-mark-delete', () => app.editor?.remove());
  on('btn-mark-play', () => app.editor?.animateSelected());
  on('btn-reset', () => {
    const b = $('btn-reset');
    if (b.dataset.armed) {
      storage.resetAll();
      app.discovered = new Set();
      b.textContent = 'Saved data cleared';
      delete b.dataset.armed;
      renderLanding();
      setTimeout(() => (b.textContent = 'Reset saved data'), 2500);
    } else {
      b.dataset.armed = '1';
      b.textContent = 'Delete all paintings and settings? Click again';
      setTimeout(() => {
        if (b.dataset.armed) {
          delete b.dataset.armed;
          b.textContent = 'Reset saved data';
        }
      }, 4000);
    }
  });

  const tl = $('timeline');
  tl.addEventListener('pointerdown', () => (tl.dataset.dragging = '1'));
  tl.addEventListener('pointerup', () => delete tl.dataset.dragging);
  tl.addEventListener('input', () => app.replay?.seek(Number(tl.value)));
  document.querySelectorAll('#modes input').forEach((i) => i.addEventListener('change', () => setMode(i.value)));

  $('mark-size').addEventListener('input', (e) => app.editor?.update({ size: Number(e.target.value) }));
  document.querySelectorAll('[data-action=home], [data-action=quit]').forEach((b) => b.addEventListener('click', goHome));

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (app.screen === 'draw' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    }
    if (app.screen === 'draw' && app.inputMode === 'face' && e.key.toLowerCase() === 'c' && !e.repeat) app.mapper?.nextColor('key');
    if (app.screen === 'results' && e.code === 'Space' && !e.target.closest('button')) {
      e.preventDefault();
      app.replay?.toggle();
    }
  });

  $('editor-canvas').addEventListener('keydown', (e) => {
    const ed = app.editor;
    if (!ed) return;
    const step = e.shiftKey ? 20 : 4;
    const keys = {
      '[': () => ed.selectRelative(-1),
      ']': () => ed.selectRelative(1),
      ArrowLeft: () => ed.nudge(-step, 0),
      ArrowRight: () => ed.nudge(step, 0),
      ArrowUp: () => ed.nudge(0, -step),
      ArrowDown: () => ed.nudge(0, step),
      Delete: () => ed.remove(),
      Backspace: () => ed.remove(),
      Escape: () => ed.select(null),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  });

  const video = $('video');
  video.addEventListener('loadedmetadata', () => {
    const o = $('face-overlay');
    o.width = video.videoWidth;
    o.height = video.videoHeight;
  });

  // Save unfinished work (JSON only) and release camera, recorder and video when the page goes away.
  const persist = () => {
    if (app.screen === 'draw' && app.session) storage.saveCurrent(app.session);
  };
  document.addEventListener('visibilitychange', () => document.hidden && persist());
  window.addEventListener('pagehide', () => {
    persist();
    app.recorder?.cancel();
    discardRecording();
    app.tracker.stop();
  });
}

async function init() {
  try {
    const res = await fetch('data/prompts.json');
    app.prompts = await res.json();
  } catch {
    app.prompts = [{ id: 'sun', label: 'a sun', level: 'beginner' }];
  }
  buildSwatches();
  buildPalette();
  bind();
  show('landing');
  renderLanding();
}

init();
