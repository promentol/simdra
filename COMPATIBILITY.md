# Browser Canvas ↔ simdra compatibility

Side-by-side coverage of the HTML5 Canvas WebIDL surface, comparing what every
modern browser ships against what simdra implements today. Source of truth is
each spec file under `specs/`; this is a flat, scannable rollup.

**Legend**

| Mark | Meaning |
|------|---------|
| ✅ | Fully implemented per spec |
| 🟡 | Partial / accepted-but-different / spec divergence (see notes) |
| ❌ | Not implemented yet (planned) |
| ⛔ | Out of scope (DOM / Blob / MediaStream / encoder dependencies) |

## Summary

| Class | Browser | simdra | Headline gap |
|---|---|---|---|
| HTMLCanvasElement (`Canvas`) | ✅ | 🟡 | `toBlob` needs Node `Blob` shim; WebP encoder missing (no stb path); JPEG done via stb_image_write |
| CanvasRenderingContext2D | ✅ | ✅ | — |
| ImageData | ✅ | ✅ | Exposes `Uint8Array` instead of `Uint8ClampedArray`; `colorSpace` informational only |
| Path2D | ✅ | 🟡 | `Path2D(d)` SVG ctor; `arc` / `arcTo` / `ellipse` / `roundRect` on Path2D |
| DOMMatrix | ✅ | 🟡 | `setMatrixValue(transformList)` + string-form ctor (CSS parser out of scope) |
| CanvasGradient | ✅ | 🟡 | `createConicGradient` |
| CanvasPattern | ✅ | ✅ | — |
| TextMetrics | ✅ | 🟡 | Only `width` populated; bbox / baseline fields not implemented |
| OffscreenCanvas | ✅ | ❌ | Whole interface unimplemented (low priority — Node has no worker transfer) |

---

## HTMLCanvasElement (exported as `Canvas`)

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `width` | ✅ | ✅ | Read/write; assignment reallocates the bitmap (transparent black) and resets ctx state per spec |
| `height` | ✅ | ✅ | Same as `width` |
| `getContext('2d')` | ✅ | ✅ | Caches on first call; only `'2d'` supported |
| `getContext(type, attrs)` | ✅ | 🟡 | Attributes accepted and ignored |
| `toDataURL()` | ✅ | ✅ | Emits `image/png` |
| `toDataURL(type)` | ✅ | 🟡 | Recognizes `image/png` and `image/jpeg`; falls back to png for unrecognized types |
| `toDataURL(type, quality)` | ✅ | 🟡 | PNG + JPEG via stb_image_write; WebP still ⛔ (no stb path) |
| `toBlob(...)` | ✅ | ⛔ | Needs Node `Blob` shim; encode primitives are in place via `Canvas.toBytes(type, quality)` |
| `transferControlToOffscreen()` | ✅ | ⛔ | Browser worker transfer model |
| `captureStream()` | ✅ | ⛔ | MediaStream API |
| Event listeners (`contextlost`, …) | ✅ | ⛔ | DOM-only |

### simdra extensions (non-spec)

| Member | Notes |
|---|---|
| `createCanvas(w, h, { fonts: [{ name, data, weight?, style? }] })` | Optional 3rd arg; `data` is prefetched TTF/OTF bytes (`ArrayBuffer` / `ArrayBufferView` / Node `Buffer`). Each entry registers a face under that family; pass `weight` (number 1-1000 or `bold`/`normal`) and `style` (`normal` / `italic` / `oblique`) to pin the face explicitly. When omitted, simdra reads `OS/2.usWeightClass` and `head.macStyle` from the font bytes. WOFF / WOFF2 not decoded. |
| `registerFont(bytes, family, descriptor?)` (top-level) | Equivalent of the above as a free function — call any time before `ctx.fillText`. Same byte-shape and descriptor acceptance. Mirrors node-canvas / @napi-rs/canvas. Multiple calls with the same family + different descriptors register multiple faces; CSS Fonts Module 3 §5.2 face matching picks the closest at lookup time. |
| Default embedded font | Manrope variable (~162 KB, default instance Regular, SIL OFL 1.1). Backs `sans-serif` / `serif` / `monospace` / `system-ui` as a single 400/normal face — bold and italic against the defaults are always faux-synthesised. Variable-axis (`wght` / `wdth`) instancing is not yet wired. |
| `Canvas.toBytes(type?, quality?)` | Same dispatch as `toDataURL` but skips the base64 round-trip. `type` defaults to `'image/png'`; `'image/jpeg'` accepts an optional `quality` in HTML5 0.0–1.0. |
| `Image` (`Image.fromBytes(bytes)`) | Decoded image source for `drawImage` / `createPattern`. Backed by stb_image (PNG / JPEG / BMP / GIF first frame). Browser-shaped helper but not the spec's HTMLImageElement (no `src` / `onload`; bytes go in synchronously). |
| `microsharp` named export (`import { microsharp } from 'simdra'`) | Sharp-shaped fluent image-processing surface on the same Zig core. Accepts `Uint8Array` / `ArrayBuffer` / `Blob` / `ReadableStream<Uint8Array>` / `Response` (Workers idiom: `microsharp(req.body).jpeg(0.8).toBuffer()`). v0 ships decode / encode round-trip + `metadata()`; `resize()` / `rotate()` / etc. are stubs throwing `not implemented`. |

