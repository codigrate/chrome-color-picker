'use strict';

// Codigrate Color Picker popup. Uses the native EyeDropper API to sample any
// pixel on screen, then reads the colour the way the Codigrate Color Picker for
// JetBrains does: copy-ready CSS, WCAG / APCA contrast, channel bars, every
// common colour space, harmonies, tints / shades / tones, temperature, colour
// vision deficiency simulations and a persisted history of recent picks.
// All maths is ported 1:1 from the JetBrains plugin (which mirrors the website).

const HISTORY_KEY = 'history';
const LAST_KEY = 'last';
const COLLAPSED_KEY = 'collapsed';
const MAX = 12;
const RAMP_STEPS = 10;

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

const $ = (id) => document.getElementById(id);
const pickBtn = $('pick');
const unsupported = $('unsupported');
const result = $('result');
const swatch = $('swatch');
const swatchHex = $('swatchHex');
const openLink = $('openCodigrate');
const historyRow = $('historyRow');

// ---- colour maths (ColorFormats.java) ----------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return ('#' + c(r) + c(g) + c(b)).toUpperCase();
}

function hslOf(hex) {
  let [r, g, b] = hexToRgb(hex);
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

function hsvOf(hex) {
  let [r, g, b] = hexToRgb(hex);
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) { h = ((g - b) / d + (g < b ? 6 : 0)) * 60; }
    else if (mx === g) { h = ((b - r) / d + 2) * 60; }
    else { h = ((r - g) / d + 4) * 60; }
  }
  const s = mx === 0 ? 0 : d / mx;
  return [Math.round(h), Math.round(s * 100), Math.round(mx * 100)];
}

function cmykOf(hex) {
  let [r, g, b] = hexToRgb(hex);
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  let c = 0, m = 0, y = 0;
  if (k < 1) {
    c = (1 - r - k) / (1 - k);
    m = (1 - g - k) / (1 - k);
    y = (1 - b - k) / (1 - k);
  }
  return [Math.round(c * 100), Math.round(m * 100), Math.round(y * 100), Math.round(k * 100)];
}

