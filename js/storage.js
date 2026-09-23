// localStorage persistence. Only JSON numbers and marks are stored — never camera frames.
// Every access is wrapped: private windows or full storage must not break the game.

import { parseSession, serializeSession } from './session.js';

const KEYS = {
  current: 'dysw:current', // the in-progress or most recent session
  calibration: 'dysw:calibration',
  discovered: 'dysw:discovered',
  gallery: 'dysw:gallery', // completed paintings (as mark lists, not images)
  settings: 'dysw:settings',
};
const GALLERY_MAX = 12;

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('Could not save to localStorage', err);
    return false;
  }
}

export const storage = {
  loadCurrent: () => parseSession(read(KEYS.current)),
  saveCurrent: (s) => write(KEYS.current, serializeSession(s)),
  clearCurrent: () => {
    try {
      localStorage.removeItem(KEYS.current);
    } catch {}
  },

  loadCalibration: () => read(KEYS.calibration),
  saveCalibration: (c) => write(KEYS.calibration, c),

  loadDiscovered: () => {
    const d = read(KEYS.discovered);
    return Array.isArray(d) ? d : [];
  },
  saveDiscovered: (list) => write(KEYS.discovered, [...new Set(list)]),

  loadSettings: () => read(KEYS.settings) || {},
  saveSettings: (s) => write(KEYS.settings, s),

  loadGallery: () => {
    const g = read(KEYS.gallery);
    return Array.isArray(g) ? g.map(parseSession).filter(Boolean) : [];
  },
  // Insert or replace by id, newest first. Oldest paintings drop off past the limit.
  saveToGallery: (s) => {
    const g = storage.loadGallery().filter((x) => x.id !== s.id);
    g.unshift(s);
    return write(KEYS.gallery, g.slice(0, GALLERY_MAX));
  },

  resetAll: () => {
    for (const k of Object.values(KEYS)) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }
  },
};
