// Local face recording with MediaRecorder, for the synchronized replay.
// The video is kept in memory only: chunks → one Blob → a blob: URL. It is never uploaded,
// never sent to an API, and never written to localStorage or the session JSON.

const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

export class FaceRecorder {
  static supported() {
    return typeof window !== 'undefined' && typeof window.MediaRecorder === 'function';
  }

  static pickType() {
    for (const t of TYPES) if (MediaRecorder.isTypeSupported?.(t)) return t;
    return '';
  }

  constructor(stream) {
    const mimeType = FaceRecorder.pickType();
    // Video only; the camera stream was requested without audio.
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 1_500_000 } : undefined);
    this.mimeType = this.rec.mimeType || mimeType || 'video/webm';
    this.chunks = [];
    this.startPerf = null;
    this.rec.addEventListener('dataavailable', (e) => e.data?.size && this.chunks.push(e.data));
  }

  get active() {
    return this.rec.state !== 'inactive';
  }

  // Resolves with the performance.now() time at which recording actually started,
  // which is what video time 0 corresponds to.
  start() {
    return new Promise((resolve) => {
      const done = () => {
        this.startPerf ??= performance.now();
        resolve(this.startPerf);
      };
      this.rec.addEventListener('start', done, { once: true });
      setTimeout(done, 1500); // never block the round if the event is late
      this.rec.start(1000); // 1 s chunks, so little is lost if the tab is closed mid-round
    });
  }

  // Stops and assembles the in-memory Blob. The caller owns the returned URL and must revoke it.
  stop() {
    return new Promise((resolve) => {
      if (this.rec.state === 'inactive') return resolve(this._assemble(performance.now()));
      this.rec.addEventListener('stop', () => resolve(this._assemble(this._stopPerf)), { once: true });
      this._stopPerf = performance.now();
      this.rec.stop();
    });
  }

  // Stop and throw the data away (leaving mid-round).
  cancel() {
    if (this.rec.state !== 'inactive') this.rec.stop();
    this.chunks = [];
  }

  _assemble(stopPerf) {
    if (!this.chunks.length) return null;
    const blob = new Blob(this.chunks, { type: this.mimeType });
    this.chunks = [];
    return {
      url: URL.createObjectURL(blob),
      size: blob.size,
      mimeType: this.mimeType,
      durationMs: Math.round(stopPerf - (this.startPerf ?? stopPerf)),
    };
  }
}
