# Do You See What I Mean?

**Pictionary, except you paint with your face.**

You get a simple prompt (“Draw a fish”) and 60 seconds. There is no brush, no mouse and no manual. Your webcam watches your head and face, and those movements steer a painting tool. At first the controls feel mysterious. They are consistent, though, so you can learn them.

## Concept

The game is about the gap between *machine recognition* and *human understanding*.

A face-tracking model can measure a lot about your face: how far your jaw has dropped, how much the corners of your mouth have lifted, the angle of your head. It cannot know what you meant. It doesn't know you were smiling because the fish looked funny, or frowning because you were concentrating on the tail. To draw well, the player has to perform *for* the machine. They learn which exaggerated expressions it can read and bend their intentions into signals it can sense.

The game keeps this quiet while you play. It comes back in a short reflection at the end:

> You learned how to make yourself legible to the machine. But did it ever understand what you were trying to draw?

### AI as power steering, not the artist

No generative model is involved. Nothing is "completed", "improved" or "interpreted" for you. **The player makes every mark.** The ML model only produces measurements. Hand-written rules turn those measurements into brush position, size, shape, rotation and color. Everything on the canvas is the direct, traceable result of something your face did, and you can inspect that trace mark by mark afterwards.

## How the ML model is used

[MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) runs in the browser on each webcam frame (WebAssembly, GPU delegate with CPU fallback). For every frame it returns:

