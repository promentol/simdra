# simdra specs

Spec-driven implementation roadmap for the full HTML5 Canvas API as documented on MDN. Each interface lives in its own file with a checklist of members; an unchecked box is a unit of work.

**North star:** make pdf.js render. The priority of every member is set by whether pdf.js's `CanvasGraphics` pipeline calls into it.

## Active milestone

- 📍 **[v0.1 — HTML5 Canvas WASM](MILESTONE_v0.1.md)** — usable HTML5 canvas WASM in one focused day. Tasks T1–T7. **Complete.** Per-task spec boxes ticked.
- 🛠 **[Internal design hardening](INTERNAL_DESIGN.md)** — non-feature pure-Zig design debts. Two buckets: (A) reverse JS-binding compromises that bled into the Zig layer, (B) internal correctness/architecture debts (AET edge sweep, coverage routes through every blend mode, SmCanvas god-object split, Shader union, etc.). Pairs with the AA / gradient / pattern feature work — do B1+B2 *before* AA so AA gets correct compositing for free.

## Priority legend

- 🔴 **high** — on the pdf.js critical path; nothing else can be marked done until these are.
- 🟡 **low** — refinements / edge-case shapes / fields pdf.js touches rarely or not at all. Implement after the high set lands.
- ⛔ **unplanned** — DOM-only, depends on capabilities we don't have (Blob, MediaStream), or only useful for browser-side concerns. Tracked here but not scheduled.

Status emoji on the table below: ✅ all members done · 🟡 partial / non-spec variant · ⬜ not started.

## Status

| Interface | Status | Highest remaining | File |
|---|---|---|---|
| HTMLCanvasElement | 🟡 partial | `toBlob` (Blob shim) + WebP encoder (no stb path) ⛔ | [HTMLCanvasElement.md](HTMLCanvasElement.md) |
| CanvasRenderingContext2D | ✅ done | only ⛔ DOM-only items remain (`isContextLost`, `drawFocusIfNeeded`, `scrollPathIntoView`); some text-style props (`fontStretch`, `fontVariantCaps`, `textRendering`) are stored-but-no-effect for lack of font-variant infrastructure | [CanvasRenderingContext2D.md](CanvasRenderingContext2D.md) |
| ImageData | ✅ done | 0 | [ImageData.md](ImageData.md) |
| Path2D | 🟡 partial | SVG-string ctor + `arc`/`ellipse`/`arcTo`/`roundRect` on Path2D | [Path2D.md](Path2D.md) |
| CanvasGradient | 🟡 partial | sampler-into-fillStyle wiring (factory + `addColorStop` work; samplers are stubs) | [CanvasGradient.md](CanvasGradient.md) |
| CanvasPattern | ⬜ not started | `createPattern` + `setTransform` | [CanvasPattern.md](CanvasPattern.md) |
| TextMetrics | 🟡 partial | `width` lands; bounding-box / em-height / per-script baseline fields still 🟡 | [TextMetrics.md](TextMetrics.md) |
| OffscreenCanvas | ⬜ not started | mostly DOM-shaped, low priority | [OffscreenCanvas.md](OffscreenCanvas.md) |
| DOMMatrix | 🟡 partial | `m11..m44` aliases + skew/3D/preMultiply + `is2D`/`isIdentity` | [DOMMatrix.md](DOMMatrix.md) |

## Snapshot — what's already shipped

**v0.1 milestone (T1–T7) + Skia-OOP refactor + HTML5-wrapper rewrite:**

