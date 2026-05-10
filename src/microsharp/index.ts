// =============================================================================
// microsharp — sharp-shaped fluent image-processing surface
// =============================================================================
//
// Second binding on top of the same Zig core (`zig/simdra/`) that backs
// the Canvas2D binding in `src/index.ts`. The two are independent: this
// file does not reach into Canvas2D state — it talks to `SmBitmap` directly.
//
// ## API
//
//     import { microsharp } from 'simdra';
//
//     const out = await microsharp(input)
//       .resize(800, 600, { fit: 'cover', kernel: 'lanczos3' })
//       .jpeg(0.9)
//       .toBuffer();
//
// `input` is a Web-standard byte source: `Uint8Array`, `ArrayBuffer`,
// `Blob`, `ReadableStream<Uint8Array>`, or `Response`. The Workers idiom
// `microsharp(req.body).jpeg(0.8).toBuffer()` works directly.
//
// ## v0 scope
//
//   - decode → encode round-trip works (PNG / JPEG / BMP / GIF first frame
//     in; PNG / JPEG / BMP / raw RGBA out)
//   - `metadata()` reads the **header only** via stb_image's
//     `stbi_info_from_memory` + `stbi_is_16_bit_from_memory` — no pixel
//     decode, no allocation — and surfaces only fields stb's public API
//     exposes (format / width / height / source channel count / bits /
//     size + a derived `hasAlpha`). The libvips-only fields sharp returns
//     (ICC, EXIF, density, orientation, pages, isProgressive, …) are not
//     populated.
//   - format options are scoped to what stb_image_write actually supports:
//       PNG  → `compressionLevel` (0–9, mutex-guarded around stb's process
//              global)
//       JPEG → `quality` (HTML5 0.0–1.0 → stb's 1–100 internally)
//       BMP  → no options (stb writes 32-bit V4 with alpha mask)
//       raw  → no options (defensive copy of decoded RGBA pixels)
//     WebP / AVIF / GIF / JP2 / TIFF / HEIF / JXL are NOT supported because
//     stb_image_write doesn't encode them. Sharp's metadata methods
//     (`keepExif`, `withExif`, `keepIccProfile`, `withIccProfile`,
//     `keepXmp`, `withXmp`, `keepMetadata`, `withMetadata`) are NOT
//     supported because stb_image doesn't read or write EXIF/ICC/XMP/IPTC.
//     `tile()`, `toFile()`, `timeout()` are also out of scope (libvips DZI,
//     Node-only fs, no cancellable underlying work).
//   - `resize` / `extend` / `extract` / `trim` / `composite` are
//     implemented on top of bitmap-direct primitives in
//     `zig/simdra/effects/`:
//       * `SmResampler.zig` — eight separable filter kernels: nearest,
//         linear, cubic (Catmull-Rom), mitchell, lanczos2, lanczos3
//         (sharp's default), mks2013, mks2021 (Costella's Magic
//         Kernel Sharp variants). Bit-level fidelity to libvips's MKS
//         is not guaranteed; the kernel shape is faithful.
//       * `SmTrim.zig` — bbox scan for `.trim()` and content-aware
//         entropy / attention crop strategies (sharp's
//         `position: 'entropy' | 'attention'`). `attention` does NOT
//         apply sharp's skin-tone bias — it's a saliency proxy from
//         local-luma gradient + saturation magnitude.
//       * `SmComposite.zig` — overlay one bitmap onto another with a
//         blend mode (27 kernels: Porter-Duff + W3C separable +
//         non-separable). Sharp's libvips/cairo blend names are
//         mapped to simdra's enum at the JS layer; `clear` and
//         `saturate` throw `RangeError` (no equivalent kernel).
//   - `rotate` / `flip` / `flop` / `flatten` / colour ops / channel
//     ops are NOT implemented yet.
//
// ## Memory
//
// Each terminal (`toBuffer` / `metadata`) decodes a fresh `SmBitmap`,
// runs the recorded ops, encodes, and frees the bitmap explicitly via
// `SmBitmap.release` — no FinalizationRegistry needed for these
// short-lived intermediates. Returned `Uint8Array`s are JS-owned
// defensive copies (safe to retain past the next call into Zig).
//
// Stream / Blob / Response inputs are materialized **once** on first
// terminal call and cached on the pipeline, so `.toBuffer()` followed by
// `.metadata()` works on a `ReadableStream`-backed pipeline (a stream
// would otherwise be locked after the first read).

import { SmBitmap, parseCssColor } from '../../zig/simdra.zig';
import type {
  SmBitmap as ZigBitmap,
  ZigBytes,
  ResampleKernelName,
  BlendModeName,
  InterpolatorName,
  BlurPrecisionName,
} from '../../zig/simdra.zig';

/** Output formats stb_image_write can encode (plus `raw` for decoded pixels). */
export type ImageFormat = 'png' | 'jpeg' | 'bmp' | 'raw';

/** Sharp-shaped resampling kernel. simdra implements all eight in
 *  `effects/SmResampler.zig` so each name maps to its own filter. */
export type ResizeKernel = ResampleKernelName;

/** Sharp's `fit` modes. */
export type ResizeFit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

/** Sharp's `position`. Anchor strings + gravity aliases + content-aware
 *  strategies. `'centre'` and `'center'` are equivalent (sharp parity). */
export type ResizePosition =
  | 'centre' | 'center'
  | 'top' | 'right' | 'bottom' | 'left'
  | 'top right' | 'right top'
  | 'right bottom' | 'bottom right'
  | 'bottom left' | 'left bottom'
  | 'left top' | 'top left'
  | 'north' | 'east' | 'south' | 'west'
  | 'northeast' | 'southeast' | 'southwest' | 'northwest'
  | 'entropy' | 'attention';

export interface BackgroundColor {
  r: number;
  g: number;
  b: number;
  alpha?: number;
}
export type BackgroundInput = string | BackgroundColor;

export interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: ResizeFit;
  position?: ResizePosition;
  background?: BackgroundInput;
  kernel?: ResizeKernel;
  withoutEnlargement?: boolean;
  withoutReduction?: boolean;
  /** Accepted for sharp parity but has no effect — simdra has no
   *  shrink-on-load decoder integration. */
  fastShrinkOnLoad?: boolean;
}

export type ExtendWithMode = 'background' | 'copy' | 'repeat' | 'mirror';

/** Sharp's extend() argument: per-edge counts + fill mode + background. */
export interface ExtendOptions {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  extendWith?: ExtendWithMode;
  background?: BackgroundInput;
}

export interface ExtractRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TrimOptions {
  background?: BackgroundInput;
  /** Allowed per-channel difference from `background`; default 10. */
  threshold?: number;
  /** Accepted for sharp parity — silently ignored (libvips-specific
   *  hint that doesn't map to our threshold metric). */
  lineArt?: boolean;
}

/** Sharp's composite blend mode strings (libvips/cairo names). Mapped
 *  internally to simdra's HTML5-shaped enum. `dest` is identity (no
 *  draw). `clear` and `saturate` throw — simdra has no equivalent. */
export type CompositeBlend =
  | 'clear' | 'source' | 'over' | 'in' | 'out' | 'atop'
  | 'dest' | 'dest-over' | 'dest-in' | 'dest-out' | 'dest-atop'
  | 'xor' | 'add' | 'saturate'
  | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'colour-dodge' | 'color-dodge' | 'colour-burn' | 'color-burn'
  | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion';

/** Channel index or sharp-style channel name. */
export type ChannelSelector = 0 | 1 | 2 | 3 | 'red' | 'green' | 'blue' | 'alpha';

/** Bitwise band-boolean op for `bandbool()`. `eor` is libvips's name
 *  for XOR; both `xor` and `eor` are accepted at the JS layer. */
export type BandBoolOp = 'and' | 'or' | 'eor' | 'xor';

/** Sharp's gravity strings for composite placement. Same set as
 *  `ResizePosition` minus the content-aware strategies. */
export type CompositeGravity =
  | 'centre' | 'center'
  | 'top' | 'right' | 'bottom' | 'left'
  | 'top right' | 'right top' | 'top left' | 'left top'
  | 'bottom right' | 'right bottom' | 'bottom left' | 'left bottom'
  | 'north' | 'east' | 'south' | 'west'
  | 'northeast' | 'southeast' | 'southwest' | 'northwest';

/** Sharp-style raw-pixel descriptor — sibling of `input`, not nested.
 *  When set, `input` is treated as raw RGBA bytes of the given dims. */
export interface CompositeRawDescriptor {
  width: number;
  height: number;
  /** Currently must be `4` (RGBA). 1-channel grey, 2-channel grey+alpha,
   *  and 3-channel RGB inputs are rejected — the blend kernels operate
   *  on RGBA8 only. */
  channels: number;
}

/** "Create" input for a composite overlay — a flat-colour rectangle
 *  built on the fly. Mirrors sharp's `{ input: { create: ... } }`. */
export interface CompositeCreateInput {
  width: number;
  height: number;
  channels: 3 | 4;
  background: BackgroundInput;
}

export type CompositeOverlayInput =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | Response
  | { create: CompositeCreateInput };

export interface CompositeImage {
  /** Encoded image bytes, a stream/blob/response producing them, or a
   *  `{ create }` flat-colour rectangle. To pass raw RGBA pixels, set
   *  `input` to the byte buffer AND provide a sibling `raw: {width,
   *  height, channels}` (sharp parity). */
  input: CompositeOverlayInput;
  /** Sharp-style raw-pixel descriptor — sibling of `input`. When set,
   *  `input` is interpreted as RGBA bytes of the given dimensions
   *  rather than as encoded image bytes. */
  raw?: CompositeRawDescriptor;
  /** Blend mode (libvips/cairo name); default `'over'` (source-over). */
  blend?: CompositeBlend;
  /** Anchor for placement when `top`/`left` aren't given. Default
   *  `'centre'`. Ignored when both `top` and `left` are provided. */
  gravity?: CompositeGravity;
  /** Explicit pixel offset from the top edge. Pairs with `left` to
   *  override `gravity`. */
  top?: number;
  /** Explicit pixel offset from the left edge. Pairs with `top` to
   *  override `gravity`. */
  left?: number;
  /** Tile the overlay across the base bitmap. */
  tile?: boolean;
  /** Sharp's premultiplied flag — accepted for compatibility but not
   *  applied: simdra always uses non-premultiplied bytes at the
   *  bitmap layer. The blend math is done in-channel by the canvas
   *  blit kernels, which is the libvips-equivalent semantic. */
  premultiplied?: boolean;
  /** Accepted but ignored — simdra doesn't parse EXIF orientation. */
  autoOrient?: boolean;
  /** Accepted but ignored — simdra doesn't decode multi-frame inputs
   *  in the composite path. */
  animated?: boolean;
  /** Accepted but ignored — DPI is meaningful only for vector inputs
   *  (SVG/PDF) we don't decode. */
  density?: number;
}

/** Per-call PNG options scoped to what stb_image_write exposes. */
export interface PngOptions {
  /** stb's compression level (0 = fastest/largest, 9 = slowest/smallest).
   *  Wraps stb's process-global `stbi_write_png_compression_level` under
   *  a mutex on the Zig side, so concurrent encodes from different
   *  pthreads (native build) don't race on the level. */
  compressionLevel?: number;
}

/** Per-call JPEG options scoped to what stb_image_write exposes. */
export interface JpegOptions {
  /** HTML5-style 0.0–1.0 quality. Mapped to stb's 1–100 scale internally. */
  quality?: number;
}

