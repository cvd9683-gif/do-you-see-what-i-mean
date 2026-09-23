// Game state + screen flow. Wires the tracker, mapper, painter and storage together.

import { CANVAS_W, CANVAS_H, PALETTE, CONTROLS, DEFAULT_SETTINGS } from './config.js';
import { FaceTracker, drawFaceOutline } from './faceTracker.js';
import { Calibrator, STEPS, DEFAULT_CALIBRATION } from './calibration.js';
import { BrushMapper } from './mapping.js';
import { MouseInput } from './mouseInput.js';
import { Painter, renderThumbnail } from './renderer.js';
import { createSession, createMark, serializeSession, uid } from './session.js';
import { storage } from './storage.js';
import { Replay, MarkEditor } from './results.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const app = {
  screen: 'landing',
  prompts: [],
  session: null,
  inputMode: null, // 'face' | 'mouse'
  tracker: new FaceTracker($('video')),
  calibration: storage.loadCalibration(),
  settings: { ...DEFAULT_SETTINGS, ...storage.loadSettings() },
  discovered: new Set(storage.loadDiscovered()),
  mapper: null,
  mouse: null,
  painter: null,
  replay: null,
  editor: null,
  audio: null,
  loop: 0,
  flowToken: 0, // bumps whenever the flow is interrupted, cancelling pending async steps
};

// Exposed for debugging and automated checks. Contains data only — never video frames.
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
}

function moveVideoTo(slotId) {
  const wrap = $('video-wrap');
  $(slotId).appendChild(wrap);
  $('video').play().catch(() => {});
}

function stopCamera() {
  app.tracker.stop();
  app.tracker.onFrame = null;
  $('video-holder').appendChild($('video-wrap'));
  setCameraPill();
}

/* ---------- landing ---------- */

function renderLanding() {
  const cur = storage.loadCurrent();
  const cont = $('btn-continue');
  if (cur && cur.status === 'drawing' && cur.elapsedMs < cur.settings.roundMs) {
    const left = Math.ceil((cur.settings.roundMs - cur.elapsedMs) / 1000);
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
    b.addEventListener('click', () => showResults(s, { animate: false }));
    li.append(b);
    list.append(li);
  }
  paintHero();
}

// The one orchestrated moment: the landing title gets painted over by the game's own brush.
let heroPainter = null;
function paintHero() {
  const canvas = $('hero-canvas');
  heroPainter ??= new Painter(canvas);
  const marks = [];
  let seed = 11;
  const shapes = ['rounded', 'line', 'angular', 'rounded', 'line'];
  for (let i = 0; i < 34; i++) {
    const r = (Math.sin(seed++ * 12.9898) * 43758.5453) % 1;
    const q = (Math.sin(seed++ * 78.233) * 12345.678) % 1;
    const a = Math.abs(r), b = Math.abs(q);
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
  // Audio needs a user gesture; the tone tells players with closed eyes when to open them.
  app.audio ??= new (window.AudioContext || window.webkitAudioContext)();
  $('btn-camera').disabled = true;
  try {
    await app.tracker.startCamera();
  } catch (err) {
    console.warn('Camera failed', err);
    $('consent-error').textContent = cameraErrorMessage(err);
    $('btn-camera').disabled = false;
    return;
  }
  $('btn-camera').disabled = false;
  if (token !== app.flowToken) return stopCamera();
  app.inputMode = 'face';
  setCameraPill();
  show('calibrate');
  moveVideoTo('calib-video-slot');
  $('calib-count').textContent = 'Getting ready';
  $('calib-instruction').textContent = 'Loading the face model…';
  $('calib-bar').style.width = '0%';
  try {
    await app.tracker.loadModel();
  } catch (err) {
    console.error('Face model failed to load', err);
    $('calib-instruction').textContent = 'The face model didn’t load.';
    $('calib-hint').textContent = 'Check your internet connection and reload, or play with a mouse instead.';
    return;
  }
  if (token !== app.flowToken) return;
  if (app.calibration && !app.calibration.defaults) return showPrompt({ canRecalibrate: true });
  runCalibration();
}

function runCalibration() {
  const token = ++app.flowToken;
  show('calibrate');
  moveVideoTo('calib-video-slot');
  $('calib-hint').textContent = 'Follow each instruction. Nothing you do here is painted.';
  const cal = new Calibrator(STEPS);
  const overlay = $('face-overlay').getContext('2d');
  let lastIndex = -1;
  app.tracker.onFrame = (f, lms) => {
    if (token !== app.flowToken) return;
    drawFaceOutline(overlay, lms, app.tracker.connections);
    const st = cal.addSample(f);
    if (st.done) {
      app.tracker.onFrame = null;
      beep();
      app.calibration = cal.result();
      storage.saveCalibration(app.calibration);
      $('calib-bar').style.width = '100%';
      $('calib-instruction').textContent = 'Got it. You can open your eyes.';
      wait(900).then(() => token === app.flowToken && showPrompt({ canRecalibrate: false }));
      return;
    }
    if (st.index !== lastIndex) {
      lastIndex = st.index;
      $('calib-count').textContent = `Step ${st.index + 1} of ${STEPS.length}`;
      $('calib-instruction').textContent = st.step.say;
    }
    $('calib-bar').style.width = `${Math.round(((st.index + st.progress) / STEPS.length) * 100)}%`;
    $('calib-hint').textContent = st.facePresent ? 'Nothing you do here is painted.' : 'I can’t see your face. Move so it’s in the frame and well lit.';
  };
  app.tracker.startLoop();
}

function beep() {
  const ctx = app.audio;
  if (!ctx) return;
  ctx.resume?.();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 660;
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.4);
}

