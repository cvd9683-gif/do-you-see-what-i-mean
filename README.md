# Do You See What I Mean?

**Pictionary, except you paint with your face.**

You get a simple prompt (“Draw a fish”) and 90 seconds. There is no brush and no mouse. Your webcam watches your head and face, and those movements steer a painting tool. Afterwards you can watch your face and your painting replay side by side, in sync.

## Concept

The game is about the gap between *machine recognition* and *human understanding*.

A face-tracking model can measure a lot about your face: how far your jaw has dropped, how much the corners of your mouth have lifted, the angle of your head. It cannot know what you meant. To draw well, the player has to perform *for* the machine. They learn which exaggerated expressions it can read and bend their intentions into signals it can sense. The synchronized replay makes this visible: you watch yourself pulling faces to be understood, next to the marks those faces produced.

The game keeps this quiet while you play. It comes back in a short reflection at the end:

> You learned how to make yourself legible to the machine. But did it ever understand what you were trying to draw?

### AI as power steering, not the artist

No generative model is involved. **The player makes every mark.** The ML model only produces measurements. Hand-written rules turn those measurements into cursor position, paint on/off, size, shape, rotation and color. Every mark is stored with the measurements that produced it, and you can inspect them one by one afterwards.

## What changed after the first usability test

First-time players were fighting the controls instead of drawing. This version:

- **Calibrates before every round**, with a guided, gated sequence of seven steps.
- **Adds an untimed practice canvas** with three small objectives.
- **Separates moving from painting**: the head moves a clearly visible cursor, and paint only flows while the mouth is open.
- **Maps each player's comfortable head range to the whole canvas.**
- **Uses concrete beginner prompts** (sun, flower, balloon, fish, face, house) and a **90-second** round. Open-ended prompts like "storm" appear after three finished rounds.
- **Optionally records the player's face** locally, for a **synchronized face-and-painting replay**.

## New Game, Restart Game and Replay Performance

These three actions are deliberately different:

| Action | Where | What happens | Calibrates? |
| --- | --- | --- | --- |
| **Replay Performance** | results screen | Plays the recorded face video and the painting again from the start, in sync. Play/pause, scrubbing and the view modes behave the same way. Nothing is reset. | **Never** |
| **New Game** | results screen | Starts a new drawing experience. Asks first if a face recording would be discarded. If you played with the camera, it turns back on and goes **straight into calibration**, then practice, the record choice, and a new prompt. | **Always** (face mode) |
| **Restart Game** | during a round | Asks for confirmation, then discards the current painting and any recording in progress. It goes **straight into calibration**, then the record choice and a new prompt. The warm-up is skipped because you've just played. | **Always** (face mode) |

Opening a finished painting from the gallery, pausing, scrubbing, switching Face only / Painting only, or going to **Explore your marks** and back never recalibrates. The round's calibration is kept with the session for its replay. Mouse mode has no calibration, so New Game and Restart Game there go straight to a new prompt.

## Game flow

1. **Landing** → **Camera explanation** → the browser's permission prompt.
2. **Calibration**, every round, 7 steps (see below).
3. **Practice**: steer into two target circles, open your mouth to paint, and change the mark with an expression. You can stay and experiment, or choose **I'm ready**. Practice marks are thrown away before the round starts.
4. **Record a face replay?** → **Record my face replay** or **Continue without recording**.
5. **Prompt** countdown, then the **90-second round**.
6. **Results**: the synchronized replay (**Replay performance**), Save image, **Explore your marks** (per-mark editor), **New Game**, and the reflection.

Mouse mode (offered up front, and whenever the camera is denied or the model fails to load) skips calibration, practice and recording.

## Facial controls

| Movement | Signal (MediaPipe) | Effect |
| --- | --- | --- |
| Turn head left / right | nose offset from face center line | cursor x, across the full canvas width |
| Tip head up / down | nose offset from mid-face height | cursor y, across the full canvas height |
| Open mouth | `jawOpen` | paints while open, after a 150 ms hold; wider makes a bigger brush |
| Closed mouth | `jawOpen` | move freely without painting |
| Smile | `mouthSmileLeft/Right` | rounded, watercolor blob marks |
| Brow movement (raise *or* furrow) | `browInnerUp`, `browDownLeft/Right` | sharp, angular shard marks |
| Tilt head | angle between the outer eye corners | rotates the mark |
| Deliberate blink | `eyeBlinkLeft/Right` (both eyes) | next color in the palette, **if calibration found blinks reliable** |
| Held eyebrow raise | `browInnerUp` | next color, **only when blinks weren't reliable**. In this mode a furrow alone makes angular marks, so the two gestures don't clash. |