/** Source-format names returned from `metadata().format` (signature sniff). */
export type ImageFormatName = 'png' | 'jpeg' | 'bmp' | 'gif' | 'unknown';

/** Output info attached to `toBuffer({ resolveWithObject: true })`. Shape
 *  is intentionally narrower than sharp's — only fields that have an
 *  honest answer with stb_image_write's encoders are populated.
 *  `premultiplied`, crop offsets, attention focal points, animation
 *  metadata, and `textAutofitDpi` are libvips features and are not set. */
export interface OutputInfo {
  format: ImageFormat;
  size: number;
  width: number;
  height: number;
  /** PNG = 4 (RGBA preserved), JPEG = 3 (alpha dropped — JPEG can't store
   *  alpha), BMP = 4 (32-bit V4 with alpha mask), raw = 4 (RGBA pixels). */
  channels: number;
}

/** Options for the `toBuffer()` terminal. */
export interface ToBufferOptions {
  /** When `true`, the terminal resolves with `{ data, info }` instead of
   *  just `data`. Mirrors sharp's option of the same name. */
  resolveWithObject?: boolean;
}

/**
 * Header-only metadata, mirroring sharp's `metadata()` semantics — populated
 * from stb_image's `stbi_info_from_memory` + `stbi_is_16_bit_from_memory`
 * fast path with no pixel decode and no allocation.
 *
 * The fields are limited to what stb_image's public API actually exposes;
 * sharp's libvips-backed extras (ICC, EXIF, density, orientation, pages,
 * isProgressive, …) are not surfaced because the decoder doesn't read them.
 */
export interface Metadata {
  /** Container detected by signature sniff. `'unknown'` if no match. */
  format: ImageFormatName;
  /** Pixel width as stored in the file header. */
  width: number;
  /** Pixel height as stored in the file header. */
  height: number;
  /** Source channel count: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA. */
  channels: number;
  /** True iff `channels === 2 || channels === 4`. */
  hasAlpha: boolean;
  /** Bits per channel sample (8 or 16) per stb_image. */
  bitsPerSample: number;
  /** Total input size in bytes (sharp parity for `Buffer` / stream input). */
  size: number;
}

export type MicroSharpInput =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | Response;

interface ResizeOp {
  kind: 'resize';
  width?: number;
  height?: number;
  opts?: ResizeOptions;
}
interface ExtendOp {
  kind: 'extend';
  opts: ExtendOptions | number;
}
interface ExtractOp {
  kind: 'extract';
  region: ExtractRegion;
}
interface TrimOp {
  kind: 'trim';
  opts?: TrimOptions;
}
interface CompositeOp {
  kind: 'composite';
  images: CompositeImage[];
}
interface RemoveAlphaOp {
  kind: 'removeAlpha';
}
interface EnsureAlphaOp {
  kind: 'ensureAlpha';
  alpha?: number;
}
interface ExtractChannelOp {
  kind: 'extractChannel';
  channel: number;
}
interface BandboolOp {
  kind: 'bandbool';
  op: 'and' | 'or' | 'eor';
}
interface JoinChannelOp {
  kind: 'joinChannel';
  image: CompositeOverlayInput;
  raw?: { width: number; height: number; channels: number };
}
interface GreyscaleOp {
  kind: 'greyscale';
}
interface TintOp {
  kind: 'tint';
  r: number;
  g: number;
  b: number;
}
interface RotateOp {
  kind: 'rotate';
  /** Pre-normalised positive angle in [0, 360). */
  angle: number;
  bg: [number, number, number, number];
}
interface AutoOrientOp {
  kind: 'autoOrient';
}
interface FlipOp {
  kind: 'flip';
}
interface FlopOp {
  kind: 'flop';
}
interface AffineOp {
  kind: 'affine';
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  idx: number;
  idy: number;
  odx: number;
  ody: number;
  bg: [number, number, number, number];
  interp: InterpolatorName;
}
interface BlurOp {
  kind: 'blur';
  /** undefined = fast 3×3 box; finite = Gaussian sigma. */
  sigma?: number;
  precision: BlurPrecisionName;
  minAmplitude: number;
}
interface SharpenOp {
  kind: 'sharpen';
  /** undefined = fast 3×3 unsharp kernel; finite = USM sigma. */
  sigma?: number;
  m1: number;
  m2: number;
  x1: number;
  y2: number;
  y3: number;
}
interface ConvolveOp {
  kind: 'convolve';
  width: number;
  height: number;
  kernel: Float64Array;
  scale: number;
  offset: number;
}
interface MedianOp {
  kind: 'median';
  size: number;
}
interface DilateOp {
  kind: 'dilate';
  width: number;
}
interface ErodeOp {
  kind: 'erode';
  width: number;
}
interface GammaOp {
  kind: 'gamma';
  gIn: number;
  gOut: number;
}
interface NegateOp {
  kind: 'negate';
  alpha: boolean;
}
interface LinearOp {
  kind: 'linear';
  a: Float64Array;
  b: Float64Array;
}
interface ThresholdOp {
  kind: 'threshold';
  t: number;
  greyscale: boolean;
}
interface RecombOp {
  kind: 'recomb';
  matrix: Float64Array;
}
interface FlattenOp {
  kind: 'flatten';
  bg: [number, number, number, number];
}
interface UnflattenOp {
  kind: 'unflatten';
}
interface BooleanOp {
  kind: 'boolean';
  operand: CompositeOverlayInput;
  raw?: { width: number; height: number; channels: number };
  op: 'and' | 'or' | 'eor';
}
interface NormaliseOp {
  kind: 'normalise';
  lower: number;
  upper: number;
}
interface ClaheOp {
  kind: 'clahe';
  width: number;
  height: number;
  maxSlope: number;
}
interface ModulateOp {
  kind: 'modulate';
  brightness: number;
  saturation: number;
  hue: number;
  lightness: number;
}

type Op =
  | ResizeOp | ExtendOp | ExtractOp | TrimOp | CompositeOp
  | RemoveAlphaOp | EnsureAlphaOp | ExtractChannelOp | BandboolOp
  | JoinChannelOp
  | GreyscaleOp | TintOp
  | RotateOp | AutoOrientOp | FlipOp | FlopOp | AffineOp
  | BlurOp | SharpenOp | ConvolveOp | MedianOp | DilateOp | ErodeOp
  | GammaOp | NegateOp | LinearOp | ThresholdOp | RecombOp
  | FlattenOp | UnflattenOp | BooleanOp
  | NormaliseOp | ClaheOp | ModulateOp;

/** Sharp's affine `interpolator` option. Mapped to simdra's two
 *  bitmap-direct samplers (nearest / bilinear). The libvips-only
 *  kernels (`nohalo`, `lbb`, `vsqbs`) collapse to `bilinear` — they
 *  exist in libvips for very-precise resamplers we don't ship. */
export type AffineInterpolator =
  | 'nearest' | 'bilinear' | 'bicubic'
  | 'nohalo' | 'lbb' | 'vsqbs';

const AFFINE_INTERP_MAP: Record<string, InterpolatorName> = {
  'nearest': 'nearest',
  'bilinear': 'bilinear',
  'bicubic': 'bilinear',
  'nohalo': 'bilinear',
  'lbb': 'bilinear',
  'vsqbs': 'bilinear',
};

function resolveAffineInterpolator(name: AffineInterpolator | undefined): InterpolatorName {
  if (name === undefined) return 'bilinear';
  const norm = String(name).toLowerCase();
  const k = AFFINE_INTERP_MAP[norm];
  if (k === undefined) {
    throw new RangeError(
      `microsharp: affine interpolator '${name}' not supported; ` +
      `expected one of nearest, bilinear, bicubic, nohalo, lbb, vsqbs`,
    );
  }
  return k;
}

export interface RotateOptions {
  background?: BackgroundInput;
}

/** Sharp's `blur(opts)` argument set. Bare `sigma` number is also
 *  accepted in the method signature. `precision` defaults to
 *  `'integer'` (matches sharp). */
export interface BlurOptions {
  sigma?: number;
  precision?: BlurPrecisionName;
  minAmplitude?: number;
}

/** Sharp's `sharpen(opts)` argument set. */
export interface SharpenOptions {
  sigma?: number;
  m1?: number;
  m2?: number;
  x1?: number;
  y2?: number;
  y3?: number;
}

/** Sharp's `convolve(kernel)` argument. `kernel` is row-major and must
 *  have `width * height` entries. `scale` defaults to the sum of
 *  kernel values; `offset` defaults to 0. */
export interface ConvolveKernel {
  width: number;
  height: number;
  kernel: ArrayLike<number>;
  scale?: number;
  offset?: number;
}

export interface NegateOptions {
  /** Whether to negate the alpha channel. Sharp default: `true`. */
  alpha?: boolean;
}

export interface ThresholdOptions {
  /** Convert to single-channel greyscale before thresholding (sharp
   *  default: `true`). When `false`, threshold is applied per RGB
   *  channel. */
  greyscale?: boolean;
  /** Alternative spelling for `greyscale` (sharp parity). */
  grayscale?: boolean;
}

export interface FlattenOptions {
  /** Background colour to merge alpha against. Sharp default `#000000`. */
  background?: BackgroundInput;
}

export type BooleanOperator = 'and' | 'or' | 'eor';

export interface BooleanOptions {
  /** Sharp's raw-pixel descriptor — sibling of `operand`. When set,
   *  the operand bytes are interpreted as RGBA / RGB / grey of the
   *  given dimensions rather than encoded image bytes. */
  raw?: CompositeRawDescriptor;
}

export interface NormaliseOptions {
  /** Percentile below which luma is clipped to 0. Sharp default 1. */
  lower?: number;
  /** Percentile above which luma is clipped to 255. Sharp default 99. */
  upper?: number;
}

export interface ClaheOptions {
  /** Tile width in pixels. Required. */
  width: number;
  /** Tile height in pixels. Required. */
  height: number;
  /** Contrast-clip slope. Sharp default 3; 0 disables clipping. */
  maxSlope?: number;
}

export interface ModulateOptions {
  /** Multiplier on V (HSV value). Default 1. */
  brightness?: number;
  /** Multiplier on S (HSV saturation). Default 1. */
  saturation?: number;
  /** Hue rotation in degrees. Default 0. */
  hue?: number;
  /** Additive offset on V (luminance). Default 0. */
  lightness?: number;
}

/** Sharp's `recomb(inputMatrix)` matrix shape: 3×3 (RGB-only) or 4×4
 *  (full RGBA). Accepts row-major flat lists too. */
export type RecombMatrix =
  | readonly [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ]
  | readonly [
      readonly [number, number, number, number],
      readonly [number, number, number, number],
      readonly [number, number, number, number],
      readonly [number, number, number, number],
    ]
  | ArrayLike<number>;

export interface AffineOptions {
  background?: BackgroundInput;
  idx?: number;
  idy?: number;
  odx?: number;
  ody?: number;
  interpolator?: AffineInterpolator;
}

/** Sharp's `affine(matrix, ...)` — matrix is a length-4 array
 *  `[a, b, c, d]` (row-major: `[[a, b], [c, d]]`) or a 2×2 nested
 *  form `[[a, b], [c, d]]`. */
export type AffineMatrix = readonly [number, number, number, number]
  | readonly [readonly [number, number], readonly [number, number]];

/** libvips colourspace vocabulary (`VipsInterpretation`) sharp accepts on
 *  `pipelineColourspace` / `toColourspace`. simdra is fixed at RGBA8 sRGB,
 *  so the only values that change pixel output are `b-w` / `grey16`
 *  (treated as greyscale); the rest are accepted-but-no-op passthroughs.
 *  Unrecognised strings throw `RangeError`. */