---

## CanvasRenderingContext2D

### Drawing rectangles

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `clearRect(x, y, w, h)` | ✅ | ✅ | |
| `fillRect(x, y, w, h)` | ✅ | ✅ | SIMD via `raster.fillRectColor` |
| `strokeRect(x, y, w, h)` | ✅ | ✅ | |

### Drawing text

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `fillText(text, x, y, maxWidth?)` | ✅ | 🟡 | `maxWidth` ignored; CTM scale/rotate dropped on glyphs (only translation applied) |
| `strokeText(...)` | ✅ | 🟡 | Falls back to `fillText` (no outlined-glyph stroke yet) |
| `measureText(text)` | ✅ | 🟡 | Returns TextMetrics with `width` only |

### Line styles

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `lineWidth` | ✅ | ✅ | f64 |
| `lineCap` | ✅ | ✅ | `butt` / `round` / `square` |
| `lineJoin` | ✅ | ✅ | `miter` / `bevel` / `round` (outer-side topology + inner miter) |
| `miterLimit` | ✅ | ✅ | Default `10`; sub-limit angles fall back to bevel |
| `getLineDash()` / `setLineDash()` | ✅ | ✅ | Odd-length arrays doubled per spec; non-finite/negative entries ignored |
| `lineDashOffset` | ✅ | ✅ | Wrapped modulo total dash length |

### Text styles

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `font` | ✅ | 🟡 | CSS shorthand parser handles `<style>`, `<weight>` (numeric or keyword), `<size>px`, optional `/<line-height>` (ignored), and a comma-separated family list. Bold/italic resolve to a registered face when one matches; otherwise simdra synthesises bold (1-px alpha dilation) and italic (12° per-row shear). `font-variant` / `font-stretch` parse but don't affect output. |
| `textAlign` | ✅ | 🟡 | RTL not honored — `start`/`end` always map to left/right |
| `textBaseline` | ✅ | 🟡 | `hanging` ≈ `top`, `ideographic` ≈ `bottom` (no per-script baselines) |
| `direction` | ✅ | ❌ | |
| `letterSpacing` | ✅ | ❌ | |
| `wordSpacing` | ✅ | ❌ | |
| `fontKerning` | ✅ | ❌ | |
| `fontStretch` | ✅ | ❌ | |
| `fontVariantCaps` | ✅ | ❌ | |
| `textRendering` | ✅ | ❌ | |

### Fill and stroke styles

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `fillStyle` (CSS string / Gradient / Pattern) | ✅ | ✅ | |
| `strokeStyle` (CSS string / Gradient / Pattern) | ✅ | ✅ | |
| CSS color parser | ✅ | ✅ | `#rgb`, `#rrggbb`, `rgb(...)`, `rgba(...)`, `hsl(...)`, named colors |

### Gradients and patterns

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `createLinearGradient(x0, y0, x1, y1)` | ✅ | ✅ | |
| `createRadialGradient(x0, y0, r0, x1, y1, r1)` | ✅ | ✅ | |
| `createConicGradient(startAngle, x, y)` | ✅ | ❌ | |
| `createPattern(image, repetition)` | ✅ | ✅ | Accepts `ImageData | Canvas`; HTMLImageElement / Blob / URL out of scope |

### Shadows

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `shadowBlur` | ✅ | ❌ | |
| `shadowColor` | ✅ | ❌ | |
| `shadowOffsetX` / `shadowOffsetY` | ✅ | ❌ | |

