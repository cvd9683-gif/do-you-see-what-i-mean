// Shared constants. Kept free of DOM access so the pure modules can be tested in Node.

// Logical painting space. Every mark's x/y/size lives in these units,
// independent of how large the canvas is drawn on screen.
export const CANVAS_W = 1200;
export const CANVAS_H = 800;

export const ROUND_MS = 90_000;

// Players see only concrete, beginner prompts until they have finished this many rounds.
export const BEGINNER_ROUNDS = 3;

// Five high-contrast pigments. Order matters: a deliberate blink cycles through them.
export const PALETTE = ['#E8321E', '#2340D8', '#FFB400', '#138A5B', '#141414'];
export const COLOR_NAMES = { '#E8321E': 'Red', '#2340D8': 'Blue', '#FFB400': 'Yellow', '#138A5B': 'Green', '#141414': 'Black', '#FF8FB8': 'Pink' };

export const SHAPES = ['line', 'rounded', 'angular'];

// The rules. Named on the results screen once a player has triggered them.
export const CONTROLS = [
  { id: 'moveX', label: 'Turn your head to move the cursor sideways.' },
  { id: 'moveY', label: 'Tip your head up or down to move it vertically.' },
  { id: 'paint', label: 'Open your mouth to paint. Close it to move without painting.' },
  { id: 'rounded', label: 'Smile while painting for rounded marks.' },
  { id: 'angular', label: 'Move your eyebrows (raise or frown) for sharp, angular marks.' },
  { id: 'rotate', label: 'Tilt your head to rotate the mark.' },
  { id: 'color', label: 'Blink deliberately (or raise your eyebrows, if blinks weren’t readable) to switch color.' },
];

// Written into every session so a saved painting records which rules produced it.
// `colorChange` and `browMovement` depend on whether calibration found blinks reliable.
export function mappingsFor(colorInput) {
  return {
    headX: 'cursor x (calibrated range → full canvas width)',
    headY: 'cursor y (calibrated range → full canvas height)',
    mouthOpen: 'paint while open (after a short hold); openness sets brush size',
    smile: 'rounded marks',
    browMovement: colorInput === 'browRaise' ? 'furrow → angular marks' : 'angular marks (raise or furrow)',
    headTilt: 'mark rotation',
    colorChange:
      colorInput === 'blink'
        ? 'deliberate blink (both eyes, held) → next color; palette click as fallback'
        : 'eyebrow raise (held) → next color, because blinks were not reliable; palette click as fallback',
  };
}

export const DEFAULT_SETTINGS = {
  paintStartMs: 150, // mouth must stay open this long before paint flows
  blinkHoldMs: 200, // a natural blink is ~100–150 ms; a deliberate one is longer
  blinkRearmMs: 400, // eyes must be open this long before another blink counts
  colorCooldownMs: 900, // one blink can never trigger several changes
  browRaiseHoldMs: 250, // fallback gesture when blinks aren't reliable
  deadZone: 0.05, // fraction of each head half-range treated as "centre"
  reach: 0.8, // 80% of the calibrated comfortable turn reaches the canvas edge
  mirror: true,
};
