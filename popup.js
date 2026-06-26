'use strict';

// Codigrate Color Picker popup. Uses the native EyeDropper API to sample any
// pixel on screen, shows it as HEX / RGB / HSL (click a row to copy), keeps a
// short history in chrome.storage.local, and links the picked colour straight
// into the Codigrate color tool.

const HISTORY_KEY = 'history';
const LAST_KEY = 'last';
const MAX = 12;

// Published "All In One Themes" extension id. When set and that extension is
// installed, the picker asks it for the active Codigrate browser theme and tints
// itself to match. Leave empty to disable the integration.
const ALL_IN_ONE_ID = 'iekicoldppmopekekolhdoofncnhhbeh';

// chrome.storage.local in the extension; an in-memory fallback when the popup is
// opened outside an extension context (e.g. a plain browser preview).
const localStore = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
  ? chrome.storage.local : null;
const memStore = {};

function storageGet(keys, cb) {
  if (localStore) { localStore.get(keys, cb); return; }
  const out = {};
  (keys || []).forEach((k) => { if (k in memStore) { out[k] = memStore[k]; } });
  cb(out);
}

function storageSet(obj) {
  if (localStore) { localStore.set(obj); return; }
  Object.assign(memStore, obj);
}

const pickBtn = document.getElementById('pick');
const unsupported = document.getElementById('unsupported');
const result = document.getElementById('result');
const swatch = document.getElementById('swatch');
const hexEl = document.getElementById('hex');
const rgbEl = document.getElementById('rgb');
const hslEl = document.getElementById('hsl');
const openLink = document.getElementById('openCodigrate');
const historyRow = document.getElementById('historyRow');
const themeMatch = document.getElementById('themeMatch');
const tmDot = document.getElementById('tmDot');
const tmName = document.getElementById('tmName');
const tmRow = document.getElementById('tmRow');

// ---- colour maths -----------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) { h = (g - b) / d + (g < b ? 6 : 0); }
    else if (mx === g) { h = (b - r) / d + 2; }
    else { h = (r - g) / d + 4; }
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

const fmtRgb = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
const fmtHsl = ([h, s, l]) => `hsl(${h}, ${s}%, ${l}%)`;

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// ---- All In One Themes integration (read-only) ------------------------------

// Curated, colour-forward slots from the theme's preview palette.
const THEME_SLOTS = ['accent', 'frame', 'toolbar', 'omnibox', 'activeTab', 'border'];

function applyThemeMatch(resp) {
  const p = resp.palette || {};
  if (p.accent) {
    document.documentElement.style.setProperty('--accent', p.accent);
    document.documentElement.style.setProperty('--accent-ink', luminance(p.accent) > 0.62 ? '#0F172A' : '#FFFFFF');
    tmDot.style.background = p.accent;
  }
  tmName.textContent = resp.name || 'Codigrate theme';
  tmRow.textContent = '';
  THEME_SLOTS.forEach((slot) => {
    const hex = p[slot];
    if (!hex) { return; }
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tm-chip';
    chip.style.background = hex;
    chip.title = slot + ' ' + hex.toUpperCase();
    chip.addEventListener('click', () => show(hex));
    tmRow.appendChild(chip);
  });
  themeMatch.classList.remove('hidden');
}

function loadThemeMatch() {
  if (!ALL_IN_ONE_ID || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }
  try {
    chrome.runtime.sendMessage(ALL_IN_ONE_ID, { type: 'getActiveTheme' }, (resp) => {
      // Swallow "could not establish connection" when the extension is absent.
      if (chrome.runtime.lastError) { return; }
      if (resp && resp.ok) { applyThemeMatch(resp); }
    });
  } catch (e) {
    // Messaging unavailable; the picker works fine on its own.
  }
}

// ---- render -----------------------------------------------------------------

function show(hex) {
  hex = hex.toUpperCase();
  const rgb = hexToRgb(hex);
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  swatch.style.background = hex;
  hexEl.textContent = hex;
  rgbEl.textContent = fmtRgb(rgb);
  hslEl.textContent = fmtHsl(hsl);
  openLink.href = 'https://codigrate.com/tools/color/' + hex.slice(1);
  result.classList.remove('hidden');
}

function renderHistory(list) {
  historyRow.textContent = '';
  if (!list || !list.length) {
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = 'No colors picked yet';
    historyRow.appendChild(span);
    return;
  }
  list.forEach((hex) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.style.background = hex;
    chip.title = hex;
    chip.addEventListener('click', () => show(hex));
    historyRow.appendChild(chip);
  });
}

// ---- storage ----------------------------------------------------------------

function addHistory(hex) {
  hex = hex.toUpperCase();
  storageGet([HISTORY_KEY], (data) => {
    let list = data[HISTORY_KEY] || [];
    list = list.filter((x) => x !== hex);
    list.unshift(hex);
    list = list.slice(0, MAX);
    storageSet({ [HISTORY_KEY]: list, [LAST_KEY]: hex });
    renderHistory(list);
  });
}

// ---- actions ----------------------------------------------------------------

async function pick() {
  if (typeof window.EyeDropper !== 'function') {
    unsupported.classList.remove('hidden');
    return;
  }
  try {
    const eyeDropper = new EyeDropper();
    const { sRGBHex } = await eyeDropper.open();
    show(sRGBHex);
    addHistory(sRGBHex);
  } catch (e) {
    // The user pressed Escape or dismissed the eyedropper; nothing to do.
  }
}

function copy(text, el) {
  navigator.clipboard.writeText(text).then(() => {
    const hint = el.querySelector('.copy-hint');
    if (hint) {
      const prev = hint.textContent;
      hint.textContent = 'Copied';
      el.classList.add('copied');
      setTimeout(() => { hint.textContent = prev; el.classList.remove('copied'); }, 900);
    }
  });
}

// ---- wire up ----------------------------------------------------------------

pickBtn.addEventListener('click', pick);

document.querySelectorAll('.val').forEach((row) => {
  row.addEventListener('click', () => {
    const value = row.querySelector('.v').textContent;
    if (value) { copy(value, row); }
  });
});

storageGet([HISTORY_KEY, LAST_KEY], (data) => {
  renderHistory(data[HISTORY_KEY] || []);
  if (data[LAST_KEY]) { show(data[LAST_KEY]); }
});

loadThemeMatch();
