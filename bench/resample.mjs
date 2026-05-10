// Microbench for the resampler. Run via `node --loader=node-zigar
// bench/resample.mjs` (native) or against the WASM dist after a build.
//
// Reports milliseconds per resize across kernels, plus a 4-corner
// comparison vs sharp (so the relative cost lines up with the existing
// quality measurements in test/microsharp_compare.js).

import { microsharp, createCanvas } from '../src/index.ts';

const SRC_DIM = 1024;
const DST_DIM = 512;
const ITERS = 30;
const KERNELS = ['nearest', 'linear', 'cubic', 'mitchell', 'lanczos2', 'lanczos3', 'mks2013', 'mks2021'];

const c = createCanvas(SRC_DIM, SRC_DIM);
const ctx = c.getContext('2d');
const grad = ctx.createLinearGradient(0, 0, SRC_DIM, SRC_DIM);
grad.addColorStop(0, '#1e3a8a');
grad.addColorStop(0.5, '#10b981');
grad.addColorStop(1, '#f59e0b');
ctx.fillStyle = grad;
ctx.fillRect(0, 0, SRC_DIM, SRC_DIM);
ctx.fillStyle = '#ef4444';
ctx.fillRect(120, 120, 200, 200);
const png = c.toBytes();

console.log(`bench: ${SRC_DIM}×${SRC_DIM} → ${DST_DIM}×${DST_DIM}, ${ITERS} iters/kernel`);
console.log(`source PNG: ${png.length} bytes`);
console.log();

let sharp = null;
try { sharp = (await import('sharp')).default; } catch {}

for (const kernel of KERNELS) {
  // Warm up
  await microsharp(png).resize(DST_DIM, DST_DIM, { kernel, fit: 'fill' }).raw().toBuffer();
  if (sharp) await sharp(png).resize(DST_DIM, DST_DIM, { kernel, fit: 'fill' }).raw().toBuffer();

  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    await microsharp(png).resize(DST_DIM, DST_DIM, { kernel, fit: 'fill' }).raw().toBuffer();
  }
  const t1 = performance.now();
  const microMs = (t1 - t0) / ITERS;

  let sharpMs = null;
  if (sharp) {
    const s0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      await sharp(png).resize(DST_DIM, DST_DIM, { kernel, fit: 'fill' }).raw().toBuffer();
    }
    const s1 = performance.now();
    sharpMs = (s1 - s0) / ITERS;
  }

  if (sharpMs !== null) {
    const ratio = microMs / sharpMs;
    console.log(`  ${kernel.padEnd(10)} microsharp ${microMs.toFixed(2).padStart(7)} ms  ` +
                `sharp ${sharpMs.toFixed(2).padStart(7)} ms  (${ratio.toFixed(2)}× slower)`);
  } else {
    console.log(`  ${kernel.padEnd(10)} microsharp ${microMs.toFixed(2).padStart(7)} ms`);
  }
}
