'use strict';

// Codigrate Color Picker popup. Uses the native EyeDropper API to sample any
// pixel on screen, then reads the colour exactly the way the Codigrate Color
// Picker for macOS does: the same header (swatch, name, hex field, pick, copy,
// recent colors), the same analysis sections in the same order (conversions,
// CSS, accessibility, channels, harmony, ramps, temperature, color vision) and
// the same formats. All maths is ported 1:1 from the macOS / JetBrains apps.

const HISTORY_KEY = 'history';
const LAST_KEY = 'last';
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
const swatch = $('swatch');
const hexField = $('hexField');
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

// macOS hexToHsl: hue rounded, saturation and lightness to one decimal.
function hslDec(hex) {
  let [r, g, b] = hexToRgb(hex);
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) { h = ((g - b) / d) % 6; }
    else if (mx === g) { h = (b - r) / d + 2; }
    else { h = (r - g) / d + 4; }
  }
  h = Math.round(h * 60);
  if (h < 0) { h += 360; }
  const l = (mx + mn) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, round(sat * 100, 1), round(l * 100, 1)];
}

const fmt = {
  rgb: (hex) => { const [r, g, b] = hexToRgb(hex); return `rgb(${r}, ${g}, ${b})`; },
  rgbPct: (hex) => { const [r, g, b] = hexToRgb(hex); return `rgb(${Math.round(r / 255 * 100)}%, ${Math.round(g / 255 * 100)}%, ${Math.round(b / 255 * 100)}%)`; },
  hsl: (hex) => { const h = hslDec(hex); return `hsl(${h[0]}, ${h[1]}%, ${h[2]}%)`; },
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
  lab: (hex) => { const l = labOf(hex); return `lab(${num(round(l[0], 2))} ${num(round(l[1], 2))} ${num(round(l[2], 2))})`; },
  lch: (hex) => { const l = labOf(hex); const [c, h] = polar(l[1], l[2]); return `lch(${num(round(l[0], 2))} ${num(round(c, 2))} ${num(round(h, 1))})`; },
  xyz: (hex) => { const x = xyzOf(hex); return `${num(round(x[0] * 100, 3))}, ${num(round(x[1] * 100, 3))}, ${num(round(x[2] * 100, 3))}`; },
  yxy: (hex) => {
    const [x, y, z] = xyzOf(hex).map((v) => v * 100);
    const sum = (x + y + z) || 1;
    return `${num(round(y, 2))}, ${num(round(x / sum, 4))}, ${num(round(y / sum, 4))}`;
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

// Copy, then flash the row's value as "Copied" for 0.9s (macOS CopyRow).
function copyFlash(text, node, valueEl) {
  navigator.clipboard.writeText(text).then(() => {
    const prev = valueEl.textContent;
    valueEl.textContent = 'Copied';
    node.classList.add('copied');
    setTimeout(() => { valueEl.textContent = prev; node.classList.remove('copied'); }, 900);
  });
}

function copyRow(label, value) {
  const row = el('button', 'row');
  row.type = 'button';
  row.appendChild(el('span', 'k', label));
  const v = el('span', 'v', value);
  row.appendChild(v);
  row.title = value;
  row.addEventListener('click', () => copyFlash(value, row, v));
  return row;
}

function group(title, rows) {
  const g = el('div', 'group');
  g.appendChild(el('div', 'sec-title', title));
  rows.forEach((r) => g.appendChild(r));
  return g;
}

function chip(hex) {
  const c = el('button', 'chip');
  c.type = 'button';
  c.style.background = hex;
  c.title = hex;
  c.addEventListener('click', () => { show(hex); addHistory(hex); });
  return c;
}

// A titled ChipStrip; `kind` = 'tall' (26px, harmony) or '' (22px).
function strip(title, colors, kind) {
  const wrap = el('div', 'strip');
  wrap.appendChild(el('div', 'strip-title', title));
  const row = el('div', 'chips' + (kind ? ' ' + kind : ''));
  colors.forEach((h) => row.appendChild(chip(h)));
  wrap.appendChild(row);
  return wrap;
}

function bar(label, frac, value, fillColor) {
  const row = el('div', 'bar');
  row.appendChild(el('span', 'bar-k', label));
  const track = el('div', 'bar-track');
  const fill = el('div', 'bar-fill');
  fill.style.width = (Math.max(0, Math.min(1, frac)) * 100) + '%';
  fill.style.background = fillColor;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', 'bar-v', value));
  return row;
}

// macOS AccessibilitySection row: Aa sample, label, ratio, WCAG badge, Lc.
function a11yRow(label, text, bg) {
  const row = el('div', 'a11y');
  const sample = el('span', 'a11y-sample', 'Aa');
  sample.style.background = bg;
  sample.style.color = text;
  row.appendChild(sample);
  row.appendChild(el('span', 'a11y-label', label));
  const ratio = contrastRatio(text, bg);
  row.appendChild(el('span', 'a11y-ratio', num(round(ratio, 2)) + ':1'));
  const level = normalTextLevel(ratio);
  row.appendChild(el('span', 'badge ' + (level === 'Fail' ? 'fail' : 'ok'), level));
  row.appendChild(el('span', 'a11y-lc', 'Lc ' + Math.abs(apcaContrast(text, bg))));
  row.title = 'Text ' + text + ' on ' + bg;
  return row;
}

function fill(id, nodes) {
  const c = $(id);
  c.textContent = '';
  nodes.forEach((n) => c.appendChild(n));
}

// "endless-galaxy" -> "Endless Galaxy" (macOS ColorReference.name).
function colorName(hex) {
  const raw = COLOR_NAMES[hex.slice(1).toUpperCase()];
  if (!raw) { return ''; }
  return raw.split(/[- ]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ---- render (macOS RootView + AnalysisSections) --------------------------------

let current = '';

function show(hex) {
  hex = hex.toUpperCase();
  current = hex;
  const [r, g, b] = hexToRgb(hex);
  swatch.style.background = hex;
  hexField.value = hex;
  $('colorName').textContent = colorName(hex);

  const hsl = hslDec(hex), hsv = hsvOf(hex), cmyk = cmykOf(hex);
  const [X, Y, Z] = xyzOf(hex);
  fill('conversions', [
    group('Web & sRGB', [
      copyRow('HEX', hex),
      copyRow('RGB', fmt.rgb(hex)),
      copyRow('RGB %', fmt.rgbPct(hex)),
      copyRow('Web-Safe', webSafe(hex)),
      copyRow('Decimal', fmt.decimal(hex)),
      copyRow('Octal', fmt.octal(hex)),
      copyRow('Binary', fmt.binary(hex)),
    ]),
    group('Hue-Based', [
      copyRow('HSL', fmt.hsl(hex)),
      copyRow('HSV', fmt.hsv(hex)),
      copyRow('HWB', fmt.hwb(hex)),
    ]),
    group('Perceptual', [
      copyRow('OKLCH', fmt.oklch(hex)),
      copyRow('OKLab', fmt.oklab(hex)),
      copyRow('CIE-LAB', fmt.lab(hex)),
      copyRow('CIE-LCH', fmt.lch(hex)),
    ]),
    group('Print', [
      copyRow('CMYK', fmt.cmyk(hex)),
      copyRow('RAL', nearestRal(hex)),
    ]),
    group('CIE', [
      copyRow('XYZ', fmt.xyz(hex)),
      copyRow('Yxy', fmt.yxy(hex)),
      copyRow('Hunter Lab', fmt.hunter(hex)),
    ]),
  ]);

  fill('cssRows', [
    copyRow('color', `color: ${hex};`),
    copyRow('background', `background-color: ${hex};`),
    copyRow('border', `border: 1px solid ${hex};`),
    copyRow('rgb', `color: rgb(${r}, ${g}, ${b});`),
    copyRow('hsl', `color: hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%);`),
  ]);

  const comp = rotateHue(hex, 180);
  fill('a11yRows', [
    a11yRow('On White', hex, '#FFFFFF'),
    a11yRow('White On', '#FFFFFF', hex),
    a11yRow('On Black', hex, '#000000'),
    a11yRow('Black On', '#000000', hex),
    a11yRow('On Complement', hex, comp),
    a11yRow('Complement On', comp, hex),
  ]);

  fill('channels', [
    bar('R', r / 255, String(r), '#FF3B30'),
    bar('G', g / 255, String(g), '#34C759'),
    bar('B', b / 255, String(b), '#007AFF'),
    bar('H', hsl[0] / 360, Math.round(hsl[0]) + '°', fromHsl(hsl[0], 100, 50)),
    bar('S', hsl[1] / 100, Math.round(hsl[1]) + '%', '#8E8E93'),
    bar('L', hsl[2] / 100, Math.round(hsl[2]) + '%', '#8E8E93'),
    bar('V', hsv[2] / 100, hsv[2] + '%', '#8E8E93'),
    bar('C', cmyk[0] / 100, cmyk[0] + '%', '#32ADE6'),
    bar('M', cmyk[1] / 100, cmyk[1] + '%', '#FF00FF'),
    bar('Y', cmyk[2] / 100, cmyk[2] + '%', '#FFCC00'),
    bar('K', cmyk[3] / 100, cmyk[3] + '%', '#000000'),
  ]);

  fill('harmony', [
    strip('Complementary', [hex, comp], 'tall'),
    strip('Analogous', analogousTrio(hex), 'tall'),
    strip('Monochrome', monochromeTrio(hex), 'tall'),
    strip('Split Complementary', [hex, rotateHue(hex, 150), rotateHue(hex, 210)], 'tall'),
    strip('Triadic', [hex, rotateHue(hex, 120), rotateHue(hex, 240)], 'tall'),
    strip('Tetradic', [hex, rotateHue(hex, 60), comp, rotateHue(hex, 240)], 'tall'),
  ]);

  fill('ramps', [
    strip('Tints', ramp(hex, '#FFFFFF', RAMP_STEPS)),
    strip('Shades', ramp(hex, '#000000', RAMP_STEPS)),
    strip('Tones', ramp(hex, '#808080', RAMP_STEPS)),
  ]);

  fill('temperature', [
    el('p', 'verdict', 'On the warm to cool axis this color reads ' + (isWarm(hex) ? 'warm' : 'cool') + '.'),
    strip('Warmer', warmer(hex, RAMP_STEPS)),
    strip('Cooler', cooler(hex, RAMP_STEPS)),
  ]);

  const cvdRows = [
    ['Protanomaly', 'protan', true], ['Deuteranomaly', 'deutan', true], ['Tritanomaly', 'tritan', true], ['Achromatomaly', 'achroma', true],
    ['Protanopia', 'protan', false], ['Deuteranopia', 'deutan', false], ['Tritanopia', 'tritan', false], ['Achromatopsia', 'achroma', false],
  ].map(([name, type, anomalize]) => {
    const sim = cvdSimulate(hex, type, anomalize);
    const row = el('button', 'cvd');
    row.type = 'button';
    const c = el('span', 'cvd-chip');
    c.style.background = sim;
    row.appendChild(c);
    row.appendChild(el('span', 'cvd-name', name));
    const v = el('span', 'cvd-hex', sim);
    row.appendChild(v);
    row.addEventListener('click', () => copyFlash(sim, row, v));
    return row;
  });
  fill('cvd', cvdRows);

  openLink.href = 'https://codigrate.com/tools/color/' + hex.slice(1).toLowerCase();
}

function renderHistory(list) {
  historyRow.textContent = '';
  const box = $('recents');
  if (!list || !list.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  list.forEach((hex) => historyRow.appendChild(chip(hex)));
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

// The hex field: type or paste a color and press Enter (macOS onSubmit).
function submitHex() {
  let v = hexField.value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) { v = v.split('').map((c) => c + c).join(''); }
  if (!/^[0-9a-f]{6}$/i.test(v)) { hexField.value = current; return; }
  const hex = '#' + v.toUpperCase();
  show(hex);
  addHistory(hex);
}

// ---- wire up ----------------------------------------------------------------

pickBtn.addEventListener('click', pick);
hexField.addEventListener('keydown', (e) => { if (e.key === 'Enter') { submitHex(); } });
hexField.addEventListener('blur', submitHex);
$('copyHex').addEventListener('click', () => {
  const btn = $('copyHex');
  navigator.clipboard.writeText(current).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 900);
  });
});

storageGet([HISTORY_KEY, LAST_KEY], (data) => {
  renderHistory(data[HISTORY_KEY] || []);
  show(data[LAST_KEY] || '#3F4494');
});

loadThemeMatch();
