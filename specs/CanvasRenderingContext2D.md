# CanvasRenderingContext2D

MDN: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D

Largest interface in the API. simd-canvas exposes it as `CanvasRenderingContext2D` (`zig/canvas/CanvasRenderingContext2D.zig`), constructed lazily by `Canvas.getContext("2d")`.

Sections below mirror the MDN grouping. Tick a box only after the member is implemented in Zig **and** exercised in `test/index.js`.

**Numeric types.** All non-dimension parameters and properties are `f64` to match JS Number semantics (MDN's WebIDL declares them `unrestricted double`). Canvas/ImageData width and height stay `u32` (`unsigned long`). The currently-implemented rect methods (`clearRect`, `fillRect`, `strokeRect`) take `i32` in Zig today — that's an impl divergence to fix when the path API lands and we have a unified coordinate type.

Priority is set by pdf.js's `CanvasGraphics` rendering pipeline. Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Drawing rectangles

- [x] 🔴 `clearRect(x, y, w, h)` — `zig/canvas/CanvasRenderingContext2D.zig` (writes 0 / transparent black).
- [x] 🔴 `fillRect(x, y, w, h)` — SIMD via `raster.fillRectColor`.
- [x] 🔴 `strokeRect(x, y, w, h)` — composed from 4 SIMD `fillRectColor` calls.

## Drawing text

- [x] 🔴 `fillText(text, x, y, maxWidth?)` — `zig/simdra/core/SmCanvas.zig` (`drawText` + `fillText`), backed by stb_truetype via `zig/simdra/core/SmFont.zig`. HTML5 façade in `src/index.ts`. Glyph alpha rows feed `SmBlitter.blitRow` through the new partial-coverage path (`opts/*.blendSrcOverCovU32`). v1 caveats: `maxWidth` ignored; CTM only the translation component is applied to the pen (scale/rotate of the CTM are dropped on glyph rendering).
- [x] 🟡 `strokeText(text, x, y, maxWidth?)` — `src/index.ts` falls back to `fillText`; real outlined-glyph path (extract glyph contours via `stbtt_GetGlyphShape`, feed through `SmScan.strokePath`) is a follow-up.
- [x] 🔴 `measureText(text)` → `TextMetrics` — `src/index.ts` (`TextMetrics` class + `ctx.measureText`); `width` populated via `SmFont.measureWidth` (sum of scaled advance widths, no kerning yet). Other `TextMetrics` fields remain 🟡.

## Line styles

- [x] 🔴 `lineWidth: f64` — `zig/simdra/core/SmCanvas.zig` (`lineWidth: f64` field + `setLineWidth`). `SmPaint.stroke_width` widened to `f64` to match.
- [x] 🔴 `lineCap: 'butt' | 'round' | 'square'` — `zig/simdra/core/SmCanvas.zig` (field + `setLineCap`); cap topology in `zig/simdra/core/SmScan.zig` (`emitCapEdges` — butt = single edge, square = +half_w extension along tangent, round = arc fan via `emitArcFan`). HTML5 ↔ enum map in `src/index.ts` (`HTML5_TO_LINECAP`).
- [x] 🔴 `lineJoin: 'round' | 'bevel' | 'miter'` — `zig/simdra/core/SmCanvas.zig` (field + `setLineJoin`); join topology in `zig/simdra/core/SmScan.zig` (`strokePolyline` interior-vertex switch: outer side gets two outline points + bevel chamfer or arc fan; inner side keeps the miter for clean polygon topology). HTML5 ↔ enum map in `src/index.ts` (`HTML5_TO_LINEJOIN`).
- [x] 🔴 `miterLimit: f64` — `zig/simdra/core/SmCanvas.zig` (field + `setMiterLimit`); plumbed through `SmScan.strokePath` → `strokePolyline`. The default `default_miter_limit = 10.0` constant in `SmScan.zig` is gone; the value rides on ctx state.
- [x] 🔴 `getLineDash() / setLineDash(segments)` — `zig/simdra/core/SmCanvas.zig` (`line_dash_storage: SmList(f64)` + `setLineDash` validates non-finite/negative and doubles odd-length per spec). `dashAndStrokePolyline` in `zig/simdra/core/SmScan.zig` walks the polyline accumulating arc length and emits sub-polylines for each on-interval through the existing `strokePolyline`. JS layer (`src/index.ts`) packs into `Float64Array` for the Zig setter and copies the Zig slice back into a fresh `number[]` on read.
- [x] 🔴 `lineDashOffset: f64` — `zig/simdra/core/SmCanvas.zig` (`lineDashOffset` field + `setLineDashOffset`); resolved at the start of `dashAndStrokePolyline` via `@mod(offset, total_dash)` per spec wrap-around.

## Text styles

- [x] 🔴 `font: string` — `src/index.ts`. CSS font-shorthand parser handles `<style>` (`italic`/`oblique`), `<weight>` (numeric 1-1000 or keyword `bold`/`bolder`/`lighter`/`normal`), `<size>px`, optional `/<line-height>` (parsed, ignored), and a comma-separated family list; `font-variant` and `font-stretch` keywords are accepted and ignored. Family lookup goes through a multi-face registry (`Map<family, Face[]>`) populated by top-level `registerFont(bytes, family, { weight?, style? })` or the `fonts: [{ name, data, weight?, style? }]` option on `createCanvas(w, h, opts)`. When the descriptor is omitted, simdra auto-detects weight/style from `OS/2.usWeightClass` + `head.macStyle`. Selection at draw time follows CSS Fonts Module 3 §5.2 (style-tier fallback `italic > oblique > normal` etc., then the 400/500-pivot weight-distance rule). When no matching face exists simdra synthesises: 1-px horizontal alpha dilation in `SmFont.rasterizeGlyph` for faux-bold, 12° per-row shear in `SmCanvas.drawTextRun` for faux-italic. Default embedded font is Manrope (variable, ~162 KB, default instance Regular) registered against `sans-serif` / `serif` / `monospace` / `system-ui` as a single 400/normal face — bold/italic against the defaults are always faux. Variable-font axis instancing not yet wired. (SIL OFL 1.1 — see `zig/simdra/assets/LICENSE-Manrope.txt`.)
- [x] 🔴 `textAlign: 'start' | 'end' | 'left' | 'right' | 'center'` — `src/index.ts`. RTL direction not yet honored (`'start'` always means left, `'end'` always means right); revisit when `direction` lands.
- [x] 🔴 `textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom'` — `src/index.ts`, derived from `SmFont.getMetrics()`. `hanging` approximates `top`, `ideographic` approximates `bottom` (simdra has no per-script baselines yet).
- [x] 🟡 `direction: 'ltr' | 'rtl' | 'inherit'` — `src/index.ts`. `'rtl'` flips `textAlign='start'`→right and `'end'`→left in `#applyTextOffsets`. Full RTL bidi text shaping is out of scope (would need HarfBuzz).
- [x] 🟡 `letterSpacing: string` (CSS length) — `src/index.ts` round-trip via `parseCssLengthPx` (px-only); applied in `SmFont.measureWithSpacing` and `SmTextRun.shapeWithSpacing` for both `measureText` and `fillText`/`strokeText`.
- [x] 🟡 `wordSpacing: string` (CSS length) — `src/index.ts` round-trip; same plumbing as `letterSpacing`. Adds extra advance after each U+0020 (space) per CSS Text 3 §10.2.
- [x] 🟡 `fontKerning: 'auto' | 'normal' | 'none'` — `src/index.ts` round-trip; `'none'` disables, `'auto'` and `'normal'` enable. Implemented via `SmFont.kernAdvance` wrapping `stbtt_GetCodepointKernAdvance`.
- [x] 🟡 `fontStretch` — `src/index.ts` round-trip only (no font-variant infrastructure; stb_truetype offers no axis interface).
- [x] 🟡 `fontVariantCaps` — `src/index.ts` round-trip only (same constraint).
- [x] 🟡 `textRendering` — `src/index.ts` round-trip only (stb_truetype has no hinting toggle).

## Fill and stroke styles

- [x] 🟡 `fillStyle: string | CanvasGradient | CanvasPattern` — accepts CSS strings (parsed via `parseCssColor`), `CanvasGradient`, and `CanvasPattern`. Getter returns the live wrapper object after a non-string assignment, the canonical string otherwise. Per-pixel sampling routed through `SmBlitter.dispatchShader` (`zig/simdra/core/SmBlitter.zig`).
- [x] 🟡 `strokeStyle: string | CanvasGradient | CanvasPattern` — same as above.
- [x] 🔴 CSS color string parser (`#rgb`, `#rrggbb`, `rgb(...)`, `rgba(...)`, named colors, `hsl(...)`). Shared by fillStyle/strokeStyle/shadowColor/gradient stops. — `zig/simdra/utils/css_color.zig` (exposed via `parseCssColor` in `zig/simdra.zig`).

## Gradients and patterns

- [x] 🔴 `createLinearGradient(x0, y0, x1, y1)` → `CanvasGradient` — wraps `SmGradient.linear` (`zig/simdra/effects/SmGradient.zig`); per-pixel `sampleLinear` interpolates in premul-alpha space.
- [x] 🔴 `createRadialGradient(x0, y0, r0, x1, y1, r1)` → `CanvasGradient` — wraps `SmGradient.radial`; `sampleRadial` solves the two-circle quadratic.
- [x] 🟡 `createConicGradient(startAngle, x, y)` → `CanvasGradient` — `zig/simdra/effects/SmGradient.zig` (`Kind.conic` + `Geometry.Conic` + `sampleConic`). Per-pixel sampling computes `atan2(dy, dx) - startAngle`, normalizes to [0, 1] modulo 2π, and looks up the stop color. Wired into `SmBlitter.dispatchShader`. JS façade in `src/index.ts` (`createConicGradient`).
- [x] 🔴 `createPattern(image, repetition)` → `CanvasPattern` — accepts `ImageData | Canvas`; snapshots into an owned RGBA buffer in `SmPattern` (`zig/simdra/effects/SmPattern.zig`).

## Shadows

- [x] 🟡 `shadowBlur: f64` — `zig/simdra/core/SmCanvas.zig` (`shadowBlur` field + StateFrame). Sigma = blur / 2 (matches Chromium/Skia). Three-pass box blur on the shape's u8 alpha mask in `zig/simdra/opts/generic.zig` (`gaussianBlurAlpha` + `boxBlurAlphaH` + `boxBlurAlphaV`).
- [x] 🟡 `shadowColor: string` — `zig/simdra/core/SmCanvas.zig` (`shadowColor` packed RGBA u32). JS layer parses CSS via `parseCssColor`. Default transparent black; alpha=0 disables shadow rendering.
- [x] 🟡 `shadowOffsetX: f64` — `zig/simdra/core/SmCanvas.zig` (`shadowOffsetX` field + StateFrame).
- [x] 🟡 `shadowOffsetY: f64` — `zig/simdra/core/SmCanvas.zig` (`shadowOffsetY` field + StateFrame). Pipeline: `beginShadowLayer` switches `self.pixels` to a cleared scratch RGBA, forces `src_over`; the inner draw lands the shape on transparent. `endShadowLayer` extracts alpha, blurs, multiplies by `shadowColor`, composites the shadow at the offset onto the real canvas using the user's blend mode, then composites the shape on top using the same. Wired into `fill`, `stroke`, `fillRect`, `strokeRect`, `fillTriangle`, `strokeTriangle`, `fillText` family, and `drawImageScaledSub` (which `drawImageAt`/`Scaled` route through). `clearRect` and `putImageData` skip per HTML5 spec.

## Paths

- [x] 🔴 `beginPath()` — pdf.js opens every shape with this. — `zig/canvas/CanvasRenderingContext2D.zig`.
- [x] 🔴 `closePath()` — zig/canvas/CanvasRenderingContext2D.zig (pins `Opcode` enum + `subpath_open` flag for `moveTo`/`lineTo` etc.).
- [x] 🔴 `moveTo(x, y)` — `zig/canvas/CanvasRenderingContext2D.zig`. Emits `move_to` opcode + 16-byte `(f64, f64)` payload; non-finite args are silently ignored per spec; sets `subpath_open = true`.
- [x] 🔴 `lineTo(x, y)` — `zig/canvas/CanvasRenderingContext2D.zig`. Emits `line_to` opcode + 16-byte payload; non-finite args are a no-op; implicit `moveTo(x, y)` if no sub-path is open.
- [x] 🔴 `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)` — `zig/canvas/CanvasRenderingContext2D.zig`. Emits `bezier_to` opcode + 48-byte payload; non-finite args are a no-op; implicit `moveTo(cp1x, cp1y)` if no sub-path is open.
- [x] 🔴 `quadraticCurveTo(cpx, cpy, x, y)` — `zig/canvas/CanvasRenderingContext2D.zig`. Emits `quad_to` opcode + 32-byte payload; non-finite args are a no-op; implicit `moveTo(cpx, cpy)` if no sub-path is open.
- [x] 🟡 `arc(x, y, radius, startAngle, endAngle, counterclockwise?)` — `SmCanvas.arc` (CTM-aware) + `SmPath.arc` (Path2D). Flattens to line segments at append time using a chord-tolerance segment count (`arcSegmentCount` in `SmPath`, 0.25-px target). HTML5 sweep normalization + ccw direction handled. JS shim defaults `counterclockwise` to false.
- [x] 🟡 `arcTo(x1, y1, x2, y2, radius)` — `zig/simdra/core/SmCanvas.zig` (`arcTo`) + `zig/simdra/core/SmPath.zig` (`arcTo` instance method). SmPath now tracks `current_point` + `last_move_point` so `arcTo` can use the previous endpoint as P0 per spec. SmCanvas computes the tangent geometry in user-space (inverse-transforming `path.current_point`) so non-uniform CTMs deform the arc consistently with `arc()`. JS façade in `src/index.ts` on both `CanvasRenderingContext2D` and `Path2D`; throws `IndexSizeError` on negative radius.
- [x] 🟡 `ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise?)` — `SmCanvas.ellipse` + `SmPath.ellipse`. Same flattening as arc; rotation pre-applied per generated point before CTM.
- [x] 🔴 `rect(x, y, w, h)` — pdf.js page clipping. — `zig/canvas/CanvasRenderingContext2D.zig` (delegates to `Path.rect`).
- [x] 🟡 `roundRect(x, y, w, h, radii)` — `zig/simdra/core/SmCanvas.zig` (`roundRect`) + `zig/simdra/core/SmPath.zig` (`roundRect` instance method). Each corner is a quarter-arc through the existing `arc()` flattening. JS layer (`src/index.ts`) normalizes the polymorphic `radii` argument (number, DOMPointInit, or 1–4-element array of either) into 4 scalar radii; throws RangeError on negative values; the array length 1/2/3/4 maps per CSS shorthand pattern (1 → all four, 2 → tl=br + tr=bl, 3 → tl + tr=bl + br, 4 → tl/tr/br/bl). Negative w/h flip orientation per spec.

## Drawing paths

- [x] 🟡 `fill()` / `fill(fillRule)` / `fill(path)` / `fill(path, fillRule)` — `SmCanvas.fill` + `SmCanvas.fillPathExternal` → `SmScan.fillPath` → AET scanline with `FillRule` parameter (nonzero or evenodd). Béziers flattened via recursive de Casteljau (0.25-px chord tolerance). No AA yet (analytic edge coverage is a follow-up). HTML5 façade in `src/index.ts` dispatches all four overloads.
- [x] 🟡 `stroke()` / `stroke(path)` — `SmCanvas.stroke` + `SmCanvas.strokePathExternal` → `SmScan.strokePath` → polygon inflation with the configured `lineCap` (butt/round/square via `emitCapEdges`), `lineJoin` (miter/bevel/round via the interior-vertex switch in `strokePolyline`), and `miterLimit` (drives the bevel fallback in the miter branch). Optional dash pattern routed through `dashAndStrokePolyline`. Béziers flatten via `flattenQuadPoints` / `flattenCubicPoints`.
- [x] 🔴 `clip(fillRule?)` / `clip(path, fillRule?)` — `zig/simdra/core/SmCanvas.zig` (`clip_mask: ?[]u8` field, `clip()` and `clipPath()` methods). The new path is rasterized into a fresh u8 mask via `SmScan.fillPathToCoverage` (which reuses `sweepEdgesToMask`), then per-pixel min-merged with the existing mask (clip is monotonic). `SmBlitter.blitRow` AND's the per-row clip slice with coverage before dispatch — same coverage parameter that AA edges and glyph alpha already use, no new code path. Drawing primitives that don't go through `blitRow` (the `drawImage` family) snapshot the dst row before the SIMD sampler runs and restore the clipped-out pixels afterward. `putImageData` bypasses clip per HTML5 spec. `save()` / `restore()` deep-copy the mask in `StateFrame.clipMask`. JS façade in `src/index.ts` dispatches `clip(rule?)` and `clip(path, rule?)`.
- [x] 🟡 `isPointInPath(x, y, fillRule?)` / `isPointInPath(path, x, y, fillRule?)` — `zig/simdra/core/SmCanvas.zig` (`isPointInPath` / `isPointInPathExternal`). Reuses `SmScan.flattenPathToFillEdges` (extracted from `fillPath`) + new `SmScan.pointInEdges` (winding-number test with the requested `FillRule`). For external Path2D, the query point is inverse-CTM'd back into path-space first.
- [x] 🟡 `isPointInStroke(x, y)` / `isPointInStroke(path, x, y)` — `zig/simdra/core/SmCanvas.zig` (`isPointInStroke` / `isPointInStrokeExternal`). Reuses the new `SmScan.flattenPathToStrokeEdges` (extracted from `strokePath`) to build the inflated outline polygon, then runs `pointInEdges` with nonzero winding (matching the renderer's polygon orientation).

### Non-spec convenience (will revisit once paths land)

- [x] 🟡 `fillTriangle(x0, y0, x1, y1, x2, y2)` — scanline fill, `zig/canvas/CanvasRenderingContext2D.zig`.
- [x] 🟡 `strokeTriangle(...)` — currently fills with stroke color; replace with thick polyline once `stroke()` exists.

## Transformations

- [x] 🔴 `getTransform()` → returns SmMatrix value (Zig) / DOMMatrix proxy (JS). `zig/simdra/core/SmCanvas.zig`.
- [x] 🔴 `setTransform(a, b, c, d, e, f)` — replaces CTM. `zig/simdra/core/SmCanvas.zig`. (DOMMatrix-arg form deferred.)
- [x] 🔴 `resetTransform()` — resets to identity. `zig/simdra/core/SmCanvas.zig`.
- [x] 🔴 `transform(a, b, c, d, e, f)` — post-multiplies CTM. `zig/simdra/core/SmCanvas.zig`.
- [x] 🔴 `translate(x, y)` — `zig/simdra/core/SmCanvas.zig`.
- [x] 🔴 `rotate(angle)` — radians per spec; `zig/simdra/core/SmCanvas.zig`.
- [x] 🔴 `scale(x, y)` — `zig/simdra/core/SmCanvas.zig`.

## Compositing

- [x] 🔴 `globalAlpha: f64` (0..1) — wraps Zig `alpha: u8` on `SmCanvas`. JS getter/setter in `src/index.ts` does float ↔ u8 mapping. Pre-multiplied into source-color alpha when paints are constructed in fillRect/strokeRect/etc.
- [x] 🟡 `globalCompositeOperation: string` — partial: `'source-over'`, `'lighter'`, `'copy'` wired to Zig `BlendMode` enum + matching SIMD kernels (`fillU32`, `blendSrcOverU32`, `blendAddU32`). Full HTML5 set (`multiply`, `screen`, `overlay`, `destination-*`, etc.) to follow as separate kernels are added — same dispatch table.

## Image smoothing

- [x] 🟡 `imageSmoothingEnabled: bool` — `src/index.ts` + `zig/simdra/core/SmCanvas.zig` (`imageSmoothingEnabled` field + StateFrame capture). Toggles between `simd.sampleImageNearestRow` and `simd.sampleImageBilinearRow` (new in `zig/simdra/opts/generic.zig`) inside `drawImageScaledSub`. Default true (HTML5 spec).
- [x] 🟡 `imageSmoothingQuality: 'low' | 'medium' | 'high'` — `src/index.ts` + `zig/simdra/core/SmCanvas.zig` (`imageSmoothingQuality` u8 field + StateFrame capture). Encoded 0/1/2; quality is advisory and currently always uses bilinear. Higher-order kernels (Mitchell-Netravali, etc.) reserved for follow-up.

## Filters

- [x] 🟡 `filter: string` — `src/index.ts` (`parseCssFilter`) parses CSS-filter syntax for `blur(<len>)`, `brightness(<pct|num>)`, `contrast(<pct|num>)`. Other filter functions parse OK but are no-ops at render time. Parsed chain feeds `SmCanvas.setFilterChain` (`filter_verbs` + `filter_params` SmLists, deep-copied in StateFrame). Rendering: `beginFilterLayer` switches `self.pixels` to `filter_scratch`; the inner draw lands the shape on transparent; `endFilterLayer` walks the chain — `simd.gaussianBlurU32` / `simd.brightnessU32` / `simd.contrastU32` (all in `zig/simdra/opts/generic.zig`) — then composites the result onto the real canvas using the user's blend mode. Filter wraps shadow + composite layers, so shadows render through the filter chain too.

## Drawing images

- [x] 🔴 `drawImage(image, dx, dy)` — `SmCanvas.drawImageAt`. Nearest-neighbor sampling via `simd.sampleImageNearestRow` (vector inv-transform fma + scalar gather). Respects CTM. Source: `ImageData` (rgba_unorm8 SmBitmap) or another simdra `Canvas` (snapshotted via `getImageData`).
- [x] 🔴 `drawImage(image, dx, dy, dw, dh)` — `SmCanvas.drawImageScaled`.
- [x] 🔴 `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)` — `SmCanvas.drawImageScaledSub`. Source rect bounds-checked at sample time so rotated CTM (when path-fill arrives) won't spill outside the parallelogram. Bilinear filtering and Blitter-integrated globalAlpha/blend land as follow-up kernels.

## Pixel manipulation

- [x] 🔴 `createImageData(width, height, settings?)` — wrapper in `src/index.ts`, returns a JS ImageData holding a Zig SmBitmap. Also accepts an existing ImageData per spec (copy dims + settings).
- [x] 🟡 `createImageData(imagedata)` — copy constructor; `src/index.ts` (overload branch on `arg1 instanceof ImageData` constructs a fresh transparent-black ImageData with matching dims + colorSpace + pixelFormat per HTML5 spec).
- [x] 🔴 `getImageData(sx, sy, sw, sh)` — `zig/canvas/CanvasRenderingContext2D.zig`.
- [x] 🔴 `getImageData(sx, sy, sw, sh, settings)` — exposed as `getImageDataSettings`.
- [x] 🔴 `putImageData(imagedata, dx, dy)` — `SmCanvas.writePixels` (Skia naming). Per-row `simd.copyU32`. Bypasses CTM / globalAlpha / blend per HTML5 spec. JS shim in `src/index.ts` dispatches the 3-arg / 7-arg overload. Currently `rgba_unorm8` only — float16 needs the symmetric `copyFloat16NormToU32` SIMD kernel.
- [x] 🟡 `putImageData(imagedata, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)` — `SmCanvas.writePixelsDirty`. Negative dirty dims reflect; rect clipped to bitmap + canvas bounds silently.

## Context state

- [x] 🔴 `save()` / `restore()` — captures transform + fillStyle/strokeStyle/lineWidth + alpha + blendMode. `zig/simdra/core/SmCanvas.zig` (StateStack). Future state (clip mask, line caps/joins, lineDash) lands in StateFrame as it arrives.
- [x] 🟡 `reset()` — `zig/simdra/core/SmCanvas.zig` (`reset` method) drains the save stack, frees clip-mask + lineDash storage, resets every state field to its struct default, clears `path`, and zeroes the surface pixels via `simd.fillU32`. JS layer (`src/index.ts`) also resets the JS-side mirror state (font, textAlign, fillStyle string, etc.).
- [ ] ⛔ `isContextLost()` — Node has no context-loss model.
- [x] 🟡 `getContextAttributes()` — `src/index.ts`. Returns `{alpha:true, colorSpace:'srgb', desynchronized:false, willReadFrequently:false}` (static — context-creation attributes aren't actually configurable yet).
- [x] 🟡 `canvas` back-reference property — `src/index.ts`. The `CanvasRenderingContext2D` constructor now takes the owning `Canvas` and exposes it via the `canvas` getter.

## Focus management

- ⛔ `drawFocusIfNeeded(element)` — DOM-only.
- ⛔ `scrollPathIntoView(path?)` — DOM-only.

## Non-spec extensions

- `setFillStyle(r, g, b, a)` — temporary until CSS color string parser lands.
- `setStrokeStyle(r, g, b, a)` — same.
- `setLineWidth(w)` — same.
- `releaseImageData(image_data)` — manual buffer free; node-zigar does not GC Zig allocations.
