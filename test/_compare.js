// Visual SSIM + plain assertion helpers for test/index.js.
//
// `compareScene(label, w, h, drawScene, threshold?)` — runs the same
// drawScene against simdra and @napi-rs/canvas, computes SSIM, and writes
// PNGs into `test/__output__/`:
//
//     <safe-label>.simdra.png — what simdra produced (always written)
//     <safe-label>.napi.png   — the @napi-rs/canvas reference (failure only)
//     <safe-label>.diff.png   — abs(simdra - napi) × 4 amp (failure only)
//
// `plain(label, ok, info?)` — non-visual PASS/FAIL with the same counter.
// `summary()` — prints a final tally and sets process.exitCode on failures.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import { ssim } from 'ssim.js';

import { createCanvas as simdraCreate } from '../src/index.ts';
import { createCanvas as napiCreate } from '@napi-rs/canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '__output__');
mkdirSync(OUTPUT_DIR, { recursive: true });

let visualPass = 0;
let visualFail = 0;
let plainPass = 0;
let plainFail = 0;

function toClampedArrayCopy(imgData) {
  // simdra's `data` is a node-zigar proxy without Array.prototype methods;
  // copy index-by-index so the ssim.js view sees a real Uint8ClampedArray.
  const len = imgData.data.length;
  const out = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) out[i] = imgData.data[i];
  return out;
}

function snapshot(canvas) {
  const ctx = canvas.getContext('2d');
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: toClampedArrayCopy(id),
    width: canvas.width,
    height: canvas.height,
  };
}

function writeSimdraPng(canvas, path) {
  const url = canvas.toDataURL();
  const comma = url.indexOf(',');
  if (comma === -1) return;
  writeFileSync(path, Buffer.from(url.slice(comma + 1), 'base64'));
}

function writeNapiPng(canvas, path) {
  writeFileSync(path, canvas.toBuffer('image/png'));
}

function writeDiffPng(simImg, refImg, path) {
  const out = napiCreate(simImg.width, simImg.height);
  const ctx = out.getContext('2d');
  const id = ctx.createImageData(simImg.width, simImg.height);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i + 0] = Math.min(255, Math.abs(simImg.data[i + 0] - refImg.data[i + 0]) * 4);
    id.data[i + 1] = Math.min(255, Math.abs(simImg.data[i + 1] - refImg.data[i + 1]) * 4);
    id.data[i + 2] = Math.min(255, Math.abs(simImg.data[i + 2] - refImg.data[i + 2]) * 4);
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  writeFileSync(path, out.toBuffer('image/png'));
}

function safeName(label) {
  return label.replace(/[^a-z0-9._-]+/gi, '_');
}

export function compareScene(label, w, h, drawScene, threshold = 0.99) {
  const sim = simdraCreate(w, h);
  drawScene(sim.getContext('2d'));
  const ref = napiCreate(w, h);
  drawScene(ref.getContext('2d'));

  const simImg = snapshot(sim);
  const refImg = snapshot(ref);
  const score = ssim(simImg, refImg).mssim;
  const ok = Number.isFinite(score) && score >= threshold;

  const base = join(OUTPUT_DIR, safeName(label));
  writeSimdraPng(sim, `${base}.simdra.png`);

  if (ok) {
    visualPass++;
    console.log(`${label}: PASS (mssim=${score.toFixed(4)} ≥ ${threshold})`);
  } else {
    visualFail++;
    writeNapiPng(ref, `${base}.napi.png`);
    writeDiffPng(simImg, refImg, `${base}.diff.png`);
    const shown = Number.isFinite(score) ? score.toFixed(4) : 'NaN';
    console.log(
      `${label}: FAIL (mssim=${shown} < ${threshold}) → wrote ${base}.{simdra,napi,diff}.png`,
    );
  }
  return score;
}

export function plain(label, ok, info = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(info ? `${label}: ${tag} ${info}` : `${label}: ${tag}`);
  if (ok) plainPass++;
  else plainFail++;
}

export function summary() {
  const total = visualPass + visualFail + plainPass + plainFail;
  const fail = visualFail + plainFail;
  console.log(
    `\n=== ${total - fail}/${total} passed (visual ${visualPass}/${visualPass + visualFail}, plain ${plainPass}/${plainPass + plainFail}) ===`,
  );
  console.log(`Simdra-rendered PNGs in ${OUTPUT_DIR} (failures also have .napi.png / .diff.png).`);
  if (fail > 0) process.exitCode = 1;
}
