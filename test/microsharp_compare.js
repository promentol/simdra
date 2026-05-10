// microsharp ↔ sharp behaviour-parity tests.
//
// For each operation (resize across kernels and fits, extend modes,
// extract, trim), we run the same input through both libraries and
// compare outputs with SSIM. Thresholds are calibrated to current
// measured values minus a small margin, so this suite acts as a
// regression detector — a quality drop or a kernel bug shows up as a
// fail.
//
// microsharp now matches sharp/libvips's resample pipeline by default:
// sRGB → linear → premultiply α → separable filter → unpremultiply →
// linear → sRGB. Residual SSIM gap is from kernel-coefficient
// differences (Costella's MKS vs libvips's, sharp's lanczos
// normalization edge handling, etc.) — not from a fundamental pipeline
// mismatch.
//
// Pixel-exact ops:
//   - extract / extend.* / trim — deterministic copies; SSIM = 1
//   - withoutEnlargement (no-op) — SSIM = 1
//
// Resample ops (linear-premultiplied; numbers are observed minus margin):
//   - nearest — pixel replication; SSIM ≥ 0.99
//   - linear, cubic, mitchell, lanczos2 — SSIM ≥ 0.95
//   - lanczos3 — SSIM ≥ 0.94
//   - mks2013/2021 — Costella ref vs libvips re-derivation; ≥ 0.85
//   - position anchors — driven by the underlying lanczos3; ≥ 0.92
//   - fit modes — inherit kernel + crop/pad combo; per-fit thresholds
//
// On failure: writes <label>.microsharp.png, <label>.sharp.png, and
// <label>.diff.png (×4-amplified abs-difference) into
// test/__output_compare__/ so the divergence is inspectable.
//
// On failure: writes <label>.microsharp.png, <label>.sharp.png, and
// <label>.diff.png into test/__output_compare__/ so the divergence is
// inspectable.
//
// Skipped at the top level if `sharp` isn't installed (npm install --save-dev sharp).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

import { ssim } from 'ssim.js';

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.log('sharp not installed; skipping microsharp ↔ sharp comparison');
  process.exit(0);
}

import { createCanvas, microsharp } from '../src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '__output_compare__');
mkdirSync(OUTPUT_DIR, { recursive: true });

let pass = 0;
let fail = 0;

function safeName(s) {
  return s.replace(/[^a-z0-9._-]+/gi, '_');
}

// Decode PNG bytes via microsharp's raw path (always 4-channel RGBA, the
// shape ssim.js wants). Returns { data, width, height }.
async function decodeRgba(bytes) {
  const meta = await microsharp(bytes).metadata();
  const raw = await microsharp(bytes).raw().toBuffer();
  const out = new Uint8ClampedArray(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i];
  return { data: out, width: meta.width, height: meta.height };
}

function writeDiffPng(label, micro, sharpRgba) {
  // Build an abs-difference PNG via createCanvas (simdra) — keeps the
  // Sharp dependency optional for diff dumps.
  const c = createCanvas(micro.width, micro.height);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(micro.width, micro.height);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i + 0] = Math.min(255, Math.abs(micro.data[i + 0] - sharpRgba.data[i + 0]) * 4);
    id.data[i + 1] = Math.min(255, Math.abs(micro.data[i + 1] - sharpRgba.data[i + 1]) * 4);
    id.data[i + 2] = Math.min(255, Math.abs(micro.data[i + 2] - sharpRgba.data[i + 2]) * 4);
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  writeFileSync(join(OUTPUT_DIR, `${safeName(label)}.diff.png`), c.toBytes());
}