function chooseMouse() {
  ++app.flowToken;
  stopCamera();
  app.inputMode = 'mouse';
  showPrompt({ canRecalibrate: false });
}

/* ---------- prompt ---------- */

function pickPrompt() {
  const last = storage.loadGallery()[0]?.prompt?.id;
  const pool = app.prompts.filter((p) => p.id !== last);
  return pool[Math.floor(Math.random() * pool.length)] || app.prompts[0];
}

async function showPrompt({ canRecalibrate }) {
  const token = ++app.flowToken;
  if (!app.session || app.session.status !== 'drawing') app.session = null;
  const prompt = app.session?.prompt ?? pickPrompt();
  app.pendingPrompt = prompt;
  $('prompt-word').textContent = prompt.label;
  $('btn-recalibrate').hidden = !(canRecalibrate && app.inputMode === 'face');
  show('prompt');
  const beat = reduceMotion() ? 900 : 800;
  for (const n of ['3', '2', '1']) {
    $('prompt-count').textContent = n;
    await wait(beat);
    if (token !== app.flowToken) return;
  }
  startDrawing();
}

/* ---------- drawing ---------- */

const round = {
  lastT: 0,
  strokeId: null,
  lastDab: null,
  lastDabAt: 0,
  range: null,
  faceLostAt: null,
  newlyFound: new Set(),
  saveAt: 0,
};