### Paths

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `beginPath()` | ✅ | ✅ | |
| `closePath()` | ✅ | ✅ | |
| `moveTo(x, y)` | ✅ | ✅ | |
| `lineTo(x, y)` | ✅ | ✅ | |
| `bezierCurveTo(...)` | ✅ | ✅ | |
| `quadraticCurveTo(...)` | ✅ | ✅ | |
| `arc(x, y, r, a0, a1, ccw?)` | ✅ | ✅ | Flattened to line segments at append time |
| `arcTo(x1, y1, x2, y2, r)` | ✅ | ❌ | |
| `ellipse(...)` | ✅ | ✅ | |
| `rect(x, y, w, h)` | ✅ | ✅ | |
| `roundRect(x, y, w, h, radii)` | ✅ | ❌ | |

### Drawing paths

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `fill()` / `fill(rule)` / `fill(path)` / `fill(path, rule)` | ✅ | ✅ | Nonzero + evenodd; AA via 8× Y-supersample + analytic-X partial coverage in `SmScan.sweepEdges` |
| `stroke()` / `stroke(path)` | ✅ | ✅ | Honors `lineCap`, `lineJoin`, `miterLimit`, `setLineDash`, `lineDashOffset` |
| `clip(rule?)` / `clip(path, rule?)` | ✅ | ✅ | Per-pixel u8 mask with AA on curved boundaries; intersected with prior region multiplicatively (`(a * b + 127) / 255`). `drawImage` / `clearRect` honor clip; `putImageData` bypasses per spec |
| `isPointInPath(...)` | ✅ | ❌ | |
| `isPointInStroke(...)` | ✅ | ❌ | |

### Transformations

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `getTransform()` | ✅ | ✅ | Returns DOMMatrix |
| `setTransform(a, b, c, d, e, f)` | ✅ | ✅ | DOMMatrix-arg form not yet wired |
| `resetTransform()` | ✅ | ✅ | |
| `transform(a, b, c, d, e, f)` | ✅ | ✅ | |
| `translate(x, y)` | ✅ | ✅ | |
| `rotate(angleRadians)` | ✅ | ✅ | |
| `scale(sx, sy)` | ✅ | ✅ | |

### Compositing

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `globalAlpha` | ✅ | ✅ | |
| `globalCompositeOperation` | ✅ | ✅ | All 26 modes (11 Porter-Duff + 11 separable + 4 HSL) |

### Image smoothing

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `imageSmoothingEnabled` | ✅ | ❌ | Always nearest-neighbor today |
| `imageSmoothingQuality` | ✅ | ❌ | |

### Filters

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `filter` (CSS) | ✅ | ⛔ | CSS filter parser + multi-pass effect pipeline |

### Drawing images

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `drawImage(image, dx, dy)` | ✅ | 🟡 | Source: `ImageData | Canvas`. Honors `globalCompositeOperation` + `globalAlpha` (samples into row scratch → `SmBlitter.blitRowFromSource`; non-row-friendly modes go through the layer-composite scratch). |
| `drawImage(image, dx, dy, dw, dh)` | ✅ | 🟡 | Same |
| `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)` | ✅ | 🟡 | Same |

### Pixel manipulation

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `createImageData(w, h, settings?)` | ✅ | ✅ | |
| `createImageData(imagedata)` | ✅ | ✅ | |
| `getImageData(sx, sy, sw, sh)` | ✅ | ✅ | |
| `getImageData(sx, sy, sw, sh, settings)` | ✅ | ✅ | |
| `putImageData(imagedata, dx, dy)` | ✅ | ✅ | |
| `putImageData(imagedata, dx, dy, dx, dy, dw, dh)` | ✅ | 🟡 | `rgba_unorm8` only (float16 needs symmetric copy kernel) |

### Context state

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `save()` / `restore()` | ✅ | ✅ | Captures transform + styles + alpha + blendMode |
| `reset()` | ✅ | ❌ | |
| `isContextLost()` | ✅ | ⛔ | Node has no context-loss model |
| `getContextAttributes()` | ✅ | ❌ | |
| `canvas` back-reference | ✅ | ❌ | |

### Focus management

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `drawFocusIfNeeded(elem)` | ✅ | ⛔ | DOM-only |
| `scrollPathIntoView(path?)` | ✅ | ⛔ | DOM-only |

---