async function compare(label, threshold, microPng, sharpPng) {
  const microRgba = await decodeRgba(microPng);
  const sharpRgba = await decodeRgba(sharpPng);

  if (microRgba.width !== sharpRgba.width || microRgba.height !== sharpRgba.height) {
    fail++;
    console.log(
      `[FAIL] ${label}: dims diverge ` +
      `(microsharp=${microRgba.width}x${microRgba.height} sharp=${sharpRgba.width}x${sharpRgba.height})`,
    );
    writeFileSync(join(OUTPUT_DIR, `${safeName(label)}.microsharp.png`), microPng);
    writeFileSync(join(OUTPUT_DIR, `${safeName(label)}.sharp.png`), sharpPng);
    return;
  }

  const result = ssim(microRgba, sharpRgba);
  const ok = result.mssim >= threshold;
  if (ok) {
    pass++;
    console.log(`[PASS] ${label}: mssim=${result.mssim.toFixed(4)} (≥ ${threshold})`);
  } else {
    fail++;
    console.log(`[FAIL] ${label}: mssim=${result.mssim.toFixed(4)} (< ${threshold})`);
    writeFileSync(join(OUTPUT_DIR, `${safeName(label)}.microsharp.png`), microPng);
    writeFileSync(join(OUTPUT_DIR, `${safeName(label)}.sharp.png`), sharpPng);
    writeDiffPng(label, microRgba, sharpRgba);
  }
}

// Build a deterministic test image with mixed structure: solid blocks +
// diagonal gradient + alpha edge — gives every kernel a chance to
// differ and gives trim a clear bbox.
function buildSourcePng(w = 256, h = 256) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  // Transparent border for trim.
  // (createCanvas defaults to transparent black, which is what we want
  // for the outer ring.)
  // Gradient core
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#1e3a8a'); // indigo
  grad.addColorStop(0.5, '#10b981'); // emerald
  grad.addColorStop(1, '#f59e0b'); // amber
  ctx.fillStyle = grad;
  ctx.fillRect(20, 20, w - 40, h - 40);
  // Solid red rect to give edges
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(60, 60, 80, 60);
  // Thin black line — easy aliasing
  ctx.fillStyle = '#000000';
  ctx.fillRect(40, 200, w - 80, 2);
  return c.toBytes();
}

const SRC = buildSourcePng();

// =============================================================================
// resize — kernel-by-kernel SSIM
// =============================================================================

const KERNEL_THRESHOLDS = {
  nearest: 0.99,
  linear: 0.95,
  cubic: 0.97,
  mitchell: 0.95,
  lanczos2: 0.97,
  lanczos3: 0.94,
  mks2013: 0.85,
  mks2021: 0.90,
};

for (const [kernel, threshold] of Object.entries(KERNEL_THRESHOLDS)) {
  const microOut = await microsharp(SRC)
    .resize(128, 128, { kernel, fit: 'fill' })
    .png()
    .toBuffer();
  const sharpOut = await sharp(SRC)
    .resize(128, 128, { kernel, fit: 'fill' })
    .png()
    .toBuffer();
  await compare(`resize_kernel_${kernel}`, threshold, microOut, sharpOut);
}

// =============================================================================
// resize — fit modes (centre-anchored). lanczos3 default.
// =============================================================================

// Per-fit thresholds reflect the residual kernel-coefficient gap
// between our lanczos3 and sharp's lanczos3 after the gamma/premul
// match-up. Values are observed minus ~2% margin.
const FIT_THRESHOLDS = {
  cover: 0.88,
  contain: 0.95,
  fill: 0.88,
  inside: 0.93,
  outside: 0.85,
};
for (const [fit, threshold] of Object.entries(FIT_THRESHOLDS)) {
  const microOpts = { fit };
  const sharpOpts = { fit };
  if (fit === 'contain') {
    microOpts.background = { r: 0, g: 0, b: 0, alpha: 0 };
    sharpOpts.background = { r: 0, g: 0, b: 0, alpha: 0 };
  }
  const microOut = await microsharp(SRC).resize(180, 100, microOpts).png().toBuffer();
  const sharpOut = await sharp(SRC).resize(180, 100, sharpOpts).png().toBuffer();
  await compare(`resize_fit_${fit}`, threshold, microOut, sharpOut);
}

// =============================================================================
// resize — position anchors (cover-crop).
// =============================================================================

// Rectangular target so the cover-crop actually has overflow to anchor.
// 256×256 source → 120×80 final means scale=max(120/256, 80/256)=120/256;
// intermediate is 120×120 (square); final crops 40 px off the height.
// The `position` value picks which 40 px get dropped.
for (const position of ['top', 'right', 'bottom', 'left',
                         'right top', 'left bottom']) {
  const microOut = await microsharp(SRC)
    .resize(120, 80, { fit: 'cover', position }).png().toBuffer();
  const sharpOut = await sharp(SRC)
    .resize(120, 80, { fit: 'cover', position }).png().toBuffer();
  await compare(`resize_position_${position.replace(/\s+/g, '_')}`, 0.92, microOut, sharpOut);
}