const COLOURSPACES: ReadonlySet<string> = new Set([
  'multiband', 'b-w', 'histogram', 'xyz', 'lab', 'cmyk', 'labq', 'rgb',
  'cmc', 'lch', 'labs', 'srgb', 'yxy', 'fourier', 'rgb16', 'grey16',
  'matrix', 'scrgb', 'hsv', 'last',
]);
/** Subset that maps to a greyscale step in our 8-bit pipeline. */
const GREY_COLOURSPACES: ReadonlySet<string> = new Set(['b-w', 'grey16']);

const BLUR_PRECISIONS: ReadonlySet<BlurPrecisionName> =
  new Set(['integer', 'float', 'approximate']);

function resolveBlurPrecision(p: BlurPrecisionName | string): BlurPrecisionName {
  const norm = String(p).toLowerCase() as BlurPrecisionName;
  if (!BLUR_PRECISIONS.has(norm)) {
    throw new RangeError(
      `microsharp: blur({ precision: '${p}' }) — expected 'integer' | 'float' | 'approximate'`,
    );
  }
  return norm;
}

function normaliseColourspace(cs: string | undefined, label: string): string | undefined {
  if (cs === undefined) return undefined;
  const norm = String(cs).toLowerCase().trim();
  if (!COLOURSPACES.has(norm)) {
    throw new RangeError(
      `microsharp: ${label}('${cs}') — not a recognised libvips colourspace; ` +
      `expected one of ${[...COLOURSPACES].join(', ')}`,
    );
  }
  return norm;
}

export class MicroSharpPipeline {
  private readonly input: MicroSharpInput;
  private materialized: Promise<Uint8Array> | null = null;
  private outputFormat: ImageFormat = 'png';
  private jpegQuality = 92;
  private pngCompressionLevel: number | null = null;
  private readonly ops: Op[] = [];
  /** Recorded `pipelineColourspace`. `'b-w'`/`'grey16'` injects a leading
   *  greyscale at apply time; other recognised values are no-ops on our
   *  RGBA8 sRGB pipeline (documented in COMPATIBILITY.md). */
  private pipelineColourspaceSetting: string | undefined;
  /** Recorded `toColourspace`. Same semantics as the pipeline knob, but
   *  the greyscale (when triggered) runs *after* all queued ops. */
  private toColourspaceSetting: string | undefined;

  constructor(input: MicroSharpInput) {
    this.input = input;
  }

  /**
   * Sharp-shaped resize. Three call forms:
   *   .resize(width, height, opts?)
   *   .resize(width, opts?) — auto-scales height from source aspect
   *   .resize({ width, height, ...opts })
   *
   * Per sharp: only one resize op survives per pipeline; subsequent
   * `.resize()` calls replace the recorded op rather than appending.
   */
  resize(
    widthOrOpts?: number | (ResizeOptions & { width?: number; height?: number }) | null,
    heightOrOpts?: number | ResizeOptions | null,
    opts?: ResizeOptions,
  ): this {
    let width: number | undefined;
    let height: number | undefined;
    let resolved: ResizeOptions | undefined;

    if (widthOrOpts != null && typeof widthOrOpts === 'object') {
      width = widthOrOpts.width;
      height = widthOrOpts.height;
      resolved = widthOrOpts;
    } else {
      width = widthOrOpts ?? undefined;
      if (typeof heightOrOpts === 'number') {
        height = heightOrOpts;
        resolved = opts;
      } else if (heightOrOpts != null && typeof heightOrOpts === 'object') {
        resolved = heightOrOpts;
      }
    }

    // Replace any previously-recorded resize. Sharp behaves the same.
    const idx = this.ops.findIndex((o) => o.kind === 'resize');
    const op: ResizeOp = { kind: 'resize', width, height, opts: resolved };
    if (idx >= 0) this.ops[idx] = op;
    else this.ops.push(op);
    return this;
  }

  /** Pad / extrude the image. Sharp accepts a number (all four edges)
   *  or a per-edge object with optional `extendWith` and `background`. */
  extend(opts: number | ExtendOptions): this {
    this.ops.push({ kind: 'extend', opts });
    return this;
  }

  /** Crop a sub-rectangle. Validated against the *current* bitmap at
   *  apply time, not at queue time. */
  extract(region: ExtractRegion): this {
    if (
      !Number.isInteger(region.left) || region.left < 0 ||
      !Number.isInteger(region.top) || region.top < 0 ||
      !Number.isInteger(region.width) || region.width < 1 ||
      !Number.isInteger(region.height) || region.height < 1
    ) {
      throw new RangeError(
        'microsharp: extract() requires non-negative integer left/top and positive integer width/height',
      );
    }
    this.ops.push({ kind: 'extract', region });
    return this;
  }

  /** Trim background-coloured edges. Default background = top-left
   *  pixel of the working bitmap (sharp parity); default threshold = 10. */
  trim(opts?: TrimOptions): this {
    this.ops.push({ kind: 'trim', opts });
    return this;
  }

  /** Composite one or more overlays onto the working bitmap. Each
   *  entry's `input` is materialized at apply time (so streams, blobs,
   *  and responses work for overlays just like they do for the
   *  pipeline's primary input). Overlays are drawn in array order;
   *  later entries can blend over earlier ones. */
  composite(images: CompositeImage[]): this {
    if (!Array.isArray(images)) {
      throw new TypeError('microsharp: composite() expects an array of images');
    }
    this.ops.push({ kind: 'composite', images });
    return this;
  }

  /** Strip alpha — sets α=255 on every pixel. Sharp's docs describe
   *  this as "the output image is a 3 channel image without an alpha
   *  channel"; in microsharp the buffer remains 4-channel for
   *  pipeline-shape invariance, but the result is visibly identical
   *  (all pixels fully opaque). */
  removeAlpha(): this {
    this.ops.push({ kind: 'removeAlpha' });
    return this;
  }