## ImageData

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `new ImageData(w, h, settings?)` | ✅ | ✅ | |
| `new ImageData(data, w, h?, settings?)` | ✅ | ✅ | |
| `data` | ✅ | 🟡 | `Uint8Array` (spec wants `Uint8ClampedArray`) |
| `width` | ✅ | ✅ | |
| `height` | ✅ | ✅ | |
| `colorSpace` | ✅ | 🟡 | Value preserved; sRGB↔P3 transform not performed |
| `pixelFormat` | ✅ | ✅ | `'rgba-unorm8' | 'rgba-float16'` |

---

## Path2D

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `new Path2D()` | ✅ | ✅ | |
| `new Path2D(other)` | ✅ | ✅ | |
| `new Path2D(d)` (SVG path data) | ✅ | ❌ | |
| `addPath(path, transform?)` | ✅ | ✅ | |
| `closePath()` | ✅ | ✅ | |
| `moveTo(x, y)` | ✅ | ✅ | |
| `lineTo(x, y)` | ✅ | ✅ | |
| `bezierCurveTo(...)` | ✅ | ✅ | |
| `quadraticCurveTo(...)` | ✅ | ✅ | |
| `rect(x, y, w, h)` | ✅ | ✅ | |
| `arc(...)` | ✅ | ❌ | Available on `ctx`, not yet on Path2D |
| `arcTo(...)` | ✅ | ❌ | |
| `ellipse(...)` | ✅ | ❌ | Same as arc |
| `roundRect(...)` | ✅ | ❌ | |

---

## DOMMatrix (2D subset)

simdra stores only the 6-element 2D affine form. 3D-only fields are
identity-valued read-only; 3D-only methods either restrict to their 2D
sub-domain or throw.

### Constructors

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `new DOMMatrix()` | ✅ | ✅ | |
| `new DOMMatrix([a..f])` (6) | ✅ | ✅ | |
| `new DOMMatrix([m11..m44])` (16) | ✅ | 🟡 | Validates 3D positions are at identity |
| `new DOMMatrix(transformString)` | ✅ | ❌ | CSS transform-list parser deferred |

### Properties

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `a, b, c, d, e, f` | ✅ | ✅ | |
| `m11, m12, m21, m22, m41, m42` | ✅ | ✅ | Aliases of a..f |
| `m13, m14, m23, m24, m31, m32, m34, m43` | ✅ | 🟡 | Read-only `0` |
| `m33, m44` | ✅ | 🟡 | Read-only `1` |
| `is2D` | ✅ | 🟡 | Always `true` |
| `isIdentity` | ✅ | ✅ | |

### Mutating methods

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `multiplySelf(other)` | ✅ | ✅ | |
| `preMultiplySelf(other)` | ✅ | ✅ | |
| `translateSelf(tx, ty)` | ✅ | 🟡 | `tz` arg dropped (positional binding) |
| `scaleSelf(sx, sy)` | ✅ | 🟡 | Origin args + `sz` dropped |
| `rotateSelf(angleDeg)` | ✅ | ✅ | |
| `rotateFromVectorSelf(x, y)` | ✅ | ✅ | |
| `rotateAxisAngleSelf(x, y, z, angle)` | ✅ | 🟡 | Throws unless axis is `(0, 0, +z)` |
| `scale3dSelf(scale, ox?, oy?, oz?)` | ✅ | 🟡 | Throws if `originZ ≠ 0` |
| `skewXSelf(angle)` | ✅ | ✅ | |
| `skewYSelf(angle)` | ✅ | ✅ | |
| `invertSelf()` | ✅ | ✅ | NaNs all components when det ≈ 0 (per MDN) |
| `setMatrixValue(transformList)` | ✅ | ❌ | CSS transform-list parser deferred |

### Static methods

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `DOMMatrix.fromFloat32Array(arr)` | ✅ | ✅ | 6- or 16-element forms |
| `DOMMatrix.fromFloat64Array(arr)` | ✅ | ✅ | 6- or 16-element forms |
| `DOMMatrix.fromMatrix(other)` | ✅ | ✅ | Accepts `DOMMatrix | DOMMatrix2DInit` |

---

## CanvasGradient

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `addColorStop(offset, color)` | ✅ | ✅ | Throws `IndexSizeError` outside `[0,1]`; `SyntaxError` on bad color |
| Linear sampler | ✅ | ✅ | Premul-alpha lerp |
| Radial sampler | ✅ | ✅ | Two-circle quadratic |
| Conic sampler | ✅ | ❌ | |