- Transform stack: `translate`, `rotate`, `scale`, `transform`, `setTransform`, `resetTransform`, `getTransform`, `save`, `restore`.
- Pixels: `getImageData` (with settings), `putImageData` (3-arg + 7-arg dirty-rect form), `createImageData` (number/number, settings, ImageData-arg overloads).
- Images: `drawImage` (3 / 5 / 9-arg, nearest-neighbor sampling, CTM-aware, accepts ImageData or Canvas).
- Paths: `beginPath`/`closePath`/`moveTo`/`lineTo`/`bezierCurveTo`/`quadraticCurveTo`/`rect`/`arc`/`ellipse`/`fill()`/`stroke()` (butt caps, miter joins).
- Styles as CSS strings: `fillStyle = '#ff0000' | 'rgba(...)' | 'red'` with canonical-form getter; same for `strokeStyle`.
- Gradients: `createLinearGradient` / `createRadialGradient` returning `CanvasGradient` (factory + `addColorStop` work; sampler-into-fill wiring still 🟡).
- DOMMatrix 2D core: `a/b/c/d/e/f`, `multiplySelf`, `translateSelf`, `scaleSelf`, `rotateSelf`, `invertSelf`, `new DOMMatrix([a,b,c,d,e,f])`.
- Path2D core: `new Path2D()` / `new Path2D(other)`, all path-build methods + `arc` / `ellipse` + `addPath(path, transform?)`.
- Strict HTML5 wrapper layer (`src/index.ts`): every public class is a real TS class with private `[ZIG]` symbol; `FinalizationRegistry` for auto-cleanup; Sm* Zig types never leak.

**Post-v0.1 sessions — text, blend modes, AA-shaped pipeline:**

- **Text subsystem v1** (`fillText`, `strokeText`, `measureText`, `font`, `textAlign`, `textBaseline`, `TextMetrics.width`):
  - stb_truetype vendored under `zig/simdra/utils/`; built via libc-linked C interop wired through `zig/build.extra.zig` (works for both native node-zigar and WASM rollup-plugin-zigar paths).
  - `zig/simdra/core/SmFont.zig` — Skia-style typeface+size; opaque `*anyopaque` handle keeps zigar's type scanner away from `stbtt_fontinfo`. Methods: `fromBytes`, `getMetrics`, `glyphIndexFor`, `glyphAdvanceWidth`, `measureWidth`, `rasterizeGlyph`, `release`.
  - `SmCanvas.drawText` / `fillText` walk UTF-8 codepoints, rasterize each glyph through SmFont, feed alpha rows to `SmBlitter.blitRow` as the **coverage parameter** — same plumbing future analytic-edge AA path fills will use.
  - Default font: Manrope (variable, ~162 KB, default instance Regular, SIL OFL) embedded via `@embedFile`; registered against `sans-serif` / `serif` / `monospace` / `system-ui`. User fonts come in via top-level `registerFont(bytes, family)` or the `fonts: [{ name, data }]` option on `createCanvas(w, h, opts)` — both non-spec, both share the global registry.
  - HTML5 façade in `src/index.ts`: subset CSS font-shorthand parser (`'<size>px <family-list>'`), `TextMetrics` class, `textAlign` / `textBaseline` validation. v1 caveats: `maxWidth` ignored; only CTM translation applied to the pen; `strokeText` falls back to fill; no kerning yet.
- **AA-shaped Blitter**: `SmBlitter.blitRow` previously `@panic`-ed on the coverage branch. New `blendSrcOverCovU32` kernel in `opts/generic.zig` accepts per-pixel coverage and routes through src_over / src / copy. Glyph rendering uses it today; analytic-edge AA path fills (the next 4 h of work) will plug in here without further blitter changes.
- **Full HTML5 `globalCompositeOperation` set** (was 3 modes — `'source-over'` / `'lighter'` / `'copy'`; now 26 modes):
  - 11 Porter-Duff: `source-over`, `source-in`, `source-out`, `source-atop`, `destination-over`, `destination-in`, `destination-out`, `destination-atop`, `xor`, `lighter`, `copy`. Centralized via one `pdScalar` evaluator + a comptime (Fa, Fb) factor pair per operator.
  - 11 separable blend: `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`. Centralized via one `sepScalar` evaluator + a comptime per-channel `B(Cb, Cs)` function per operator.
  - 4 non-separable HSL blend: `hue`, `saturation`, `color`, `luminosity`. f64 per-pixel HSL-shape RGB triple manipulation (`Lum`, `Sat`, `ClipColor`, `SetLum`, `SetSat`).
  - **Layer-composite** for the 5 modes whose pixel formula yields a non-`dst` result outside the source region (`source-in`, `source-out`, `destination-in`, `destination-atop`, `copy`): `BlendMode.requiresLayerComposite()` predicate gates `SmCanvas.beginCompositeLayer` / `endCompositeLayer`, which redirects rendering onto a transparent scratch buffer with `src_over`, then composites scratch → canvas using the user's mode via `SmBlitter.blitFull`. This is the W3C-spec rendering protocol; matches Skia / Cairo.
  - Correctness fixes flushed out by the visual diffs: exact `d255 = x / 255` (the `(x+128)>>8` approximation drifted 2-3 LSB through premult/un-premult round-trip); u64 widening on the un-premult divide (Zig 0.15 flagged the boundary `255×255+127` overflow).
  - All 23 new modes match `@napi-rs/canvas` pixel-for-pixel (Porter-Duff and separable at mssim 1.0000; HSL at 0.9999 — within rounding error of Skia).
