// Converts brand/deepseek-mobile.svg into an Android adaptive-icon VectorDrawable.
//
// The SVG's artwork lives inside one <g transform="matrix(...)">; VectorDrawable groups
// support only one translate+scale, so both the SVG matrix and the adaptive-icon
// safe-zone fit are composed analytically into a single group transform:
//
//   p' = k * (M * p - c) + canvasCenter        (M = SVG group matrix, c = transformed bbox center)
//
// with k chosen so the whole transformed bounding box fits inside the 66dp safe circle
// of the 108dp adaptive-icon canvas (viewport 1254), plus ~3% padding.
//
// Usage: node tools/brand/svg-to-vector.mjs <input.svg> <output.xml>

import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('usage: node svg-to-vector.mjs <input.svg> <output.xml>');
  process.exit(1);
}

const svg = readFileSync(inputPath, 'utf8');

// --- 1. extract group transform -------------------------------------------------
const groupMatch = svg.match(/<g[^>]*transform="matrix\(([^)]+)\)"/);
if (!groupMatch) {
  console.error('no matrix group transform found');
  process.exit(1);
}
const [a, b, c, d, e, f] = groupMatch[1].split(/[\s,]+/).map(Number);
// affine p' = (a*x + c*y + e, b*x + d*y + f); this file uses pure scale+translate.
if (Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9) {
  console.error('unsupported non-scale/translate matrix', groupMatch[1]);
  process.exit(1);
}
const sx = a, sy = d, tx = e, ty = f;