function startDrawing() {
  const token = ++app.flowToken;
  if (!app.session) {
    app.session = createSession({
      prompt: app.pendingPrompt,
      inputMode: app.inputMode,
      calibration: app.inputMode === 'face' ? app.calibration : null,
      settings: app.settings,
    });
  }
  const s = app.session;
  s.inputMode = app.inputMode;
  if (app.inputMode === 'face') s.calibration = app.calibration;
  storage.saveCurrent(s);

  show('draw');
  $('draw-prompt').textContent = `Draw ${s.prompt.label}`;
  app.painter ??= new Painter($('paint-canvas'));
  app.painter.redraw(s.marks);

  Object.assign(round, {
    lastT: performance.now(),
    strokeId: null,
    lastDab: null,
    range: { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity },
    faceLostAt: null,
    newlyFound: new Set(),
    saveAt: performance.now() + 1500,
  });
  renderFound();

  const face = app.inputMode === 'face';
  $('mouse-help').hidden = face;
  $('stamp-mode-wrap').hidden = !face;
  document.querySelector('.draw-side .preview').hidden = !face;
  $('signals').hidden = !face;
  $('face-status').textContent = '';

  if (face) {
    moveVideoTo('draw-video-slot');
    app.mapper = new BrushMapper({ calibration: app.calibration || DEFAULT_CALIBRATION, settings: app.settings });
    const sel = $('stamp-mode');
    sel.querySelector('[value=blink]').disabled = !app.mapper.cal.blink.reliable;
    sel.value = app.mapper.stampMode;
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
  $('paint-canvas').parentElement.focus?.();
  cancelAnimationFrame(app.loop);
  app.loop = requestAnimationFrame(tick);
}

function currentInput() {
  return app.inputMode === 'face' ? app.mapper : app.mouse;
}

function tick(now) {
  app.loop = requestAnimationFrame(tick);
  const s = app.session;
  const dt = Math.min(100, now - round.lastT);
  round.lastT = now;
  s.elapsedMs += dt;

  const input = currentInput();
  const brush = app.inputMode === 'face' ? input.state : input.tick(dt);

  for (const ev of input.drainEvents()) {
    if (ev.type === 'stamp') stamp();
    if (ev.type === 'color') discover('color');
  }

  if (brush.present) {
    const r = round.range;
    r.x0 = Math.min(r.x0, brush.x); r.x1 = Math.max(r.x1, brush.x);
    r.y0 = Math.min(r.y0, brush.y); r.y1 = Math.max(r.y1, brush.y);
    if (r.x1 - r.x0 > CANVAS_W * 0.4) discover('moveX');
    if (r.y1 - r.y0 > CANVAS_H * 0.4) discover('moveY');
  }

  // Paint a trail of independent dabs while the brush is "down".
  if (brush.present && brush.painting) {
    if (!round.strokeId) {
      round.strokeId = uid('k');
      round.lastDab = null;
    }
    const spacing = Math.max(5, brush.size * 0.28);
    const far = !round.lastDab || Math.hypot(brush.x - round.lastDab.x, brush.y - round.lastDab.y) >= spacing;
    if (far || now - round.lastDabAt > 260) {
      addMark(brush, 'paint', round.strokeId);
      round.lastDab = { x: brush.x, y: brush.y };
      round.lastDabAt = now;
    }
  } else round.strokeId = null;

  // Face-lost notice, only after a moment so single dropped frames don't flash it.
  if (app.inputMode === 'face') {
    if (!brush.present) round.faceLostAt ??= now;
    else round.faceLostAt = null;
    const lost = round.faceLostAt && now - round.faceLostAt > 600;
    const msg = lost ? 'Can’t see your face. Move back into the frame.' : '';
    if ($('face-status').textContent !== msg) $('face-status').textContent = msg;
    const sig = brush.signals;
    const bars = $('signals').children;
    [sig.mouth, sig.smile, sig.brow, sig.browUp, sig.blink].forEach((v, i) => {
      bars[i].style.transform = `scaleY(${Math.max(0.06, Math.min(1, v))})`;
    });
  }

  app.painter.composite();
  app.painter.drawCursor(brush);

  const left = Math.max(0, s.settings.roundMs - s.elapsedMs);
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

function addMark(brush, trigger, strokeId) {
  const s = app.session;
  const mark = createMark({
    brush,
    facialInput: currentInput().facialInput,
    timestamp: s.elapsedMs,
    strokeId,
    trigger,
  });
  s.marks.push(mark);
  app.painter.addMark(mark);
  if (trigger === 'paint') discover('paint');
  if (mark.visualOutput.shape !== 'line') discover(mark.visualOutput.shape);
  if (Math.abs(mark.visualOutput.rotation) >= 20) discover('rotate');
  return mark;
}

function stamp() {
  const brush = currentInput().state;
  if (!brush.present || app.screen !== 'draw') return;
  addMark(brush, 'stamp', uid('k'));
  discover('stamp');
}

// Discoveries only count in face mode: in demo mode the rules are printed on screen.
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

// Eight unlabeled glyphs that fill in as rules are found. No words, on purpose.
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

function finishRound() {
  const s = app.session;
  stopRound();
  stopCamera(); // the round is over: release the webcam immediately
  s.status = 'finished';
  s.finishedAt = new Date().toISOString();
  s.elapsedMs = Math.min(s.elapsedMs, s.settings.roundMs);
  storage.saveCurrent(s);
  storage.saveToGallery(s);
  showResults(s, { animate: true });
}

// Leave the experience from anywhere: keep unfinished work, release the camera.
function goHome() {
  ++app.flowToken;
  if (app.screen === 'draw' && app.session) storage.saveCurrent(app.session);
  stopRound();
  stopCamera();
  app.replay?.stop();
  app.editor?.close();
  app.session = null;
  show('landing');
  renderLanding();
}

/* ---------- results + editor ---------- */

let resultSession = null;

async function showResults(s, { animate }) {
  ++app.flowToken;
  resultSession = s;
  show('results');
  $('result-prompt').textContent = s.prompt.label;
  const secs = Math.round(Math.min(s.elapsedMs, s.settings.roundMs) / 1000);
  const found = s.discoveredControls.length;
  $('result-stats').textContent =
    `${s.marks.length} marks in ${secs} seconds` +
    (s.inputMode === 'face' ? `. ${found} of ${CONTROLS.length} hidden controls used.` : ', painted in mouse mode.');
  renderControlsList(s, false);
  app.replay ??= new Replay($('result-canvas'));
  const refl = $('reflection');
  if (animate) {
    refl.classList.remove('shown');
    await app.replay.play(s.marks);
    if (resultSession === s) refl.classList.add('shown');
  } else {
    app.replay.showStatic(s.marks);
    refl.classList.add('shown');
  }
}

function renderControlsList(s, revealAll) {
  // Mouse paintings had no face to discover rules with, so show what face mode would have used.
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
  app.editor = new MarkEditor($('editor-canvas'), {
    onChange: saveResultSession,
    onSelect: renderMarkPanel,
  });
  app.editor.open(s.marks);
  renderMarkPanel(null);
  $('editor-title').textContent = `Your marks: ${s.marks.length}`;
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

/* ---------- wiring ---------- */

function bind() {
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('btn-start', () => {
    app.session = null;
    show('consent');
  });
  on('btn-continue', () => {
    app.session = storage.loadCurrent();
    show('consent');
  });
  on('btn-camera', chooseCamera);
  on('btn-mouse', chooseMouse);
  on('btn-calib-mouse', chooseMouse);
  on('btn-recalibrate', runCalibration);
  on('btn-undo', undo);
  on('btn-clear', clearCanvas);
  on('btn-finish', finishRound);
  on('btn-replay', () => resultSession && app.replay.play(resultSession.marks));
  on('btn-save', async () => {
    const blob = await app.replay.painter.toBlob();
    download(blob, `do-you-see-what-i-mean-${resultSession.prompt.id}.png`);
  });
  on('btn-explore', openEditor);
  on('btn-again', () => {
    app.session = null;
    storage.clearCurrent();
    show('consent');
  });
  on('btn-reveal', () => renderControlsList(resultSession, true));
  on('btn-editor-done', () => {
    app.editor?.close();
    showResults(resultSession, { animate: false });
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
      app.calibration = null;
      app.discovered = new Set();
      app.settings = { ...DEFAULT_SETTINGS };
      b.textContent = 'Saved data cleared';
      delete b.dataset.armed;
      renderLanding();
      setTimeout(() => (b.textContent = 'Reset saved data'), 2500);
    } else {
      b.dataset.armed = '1';
      b.textContent = 'Delete all paintings and calibration? Click again';
      setTimeout(() => {
        if (b.dataset.armed) {
          delete b.dataset.armed;
          b.textContent = 'Reset saved data';
        }
      }, 4000);
    }
  });
  $('mark-size').addEventListener('input', (e) => app.editor?.update({ size: Number(e.target.value) }));
  $('stamp-mode').addEventListener('change', (e) => {
    app.settings.stampMode = e.target.value;
    app.mapper?.setStampMode(e.target.value);
    storage.saveSettings({ stampMode: e.target.value });
    if (app.session) app.session.settings.stampMode = e.target.value;
  });
  document.querySelectorAll('[data-action=home], [data-action=quit]').forEach((b) => b.addEventListener('click', goHome));

  // Space stamps during a round (the always-available fallback to blinking).
  window.addEventListener('keydown', (e) => {
    if (app.screen === 'draw' && e.code === 'Space' && !e.repeat && !e.target.closest('button, select, input')) {
      e.preventDefault();
      stamp();
    }
    if (app.screen === 'draw' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
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

  // Save unfinished work and release the camera whenever the page goes away.
  const persist = () => {
    if (app.screen === 'draw' && app.session) storage.saveCurrent(app.session);
  };
  document.addEventListener('visibilitychange', () => document.hidden && persist());
  window.addEventListener('pagehide', () => {
    persist();
    app.tracker.stop();
  });
}

async function init() {
  try {
    const res = await fetch('data/prompts.json');
    app.prompts = await res.json();
  } catch {
    app.prompts = [{ id: 'flower', label: 'a flower' }];
  }
  buildSwatches();
  bind();
  show('landing');
  renderLanding();
}

init();