  /** Sharp's `ensureAlpha([alpha])`. Microsharp bitmaps always carry
   *  an alpha channel, so this is a no-op without an argument. With
   *  an explicit `alpha` (0..1) the channel is set to that constant
   *  level — useful right after `removeAlpha` to set a non-opaque
   *  uniform alpha, or to force a known transparency level on a
   *  decoded source. */
  ensureAlpha(alpha?: number): this {
    if (alpha !== undefined) {
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
        throw new RangeError('microsharp: ensureAlpha(α) expects α in [0, 1]');
      }
    }
    this.ops.push({ kind: 'ensureAlpha', alpha });
    return this;
  }

  /** Extract a single channel as a greyscale image. `channel` accepts
   *  the integer index 0/1/2/3 or sharp's string names
   *  'red'/'green'/'blue'/'alpha'. The result is RGB = chosen channel,
   *  α = 255. */
  extractChannel(channel: ChannelSelector): this {
    const idx = resolveChannel(channel);
    this.ops.push({ kind: 'extractChannel', channel: idx });
    return this;
  }

  /** Per-pixel bitwise op across R, G, B channels — produces a
   *  greyscale image where each pixel is `(R op G op B)` broadcast.
   *  Accepts sharp's `'and'` / `'or'` / `'eor'` (libvips name for
   *  XOR); plain `'xor'` is also accepted. */
  bandbool(op: BandBoolOp): this {
    const norm = op === 'xor' ? 'eor' : op;
    if (norm !== 'and' && norm !== 'or' && norm !== 'eor') {
      throw new RangeError(
        `microsharp: bandbool() expects 'and' | 'or' | 'eor' (got ${String(op)})`,
      );
    }
    this.ops.push({ kind: 'bandbool', op: norm });
    return this;
  }

  /** Sharp's `tint(colour)` — recolour using the given RGB tint while
   *  preserving the per-pixel luminance pattern. Alpha is unchanged
   *  (sharp spec). The colour can be a CSS string or
   *  `{ r, g, b, alpha? }` object; the alpha component is parsed for
   *  compatibility but ignored — the tint operation is RGB-only. */
  tint(colour: BackgroundInput): this {
    const [r, g, b] = parseBackground(colour, [0, 0, 0, 255]);
    this.ops.push({ kind: 'tint', r, g, b });
    return this;
  }

  /** Sharp's `rotate([angle], [opts])`. With no arguments this is the
   *  back-compat alias for `autoOrient()`. With a finite angle it
   *  rotates by that many degrees clockwise, padding with `background`
   *  (default opaque black). Multiples of 90° are byte-exact (lossless
   *  index permutation); other angles sample through bilinear
   *  interpolation against the source-bbox AABB. Sharp parity:
   *  multi-page input is not supported — simdra decodes one frame. */
  rotate(angle?: number, opts?: RotateOptions): this {
    if (angle === undefined) {
      this.ops.push({ kind: 'autoOrient' });
      return this;
    }
    if (!Number.isFinite(angle)) {
      throw new RangeError('microsharp: rotate(angle) must be a finite number');
    }
    // Normalise to [0, 360). Sharp does the same: -450 → 270.
    let a = angle % 360;
    if (a < 0) a += 360;
    const bg = parseBackground(opts?.background, [0, 0, 0, 255]);
    this.ops.push({ kind: 'rotate', angle: a, bg });
    return this;
  }

  /** Sharp's `autoOrient()` — read the EXIF Orientation tag from the
   *  input bytes and apply the corresponding rotation / mirror. simdra
   *  parses Orientation only (no full EXIF library); the tag is read
   *  by `SmBitmap.peekOrientation` against the materialised input
   *  bytes at apply time. Missing / malformed EXIF → no-op. */
  autoOrient(): this {
    this.ops.push({ kind: 'autoOrient' });
    return this;
  }

  /** Sharp's `flip([on])` — mirror vertically (top↔bottom). */
  flip(on: boolean = true): this {
    if (on) this.ops.push({ kind: 'flip' });
    return this;
  }

  /** Sharp's `flop([on])` — mirror horizontally (left↔right). */
  flop(on: boolean = true): this {
    if (on) this.ops.push({ kind: 'flop' });
    return this;
  }

  /** Sharp's `affine(matrix, [opts])`. `matrix` is `[a, b, c, d]`
   *  (`[[a, b], [c, d]]`) — the linear part of `F(x, y) = M·(x+idx,
   *  y+idy) + (odx, ody)`. Output dims = forward bbox of the input
   *  rectangle; the gap is padded with `background` (default opaque
   *  black). `interpolator` accepts sharp/libvips kernel names; the
   *  three high-precision kernels libvips ships (`nohalo`/`lbb`/
   *  `vsqbs`) collapse to `bilinear` here — see COMPATIBILITY.md. */
  affine(matrix: AffineMatrix, opts?: AffineOptions): this {
    const m = flattenAffineMatrix(matrix);
    const bg = parseBackground(opts?.background, [0, 0, 0, 255]);
    const interp = resolveAffineInterpolator(opts?.interpolator);
    this.ops.push({
      kind: 'affine',
      m00: m[0], m01: m[1], m10: m[2], m11: m[3],
      idx: opts?.idx ?? 0,
      idy: opts?.idy ?? 0,
      odx: opts?.odx ?? 0,
      ody: opts?.ody ?? 0,
      bg,
      interp,
    });
    return this;
  }

  /** Sharp's `blur([opts])`.
   *   - No args / `true`: fast 3×3 box blur.
   *   - `false`: no-op (records nothing).
   *   - bare `sigma` number: Gaussian blur with the chosen sigma.
   *   - `{ sigma, precision, minAmplitude }`: same with explicit
   *     working-precision and kernel-amplitude cutoff.
   *   `precision` defaults to `'integer'`; `minAmplitude` to `0.2`
   *   (sharp's defaults). Sigma must be in [0.3, 1000]. */
  blur(opts?: number | boolean | BlurOptions): this {
    if (opts === false) return this;
    if (opts === undefined || opts === true) {
      this.ops.push({ kind: 'blur', precision: 'integer', minAmplitude: 0.2 });
      return this;
    }
    let sigma: number | undefined;
    let precision: BlurPrecisionName = 'integer';
    let minAmplitude = 0.2;
    if (typeof opts === 'number') {
      sigma = opts;
    } else {
      sigma = opts.sigma;
      if (opts.precision !== undefined) precision = resolveBlurPrecision(opts.precision);
      if (opts.minAmplitude !== undefined) {
        if (!Number.isFinite(opts.minAmplitude) || opts.minAmplitude <= 0 || opts.minAmplitude >= 1) {
          throw new RangeError(
            'microsharp: blur({ minAmplitude }) must be in (0, 1)',
          );
        }
        minAmplitude = opts.minAmplitude;
      }
    }
    if (sigma !== undefined) {
      if (!Number.isFinite(sigma) || sigma < 0.3 || sigma > 1000) {
        throw new RangeError('microsharp: blur(sigma) must be in [0.3, 1000]');
      }
    }
    this.ops.push({ kind: 'blur', sigma, precision, minAmplitude });
    return this;
  }

  /** Sharp's `sharpen([opts], [flat], [jagged])`.
   *   - No args: fast 3×3 unsharp kernel `[[0,-1,0],[-1,5,-1],[0,-1,0]]`.
   *   - `{ sigma, m1, m2, x1, y2, y3 }`: libvips USM with the flat /
   *     jagged piecewise gain. Per-channel in 8-bit sRGB (sharp's
   *     LAB-L pipeline isn't available — documented 🟡 in COMPATIBILITY).
   *   - Deprecated 2-positional form `sharpen(sigma, flat, jagged)`:
   *     surfaces with `flat = m1`, `jagged = m2`. Sharp parity. */
  sharpen(opts?: number | SharpenOptions, flat?: number, jagged?: number): this {
    let sigma: number | undefined;
    let m1: number = 1.0;
    let m2: number = 2.0;
    let x1: number = 2.0;
    let y2: number = 10.0;
    let y3: number = 20.0;
    if (typeof opts === 'number') {
      sigma = opts;
      if (typeof flat === 'number') m1 = flat;
      if (typeof jagged === 'number') m2 = jagged;
    } else if (opts !== undefined) {
      sigma = opts.sigma;
      if (opts.m1 !== undefined) m1 = opts.m1;
      if (opts.m2 !== undefined) m2 = opts.m2;
      if (opts.x1 !== undefined) x1 = opts.x1;
      if (opts.y2 !== undefined) y2 = opts.y2;
      if (opts.y3 !== undefined) y3 = opts.y3;
    }
    // Sharp's published bounds: sigma ∈ [0.000001, 10] when set.
    if (sigma !== undefined) {
      if (!Number.isFinite(sigma) || sigma < 0.000001 || sigma > 10) {
        throw new RangeError('microsharp: sharpen({ sigma }) must be in [0.000001, 10]');
      }
    }
    for (const [name, v] of [
      ['m1', m1], ['m2', m2], ['x1', x1], ['y2', y2], ['y3', y3],
    ] as const) {
      if (!Number.isFinite(v) || v < 0 || v > 1_000_000) {
        throw new RangeError(`microsharp: sharpen({ ${name} }) must be in [0, 1000000]`);
      }
    }
    this.ops.push({ kind: 'sharpen', sigma, m1, m2, x1, y2, y3 });
    return this;
  }

  /** Sharp's `median([size])`. Square `size × size` window per RGB
   *  channel; α preserved. `size` defaults to 3 and must be odd. */
  median(size: number = 3): this {
    if (!Number.isInteger(size) || size < 1 || (size & 1) === 0 || size > 99) {
      throw new RangeError('microsharp: median(size) must be an odd integer in [1, 99]');
    }
    this.ops.push({ kind: 'median', size });
    return this;
  }

  /** Sharp's `dilate([width])`. Foreground expansion by a separable
   *  `(2·width+1)`-square max-window. `width` defaults to 1. */
  dilate(width: number = 1): this {
    if (!Number.isInteger(width) || width < 0 || width > 250) {
      throw new RangeError('microsharp: dilate(width) must be an integer in [0, 250]');
    }
    this.ops.push({ kind: 'dilate', width });
    return this;
  }

  /** Sharp's `erode([width])`. Foreground shrinking — same shape as
   *  `dilate`, opposite kernel direction. */
  erode(width: number = 1): this {
    if (!Number.isInteger(width) || width < 0 || width > 250) {
      throw new RangeError('microsharp: erode(width) must be an integer in [0, 250]');
    }
    this.ops.push({ kind: 'erode', width });
    return this;
  }

  /** Sharp's `convolve(kernel)`. `kernel.kernel` length must equal
   *  `width · height`; both dims must be odd. `scale` defaults to the
   *  sum of kernel values; `offset` defaults to 0. Edge mode is
   *  clamp (libvips's default). */
  convolve(spec: ConvolveKernel): this {
    if (!Number.isInteger(spec.width) || spec.width < 1 || (spec.width & 1) === 0) {
      throw new RangeError('microsharp: convolve.width must be an odd positive integer');
    }
    if (!Number.isInteger(spec.height) || spec.height < 1 || (spec.height & 1) === 0) {
      throw new RangeError('microsharp: convolve.height must be an odd positive integer');
    }
    const expected = spec.width * spec.height;
    if (spec.kernel.length !== expected) {
      throw new RangeError(
        `microsharp: convolve.kernel length ${spec.kernel.length} ≠ width·height (${expected})`,
      );
    }
    const k = new Float64Array(expected);
    let sum = 0;
    for (let i = 0; i < expected; i++) {
      const v = Number(spec.kernel[i]);
      if (!Number.isFinite(v)) {
        throw new RangeError('microsharp: convolve.kernel entries must be finite numbers');
      }
      k[i] = v;
      sum += v;
    }
    let scale: number;
    if (spec.scale === undefined) {
      // Sharp's default: kernel sum. Fallback to 1 when sum is zero
      // (e.g. derivative kernels like Sobel).
      scale = sum === 0 ? 1 : sum;
    } else {
      if (!Number.isFinite(spec.scale) || spec.scale === 0) {
        throw new RangeError('microsharp: convolve.scale must be a finite non-zero number');
      }
      scale = spec.scale;
    }
    const offset = spec.offset ?? 0;
    if (!Number.isFinite(offset)) {
      throw new RangeError('microsharp: convolve.offset must be a finite number');
    }
    this.ops.push({ kind: 'convolve', width: spec.width, height: spec.height, kernel: k, scale, offset });
    return this;
  }

  /** Sharp's `gamma([gamma], [gammaOut])`. Applies a single LUT
   *  `(in/255)^(gIn/gOut)·255` per RGB channel; α preserved. Sharp's
   *  pre-/post-resize coupling collapses to a single pass without an
   *  intervening resize — documented 🟡 in COMPATIBILITY.md. Both
   *  values must be in [1.0, 3.0]; `gOut` defaults to `gIn`. */
  gamma(g: number = 2.2, gOut?: number): this {
    if (!Number.isFinite(g) || g < 1.0 || g > 3.0) {
      throw new RangeError('microsharp: gamma(g) must be in [1.0, 3.0]');
    }
    const out = gOut ?? g;
    if (!Number.isFinite(out) || out < 1.0 || out > 3.0) {
      throw new RangeError('microsharp: gamma(_, gOut) must be in [1.0, 3.0]');
    }
    this.ops.push({ kind: 'gamma', gIn: g, gOut: out });
    return this;
  }

  /** Sharp's `negate([opts])`. RGB inverted; α negated when
   *  `opts.alpha !== false` (sharp default `true`). */
  negate(opts?: NegateOptions): this {
    const alpha = opts?.alpha !== false;
    this.ops.push({ kind: 'negate', alpha });
    return this;
  }

  /** Sharp's `linear([a], [b])`. Per-channel `a·C + b` with output
   *  clipped to [0, 255]. Both arguments accept a single number (RGB
   *  broadcast, alpha untouched), a length-3 array (RGB), or a
   *  length-4 array (RGBA). Defaults: `a=1`, `b=0` per channel. */
  linear(a?: number | ArrayLike<number>, b?: number | ArrayLike<number>): this {
    const aArr = expandLinearVec(a, 1, 'a');
    const bArr = expandLinearVec(b, 0, 'b');
    this.ops.push({ kind: 'linear', a: aArr, b: bArr });
    return this;
  }

  /** Sharp's `threshold([t], [opts])`. `t` defaults to 128; sharp
   *  accepts 0..255. With `greyscale=true` (default), Rec.601 luma is
   *  computed first and broadcast. */
  threshold(t: number = 128, opts?: ThresholdOptions): this {
    if (!Number.isInteger(t) || t < 0 || t > 255) {
      throw new RangeError('microsharp: threshold(t) must be an integer in [0, 255]');
    }
    // Sharp accepts both spellings; greyscale wins if both set.
    const grey = opts?.greyscale ?? opts?.grayscale ?? true;
    this.ops.push({ kind: 'threshold', t, greyscale: grey });
    return this;
  }

  /** Sharp's `recomb(matrix)`. 3×3 (RGB only, α preserved) or 4×4
   *  (full RGBA) row-major colour matrix. Accepts nested form
   *  `[[a,b,c],[d,e,f],[g,h,i]]` or flat `[a,b,c,d,e,f,g,h,i]`. */
  recomb(matrix: RecombMatrix): this {
    const m = flattenRecombMatrix(matrix);
    this.ops.push({ kind: 'recomb', matrix: m });
    return this;
  }

  /** Sharp's `flatten([opts])`. Alpha-blend onto an opaque background
   *  and drop alpha. Buffer remains 4-channel for pipeline-shape
   *  invariance (α=255 across the result). */
  flatten(opts?: FlattenOptions): this {
    const bg = parseBackground(opts?.background, [0, 0, 0, 255]);
    this.ops.push({ kind: 'flatten', bg });
    return this;
  }

  /** Sharp's `unflatten()`. Every pixel where `R=G=B=255` becomes
   *  fully transparent (α=0); other pixels are unchanged. */
  unflatten(): this {
    this.ops.push({ kind: 'unflatten' });
    return this;
  }

  /** Sharp's `boolean(operand, operator, [opts])`. Per-pixel bitwise
   *  `and` / `or` / `eor` (libvips name for XOR) across all four
   *  RGBA bands between this bitmap and `operand`. The operand is
   *  materialised at apply time (encoded image bytes by default;
   *  `opts.raw` for pre-decoded pixels — same shape as `joinChannel`). */
  boolean(
    operand: CompositeOverlayInput,
    operator: BooleanOperator | 'xor',
    opts?: BooleanOptions,
  ): this {
    const op = operator === 'xor' ? 'eor' : operator;
    if (op !== 'and' && op !== 'or' && op !== 'eor') {
      throw new RangeError(
        `microsharp: boolean(_, '${operator}') — expected 'and' | 'or' | 'eor' | 'xor'`,
      );
    }
    this.ops.push({ kind: 'boolean', operand, raw: opts?.raw, op });
    return this;
  }

  /** Sharp's `normalise([opts])`. Stretch the luma percentile range
   *  `[lower, upper]` to `[0, 255]` and broadcast the same affine map
   *  to all RGB channels. α preserved. Defaults `lower: 1`, `upper: 99`. */
  normalise(opts?: NormaliseOptions): this {
    const lower = opts?.lower ?? 1;
    const upper = opts?.upper ?? 99;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) ||
        lower < 0 || upper > 100 || lower >= upper) {
      throw new RangeError(
        'microsharp: normalise({ lower, upper }) requires 0 ≤ lower < upper ≤ 100',
      );
    }
    this.ops.push({ kind: 'normalise', lower, upper });
    return this;
  }

  /** Alternative spelling of `normalise()` (sharp parity). */
  normalize(opts?: NormaliseOptions): this {
    return this.normalise(opts);
  }

  /** Sharp's `clahe({ width, height, maxSlope? })`. Tile-based local
   *  histogram equalisation with bilinear interpolation between tile
   *  centres. `maxSlope` defaults to 3 (sharp parity); 0 disables the
   *  contrast clip and reduces to plain AHE. */
  clahe(opts: ClaheOptions): this {
    if (!Number.isInteger(opts.width) || opts.width < 1 || opts.width > 10000) {
      throw new RangeError('microsharp: clahe.width must be a positive integer');
    }
    if (!Number.isInteger(opts.height) || opts.height < 1 || opts.height > 10000) {
      throw new RangeError('microsharp: clahe.height must be a positive integer');
    }
    const maxSlope = opts.maxSlope ?? 3;
    if (!Number.isFinite(maxSlope) || maxSlope < 0 || maxSlope > 100) {
      throw new RangeError('microsharp: clahe.maxSlope must be in [0, 100]');
    }
    this.ops.push({ kind: 'clahe', width: opts.width, height: opts.height, maxSlope });
    return this;
  }

  /** Sharp's `modulate({ brightness, saturation, hue, lightness })`.
   *  Applied in HSV space (sharp uses LCh; documented 🟡 in
   *  COMPATIBILITY.md). All four arguments are optional. α preserved. */
  modulate(opts?: ModulateOptions): this {
    const brightness = opts?.brightness ?? 1;
    const saturation = opts?.saturation ?? 1;
    const hue = opts?.hue ?? 0;
    const lightness = opts?.lightness ?? 0;
    if (!Number.isFinite(brightness) || brightness < 0) {
      throw new RangeError('microsharp: modulate({ brightness }) must be ≥ 0');
    }
    if (!Number.isFinite(saturation) || saturation < 0) {
      throw new RangeError('microsharp: modulate({ saturation }) must be ≥ 0');
    }
    if (!Number.isFinite(hue)) {
      throw new RangeError('microsharp: modulate({ hue }) must be a finite number');
    }
    if (!Number.isFinite(lightness)) {
      throw new RangeError('microsharp: modulate({ lightness }) must be a finite number');
    }
    this.ops.push({ kind: 'modulate', brightness, saturation, hue, lightness });
    return this;
  }

  /** Sharp's `greyscale([on])`. `on` defaults to `true`; passing `false`
   *  records nothing (sharp parity). Computes Rec.601 luma in 8-bit
   *  sRGB space — for a true linear-space conversion sharp recommends
   *  chaining a future `gamma()` op. */
  greyscale(on: boolean = true): this {
    if (on) this.ops.push({ kind: 'greyscale' });
    return this;
  }

  /** Alternative spelling of `greyscale()` (sharp parity). */
  grayscale(on: boolean = true): this {
    return this.greyscale(on);
  }

  /** Sharp's `pipelineColourspace([cs])`. Records the requested input
   *  colourspace; `b-w` / `grey16` triggers a leading greyscale so the
   *  rest of the pipeline runs on luma values. Other recognised libvips
   *  colourspace names are accepted as no-ops because simdra has no
   *  16-bit / LAB / CMYK pipeline (documented in COMPATIBILITY.md).
   *  Unrecognised strings throw `RangeError`. */
  pipelineColourspace(cs?: string): this {
    this.pipelineColourspaceSetting = normaliseColourspace(cs, 'pipelineColourspace');
    return this;
  }

  /** Alternative spelling of `pipelineColourspace()` (sharp parity). */
  pipelineColorspace(cs?: string): this {
    this.pipelineColourspaceSetting = normaliseColourspace(cs, 'pipelineColorspace');
    return this;
  }

  /** Sharp's `toColourspace([cs])`. Records the requested output
   *  colourspace; `b-w` / `grey16` triggers a tail greyscale (buffer
   *  stays 4-channel for pipeline-shape invariance). All other
   *  recognised libvips colourspace names are 8-bit sRGB passthrough
   *  no-ops. Unrecognised strings throw `RangeError`. */
  toColourspace(cs?: string): this {
    this.toColourspaceSetting = normaliseColourspace(cs, 'toColourspace');
    return this;
  }

  /** Alternative spelling of `toColourspace()` (sharp parity). */
  toColorspace(cs?: string): this {
    this.toColourspaceSetting = normaliseColourspace(cs, 'toColorspace');
    return this;
  }

  /** Sharp's `joinChannel(image, options?)` — replace this bitmap's
   *  alpha channel with Rec.601 luma of the joined image's RGB.
   *
   *  Microsharp's always-RGBA model can't grow beyond 4 channels, so
   *  we handle the common case (single mask image → new alpha) rather
   *  than libvips's full N-band append. Multi-image arrays and
   *  multi-band joins beyond RGBA aren't supported: pass a single
   *  Buffer/typed-array, or a `{ raw: { width, height, channels: 1|3|4 } }`
   *  options descriptor for pre-decoded mask pixels.
   *
   *  Greyscale (1-channel) and grey+alpha (1- or 4-channel with
   *  R=G=B) masks round-trip exactly: luma collapses to R. RGB masks
   *  are converted via `0.299·R + 0.587·G + 0.114·B`. */
  joinChannel(
    image: CompositeOverlayInput | CompositeOverlayInput[],
    options?: { raw?: { width: number; height: number; channels: number } },
  ): this {
    if (Array.isArray(image)) {
      if (image.length !== 1) {
        throw new RangeError(
          'microsharp: joinChannel() accepts a single image (libvips multi-band join not supported in the always-RGBA model)',
        );
      }
      image = image[0];
    }
    this.ops.push({ kind: 'joinChannel', image, raw: options?.raw });
    return this;
  }

  png(opts?: PngOptions): this {
    this.outputFormat = 'png';
    if (opts?.compressionLevel !== undefined) {
      const lvl = opts.compressionLevel;
      if (!Number.isInteger(lvl) || lvl < 0 || lvl > 9) {
        throw new RangeError(
          'microsharp: png({ compressionLevel }) must be an integer in [0, 9]',
        );
      }
      this.pngCompressionLevel = lvl;
    } else {
      this.pngCompressionLevel = null;
    }
    return this;
  }

  /** `quality` is the HTML5 0.0–1.0 range; default 0.92 (Chromium default).
   *  Accepts either a bare number or sharp's `{ quality }` object form. */
  jpeg(opts?: number | JpegOptions): this {
    this.outputFormat = 'jpeg';
    const quality = typeof opts === 'number' ? opts : opts?.quality;
    if (quality !== undefined) {
      const f = Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0.92;
      this.jpegQuality = Math.max(1, Math.min(100, Math.round(f * 100)));
    }
    return this;
  }

  /** 32-bit BMP V4 (stb's `comp=4` path; preserves alpha via BI_BITFIELDS). */
  bmp(): this {
    this.outputFormat = 'bmp';
    return this;
  }

  /** Raw RGBA pixel data. Channel ordering is RGBA, top-to-bottom, no
   *  padding (forced 4-channel by the stb_image decode path). */
  raw(): this {
    this.outputFormat = 'raw';
    return this;
  }

  /** Force output format. Sharp accepts an object with an `id` attribute
   *  for libvips-specific format options; we accept the string only. */
  toFormat(format: ImageFormat): this {
    if (format !== 'png' && format !== 'jpeg' && format !== 'bmp' && format !== 'raw') {
      throw new RangeError(
        `microsharp: toFormat() expects 'png' | 'jpeg' | 'bmp' | 'raw' (got ${String(format)})`,
      );
    }
    this.outputFormat = format;
    return this;
  }

  toBuffer(opts: ToBufferOptions & { resolveWithObject: true }):
    Promise<{ data: Uint8Array; info: OutputInfo }>;
  toBuffer(opts?: ToBufferOptions): Promise<Uint8Array>;
  async toBuffer(
    opts?: ToBufferOptions,
  ): Promise<Uint8Array | { data: Uint8Array; info: OutputInfo }> {
    const bytes = await this.getInput();
    let bitmap = SmBitmap.decode(bytes);
    try {
      bitmap = await this.applyOps(bitmap);
      const data = this.encodeBitmap(bitmap);
      if (opts?.resolveWithObject) {
        const info: OutputInfo = {
          format: this.outputFormat,
          size: data.byteLength,
          width: bitmap.width,
          height: bitmap.height,
          channels: outputChannelsFor(this.outputFormat),
        };
        return { data, info };
      }
      return data;
    } finally {
      SmBitmap.release(bitmap);
    }
  }

  private encodeBitmap(bitmap: ZigBitmap): Uint8Array {
    switch (this.outputFormat) {
      case 'png':
        return zigBytesToCopy(
          this.pngCompressionLevel === null
            ? bitmap.encodePng()
            : bitmap.encodePngWithLevel(this.pngCompressionLevel),
        );
      case 'jpeg':
        return zigBytesToCopy(bitmap.encodeJpeg(this.jpegQuality));
      case 'bmp':
        return zigBytesToCopy(bitmap.encodeBmp());
      case 'raw':
        return bitmapPixelsToCopy(bitmap);
    }
  }

  async metadata(): Promise<Metadata> {
    const bytes = await this.getInput();
    const info = SmBitmap.peekInfo(bytes);
    const channels = info.channels;
    return {
      format: detectFormat(bytes),
      width: info.width,
      height: info.height,
      channels,
      hasAlpha: channels === 2 || channels === 4,
      bitsPerSample: info.bits_per_sample,
      size: bytes.byteLength,
    };
  }

  private getInput(): Promise<Uint8Array> {
    if (!this.materialized) this.materialized = readToUint8Array(this.input);
    return this.materialized;
  }

  /** Run each queued op in order. Each op consumes the previous bitmap
   *  and returns a fresh one; the consumed bitmap is released
   *  immediately to keep peak memory bounded. Async because
   *  `composite` may need to await overlay materialization (decode
   *  bytes, drain a stream, etc.). */
  private async applyOps(initial: ZigBitmap): Promise<ZigBitmap> {
    let bitmap = initial;
    // pipelineColourspace runs at the head — sharp's "input is converted
    // to the provided colourspace at the start of the pipeline".
    if (
      this.pipelineColourspaceSetting !== undefined &&
      GREY_COLOURSPACES.has(this.pipelineColourspaceSetting)
    ) {
      const next = bitmap.greyscale();
      SmBitmap.release(bitmap);
      bitmap = next;
    }
    for (const op of this.ops) {
      const next = await this.runOp(op, bitmap);
      if (next !== bitmap) {
        SmBitmap.release(bitmap);
        bitmap = next;
      }
    }
    // toColourspace runs at the tail — sharp's "before converting to the
    // output colourspace, as defined by toColourspace".
    if (
      this.toColourspaceSetting !== undefined &&
      GREY_COLOURSPACES.has(this.toColourspaceSetting)
    ) {
      const next = bitmap.greyscale();
      SmBitmap.release(bitmap);
      bitmap = next;
    }
    return bitmap;
  }

  private runOp(op: Op, bitmap: ZigBitmap): Promise<ZigBitmap> | ZigBitmap {
    switch (op.kind) {
      case 'resize':
        return runResize(bitmap, op);
      case 'extend':
        return runExtend(bitmap, op);
      case 'extract':
        return runExtract(bitmap, op);
      case 'trim':
        return runTrim(bitmap, op);
      case 'composite':
        return runComposite(bitmap, op);
      case 'removeAlpha':
        return bitmap.removeAlpha();
      case 'ensureAlpha':
        if (op.alpha === undefined) {
          // Our bitmaps always have alpha. No-op; emit a fresh copy so
          // the applyOps release contract holds.
          return bitmap.extract(0, 0, bitmap.width, bitmap.height);
        }
        return bitmap.setAlphaConstant(Math.max(0, Math.min(255, Math.round(op.alpha * 255))));
      case 'extractChannel':
        return bitmap.extractChannel(op.channel);
      case 'bandbool':
        return bitmap.bandbool(op.op);
      case 'joinChannel':
        return runJoinChannel(bitmap, op);
      case 'greyscale':
        return bitmap.greyscale();
      case 'tint':
        return bitmap.tint(op.r, op.g, op.b);
      case 'rotate':
        return runRotate(bitmap, op);
      case 'autoOrient':
        return runAutoOrient(bitmap, this.materialized);
      case 'flip':
        return bitmap.flipV();
      case 'flop':
        return bitmap.flipH();
      case 'affine':
        return bitmap.affine(
          op.m00, op.m01, op.m10, op.m11,
          op.idx, op.idy, op.odx, op.ody,
          op.bg[0], op.bg[1], op.bg[2], op.bg[3],
          op.interp,
        );
      case 'blur':
        return op.sigma === undefined
          ? bitmap.blurBox3()
          : bitmap.blurGaussian(op.sigma, op.precision, op.minAmplitude);
      case 'sharpen':
        return op.sigma === undefined
          ? bitmap.sharpenFast()
          : bitmap.sharpenUSM(op.sigma, op.m1, op.m2, op.x1, op.y2, op.y3);
      case 'convolve':
        return bitmap.convolve(op.width, op.height, op.kernel, op.scale, op.offset);
      case 'median':
        return bitmap.median(op.size);
      case 'dilate':
        return bitmap.dilate(op.width);
      case 'erode':
        return bitmap.erode(op.width);
      case 'gamma':
        return bitmap.gamma(op.gIn, op.gOut);
      case 'negate':
        return bitmap.negate(op.alpha);
      case 'linear':
        return bitmap.linear(op.a, op.b);
      case 'threshold':
        return bitmap.threshold(op.t, op.greyscale);
      case 'recomb':
        return bitmap.recomb(op.matrix);
      case 'flatten':
        return bitmap.flatten(op.bg[0], op.bg[1], op.bg[2]);
      case 'unflatten':
        return bitmap.unflatten();
      case 'boolean':
        return runBoolean(bitmap, op);
      case 'normalise':
        return bitmap.normalise(op.lower, op.upper);
      case 'clahe':
        return bitmap.clahe(op.width, op.height, op.maxSlope);
      case 'modulate':
        return bitmap.modulate(op.brightness, op.saturation, op.hue, op.lightness);
    }
  }
}

