# v0.1 — HTML5 Canvas WASM milestone

**Goal:** ship a usable HTML5 Canvas WASM implementation in a single focused day. Cover the API surface that ~80–90% of real HTML5 canvas code actually touches; leave text, shadows, gradients-as-fillStyle, and anti-aliasing for follow-up work.

**Distribution target:** the existing `dist/simdra.mjs` artifact (WASM bundle via `rollup-plugin-zigar`). The native node-zigar build is the dev iteration loop; the WASM build is what ships.

**Acceptance criteria for the milestone:** every listed task lands, all existing tests stay green (currently 67/67), `npm run build` produces a working WASM bundle, `npm run test:built` exercises the new APIs through the WASM path. Each task ticks the corresponding boxes in `specs/CanvasRenderingContext2D.md` (and `specs/HTMLCanvasElement.md` where applicable).

## What's in vs. out for v0.1

| In ✅ | Out ⏭️ (next milestones) |
|---|---|
| transform stack (translate/rotate/scale/transform/setTransform/resetTransform/save/restore) | anti-aliasing on path edges |
| globalAlpha + non-opaque fill via `src_over` | text rendering (font subsystem — separate effort) |
| `globalCompositeOperation` for `'source-over'` and `'lighter'` | shadows (`shadowBlur`/`shadowColor`/`shadowOffsetX`/Y) |
| putImageData (symmetric to getImageData) | gradient/pattern as `fillStyle` (samplers stubbed; wiring is +1h, post-v0.1) |
| drawImage (3-arg + 9-arg, nearest-neighbor sampling) | `imageSmoothingQuality` (bilinear sampling — +1h after v0.1) |
| beginPath/moveTo/lineTo/bezierCurveTo/quadraticCurveTo/closePath + `fill()` | full set of HTML5 blend modes (`darken`, `lighten`, `multiply`, `screen`, `xor`, ...) |
| `arc` / `ellipse` / `arcTo` (curve-flattened to line segments) | `lineDash` / `lineDashOffset` |
| `stroke()` with butt caps + miter joins | `lineCap` / `lineJoin` other than butt+miter |
| `fillStyle` / `strokeStyle` as CSS strings (parsing already exists; wire the setters) | `clip()` / `isPointInPath` / `isPointInStroke` |

## Architecture invariants (don't break these)

- **Zig stays HTML5-free**. New methods on `core/Sm*.zig` use neutral graphics names; HTML5 method names live in `src/index.ts`.
- **Drawing pipeline = Scan → Blitter**. New shape rasterizers grow `core/SmScan.zig`; new fill kinds / blend modes grow `core/SmBlitter.zig`'s dispatch. **Never** add a new pixel-writing path that bypasses `SmBlitter.blitRow`.
- **SIMD spine everywhere**. Per-pixel hot loops process N lanes via `@Vector(N, ...)`; new kernels live in `opts/generic.zig` (and optionally specialized in `opts/neon.zig`). Generic stays the byte-equal correctness reference and the WASM-safe target.
- **Skia-style static factories**. Construction is on the type itself (`SmFoo.bar(...)`), no flat free functions in `simdra.zig`.

## Dependency graph

```
T1 transform stack ──┐
                     ├──► T5 path fill ──► T6 arc/ellipse ──► T7 path stroke
T2 blend_mode + α ───┤
T3 putImageData ─────┤   (T2-T4 are independent — can land in any order)
T4 drawImage ────────┘
```

T1 is foundational. T2/T3/T4 are independent of each other and of T1; safe to land in any order. T5 must land before T6 and T7. **Recommended sequence**: T1 → T2 → T3 → T4 → T5 → T6 → T7.

---

## T1 — Transform stack

**Goal:** `ctx.translate / rotate / scale / transform / setTransform / resetTransform / getTransform / save / restore` work, and every drawing method respects the current transform.

