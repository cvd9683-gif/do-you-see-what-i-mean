// Shared constants. Kept free of DOM access so the pure modules can be tested in Node.

// Logical painting space. Every mark's x/y/size lives in these units,
// independent of how large the canvas is drawn on screen.
export const CANVAS_W = 1200;
export const CANVAS_H = 800;

export const ROUND_MS = 60_000;

// A bold, limited pigment set. Order matters: raising your brows cycles through it.
export const PALETTE = ['#E8321E', '#2340D8', '#FFB400', '#141414', '#138A5B', '#FF8FB8'];

export const SHAPES = ['line', 'rounded', 'angular'];

// The hidden rules. Only revealed (one by one) after a player triggers them.
export const CONTROLS = [
  { id: 'moveX', label: 'Turn your head left or right to move sideways.' },
  { id: 'moveY', label: 'Tip your head up or down to move vertically.' },
  { id: 'paint', label: 'Open your mouth to paint. Wider makes bigger marks.' },
  { id: 'rounded', label: 'Smile to make rounded marks.' },
  { id: 'angular', label: 'Lower or furrow your brows for sharp, angular marks.' },
  { id: 'rotate', label: 'Tilt your head to rotate a mark.' },
  { id: 'stamp', label: 'Hold a long blink to stamp a bold mark.' },
  { id: 'color', label: 'Raise your eyebrows to switch color.' },
];

export const DEFAULT_SETTINGS = {
  roundMs: ROUND_MS,
  // 'blink' = long blink stamps; 'dwell' = holding still stamps. Space bar always stamps.
  stampMode: 'blink',
  blinkHoldMs: 280,
  dwellMs: 1200,
  paintStartMs: 120,
  mirror: true,
};