export function microsharp(input: MicroSharpInput): MicroSharpPipeline {
  return new MicroSharpPipeline(input);
}

// ---- internal helpers -------------------------------------------------------

async function readToUint8Array(input: MicroSharpInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (typeof Response !== 'undefined' && input instanceof Response) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (typeof ReadableStream !== 'undefined' && input instanceof ReadableStream) {
    const reader = (input as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  throw new TypeError(
    'microsharp: input must be Uint8Array, ArrayBuffer, Blob, ReadableStream, or Response',
  );
}

function detectFormat(bytes: Uint8Array): ImageFormatName {
  // stb_image's public API doesn't expose which decoder it picked, so we
  // mirror its detection set with a signature sniff. Order matches the
  // formats stb_image actually decodes (see `decode/stb.zig`).
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'bmp';
  }
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'gif';
  }
  return 'unknown';
}

// =============================================================================
// Op implementations
// =============================================================================

type AnchorX = 'left' | 'centre' | 'right';
type AnchorY = 'top' | 'centre' | 'bottom';

interface Anchor {
  x: AnchorX;
  y: AnchorY;
}

const VALID_KERNELS: ReadonlyArray<ResizeKernel> = [
  'nearest', 'linear', 'cubic', 'mitchell', 'lanczos2', 'lanczos3', 'mks2013', 'mks2021',
];