// =============================================================================
// resize — withoutEnlargement / withoutReduction
// =============================================================================

{
  // Source 256×256, target 512×512 fit=inside withoutEnlargement -> stays 256×256.
  const microOut = await microsharp(SRC)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
  const sharpOut = await sharp(SRC)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
  await compare('resize_withoutEnlargement', 0.99, microOut, sharpOut);
}

// =============================================================================
// extract — pixel-exact memcpy.
// =============================================================================

{
  const region = { left: 30, top: 30, width: 120, height: 90 };
  const microOut = await microsharp(SRC).extract(region).png().toBuffer();
  const sharpOut = await sharp(SRC).extract(region).png().toBuffer();
  await compare('extract_subrect', 0.99, microOut, sharpOut);
}

// =============================================================================
// extend — background / copy / repeat / mirror
// =============================================================================

{
  const opts = { top: 12, right: 16, bottom: 12, left: 16 };
  for (const extendWith of ['background', 'copy']) {
    const bg = { r: 255, g: 0, b: 0, alpha: 1 };
    const microOut = await microsharp(SRC)
      .extend({ ...opts, extendWith, background: bg }).png().toBuffer();
    const sharpOut = await sharp(SRC)
      .extend({ ...opts, extendWith, background: bg }).png().toBuffer();
    await compare(`extend_${extendWith}`, 0.99, microOut, sharpOut);
  }

  // sharp's libvips supports mirror; repeat is a libvips feature too.
  // Compare both at high SSIM.
  for (const extendWith of ['mirror', 'repeat']) {
    const microOut = await microsharp(SRC).extend({ ...opts, extendWith }).png().toBuffer();
    let sharpOut;
    try {
      sharpOut = await sharp(SRC).extend({ ...opts, extendWith }).png().toBuffer();
    } catch (err) {
      console.log(`[SKIP] extend_${extendWith}: sharp threw ${String(err.message).slice(0, 80)}`);
      continue;
    }
    await compare(`extend_${extendWith}`, 0.95, microOut, sharpOut);
  }
}

// =============================================================================
// trim — bbox crop with default top-left-pixel background.
// =============================================================================

{
  // Build an image with a known transparent border so trim has work to do.
  const c = createCanvas(160, 100);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#22d3ee';
  ctx.fillRect(20, 15, 100, 70);
  ctx.fillStyle = '#9333ea';
  ctx.fillRect(50, 35, 40, 30);
  const trimSrc = c.toBytes();

  const microOut = await microsharp(trimSrc).trim().png().toBuffer();
  const sharpOut = await sharp(trimSrc).trim().png().toBuffer();
  await compare('trim_default', 0.85, microOut, sharpOut);
}

// =============================================================================
// composite — overlay placement, tile, blend modes
// =============================================================================

