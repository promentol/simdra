// Four-way benchmark across canvas implementations on Node:
//
//   • simdra wasm   — `dist/simdra.mjs`, built by `vite build` through
//                     rollup-plugin-zigar. WASM SIMD via @Vector(N).
//                     V8's WASM engine, ~512 KB bundle, no native deps.
//   • simdra native — `zig/simdra.zig` via node-zigar's loader hook
//                     (compiles Zig → aarch64 dylib at first import).
//                     Same source as wasm leg; NEON SIMD, no WASM cost.
//   • napi-skia     — `@napi-rs/canvas`, Skia C++ via Rust + N-API.
//                     The fast reference: tile-based scan, full HTML5.
//   • node-canvas   — `canvas` (Automattic), Cairo + Pango via node-gyp.
//                     The legacy reference: per-pixel scan, full HTML5.
//
// To get all four in the same process the script must run with the
// node-zigar loader. `npm run bench` wires this up.

import { performance } from 'node:perf_hooks';
import { createCanvas as wasmCreate } from '../dist/simdra.mjs';
import { createCanvas as nativeCreate } from '../src/index.ts';
import { createCanvas as skiaCreate } from '@napi-rs/canvas';
import { createCanvas as cairoCreate } from 'canvas';

const W = 800;
const H = 600;

// ---------------------------------------------------------------------------
// Bench harness
// ---------------------------------------------------------------------------

function bench(label, fn, { warmup = 100, runs = 1000 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const t1 = performance.now();
  const totalMs = t1 - t0;
  const msPerOp = totalMs / runs;
  return { label, msPerOp, opsPerSec: 1000 / msPerOp, totalMs, runs };
}

function runSuite(name, makeWorkload, options) {
  console.log(`\n## ${name}`);
  console.log('─'.repeat(76));
  const results = [
    bench('simdra wasm  ', makeWorkload(wasmCreate), options),
    bench('simdra native', makeWorkload(nativeCreate), options),
    bench('napi-skia    ', makeWorkload(skiaCreate), options),
    bench('node-canvas  ', makeWorkload(cairoCreate), options),
  ];
  const slowest = Math.max(...results.map((r) => r.msPerOp));
  for (const r of results) {
    const speedup = slowest / r.msPerOp;
    console.log(
      `  ${r.label}  ${r.msPerOp.toFixed(4).padStart(10)} ms/op   ` +
        `${Math.round(r.opsPerSec).toString().padStart(8)} ops/sec   ` +
        `${speedup.toFixed(1).padStart(5)}× vs slowest`,
    );
  }
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

// Solid fill of the full canvas — exercises simdra's `simd.fillU32` SIMD
// primitive (16 u32 per chunk). WASM goes through V8's SIMD lowering;
// native goes through aarch64's NEON.
function fillRectWorkload(create) {
  const canvas = create(W, H);
  const ctx = canvas.getContext('2d');
  return () => {
    ctx.fillStyle = '#03a9f4';
    ctx.fillRect(0, 0, W, H);
  };
}

// Same fillRect, but follows it with a 1-pixel readback to force any
// deferred rasterizer (Skia uses deferred drawing) to actually flush.
// Honest comparison — fillRect alone reads suspiciously fast on Skia
// because it just records the op.
function fillRectFlushedWorkload(create) {
  const canvas = create(W, H);
  const ctx = canvas.getContext('2d');
  return () => {
    ctx.fillStyle = '#03a9f4';
    ctx.fillRect(0, 0, W, H);
    const id = ctx.getImageData(0, 0, 1, 1);
    return id.data[0];
  };
}

// Many small rects — overhead-bound (per-call cost dominates fillU32
// throughput). This is where the WASM-boundary cost shows up vs native.
function manySmallRectsWorkload(create) {
  const canvas = create(W, H);
  const ctx = canvas.getContext('2d');
  return () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 100; i++) {
      const x = (i * 37) % (W - 20);
      const y = (i * 53) % (H - 20);
      ctx.fillStyle = `rgb(${(i * 11) % 255}, ${(i * 23) % 255}, ${(i * 31) % 255})`;
      ctx.fillRect(x, y, 20, 20);
    }
  };
}

// Filled circle — exercises path rasterization (Bezier flattening + AET).
function filledCircleWorkload(create) {
  const canvas = create(W, H);
  const ctx = canvas.getContext('2d');
  return () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#3366cc';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 200, 0, 2 * Math.PI);
    ctx.fill();
  };
}

// getImageData — pixel readback (tests the format-conversion / copy path,
// the simd.copyU32 SIMD kernel).
function getImageDataWorkload(create) {
  const canvas = create(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#33aa55';
  ctx.fillRect(0, 0, W, H);
  return () => {
    const id = ctx.getImageData(0, 0, W, H);
    return id.data[0];
  };
}

// putImageData — write pixels back. Pure simd.copyU32 hot path.
function putImageDataWorkload(create) {
  const canvas = create(W, H);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      id.data[i] = (x * 255) / W;
      id.data[i + 1] = (y * 255) / H;
      id.data[i + 2] = 128;
      id.data[i + 3] = 255;
    }
  }
  return () => {
    ctx.putImageData(id, 0, 0);
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\nsimdra benchmark — ${W}×${H} canvas`);
console.log(`node ${process.version}, arch ${process.arch}, platform ${process.platform}\n`);
console.log('Legs:');
console.log('  simdra wasm   — dist/simdra.mjs (WASM SIMD via V8)');
console.log('  simdra native — zig/simdra.zig via node-zigar loader (NEON aarch64)');
console.log('  napi-skia     — @napi-rs/canvas (Skia, N-API native binding)');
console.log('  node-canvas   — canvas (Cairo, node-gyp native binding)');

runSuite('fillRect — full-canvas solid fill (deferred-friendly)', fillRectWorkload, { runs: 500 });
runSuite('fillRect — full-canvas solid fill (forced flush via 1-px readback)', fillRectFlushedWorkload, { runs: 200 });
runSuite('100 small fillRects — overhead test', manySmallRectsWorkload, { runs: 500 });
runSuite('filled circle (path raster)', filledCircleWorkload, { runs: 200 });
runSuite('getImageData — full canvas readback', getImageDataWorkload, { runs: 100 });
runSuite('putImageData — full canvas write', putImageDataWorkload, { runs: 100 });

console.log('\nDone.\n');