function resolveKernel(k: ResizeKernel | undefined): ResizeKernel {
  if (k === undefined) return 'lanczos3'; // sharp's default
  if (!VALID_KERNELS.includes(k)) {
    throw new RangeError(
      `microsharp: kernel must be one of ${VALID_KERNELS.join(', ')} (got ${String(k)})`,
    );
  }
  return k;
}

function parsePosition(p: ResizePosition | undefined): Anchor | 'entropy' | 'attention' {
  if (p === undefined) return { x: 'centre', y: 'centre' };
  const norm = String(p).toLowerCase().trim();
  if (norm === 'entropy' || norm === 'attention') return norm;
  switch (norm) {
    case 'centre': case 'center': return { x: 'centre', y: 'centre' };
    case 'top': case 'north': return { x: 'centre', y: 'top' };
    case 'bottom': case 'south': return { x: 'centre', y: 'bottom' };
    case 'left': case 'west': return { x: 'left', y: 'centre' };
    case 'right': case 'east': return { x: 'right', y: 'centre' };
    case 'top right': case 'right top': case 'northeast':
      return { x: 'right', y: 'top' };
    case 'top left': case 'left top': case 'northwest':
      return { x: 'left', y: 'top' };
    case 'bottom right': case 'right bottom': case 'southeast':
      return { x: 'right', y: 'bottom' };
    case 'bottom left': case 'left bottom': case 'southwest':
      return { x: 'left', y: 'bottom' };
  }
  throw new RangeError(`microsharp: unknown position '${String(p)}'`);
}

function parseBackground(
  bg: BackgroundInput | undefined,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  if (bg === undefined) return fallback;
  if (typeof bg === 'string') {
    const packed = parseCssColor(bg);
    if (packed === null) {
      throw new RangeError(`microsharp: invalid background colour '${bg}'`);
    }
    const u = packed >>> 0;
    return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff];
  }
  if (typeof bg === 'object') {
    const r = clampByte(bg.r);
    const g = clampByte(bg.g);
    const b = clampByte(bg.b);
    const a = bg.alpha === undefined ? 255 : clampByte(Math.round(bg.alpha * 255));
    return [r, g, b, a];
  }
  throw new RangeError('microsharp: background must be a CSS string or {r,g,b,alpha?} object');
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

interface TargetDims {
  width: number;
  height: number;
}

function computeTargetDims(srcW: number, srcH: number, op: ResizeOp): TargetDims {
  const aspect = srcW / srcH;
  let { width, height } = op;
  // Object-form `{ width, height }` is also surfaced via op.opts (sharp parity).
  if (op.opts) {
    if (op.opts.width !== undefined && width === undefined) width = op.opts.width;
    if (op.opts.height !== undefined && height === undefined) height = op.opts.height;
  }
  if (width != null && height != null) return { width, height };
  if (width != null) return { width, height: Math.max(1, Math.round(width / aspect)) };
  if (height != null) return { width: Math.max(1, Math.round(height * aspect)), height };
  // Neither given: behave as a no-op (sharp behavior).
  return { width: srcW, height: srcH };
}

interface FitDims {
  /** Intermediate resample size before any cover-crop / contain-pad. */
  resampleW: number;
  resampleH: number;
  /** Final output canvas size (== target for fill/cover/contain;
   *  shrunk-to-aspect for inside/outside). */
  outW: number;
  outH: number;
}

function computeFitDims(srcW: number, srcH: number, target: TargetDims, fit: ResizeFit): FitDims {
  const { width: tW, height: tH } = target;
  const sx = tW / srcW;
  const sy = tH / srcH;
  switch (fit) {
    case 'fill':
      return { resampleW: tW, resampleH: tH, outW: tW, outH: tH };
    case 'inside': {
      const s = Math.min(sx, sy);
      const w = Math.max(1, Math.round(srcW * s));
      const h = Math.max(1, Math.round(srcH * s));
      return { resampleW: w, resampleH: h, outW: w, outH: h };
    }
    case 'outside': {
      const s = Math.max(sx, sy);
      const w = Math.max(1, Math.round(srcW * s));
      const h = Math.max(1, Math.round(srcH * s));
      return { resampleW: w, resampleH: h, outW: w, outH: h };
    }
    case 'contain': {
      const s = Math.min(sx, sy);
      const w = Math.max(1, Math.round(srcW * s));
      const h = Math.max(1, Math.round(srcH * s));
      return { resampleW: w, resampleH: h, outW: tW, outH: tH };
    }
    case 'cover':
    default: {
      const s = Math.max(sx, sy);
      const w = Math.max(1, Math.round(srcW * s));
      const h = Math.max(1, Math.round(srcH * s));
      return { resampleW: w, resampleH: h, outW: tW, outH: tH };
    }
  }
}

function runResize(bitmap: ZigBitmap, op: ResizeOp): ZigBitmap {
  const target = computeTargetDims(bitmap.width, bitmap.height, op);
  if (target.width === bitmap.width && target.height === bitmap.height) {
    // No-op: dims unchanged.
    return bitmap;
  }

  const opts = op.opts ?? {};
  const fit: ResizeFit = opts.fit ?? 'cover';
  const kernel = resolveKernel(opts.kernel);

  // withoutEnlargement / withoutReduction veto if the resize would go
  // the disallowed direction. Sharp defines these per-axis: the resize
  // is skipped if BOTH dims would scale in the forbidden direction.
  const grows = target.width > bitmap.width || target.height > bitmap.height;
  const shrinks = target.width < bitmap.width || target.height < bitmap.height;
  if (opts.withoutEnlargement && grows && !shrinks) return bitmap;
  if (opts.withoutReduction && shrinks && !grows) return bitmap;

  const { resampleW, resampleH, outW, outH } = computeFitDims(
    bitmap.width, bitmap.height, target, fit,
  );

  // Stage 1: resample to the intermediate size (skipped if already there).
  const needsResample = resampleW !== bitmap.width || resampleH !== bitmap.height;
  const scaled: ZigBitmap = needsResample
    ? bitmap.resample(resampleW, resampleH, kernel)
    : bitmap;

  // Helper: free `scaled` iff we own it AND we're not returning it.
  // We OWN `scaled` when `needsResample` is true (the resample call
  // produced a fresh bitmap); when it aliases the input, the caller
  // (applyOps) is responsible for it.
  const finish = (out: ZigBitmap): ZigBitmap => {
    if (needsResample && out !== scaled) SmBitmap.release(scaled);
    return out;
  };

  if (fit === 'fill' || fit === 'inside' || fit === 'outside') {
    // No post-processing. Transfer ownership: if we resampled, return
    // the fresh bitmap directly; otherwise copy so applyOps's release
    // contract still holds (it releases the old when next !== old).
    if (needsResample) return scaled;
    return passthroughCopy(scaled);
  }

  if (fit === 'cover') {
    const pos = parsePosition(opts.position);
    let cropLeft: number;
    let cropTop: number;
    if (pos === 'entropy' || pos === 'attention') {
      const bounds = scaled.contentBounds(outW, outH, pos);
      cropLeft = bounds.left;
      cropTop = bounds.top;
    } else {
      ({ cropLeft, cropTop } = computeCornerCrop(resampleW, resampleH, outW, outH, pos));
    }
    const out = scaled.extract(cropLeft, cropTop, outW, outH);
    return finish(out);
  }

  // contain: letterbox onto outW × outH
  const pos = parsePosition(opts.position);
  // Sharp ignores entropy/attention for contain; we match by falling
  // back to centre.
  const anchor: Anchor = (pos === 'entropy' || pos === 'attention')
    ? { x: 'centre', y: 'centre' }
    : pos;
  const { offsetX, offsetY } = computeOffset(resampleW, resampleH, outW, outH, anchor);
  const padTop = offsetY;
  const padLeft = offsetX;
  const padBottom = outH - resampleH - offsetY;
  const padRight = outW - resampleW - offsetX;
  const bg = parseBackground(opts.background, [0, 0, 0, 255]);
  const padded = scaled.extend(padTop, padRight, padBottom, padLeft, 'background', bg[0], bg[1], bg[2], bg[3]);
  return finish(padded);
}

