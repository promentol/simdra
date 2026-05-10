// SimdraCanvasFactory — implements the contract pdf.js's BaseCanvasFactory
// expects from a `canvasFactory` object: create / reset / destroy. Mirrors
// the shape of pdf.js's built-in NodeCanvasFactory (which uses
// @napi-rs/canvas) but builds on simdra so the same code runs unchanged in
// Cloudflare Workers / Vercel Edge / Deno Deploy / AWS Lambda.
//
// Why this works:
//   * `create(w, h)` returns `{ canvas, context }` — pdf.js draws into
//     `context` and reads `canvas.width`/`canvas.height` later.
//   * `reset({ canvas }, w, h)` sets `canvas.width`/`canvas.height` —
//     simdra's setter reallocates the bitmap and resets ctx state per spec.
//   * `destroy({ canvas })` sets dims to 0 and nulls the references.

export class SimdraCanvasFactory {
  constructor(createCanvas) {
    this.createCanvas = createCanvas;
  }

  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = this.createCanvas(width, height);
    return {
      canvas,
      // pdf.js passes `{ willReadFrequently }` here; simdra accepts and
      // ignores 2d-context attributes (no GPU path to opt out of).
      context: canvas.getContext('2d'),
    };
  }

  reset(canvasAndContext, width, height) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
    // Eager teardown of the Zig-side surface (pixel buffer, cached
    // SmCanvas, last encoded payload). Without this, cleanup happens
    // lazily through the FinalizationRegistry — fine for memory
    // correctness, slower under tight per-request memory caps.
    canvasAndContext.canvas.destroy();
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// installSimdraGlobals — pdf.js calls `new Path2D()`, `new DOMMatrix(...)`,
// and references `ImageData` as globals (these are WebIDL-spec types that
// browsers ship as window globals). On non-DOM runtimes we hand it the
// simdra implementations on `globalThis` BEFORE importing pdfjs-dist.
//
// Pass the simdra namespace exports (the ones from `simdra` or
// `simdra/wasm`) — { Path2D, DOMMatrix, ImageData }. Returns nothing.
export function installSimdraGlobals(simdra) {
  if (!globalThis.Path2D) globalThis.Path2D = simdra.Path2D;
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = simdra.DOMMatrix;
  if (!globalThis.ImageData) globalThis.ImageData = simdra.ImageData;
}
