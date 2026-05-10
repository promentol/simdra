# CanvasPattern

MDN: https://developer.mozilla.org/en-US/docs/Web/API/CanvasPattern

Returned by `createPattern(image, repetition)`. Tiles a source image (RGBA) across the fill region.

Lives in `zig/simdra/effects/SmPattern.zig`. Owns its own RGBA buffer (snapshot at construction) so the source `ImageData` / `Canvas` can mutate or be GC'd freely afterward — matches HTML5 spec.

Priority is set by pdf.js — PDF tiling patterns (PaintType 1) lower to `createPattern`, so this is critical. Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Instance methods

- [x] 🔴 `setTransform(matrix)` — accepts `DOMMatrix` or `DOMMatrix2DInit` (`{ a, b, c, d, e, f }`). The Zig side stores the *inverse* of the supplied matrix so the per-pixel sampler is one matrix multiply (no per-pixel inversion). Singular matrices silently no-op (HTML5: "If matrix is not invertible, do nothing"). — `zig/simdra/effects/SmPattern.zig`, `src/index.ts`.

## Construction

- [x] 🔴 `createPattern(image, repetition)` on `CanvasRenderingContext2D`. Accepts `ImageData | Canvas` (matches `drawImage`'s accepted set; HTMLImageElement / Blob / URL await a decoder pipeline). `repetition` ∈ `'' | 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat'` (empty defaults to `'repeat'` per spec); throws `SyntaxError` otherwise. — `src/index.ts`.

## Sampling

- Per-pixel `sample(x, y) u32` in `SmPattern.zig`: applies the stored inverse transform to dst `(x, y)`, then routes through the repetition mode (`floorMod` for the wrap modes — handles negative source coordinates), then nearest-neighbor texel fetch. Out-of-bounds with `.no_repeat` (or the non-tiled axis of `.repeat-x` / `.repeat-y`) returns transparent black. Bilinear filtering and SIMD row sampling are future work.

## Dependencies

- 🔴 ✅ `SmBitmap` (`zig/simdra/core/SmBitmap.zig`) — used as the snapshot source when `createPattern` accepts a `Canvas` (via the existing `getImageData` path); SmPattern then copies the bytes into its own owned buffer.
- 🔴 ✅ `SmMatrix.invertSelf` + `applyToPoint` (`zig/simdra/core/SmMatrix.zig`) — pattern transform inverse + per-pixel sample lookup.
- 🔴 ✅ `SmPaint.Shader` widened to include `pattern: *const SmPattern` (`zig/simdra/core/SmPaint.zig`); `SmBlitter.dispatchShader` routes per-pixel.