- **Visual SSIM test infrastructure** (`test/index.js` + `test/_compare.js`):
  - 47 visual scenes via `compareScene(label, w, h, drawScene, threshold)` — runs the same scene in simdra and `@napi-rs/canvas`, computes mssim, asserts ≥ threshold.
  - Every scene writes `test/__output__/<label>.simdra.png` regardless of pass/fail, so simdra's output is always inspectable. On failure the helper additionally writes `<label>.napi.png` and `<label>.diff.png` (×4-amplified abs-difference) into the same directory. Failures are debuggable from the file system without a separate test infra step.
  - 73 plain assertions for non-visual structural / numeric / parser checks (CSS color parser, DOMMatrix arithmetic, Path2D structural, ImageData ctor, CanvasGradient ctor, text round-trips).
  - `npm test` reports `120/120 passed (visual 47/47, plain 73/73)` end-to-end.

## Post-v0.1 roadmap

Everything below is **additive on top of the snapshot above**. No architectural changes — each item plugs into an existing pipeline (Scan → Blitter → opts SIMD kernels) or extends a Sm* class with a new method. Items are sized in focused-work-hours.

### High-impact unimplemented (🔴)

| Group | Items | Effort | Dependency / approach |
|---|---|---|---|
| ~~**Anti-aliasing**~~ 🟢 | ~~analytic edge coverage in `SmScan.fillPath` / `strokePath`~~ | ~~4 h~~ | **Landed.** Hybrid 8× Y-supersample + analytic-X partial coverage in `SmScan.sweepEdges` (`zig/simdra/core/SmScan.zig`). Per-row scratches (`aa_accum: f32`, `aa_coverage: u8`) live on `SmCanvas`; coverage feeds `SmBlitter.blitRow` and routes through every blend mode + clip mask unchanged. SSIM ≥ 0.985 on every curve scene against `@napi-rs/canvas` (Skia). See `INTERNAL_DESIGN.md` § B3. |
| **`clip()`** | `clip(fillRule?)` / `clip(path, fillRule?)` — clip mask intersected with subsequent draws | 4 h | Clip stack on `SmCanvas` (push/pop via save/restore). Per-row coverage AND between fill output and clip mask in `SmBlitter.blitRow`. Reuses path scan-conversion. Every pdf.js page op sits under a clip. |
| **Stroke styles** | `lineCap` (round/square), `lineJoin` (round/bevel), `miterLimit` getter/setter, `setLineDash`/`getLineDash`, `lineDashOffset` | 4–6 h | `SmScan.strokePolyline` already accepts `miter_limit`; expose JS getter. Round/square caps + round/bevel joins extend the inflation per-vertex code. Dash list segments the polyline at append time. pdf.js sets all variants. |
| **CanvasPattern** | `createPattern(image, repetition)` → tiled image source + `setTransform` | 3 h | New `effects/SmPattern.zig` + tiling sampler kernel (modulo into source coords). New `SmPaint.kind = .pattern`. Pdf.js tiling fills. |
| **Gradient as `fillStyle`** | `ctx.fillStyle = ctx.createLinearGradient(...)` | 3 h | Wire existing `SmGradient` samplers (currently stubs returning first stop) into `SmBlitter` source phase. Add `SmPaint.kind = .gradient` + `simd.sampleGradientLinear/RadialN` kernels in `opts/`. |

### Medium / extension (🟡)