// --- 2. extract paths ------------------------------------------------------------
const pathPattern = /<path\s+d="([^"]+)"\s+style="([^"]+)"/g;
const paths = [];
for (const m of svg.matchAll(pathPattern)) {
  const dAttr = m[1];
  const style = m[2];
  const fillMatch = style.match(/fill:rgb\((\d+),(\d+),(\d+)\)/);
  if (!fillMatch) {
    console.error('path missing fill');
    process.exit(1);
  }
  const alphaMatch = style.match(/fill-opacity:([\d.]+)/);
  const [, r, g, b] = fillMatch.map(Number);
  paths.push({
    d: dAttr,
    color: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`,
    alpha: alphaMatch ? Number(alphaMatch[1]) : 1,
  });
}
console.log('paths:', paths.length);

// --- 3. parse path data, collect transformed bbox ---------------------------------
const coordPattern = /([A-Za-z])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
const transforms = [];
for (const path of paths) {
  let x = 0, y = 0, startX = 0, startY = 0;
  let lastCmd = null;
  const tokens = [];
  for (const m of path.d.matchAll(coordPattern)) {
    if (m[1] !== undefined) {
      const cmd = m[1];
      if (cmd !== cmd.toUpperCase()) {
        console.error('relative command not supported:', cmd);
        process.exit(1);
      }
      lastCmd = cmd;
      tokens.push({ cmd });
    } else {
      tokens.push({ num: Number(m[2]) });
    }
  }
  const out = [];
  let i = 0;
  const next = () => tokens[i++].num;
  const emit = (px, py) => {
    const X = sx * px + tx;
    const Y = sy * py + ty;
    if (X < bbox.minX) bbox.minX = X;
    if (X > bbox.maxX) bbox.maxX = X;
    if (Y < bbox.minY) bbox.minY = Y;
    if (Y > bbox.maxY) bbox.maxY = Y;
    out.push([X, Y]);
  };
  while (i < tokens.length) {
    const t = tokens[i++];
    const cmd = t.cmd ?? lastCmd;
    switch (cmd) {
      case 'M': x = next(); y = next(); startX = x; startY = y; emit(x, y); break;
      case 'L': x = next(); y = next(); emit(x, y); break;
      case 'C': {
        const x1 = next(), y1 = next(), x2 = next(), y2 = next(), x3 = next(), y3 = next();
        emit(x1, y1); emit(x2, y2); emit(x3, y3);
        x = x3; y = y3;
        break;
      }
      case 'Z': x = startX; y = startY; break;
      default:
        console.error('unsupported command:', cmd);
        process.exit(1);
    }
    lastCmd = cmd;
  }
  transforms.push({ d: path.d, out, color: path.color, alpha: path.alpha });
}
console.log('transformed bbox:', JSON.stringify(bbox));

// --- 4. compute safe-zone fit ------------------------------------------------------
const VIEWPORT = 1254;
const CANVAS_CENTER = VIEWPORT / 2;
// Adaptive icon: 108dp canvas, 66dp safe circle -> radius in viewport units.
const SAFE_RADIUS = (66 / 108) * VIEWPORT / 2;
const cx = (bbox.minX + bbox.maxX) / 2;
const cy = (bbox.minY + bbox.maxY) / 2;
const halfW = (bbox.maxX - bbox.minX) / 2;
const halfH = (bbox.maxY - bbox.minY) / 2;
const halfDiag = Math.hypot(halfW, halfH);
const k = (SAFE_RADIUS / halfDiag) * 0.97; // 3% padding inside the safe circle
// Compose SVG matrix M (p -> sx*p + tx) with the fit into ONE scale+translate:
//   p' = k*(M*p - c) + C  =  (k*sx)*p + (C + k*(tx - c))
const finalScale = k * sx;
const finalTx = CANVAS_CENTER + k * (tx - cx);
const finalTy = CANVAS_CENTER + k * (ty - cy);
console.log('fit k:', k.toFixed(4), 'final scale:', finalScale.toFixed(4), 'final translate:', finalTx.toFixed(2), finalTy.toFixed(2));

// --- 5. emit VectorDrawable ---------------------------------------------------------
const fmt = (n) => String(Math.round(n * 1000) / 1000);
const lines = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<!-- DeepSeek Mobile launcher/splash mark, converted from brand/deepseek-mobile.svg.',
  '     Artwork fits inside the 66dp adaptive-icon safe zone. -->',
  '<vector xmlns:android="http://schemas.android.com/apk/res/android"',
  '    android:width="108dp"',
  '    android:height="108dp"',
  `    android:viewportWidth="${VIEWPORT}"`,
  `    android:viewportHeight="${VIEWPORT}">`,
  `    <group`,
  `        android:scaleX="${fmt(finalScale)}"`,
  `        android:scaleY="${fmt(finalScale)}"`,
  `        android:translateX="${fmt(finalTx)}"`,
  `        android:translateY="${fmt(finalTy)}">`,
];
for (const t of transforms) {
  const nums = [];
  for (const m of t.d.matchAll(coordPattern)) {
    nums.push(m[1] !== undefined ? { cmd: m[1] } : { num: Number(m[2]) });
  }
  let data = '';
  let lastCmd = null;
  let x = 0, y = 0, startX = 0, startY = 0;
  let i = 0;
  while (i < nums.length) {
    const tok = nums[i++];
    const cmd = tok.cmd ?? lastCmd;
    const n = () => nums[i++].num;
    switch (cmd) {
      case 'M': x = n(); y = n(); startX = x; startY = y; data += `M${fmt(x)},${fmt(y)}`; break;
      case 'L': x = n(); y = n(); data += `L${fmt(x)},${fmt(y)}`; break;
      case 'C': {
        const x1 = n(), y1 = n(), x2 = n(), y2 = n(), x3 = n(), y3 = n();
        data += `C${fmt(x1)},${fmt(y1)} ${fmt(x2)},${fmt(y2)} ${fmt(x3)},${fmt(y3)}`;
        x = x3; y = y3;
        break;
      }
      case 'Z': data += 'Z'; x = startX; y = startY; break;
    }
    lastCmd = cmd;
  }
  const alpha = t.alpha >= 0.995 ? '' : ` android:fillAlpha="${fmt(t.alpha)}"`;
  lines.push(`        <path${alpha} android:fillColor="${t.color}" android:fillType="evenOdd" android:pathData="${data}"/>`);
}
lines.push('    </group>', '</vector>', '');
writeFileSync(outputPath, lines.join('\n'));
console.log('wrote', outputPath);