function passthroughCopy(bitmap: ZigBitmap): ZigBitmap {
  // We need to return a NEW bitmap (caller releases the input) so a
  // no-op resize at fit='inside' with same dims doesn't free our
  // input. Use extract(0,0,w,h) — bitmap-direct copy.
  return bitmap.extract(0, 0, bitmap.width, bitmap.height);
}

function computeCornerCrop(
  intW: number, intH: number, outW: number, outH: number, anchor: Anchor,
): { cropLeft: number; cropTop: number } {
  let cropLeft = 0;
  let cropTop = 0;
  switch (anchor.x) {
    case 'left': cropLeft = 0; break;
    case 'right': cropLeft = intW - outW; break;
    case 'centre': cropLeft = Math.round((intW - outW) / 2); break;
  }
  switch (anchor.y) {
    case 'top': cropTop = 0; break;
    case 'bottom': cropTop = intH - outH; break;
    case 'centre': cropTop = Math.round((intH - outH) / 2); break;
  }
  return { cropLeft, cropTop };
}

function computeOffset(
  intW: number, intH: number, outW: number, outH: number, anchor: Anchor,
): { offsetX: number; offsetY: number } {
  let offsetX = 0;
  let offsetY = 0;
  switch (anchor.x) {
    case 'left': offsetX = 0; break;
    case 'right': offsetX = outW - intW; break;
    case 'centre': offsetX = Math.round((outW - intW) / 2); break;
  }
  switch (anchor.y) {
    case 'top': offsetY = 0; break;
    case 'bottom': offsetY = outH - intH; break;
    case 'centre': offsetY = Math.round((outH - intH) / 2); break;
  }
  return { offsetX, offsetY };
}

function runExtend(bitmap: ZigBitmap, op: ExtendOp): ZigBitmap {
  let top = 0, right = 0, bottom = 0, left = 0;
  let mode: ExtendWithMode = 'background';
  let bgInput: BackgroundInput | undefined;

  if (typeof op.opts === 'number') {
    const n = op.opts;
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError('microsharp: extend(n) requires a non-negative integer');
    }
    top = right = bottom = left = n;
  } else {
    top = op.opts.top ?? 0;
    right = op.opts.right ?? 0;
    bottom = op.opts.bottom ?? 0;
    left = op.opts.left ?? 0;
    mode = op.opts.extendWith ?? 'background';
    bgInput = op.opts.background;
  }

  if (mode !== 'background' && mode !== 'copy' && mode !== 'repeat' && mode !== 'mirror') {
    throw new RangeError(
      `microsharp: extendWith must be 'background' | 'copy' | 'repeat' | 'mirror' (got ${String(mode)})`,
    );
  }
  for (const [name, v] of [['top', top], ['right', right], ['bottom', bottom], ['left', left]] as const) {
    if (!Number.isInteger(v) || v < 0) {
      throw new RangeError(`microsharp: extend.${name} must be a non-negative integer`);
    }
  }

  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    // No-op; return a fresh copy so caller release semantics stay uniform.
    return bitmap.extract(0, 0, bitmap.width, bitmap.height);
  }

  const bg = parseBackground(bgInput, [0, 0, 0, 255]);
  return bitmap.extend(top, right, bottom, left, mode, bg[0], bg[1], bg[2], bg[3]);
}

function runExtract(bitmap: ZigBitmap, op: ExtractOp): ZigBitmap {
  const { left, top, width, height } = op.region;
  if (left + width > bitmap.width || top + height > bitmap.height) {
    throw new RangeError(
      `microsharp: extract region (${left},${top} ${width}×${height}) ` +
      `out of bounds for ${bitmap.width}×${bitmap.height} bitmap`,
    );
  }
  return bitmap.extract(left, top, width, height);
}

// =============================================================================
// composite — sharp's libvips/cairo blend names → simdra's HTML5 enum.
// =============================================================================

const BLEND_MAP: Record<string, BlendModeName | 'dest'> = {
  // Cairo / libvips short names
  'over':       'src_over',
  'source':     'copy',
  'in':         'src_in',
  'out':        'src_out',
  'atop':       'src_atop',
  'dest':       'dest',           // identity — caller skips draw
  'dest-over':  'dst_over',
  'dest-in':    'dst_in',
  'dest-out':   'dst_out',
  'dest-atop':  'dst_atop',
  'xor':        'xor',
  'add':        'add',
  // Separable W3C blends
  'multiply':   'multiply',
  'screen':     'screen',
  'overlay':    'overlay',
  'darken':     'darken',
  'lighten':    'lighten',
  'colour-dodge': 'color_dodge',
  'color-dodge':  'color_dodge',
  'colour-burn':  'color_burn',
  'color-burn':   'color_burn',
  'hard-light': 'hard_light',
  'soft-light': 'soft_light',
  'difference': 'difference',
  'exclusion':  'exclusion',
};

function resolveBlend(b: CompositeBlend | undefined): BlendModeName | 'dest' {
  const key = (b ?? 'over').toLowerCase();
  // 'clear' and 'saturate' are libvips/cairo modes simdra doesn't ship.
  if (key === 'clear' || key === 'saturate') {
    throw new RangeError(`microsharp: composite blend '${b}' not supported (no equivalent in simdra's blend kernel set)`);
  }
  const m = BLEND_MAP[key];
  if (m === undefined) {
    throw new RangeError(`microsharp: unknown composite blend '${b}'`);
  }
  return m;
}

function resolveCompositeGravity(g: CompositeGravity | undefined): Anchor {
  if (g === undefined) return { x: 'centre', y: 'centre' };
  const norm = String(g).toLowerCase().trim();
  switch (norm) {
    case 'centre': case 'center': return { x: 'centre', y: 'centre' };
    case 'top': case 'north': return { x: 'centre', y: 'top' };
    case 'bottom': case 'south': return { x: 'centre', y: 'bottom' };
    case 'left': case 'west': return { x: 'left', y: 'centre' };
    case 'right': case 'east': return { x: 'right', y: 'centre' };
    case 'top right': case 'right top': case 'northeast':
      return { x: 'right', y: 'top' };
    case 'top left': case 'left top': case 'northwest':
      return { x: 'left', y: 'top' };
    case 'bottom right': case 'right bottom': case 'southeast':
      return { x: 'right', y: 'bottom' };
    case 'bottom left': case 'left bottom': case 'southwest':
      return { x: 'left', y: 'bottom' };
  }
  throw new RangeError(`microsharp: unknown composite gravity '${String(g)}'`);
}

function gravityOffset(
  baseW: number, baseH: number,
  ovW: number, ovH: number,
  anchor: Anchor,
): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  switch (anchor.x) {
    case 'left': dx = 0; break;
    case 'right': dx = baseW - ovW; break;
    case 'centre': dx = Math.round((baseW - ovW) / 2); break;
  }
  switch (anchor.y) {
    case 'top': dy = 0; break;
    case 'bottom': dy = baseH - ovH; break;
    case 'centre': dy = Math.round((baseH - ovH) / 2); break;
  }
  return { dx, dy };
}

async function materializeOverlay(
  input: CompositeOverlayInput,
  raw: CompositeRawDescriptor | undefined,
): Promise<ZigBitmap> {
  // `{ create }` path first — bypasses the byte readers.
  if (input && typeof input === 'object' && !(input instanceof Uint8Array) &&
      !(input instanceof ArrayBuffer) &&
      !(typeof Blob !== 'undefined' && input instanceof Blob) &&
      !(typeof Response !== 'undefined' && input instanceof Response) &&
      !(typeof ReadableStream !== 'undefined' && input instanceof ReadableStream)) {
    if ('create' in input && input.create) {
      const cre = input.create;
      if (cre.channels !== 3 && cre.channels !== 4) {
        throw new RangeError(
          `microsharp: composite create.channels must be 3 or 4; got ${cre.channels}`,
        );
      }
      const bg = parseBackground(cre.background, [0, 0, 0, 255]);
      const a = cre.channels === 3 ? 255 : bg[3];
      const data = new Uint8Array(cre.width * cre.height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i + 0] = bg[0];
        data[i + 1] = bg[1];
        data[i + 2] = bg[2];
        data[i + 3] = a;
      }
      return SmBitmap.createFromBuffer(data, cre.width, cre.height, {});
    }
  }
  // Materialize bytes once.
  const bytes = await readToUint8Array(input as MicroSharpInput);
  // Sharp-style raw descriptor: bytes are pre-decoded pixels at the
  // given band count. Microsharp expands 1- and 3-channel inputs into
  // 4-channel RGBA on the fly so the rest of the pipeline doesn't
  // need a per-call channel-count switch.
  if (raw !== undefined) {
    return rawDescriptorToRgba(bytes, raw);
  }
  // Encoded image bytes.
  return SmBitmap.decode(bytes);
}

/** Convert a sharp-style raw descriptor into an RGBA `SmBitmap`.
 *  Supports `channels` ∈ {1, 3, 4}; rejects 2 (rare grey+alpha) and
 *  anything else. */