With neither a smile nor brow movement, the brush makes dry-brush strokes.

### Color selection

- A **palette of five high-contrast colors** (red, blue, yellow, green, black) sits next to the canvas for the whole round. The current color has a thick ring and its name is shown ("Color: Blue").
- **Face control:** a deliberate blink cycles to the next color, and a label with a color chip pops up over the canvas. The line under the palette says which gesture to use.
- **Blink rules:**
  - both eyes must close together (`min(left, right)`), so a wink or a glance doesn't count
  - the closure must pass a strong personal threshold, set by calibration at 65% of the way from open to closed
  - it must be held for 200 ms (natural blinks last about 100–150 ms)
  - the eyes must reopen for 400 ms before another blink counts
  - there is a 900 ms cooldown
  - keeping your eyes shut never repeats a change
- **Fallback:** if calibration couldn't separate deliberate blinks from open eyes or looking down, a **held eyebrow raise** (250 ms, same cooldown) changes color instead.
- **Click** any palette color (or press **C**) at any time. This only changes the color; face tracking and the timer keep running.
- Every change is stored in the session JSON as a timestamped `colorChange` event, and the replay reproduces it at the same moment.

The practice stage teaches only movement and painting. Which expression makes which shape, head tilt, and blink-for-color are left to discover. Seven wordless glyphs fill in as you find them, and the results screen names the ones you used.

### Making the controls feel steady but responsive