- **478 face landmarks.** The game uses a handful to estimate head turn (nose offset from the face's center line), head nod (nose offset from mid-face height) and head tilt (the angle between the outer eye corners). All three are computed in *mirrored* space, so moving left moves the brush left.
- **52 blendshape scores (0–1).** The game uses `jawOpen`, `mouthSmileLeft/Right`, `browDownLeft/Right`, `browInnerUp` and `eyeBlinkLeft/Right`.

These are **detected facial movements, not emotions**. A high `mouthSmile` score means the corners of the mouth moved. It does not mean you were happy.

### Calibration

A 20-second guided sequence (face forward, turn left and right, look up and down, smile, open mouth, furrow and raise brows, close eyes) records your neutral face and your comfortable range for each movement. Every signal is then normalized *to you*. The calibration steps don't say what each gesture will paint.

Calibration also checks whether blinks can be detected reliably. Eyelids drop when you look down, so the blink threshold has to clear that too. If blinks aren't separable, stamping switches to the hold-still fallback.

### Facial controls (spoilers)

| Movement | Signal | Effect |
| --- | --- | --- |
| Turn head left / right | nose offset, calibrated | brush moves horizontally |
| Tip head up / down | nose offset, calibrated | brush moves vertically |
| Open mouth | `jawOpen` | paints while open (after a 120 ms beat); wider makes a bigger brush |
| Smile | `mouthSmile*` | rounded, watercolor blob marks |
| Lower / furrow brows | `browDown*` | sharp, angular shard marks |
| Tilt head | eye-line angle | rotates the mark |
| Hold a long blink (≥280 ms, both eyes) | `eyeBlink*` | stamps one bold mark |
| Raise eyebrows | `browInnerUp` | cycles to the next color |

With neither a smile nor a frown, the brush makes dry-brush strokes.

**Fallbacks:** the **Space bar** always stamps. If blinks aren't reliable, **holding the brush still** for 1.2 s stamps instead. You can switch between the two during a round.

**Smoothing:** head position goes through a [1€ filter](https://gery.casiez.net/1euro/), which smooths heavily when you're still and lightly when you move fast. A 4 px dead-band sits on top. Expression scores use an exponential moving average. Painting and color changes use hysteresis and cooldowns so they don't flicker near a threshold. In an automated test on a still face with sensor noise, frame-to-frame cursor movement fell from about 2.9 px to under 0.2 px.

**Discovery:** eight unlabeled glyphs on the drawing screen fill in as you trigger each hidden rule. The results screen names the rules you found. You can choose to reveal the rest.

## Technology and APIs

- Plain HTML, CSS and JavaScript ES modules. No framework and no build step.
- HTML Canvas 2D for all rendering. Marks are drawn procedurally from a seed: layered translucent wobbly fills, bristle strokes, granulation, and `multiply` compositing over generated paper grain.
- `navigator.mediaDevices.getUserMedia()` for the webcam.
- `@mediapipe/tasks-vision` 1.0.1 (the current Tasks API, loaded from jsDelivr) and the `face_landmarker.task` float16 model (loaded from Google's model storage).
- JSON for all painting data.
- `localStorage` for autosave, calibration, discovered controls, settings and the gallery.
- Web Audio for one short tone that tells you to open your eyes after the eyes-closed calibration step.
- Google Fonts: Bricolage Grotesque (display) and Atkinson Hyperlegible (body).

### Code layout

```
index.html
css/style.css
data/prompts.json          prompt list
js/config.js               constants: canvas size, palette, controls, default settings
js/faceTracker.js          webcam + MediaPipe, feature extraction, face outline
js/calibration.js          calibration steps and per-player ranges
js/mapping.js              gesture → brush: 1€ filter, normalization, thresholds, blink/dwell stamping
js/mouseInput.js           mouse/pen demo mode with the same brush interface
js/renderer.js             paper texture, procedural marks, hit-testing, cursor
js/session.js              session + mark model, JSON (de)serialization, validation
js/storage.js              localStorage persistence
js/results.js              chronological replay and the mark editor
js/main.js                 game state machine and screen flow
tests/logic.test.mjs       Node tests for filtering, calibration, mapping and JSON
```

## JSON structure

A painting is never flattened into pixels. It is a session object holding a list of independent marks, and the canvas is re-rendered from them whenever needed.

```json
{
  "schemaVersion": 1,
  "id": "s-…",
  "prompt": { "id": "fish", "label": "a fish" },
  "inputMode": "face",
  "status": "finished",
  "startedAt": "2026-09-22T20:31:04.120Z",
  "finishedAt": "2026-09-22T20:32:05.410Z",
  "elapsedMs": 60000,
  "canvas": { "width": 1200, "height": 800 },
  "calibration": {
    "neutral": { "headX": -0.02, "headY": 0.03, "tilt": 0.5, "mouthOpen": 0.05, "smile": 0.08, "browDown": 0.1, "browUp": 0.02, "blink": 0.12 },
    "headX": { "neg": -0.17, "pos": 0.13 },
    "mouthOpen": { "rest": 0.05, "max": 0.62 },
    "blink": { "rest": 0.12, "threshold": 0.48, "max": 0.83, "reliable": true },
    "…": "…"
  },
  "settings": { "roundMs": 60000, "stampMode": "blink", "blinkHoldMs": 280, "dwellMs": 1200, "paintStartMs": 120, "mirror": true },
  "discoveredControls": ["moveX", "paint", "rounded"],
  "marks": [
    {
      "id": "m-4a021efa-28da",
      "strokeId": "k-7e999b47-c476",
      "timestamp": 12450,
      "trigger": "paint",
      "source": "face",
      "facialInput": {
        "mouthOpen": 0.72, "smileLeft": 0.63, "smileRight": 0.67, "browDown": 0.31, "browUp": 0.05,
        "blinkLeft": 0.04, "blinkRight": 0.05, "headX": 0.42, "headY": 0.58, "headTilt": -12
      },
      "visualOutput": {
        "x": 410, "y": 260, "shape": "rounded", "color": "#E8321E",
        "size": 76, "rotation": -19, "opacity": 0.6, "seed": 1103038273
      }
    }
  ]
}
```

- `timestamp` is milliseconds since the round started, which drives the replay.
- `strokeId` groups the dabs from one mouth-open stroke, so Undo removes the whole stroke.
- `trigger` is `paint` (a mouth-open trail) or `stamp` (long blink, hold-still or Space).
- `facialInput` is the set of numbers that produced the mark. It is `null` for mouse-mode marks.
- `seed` makes each mark's texture identical every time it is re-rendered.
- **Explore your marks** lets you select any mark and move, recolor, resize, delete or replay it. The panel shows that mark's live JSON, including "what the machine measured". **Download JSON** exports the whole session.

## localStorage

| Key | Contents |
| --- | --- |
| `dysw:current` | the in-progress (or last) session, autosaved every 1.5 s and when the tab is hidden |
| `dysw:calibration` | your calibration, reused next time (you can recalibrate from the prompt screen) |
| `dysw:discovered` | which hidden controls you have ever found |
| `dysw:settings` | preferred stamp mode |
| `dysw:gallery` | up to 12 completed paintings, stored as marks, not images |

Refresh mid-round and the landing page offers **Continue** with the time you had left. **Reset saved data** (on the landing page, with a confirm click) removes every key above.

## Run locally

Browsers only allow camera access on `https://` or `localhost`, and ES modules need an HTTP server, so don't open `index.html` directly.

```bash
git clone https://github.com/<you>/do-you-see-what-i-mean.git
cd do-you-see-what-i-mean
python3 -m http.server 8000      # or: npm start
# open http://localhost:8000
```

Run the unit tests (Node 18+):

```bash
npm test
```

The first camera session downloads the MediaPipe runtime and model, about 4 MB.

## Privacy

- The camera is requested **only after** you press Start and read why it's needed.
- Video frames go from the `<video>` element straight into the model **inside your browser tab**. No frame is copied to storage, drawn into the saved painting, or sent over the network. The only network requests are GETs for the page, fonts, and the MediaPipe library and model.
- What *is* stored: the numeric measurements attached to each mark, and your calibration numbers.
- A "Camera on" indicator is visible while the stream is active. The stream is fully stopped (all tracks ended) when the round ends, when you choose **Turn off and exit**, and when the page is closed.
- **Mouse mode** never requests the camera. It's offered up front and again if permission is denied or the model can't load.

## Current limitations

- Head-pose values are geometric approximations from landmarks, not a full 3D pose solve. Extreme angles and strong side lighting reduce accuracy.
- Blendshape quality varies with lighting, glasses, facial hair, camera angle and face shape. Calibration helps but can't fix everything. That limitation is itself part of the point.
- Long-blink detection is disabled automatically for people whose blinks the model can't separate from looking down. The hold-still fallback then takes over.
- Painting requires an open mouth, which may be uncomfortable or impossible for some players. Mouse mode is the accessible alternative, but there is no alternative face mapping yet.
- The app needs a network connection the first time, to load MediaPipe and the model from CDNs.
- It has been tested in Chromium. Safari and Firefox should work, but the WebGL delegate may fall back to the slower CPU path.
- The gallery keeps 12 paintings to stay well inside localStorage quotas.

## Future improvements

- Remappable controls, so players can choose which movements do what, including options that don't need an open mouth.
- A multiplayer "guess what I drew" round where another person, and separately a vision model, try to name the drawing. That would put human and machine readings side by side.
- Vendoring the MediaPipe runtime and model for fully offline play.
- Continuous brush parameters, such as blending shapes by smile intensity instead of discrete thresholds.
- Exporting a replay as video or an animated SVG.
- Selecting a whole stroke in the editor, not just single marks.
