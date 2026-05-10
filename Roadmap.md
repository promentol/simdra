# Roadmap

Future work, ordered by what unlocks the most use cases. No dates —
items land when somebody picks them up. Each entry names what it
enables and what stands in the way.

## Pixel format expansion

Today: `rgba_unorm8` only. Every kernel rejects other formats with
`error.UnsupportedPixelFormat` (the `rgba_float16` enum value exists
in `core/types.zig` for HTML5 `getImageData` spec compatibility, but
no op runs on it). The roadmap is to grow into the format set Skia
ships, with the same comptime-dispatch shape we already use for
backends.

### `kRGBA_F16` / `kRGBA_F16Norm` — 16-bit float per channel

Enables HDR rendering and wide-gamut workflows. Used by browsers for
Display P3 / Rec. 2020 content and by Flutter for HDR canvas.

- 8 bytes per pixel; `@Vector(4, f16)` in registers.
- Linear-light by default in `_F16` semantics; sRGB-encoded in
  `_F16Norm` per Skia.
- WASM caveat: `wasm32` rejects `@Vector(N, f16)` casts in some Zig
  releases — backend split (NEON/SSE supports natively, generic
  emulates via f32 round-trip) is the same shape we already use for
  arch dispatch.
- Surfaces:
  - HTML5 `ImageData(width, height, { pixelFormat: 'float16' })` —
    spec-recognised in Safari + Chrome behind a flag; we already
    accept the constructor option, just need the kernels.
  - sharp's `pipelineColourspace('rgb16')` /
    `toColourspace('rgb16')` — currently 🟡 (accepted as 8-bit
    sRGB passthrough); would become real precision.
- Blockers:
  - Per-format kernel dispatch in every effects module (or
    runtime format check, which costs ILP).
  - sRGB ↔ linear LUTs (currently in `effects/SmResampler.zig` as
    `srgbByteToLinear` / `linearToSrgbByte`) need an f16 form.
  - Encoders (`encode/encoder.zig`) can't write 16-bit PNG via
    `stb_image_write` — bound to `stbi_write_png_to_func`'s
    8-bit-only output. Needs a native PNG encoder with 16-bit
    support, or a separate decode-only-to-8-bit fast path.

### `kRGBA_F32` — 32-bit float per channel

For scientific / DCC (digital content creation) workflows. ~5% of
Skia surfaces; large bandwidth cost.

- 16 bytes per pixel; `@Vector(4, f32)` in registers (same as our
  current intermediate scratch type).
- Output side has no PNG/JPEG path — F32 surfaces serialise as
  EXR/HDR or raw float buffers.
- Likely scope: support as a *working* format (intermediates,
  effects), not a *persistent* surface. Most callers won't want
  16 MB per megapixel of bitmap on a Worker.

### `kRGBA_1010102` — 10-bit per channel + 2-bit alpha

For HDR10 video pipelines. 4 bytes per pixel; same total size as
`rgba_unorm8` but more chroma headroom.

- Bit-packing: 30 bits across R/G/B + 2 bits alpha in a `u32`.
- Encoders: stb_image_write doesn't support; AVIF/HEIF/HDR10 PNG
  can carry it but those encoders aren't in scope today.
- Practical use: useful when paired with HDR display output paths
  in browsers; less useful on Workers (no display output).
- Lower priority — probably blocked on someone shipping an HDR
  use case that needs it.

### Single-/two-channel formats

`kAlpha_8`, `kR16G16_unorm`, `kAlpha_F16` — masks, shadow maps,
distance-field font atlases.

- 1 byte / 4 bytes / 2 bytes per pixel.
- Mostly useful as *intermediate* formats (e.g. text shaping path
  could render glyphs into `kAlpha_8` once, composite at draw
  time).
- Shadow blur path in `core/SmCanvas` already works on a `[]u8`
  alpha buffer internally — that's morally `kAlpha_8` storage; the
  format tag is the only thing missing.

### Implementation shape

When the work lands, the path is:

1. Promote `core/types.zig::PixelFormat` to a richer enum with
   per-format byte sizes and channel layouts.