**Files touched:**
- `zig/simdra/core/SmCanvas.zig` — add `current_transform: SmMatrix = .{}` field; add `state_stack: StateStack`. Methods: `translate`, `rotate`, `scale`, `concat` (for `transform(...)`), `setTransform`, `resetTransform`, `getTransform`, `save`, `restore`.
- `zig/simdra/core/SmCanvas.zig` — `drawRect` and `drawTriangle` apply `current_transform` before scan: identity-axis-aligned → fast path scanline as today; rotated/sheared → emit transformed-corner polygon, fall through to a polygon fill (lands fully in T5; for T1 we can apply transform to triangle fill, and document rect-with-non-axis-aligned-transform as TODO until T5 ships).
- `src/simdra-zig.d.ts` — declare new methods on the SmCanvas interface.
- `src/index.ts` — `class Canvas` no change; the methods are called directly on the renderer proxy (HTML5 `ctx.translate(...)` etc. work because they're real Zig methods).
- `test/index.js` — add tests: identity transform draws same as before; rotate(90) on a rect draws as expected at the new position.

**Acceptance criteria:**
- All existing tests stay green.
- New tests: 90° rotation of a rect produces pixels in the rotated position; `save → modify → restore` returns to the prior transform; nested save/restore stack works to depth ≥ 4.
- `getTransform()` returns a Matrix matching the WebIDL DOMMatrix shape.

**Spec checkbox refs:**
- `specs/CanvasRenderingContext2D.md`: `translate`, `rotate`, `scale`, `transform`, `setTransform`, `resetTransform`, `getTransform`, `save`, `restore`.

**Time estimate:** 1.5 h.

---

## T2 — blend_mode + globalAlpha (srcover wired)

**Goal:** non-opaque colors blend per HTML5 spec (Porter-Duff src_over). `ctx.globalAlpha = 0.5` halves source alpha. `ctx.globalCompositeOperation = 'source-over' | 'lighter'` switches the blend kernel.

**Files touched:**
- `zig/simdra/core/SmPaint.zig` — add `blend_mode: BlendMode = .src_over` and `global_alpha: u8 = 0xFF`. Add `BlendMode` enum: `src_over`, `src`, `add` (Love2D `add` / HTML5 `lighter`).
- `zig/simdra/core/SmBlitter.zig` — `blitRow` dispatches on `paint.blend_mode`: `.src` → `simd.fillU32`; `.src_over` → `simd.blendSrcOverU32`; `.add` → `simd.blendAddU32` (new kernel, T2.5 below). Apply `paint.global_alpha` to source pre-blend (multiplies into src.a).
- `zig/simdra/opts/generic.zig` — add `blendAddU32(dst, src_color)` SIMD kernel (saturating per-channel u8 add). Re-export through `opts/simd.zig` and inherit in `opts/neon.zig`.
- `zig/simdra/core/SmCanvas.zig` — add `globalAlpha: u8 = 0xFF` field + `setGlobalAlpha(a: u8)`. Add `globalCompositeOperation: BlendMode`. The `fillRect`/`strokeRect`/etc. helpers read these into the SmPaint they build.
- `src/simdra-zig.d.ts` — extend SmCanvas interface; SmPaint gets `blend_mode` + `global_alpha`.
- `src/index.ts` — augment `SmCanvas.prototype` with `globalAlpha` get/set + `globalCompositeOperation` get/set: parse string → enum, write to underlying field.
- `test/index.js` — non-opaque fillStyle + opaque background blends to mid-color; globalAlpha halves alpha; `'lighter'` mode adds.

**Acceptance criteria:**
- `setFillStyle(255, 0, 0, 128); fillRect(...)` over white produces ~`(255, 127, 127, 255)` (within ±1 due to fast `(x*y + 128) >> 8` divide).
- `globalAlpha = 0.5` over fully opaque fill = effective alpha 0x80.
- `globalCompositeOperation = 'lighter'` saturates per channel.

**Spec checkbox refs:**
- `specs/CanvasRenderingContext2D.md`: `globalAlpha`, `globalCompositeOperation`, `fillStyle` non-opaque path.

**Time estimate:** 1 h.

---

## T3 — putImageData

**Goal:** symmetric counterpart of `getImageData`. `ctx.putImageData(imageData, dx, dy)` and `ctx.putImageData(imageData, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)` both work.

**Files touched:**
- `zig/simdra/core/SmCanvas.zig` — add `putImageData(bitmap: SmBitmap, dx: i32, dy: i32) void` and `putImageDataDirty(bitmap, dx, dy, dirty_x, dirty_y, dirty_w, dirty_h) void`. Per-row `simd.copyU32` from bitmap.data into self.pixels at offset. **Bypasses transform** per HTML5 spec.
- `zig/simdra/opts/` — no new kernel; reuse `simd.copyU32`. (For float16 input, add `simd.copyFloat16NormToU32` kernel — symmetric to existing `copyU32ToFloat16Norm`. Skip if not exercised today; rgba_unorm8 is the path pdf.js uses.)
- `src/simdra-zig.d.ts` — declare on SmCanvas interface.
- `src/index.ts` — patch `putImageData` onto `SmCanvas.prototype` with WebIDL dispatch (3-arg and 7-arg forms).
- `test/index.js` — round-trip: `getImageData → mutate → putImageData → getImageData` returns mutated values.

**Acceptance criteria:**
- 3-arg form copies the whole bitmap.
- 7-arg form copies only the dirty sub-rect (relative to bitmap's origin).
- Dirty rect that goes out of bitmap bounds is clipped silently per spec.
- Round-trip preserves bytes byte-for-byte (same colorspace + format).

**Spec checkbox refs:**
- `specs/CanvasRenderingContext2D.md`: `putImageData`.

**Time estimate:** 30 min.

---

## T4 — drawImage (nearest-neighbor)

**Goal:** `ctx.drawImage(image, dx, dy)`, `drawImage(image, dx, dy, dw, dh)`, `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)` all work. Source = an `ImageData` (rgba_unorm8 SmBitmap) for v0.1; an `HTMLCanvasElement`-equivalent (another simdra `Canvas`) is symmetric and lands free since they share the buffer shape. Nearest-neighbor sampling only (bilinear is +1h post-v0.1).

**Files touched:**
- `zig/simdra/effects/SmImageSource.zig` — new file. Holds `image_pixels: []const u32`, `image_w/h: u32`, `inv_transform: SmMatrix` (dst→src mapping). Provides per-row sample helpers.
- `zig/simdra/core/SmPaint.zig` — extend with `kind: PaintKind = .solid` enum (`.solid | .image`); `image: ?*const SmImageSource = null`. The `Style` we have today (fill/stroke/fill_and_stroke) is orthogonal to PaintKind — both stay.
- `zig/simdra/core/SmBlitter.zig` — `blitRow` adds source phase: `paint.kind == .image` → call `simd.sampleImageNearestN` per N-pixel chunk; modulate; blend.
- `zig/simdra/opts/generic.zig` — `sampleImageNearestN(dst: []u32, src_pixels: []const u32, src_w, src_h, u_start, v_start, du, dv, n) void` SIMD kernel. Per-N-lane: integer `(u, v)` from start + step, clamp to source bounds, gather (loop with one indirection per lane on CPU; LLVM vectorizes the rest). Re-export via `opts/simd.zig`; inherit in `opts/neon.zig`.
- `zig/simdra/core/SmCanvas.zig` — `drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh)`. Computes `inv_transform` mapping dst pixel → source pixel (combines current_transform × dst-rect-to-source-rect mapping). Builds image-paint, scans dst rect rows, hands to SmBlitter.
- `src/simdra-zig.d.ts` — declare drawImage signatures + SmImageSource.
- `src/index.ts` — patch `drawImage` onto `SmCanvas.prototype`. Accepts an `ImageData` (`SmBitmap` proxy) or any object with `.data / .width / .height` matching unorm8 layout. Also accepts a JS `Canvas` instance — extracts the underlying SmSurface's pixels.
- `test/index.js` — draw a 4×4 sprite at (10,10); read back via getImageData and verify pixels match. Test 9-arg form with sub-rect.

**Acceptance criteria:**
- 3-arg form draws the source bitmap 1:1.
- 5-arg form scales the source to the dst rect (nearest-neighbor).
- 9-arg form selects a sub-rect of source and scales to dst.
- Source pixels outside the source rect (clamped at edges) are NOT read.
- Combined with T1: `translate(50, 50); drawImage(...)` shifts; `rotate(45deg); drawImage(...)` rotates.

**Spec checkbox refs:**
- `specs/CanvasRenderingContext2D.md`: `drawImage` (all 3 overloads).

**Time estimate:** 1.5 h (1h + 0.5h test/wire).

---

## T5 — Path fill (no AA)

**Goal:** `ctx.fill()` rasterizes the current path with `paint.kind = .solid` (or `.image` / future `.gradient`). Polygons, custom shapes, Béziers all fill correctly. Edges are aliased (no smooth coverage).

**Files touched:**
- `zig/simdra/core/SmScan.zig` — new function `pathToCoverageRows`: walk path opcodes, flatten Béziers (de Casteljau split, recursive until segment-flatness threshold), build edge list `(x0, y0, x1, y1)`. Active-edge-table scan converter: at each y, find x intersections with active edges, sort, emit spans between pairs (even-odd fill rule by default; non-zero needs winding count later).
- `zig/simdra/core/SmCanvas.zig` — `fill()` method: emit current `self.path` through `SmScan.pathToCoverageRows`, blit each row.
- `src/simdra-zig.d.ts` — declare `fill()` on SmCanvas.
- `src/index.ts` — already exposed via SmCanvas method (no JS shim needed).
- `test/index.js` — fill a closed triangle as a path → matches `fillTriangle` output bit-for-bit. Fill a square via `moveTo/lineTo×4/closePath` → matches `fillRect`. Fill a non-convex polygon (a star) → expected silhouette.

**Acceptance criteria:**
- Closed paths fill correctly (even-odd rule).
- Bézier curves render (flattening tolerance: max segment chord error ≤ 0.25 px).
- `fill()` respects current transform (T1) — rotated paths fill at rotated coordinates.
- Edges are aliased (no AA); one of the AC of T5 is **not** smooth edges.

**Spec checkbox refs:**
- `specs/CanvasRenderingContext2D.md`: `fill()`.
- `specs/Path2D.md`: cross-reference; the JS Path2D class also benefits since SmCanvas.fill works on `self.path`. (Filling a Path2D directly via `ctx.fill(path)` is +30 min after this.)

**Time estimate:** 2 h.

---

## T6 — arc / ellipse / arcTo

**Goal:** `ctx.arc(cx, cy, r, sa, ea[, ccw])`, `ellipse(cx, cy, rx, ry, rot, sa, ea[, ccw])`, `arcTo(x1, y1, x2, y2, r)` build path opcodes that flatten to line segments inside SmScan.

**Files touched:**
- `zig/simdra/core/SmPath.zig` — add `arc` / `ellipse` opcodes (parameters: cx, cy, rx, ry, rotation, start_angle, end_angle, ccw). Add `arcToOpcode` (or implement `arcTo` inline as math → arc opcode).
- `zig/simdra/core/SmScan.zig` — handle the new opcodes in `pathToCoverageRows`: flatten arc to N line segments where N proportional to radius (target chord error ≤ 0.25 px). For full circle radius 100, ~64 segments.
- `zig/simdra/core/SmCanvas.zig` — add `arc / ellipse / arcTo` methods that delegate to `self.path`.
- `src/simdra-zig.d.ts` — declare new path methods on SmCanvas + SmPath.
- `test/index.js` — fill a circle (radius 50) → expected pixel-count within ±5% of `π·r²`. Fill an ellipse. Round-corner rect via `arcTo` × 4.

**Acceptance criteria:**
- `arc(cx, cy, r, 0, 2π)` → filled disk of correct area.
- `ellipse` with rotation rotates correctly (combines with T1 transform).
- `arcTo(x1, y1, x2, y2, r)` produces a tangent arc between segments at the correct angle.

**Spec checkbox refs:**
- `specs/CanvasRenderingContext2D.md`: `arc`, `ellipse`, `arcTo`.
- `specs/Path2D.md`: matching opcodes on Path2D.

**Time estimate:** 1 h.

---

## T7 — Path stroke (butt + miter)

**Goal:** `ctx.stroke()` outlines the current path at `lineWidth`. Butt line caps, miter joins (no bevel/round caps in v0.1). Skia approach: inflate path to a polygon (offset segments perpendicular by `lineWidth/2`, connect at joins), call fill on the inflated polygon.

**Files touched:**
- `zig/simdra/core/SmScan.zig` — new helper `inflatePath(path, line_width) -> SmPath` (or stream into an internal scratch path). Walks segments; for each segment emits two parallel offset lines + miter-clipped join with previous segment. Closed paths bridge first/last; open paths add butt caps (perpendicular cap line at endpoints).
- `zig/simdra/core/SmCanvas.zig` — `stroke()` method: build inflated path, run through `SmScan.pathToCoverageRows`, blit. Reuse stroke paint (color = self.strokeStyle, width = self.lineWidth).
- `src/simdra-zig.d.ts` — declare `stroke()` on SmCanvas.
- `test/index.js` — stroke a rectangle with lineWidth=10 matches `strokeRect` 4-edge legacy path within rounding. Stroke a closed triangle. Stroke an open polyline (caps at endpoints).

**Acceptance criteria:**
- Closed-path stroke matches the equivalent fill-of-rect-frame approach (`strokeRect` continues to use the legacy 4-thin-rects path; `stroke()` on a path-built rectangle matches it within ±1 pixel).
- Open polyline has butt caps at endpoints.
- Sharp turns produce mitered corners; if miter would be excessive (acute angle), spec says fall back to bevel — for v0.1 we just clip to miterLimit = 10 (default).

**Spec checkbox refs:**
- `specs/CanvasRenderingContext2D.md`: `stroke()`.
- `specs/Path2D.md`: implicit (any Path2D can be stroked once `ctx.stroke(path)` lands +30 min later).

**Time estimate:** 1.5 h.

---

## SIMD application per task

Recap of where the SIMD spine grows or is reused:

| Task | New SIMD kernels | Reused kernels |
|---|---|---|
| T1 | none (transforms apply at vertex level — already SIMD via SmMatrix.applyToPoint) | `SmMatrix.applyToPoint` (vector mul-add) |
| T2 | `blendAddU32` (`opts/generic.zig`) | `blendSrcOverU32` (already added), `fillU32` |
| T3 | (optional) `copyFloat16NormToU32` | `copyU32` |
| T4 | `sampleImageNearestN` (`opts/generic.zig`) | — |
| T5 | edge interpolation per scanline (`@Vector(N, f32)` for Bézier flattening); span fill via existing blitRow | `fillU32`, `blendSrcOverU32` |
| T6 | arc flattening — scalar (geometry, not per-pixel) | flows through T5 SIMD path |
| T7 | inflation — scalar (geometry) | flows through T5 SIMD path |

## After v0.1 (post-milestone work)

These are sized roughly. None block v0.1.

| Feature | Effort | Why deferred |
|---|---|---|
| ~~Anti-aliasing (analytic edge coverage)~~ 🟢 | ~~4 h~~ | **Landed post-v0.1.** Hybrid 8× Y-supersample + analytic-X partial coverage in `SmScan.sweepEdges`; SSIM ≥ 0.985 vs Skia on every curve scene. See `INTERNAL_DESIGN.md` § B3. |
| Bilinear `drawImage` (`imageSmoothingEnabled = true`) | 1 h | nearest works; bilinear is +1 sampler kernel |
| Gradient as fillStyle (`paint.kind = .gradient` wired) | 1 h | samplers stubbed in `effects/SmGradient.zig`; just wire `blitRow` source phase |
| Pattern as fillStyle | 2 h | `effects/SmPattern.zig` + a tiling sampler |
| All HTML5 blend modes (`darken/lighten/multiply/screen/xor/...`) | 2 h | one SIMD kernel per mode + dispatch case |
| Shadows (`shadowBlur` + offset) | 4 h | needs separable Gaussian kernel — the only kernel that has multi-pass cost |
| Text (`fillText` / `strokeText` / `measureText`) | 1-2 weeks | font subsystem + glyph rasterizer; out of scope for daily milestones |
| `clip()` + clip stack | 3 h | clip mask = a coverage rect intersected with all subsequent draws |
| `lineCap` (round, square) / `lineJoin` (round, bevel) | 2 h | extends T7's inflation |
| `lineDash` / `lineDashOffset` | 1 h | extends T7's segment emit |
| Tile-based path (perf for heavy scenes) | 1 day | only worthwhile for pdf.js full-page render or similar; same Blitter API plugs in |