| Group | Items | Effort | Dependency / approach |
|---|---|---|---|
| **drawImage honors blend mode** | route image-sampling output through the blitter | 2 h | Currently `drawImageScaledSub` writes pixels directly via `simd.sampleImageNearestRow` — bypasses `SmBlitter.blitRow` and ignores `globalCompositeOperation`. After this fix, all 26 composite modes work for `drawImage` too. |
| **Bilinear `drawImage`** | `imageSmoothingEnabled = true` path | 1–2 h | New `simd.sampleImageBilinearN` kernel; same SIMD-coord-compute pattern as nearest, plus 4-corner gather + lerp. JS getter/setter wires the flag. |
| **Shadows** | `shadowBlur`, `shadowColor`, `shadowOffsetX`, `shadowOffsetY` | 4 h | Multi-pass: render shape into a scratch alpha buffer, separable Gaussian blur (the only kernel that's two-pass), composite into dst at offset. Adds `simd.gaussianBlur1D` to opts/. The composite-layer scratch from `endCompositeLayer` already proves the alloc + reuse pattern. |
| **Path2D extensions** | SVG path-data string parser; `arc`/`ellipse`/`arcTo`/`roundRect` on Path2D mirroring SmPath | 2–3 h | SVG parser is the biggest piece. arc/ellipse already on SmPath; arcTo and roundRect are new. |
| **arcTo** | `ctx.arcTo(x1, y1, x2, y2, radius)` | 1 h | Track current-point on `SmCanvas`; compute tangent points + miter arc geometry; emit as a flattened sub-path. |
| **`fill(path)` / `stroke(path)`** | accept explicit Path2D arg | 30 min | Add `SmCanvas.fillPath2D` / `strokePath2D` taking a `*const SmPath` arg; existing `fill()`/`stroke()` become 1-liners over `&self.path`. JS shim dispatches based on first arg. |
| **DOMMatrix completeness** | `m11..m44` aliases, `is2D`, `isIdentity`, `preMultiplySelf`, `skewXSelf`, `skewYSelf`, `fromMatrix`, 3D no-op stubs | 3 h | Pure additions to `SmMatrix.zig`. Aliases via getters/setters in JS shim. 3D fields are read-only identity. |
| **TextMetrics rest** | `actualBoundingBoxLeft/Right/Ascent/Descent`, `fontBoundingBoxAscent/Descent`, `emHeightAscent/Descent`, `hangingBaseline`, `alphabeticBaseline`, `ideographicBaseline` | 2 h | `stbtt_GetGlyphBitmapBox` already returns the per-glyph bbox; sum advance + max ascent / descent gives the run's bbox. Add fields to the TS `TextMetrics` class + a Zig helper on `SmFont`. |
| **Text v2** | kerning (`fontKerning='normal'` via `stbtt_GetGlyphKernAdvance`); CTM-aware glyph rendering (currently only translation applied — pdf.js zooms text via CTM scale); real outlined `strokeText` (extract glyph contours via `stbtt_GetGlyphShape`, feed `SmScan.strokePath`); sub-pixel positioning (`stbtt_MakeGlyphBitmapSubpixel`); `direction: 'ltr' | 'rtl'`, `letterSpacing`, `wordSpacing`, `fontKerning`, `fontStretch`, `fontVariantCaps`, `textRendering` | 1–2 days |
| **`createConicGradient(startAngle, x, y)`** | conic gradient | 2 h | New `SmGradient.conic` factory + sampler: per-pixel angle to gradient center, lookup in stops table. Rare in PDFs; nice for dashboards. |

### Performance / structural (no spec checkboxes)

Bench-driven priorities (from `npm run bench` against simdra-wasm / simdra-native / napi-skia / node-canvas):

| Item | Why (bench evidence) | Effort |
|---|---|---|
| **NEON-tuned SIMD kernels** | `opts/neon.zig` currently inherits everything from `opts/generic.zig`. Worth tuning: `blendSrcOverU32` (re-vectorize after the pdScalar refactor — fast path for opaque-dst rows would recover the ~30% perf hit; NEON `vmlal_u8` for 8-lane mul-acc; FP16 / dotprod kernels for sampler/gradient paths). The 23 new blend kernels are scalar-loop today and ripe for vectorization. | 4–8 h |
| **Tile-based scheduler** | Bench shows simdra is 30× **slower** than Skia on "100 small fillRects" — overhead-bound, not throughput-bound. Tile binning batches many small ops into few SIMD-friendly tiles. Same Blitter API; new work-distribution layer above Scan. | 1 day |
| **Reduce WASM-boundary overhead** | simdra-wasm is 2–3× simdra-native on tight workloads (per-call cost across the WASM/JS boundary). A draw-list batch API on the JS side would amortize. Open design question. | open |

### Out of scope (⛔ — unlikely to land in simdra core)

| Item | Why deferred |
|---|---|
| `toDataURL(type, quality)` | needs JPEG / WebP encoders (encoder work, not architecture) |
| `toBlob` family | needs Node `Blob` shim + the format encoders above |
| `transferControlToOffscreen()` | browser-worker transfer model; doesn't exist in Node |
| OffscreenCanvas (most methods) | mostly DOM-shaped; not on critical path |
| `captureStream()` | browser MediaStream API |
| `webglcontext*` events, HTMLElement inheritance | DOM-only |
| `filter: string` (CSS filters: blur, drop-shadow, ...) | overlaps with shadows; CSS-string parser is the biggest piece, output for blur is the same Gaussian as shadow |

### Internal cleanup (housekeeping, < 30 min)

- `Path2D.md` — `arc` / `ellipse` are implemented on SmPath (T6) but the Path2D-specific spec entries weren't ticked.
- `DOMMatrix.md` — 15 🟡 entries (m11..m44 aliases, `is2D`, `isIdentity`, etc.) are still unchecked but easy 1-h additions; promote to a proper task when DOMMatrix needs a polish pass.

---

## Path to "real HTML5" by use case

| Goal | Remaining work | Effort |
|---|---|---|
| **pdf.js end-to-end** | AA → `clip()` → stroke styles (cap/join/dash) → `createPattern` → gradient-as-fillStyle → text v2 (kerning + CTM-aware glyphs) | ~1 week |
| **Love2D-style 2D game** | already works ✅ — round caps + AA are polish | ~5 h |
| **Chart library (Chart.js / ECharts)** | gradient fills + AA → production-quality output | ~7 h |
| **Arbitrary HTML5 demos** | AA is the highest-impact 4 h; lineDash + round caps are the next 4–6 h | ~10 h |

## How to use

1. Open the relevant spec file (`CanvasRenderingContext2D.md` is the main one).
2. Pick the next 🔴 unchecked member, or pull from the post-v0.1 roadmap above.
3. Implement on the matching `zig/simdra/core/Sm*.zig` (or `effects/` / `opts/` / `utils/` per the folder mapping in `CLAUDE.md`).
4. Wrap in `src/index.ts` if it's a new HTML5 surface — **never expose Sm\* classes directly**.
5. Add a `compareScene(...)` line in `test/index.js` if it's pixel-shaped, or a `plain(...)` line if it's structural / numeric.
6. Run `npm test` (fast dev, native via node-zigar) → `npm run build && npm run test:built` (WASM smoke). Every visual scene writes `test/__output__/<label>.simdra.png`; failing scenes additionally write `<label>.napi.png` and `<label>.diff.png` automatically.
7. Tick the box in the spec and note the implementing path.

## Workflow scripts

```bash
npm test             # fast dev tests via node-zigar loader (47 visual SSIM + 73 plain)
npm run test:built   # post-build smoke test of dist/simdra.mjs (incl. text + registerFont)
npm run test:visual  # legacy jest visual-regression layer (pre-migration, 13 tests)
npm run test:all     # npm test + npm run test:visual
npm run bench        # 4-way perf: simdra-wasm / simdra-native / napi-skia / node-canvas
npm run build        # rollup-plugin-zigar → dist/simdra.mjs (WASM SIMD)
npm run typecheck    # tsc --noEmit (TS layer in src/)
```

## Out-of-scope (unlikely to ever land)

Same items flagged ⛔ in the roadmap above — kept here for cross-reference. These require capabilities beyond the simdra core (DOM, MediaStream, Blob, browser worker transfer):

- Events (`contextlost`, `contextrestored`, `webglcontext*`).
- `captureStream()`.
- `transferControlToOffscreen()` / OffscreenCanvas worker transfer.
- `toBlob()` — depends on a Node `Blob` shim plus jpeg/webp encoders.
- HTMLElement inheritance.
- `filter: string` — CSS filter parser + multi-pass effect pipeline; out of scope for v1.