2. Each effects module switches to a comptime function-per-format
   pattern (same shape as `opts/simd.zig`'s arch dispatch).
3. The hot kernels stay scalar-with-`@Vector` for the common formats;
   uncommon ones can fall back to slower scalar loops without losing
   the abstraction.
4. Encoders either grow native 16-bit-aware backends or document the
   conversion-on-encode (e.g. F16 surface → 8-bit PNG with optional
   tone-mapping).

The core/effects boundary lets us add formats incrementally — every
new format starts as "supported in `getImageData` / `putImageData`
round-trip" and grows op-by-op until the test matrix is clean.

## Codec independence — remove stb_image / stb_image_write

Today: `decode/stb.zig` and `encode/encoder.zig` link against
`utils/stb_image.c` and `stb_image_write.h`. That's two C sources, a
libc dependency, and a quirky API shape (return-mode globals, plus a
process-wide `stbi_write_png_compression_level` mutex hack on the
encode side). Pure-Zig codec replacements are on the roadmap.

### Pure-Zig PNG decoder + encoder

- **Decoder:** PNG is a well-specified format (RFC 2083). The hard
  parts are CRC32, the DEFLATE inflater, and PNG's filter byte logic.
  `std.compress.flate` already ships in the stdlib; CRC32 is in
  `std.hash.crc`; the unfilter logic is small. Estimated 600-800 SLOC
  of Zig.
- **Encoder:** stored-block PNG is already in `encode/png.zig` (we
  wrote it as a fallback). What's missing is a real DEFLATE
  compressor. `std.compress.flate.deflate.compressor` ships in
  recent Zig releases — adoption blocked on dialing in compression
  levels and on perf parity with stb's hand-tuned hash chain.
- **Wins:** cuts the C dependency entirely from the PNG path. Saves
  ~30 KB compiled. Removes the process-global compression-level
  mutex.
- **What it costs:** the test matrix grows — every PNG output (which
  is the default) becomes a Zig codec output. Visual SSIM regression
  vs `@napi-rs/canvas` re-baselines.

### Pure-Zig JPEG decoder + encoder

- **Decoder:** baseline JPEG is well-specified (ITU-T T.81); the hard
  parts are entropy decoding, IDCT, and chroma upsampling. ~1500-2000
  SLOC of Zig for a baseline-only decoder. Progressive / arithmetic
  coding can be follow-ups.
- **Encoder:** baseline JPEG with 2:2:0 chroma subsampling and a
  fixed quantisation table is ~800 SLOC. Quality knob is the
  quantisation-table scale.
- **Wins:** cuts the largest C dependency (`stb_image.c` is ~7 KLOC,
  most of it JPEG). Saves ~60 KB compiled. Better control over
  encode quality vs file size.
- **What it costs:** real test surface — JPEG roundtrip SSIM today is
  0.998 against `@napi-rs/canvas`; a Zig encoder needs to land in
  the same ballpark before it can replace stb.

### Pure-Zig BMP / GIF (first-frame) decoders

- **BMP:** trivial. ~150 SLOC.
- **GIF first-frame:** GIF needs LZW decode, which `std.compress`
  doesn't ship. ~400 SLOC for a self-contained LZW + frame walker.
- **Wins:** kills the last `stb_image.c` dependency.
- **What it costs:** GIF animation isn't on the roadmap (we already
  decode first frame only, sharp parity), so this one's about
  removing the C dep, not adding format support.

### Pure-Zig font rasterizer

Today: `utils/stb_truetype.c` + the embedded Manrope variable TTF.
~7 KLOC of C.

- A pure-Zig TTF/OTF rasterizer is doable — Zig's `std.io` reading,
  bezier flattening for glyph outlines, signed-distance-field or
  scanline-coverage fill — but it's **a project**, not a milestone.
  Estimated 3000-4000 SLOC.
- **Wins:** zero C dependencies in the entire library.
- **What it costs:** font rasterisation is a deep area — hinting,
  variable-axis instancing, fallback chains, OpenType GSUB/GPOS for
  shaping. The 80/20 cut is "render Latin-1 from a TTF without
  hinting"; everything past that is incremental.
- **Lower priority** because stb_truetype is small (~7 KLOC compiled
  to ~40 KB), correct, and doesn't hold us back.

### Why remove the C dependencies

- **Smaller WASM bundle.** stb_image (~80 KB compiled) + stb_truetype
  (~40 KB compiled) is roughly a quarter of our current WASM size.
- **Cleaner build.** No `useLibc: true` requirement, no C toolchain
  needed for contributors, no `@cImport`. Pure Zig.
- **Better error handling.** stb's idiom is "return null on failure,
  set a static `stbi__g_failure_reason` string." Zig error sets
  carry the failure mode in the type system. Replacing stb means
  every decode/encode failure has a typed reason.
- **Comptime opportunities.** A Zig PNG decoder can be `comptime`-evaluable
  for the embedded font and for assets baked into the binary. stb
  can't do that.
- **Audit surface.** `stb_image.c` is well-known and battle-tested,
  but it's still 7 KLOC of C in our supply chain. A Zig rewrite is
  small, reviewable, and matches the rest of the codebase's
  language idioms.

### Order to do them in

1. **PNG decoder + encoder** (highest value: PNG is the default
   output format; removes the global compression-level mutex).
2. **JPEG decoder + encoder** (largest size win; biggest test
   surface re-baseline).
3. **BMP + GIF first-frame** (small; finishes the stb_image
   removal).
4. **Font rasterizer** (large project, stb_truetype keeps
   working).

After step 3, `useLibc: true` can flip to `false` and we drop the
entire libc dependency on WASM.

## Tier 4 from previous SIMD-perf list (re-stated for completeness)

These don't belong to format-or-codec work but are on the perf
roadmap:

- **CLAHE in YCbCr** instead of RGB scale-factor (closer chroma to
  sharp's libvips path).
- **Sharpen on Rec.601 luma** instead of per-channel (closer to
  sharp's LAB-L USM).
- **Modulate hue in LCh-Lab** instead of HSV (perceptually uniform
  rotation; bigger code change because it needs a CMS-lite for
  RGB↔LAB).
- **Bench harness** for the image-ops batch — `bench/` already
  exists, needs the new ops wired in to track regressions.

## Out of scope — won't do

- **GPU backend.** simdra is a pure CPU+SIMD rasterizer; that's the
  scope statement in [`CLAUDE.md`](./CLAUDE.md). Anyone needing GPU
  should use Skia / WebGPU directly.
- **WebP / AVIF / JXL output.** These need libwebp / libheif / libjxl,
  which dwarf the simdra bundle. Not on the table.
- **Multi-page rotation / animated GIF / animated WebP / animated
  AVIF.** Single-frame decode is the scope.
- **EXIF / ICC / XMP metadata round-trip.** Only `Orientation` is
  read for `autoOrient` — full EXIF is a project.
- **Multi-threading.** simdra is single-thread first-class by
  design. SIMD is the parallelism. See `Marketing.md`.