---

## CanvasPattern

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `setTransform(matrix)` | ✅ | ✅ | Accepts `DOMMatrix | DOMMatrix2DInit` |
| `createPattern(image, repetition)` | ✅ | 🟡 | Accepts `ImageData | Canvas`; HTMLImageElement / Blob / URL not supported |
| Repetition: `repeat`, `repeat-x`, `repeat-y`, `no-repeat` | ✅ | ✅ | |

---

## TextMetrics

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `width` | ✅ | ✅ | |
| `actualBoundingBoxLeft` | ✅ | ❌ | |
| `actualBoundingBoxRight` | ✅ | ❌ | |
| `actualBoundingBoxAscent` | ✅ | ❌ | |
| `actualBoundingBoxDescent` | ✅ | ❌ | |
| `fontBoundingBoxAscent` | ✅ | ❌ | |
| `fontBoundingBoxDescent` | ✅ | ❌ | |
| `emHeightAscent` / `emHeightDescent` | ✅ | ❌ | |
| `hangingBaseline` | ✅ | ❌ | |
| `alphabeticBaseline` | ✅ | ❌ | |
| `ideographicBaseline` | ✅ | ❌ | |

---

## OffscreenCanvas

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `new OffscreenCanvas(w, h)` | ✅ | ❌ | |
| `width` / `height` | ✅ | ❌ | |
| `getContext(type, attrs?)` | ✅ | ❌ | |
| `convertToBlob(opts?)` | ✅ | ⛔ | Needs Blob shim + encoders |
| `transferToImageBitmap()` | ✅ | ⛔ | Needs ImageBitmap |
| Worker `postMessage` transfer | ✅ | ⛔ | Node `worker_threads` model differs |

---

## microsharp (sharp-shaped binding)

Tracks parity against the [sharp](https://sharp.pixelplumbing.com/) npm
package. Coverage is non-spec — sharp itself isn't a W3C surface — but
the same legend (✅ / 🟡 / ❌ / ⛔) applies. v0 is intentionally narrower
than sharp; encoder-side gaps are gated by what stb_image_write supports
(see `src/microsharp/index.ts` header for the full v0 contract).

### Colour manipulation

| Member | sharp | microsharp | Notes |
|---|---|---|---|
| `tint(colour)` | ✅ | 🟡 | Scaled-luma approximation: `out_C = L · tint_C / 255` per channel, α preserved. Sharp's libvips implementation does the shaping in LAB space — monochrome shape is correct, chroma differs slightly. Accepts CSS strings (via `parseCssColor`) and `{ r, g, b, alpha? }` objects (the `alpha` is parsed but ignored — sharp's tint is RGB-only). |
| `greyscale([on])` | ✅ | 🟡 | Rec.601 luma in 8-bit sRGB space; `R=G=B=L`, α preserved. Sharp's docs flag the op as "linear" and recommend `gamma()` for sRGB input — simdra has no `gamma()` op yet, so the conversion stays in the only space the pipeline has. `on=false` is a no-op (sharp parity). Output buffer remains 4-channel for pipeline-shape invariance. |
| `grayscale([on])` | ✅ | 🟡 | Alias of `greyscale`. |
| `pipelineColourspace([cs])` | ✅ | 🟡 | Every documented libvips colourspace name is accepted (`srgb`, `rgb`, `multiband`, `b-w`, `histogram`, `xyz`, `lab`, `cmyk`, `labq`, `cmc`, `lch`, `labs`, `yxy`, `fourier`, `rgb16`, `grey16`, `matrix`, `scrgb`, `hsv`, `last`). `b-w` and `grey16` inject a leading greyscale at apply time; everything else is an 8-bit-sRGB passthrough no-op because simdra has no 16-bit / LAB / CMYK pipeline. Unrecognised strings throw `RangeError`. |
| `pipelineColorspace([cs])` | ✅ | 🟡 | Alias of `pipelineColourspace`. |
| `toColourspace([cs])` | ✅ | 🟡 | Same accepted vocabulary. `b-w` / `grey16` triggers a tail greyscale; other recognised values are passthrough no-ops; output is always 8-bit RGBA sRGB. Unrecognised strings throw `RangeError`. |
| `toColorspace([cs])` | ✅ | 🟡 | Alias of `toColourspace`. |