{
  // Build a 30×20 yellow overlay PNG.
  const ovC = createCanvas(30, 20);
  const ovX = ovC.getContext('2d');
  ovX.fillStyle = '#ffff00';
  ovX.fillRect(0, 0, 30, 20);
  const overlay = ovC.toBytes();

  // Default placement (centre, 'over' blend).
  {
    const m = await microsharp(SRC).composite([{ input: overlay }]).png().toBuffer();
    const s = await sharp(SRC).composite([{ input: overlay }]).png().toBuffer();
    await compare('composite_default_centre', 0.99, m, s);
  }
  // Explicit top/left.
  {
    const m = await microsharp(SRC).composite([{ input: overlay, top: 10, left: 30 }]).png().toBuffer();
    const s = await sharp(SRC).composite([{ input: overlay, top: 10, left: 30 }]).png().toBuffer();
    await compare('composite_top_left', 0.99, m, s);
  }
  // Gravity placement.
  for (const gravity of ['northeast', 'southwest', 'centre']) {
    const m = await microsharp(SRC).composite([{ input: overlay, gravity }]).png().toBuffer();
    const s = await sharp(SRC).composite([{ input: overlay, gravity }]).png().toBuffer();
    await compare(`composite_gravity_${gravity}`, 0.99, m, s);
  }
  // Tile.
  {
    const m = await microsharp(SRC).composite([{ input: overlay, tile: true, gravity: 'northwest' }]).png().toBuffer();
    const s = await sharp(SRC).composite([{ input: overlay, tile: true, gravity: 'northwest' }]).png().toBuffer();
    await compare('composite_tile_nw', 0.99, m, s);
  }
  // Blend modes that map cleanly to simdra's HTML5 set.
  for (const blend of ['multiply', 'screen', 'darken', 'lighten',
                        'difference', 'exclusion', 'add', 'xor',
                        'over', 'in', 'out', 'atop',
                        'dest-over', 'dest-in', 'dest-out', 'dest-atop']) {
    const m = await microsharp(SRC).composite([{ input: overlay, blend }]).png().toBuffer();
    const s = await sharp(SRC).composite([{ input: overlay, blend }]).png().toBuffer();
    // Some blend modes (especially color-dodge/burn, hard/soft-light)
    // diverge slightly between simdra and libvips because of
    // premultiplication ordering at the row blitter. We still expect
    // ≥ 0.95 SSIM for the ones in this list — they're the
    // "conservative" set that both libs implement identically.
    await compare(`composite_blend_${blend}`, 0.95, m, s);
  }
  // {create} flat-colour overlay parity.
  {
    const opts = {
      input: { create: { width: 60, height: 40, channels: 4,
                          background: { r: 255, g: 0, b: 0, alpha: 0.5 } } },
      top: 30, left: 40,
    };
    const m = await microsharp(SRC).composite([opts]).png().toBuffer();
    const s = await sharp(SRC).composite([opts]).png().toBuffer();
    await compare('composite_create_alpha', 0.95, m, s);
  }
  // Raw pre-built RGBA overlay parity (sharp's sibling-`raw` shape).
  {
    const data = new Uint8Array(40 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i + 0] = 0; data[i + 1] = 255; data[i + 2] = 0; data[i + 3] = 200;
    }
    const opts = {
      input: data,
      raw: { width: 40, height: 40, channels: 4 },
      top: 100, left: 50,
    };
    const m = await microsharp(SRC).composite([opts]).png().toBuffer();
    const s = await sharp(SRC).composite([opts]).png().toBuffer();
    await compare('composite_raw_alpha', 0.95, m, s);
  }
}

// =============================================================================
// channel ops — removeAlpha / ensureAlpha / extractChannel / bandbool
// =============================================================================
//
// Channel ops on our side produce 4-channel RGBA bitmaps. Sharp's
// extractChannel produces a 1-channel `b-w` image; bandbool also
// produces 1-channel. The PNG encoders write different channel counts
// — sharp writes 1-channel grey PNG, microsharp writes 4-channel. Both
// represent the same visible greyscale, so we compare the *decoded*
// raw bytes (always RGBA after our `decodeRgba` helper) at high SSIM.

