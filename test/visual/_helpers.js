// Visual-regression helpers. Used by every test under test/visual/.

import { ssim } from 'ssim.js';

/**
 * Adapt an `ImageData`-like object (from either simdra or @napi-rs/canvas)
 * to the shape ssim.js expects: a plain object with `data`, `width`,
 * `height` where `data` is a real Uint8ClampedArray (real Array methods,
 * real .buffer). simdra's `data` is a node-zigar Uint8Array proxy that
 * supports `.length` and indexed access but not Array.prototype methods —
 * we copy into a real Uint8ClampedArray.
 */
export function toSsimImage(imageData) {
  const len = imageData.data.length;
  const out = new Uint8ClampedArray(len);
  // Copy lane-by-lane (works for both real Uint8ClampedArray and the
  // zigar proxy).
  for (let i = 0; i < len; i++) out[i] = imageData.data[i];
  return { data: out, width: imageData.width, height: imageData.height };
}

/**
 * Extract a comparable image (as ssim.js wants) from a `Canvas`-like
 * object — works for both simdra `Canvas` and @napi-rs/canvas Canvas.
 */
export function snapshot(canvas) {
  const ctx = canvas.getContext('2d');
  return toSsimImage(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/**
 * Run the same drawing function in both `simdra` and `@napi-rs/canvas`,
 * compute SSIM between the resulting bitmaps, and return the score
 * (mssim ∈ [0, 1] — 1.0 = identical).
 */
export function compareSSIM(simdraCreate, napiCreate, w, h, drawScene) {
  const sim = simdraCreate(w, h);
  const sctx = sim.getContext('2d');
  drawScene(sctx);

  const ref = napiCreate(w, h);
  const rctx = ref.getContext('2d');
  drawScene(rctx);

  const simImg = snapshot(sim);
  const refImg = snapshot(ref);
  const result = ssim(simImg, refImg);
  return result.mssim;
}