### Image operations

Phase 1 (geometric + EXIF orientation). Convolution / morphology / tone /
histogram / HSV land in subsequent phases.

| Member | sharp | microsharp | Notes |
|---|---|---|---|
| `rotate(angle, [opts])` | ✅ | 🟡 | Multiples of 90° (incl. negative / out-of-range angles, normalised to `[0, 360)`) are byte-exact lossless permutations. Other angles sample through the existing bilinear row kernel against the source-bbox AABB; the gap is padded with `opts.background` (default `#000000`). Multi-page input is not supported — simdra decodes one frame. Sharp's "only one rotation per pipeline" semantics are not enforced (each `rotate()` records a fresh op; if you call it twice the second runs after the first). |
| `rotate()` (no args) | ✅ | 🟡 | Aliases `autoOrient()` for sharp back-compat. |
| `autoOrient()` | ✅ | 🟡 | EXIF Orientation tag (1..8) only. Read by a custom parser in `decode/exif.zig` covering JPEG APP1 (`Exif\0\0`) and PNG `eXIf` chunks; other containers / ICC / XMP-orientation are not consulted. Missing / malformed EXIF → no-op. |
| `flip([on])` | ✅ | ✅ | Vertical mirror (top↔bottom). `on=false` records nothing (sharp parity). |
| `flop([on])` | ✅ | ✅ | Horizontal mirror (left↔right). |
| `affine(matrix, [opts])` | ✅ | 🟡 | Accepts `[a, b, c, d]` and `[[a, b], [c, d]]` matrix shapes plus `idx` / `idy` / `odx` / `ody` offsets. Output dim = forward-mapped AABB of the source. `interpolator` accepts sharp's vocabulary: `nearest` and `bilinear` map directly; `bicubic` / `nohalo` / `lbb` / `vsqbs` collapse to `bilinear` (libvips's high-precision resamplers we don't ship). Singular matrix (det=0) throws `RangeError`. |
| `blur([opts])` | ✅ | 🟡 | No-args / `true` → fast 3×3 box blur. `false` → no-op (sharp parity). Bare `sigma` number → separable Gaussian. `{ sigma, precision, minAmplitude }` accepts `precision` ∈ `'integer' | 'float' | 'approximate'` and `minAmplitude` ∈ (0, 1). The `'integer'` and `'float'` paths share a single `f64`-domain separable Gaussian; the divergence between them is < 1 LSB at 8-bit output and not worth two implementations. `'approximate'` reuses the existing 3-pass box (Wells '86) ≈ Gaussian. |
| `sharpen([opts], [flat], [jagged])` | ✅ | 🟡 | No-args → 3×3 unsharp-mask kernel `[[0,-1,0],[-1,5,-1],[0,-1,0]]` (per-channel, fast). With `{ sigma, m1, m2, x1, y2, y3 }` runs the libvips USM piecewise-gain formula in **8-bit sRGB per RGB channel**; sharp's libvips path operates on the L channel of LAB, which simdra has no pipeline for. Visible result is similar at moderate sigma but can colour-shift on saturated edges. Deprecated 2-positional `sharpen(sigma, flat, jagged)` form is accepted (maps to `m1`/`m2`). |
| `convolve(kernel)` | ✅ | ✅ | Generic `width × height` kernel (both must be odd). `scale` defaults to the sum of kernel values (or 1 when the sum is 0, e.g. derivative kernels like Sobel). Edge mode is **clamp** (libvips's default). Operates on R/G/B per channel; α preserved. |
| `median([size])` | ✅ | ✅ | Square `size × size` median per RGB channel; α preserved. `size` defaults to 3 and must be odd. Implementation is per-pixel sort over the window — fine for typical sharp use (`size ≤ 7`); larger windows are accepted up to 99 but get expensive. |
| `dilate([width])` | ✅ | 🟡 | Foreground expansion via separable max-window (per-side radius `width`, kernel `(2·width+1)`-square). Operates on R/G/B per channel; α preserved. `width=0` accepted as a no-op. |
| `erode([width])` | ✅ | 🟡 | Same shape as `dilate`, opposite kernel direction (min-window). |
| `gamma([gamma], [gammaOut])` | ✅ | 🟡 | Single LUT `(in/255)^(gIn/gOut)·255` per RGB channel; α preserved. Sharp implements this as a pre-/post-resize pair (encode pre, decode post); without an intervening resize the two steps cancel, which matches our single-LUT identity at `gIn == gOut`. With `gOut ≠ gIn` the LUT is the *combined* exponent (e.g. `gamma(2.2, 1.0)` ≈ sRGB→linear); sharp's pre-/post-resize coupling can't be reproduced in 8-bit without a real resize between, so the brightness-on-resize benefit sharp claims is not available. |
| `negate([opts])` | ✅ | ✅ | RGB inverted; α negated when `opts.alpha !== false` (sharp default true). |
| `linear([a], [b])` | ✅ | ✅ | Per-channel `a·C + b`. Both args accept a single number (RGB broadcast, α untouched), a length-3 array (RGB), or length-4 (RGBA). Defaults `a=1`, `b=0` per channel. |
| `threshold([t], [opts])` | ✅ | ✅ | `t` defaults to 128. With `greyscale=true` (default), Rec.601 luma is computed first and broadcast. `grayscale` alias accepted. |
| `recomb(matrix)` | ✅ | ✅ | 3×3 (RGB only, α preserved) or 4×4 (full RGBA) row-major matrix multiply. Accepts nested or flat (length 9 or 16) form. |
| `flatten([opts])` | ✅ | 🟡 | Alpha-blend onto an opaque background and force α=255. The buffer remains 4-channel for pipeline-shape invariance (sharp drops to 3-channel; visually identical). |
| `unflatten()` | ✅ | ✅ | Pure-white pixels (R=G=B=255) become α=0; other pixels untouched. |
| `boolean(operand, operator, [opts])` | ✅ | ✅ | Per-pixel bitwise `and` / `or` / `eor` (sharp's libvips name for XOR; `xor` is also accepted) across all four RGBA bands between this bitmap and the operand. Operand accepts encoded image bytes, `Buffer` / `Uint8Array` / stream / Response, or `{ raw: { width, height, channels } }` for pre-decoded pixels. |
| `normalise([opts])` | ✅ | ✅ | Build a Rec.601 luma histogram, find the `lower` and `upper` percentile cutoffs (defaults 1, 99), and apply the affine map `(C - lo) · 255 / (hi - lo)` to every RGB channel; α preserved. Same affine map is applied to all three channels so colour ratios are preserved. |
| `normalize([opts])` | ✅ | ✅ | Alias of `normalise`. |
| `clahe(opts)` | ✅ | 🟡 | Tile-based local histogram equalisation (Zuiderveld 1994). `width` / `height` size each tile; `maxSlope` (sharp default 3) caps the contrast amplification per tile, with the clipped excess redistributed uniformly. Per-pixel transform is bilinear-interpolated between the four nearest tile-centre CDFs and applied to RGB via a multiplicative `newL/oldL` factor (preserves colour ratio); α preserved. Sharp's libvips path runs CLAHE on the L channel of LAB; we use Rec.601 luma in 8-bit sRGB — visually similar at moderate `maxSlope` but can colour-shift on saturated edges. |
| `modulate([opts])` | ✅ | 🟡 | Brightness, saturation, hue, and lightness adjustments in HSV space. Sharp uses LCh-Lab for hue rotation (perceptually uniform); we approximate in HSV — the 180° rotations sharp's docs use as examples (red↔cyan, etc.) come out byte-identical, but saturated mid-rotations differ slightly. Brightness multiplies V, lightness adds to V (sharp parity for additive vs multiplicative), saturation multiplies S. α preserved. |

## Project-wide divergences

These apply across the API rather than to a single member:

- **Numeric types.** Coordinates, sizes, and other `unrestricted double` WebIDL
  parameters are `f64` end-to-end. Canvas/ImageData width/height are `u32`.
- **No GPU backend.** simdra is a pure CPU+SIMD rasterizer; there is no
  WebGL / WebGPU path. (See `CLAUDE.md` § Scope.)
- **No DOM.** Anything that depends on DOM events, focus management, layout,
  or HTMLElement inheritance is ⛔.
- **No worker transfer.** OffscreenCanvas / `transferControlToOffscreen` /
  `postMessage`-with-transfer are ⛔ until/unless Node `worker_threads` get a
  matching transfer model.
- **No Blob.** `toBlob`, `convertToBlob`, and Blob-arg `createPattern` are ⛔
  until a Node `Blob` shim lands. PNG output goes through `toDataURL()` today.