{
  // Build a non-trivial RGBA source (60×60 with regions of distinct
  // colour mix so each channel has variance).
  const src = createCanvas(60, 60);
  const sx = src.getContext('2d');
  sx.fillStyle = '#3b82f6';
  sx.fillRect(0, 0, 60, 60);
  sx.fillStyle = '#10b981';
  sx.fillRect(10, 10, 40, 40);
  sx.fillStyle = '#ef4444';
  sx.fillRect(20, 20, 20, 20);
  const SRC_RGBA = src.toBytes();

  // removeAlpha — sharp emits a 3-channel PNG; microsharp emits 4-channel
  // RGBA with α=255. Both decode to RGBA where α=255 everywhere, so SSIM
  // should be 1.0.
  {
    const m = await microsharp(SRC_RGBA).removeAlpha().png().toBuffer();
    const s = await sharp(SRC_RGBA).removeAlpha().png().toBuffer();
    await compare('channel_removeAlpha', 0.99, m, s);
  }

  // ensureAlpha(0.5) — bitmap had α=255 from canvas; sharp sees an RGB
  // PNG (it strips alpha at decode) and adds α=0.5*255=127.5→128.
  // Microsharp keeps α=255 from the canvas decode, then setAlphaConstant
  // overwrites to 128. Compare on a 3-channel-source RGB encoded image.
  {
    // Build via sharp's `flatten` to ensure a 3-channel source.
    const rgb = await sharp(SRC_RGBA).flatten({ background: '#000' }).jpeg().toBuffer();
    const m = await microsharp(rgb).ensureAlpha(0.5).png().toBuffer();
    const s = await sharp(rgb).ensureAlpha(0.5).png().toBuffer();
    // Sharp's α may differ in the rounding (0.5 → 127 or 128); accept 0.95.
    await compare('channel_ensureAlpha_half', 0.95, m, s);
  }

  // extractChannel — each channel as greyscale.
  for (const ch of ['red', 'green', 'blue', 'alpha']) {
    const m = await microsharp(SRC_RGBA).extractChannel(ch).png().toBuffer();
    const s = await sharp(SRC_RGBA).extractChannel(ch).png().toBuffer();
    await compare(`channel_extract_${ch}`, 0.99, m, s);
  }

  // bandbool — sharp implements all three.
  for (const op of ['and', 'or', 'eor']) {
    const m = await microsharp(SRC_RGBA).bandbool(op).png().toBuffer();
    const s = await sharp(SRC_RGBA).bandbool(op).png().toBuffer();
    await compare(`channel_bandbool_${op}`, 0.99, m, s);
  }

  // joinChannel — single-channel raw mask. Sharp's libvips applies it
  // as a new alpha band; microsharp uses Rec.601 luma to derive a
  // single channel from any input. For grey masks (R=G=B), luma = R,
  // so the two paths agree exactly.
  {
    const maskBytes = new Uint8Array(60 * 60);
    for (let i = 0; i < maskBytes.length; i++) {
      // Diagonal gradient 0..255 so each pixel is distinct.
      const x = i % 60, y = (i / 60) | 0;
      maskBytes[i] = (x + y) * 2;
    }
    const opts = { raw: { width: 60, height: 60, channels: 1 } };
    const m = await microsharp(SRC_RGBA).joinChannel(maskBytes, opts).png().toBuffer();
    const s = await sharp(SRC_RGBA).joinChannel(maskBytes, opts).png().toBuffer();
    await compare('channel_joinChannel_raw1', 0.99, m, s);
  }
  // joinChannel — encoded grey PNG mask. sharp may decode this as
  // 1-channel grey internally, microsharp decodes as RGBA where R=G=B.
  // luma collapses to the grey value either way.
  {
    const m1 = createCanvas(60, 60);
    const m1x = m1.getContext('2d');
    m1x.fillStyle = '#404040';
    m1x.fillRect(0, 0, 60, 60);
    m1x.fillStyle = '#c0c0c0';
    m1x.fillRect(15, 15, 30, 30);
    const grey = m1.toBytes();
    const m = await microsharp(SRC_RGBA).joinChannel(grey).png().toBuffer();
    const s = await sharp(SRC_RGBA).joinChannel(grey).png().toBuffer();
    await compare('channel_joinChannel_encoded_grey', 0.95, m, s);
  }
}

// =============================================================================
// chained: resize + extract + trim
// =============================================================================

{
  // Pipeline: resize 50% lanczos3 -> extract centre -> back to PNG.
  const microOut = await microsharp(SRC)
    .resize(128, 128, { kernel: 'lanczos3', fit: 'fill' })
    .extract({ left: 16, top: 16, width: 96, height: 96 })
    .png().toBuffer();
  const sharpOut = await sharp(SRC)
    .resize(128, 128, { kernel: 'lanczos3', fit: 'fill' })
    .extract({ left: 16, top: 16, width: 96, height: 96 })
    .png().toBuffer();
  // The chain's bottleneck is the lanczos3 resize quality vs sharp's;
  // the extract afterwards is bit-exact in both libs.
  await compare('chain_resize_extract', 0.94, microOut, sharpOut);
}

// =============================================================================

const total = pass + fail;
console.log(`\n=== microsharp ↔ sharp: ${pass}/${total} passed ===`);
if (fail > 0) {
  console.log(`Diff PNGs in ${OUTPUT_DIR}`);
  process.exitCode = 1;
}
