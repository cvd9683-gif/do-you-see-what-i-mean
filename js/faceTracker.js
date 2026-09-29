// Face tracking: webcam access + MediaPipe Face Landmarker, all running in this tab.
// Frames go from <video> straight into the model and are never copied, stored or sent.

const MP_VERSION = '1.0.1';
const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Landmark indices in MediaPipe's 478-point face mesh.
const LM = { nose: 1, cheekR: 234, cheekL: 454, forehead: 10, chin: 152, eyeOuterR: 33, eyeOuterL: 263 };

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.vision = null;
    this.onFrame = null; // (features, landmarks) => void
    this._raf = 0;
    this._lastVideoTime = -1;
  }

  get cameraOn() {
    return !!this.stream;
  }

  async startCamera() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
  }

  // Loaded lazily so mouse mode works even when the CDN is unreachable.
  async loadModel() {
    if (this.landmarker) return;
    this.vision = await import(MP_BUNDLE);
    const { FaceLandmarker, FilesetResolver } = this.vision;
    const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch (err) {
      console.warn('GPU delegate unavailable, falling back to CPU', err);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
    }
  }

  get connections() {
    const F = this.vision?.FaceLandmarker;
    if (!F) return [];
    return [
      F.FACE_LANDMARKS_FACE_OVAL,
      F.FACE_LANDMARKS_LIPS,
      F.FACE_LANDMARKS_LEFT_EYE,
      F.FACE_LANDMARKS_RIGHT_EYE,
      F.FACE_LANDMARKS_LEFT_EYEBROW,
      F.FACE_LANDMARKS_RIGHT_EYEBROW,
    ];
  }

  startLoop() {
    cancelAnimationFrame(this._raf);
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      const v = this.video;
      const now = performance.now();
      // Watchdog: if the stream stops delivering frames (e.g. the element was paused), nudge it.
      if (v.currentTime !== this._lastVideoTime) this._lastFreshAt = now;
      else if (this.stream && now - (this._lastFreshAt ?? now) > 1500) {
        this._lastFreshAt = now;
        v.play().catch(() => {});
      }
      if (!this.landmarker || v.readyState < 2 || v.currentTime === this._lastVideoTime) return;
      this._lastVideoTime = v.currentTime;
      let result;
      try {
        result = this.landmarker.detectForVideo(v, now);
      } catch (err) {
        console.warn('detectForVideo failed', err);
        return;
      }
      const lms = result.faceLandmarks?.[0];
      const features = extractFeatures(result, v.videoWidth, v.videoHeight, now);
      this.onFrame?.(features, lms || null);
    };
    loop();
  }

  stopLoop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  // Fully release the webcam: the browser's camera indicator turns off.
  stop() {
    this.stopLoop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this._lastVideoTime = -1;
  }
}

// Turn one MediaPipe result into a small bag of numbers. This is all the game ever keeps.
// headX / headY / tilt are computed in *mirrored* space so they match what the player sees.
export function extractFeatures(result, vw, vh, t) {
  const lm = result.faceLandmarks?.[0];
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!lm || !cats) return { present: false, t };

  const b = {};
  for (const c of cats) b[c.categoryName] = c.score;

  const mx = (p) => (1 - p.x) * vw;
  const my = (p) => p.y * vh;
  const nose = lm[LM.nose], cR = lm[LM.cheekR], cL = lm[LM.cheekL];
  const top = lm[LM.forehead], chin = lm[LM.chin];
  const eR = lm[LM.eyeOuterR], eL = lm[LM.eyeOuterL];

  const faceW = Math.hypot(mx(cL) - mx(cR), my(cL) - my(cR)) || 1;
  const faceH = Math.hypot(mx(chin) - mx(top), my(chin) - my(top)) || 1;
  // The face's own axes: u runs along the eye line (toward screen-right), v is perpendicular to it
  // (toward the chin). Measuring along these instead of the screen's x/y means a slightly tilted
  // head can't leak a turn into a nod: e.g. turning left no longer reads as looking down.
  const eyeLen = Math.hypot(mx(eR) - mx(eL), my(eR) - my(eL)) || 1;
  const ux = (mx(eR) - mx(eL)) / eyeLen, uy = (my(eR) - my(eL)) / eyeLen;
  const vx = -uy, vy = ux;
  // Nose offset from the face's centre line approximates yaw; from its mid-height, pitch.
  const sx = mx(nose) - (mx(cR) + mx(cL)) / 2, sy = my(nose) - (my(cR) + my(cL)) / 2;
  const px = mx(nose) - (mx(top) + mx(chin)) / 2, py = my(nose) - (my(top) + my(chin)) / 2;
  const headX = (sx * ux + sy * uy) / faceW;
  const headY = (px * vx + py * vy) / faceH;
  // Roll: angle of the line between the outer eye corners, as seen in the mirror.
  const tilt = (Math.atan2(my(eR) - my(eL), mx(eR) - mx(eL)) * 180) / Math.PI;

  return {
    present: true,
    t,
    headX,
    headY,
    tilt,
    mouthOpen: b.jawOpen ?? 0,
    smileL: b.mouthSmileLeft ?? 0,
    smileR: b.mouthSmileRight ?? 0,
    browDownL: b.browDownLeft ?? 0,
    browDownR: b.browDownRight ?? 0,
    browUp: b.browInnerUp ?? 0,
    blinkL: b.eyeBlinkLeft ?? 0,
    blinkR: b.eyeBlinkRight ?? 0,
  };
}

// Draws a thin face outline on the (CSS-mirrored) preview overlay: live proof of what is tracked.
export function drawFaceOutline(ctx, landmarks, connections, color = '#141414') {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, w / 320);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const set of connections) {
    for (const { start, end } of set) {
      const a = landmarks[start], b = landmarks[end];
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
    }
  }
  ctx.stroke();
}