function rawDescriptorToRgba(
  bytes: Uint8Array,
  raw: { width: number; height: number; channels: number },
): ZigBitmap {
  const px = raw.width * raw.height;
  const expected = px * raw.channels;
  if (bytes.byteLength !== expected) {
    throw new RangeError(
      `microsharp: raw bytes length ${bytes.byteLength} ≠ width*height*channels ` +
      `(${raw.width}×${raw.height}×${raw.channels} = ${expected})`,
    );
  }
  if (raw.channels === 4) {
    return SmBitmap.createFromBuffer(bytes, raw.width, raw.height, {});
  }
  if (raw.channels === 1) {
    const out = new Uint8Array(px * 4);
    for (let i = 0; i < px; i++) {
      const v = bytes[i];
      out[i * 4 + 0] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
    return SmBitmap.createFromBuffer(out, raw.width, raw.height, {});
  }
  if (raw.channels === 3) {
    const out = new Uint8Array(px * 4);
    for (let i = 0; i < px; i++) {
      out[i * 4 + 0] = bytes[i * 3 + 0];
      out[i * 4 + 1] = bytes[i * 3 + 1];
      out[i * 4 + 2] = bytes[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return SmBitmap.createFromBuffer(out, raw.width, raw.height, {});
  }
  throw new RangeError(
    `microsharp: raw.channels must be 1, 3, or 4 (got ${raw.channels}); 2-channel grey+alpha is not supported`,
  );
}

async function runComposite(bitmap: ZigBitmap, op: CompositeOp): Promise<ZigBitmap> {
  let current = bitmap;
  let ownsCurrent = false;
  // `current` starts aliased to the caller's bitmap. We replace it with
  // a freshly-allocated composited bitmap on first iteration; subsequent
  // iterations release the previous owned bitmap.

  try {
    for (const img of op.images) {
      const blend = resolveBlend(img.blend);
      // 'dest' is sharp's identity blend — keep destination, ignore
      // source. Skip the draw entirely.
      if (blend === 'dest') continue;

      const overlay = await materializeOverlay(img.input, img.raw);
      try {
        let dx: number;
        let dy: number;
        if (img.top !== undefined && img.left !== undefined) {
          dx = img.left;
          dy = img.top;
        } else {
          const anchor = resolveCompositeGravity(img.gravity);
          ({ dx, dy } = gravityOffset(current.width, current.height, overlay.width, overlay.height, anchor));
        }
        const next = current.composite(overlay, blend, dx, dy, img.tile === true);
        if (ownsCurrent) SmBitmap.release(current);
        current = next;
        ownsCurrent = true;
      } finally {
        SmBitmap.release(overlay);
      }
    }
  } catch (err) {
    if (ownsCurrent) SmBitmap.release(current);
    throw err;
  }

  // If we never composited (empty list, or every entry was 'dest'),
  // produce a fresh copy so applyOps's release contract holds.
  if (!ownsCurrent) {
    return current.extract(0, 0, current.width, current.height);
  }
  return current;
}

async function runJoinChannel(bitmap: ZigBitmap, op: JoinChannelOp): Promise<ZigBitmap> {
  const mask = await materializeOverlay(op.image, op.raw);
  try {
    if (mask.width !== bitmap.width || mask.height !== bitmap.height) {
      throw new RangeError(
        `microsharp: joinChannel image ${mask.width}×${mask.height} must match base ${bitmap.width}×${bitmap.height}`,
      );
    }
    return bitmap.joinAlphaFromMask(mask);
  } finally {
    SmBitmap.release(mask);
  }
}

function resolveChannel(c: ChannelSelector): number {
  if (typeof c === 'number') {
    if (!Number.isInteger(c) || c < 0 || c > 3) {
      throw new RangeError(
        `microsharp: extractChannel() expects 0..3 or 'red'|'green'|'blue'|'alpha' (got ${c})`,
      );
    }
    return c;
  }
  switch (c) {
    case 'red': return 0;
    case 'green': return 1;
    case 'blue': return 2;
    case 'alpha': return 3;
  }
  throw new RangeError(`microsharp: extractChannel() unknown channel '${String(c)}'`);
}

function expandLinearVec(
  v: number | ArrayLike<number> | undefined,
  fallback: number,
  label: 'a' | 'b',
): Float64Array {
  const out = new Float64Array(4);
  // Default: per-RGB has the supplied value; alpha keeps identity (a=1, b=0).
  const alphaIdentity = label === 'a' ? 1 : 0;
  if (v === undefined) {
    out[0] = fallback; out[1] = fallback; out[2] = fallback;
    out[3] = alphaIdentity;
    return out;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new RangeError(`microsharp: linear(${label}) must be a finite number`);
    }
    out[0] = v; out[1] = v; out[2] = v;
    out[3] = alphaIdentity;
    return out;
  }
  if (v.length === 3 || v.length === 4) {
    for (let i = 0; i < v.length; i++) {
      const n = Number(v[i]);
      if (!Number.isFinite(n)) {
        throw new RangeError(`microsharp: linear(${label})[${i}] must be a finite number`);
      }
      out[i] = n;
    }
    if (v.length === 3) out[3] = alphaIdentity;
    return out;
  }
  throw new RangeError(
    `microsharp: linear(${label}) must be a number, length-3 array, or length-4 array (got length ${v.length})`,
  );
}

function flattenRecombMatrix(m: RecombMatrix): Float64Array {
  // Nested form: outer is an array whose first element is itself an array.
  if (Array.isArray(m) && m.length > 0 && Array.isArray((m as readonly unknown[])[0])) {
    const rows = m as readonly (readonly number[])[];
    const cols = rows[0].length;
    if (!((rows.length === 3 && cols === 3) || (rows.length === 4 && cols === 4))) {
      throw new RangeError('microsharp: recomb nested matrix must be 3×3 or 4×4');
    }
    const flat = new Float64Array(rows.length * cols);
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].length !== cols) {
        throw new RangeError('microsharp: recomb matrix is jagged — every row must have the same length');
      }
      for (let c = 0; c < cols; c++) {
        const v = Number(rows[r][c]);
        if (!Number.isFinite(v)) {
          throw new RangeError(`microsharp: recomb[${r}][${c}] must be finite`);
        }
        flat[r * cols + c] = v;
      }
    }
    return flat;
  }
  // Flat number list: length 9 (3×3) or 16 (4×4).
  const arr = m as ArrayLike<number>;
  const n = arr.length;
  if (n !== 9 && n !== 16) {
    throw new RangeError('microsharp: recomb flat matrix length must be 9 (3×3) or 16 (4×4)');
  }
  const flat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(arr[i]);
    if (!Number.isFinite(v)) {
      throw new RangeError(`microsharp: recomb[${i}] must be finite`);
    }
    flat[i] = v;
  }
  return flat;
}

async function runBoolean(bitmap: ZigBitmap, op: BooleanOp): Promise<ZigBitmap> {
  const operand = await materializeOverlay(op.operand, op.raw);
  try {
    return bitmap.booleanWith(operand, op.op);
  } finally {
    SmBitmap.release(operand);
  }
}

function flattenAffineMatrix(m: AffineMatrix): [number, number, number, number] {
  // Sharp accepts both `[a, b, c, d]` and `[[a, b], [c, d]]`. Reject other
  // shapes (e.g. 3-element list, jagged nested array) with a RangeError so
  // bad input lands at the wrapper, not deep in Zig.
  if (Array.isArray(m) && m.length === 4 && m.every((x) => typeof x === 'number')) {
    return [m[0] as number, m[1] as number, m[2] as number, m[3] as number];
  }
  if (Array.isArray(m) && m.length === 2 &&
      Array.isArray(m[0]) && (m[0] as readonly number[]).length === 2 &&
      Array.isArray(m[1]) && (m[1] as readonly number[]).length === 2) {
    const r0 = m[0] as readonly number[];
    const r1 = m[1] as readonly number[];
    return [r0[0], r0[1], r1[0], r1[1]];
  }
  throw new RangeError(
    'microsharp: affine matrix must be [a, b, c, d] or [[a, b], [c, d]]',
  );
}

function runRotate(bitmap: ZigBitmap, op: RotateOp): ZigBitmap {
  // Multiples of 90° → byte-exact lossless permutation. Compare with a
  // small float epsilon so users typing 90.0000000001 still hit the fast
  // path. The sampler-driven slow path is ~10–20× slower for the same
  // pixel count and introduces filtering artifacts.
  const a = op.angle;
  const eps = 1e-9;
  if (Math.abs(a) < eps || Math.abs(a - 360) < eps) {
    return bitmap.extract(0, 0, bitmap.width, bitmap.height);
  }
  if (Math.abs(a - 90) < eps) return bitmap.rotate90();
  if (Math.abs(a - 180) < eps) return bitmap.rotate180();
  if (Math.abs(a - 270) < eps) return bitmap.rotate270();
  return bitmap.rotateArbitrary(a, op.bg[0], op.bg[1], op.bg[2], op.bg[3], 'bilinear');
}

function runAutoOrient(
  bitmap: ZigBitmap,
  inputBytes: Promise<Uint8Array> | null,
): Promise<ZigBitmap> | ZigBitmap {
  // We need the materialised input bytes to read the EXIF Orientation
  // tag. `applyOps` always runs after `getInput` returned, so the
  // promise has already resolved — but we still resolve through it for
  // safety and to satisfy the type contract of `runOp`.
  if (inputBytes === null) {
    return bitmap.extract(0, 0, bitmap.width, bitmap.height);
  }
  return inputBytes.then((bytes) => applyOrientation(bitmap, bytes));
}

function applyOrientation(bitmap: ZigBitmap, bytes: Uint8Array): ZigBitmap {
  const o = SmBitmap.peekOrientation(bytes);
  // 1 = no rotation; we still produce a fresh bitmap so applyOps's
  // release contract holds (it releases the previous when next !== prev).
  switch (o) {
    case 1:
      return bitmap.extract(0, 0, bitmap.width, bitmap.height);
    case 2:
      return bitmap.flipH();
    case 3:
      return bitmap.rotate180();
    case 4:
      return bitmap.flipV();
    case 5: {
      // Transpose: 90° CW then h-flip (equivalent to mirroring across
      // the main diagonal). Two-step routes through page_allocator
      // bitmaps; release the intermediate.
      const r = bitmap.rotate90();
      try { return r.flipH(); }
      finally { SmBitmap.release(r); }
    }
    case 6:
      return bitmap.rotate90();
    case 7: {
      // Transverse: 90° CW then v-flip (mirror across anti-diagonal).
      const r = bitmap.rotate90();
      try { return r.flipV(); }
      finally { SmBitmap.release(r); }
    }
    case 8:
      return bitmap.rotate270();
    default:
      return bitmap.extract(0, 0, bitmap.width, bitmap.height);
  }
}

function runTrim(bitmap: ZigBitmap, op: TrimOp): ZigBitmap {
  const opts = op.opts ?? {};
  const threshold = opts.threshold ?? 10;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError('microsharp: trim threshold must be 0..255');
  }
  // Default background = top-left pixel of the working bitmap (sharp parity).
  let bg: [number, number, number, number];
  if (opts.background !== undefined) {
    bg = parseBackground(opts.background, [0, 0, 0, 255]);
  } else {
    const px = bitmap.data as unknown as ZigBytes;
    bg = [px[0], px[1], px[2], px[3]];
  }
  let bounds: { left: number; top: number; width: number; height: number };
  try {
    bounds = bitmap.findOpaqueBounds(bg[0], bg[1], bg[2], bg[3], Math.round(threshold));
  } catch (err) {
    // NoContent: every pixel matches background within threshold.
    // Sharp's behaviour: leave the image untouched.
    return bitmap.extract(0, 0, bitmap.width, bitmap.height);
  }
  return bitmap.extract(bounds.left, bounds.top, bounds.width, bounds.height);
}

function outputChannelsFor(format: ImageFormat): number {
  // PNG: stb writes 4-channel RGBA. JPEG: stb's encoder drops alpha — the
  // file always carries 3 channels regardless of `comp`. BMP: stb writes a
  // 32-bit V4 header with explicit alpha mask when comp=4. Raw: the
  // decoded RGBA buffer that backs the bitmap (forced 4-channel by
  // `decode/stb.zig`).
  return format === 'jpeg' ? 3 : 4;
}

function bitmapPixelsToCopy(bitmap: ZigBitmap): Uint8Array {
  // bitmap.data is a slice proxy into Zig memory; same defensive-copy
  // story as `zigBytesToCopy`. The slice's `dataView` accessor lets us
  // do a single `.set()` rather than a byte-by-byte indexer loop.
  const src = bitmap.data as unknown as ZigBytes;
  const dv = src.dataView;
  const out = new Uint8Array(dv.byteLength);
  out.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  return out;
}

function zigBytesToCopy(bytes: ZigBytes): Uint8Array {
  // Defensive copy out of WASM linear memory — see the equivalent helper
  // in src/index.ts. Live `dataView` views become invalid when Zig grows
  // the heap, so anything that survives the next allocator call has to be
  // in a JS-owned ArrayBuffer.
  const dv = bytes.dataView;
  const out = new Uint8Array(dv.byteLength);
  out.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  return out;
}