- **Full-canvas mapping.** Each side of your neutral head position is scaled separately to your *calibrated comfortable* extreme. Reaching 80% of it puts the cursor at the edge, so small, easy movements cover the canvas.
- **Neutral dead zone.** The innermost 5% of each half-range maps to the center, so a relaxed head doesn't wander.
- **Smoothing.** A [1€ filter](https://gery.casiez.net/1euro/) smooths heavily when still and lightly when moving fast, with a 3 px dead-band on top. Expression scores use an exponential moving average.
- **Paint activation.** The mouth has to pass 35% of your personal open range and stay there for 150 ms before paint flows. It stops below 20%. The gap between those two thresholds (hysteresis) stops paint flickering on and off, and talking-sized openings don't paint.
- **Cursor feedback.** A high-contrast ring shows where you are. A dashed ghost shows the mark you'd make. A colored ring fills while the mouth "charges" before paint starts, and a black ring fills while a deliberate blink is held.
- **Blink protection.** See *Color selection* above: both eyes together, a strong personal threshold, a 200 ms hold, a 400 ms re-arm and a 900 ms cooldown.

## Calibration

### Why it runs before every round

Faces, lighting, camera position and posture change between rounds and between players. The same absolute blendshape value can mean "resting" for one person and "wide open" for another. Recalibrating each round keeps every threshold relative to *this player, right now*.

### MediaPipe is not retrained

The Face Landmarker model is fixed. Calibration never changes its weights. It only **measures** your signals at rest and at a comfortable extreme, and the game's own thresholds are then expressed relative to those numbers.

### The screen

The instruction is the most important thing on screen, so it's the largest. From top to bottom:

- a small label, **"CALIBRATION · 2 OF 7"**
- a seven-part **progress bar** with step names; finished steps turn green with a ✓, and the current step is red
- **one large instruction**, e.g. **"Slowly turn your head left and right."** (about 80 px on a laptop)
- one short **secondary line**, e.g. *"Move comfortably. You do not need to turn very far."*
- a bordered **feedback box** with a large status line and an animated demonstration face. The status reads **HOLD LEFT…** (red), then **LEFT DETECTED**, then **RIGHT DETECTED**, then **COMPLETE** (green, and the box turns green). It also shows target chips with fill-up rings and a live meter with the threshold marked.

The camera preview and the "What the tracker detects" panel sit in a narrower side column. They stay visible but never compete with the instruction.

### The steps

Each step requires its action to be **detected and held**: 1 s for expressions, 0.8 s at each side of a head movement, 0.4 s for "relax", and 0.3 s per deliberate blink. Hold time drains away twice as fast as it builds when the signal drops, so brief accidental glances or flickers never complete a step. It also only builds up while a face is visible. When a step finishes, the screen shows "*<LAST>* DETECTED" (0.6 s), then **COMPLETE** (1.2 s), and only then moves on. Steps **never auto-advance**.

1. Face forward with a neutral expression (hold still)
2. Turn left, then right (the second side must be opposite the first)
3. Look up, then down
4. Open, then close the mouth
5. Smile, then relax
6. Move the eyebrows (raise **or** furrow), then relax
7. Blink deliberately, twice (the eyes must reopen in between)

Next to the video, a panel shows what the tracker is detecting right now: **Head position, Mouth open, Smile movement, Brow movement, Eyes closed**. These are movements, not emotions.

If a step isn't detected within 10 seconds, **NOT DETECTED YET** shows, and **Retry this step** and **Continue without this signal** appear. Continuing uses a standard fallback range for that signal, records it in `calibration.fallbacks`, and never traps the player.

### How the values are calculated

- **Neutral**: the mean of every signal while holding still in step 1.
- **Head X / Y ranges**: the median head position while *holding* at each side (left, right, up, down). This is a comfortable held position, not a one-frame extreme.
- **Mouth, smile, brows**: `rest` = the neutral value; `max` = the median value while the action was held. The game normalizes each signal to 0 at rest and 1 at your comfortable max. Painting starts at 0.35 of the mouth range; rounded or angular shapes switch in at 0.5.
- **Brows**: the step accepts either direction, so the game records which one you used (`raise`, `furrow` or `both`) and uses a default range for the other.
- **Blink**: `closed` = the median eye closure during deliberate blinks. Eyelids also drop when you look down, so the floor is the higher of the neutral value and the 90th percentile while looking down (step 3). If `closed − floor > 0.2`, blinks are *reliable* and the color-change threshold is a strong `floor + 0.65 × (closed − floor)`. Otherwise blink-for-color is off and a held eyebrow raise changes color instead. The palette is always clickable.

## Local recording (`MediaRecorder`)

- Recording is **opt-in each round**. The screen before the prompt says: *“Your camera video can be recorded for the replay, but it stays in this browser session and is never uploaded.”* and offers **Record my face replay** or **Continue without recording**.
- During the round, a red **Recording** badge sits on the preview and the camera pill reads "Camera on · Recording".
- `MediaRecorder` records the existing camera `MediaStream` as video only (WebM VP9/VP8, or MP4 where that's the only option), in 1-second chunks, **held in memory**.
- When the round ends (timer or **Finish**), the chunks become one `Blob` and a `blob:` URL (`URL.createObjectURL`) for the result screen's `<video>`.
- The URL is revoked (`URL.revokeObjectURL`) when you **Delete recording**, start a **new game** (you're asked first), **leave** the experience, or the page is hidden or unloaded.
- The live webcam frames still go to MediaPipe for tracking. Individual frames are never stored.

### Why the video is not in `localStorage`

It's large (megabytes per minute), `localStorage` holds only a few megabytes of *strings*, and storing it would make a video of your face persist on disk. Only lightweight JSON (marks, calibration numbers, settings) persists across refreshes. **After a reload the painting is restored from JSON, but the face replay is gone**, and the result screen says so.

## Synchronized replay

### One shared clock

When a round starts, the game starts the recorder and waits for its `start` event. At that instant it reads `performance.now()` as the round's start. The same monotonic clock (unaffected by wall-clock changes) drives:

- **the timer**: elapsed = now − start (plus any time from before a refresh)
- **every mark**: `timestamp` = milliseconds since the round's start
- **the video**: `recording.videoLeadMs` = round start − recorder start. In tests this is 0–5 ms.

### Playback

On the results screen, round time `t` and video time are tied by `videoTime = (t + videoLeadMs) / 1000`.

- **While the video plays, it is the master clock.** Each frame the canvas reads `video.currentTime` and shows every mark with `timestamp ≤ t`. The newest marks "bloom" in over 220 ms. Marks that have finished blooming are cached in an offscreen layer, so each frame only draws what's new.
- **Pause** freezes both at the same instant. **Scrubbing** the timeline sets the video time and redraws the canvas up to that point (it rebuilds from scratch when moving backwards). **Replay performance** clears the canvas and plays both from 0. It never recalibrates or starts a new round.
- **Without a recording** (declined, mouse mode, after a reload, or deleted), an internal clock drives a painting-only replay, and the Face only and Side by side modes are disabled.
- MediaRecorder WebM files often have no duration in their header, which breaks seeking. The player works around this with a known fix: it seeks far past the end once to make the browser compute the duration.
- **Compare modes**: Side by side, Face only, Painting only. The recorded video is shown mirrored, as the player saw it.
- **Colors in the replay**: a small palette strip next to the timeline highlights the color that was active at the current replay time, worked out from `initialColor` and the `colorChange` events. When playback passes a color change, the same color label pops up over the replay canvas. Marks keep the color they were painted with.

## JSON structure

A painting is never flattened into pixels. It's a session object with independent marks.

```json
{
  "schemaVersion": 2,
  "id": "s-…",
  "prompt": { "id": "fish", "label": "a fish", "level": "beginner" },
  "inputMode": "face",
  "status": "finished",
  "startedAt": "2026-09-22T20:31:04.120Z",
  "finishedAt": "2026-09-22T20:32:34.400Z",
  "roundDurationMs": 90000,
  "elapsedMs": 90000,
  "timing": {
    "clock": "performance.now",
    "sharedStartEpochMs": 1790000000000,
    "sharedStartPerfMs": 51234.5,
    "drawingDurationMs": 90000
  },
  "recording": {
    "enabled": true,
    "mimeType": "video/webm;codecs=vp9",
    "durationMs": 90009,
    "videoLeadMs": 0,
    "storedIn": "memory only (never saved)"
  },
  "calibration": {
    "neutral": { "headX": -0.02, "headY": 0.03, "tilt": 0.5, "mouthOpen": 0.03, "smile": 0.06, "browDown": 0.1, "browUp": 0.05, "blink": 0.12 },
    "headX": { "neg": -0.1, "pos": 0.1 },
    "headY": { "neg": -0.06, "pos": 0.06 },
    "mouthOpen": { "rest": 0.03, "max": 0.55 },
    "smile": { "rest": 0.06, "max": 0.7 },
    "brow": { "up": { "rest": 0.05, "max": 0.6 }, "down": { "rest": 0.1, "max": 0.4 }, "direction": "raise" },
    "blink": { "rest": 0.12, "threshold": 0.66, "closed": 0.9, "reliable": true },
    "fallbacks": [],
    "calibratedAt": "2026-09-22T20:30:51.000Z"
  },
  "mappings": {
    "headX": "cursor x (calibrated range → full canvas width)",
    "headY": "cursor y (calibrated range → full canvas height)",
    "mouthOpen": "paint while open (after a short hold); openness sets brush size",
    "smile": "rounded marks",
    "browMovement": "angular marks (raise or furrow)",
    "headTilt": "mark rotation",
    "colorChange": "deliberate blink (both eyes, held) → next color; palette click as fallback"
  },
  "initialColor": "#E8321E",
  "events": [
    { "type": "colorChange", "timestamp": 8420, "previousColor": "#E8321E", "newColor": "#2340D8", "input": "blink" },
    { "type": "colorChange", "timestamp": 21310, "previousColor": "#2340D8", "newColor": "#138A5B", "input": "click" }
  ],
  "settings": { "paintStartMs": 150, "blinkHoldMs": 200, "blinkRearmMs": 400, "colorCooldownMs": 900, "browRaiseHoldMs": 250, "deadZone": 0.05, "reach": 0.8, "mirror": true },
  "discoveredControls": ["moveX", "moveY", "paint", "rounded"],
  "marks": [
    {
      "id": "mark-da65dcdc-3c69",
      "strokeId": "k-7e106b73-894b",
      "timestamp": 4280,
      "trigger": "paint",
      "source": "face",
      "facialInput": { "mouthOpen": 0.74, "smile": 0.61, "browMovement": 0.18, "blink": 0.1, "headX": 0.44, "headY": 0.52, "headTilt": -8 },
      "visualOutput": { "x": 420, "y": 270, "shape": "rounded", "color": "#E8321E", "size": 64, "rotation": -8, "opacity": 0.68, "seed": 857103346 }
    }
  ]
}
```

- `timestamp` is milliseconds since the shared round start. It drives both the replay and video sync.
- `strokeId` groups the dabs of one mouth-open stroke, so Undo removes the whole stroke.
- `events` records every color change: its round-relative `timestamp`, `previousColor`, `newColor`, and `input` (`blink`, `browRaise`, `click` or `key`). Together with `initialColor`, this tells you exactly which color was active at any moment.
- `facialInput` holds the raw measurements that produced the mark: blendshape scores, head position as 0–1 of the canvas, and tilt in degrees relative to neutral. It is `null` in mouse mode.
- `seed` makes each mark's texture identical every time it's re-rendered.
- **The video is never serialized.** When a session is loaded, any unexpected fields under `recording` (a URL, data) are stripped.
- Version 1 sessions (60-second rounds) are migrated when loaded.

### localStorage

| Key | Contents |
| --- | --- |
| `dysw:current` | the in-progress (or last) session, autosaved every 1.5 s and when the tab is hidden |
| `dysw:calibration` | the most recent calibration numbers (for reference; every round recalibrates) |
| `dysw:discovered` | which controls you have ever found |
| `dysw:gallery` | up to 12 finished paintings, stored as marks, not images |

Refresh mid-round and the landing page offers **Continue** with your time left. A resumed round recalibrates first but isn't recorded, because the earlier part of the video no longer exists. **Reset saved data** removes every key above.

## Technology and APIs

- Plain HTML, CSS and JavaScript ES modules. No framework and no build step.
- Canvas 2D for all rendering: procedural textured marks, `multiply` compositing, and generated paper grain.
- `getUserMedia` (camera), `MediaRecorder` (local recording), `URL.createObjectURL` / `revokeObjectURL`, `performance.now()` (shared clock), and `<dialog>`.
- `@mediapipe/tasks-vision` 1.0.1 Face Landmarker with the float16 `face_landmarker.task` model, loaded from jsDelivr and Google's model storage.

```
js/config.js        constants, palette, controls, mappings, settings
js/faceTracker.js   webcam + MediaPipe, feature extraction, face outline
js/calibration.js   gated 7-step calibration and personal thresholds
js/mapping.js       gesture → brush: 1€ filter, dead zone, paint gate, blink protection, dab trail
js/practice.js      untimed practice canvas and objectives
js/recorder.js      MediaRecorder wrapper (memory only)
js/renderer.js      paper, procedural marks, cursor, hit-testing
js/results.js       synchronized replay + mark editor
js/session.js       session/mark JSON model, validation, migration
js/storage.js       localStorage persistence
js/mouseInput.js    mouse/pen demo mode
js/main.js          game state machine and screens
tests/              Node unit tests
```

## Run locally

Camera access requires `https://` or `localhost`, and ES modules need an HTTP server, so don't open `index.html` directly.

```bash
git clone https://github.com/cvd9683-gif/do-you-see-what-i-mean.git
cd do-you-see-what-i-mean
python3 -m http.server 8000      # or: npm start
# open http://localhost:8000
npm test                         # unit tests (Node 18+)
```

## Privacy

- The camera is requested only after you press Start and read why it's needed. A "Camera on" indicator shows while it's active.
- Frames go from the `<video>` element into the model in your tab, then are discarded. None are stored or sent.
- Recording is optional and held only in browser memory. It's revoked on delete, new game, leaving or reload. It's never uploaded, sent to an API, put in `localStorage`, or included in the JSON.
- The only network requests are GETs for the page, fonts, and the MediaPipe library and model.
- The camera tracks (and so the recorder) are stopped when a round ends, when you choose **Turn off and exit**, and when the page closes.

### Privacy limitations

- While a recording exists, anyone with access to this browser tab can watch it. **Save image** and **Download JSON** create files you control, but the video itself can't be downloaded from the game.
- Browser extensions and devtools can see the page's memory, like any web content.
- MediaPipe's runtime and model come from third-party CDNs (jsDelivr, Google). Those hosts see an ordinary request for the files, but never your video or measurements.
- The numeric `facialInput` saved with each mark is a coarse record of your expressions over time. It's kept in `localStorage` until you reset.

## Browser compatibility

- **Chrome** (desktop): tested, including recording (WebM VP9), the synchronized replay and seeking. Edge uses the same engine.
- **Firefox**: supports MediaPipe, the camera and WebM recording, but this project hasn't been tested there yet.
- **Safari (macOS/iOS)**: `MediaRecorder` records MP4 in recent versions. Where it's missing, the record option is disabled and the replay shows the painting only. MediaPipe may fall back to its slower CPU path. Not yet tested.
- `<dialog>` and CSS `:has()` need a 2022-or-newer browser.
- Seeking in MediaRecorder WebM relies on the duration fix above. Some browsers may seek coarsely, to the nearest keyframe.

## Current limitations

- Head position is estimated from face landmarks, not a full 3D pose, so extreme angles and strong side light reduce accuracy.
- Expression detection varies with lighting, glasses, facial hair and face shape. Calibration helps but can't fix everything, which is itself part of the point.
- Painting requires opening the mouth, and there's no alternative face mapping yet (mouse mode is the accessible alternative).
- Automated tests cover the real model on a still face (it completes "face forward" and correctly *can't* pass "turn left"). A scripted player that sends numeric face signals, not images, drives calibration, practice and rounds. Tuning with many real players is still needed.
- The first run needs a network connection to fetch MediaPipe and the model.

## Future improvements

- Remappable controls, including options that don't need an open mouth.
- A multiplayer "guess what I drew" round comparing human and machine readings (deliberately not built yet).
- Vendoring MediaPipe for offline play.
- An optional, explicit "save video to my device" export.
- Selecting a whole stroke in the editor.