function fromHsl(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

const rotateHue = (hex, deg) => { const h = hslOf(hex); return fromHsl(h[0] + deg, h[1], h[2]); };

function mix(from, to, f) {
  const a = hexToRgb(from), b = hexToRgb(to);
  return rgbToHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

// The site's tint/shade/tone ramp: n steps toward the end colour, starting at
// the colour itself and stopping just short of the end.
const ramp = (from, to, n) => Array.from({ length: n }, (_, i) => mix(from, to, i / n));

const analogousTrio = (hex) => [rotateHue(hex, -22), hex, rotateHue(hex, 22)];

function monochromeTrio(hex) {
  const h = hslOf(hex);
  const down = Math.min(8, h[2] / 2.5);
  const up = Math.min(8, (100 - h[2]) / 2);
  return [fromHsl(h[0], h[1], Math.max(h[2] - 2 * down, 0)), hex, fromHsl(h[0], h[1], Math.min(h[2] + 2 * up, 100))];
}

// Warm hue bands per the site: [0, 90) and [270, 360].
const isWarm = (hex) => { const h = hslOf(hex)[0]; return h < 90 || h >= 270; };

function warmer(hex, n) {
  const h = hslOf(hex);
  let diff = h[0], clockwise = -1;
  if (diff > 180) { diff = 360 - diff; clockwise = 1; }
  const step = Math.min(9, (diff * clockwise) / 12);
  return Array.from({ length: n }, (_, i) => fromHsl(h[0] + i * step, h[1], h[2]));
}

function cooler(hex, n) {
  const h = hslOf(hex);
  const step = Math.min(9, (180 - h[0]) / 12);
  return Array.from({ length: n }, (_, i) => fromHsl(h[0] + i * step, h[1], h[2]));
}

const webSafe = (hex) => { const [r, g, b] = hexToRgb(hex); return rgbToHex(Math.round(r / 51) * 51, Math.round(g / 51) * 51, Math.round(b / 51) * 51); };

// Linear-light sRGB channels [0..1] (the site's gamma curve, 0.03928 knee).
function linearRgb(hex) {
  return hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
}

function xyzOf(hex) {
  const [r, g, b] = linearRgb(hex);
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
  ];
}

function labOf(hex) {
  const [x, y, z] = xyzOf(hex);
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
  const fx = f(x / 0.95047), fy = f(y / 1.0), fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function oklabOf(hex) {
  const [r, g, b] = linearRgb(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

const round = (v, d) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
// Trim a trailing ".0" so values read like the website's (e.g. "240" not "240.0").
const num = (v) => String(v);

function polar(a, b) {
  const c = Math.sqrt(a * a + b * b);
  let h = Math.atan2(b, a) * 180 / Math.PI;
  if (h < 0) { h += 360; }
  return [c, h];
}

const fmt = {
  rgb: (hex) => { const [r, g, b] = hexToRgb(hex); return `rgb(${r}, ${g}, ${b})`; },
  rgbPct: (hex) => { const [r, g, b] = hexToRgb(hex); return `rgb(${Math.round(r / 255 * 100)}%, ${Math.round(g / 255 * 100)}%, ${Math.round(b / 255 * 100)}%)`; },
  hsl: (hex) => { const h = hslOf(hex); return `hsl(${h[0]}, ${h[1]}%, ${h[2]}%)`; },
  hsv: (hex) => { const h = hsvOf(hex); return `hsv(${h[0]}, ${h[1]}%, ${h[2]}%)`; },
  hwb: (hex) => {
    const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    return `hwb(${hslOf(hex)[0]} ${Math.round(Math.min(r, g, b) * 100)}% ${Math.round((1 - Math.max(r, g, b)) * 100)}%)`;
  },
  cmyk: (hex) => { const c = cmykOf(hex); return `cmyk(${c[0]}%, ${c[1]}%, ${c[2]}%, ${c[3]}%)`; },
  decimal: (hex) => String(parseInt(hex.slice(1), 16)),
  octal: (hex) => hexToRgb(hex).map((v) => v.toString(8)).join(' '),
  binary: (hex) => hexToRgb(hex).map((v) => v.toString(2).padStart(8, '0')).join(' '),
  oklab: (hex) => { const o = oklabOf(hex); return `oklab(${num(round(o[0], 3))} ${num(round(o[1], 3))} ${num(round(o[2], 3))})`; },
  oklch: (hex) => { const o = oklabOf(hex); const [c, h] = polar(o[1], o[2]); return `oklch(${num(round(o[0], 3))} ${num(round(c, 3))} ${num(round(h, 1))})`; },
  lab: (hex) => { const l = labOf(hex); return `lab(${num(round(l[0], 3))} ${num(round(l[1], 3))} ${num(round(l[2], 3))})`; },
  lch: (hex) => { const l = labOf(hex); const [c, h] = polar(l[1], l[2]); return `lch(${num(round(l[0], 2))} ${num(round(c, 2))} ${num(round(h, 1))})`; },
  xyz: (hex) => { const x = xyzOf(hex); return `xyz(${num(round(x[0], 3))}, ${num(round(x[1], 3))}, ${num(round(x[2], 3))})`; },
  yxy: (hex) => {
    const [x, y, z] = xyzOf(hex).map((v) => v * 100);
    const sum = (x + y + z) || 1;
    return `yxy(${num(round(y, 2))}, ${num(round(x / sum, 4))}, ${num(round(y / sum, 4))})`;
  },
  hunter: (hex) => {
    const [x, y, z] = xyzOf(hex).map((v) => v * 100);
    if (y <= 0) { return '0, 0, 0'; }
    const sq = Math.sqrt(y);
    return `${num(round(10 * sq, 2))}, ${num(round(17.5 * ((1.02 * x - y) / sq), 2))}, ${num(round(7 * ((y - 0.847 * z) / sq), 2))}`;
  },
};

// Nearest RAL Classic match by CIE-Lab distance (Ral.java).
let ralTable = null;
function nearestRal(hex) {
  if (!ralTable) {
    ralTable = RAL_CLASSIC.map(([code, h]) => ({ code, lab: labOf('#' + h) }));
  }
  const lab = labOf(hex);
  let best = '', bestD = Infinity;
  for (const ral of ralTable) {
    const dl = lab[0] - ral.lab[0], da = lab[1] - ral.lab[1], db = lab[2] - ral.lab[2];
    const d = dl * dl + da * da + db * db;
    if (d < bestD) { bestD = d; best = ral.code; }
  }
  return 'RAL ' + best;
}

// ---- accessibility (Wcag.java) ----------------------------------------------

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const normalTextLevel = (ratio) => ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : 'Fail';
const largeTextLevel = (ratio) => ratio >= 4.5 ? 'AAA' : ratio >= 3 ? 'AA' : 'Fail';

function apcaY(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126729 * Math.pow(r / 255, 2.4) + 0.7151522 * Math.pow(g / 255, 2.4) + 0.0721750 * Math.pow(b / 255, 2.4);
}

// Signed APCA lightness contrast Lc for text over a background (0.0.98 formula).
function apcaContrast(text, bg) {
  const blkThrs = 0.022, blkClmp = 1.414;
  let txtY = apcaY(text), bgY = apcaY(bg);
  txtY = txtY > blkThrs ? txtY : txtY + Math.pow(blkThrs - txtY, blkClmp);
  bgY = bgY > blkThrs ? bgY : bgY + Math.pow(blkThrs - bgY, blkClmp);
  if (Math.abs(bgY - txtY) < 0.0005) { return 0; }
  let sapc, out;
  if (bgY > txtY) {
    sapc = (Math.pow(bgY, 0.56) - Math.pow(txtY, 0.57)) * 1.14;
    out = sapc < 0.1 ? 0 : sapc - 0.027;
  } else {
    sapc = (Math.pow(bgY, 0.65) - Math.pow(txtY, 0.62)) * 1.14;
    out = sapc > -0.1 ? 0 : sapc + 0.027;
  }
  return Math.round(out * 100);
}

function apcaLevel(lc) {
  const a = Math.abs(lc);
  if (a >= 75) { return 'Body text'; }
  if (a >= 60) { return 'Large / bold'; }
  if (a >= 45) { return 'Large text'; }
  if (a >= 30) { return 'UI / non-text'; }
  return 'Fail';
}

// ---- colour vision deficiency (Cvd.java) ------------------------------------

const XYZ_TO_RGB = [3.240712470389558, -0.969259258688888, 0.05563600315398933,
  -1.5372626602963142, 1.875996969313966, -0.2039948802843549,
  -0.49857440415943116, 0.041556132211625726, 1.0570636917433989];
const RGB_TO_XYZ = [0.41242371206635076, 0.21265606784927693, 0.019331987577444885,
  0.3575793401363035, 0.715157818248362, 0.11919267420354762,
  0.1804662232369621, 0.0721864539171564, 0.9504491124870351];
const CONFUSION = {
  protan: { x: 0.7465, y: 0.2535, m: 1.273463, yi: -0.073894 },
  deutan: { x: 1.4, y: -0.4, m: 0.968437, yi: 0.003331 },
  tritan: { x: 0.1748, y: 0, m: 0.062921, yi: 0.292119 },
};

function cvdSimulate(hex, type, anomalize) {
  const [inR, inG, inB] = hexToRgb(hex);
  let outR, outG, outB;
  if (type === 'achroma') {
    const z = inR * 0.212656 + inG * 0.715158 + inB * 0.072186;
    outR = z; outG = z; outB = z;
  } else {
    const line = CONFUSION[type];
    const lin = (v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
    const lr = lin(inR), lg = lin(inG), lb = lin(inB);
    const x = lr * RGB_TO_XYZ[0] + lg * RGB_TO_XYZ[3] + lb * RGB_TO_XYZ[6];
    const y = lr * RGB_TO_XYZ[1] + lg * RGB_TO_XYZ[4] + lb * RGB_TO_XYZ[7];
    const z = lr * RGB_TO_XYZ[2] + lg * RGB_TO_XYZ[5] + lb * RGB_TO_XYZ[8];
    const sum = x + y + z;
    const cx = sum === 0 ? 0 : x / sum, cy = sum === 0 ? 0 : y / sum, bigY = y;
    const slope = (cy - line.y) / (cx - line.x);
    const yi = cy - cx * slope;
    const dx = (line.yi - yi) / (slope - line.m);
    const dy = slope * dx + yi;
    const simX = dx * bigY / dy, simZ = (1 - (dx + dy)) * bigY / dy;
    const ngx = 0.312713 * bigY / 0.329016, ngz = 0.358271 * bigY / 0.329016;
    const dX = ngx - simX, dZ = ngz - simZ;
    const dR = dX * XYZ_TO_RGB[0] + dZ * XYZ_TO_RGB[6];
    const dG = dX * XYZ_TO_RGB[1] + dZ * XYZ_TO_RGB[7];
    const dB = dX * XYZ_TO_RGB[2] + dZ * XYZ_TO_RGB[8];
    const r = simX * XYZ_TO_RGB[0] + bigY * XYZ_TO_RGB[3] + simZ * XYZ_TO_RGB[6];
    const g = simX * XYZ_TO_RGB[1] + bigY * XYZ_TO_RGB[4] + simZ * XYZ_TO_RGB[7];
    const b = simX * XYZ_TO_RGB[2] + bigY * XYZ_TO_RGB[5] + simZ * XYZ_TO_RGB[8];
    const clamp = (v) => (isNaN(v) || v > 1 || v < 0) ? 0 : v;
    const adjust = Math.max(clamp(((r < 0 ? 0 : 1) - r) / dR), clamp(((g < 0 ? 0 : 1) - g) / dG), clamp(((b < 0 ? 0 : 1) - b) / dB));
    const enc = (v) => 255 * (v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1 / 2.2));
    outR = enc(r + adjust * dR); outG = enc(g + adjust * dG); outB = enc(b + adjust * dB);
  }
  if (anomalize) {
    const v = 1.75, n = v + 1;
    outR = (v * outR + inR) / n; outG = (v * outG + inG) / n; outB = (v * outB + inB) / n;
  }
  const ch = (v) => isNaN(v) ? 0 : Math.max(0, Math.min(255, Math.round(v)));
  return rgbToHex(ch(outR), ch(outG), ch(outB));
}

const CVD_GROUPS = [
  ['Protan (red)', [['Protanomaly', 'protan', true], ['Protanopia', 'protan', false]]],
  ['Deutan (green)', [['Deuteranomaly', 'deutan', true], ['Deuteranopia', 'deutan', false]]],
  ['Tritan (blue)', [['Tritanomaly', 'tritan', true], ['Tritanopia', 'tritan', false]]],
  ['Monochromacy (no color)', [['Achromatomaly', 'achroma', true], ['Achromatopsia', 'achroma', false]]],
];

// ---- All In One Themes integration (read-only) ------------------------------

function applyThemeMatch(resp) {
  const p = resp.palette || {};
  if (p.accent) {
    document.documentElement.style.setProperty('--accent', p.accent);
    document.documentElement.style.setProperty('--accent-ink', relativeLuminance(p.accent) > 0.5 ? '#0F172A' : '#FFFFFF');
  }
}

function loadThemeMatch() {
  if (!ALL_IN_ONE_ID || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }
  try {
    chrome.runtime.sendMessage(ALL_IN_ONE_ID, { type: 'getActiveTheme' }, (resp) => {
      if (chrome.runtime.lastError) { return; }
      if (resp && resp.ok) { applyThemeMatch(resp); }
    });
  } catch (e) {
    // Messaging unavailable; the picker works fine on its own.
  }
}

// ---- DOM helpers --------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) { n.className = cls; }
  if (text !== undefined) { n.textContent = text; }
  return n;
}

function copy(text, row) {
  navigator.clipboard.writeText(text).then(() => {
    const hint = row.querySelector('.copy-hint');
    if (hint) {
      hint.textContent = 'Copied';
      row.classList.add('copied');
      setTimeout(() => { hint.textContent = 'Copy'; row.classList.remove('copied'); }, 900);
    }
  });
}

// A key / value row that copies its value on click (ConvRow).
function copyRow(key, value) {
  const row = el('button', 'val');
  row.type = 'button';
  row.appendChild(el('span', 'k', key));
  row.appendChild(el('span', 'v', value));
  row.appendChild(el('span', 'copy-hint', 'Copy'));
  row.addEventListener('click', () => copy(value, row));
  return row;
}

const groupHeader = (title) => el('div', 'group-head', title);

// A titled strip of colour chips; clicking a chip loads that colour (ChipStrip).
function chipStrip(title, colors, note) {
  const wrap = el('div', 'strip');
  const head = el('div', 'strip-head');
  head.appendChild(el('span', 'strip-title', title));
  if (note) { head.appendChild(el('span', 'strip-note', note)); }
  wrap.appendChild(head);
  const row = el('div', 'h-row');
  colors.forEach((hex) => row.appendChild(chip(hex)));
  wrap.appendChild(row);
  return wrap;
}

function chip(hex, cls) {
  const c = el('button', 'chip' + (cls ? ' ' + cls : ''));
  c.type = 'button';
  c.style.background = hex;
  c.title = hex;
  c.addEventListener('click', () => { show(hex); addHistory(hex); });
  return c;
}

// A channel bar (ChannelBar): label, filled track, value.
function channelBar(label, display, pct, tint) {
  const row = el('div', 'bar-row');
  row.appendChild(el('span', 'bar-label', label));
  const track = el('div', 'bar-track');
  const fill = el('div', 'bar-fill');
  fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  fill.style.background = tint;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', 'bar-value', display));
  return row;
}

// A contrast row (ContrastRow): "Aa" sample, ratio and the three badges.
function contrastRow(title, text, surface) {
  const row = el('div', 'a11y-row');
  const sample = el('span', 'a11y-sample', 'Aa');
  sample.style.color = text;
  sample.style.background = surface;
  row.appendChild(sample);
  const body = el('div', 'a11y-body');
  const top = el('div', 'a11y-top');
  top.appendChild(el('span', 'a11y-title', title));
  const ratio = contrastRatio(text, surface);
  top.appendChild(el('span', 'a11y-ratio', ratio.toFixed(2) + ':1'));
  body.appendChild(top);
  const badges = el('div', 'a11y-badges');
  const n = normalTextLevel(ratio), l = largeTextLevel(ratio);
  const lc = apcaContrast(text, surface), al = apcaLevel(lc);
  badges.appendChild(el('span', 'badge lv-' + n, 'Normal · ' + n));
  badges.appendChild(el('span', 'badge lv-' + l, 'Large · ' + l));
  badges.appendChild(el('span', 'badge lv-' + (al === 'Fail' ? 'Fail' : al === 'Body text' ? 'AAA' : 'AA'), 'APCA Lc ' + lc + ' · ' + al));
  body.appendChild(badges);
  row.appendChild(body);
  row.title = 'Text ' + text + ' on ' + surface;
  return row;
}

function fill(container, nodes) {
  container.textContent = '';
  nodes.forEach((n) => container.appendChild(n));
}

// ---- render (ColorPickerPanel.show) -------------------------------------------

function show(hex) {
  hex = hex.toUpperCase();
  const [r, g, b] = hexToRgb(hex);
  swatch.style.background = hex;
  swatchHex.textContent = hex;
  swatchHex.style.color = relativeLuminance(hex) > 0.5 ? '#0F172A' : '#FFFFFF';

  fill($('cssRows'), [
    copyRow('Color', `color: ${hex};`),
    copyRow('Background', `background-color: ${hex};`),
    copyRow('Border', `border: 2px solid ${hex};`),
    copyRow('Text Shadow', `text-shadow: 2px 2px 4px ${hex};`),
    copyRow('Box Shadow', `box-shadow: 0 8px 24px rgba(${r}, ${g}, ${b}, 0.5);`),
  ]);

  const complement = rotateHue(hex, 180);
  fill($('a11yRows'), [
    contrastRow('On white', hex, '#FFFFFF'),
    contrastRow('White on it', '#FFFFFF', hex),
    contrastRow('On black', hex, '#000000'),
    contrastRow('Black on it', '#000000', hex),
    contrastRow('On its complement', hex, complement),
    contrastRow('Complement on it', complement, hex),
  ]);

  const hsl = hslOf(hex), hsv = hsvOf(hex), cmyk = cmykOf(hex);
  const hueTint = `hsl(${hsl[0]}, 70%, 45%)`;
  fill($('channels'), [
    groupHeader('RGB'),
    channelBar('R', String(r), r / 255 * 100, '#D6493F'),
    channelBar('G', String(g), g / 255 * 100, '#3AA35E'),
    channelBar('B', String(b), b / 255 * 100, '#3A74E0'),
    groupHeader('HSL'),
    channelBar('H', hsl[0] + '°', hsl[0] / 360 * 100, hueTint),
    channelBar('S', hsl[1] + '%', hsl[1], hex),
    channelBar('L', hsl[2] + '%', hsl[2], `hsl(0, 0%, ${hsl[2]}%)`),
    groupHeader('HSV'),
    channelBar('H', hsv[0] + '°', hsv[0] / 360 * 100, hueTint),
    channelBar('S', hsv[1] + '%', hsv[1], hex),
    channelBar('V', hsv[2] + '%', hsv[2], `hsl(0, 0%, ${hsv[2]}%)`),
    groupHeader('CMYK'),
    channelBar('C', cmyk[0] + '%', cmyk[0], '#0B9FD8'),
    channelBar('M', cmyk[1] + '%', cmyk[1], '#D6338E'),
    channelBar('Y', cmyk[2] + '%', cmyk[2], '#E0B926'),
    channelBar('K', cmyk[3] + '%', cmyk[3], '#1F2937'),
  ]);

  fill($('convRows'), [
    groupHeader('Web & sRGB'),
    copyRow('Hex', hex),
    copyRow('RGB', fmt.rgb(hex)),
    copyRow('RGB %', fmt.rgbPct(hex)),
    copyRow('Web-Safe', webSafe(hex)),
    copyRow('Decimal', fmt.decimal(hex)),
    copyRow('Octal', fmt.octal(hex)),
    copyRow('Binary', fmt.binary(hex)),
    groupHeader('Hue-Based'),
    copyRow('HSL', fmt.hsl(hex)),
    copyRow('HSV', fmt.hsv(hex)),
    copyRow('HWB', fmt.hwb(hex)),
    groupHeader('Perceptual & Wide Gamut'),
    copyRow('OKLCH', fmt.oklch(hex)),
    copyRow('OKLab', fmt.oklab(hex)),
    copyRow('CIE-LAB', fmt.lab(hex)),
    copyRow('CIE-LCH', fmt.lch(hex)),
    groupHeader('Print'),
    copyRow('CMYK', fmt.cmyk(hex)),
    copyRow('RAL', nearestRal(hex)),
    groupHeader('CIE Tristimulus'),
    copyRow('XYZ', fmt.xyz(hex)),
    copyRow('Yxy', fmt.yxy(hex)),
    copyRow('Hunter Lab', fmt.hunter(hex)),
  ]);

  const verdict = isWarm(hex) ? 'Warm' : 'Cool';
  fill($('harmony'), [
    chipStrip('Analogous', analogousTrio(hex)),
    chipStrip('Monochrome', monochromeTrio(hex)),
    chipStrip('Complementary', [hex, complement]),
    chipStrip('Split Complementary', [hex, rotateHue(hex, 150), rotateHue(hex, 210)]),
    chipStrip('Triadic', [hex, rotateHue(hex, 120), rotateHue(hex, 240)]),
    chipStrip('Tetradic', [hex, rotateHue(hex, 60), complement, rotateHue(hex, 240)]),
    chipStrip('Temperature', [hex], verdict),
  ]);

  fill($('ramps'), [
    chipStrip('Tints', ramp(hex, '#FFFFFF', RAMP_STEPS)),
    chipStrip('Shades', ramp(hex, '#000000', RAMP_STEPS)),
    chipStrip('Tones', ramp(hex, '#808080', RAMP_STEPS)),
  ]);

  fill($('temperature'), [
    el('p', 'verdict', 'On the warm to cool axis this color reads ' + verdict),
    chipStrip('Warmer', warmer(hex, RAMP_STEPS)),
    chipStrip('Cooler', cooler(hex, RAMP_STEPS)),
  ]);

  const cvdNodes = [];
  CVD_GROUPS.forEach(([group, types]) => {
    cvdNodes.push(groupHeader(group));
    types.forEach(([name, type, anomalize]) => {
      const sim = cvdSimulate(hex, type, anomalize);
      const row = el('div', 'cvd-row');
      const pair = el('div', 'cvd-pair');
      const base = el('span', 'chip cvd-base');
      base.style.background = hex;
      base.title = hex;
      pair.appendChild(base);
      pair.appendChild(chip(sim, 'cvd-sim'));
      row.appendChild(pair);
      const text = el('div', 'cvd-text');
      text.appendChild(el('span', 'cvd-name', name));
      text.appendChild(el('span', 'cvd-hex', sim));
      row.appendChild(text);
      cvdNodes.push(row);
    });
  });
  fill($('cvd'), cvdNodes);

  openLink.href = 'https://codigrate.com/tools/color/' + hex.slice(1);
  result.classList.remove('hidden');
}

function renderHistory(list) {
  historyRow.textContent = '';
  if (!list || !list.length) {
    historyRow.appendChild(el('span', 'empty', 'No colors picked yet'));
    return;
  }
  list.forEach((hex) => {
    const c = el('button', 'chip');
    c.type = 'button';
    c.style.background = hex;
    c.title = hex;
    c.addEventListener('click', () => show(hex));
    historyRow.appendChild(c);
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

// Collapsible sections: the state persists like the JetBrains tool window's.
let collapsed = {};
function applyCollapsed() {
  document.querySelectorAll('.sec').forEach((sec) => {
    sec.classList.toggle('collapsed', !!collapsed[sec.dataset.sec]);
  });
}

document.querySelectorAll('.sec-head').forEach((head) => {
  head.addEventListener('click', () => {
    const key = head.parentElement.dataset.sec;
    collapsed[key] = !collapsed[key];
    storageSet({ [COLLAPSED_KEY]: collapsed });
    applyCollapsed();
  });
});

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

// ---- wire up ----------------------------------------------------------------

pickBtn.addEventListener('click', pick);

storageGet([HISTORY_KEY, LAST_KEY, COLLAPSED_KEY], (data) => {
  collapsed = data[COLLAPSED_KEY] || {};
  applyCollapsed();
  renderHistory(data[HISTORY_KEY] || []);
  if (data[LAST_KEY]) { show(data[LAST_KEY]); }
});

loadThemeMatch();
