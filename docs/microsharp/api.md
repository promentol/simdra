---
title: microsharp API
description: Sharp-shaped fluent image-processing surface — full API reference, organized into the same groups as sharp's docs.
weight: 30
---

# microsharp API

`microsharp` is a sharp-API-shaped fluent image-processing pipeline. It shares the same Zig core (decoders, encoders, SIMD kernels) as the Canvas2D binding but exposes an entirely different surface — closer to [sharp](https://sharp.pixelplumbing.com) than to HTML5 Canvas.

The page below mirrors sharp's documentation structure: **Constructor → Input metadata → Output options → Resizing → Compositing → Image operations → Colour manipulation → Channel manipulation**. If you know sharp, you know where to look.

## Quick recipe

```ts
import { microsharp } from 'simdra';
import { readFileSync, writeFileSync } from 'node:fs';

const out = await microsharp(readFileSync('input.png'))
  .resize(800, 600, { fit: 'cover', kernel: 'lanczos3' })
  .modulate({ brightness: 1.05, saturation: 1.1 })
  .sharpen()
  .jpeg({ quality: 85 })
  .toBuffer();
writeFileSync('output.jpg', out);
```

The `microsharp()` factory returns a `MicroSharpPipeline`. Calls record into the pipeline; terminals (`toBuffer`, `metadata`) execute it.

---

## Constructor

### `microsharp(input)`

Returns a fresh `MicroSharpPipeline`. `input` is one of:

- `Uint8Array`
- `ArrayBuffer`
- `Blob`
- `ReadableStream<Uint8Array>`
- `Response`

PNG / JPEG / BMP / GIF first frame are auto-detected on terminal execution. Stream / Blob / Response inputs are materialized **once** on first terminal call and cached on the pipeline, so `.toBuffer()` followed by `.metadata()` works on a stream-backed pipeline (a `ReadableStream` would otherwise be locked after the first read).

---

## Input metadata

### `.metadata()` — `Promise<Metadata>`

Header-only metadata read — **no pixel decode, no allocation**. Backed by stb_image's `stbi_info_from_memory` + `stbi_is_16_bit_from_memory` public fast-path APIs; populates only fields stb's API actually exposes. The libvips-only fields sharp returns (ICC, EXIF, density, orientation, pages, isProgressive, …) are **not** populated — the underlying decoder doesn't read them.

```ts
interface Metadata {
  format: 'png' | 'jpeg' | 'bmp' | 'gif' | 'unknown';
  width: number;
  height: number;
  channels: number;        // source: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA
  hasAlpha: boolean;       // derived: channels === 2 || channels === 4
  bitsPerSample: number;   // 8 or 16, per stb_image
  size: number;            // total input byte length
}
```

`format` is detected by signature sniff (PNG / JPEG / BMP / GIF). `'unknown'` is returned for input bytes that don't match any of the four containers.

```ts
const { width, height, format, channels, hasAlpha } =
  await microsharp(req.body).metadata();
```

---

## Output options

### `.png([opts])` — `{ compressionLevel? }`

Selects PNG output. The only option is `compressionLevel` (integer `0..9`), wired to stb's process-global `stbi_write_png_compression_level`. The Zig encoder serializes concurrent calls behind a `std.Thread.Mutex` and saves/restores the global so the value is per-call from JS's perspective. Out-of-range values throw `RangeError` synchronously.

```ts
microsharp(input).png({ compressionLevel: 9 }).toBuffer();
```

Sharp's other PNG options (`progressive`, `palette`, `quality`, `effort`, `colours`, `dither`, `adaptiveFiltering`, `force`) are libvips/libpng features and are not supported.

### `.jpeg([opts])` — `quality? | { quality? }`

Selects JPEG output. Accepts either a bare `quality` number (HTML5-style `0.0–1.0`, default `0.92`) or sharp's `{ quality }` object form. Maps to stb's 1–100 scale internally.

```ts
microsharp(input).jpeg(0.85).toBuffer();
microsharp(input).jpeg({ quality: 0.85 }).toBuffer();   // sharp parity
```

Sharp's other JPEG options (`progressive`, `chromaSubsampling`, `mozjpeg`, `optimiseCoding`, `trellisQuantisation`, `overshootDeringing`, `optimiseScans`, `quantisationTable`, `force`) need libjpeg/mozjpeg and are not supported.

### `.bmp()`

Selects BMP output. No options — stb writes a 32-bit BMP V4 header (`BI_BITFIELDS` with explicit RGBA channel masks), preserving alpha. Sharp does not ship a BMP encoder; this exists because stb_image_write does.

### `.raw()`

Returns the decoded RGBA pixel bytes (left-to-right, top-to-bottom, no padding). Always 4-channel because the stb_image decode path forces RGBA.

```ts
const data = await microsharp(input).raw().toBuffer();
// data.length === width * height * 4
```

Sharp's `raw({ depth })` argument is libvips-specific and not supported — output depth is always `uchar` (8 bits per channel).

### `.toFormat(format)`

Unified format setter. Accepts `'png' | 'jpeg' | 'bmp' | 'raw'` only. Throws `RangeError` for any other string (including `'webp'`, `'avif'`, `'gif'`, `'jp2'`, `'tiff'`, `'heif'`, `'jxl'` — none of which stb_image_write encodes).

### `.toBuffer([opts])`

Decodes the input, runs recorded ops in order, encodes the result, and returns a JS-owned `Uint8Array`. The intermediate `SmBitmap` is freed before returning — no leaks even if you don't await.

```ts
const data: Uint8Array = await microsharp(input).png().toBuffer();
```

`{ resolveWithObject: true }` returns `{ data, info }` (sharp parity):

```ts
const { data, info } = await microsharp(input)
  .jpeg(0.85)
  .toBuffer({ resolveWithObject: true });
// info: OutputInfo
//   format: 'png' | 'jpeg' | 'bmp' | 'raw'
//   size: number       // data.byteLength
//   width: number
//   height: number
//   channels: number   // png/bmp/raw = 4, jpeg = 3
```

`OutputInfo` is intentionally narrower than sharp's payload. Sharp's libvips-only fields — `premultiplied`, `cropOffsetLeft`, `cropOffsetTop`, `attentionX`, `attentionY`, `pageHeight`, `pages`, `textAutofitDpi` — are not populated because the underlying encoder doesn't report them.

---

## Resizing images

### `.resize([width], [height], [opts])`

Resamples the image to the target dimensions. Three call forms — `.resize(w, h, opts?)`, `.resize(w, opts?)` (height auto-scales from aspect), `.resize({ width, height, ...opts })`.

Backed by `effects/SmResampler.zig` — a generalized separable resampler. The pipeline mirrors sharp/libvips: `sRGB → linear → premultiply α → separable filter → unpremultiply → linear → sRGB`.

Eight kernels:

| `kernel` | filter function | support | notes |
|---|---|---|---|
| `nearest` | δ(x) | 0.5 | exact pixels; fastest, blocky |
| `linear` | triangle | 1 | bilinear |
| `cubic` | Catmull-Rom (B=0, C=½) | 2 | smooth, slight ringing |
| `mitchell` | Mitchell-Netravali (B=⅓, C=⅓) | 2 | balanced |
| `lanczos2` | sinc · sinc(x/2) | 2 | sharp but compact |
| `lanczos3` | sinc · sinc(x/3) | 3 | **default**; sharp's default too |
| `mks2013` | Magic Kernel Sharp 2013 (Costella) | 2.5 | early MKS variant |
| `mks2021` | Magic Kernel Sharp 2021 (Costella) | 4.5 | reduced sharpening |

**Fit modes** (`opts.fit`, default `cover`): `cover` / `contain` / `fill` / `inside` / `outside`.

**Position** (`opts.position`, default `centre`) — anchor for `cover` (crop) and `contain` (letterbox). Standard set: `centre`, `top`, `right`, `bottom`, `left`, the eight corners, and gravity aliases (`north`, `east`, `south`, `west`, `northeast`, `northwest`, `southeast`, `southwest`). Plus content-aware modes:

- **`entropy`** — pick the cover-crop window with the highest Shannon entropy on its luma histogram.
- **`attention`** — pick the window with the highest saliency proxy (local-luma gradient + saturation magnitude). Sharp's libvips bias toward skin tones is not applied.

**Other options**: `background` (CSS string or `{r,g,b,alpha?}`, default black), `withoutEnlargement`, `withoutReduction`, `fastShrinkOnLoad` (accepted for parity but ignored).

```ts
await microsharp(input).resize(800, 600).toBuffer();
await microsharp(input).resize(512, 512, { fit: 'contain', background: '#fff' }).toBuffer();
await microsharp(input).resize(640, 360, { fit: 'cover', position: 'entropy' }).toBuffer();
await microsharp(input).resize(256, 256, { kernel: 'nearest' }).toBuffer();
```

Only one resize op survives per pipeline — subsequent `.resize()` calls replace the recorded op (sharp parity).

### `.extract({ left, top, width, height })`

Crop a sub-rectangle. Pure row-by-row `memcpy`, no resampling. Out-of-bounds throws `RangeError`.

```ts
await microsharp(input)
  .extract({ left: 10, top: 20, width: 200, height: 150 })
  .toBuffer();
```

### `.extend(n | { top?, right?, bottom?, left?, extendWith?, background? })`

Pad / extrude one or more edges. Pass a single number to apply to all four edges, or an object with per-edge counts.

`extendWith` (default `'background'`):

| Mode | Behaviour |
|---|---|
| `background` | fill new pixels with `background` colour |
| `copy` | extrude — replicate the nearest edge pixel |
| `repeat` | tile — wrap source coordinates |
| `mirror` | reflect — period `2·dim - 2` so edges aren't doubled |

```ts
await microsharp(input).extend(20).toBuffer();
await microsharp(input).extend({ bottom: 80, background: 'red' }).toBuffer();
await microsharp(input).extend({ right: 16, extendWith: 'mirror' }).toBuffer();
```

### `.trim([opts])` — `{ background?, threshold?, lineArt? }`

Trim away edges that match a background colour within a per-channel threshold. Default background is the **top-left pixel** of the working bitmap (sharp parity). Default threshold is `10` (max-channel-diff metric). Returns the source unchanged if every pixel is within threshold of the background.

```ts
await microsharp(input).trim().toBuffer();
await microsharp(input).trim({ background: '#fff', threshold: 5 }).toBuffer();
```

`lineArt` accepted for sharp parity but ignored.

---

## Compositing images

### `.composite(images)`

Overlay one or more images onto the working bitmap with a chosen blend mode and placement. Backed by `effects/SmComposite.zig` — orchestrates `SmSurface` + `SmCanvas.drawImageAt` + the existing 27-mode blend kernel set.

```ts
await microsharp(base)
  .composite([
    { input: layer1, gravity: 'northwest' },
    { input: layer2, top: 100, left: 50, blend: 'multiply' },
  ])
  .toBuffer();
```

**`input`** — encoded image bytes (`Uint8Array` / `ArrayBuffer` / `Blob` / `ReadableStream` / `Response`), or one of:

- **`{ create: { width, height, channels, background } }`** — flat-colour rectangle built on the fly. `channels` is 3 (alpha forced to 255) or 4.
- **Sharp-style raw pixels** — set `input` to the RGBA byte buffer AND set sibling `raw: { width, height, channels: 4 }`.

**`blend`** (default `'over'`) — libvips/cairo names mapped to simdra's HTML5-shaped enum:

| Sharp name | simdra mode |
|---|---|
| `over` | `src_over` (default) |
| `source` | `copy` |
| `in` / `out` / `atop` | `src_in` / `src_out` / `src_atop` |
| `dest` | identity (no draw) |
| `dest-over` / `dest-in` / `dest-out` / `dest-atop` | `dst_*` |
| `xor` / `add` | `xor` / `add` |
| `multiply` / `screen` / `overlay` / `darken` / `lighten` | identical |
| `colour-dodge` / `color-dodge` | `color_dodge` (both spellings) |
| `colour-burn` / `color-burn` | `color_burn` |
| `hard-light` / `soft-light` | `hard_light` / `soft_light` |
| `difference` / `exclusion` | identical |
| `clear` / `saturate` | **throws RangeError** |

**Placement** — when both `top` and `left` are provided they take precedence. Otherwise `gravity` (default `'centre'`) anchors the overlay; same string set as `resize.position`'s non-content-aware values.

**`tile: true`** — tile the overlay across the entire base, anchored at the gravity-resolved (or explicit) origin and wrapping modulo the overlay dimensions.

**Accepted but ignored** for sharp parity: `premultiplied`, `autoOrient`, `animated`, `density`.

---

## Image operations

### `.rotate([angle], [opts])`

Rotate by `angle` degrees clockwise. Multiples of 90° (incl. negative or > 360° — normalised to `[0, 360)`) are byte-exact lossless permutations. Other angles sample through bilinear interpolation against the source-bbox AABB; the gap is padded with `opts.background` (default opaque black).

```ts
await microsharp(input).rotate(90).toBuffer();
await microsharp(input).rotate(45, { background: '#fff' }).toBuffer();
await microsharp(input).rotate(-450).toBuffer();        // normalises to 270°
```

**No-args call** — `microsharp(input).rotate()` aliases `autoOrient()` for sharp back-compat. Multi-page input is not supported (single-frame decode).

### `.autoOrient()`

Read the EXIF Orientation tag (1..8) from the input bytes and apply the corresponding rotation/mirror. EXIF Orientation only — read by a custom parser in `decode/exif.zig` covering JPEG APP1 (`Exif\0\0`) and PNG `eXIf` chunks. Missing / malformed EXIF → no-op.

```ts
await microsharp(jpegFromCamera).autoOrient().toBuffer();
```

### `.flip([flip])`

Mirror vertically (top↔bottom). `flip=false` records nothing (sharp parity).

### `.flop([flop])`

Mirror horizontally (left↔right). `flop=false` records nothing.

### `.affine(matrix, [opts])`

Affine transform. `matrix` is `[a, b, c, d]` flat or `[[a, b], [c, d]]` nested — the linear part of `F(x, y) = M·(x+idx, y+idy) + (odx, ody)`. Output dim = forward-mapped AABB of the source rectangle; the gap is padded with `background`.

```ts
await microsharp(input).affine([1, 0.3, 0.1, 0.7], {
  background: 'white',
  interpolator: 'bilinear',
}).toBuffer();
```

`opts`: `background`, `idx`, `idy`, `odx`, `ody`, `interpolator`.

`interpolator` accepts sharp's vocabulary: `nearest` and `bilinear` map directly; `bicubic` / `nohalo` / `lbb` / `vsqbs` collapse to `bilinear` (libvips's high-precision resamplers we don't ship). Singular matrix (det=0) throws `RangeError`.

### `.sharpen([opts], [flat], [jagged])`

No-args call applies a 3×3 unsharp kernel (`[[0,-1,0],[-1,5,-1],[0,-1,0]]`) — fast, per-channel.

With `{ sigma, m1, m2, x1, y2, y3 }`, runs the libvips USM piecewise-gain formula in **8-bit sRGB per channel** (sharp's libvips path runs on the L channel of LAB, which simdra has no pipeline for). Visible result is similar at moderate sigma but can colour-shift on saturated edges.

```ts
await microsharp(input).sharpen().toBuffer();
await microsharp(input).sharpen({ sigma: 2 }).toBuffer();
await microsharp(input).sharpen({ sigma: 2, m1: 0, m2: 3, x1: 3, y2: 15, y3: 15 }).toBuffer();
```

Deprecated 2-positional `sharpen(sigma, flat, jagged)` form is accepted (maps to `m1` / `m2`).

### `.median([size])`

Square `size × size` median per RGB channel; α preserved. `size` defaults to 3 and must be odd. Implementation is per-pixel sort — fine for `size ≤ 7`; larger sizes accepted up to 99 but get expensive.

```ts
await microsharp(input).median().toBuffer();
await microsharp(input).median(5).toBuffer();
```

### `.blur([opts])`

- **No args / `true`**: fast 3×3 box blur.
- **`false`**: no-op.
- **bare `sigma` number**: separable Gaussian.
- **`{ sigma, precision, minAmplitude }`**: same with explicit working precision and kernel-amplitude cutoff.

`precision` accepts `'integer' | 'float' | 'approximate'` (default `'integer'`); `minAmplitude` defaults to `0.2`. Sigma must be in `[0.3, 1000]`.

The `'integer'` and `'float'` paths share a single f64 separable Gaussian (the divergence is < 1 LSB at 8-bit output). `'approximate'` reuses the existing 3-pass-box (Wells '86) ≈ Gaussian.

For **σ ≥ 3**, `'integer'` and `'float'` auto-route to the 3-pass-box approximation — within < 1 LSB at 8-bit output, but constant-cost per pixel instead of linear in σ.

```ts
await microsharp(input).blur().toBuffer();
await microsharp(input).blur(5).toBuffer();
await microsharp(input).blur({ sigma: 2, precision: 'integer' }).toBuffer();
```

### `.dilate([width])`

Foreground expansion via separable max-window. `width` is the per-side radius (sharp parity); kernel is `(2·width+1)`-square. Operates on R/G/B per channel; α preserved. `width=0` is a no-op.

Implementation uses a monotonic-deque sliding window — O(n) per row regardless of `width`.

```ts
await microsharp(input).dilate().toBuffer();          // width = 1
await microsharp(input).dilate(5).toBuffer();
```

### `.erode([width])`

Same shape as `dilate`, opposite kernel direction (min-window).

### `.flatten([opts])` — `{ background? }`

Alpha-blend onto an opaque background and force α=255. The buffer remains 4-channel for pipeline-shape invariance (sharp drops to 3-channel; visually identical). `background` defaults to `#000000`.

```ts
await microsharp(rgba).flatten({ background: '#F0A703' }).toBuffer();
```

### `.unflatten()`

Every pixel where `R = G = B = 255` becomes α=0; other pixels are unchanged. libvips parity.

```ts
await microsharp(input)
  .threshold(128, { greyscale: false })
  .unflatten()
  .toBuffer();
```

### `.gamma([gamma], [gammaOut])`

Apply a single LUT `(in/255)^(gIn/gOut) · 255` per RGB channel; α preserved. Both values must be in `[1.0, 3.0]`; `gammaOut` defaults to `gamma`.

Sharp implements gamma as a pre-/post-resize pair (encode pre, decode post); without an intervening resize the two cancel — which matches our single-LUT identity at `gIn == gOut`. With `gammaOut ≠ gamma` the LUT is the *combined* exponent (e.g. `gamma(2.2, 1.0)` ≈ sRGB→linear).

`gamma()` no-args → `gamma(2.2, 2.2)` → identity. Useful as a placeholder before a future `gamma(2.2, 1.0)` decode step.

### `.negate([opts])` — `{ alpha? }`

Invert RGB. `alpha` defaults to `true` (α also inverted, sharp parity); pass `{ alpha: false }` to preserve α.

```ts
await microsharp(input).negate().toBuffer();
await microsharp(input).negate({ alpha: false }).toBuffer();
```

### `.normalise([opts])` / `.normalize([opts])`

Stretch luma so the `lower`-percentile maps to 0 and the `upper`-percentile maps to 255. Same affine map applied to all RGB channels (preserves colour ratios). α preserved.

`opts`: `lower` (default 1), `upper` (default 99). Both in `[0, 100]` with `lower < upper`.

```ts
await microsharp(input).normalise().toBuffer();
await microsharp(input).normalise({ lower: 0, upper: 100 }).toBuffer();
```

`.normalize()` is an alias.

### `.clahe(opts)` — `{ width, height, maxSlope? }`

Tile-based local histogram equalisation (Zuiderveld 1994). `width` / `height` size each tile in pixels; `maxSlope` (default 3, sharp parity) caps contrast amplification per tile, with the clipped excess redistributed uniformly. `maxSlope = 0` disables clipping (plain AHE).

Per-pixel transform is bilinear-interpolated between the four nearest tile-centre CDFs and applied to RGB via a multiplicative `newL/oldL` factor (preserves colour ratio); α preserved.

```ts
await microsharp(input).clahe({ width: 16, height: 16 }).toBuffer();
await microsharp(input).clahe({ width: 8, height: 8, maxSlope: 5 }).toBuffer();
```

Sharp's libvips path runs CLAHE on the L channel of LAB; we use Rec.601 luma in 8-bit sRGB — visually similar at moderate `maxSlope` but can colour-shift on saturated edges.

### `.convolve(kernel)` — `{ width, height, kernel, scale?, offset? }`

Generic `width × height` kernel (both must be odd). `scale` defaults to the sum of kernel values (or 1 when the sum is 0, e.g. derivative kernels like Sobel). Edge mode is **clamp** (libvips default). Operates on R/G/B per channel; α preserved.

When the kernel is rank-1 separable (Sobel-h, Sobel-v, box, Gaussian-shape), simdra automatically decomposes `K = u·vᵀ` and runs as two 1D passes — `kh + kw` taps instead of `kh · kw`. Falls back to 2D for non-separable kernels.

```ts
// Horizontal Sobel
await microsharp(input).convolve({
  width: 3, height: 3,
  kernel: [-1, 0, 1, -2, 0, 2, -1, 0, 1],
}).raw().toBuffer();

// Box blur
await microsharp(input).convolve({
  width: 3, height: 3,
  kernel: [1, 1, 1, 1, 1, 1, 1, 1, 1],
}).toBuffer();
```

### `.threshold([t], [opts])` — `{ greyscale? | grayscale? }`

Per-channel `(C ≥ t) ? 255 : 0`. `t` defaults to 128. With `greyscale=true` (default), Rec.601 luma is computed first and broadcast to RGB; α preserved. `grayscale` alias accepted.

```ts
await microsharp(input).threshold().toBuffer();
await microsharp(input).threshold(100, { greyscale: false }).toBuffer();
```

### `.boolean(operand, operator, [opts])` — `'and' | 'or' | 'eor' | 'xor'`

Per-pixel bitwise operation across all four RGBA bands between this bitmap and `operand`. `operator` accepts `'and'`, `'or'`, `'eor'` (libvips XOR) — `'xor'` is also accepted as an alias.

`operand` accepts the same byte sources as the pipeline's primary input; pass `opts.raw = { width, height, channels }` for pre-decoded pixels (same shape as `joinChannel`).

Both bitmaps must have the same dimensions.

```ts
await microsharp(input).boolean(maskPng, 'and').toBuffer();
await microsharp(input).boolean(rawBuf, 'eor', {
  raw: { width: 100, height: 100, channels: 4 },
}).toBuffer();
```

### `.linear([a], [b])`

Per-channel `a · C + b`, output clipped to `[0, 255]`. Both arguments accept:

- a single number (RGB broadcast, α untouched)
- length-3 array (RGB)
- length-4 array (RGBA)

Defaults: `a = 1`, `b = 0` per channel.

```ts
await microsharp(input).linear(0.5, 2).toBuffer();
await microsharp(input).linear([0.25, 0.5, 0.75], [150, 100, 50]).toBuffer();
```

### `.recomb(matrix)`

3×3 (RGB only, α preserved) or 4×4 (full RGBA) row-major colour-matrix multiply. Accepts nested form `[[a,b,c],[d,e,f],[g,h,i]]` or flat `[a,b,c,d,e,f,g,h,i]`.

```ts
// Sepia tone
await microsharp(input).recomb([
  [0.3588, 0.7044, 0.1368],
  [0.2990, 0.5870, 0.1140],
  [0.2392, 0.4696, 0.0912],
]).toBuffer();
```

### `.modulate([opts])` — `{ brightness?, saturation?, hue?, lightness? }`

Brightness, saturation, hue, and lightness adjustments in HSV space. All four arguments are optional; defaults are `1, 1, 0, 0`.

- **`brightness`** — multiplier on V (HSV value). `2` doubles luminance.
- **`saturation`** — multiplier on S. `0` collapses to greyscale.
- **`hue`** — degrees of hue rotation.
- **`lightness`** — additive offset on V (sharp's "additive vs multiplicative" distinction).

α preserved.

```ts
await microsharp(input).modulate({ brightness: 2 }).toBuffer();
await microsharp(input).modulate({ hue: 180 }).toBuffer();
await microsharp(input).modulate({ brightness: 0.5, saturation: 0.5, hue: 90 }).toBuffer();
```

Sharp uses LCh-Lab for hue rotation (perceptually uniform); we approximate in HSV — saturated mid-rotations differ slightly. Documented divergence in `COMPATIBILITY.md`.

---

## Colour manipulation

### `.tint(colour)`

Recolour using the given RGB tint while preserving the per-pixel luminance pattern. α unchanged (sharp spec).

`colour` accepts a CSS string or `{ r, g, b, alpha? }` object; the `alpha` component is parsed for compatibility but ignored — tint is RGB-only.

```ts
await microsharp(input).tint({ r: 255, g: 240, b: 16 }).toBuffer();
await microsharp(input).tint('#ff8800').toBuffer();
```

Computed as `out_C = L · tint_C / 255` per channel, where `L` is Rec.601 luma. Sharp's libvips implementation does the shaping in LAB space — monochrome shape is correct, chroma differs slightly.

### `.greyscale([greyscale])` / `.grayscale([grayscale])`

Convert RGB to Rec.601 luma (`R = G = B = L`). α preserved. `greyscale=false` records nothing (sharp parity).

```ts
await microsharp(input).greyscale().toBuffer();
await microsharp(input).grayscale().toBuffer();        // alias
```

Sharp's docs flag the op as "linear" and recommend `gamma()` for sRGB input — simdra has no `gamma()` linear-light pass yet, so the conversion stays in 8-bit sRGB space.

### `.pipelineColourspace([colourspace])` / `.pipelineColorspace([colorspace])`

Records the requested input pipeline colourspace. `b-w` and `grey16` inject a leading greyscale at apply time so the rest of the pipeline runs on luma values. Other recognised libvips colourspace names (`srgb`, `rgb`, `multiband`, `xyz`, `lab`, `cmyk`, `labq`, `cmc`, `lch`, `labs`, `yxy`, `fourier`, `rgb16`, `matrix`, `scrgb`, `hsv`, `last`, `histogram`) are accepted as 8-bit sRGB passthroughs because simdra has no 16-bit / LAB / CMYK pipeline. Unrecognised strings throw `RangeError`.

```ts
await microsharp(input).pipelineColourspace('srgb').toBuffer();
await microsharp(input).pipelineColourspace('b-w').toBuffer();   // greyscale
```

### `.toColourspace([colourspace])` / `.toColorspace([colorspace])`

Same accepted vocabulary as `pipelineColourspace`. `b-w` / `grey16` triggers a tail greyscale (buffer stays 4-channel for pipeline-shape invariance). All other recognised values are passthrough no-ops; output is always 8-bit RGBA sRGB.

```ts
await microsharp(input).toColourspace('b-w').toBuffer();    // emits greyscale
```

---

## Channel manipulation

### `.removeAlpha()`

Sets α=255 on every pixel. Sharp's docs describe this as "the output image is a 3 channel image without an alpha channel"; in microsharp the buffer remains 4-channel for pipeline-shape invariance, but the visible result is identical (all pixels fully opaque).

```ts
await microsharp(rgba).removeAlpha().png().toBuffer();
```

### `.ensureAlpha([alpha])`

With no argument, a no-op (microsharp bitmaps always have an alpha channel). With an explicit `alpha` (0..1), forces α to that constant level — useful right after `removeAlpha` to set a non-opaque uniform alpha.

```ts
await microsharp(rgb).ensureAlpha().toBuffer();           // no-op
await microsharp(rgb).ensureAlpha(0).toBuffer();          // fully transparent
await microsharp(rgb).ensureAlpha(0.5).toBuffer();        // 50% alpha
```

Throws `RangeError` for `alpha` outside `[0, 1]`.

### `.extractChannel(channel)`

Pick one band as a greyscale image. `channel` accepts the integer index `0`/`1`/`2`/`3` or sharp's string names `'red'`/`'green'`/`'blue'`/`'alpha'`. Output is RGB = the chosen band, α=255.

```ts
await microsharp(input).extractChannel('green').toBuffer();
await microsharp(input).extractChannel(3).toBuffer();      // alpha as greyscale
```

Sharp emits a 1-channel `b-w` PNG; microsharp emits 4-channel RGBA where `R = G = B = L`. Both decode to identical greyscale bytes — microsharp ↔ sharp comparison hits SSIM = 1.0000.

### `.joinChannel(image, [options])`

Replace the working bitmap's alpha channel with the joined image's content. Powers sharp's "use this image as the new alpha mask" idiom.

`image` accepts the same byte sources as the pipeline's primary input (`Uint8Array` / `ArrayBuffer` / `Blob` / `ReadableStream` / `Response`). Pass `options.raw = { width, height, channels: 1 | 3 | 4 }` for pre-decoded pixels. A single-element array `[image]` is also accepted for sharp parity.

```ts
// Encoded greyscale PNG used as the alpha mask
await microsharp(rgb).joinChannel('mask.png').toBuffer();

// Pre-decoded 1-channel grey buffer
const mask = new Uint8Array(width * height);
await microsharp(rgb)
  .joinChannel(mask, { raw: { width, height, channels: 1 } })
  .toBuffer();
```

The joined image must have the same dimensions as the working bitmap (throws `RangeError` otherwise). microsharp uses Rec.601 luma to derive a single channel:

- 1-channel (grey) inputs round-trip exactly.
- 4-channel grey-with-alpha (R=G=B) round-trips exactly.
- 3-channel RGB inputs convert via `0.299·R + 0.587·G + 0.114·B`.

**Limitations vs sharp**: microsharp's always-RGBA model can't grow beyond 4 channels — libvips's full N-band append (joining 3 separate channels to make a 7-band image, or joining channels to a CMYK base) is not supported. Multi-image arrays (`joinChannel([m1, m2])`) throw `RangeError`. The supported single-mask cases hit SSIM = 1.0000 against sharp.

### `.bandbool(op)` — `'and' | 'or' | 'eor' | 'xor'`

Per-pixel bitwise operation across **all four bands** (R, G, B, A) of the input. The result is broadcast to RGB with α=255. Mirrors libvips's `vips_bandbool`; `eor` is libvips's name for XOR, `'xor'` accepted as a synonym.

| op | result |
|---|---|
| `'and'` | `R & G & B & A` |
| `'or'` | `R \| G \| B \| A` |
| `'eor'` / `'xor'` | `R ^ G ^ B ^ A` |

```ts
await microsharp(rgb).bandbool('and').toBuffer();
```

For sources where α=255, `or` collapses to 0xff everywhere and `eor` becomes `~(R ^ G ^ B)` — that's libvips behaviour.

---

## Not supported

These sharp output APIs require encoders / metadata libraries that aren't in stb_image_write, and are deliberately not implemented:

| Sharp surface | Why it's missing |
|---|---|
| `.webp()` / `.avif()` / `.gif()` / `.jp2()` / `.tiff()` / `.heif()` / `.jxl()` | stb_image_write does not encode any of these. |
| `.toFile(path)` | Requires `node:fs`; the Workers target deliberately avoids Node-only APIs. |
| `.tile(opts)` | libvips DZI / IIIF / Zoomify pyramid output. |
| `.timeout({ seconds })` | stb's encoders are synchronous; can't actually cancel. |
| `.keepExif()` / `.withExif()` | stb_image does not parse or emit EXIF (only the Orientation tag is read for `autoOrient`). |
| `.keepIccProfile()` / `.withIccProfile()` | stb_image does not parse or attach ICC profiles. |
| `.keepXmp()` / `.withXmp()` | stb_image does not parse or emit XMP. |
| `.keepMetadata()` / `.withMetadata()` | Composite of EXIF / XMP / IPTC + density + orientation. |
| `.joinChannel([m1, m2, ...], opts)` (multi-image) | Single-mask form is supported; libvips's N-band append beyond 4 channels can't be represented. |

For a full coverage matrix including Canvas2D + microsharp divergences from sharp, see [`COMPATIBILITY.md`](https://github.com/narekh/simdra/blob/main/COMPATIBILITY.md).

---

## Workers idiom

Because `microsharp` accepts `ReadableStream` and `Response` directly, request bodies flow straight in:

```ts
import { microsharp } from 'simdra/wasm';

export default {
  async fetch(req: Request) {
    const out = await microsharp(req.body).jpeg(0.8).toBuffer();
    return new Response(out, { headers: { 'content-type': 'image/jpeg' } });
  },
};
```

## Why is it `async`?

The terminals return `Promise<...>` because that matches sharp's signature — code that imported `sharp` can swap to `microsharp` with no signature changes. **In v0 the work is fully synchronous**: each terminal runs decode/encode on the calling thread and resolves immediately. There's no event-loop yielding, no worker offload.

This is fine for small images (< 1 MP) on dev machines. For server use, see the runtime-specific async patterns in [Installation](/installation#async-semantics-in-case-youre-wondering) — Web Workers in the browser, Service Bindings on Cloudflare, `worker_threads` on Node.

## Difference from Canvas2D

| | `simdra` (Canvas2D) | `microsharp` |
|---|---|---|
| API style | Immediate-mode drawing (`ctx.fillRect(...)`) | Fluent pipeline (`microsharp().resize().toBuffer()`) |
| State | Long-lived `Canvas` + `Context` | One-shot pipeline per `microsharp(buf)` call |
| Read-back | `getImageData`, `isPointInPath`, `measureText` | None — bytes-in, bytes-out |
| Sync/async | Sync | Async-shaped (sync work in v0) |
| Use case | Drawing, programmatic graphics, PDFs | Resize / re-encode / batch transform pipelines |

Both share the Zig core: same decoders, same encoders, same SIMD kernels.

## Roadmap

Future work — pixel format expansion (F16 / F32 / 10:10:10:2 / single-channel), codec independence (replace stb with pure Zig), and other planned improvements — is tracked in [`Roadmap.md`](https://github.com/narekh/simdra/blob/main/Roadmap.md).
