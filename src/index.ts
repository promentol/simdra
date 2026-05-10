// Public API of simdra — HTML5 / WebIDL classes.
//
// **Design rule:** every public class is a TypeScript class that holds a
// PRIVATE handle to its underlying Zig proxy. Consumers see only the
// HTML5 spec surface; the Sm* Zig types from `../zig/simdra.zig` are
// strictly internal — they never leave this module. Cross-class internal
// access goes through the module-private `ZIG` Symbol so wrappers can
// hand each other their underlying handles (e.g. `ctx.putImageData(bm)`)
// without those handles leaking to user code.
//
// **Memory cleanup:** Zig types own page-allocator buffers that node-zigar
// does not GC. We register every wrapper with a `FinalizationRegistry`
// so when the JS object becomes unreachable, the Zig buffer is freed.
// Consumers never call `.deinit()` or `.releaseImageData()` — those are
// gone from the public API.
//
// Modeled after Skia's C++ surface (`SkCanvas`, `SkBitmap`, `SkPath`,
// `SkMatrix`) wrapped by Chromium's HTML5 implementation, and
// canvas-rs / @napi-rs/canvas which take the same wrapping approach.

import * as zig from '../zig/simdra.zig';
import {
  SmSurface,
  SmCanvas as SmCanvasZig,
  SmBitmap,
  SmMatrix,
  SmPath,
  SmGradient,
  SmPattern,
  SmFont,
  defaultFontBytes,
  parseCssColor,
  encodePngAsync,
  encodeJpegAsync,
} from '../zig/simdra.zig';

import type {
  SmSurface as ZigSurface,
  SmCanvas as ZigCanvas,
  SmBitmap as ZigBitmap,
  SmMatrix as ZigMatrix,
  SmPath as ZigPath,
  SmGradient as ZigGradient,
  SmPattern as ZigPattern,
  SmFont as ZigFont,
  BitmapSettings as ZigBitmapSettings,
  ZigBytes,
} from '../zig/simdra.zig';

// =============================================================================
// Internal: cross-wrapper handle access
// =============================================================================

/**
 * Module-private symbols — wrappers store their underlying Zig proxy and
 * provide internal-construction factories. Same-module code can read them;
 * consumers cannot, because they don't have the symbol reference.
 */
const ZIG = Symbol('zig');
const FROM_ZIG = Symbol('fromZig');

// =============================================================================
// Internal: finalization registries
// =============================================================================
//
// Each wrapper class registers itself with a registry that frees its Zig
// buffer when the wrapper is GC'd. Callbacks are async/best-effort per the
// FinalizationRegistry contract — fine for memory correctness.

const bitmapRegistry = new FinalizationRegistry<ZigBitmap>((bitmap) => {
  SmBitmap.release(bitmap);
});

const pathRegistry = new FinalizationRegistry<ZigPath>((path) => {
  path.deinit();
});

const gradientRegistry = new FinalizationRegistry<ZigGradient>((g) => {
  g.deinit();
});

const patternRegistry = new FinalizationRegistry<ZigPattern>((p) => {
  p.deinit();
});

const surfaceRegistry = new FinalizationRegistry<ZigSurface>((s) => {
  s.deinit();
});

// =============================================================================
// HTML5: ImageData
// =============================================================================
//
// Per spec:
//   new ImageData(width, height, settings?)
//   new ImageData(data, width, height?, settings?)
//
// Properties: data (Uint8Array proxy — should be Uint8ClampedArray per
// spec; current is read-write Uint8Array which is API-compatible enough).
// width, height, colorSpace, pixelFormat (read-only).

export interface ImageDataSettings {
  colorSpace?: 'srgb' | 'display_p3';
  pixelFormat?: 'rgba_unorm8' | 'rgba_float16';
}

export class ImageData {
  /** @internal */ [ZIG]: ZigBitmap;

  constructor(width: number, height: number, settings?: ImageDataSettings);
  constructor(
    data: ArrayBufferView,
    width: number,
    height?: number,
    settings?: ImageDataSettings,
  );
  constructor(
    arg1: number | ArrayBufferView,
    arg2: number,
    arg3?: number | ImageDataSettings,
    arg4?: ImageDataSettings,
  ) {
    if (arg1 === undefined || arg2 === undefined) {
      throw new TypeError('ImageData requires at least 2 arguments');
    }
    let bitmap: ZigBitmap;
    if (typeof arg1 === 'number') {
      const w = arg1;
      const h = arg2;
      const settings = (arg3 as ImageDataSettings | undefined) ?? {};
      bitmap = SmBitmap.createBlank(w, h, settings);
    } else {
      const data = arg1;
      const w = arg2;
      const h = typeof arg3 === 'number' ? arg3 : null;
      const settings: ImageDataSettings =
        (typeof arg3 === 'number' ? arg4 : (arg3 as ImageDataSettings | undefined)) ?? {};
      bitmap = SmBitmap.createFromBuffer(data, w, h, settings);
    }
    this[ZIG] = bitmap;
    bitmapRegistry.register(this, bitmap, this);
  }

  /** @internal — wrap an existing Zig bitmap (used by getImageData). */
  static [FROM_ZIG](bitmap: ZigBitmap): ImageData {
    const obj = Object.create(ImageData.prototype) as ImageData;
    (obj as { [ZIG]: ZigBitmap })[ZIG] = bitmap;
    bitmapRegistry.register(obj, bitmap, obj);
    return obj;
  }

  get data(): Uint8Array {
    return this[ZIG].data;
  }
  get width(): number {
    return this[ZIG].width;
  }
  get height(): number {
    return this[ZIG].height;
  }
  get colorSpace(): string {
    return String(this[ZIG].colorSpace);
  }
  get pixelFormat(): string {
    return String(this[ZIG].pixelFormat);
  }
}

// =============================================================================
// Image — decoded image source (PNG / JPEG / BMP / GIF first frame)
// =============================================================================
//
// HTMLImageElement-shaped helper for Node / WASM environments. Construction
// is via the `Image.fromBytes(bytes)` factory (not `new Image(src); img.src=...`
// — there is no async loader on the JS side; bytes go in synchronously).
//
// `Image` carries a private `SmBitmap` handle and is consumed by
// `ctx.drawImage(image, ...)` and `ctx.createPattern(image, rep)`. Unlike
// `ImageData`, it does NOT expose a mutable `data` array — it is an opaque
// image source. Use `ctx.drawImage(...)` (which respects the CTM /
// compositing) rather than the raw-pixel `putImageData` path.
//
// The underlying `SmBitmap` is freed via the existing `bitmapRegistry`
// when the JS object is GC'd.

export class Image {
  /** @internal */ [ZIG]: ZigBitmap;

  private constructor() {
    throw new TypeError('Image: use Image.fromBytes(bytes)');
  }

  /** Decode PNG / JPEG / BMP / GIF (first frame) bytes into an Image. */
  static fromBytes(bytes: ArrayBufferView | Uint8Array | Buffer): Image {
    const view: ArrayBufferView = bytes;
    const bitmap = SmBitmap.decode(view);
    const obj = Object.create(Image.prototype) as Image;
    (obj as { [ZIG]: ZigBitmap })[ZIG] = bitmap;
    bitmapRegistry.register(obj, bitmap, obj);
    return obj;
  }

  /** @internal — wrap an existing Zig bitmap (used by the sharp-shaped
   *  binding's pipeline so it can hand over a decoded buffer). */
  static [FROM_ZIG](bitmap: ZigBitmap): Image {
    const obj = Object.create(Image.prototype) as Image;
    (obj as { [ZIG]: ZigBitmap })[ZIG] = bitmap;
    bitmapRegistry.register(obj, bitmap, obj);
    return obj;
  }

  get width(): number {
    return this[ZIG].width;
  }
  get height(): number {
    return this[ZIG].height;
  }
}

// =============================================================================
// HTML5: DOMMatrix (2D affine subset)
// =============================================================================
//
// Per spec:
//   new DOMMatrix()              — identity
//   new DOMMatrix(init: number[6 | 16] | string)

// 16-element column-major layout per WebIDL:
//   [m11 m12 m13 m14, m21 m22 m23 m24, m31 m32 m33 m34, m41 m42 m43 m44]
// For a 2D matrix the 3D-position values must equal identity, otherwise
// reject — we don't model 3D matrices.
function matrixFrom16(arr: ArrayLike<number>): ZigMatrix {
  const ok =
    arr[2] === 0 && arr[3] === 0 &&
    arr[6] === 0 && arr[7] === 0 &&
    arr[8] === 0 && arr[9] === 0 && arr[10] === 1 && arr[11] === 0 &&
    arr[14] === 0 && arr[15] === 1;
  if (!ok) {
    throw new TypeError('DOMMatrix: 16-element init must encode a 2D matrix');
  }
  return SmMatrix.components(arr[0], arr[1], arr[4], arr[5], arr[12], arr[13]);
}

function matrixFromTypedArray(arr: Float32Array | Float64Array): ZigMatrix {
  if (arr.length === 6) {
    return SmMatrix.components(arr[0], arr[1], arr[2], arr[3], arr[4], arr[5]);
  }
  if (arr.length === 16) {
    return matrixFrom16(arr);
  }
  throw new TypeError('DOMMatrix: typed array must have 6 or 16 elements');
}

export class DOMMatrix {
  /** @internal */ [ZIG]: ZigMatrix;

  constructor(init?: number[] | string) {
    if (init === undefined) {
      this[ZIG] = SmMatrix.identity();
    } else if (typeof init === 'string') {
      throw new Error('DOMMatrix: SVG transform-string init not supported');
    } else if (Array.isArray(init) && init.length === 6) {
      const [a, b, c, d, e, f] = init as [number, number, number, number, number, number];
      this[ZIG] = SmMatrix.components(a, b, c, d, e, f);
    } else if (Array.isArray(init) && init.length === 16) {
      this[ZIG] = matrixFrom16(init);
    } else {
      throw new TypeError('DOMMatrix: only 6- or 16-element init array supported');
    }
  }

  /** @internal */
  static [FROM_ZIG](zig: ZigMatrix): DOMMatrix {
    const obj = Object.create(DOMMatrix.prototype) as DOMMatrix;
    (obj as { [ZIG]: ZigMatrix })[ZIG] = zig;
    return obj;
  }

  static fromFloat32Array(arr: Float32Array): DOMMatrix {
    return DOMMatrix[FROM_ZIG](matrixFromTypedArray(arr));
  }
  static fromFloat64Array(arr: Float64Array): DOMMatrix {
    return DOMMatrix[FROM_ZIG](matrixFromTypedArray(arr));
  }
  static fromMatrix(other?: DOMMatrix | DOMMatrix2DInit): DOMMatrix {
    if (other === undefined) return new DOMMatrix();
    if (other instanceof DOMMatrix) {
      return DOMMatrix[FROM_ZIG](
        SmMatrix.components(other.a, other.b, other.c, other.d, other.e, other.f),
      );
    }
    const o = other as DOMMatrix2DInit;
    const a = o.a ?? o.m11 ?? 1;
    const b = o.b ?? o.m12 ?? 0;
    const c = o.c ?? o.m21 ?? 0;
    const d = o.d ?? o.m22 ?? 1;
    const e = o.e ?? o.m41 ?? 0;
    const f = o.f ?? o.m42 ?? 0;
    return DOMMatrix[FROM_ZIG](SmMatrix.components(a, b, c, d, e, f));
  }

  get a(): number { return this[ZIG].a; }
  get b(): number { return this[ZIG].b; }
  get c(): number { return this[ZIG].c; }
  get d(): number { return this[ZIG].d; }
  get e(): number { return this[ZIG].e; }
  get f(): number { return this[ZIG].f; }
  set a(v: number) { this[ZIG].a = v; }
  set b(v: number) { this[ZIG].b = v; }
  set c(v: number) { this[ZIG].c = v; }
  set d(v: number) { this[ZIG].d = v; }
  set e(v: number) { this[ZIG].e = v; }
  set f(v: number) { this[ZIG].f = v; }

  // 4×4 aliases for the 2D positions (per WebIDL, m11..m42 alias a..f).
  get m11(): number { return this[ZIG].a; }
  get m12(): number { return this[ZIG].b; }
  get m21(): number { return this[ZIG].c; }
  get m22(): number { return this[ZIG].d; }
  get m41(): number { return this[ZIG].e; }
  get m42(): number { return this[ZIG].f; }
  set m11(v: number) { this[ZIG].a = v; }
  set m12(v: number) { this[ZIG].b = v; }
  set m21(v: number) { this[ZIG].c = v; }
  set m22(v: number) { this[ZIG].d = v; }
  set m41(v: number) { this[ZIG].e = v; }
  set m42(v: number) { this[ZIG].f = v; }

  // 3D-only positions — this implementation is forced-2D, so they read as
  // identity values and have no setters.
  get m13(): number { return 0; }
  get m14(): number { return 0; }
  get m23(): number { return 0; }
  get m24(): number { return 0; }
  get m31(): number { return 0; }
  get m32(): number { return 0; }
  get m33(): number { return 1; }
  get m34(): number { return 0; }
  get m43(): number { return 0; }
  get m44(): number { return 1; }

  get is2D(): boolean { return true; }
  get isIdentity(): boolean {
    const m = this[ZIG];
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
  }

  multiplySelf(other: DOMMatrix): DOMMatrix {
    this[ZIG].multiplySelf(other[ZIG]);
    return this;
  }
  preMultiplySelf(other: DOMMatrix): DOMMatrix {
    this[ZIG].preMultiplySelf(other[ZIG]);
    return this;
  }
  translateSelf(tx: number, ty: number): DOMMatrix {
    this[ZIG].translateSelf(tx, ty);
    return this;
  }
  scaleSelf(sx: number, sy: number): DOMMatrix {
    this[ZIG].scaleSelf(sx, sy);
    return this;
  }
  rotateSelf(angleDegrees: number): DOMMatrix {
    this[ZIG].rotateSelf(angleDegrees);
    return this;
  }
  rotateFromVectorSelf(x: number, y: number): DOMMatrix {
    const angle = (x === 0 && y === 0) ? 0 : Math.atan2(y, x) * (180 / Math.PI);
    this[ZIG].rotateSelf(angle);
    return this;
  }
  rotateAxisAngleSelf(x: number, y: number, z: number, angleDegrees: number): DOMMatrix {
    if (x === 0 && y === 0 && z > 0) {
      this[ZIG].rotateSelf(angleDegrees);
      return this;
    }
    throw new Error('DOMMatrix.rotateAxisAngleSelf: only positive z-axis rotation supported in 2D');
  }
  scale3dSelf(scale: number, originX: number = 0, originY: number = 0, originZ: number = 0): DOMMatrix {
    if (originZ !== 0) {
      throw new Error('DOMMatrix.scale3dSelf: 3D origin not supported');
    }
    if (originX === 0 && originY === 0) {
      this[ZIG].scaleSelf(scale, scale);
    } else {
      this[ZIG].translateSelf(originX, originY);
      this[ZIG].scaleSelf(scale, scale);
      this[ZIG].translateSelf(-originX, -originY);
    }
    return this;
  }
  skewXSelf(angleDegrees: number): DOMMatrix {
    this[ZIG].skewXSelf(angleDegrees);
    return this;
  }
  skewYSelf(angleDegrees: number): DOMMatrix {
    this[ZIG].skewYSelf(angleDegrees);
    return this;
  }
  invertSelf(): DOMMatrix {
    this[ZIG].invertSelf();
    return this;
  }
}

// =============================================================================
// HTML5: Path2D
// =============================================================================

export class Path2D {
  /** @internal */ [ZIG]: ZigPath;

  constructor(other?: Path2D | string) {
    let p: ZigPath;
    if (other === undefined) {
      p = SmPath.empty();
    } else if (typeof other === 'string') {
      throw new Error('Path2D: SVG path-data string constructor not supported');
    } else if (other instanceof Path2D) {
      p = other[ZIG].copy();
    } else {
      throw new TypeError('Path2D: expected Path2D or undefined');
    }
    this[ZIG] = p;
    pathRegistry.register(this, p, this);
  }

  closePath(): void { this[ZIG].closePath(); }
  moveTo(x: number, y: number): void { this[ZIG].moveTo(x, y); }
  lineTo(x: number, y: number): void { this[ZIG].lineTo(x, y); }
  bezierCurveTo(
    cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number,
  ): void {
    this[ZIG].bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this[ZIG].quadraticCurveTo(cpx, cpy, x, y);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this[ZIG].rect(x, y, w, h);
  }
  arc(
    cx: number, cy: number, r: number,
    startAngle: number, endAngle: number,
    counterclockwise: boolean = false,
  ): void {
    this[ZIG].arc(cx, cy, r, startAngle, endAngle, counterclockwise);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (typeof r === 'number' && isFinite(r) && r < 0) {
      throw new DOMException('arcTo: negative radius', 'IndexSizeError');
    }
    this[ZIG].arcTo(x1, y1, x2, y2, r);
  }
  roundRect(
    x: number, y: number, w: number, h: number,
    radii?: number | DOMPointInit | Array<number | DOMPointInit>,
  ): void {
    const rs = normalizeRoundRectRadii(radii);
    if (rs === null) return;
    this[ZIG].roundRect(x, y, w, h, rs[0], rs[1], rs[2], rs[3]);
  }
  ellipse(
    cx: number, cy: number, rx: number, ry: number, rotation: number,
    startAngle: number, endAngle: number,
    counterclockwise: boolean = false,
  ): void {
    this[ZIG].ellipse(cx, cy, rx, ry, rotation, startAngle, endAngle, counterclockwise);
  }
  addPath(other: Path2D, transform?: DOMMatrix): void {
    if (transform !== undefined) {
      this[ZIG].addPathTransform(other[ZIG], transform[ZIG]);
    } else {
      this[ZIG].addPath(other[ZIG]);
    }
  }
}

// =============================================================================
// HTML5: CanvasGradient
// =============================================================================
//
// No public constructor — instances come from
// `ctx.createLinearGradient` / `ctx.createRadialGradient`.

export class CanvasGradient {
  /** @internal */ [ZIG]: ZigGradient;

  /** @internal — module-internal construction only. */
  constructor(zig: ZigGradient) {
    this[ZIG] = zig;
    gradientRegistry.register(this, zig, this);
  }

  addColorStop(offset: number, color: string): void {
    this[ZIG].addColorStop(offset, color);
  }
}

// =============================================================================
// HTML5: CanvasPattern
// =============================================================================
//
// No public constructor — instances come from `ctx.createPattern(image, rep)`.
// Snapshots the source image at construction time, so subsequent mutations to
// the source ImageData/Canvas don't affect the pattern (matches HTML5 spec).

const REPETITION_TO_ENUM: { [k: string]: 0 | 1 | 2 | 3 } = {
  'repeat': 0,
  'repeat-x': 1,
  'repeat-y': 2,
  'no-repeat': 3,
};

export interface DOMMatrix2DInit {
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  f?: number;
  m11?: number;
  m12?: number;
  m21?: number;
  m22?: number;
  m41?: number;
  m42?: number;
}

export class CanvasPattern {
  /** @internal */ [ZIG]: ZigPattern;

  /** @internal — module-internal construction only. */
  constructor(zig: ZigPattern) {
    this[ZIG] = zig;
    patternRegistry.register(this, zig, this);
  }

  setTransform(matrix?: DOMMatrix | DOMMatrix2DInit): void {
    let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
    if (matrix instanceof DOMMatrix) {
      a = matrix.a; b = matrix.b; c = matrix.c;
      d = matrix.d; e = matrix.e; f = matrix.f;
    } else if (matrix && typeof matrix === 'object') {
      a = matrix.a ?? 1;
      b = matrix.b ?? 0;
      c = matrix.c ?? 0;
      d = matrix.d ?? 1;
      e = matrix.e ?? 0;
      f = matrix.f ?? 0;
    }
    this[ZIG].setTransform(a, b, c, d, e, f);
  }
}

// =============================================================================
// HTML5: CanvasRenderingContext2D
// =============================================================================

// Full HTML5 globalCompositeOperation set (W3C Compositing & Blending L1)
// mapped to the matching `BlendMode` enum value on the Zig side. Note
// `BlendMode.src` is INTERNAL (clearRect's hardcoded paint) — HTML5 'copy'
// maps to `BlendMode.copy`, which triggers the layer-composite path so
// pixels outside the source region also become transparent per spec.
type ZigBlendName =
  | 'src_over' | 'src_in' | 'src_out' | 'src_atop'
  | 'dst_over' | 'dst_in' | 'dst_out' | 'dst_atop'
  | 'copy' | 'xor' | 'add'
  | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color_dodge' | 'color_burn' | 'hard_light' | 'soft_light'
  | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

const HTML5_TO_BLEND: { [k: string]: ZigBlendName } = {
  'source-over': 'src_over',
  'source-in': 'src_in',
  'source-out': 'src_out',
  'source-atop': 'src_atop',
  'destination-over': 'dst_over',
  'destination-in': 'dst_in',
  'destination-out': 'dst_out',
  'destination-atop': 'dst_atop',
  'copy': 'copy',
  'xor': 'xor',
  'lighter': 'add',
  'multiply': 'multiply',
  'screen': 'screen',
  'overlay': 'overlay',
  'darken': 'darken',
  'lighten': 'lighten',
  'color-dodge': 'color_dodge',
  'color-burn': 'color_burn',
  'hard-light': 'hard_light',
  'soft-light': 'soft_light',
  'difference': 'difference',
  'exclusion': 'exclusion',
  'hue': 'hue',
  'saturation': 'saturation',
  'color': 'color',
  'luminosity': 'luminosity',
};

const BLEND_TO_HTML5: { [k: string]: string } = {
  src_over: 'source-over',
  src_in: 'source-in',
  src_out: 'source-out',
  src_atop: 'source-atop',
  dst_over: 'destination-over',
  dst_in: 'destination-in',
  dst_out: 'destination-out',
  dst_atop: 'destination-atop',
  copy: 'copy',
  xor: 'xor',
  add: 'lighter',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  color_dodge: 'color-dodge',
  color_burn: 'color-burn',
  hard_light: 'hard-light',
  soft_light: 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

// Line cap / join / fill rule enum maps. Same pattern as HTML5_TO_BLEND.
type ZigLineCapName = 'butt' | 'round' | 'square';
type ZigLineJoinName = 'miter' | 'bevel' | 'round';
type ZigFillRuleName = 'nonzero' | 'evenodd';

const HTML5_TO_LINECAP: { [k: string]: ZigLineCapName } = {
  'butt': 'butt',
  'round': 'round',
  'square': 'square',
};

const HTML5_TO_LINEJOIN: { [k: string]: ZigLineJoinName } = {
  'miter': 'miter',
  'bevel': 'bevel',
  'round': 'round',
};

const HTML5_TO_FILLRULE: { [k: string]: ZigFillRuleName } = {
  'nonzero': 'nonzero',
  'evenodd': 'evenodd',
};

function bytesToBase64(bytes: ZigBytes): string {
  const buf = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes[i]!;
  return buf.toString('base64');
}

// =============================================================================
// Fonts: registry, CSS-shorthand parser, TextMetrics
// =============================================================================
//
// Architecture:
//   - `fontRegistry`  : Map<familyKey, Uint8Array>  — TTF bytes per family
//   - `fontInstances` : Map<"family|sizePx", ZigFont>  — cached SmFont proxies
//   - On `ctx.font = '...'`:
//       parseCssFont → resolve family list → look up bytes → get/create
//       SmFont at the requested pixel size → cache the result
//
// The default Inter font (embedded in WASM via @embedFile) is registered
// at module load against the four CSS generic families so out-of-the-box
// `'10px sans-serif'` works without `registerFont(...)`.

function zigBytesToU8(b: ZigBytes): Uint8Array {
  const dv = b.dataView;
  // Defensive copy — under WASM, the source buffer is the module's linear
  // memory, which gets detached when Zig allocations grow it. Anything we
  // need to survive past this call has to be in a JS-owned ArrayBuffer.
  const out = new Uint8Array(dv.byteLength);
  out.set(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  return out;
}

interface RegisteredFace {
  weight: number;
  style: FontStyle;
  bytes: Uint8Array;
}
const fontRegistry = new Map<string, RegisteredFace[]>();
const fontInstances = new Map<string, ZigFont>();

// Read a SFNT table directory entry by 4-char tag. Returns null if the
// bytes don't look like a single TrueType / OpenType font, or the tag is
// absent. Doesn't handle TTC collections (would need a 'ttcf' header path).
function readSfntTable(bytes: Uint8Array, tag: string): { offset: number; length: number } | null {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);
  const t0 = tag.charCodeAt(0), t1 = tag.charCodeAt(1), t2 = tag.charCodeAt(2), t3 = tag.charCodeAt(3);
  for (let i = 0; i < numTables; i++) {
    const recOff = 12 + i * 16;
    if (recOff + 16 > bytes.length) return null;
    if (bytes[recOff] === t0 && bytes[recOff + 1] === t1 &&
        bytes[recOff + 2] === t2 && bytes[recOff + 3] === t3) {
      return {
        offset: dv.getUint32(recOff + 8),
        length: dv.getUint32(recOff + 12),
      };
    }
  }
  return null;
}

// Auto-detect (weight, style) from OS/2.usWeightClass and head.macStyle.
// Both default to 400 / 'normal' when the tables are missing or malformed.
function detectFaceMetadata(bytes: Uint8Array): { weight: number; style: FontStyle } {
  let weight = 400;
  let style: FontStyle = 'normal';
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const os2 = readSfntTable(bytes, 'OS/2');
    if (os2 && os2.offset + 6 <= bytes.length) {
      const w = dv.getUint16(os2.offset + 4);
      if (w >= 1 && w <= 1000) weight = w;
    }
    const head = readSfntTable(bytes, 'head');
    if (head && head.offset + 46 <= bytes.length) {
      const macStyle = dv.getUint16(head.offset + 44);
      if ((macStyle & 0x2) !== 0) style = 'italic';
    }
  } catch {
    // Malformed — keep defaults.
  }
  return { weight, style };
}

interface FaceMatchResult {
  bytes: Uint8Array;
  weight: number;
  style: FontStyle;
  fauxBold: boolean;
  fauxItalic: boolean;
}

const STYLE_FALLBACK: Record<FontStyle, FontStyle[]> = {
  italic: ['italic', 'oblique', 'normal'],
  oblique: ['oblique', 'italic', 'normal'],
  normal: ['normal', 'oblique', 'italic'],
};

// CSS Fonts Module 3 §5.2 weight-distance algorithm. Returns a sort key
// where lower = better. First component is the tier (0 = ideal range,
// 1 = first fallback, 2 = second fallback); second is the |delta| within
// that tier.
function weightDistanceKey(target: number, faceWeight: number): [number, number] {
  if (target >= 400 && target <= 500) {
    if (faceWeight >= target && faceWeight <= 500) return [0, faceWeight - target];
    if (faceWeight < target) return [1, target - faceWeight];
    return [2, faceWeight - 500];
  }
  if (target < 400) {
    if (faceWeight <= target) return [0, target - faceWeight];
    return [1, faceWeight - target];
  }
  if (faceWeight >= target) return [0, faceWeight - target];
  return [1, target - faceWeight];
}

// Pick the best face for (targetWeight, targetStyle) from a registered
// family. Returns the matched bytes and faux-styling flags — `fauxBold`
// flips on whenever the target is ≥600 but the matched face's weight is
// <600; `fauxItalic` flips on when the target wants italic/oblique but
// only normal-style faces are registered.
function pickFace(faces: RegisteredFace[], targetWeight: number, targetStyle: FontStyle): FaceMatchResult | null {
  if (faces.length === 0) return null;

  let candidates: RegisteredFace[] = [];
  let chosenStyle: FontStyle = 'normal';
  for (const s of STYLE_FALLBACK[targetStyle]) {
    candidates = faces.filter(f => f.style === s);
    if (candidates.length > 0) { chosenStyle = s; break; }
  }
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestKey = weightDistanceKey(targetWeight, best.weight);
  for (let i = 1; i < candidates.length; i++) {
    const f = candidates[i]!;
    const key = weightDistanceKey(targetWeight, f.weight);
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = f;
      bestKey = key;
    }
  }

  const fauxBold = targetWeight >= 600 && best.weight < 600;
  const fauxItalic = (targetStyle === 'italic' || targetStyle === 'oblique') && chosenStyle === 'normal';
  return {
    bytes: best.bytes,
    weight: best.weight,
    style: chosenStyle,
    fauxBold,
    fauxItalic,
  };
}

// Insert a face into a family's face list, replacing any prior face with
// the same (weight, style) coordinates so the latest call wins.
function upsertFace(family: string, face: RegisteredFace): void {
  const key = family.toLowerCase();
  let faces = fontRegistry.get(key);
  if (!faces) {
    faces = [];
    fontRegistry.set(key, faces);
  }
  const idx = faces.findIndex(f => f.weight === face.weight && f.style === face.style);
  if (idx >= 0) faces[idx] = face;
  else faces.push(face);
  // Drop any cached SmFonts for this family — selection may now resolve
  // differently (a newly-registered Bold can win over a faux-bold cache).
  const prefix = `${key}|`;
  for (const k of [...fontInstances.keys()]) {
    if (k.startsWith(prefix)) fontInstances.delete(k);
  }
}

// Lazy: `defaultFontBytes()` reaches into the WASM module, so it can't run
// until `init()` has resolved (Workers/browsers). First access seeds the
// registry too, so user-facing lookups for `sans-serif` etc. just work.
const DEFAULT_FAMILIES = ['sans-serif', 'serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace'];
let defaultFamilyBytesCache: Uint8Array | null = null;
function getDefaultFamilyBytes(): Uint8Array {
  if (defaultFamilyBytesCache) return defaultFamilyBytesCache;
  defaultFamilyBytesCache = zigBytesToU8(defaultFontBytes());
  // Embedded Manrope is variable but pinned at the default instance
  // (Regular). Register it as a single 400/normal face under each generic
  // family — face matching will faux-bold / faux-italic when the lookup
  // asks for something different.
  const defaultFace: RegisteredFace = {
    weight: 400,
    style: 'normal',
    bytes: defaultFamilyBytesCache,
  };
  for (const fam of DEFAULT_FAMILIES) {
    if (!fontRegistry.has(fam)) fontRegistry.set(fam, [defaultFace]);
  }
  return defaultFamilyBytesCache;
}

/**
 * Register a TTF/OTF font under one or more CSS family names. Mirrors the
 * non-spec `registerFont` extension that node-canvas / @napi-rs/canvas
 * expose. Family lookup is case-insensitive.
 *
 * After registration, set `ctx.font` to a CSS shorthand string that names
 * the family (e.g. `'14px MyFont'`) to use it.
 */
/**
 * Single entry in the `fonts` array passed to `createCanvas(w, h, { fonts })`.
 * `data` must be already-fetched TTF or OTF bytes; WOFF / WOFF2 are not decoded.
 * `name` becomes the family selector for `ctx.font = '<size>px <name>'`.
 * `weight` / `style` describe the registered face — when omitted, simdra
 * auto-detects them from the font's `OS/2.usWeightClass` / `head.macStyle`.
 */
export interface FontInit {
  name: string;
  data: ArrayBuffer | ArrayBufferView;
  weight?: number | string;
  style?: FontStyle;
}

/**
 * Optional second-arg bag for `createCanvas` / `new Canvas`. Today only carries
 * `fonts`, a non-spec convenience that registers each entry via `registerFont`
 * before the constructor returns.
 */
export interface CanvasOptions {
  fonts?: FontInit[];
}

/**
 * Optional descriptor for `registerFont` — pin the face's weight/style
 * explicitly. When omitted, simdra reads `OS/2.usWeightClass` and the
 * `head.macStyle` italic bit from the TTF/OTF bytes.
 */
export interface FontFaceDescriptor {
  weight?: number | string;
  style?: FontStyle;
}

export function registerFont(
  bytes: ArrayBufferView | ArrayBuffer,
  family: string,
  descriptor?: FontFaceDescriptor,
): void {
  if (typeof family !== 'string' || family.length === 0) {
    throw new TypeError('registerFont: family must be a non-empty string');
  }
  let view: Uint8Array;
  if (bytes instanceof Uint8Array) {
    view = bytes;
  } else if (ArrayBuffer.isView(bytes)) {
    view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else if (bytes instanceof ArrayBuffer) {
    view = new Uint8Array(bytes);
  } else {
    throw new TypeError('registerFont: bytes must be an ArrayBuffer or ArrayBufferView');
  }

  const detected = detectFaceMetadata(view);
  const weight = resolveWeightDescriptor(descriptor?.weight, detected.weight);
  const style: FontStyle = descriptor?.style ?? detected.style;
  upsertFace(family, { weight, style, bytes: view });
}

function resolveWeightDescriptor(input: number | string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (typeof input === 'number' && Number.isFinite(input) && input >= 1 && input <= 1000) {
    return Math.round(input);
  }
  if (typeof input === 'string') {
    const lc = input.toLowerCase();
    const kw = WEIGHT_KEYWORDS[lc];
    if (kw !== undefined) return kw;
    const num = Number(lc);
    if (Number.isFinite(num) && num >= 1 && num <= 1000) return Math.round(num);
  }
  return fallback;
}

type FontStyle = 'normal' | 'italic' | 'oblique';
interface ParsedFont {
  sizePx: number;
  families: string[];
  weight: number;
  style: FontStyle;
  canonical: string;
}

// CSS Fonts Module 3 keyword sets. `normal` is intentionally absent from
// the style keyword set because it's the default — accepting it as a style
// token would shadow its valid uses as a font-variant / font-stretch /
// font-weight value (CSS lets it appear in any of those slots and the
// shorthand has to disambiguate by position; we just leave defaults alone
// when we see it).
const STYLE_KEYWORDS = new Set(['italic', 'oblique']);
const WEIGHT_KEYWORDS: Record<string, number> = {
  normal: 400,
  bold: 700,
  // bolder / lighter are computed-against-parent in CSS; outside a DOM
  // there's no parent, so we collapse to the most common practical mapping.
  bolder: 700,
  lighter: 300,
};
const VARIANT_KEYWORDS = new Set(['normal', 'small-caps']);
const STRETCH_KEYWORDS = new Set([
  'normal', 'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed',
  'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded',
]);

// CSS font-shorthand parser. Recognises optional leading style / variant /
// weight / stretch tokens, the required `<size>px` (with optional
// `/<lineheight>` ignored), and a comma-separated family list.
//   '12px sans-serif'              → 400, normal, 12, ['sans-serif']
//   'bold 14.5px Arial'            → 700, normal, 14.5, ['arial']
//   'italic 700 16px "Helv", sans' → 700, italic, 16, ['helv', 'sans']
//   '300 italic 24px/1.5 Inter'    → 300, italic, 24, ['inter']
// Returns null if the size+family core can't be located; callers keep the
// previous font (HTML5 spec: invalid font assignments are silently ignored).
function parseCssFont(input: string): ParsedFont | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Locate the size token (number followed by 'px', optionally followed by
  // `/<line-height>`). Anchored to a word boundary so '12pxxx' won't match.
  const sizeRe = /(?:^|\s)(\d+(?:\.\d+)?)\s*px(?:\s*\/\s*\S+)?(?=\s|$)/;
  const sizeMatch = sizeRe.exec(trimmed);
  if (!sizeMatch) return null;
  const sizePx = parseFloat(sizeMatch[1]!);
  if (!isFinite(sizePx) || sizePx <= 0) return null;

  const sizeStart = sizeMatch.index + (sizeMatch[0]!.startsWith(' ') ? 1 : 0);
  const sizeEnd = sizeMatch.index + sizeMatch[0]!.length;
  const prefix = trimmed.slice(0, sizeStart).trim();
  const familiesRaw = trimmed.slice(sizeEnd).trim();

  let style: FontStyle = 'normal';
  let weight = 400;
  let styleSet = false;
  let weightSet = false;

  if (prefix) {
    const tokens = prefix.split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      const lc = t.toLowerCase();
      if (!styleSet && STYLE_KEYWORDS.has(lc)) {
        style = lc as FontStyle;
        styleSet = true;
        continue;
      }
      if (!weightSet) {
        if (WEIGHT_KEYWORDS[lc] !== undefined) {
          weight = WEIGHT_KEYWORDS[lc]!;
          weightSet = true;
          continue;
        }
        const num = Number(lc);
        if (Number.isFinite(num) && Number.isInteger(num) && num >= 1 && num <= 1000) {
          weight = num;
          weightSet = true;
          continue;
        }
      }
      // Accept-and-ignore: variant / stretch / unknown tokens. Spec-strict
      // parsers reject unknowns, but in practice libraries pass odd things
      // and silently dropping them is friendlier than rejecting the whole
      // shorthand.
      if (VARIANT_KEYWORDS.has(lc) || STRETCH_KEYWORDS.has(lc)) continue;
    }
  }

  if (!familiesRaw) return null;
  const families = familiesRaw
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean);
  if (families.length === 0) return null;

  // Canonicalize per HTML5: `[<style>] [<weight>] <size>px <family-list>`.
  // Style/weight emitted only when non-default, matching what browsers do.
  const parts: string[] = [];
  if (style !== 'normal') parts.push(style);
  if (weight !== 400) parts.push(String(weight));
  parts.push(`${sizePx}px`);
  parts.push(families.join(', '));
  const canonical = parts.join(' ');

  return { sizePx, families, weight, style, canonical };
}

function buildSmFont(bytes: Uint8Array, sizePx: number, fauxBold: boolean, fauxItalic: boolean): ZigFont {
  const inst = SmFont.fromBytes(bytes, sizePx);
  if (fauxBold || fauxItalic) inst.setSynth(fauxBold, fauxItalic);
  return inst;
}

function getFontInstance(parsed: ParsedFont): ZigFont {
  // Seed default-family bytes on first use (and after `init()` has resolved).
  getDefaultFamilyBytes();

  for (const family of parsed.families) {
    const faces = fontRegistry.get(family);
    if (!faces) continue;
    const match = pickFace(faces, parsed.weight, parsed.style);
    if (!match) continue;
    const key = `${family}|${parsed.sizePx}|${parsed.weight}|${parsed.style}`;
    let inst = fontInstances.get(key);
    if (!inst) {
      inst = buildSmFont(match.bytes, parsed.sizePx, match.fauxBold, match.fauxItalic);
      fontInstances.set(key, inst);
    }
    return inst;
  }

  // No registered family matched; fall through to the default — sans-serif
  // is always seeded by `getDefaultFamilyBytes()`. Re-run face matching
  // against it so faux flags are populated for the fallback path too.
  const fallbackFaces = fontRegistry.get('sans-serif')!;
  const fbMatch = pickFace(fallbackFaces, parsed.weight, parsed.style)!;
  const fallbackKey = `sans-serif|${parsed.sizePx}|${parsed.weight}|${parsed.style}`;
  let inst = fontInstances.get(fallbackKey);
  if (!inst) {
    inst = buildSmFont(fbMatch.bytes, parsed.sizePx, fbMatch.fauxBold, fbMatch.fauxItalic);
    fontInstances.set(fallbackKey, inst);
  }
  return inst;
}

// CSS `filter` parser. Recognized ops: blur(<len>), brightness(<n%|n>),
// contrast(<n%|n>). Unknown filter functions (drop-shadow, hue-rotate,
// invert, sepia, ...) parse OK but become no-ops at render time. Returns
// `null` for unparseable input → spec says invalid filter is silently
// ignored.
type ParsedFilter = { verbs: number[]; params: number[] } | null;
function parseCssFilter(input: string): ParsedFilter {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === 'none') return { verbs: [], params: [] };
  const verbs: number[] = [];
  const params: number[] = [];
  // Match `funcname(args)` segments. Allow nested commas within args.
  const re = /([a-z-]+)\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(trimmed)) !== null) {
    consumed = m.index + m[0]!.length;
    const fn = m[1]!.toLowerCase();
    const arg = m[2]!.trim();
    switch (fn) {
      case 'blur': {
        const px = parseCssLengthPx(arg);
        if (px === null) return null;
        // sigma = blur / 2 (matches Chromium/Skia interpretation).
        verbs.push(0);
        params.push(px / 2);
        break;
      }
      case 'brightness': {
        const f = parseCssPercentOrNumber(arg);
        if (f === null) return null;
        verbs.push(1);
        params.push(f);
        break;
      }
      case 'contrast': {
        const f = parseCssPercentOrNumber(arg);
        if (f === null) return null;
        verbs.push(2);
        params.push(f);
        break;
      }
      default:
        // Unknown filter function — recognized but no-op at render time.
        break;
    }
  }
  // Anything left over after the last match means we couldn't parse it.
  if (trimmed.slice(consumed).trim() !== '') return null;
  return { verbs, params };
}

function parseCssPercentOrNumber(s: string): number | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (t.endsWith('%')) {
    const v = parseFloat(t.slice(0, -1));
    if (!isFinite(v)) return null;
    return v / 100;
  }
  const v = parseFloat(t);
  if (!isFinite(v)) return null;
  return v;
}

// Normalize HTML5 `roundRect` polymorphic `radii` argument into 4 scalar
// pixel radii (top-left, top-right, bottom-right, bottom-left). Supports:
//   - undefined            → [0, 0, 0, 0]
//   - number               → [r, r, r, r]
//   - DOMPointInit         → use .x for both axes (we don't model
//                              elliptical corners; HTML5 allows it but the
//                              SmPath roundRect takes circular radii)
//   - Array<number | DOMPointInit> length 1..4 (CSS shorthand pattern)
// Throws RangeError for negative finite values per spec; returns null on
// non-finite values to indicate "drop the call" (SmPath also rejects, but
// the JS spec wants explicit semantics).
type DOMPointInit = { x?: number; y?: number };
function normalizeRoundRectRadii(
  radii: number | DOMPointInit | Array<number | DOMPointInit> | undefined,
): [number, number, number, number] | null {
  const toScalar = (v: number | DOMPointInit | undefined): number | null => {
    if (v === undefined) return 0;
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      if (v < 0) throw new RangeError('roundRect: negative radius');
      return v;
    }
    if (v && typeof v === 'object') {
      const x = (v as DOMPointInit).x;
      if (x === undefined) return 0;
      if (typeof x !== 'number' || !isFinite(x)) return null;
      if (x < 0) throw new RangeError('roundRect: negative radius');
      return x;
    }
    return null;
  };
  if (radii === undefined) return [0, 0, 0, 0];
  if (typeof radii === 'number' || (radii && typeof radii === 'object' && !Array.isArray(radii))) {
    const r = toScalar(radii);
    if (r === null) return null;
    return [r, r, r, r];
  }
  if (Array.isArray(radii)) {
    if (radii.length === 0 || radii.length > 4) {
      throw new RangeError('roundRect: radii array must have length 1..4');
    }
    const r0 = toScalar(radii[0]);
    if (r0 === null) return null;
    if (radii.length === 1) return [r0, r0, r0, r0];
    const r1 = toScalar(radii[1]);
    if (r1 === null) return null;
    if (radii.length === 2) return [r0, r1, r0, r1];
    const r2 = toScalar(radii[2]);
    if (r2 === null) return null;
    if (radii.length === 3) return [r0, r1, r2, r1];
    const r3 = toScalar(radii[3]);
    if (r3 === null) return null;
    return [r0, r1, r2, r3];
  }
  return null;
}

const TEXT_ALIGNS = new Set(['start', 'end', 'left', 'right', 'center']);
const TEXT_BASELINES = new Set(['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom']);
const DIRECTIONS = new Set(['ltr', 'rtl', 'inherit']);
const FONT_KERNINGS = new Set(['auto', 'normal', 'none']);
const IMAGE_SMOOTHING_QUALITIES = new Set(['low', 'medium', 'high']);

// Subset CSS-length parser for letterSpacing/wordSpacing. HTML5/CSS allows
// many length units (`em`, `rem`, `pt`, ...) but in canvas they all collapse
// to pixel-space at parse time. We support `px` directly. Other units cause
// the assignment to be silently ignored per the HTML5 invalidates-other rule.
function parseCssLengthPx(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*px\s*$/i.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  if (!isFinite(v)) return null;
  return v;
}

function canonicalLengthPx(v: number): string {
  return `${v}px`;
}

export class TextMetrics {
  readonly width: number;
  /** @internal */ constructor(width: number) {
    this.width = width;
  }
}

function rgbaU32ToCssString(rgba: number): string {
  const r = rgba & 0xff;
  const g = (rgba >>> 8) & 0xff;
  const b = (rgba >>> 16) & 0xff;
  const a = (rgba >>> 24) & 0xff;
  if (a === 0xff) {
    // Canonical hex form for fully opaque.
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(4).replace(/\.?0+$/, '') || '0'})`;
}

export class CanvasRenderingContext2D {
  /** @internal */ [ZIG]: ZigCanvas;
  // Cached canonical strings so getter round-trips return what was set.
  #fillStyleStr: string = '#000000';
  #strokeStyleStr: string = '#000000';
  // When fillStyle/strokeStyle are set to a CanvasGradient or CanvasPattern,
  // hold the wrapper here. The Zig side stores a *const SmGradient/SmPattern
  // pointer; this reference keeps that handle alive (and reachable through
  // the FinalizationRegistry) for as long as it's the active style.
  #fillStyleObj: CanvasGradient | CanvasPattern | null = null;
  #strokeStyleObj: CanvasGradient | CanvasPattern | null = null;

  // ---- Text state -------------------------------------------------------
  // HTML5 default font is `'10px sans-serif'`.
  #fontStr: string = '10px sans-serif';
  // Lazy: resolving a font reaches into WASM, which isn't available until
  // `init()` resolves. First access (after init) materializes it.
  #fontInstance: ZigFont | null = null;
  #getFontInstance(): ZigFont {
    return this.#fontInstance ??= getFontInstance(parseCssFont(this.#fontStr)!);
  }
  #textAlign: 'start' | 'end' | 'left' | 'right' | 'center' = 'start';
  #textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom' = 'alphabetic';
  #direction: 'ltr' | 'rtl' | 'inherit' = 'inherit';
  #letterSpacing: string = '0px';
  #letterSpacingPx: number = 0;
  #wordSpacing: string = '0px';
  #wordSpacingPx: number = 0;
  #fontKerning: 'auto' | 'normal' | 'none' = 'auto';
  // No font-variant infrastructure yet; stored verbatim, no rendering effect.
  #fontStretch: string = 'normal';
  #fontVariantCaps: string = 'normal';
  // stb_truetype offers no hinting toggle; stored verbatim, no rendering effect.
  #textRendering: string = 'auto';
  // Filter chain rendering lands in phase 7; phase 1 stores verbatim.
  #filter: string = 'none';
  // Image smoothing storage; phase 4 wires the bilinear branch.
  #imageSmoothingEnabled: boolean = true;
  #imageSmoothingQuality: 'low' | 'medium' | 'high' = 'low';
  #shadowBlur: number = 0;
  #shadowColorStr: string = 'rgba(0, 0, 0, 0)';
  #shadowOffsetX: number = 0;
  #shadowOffsetY: number = 0;
  #canvas: Canvas;

  /** @internal — only `Canvas.getContext('2d')` constructs these. */
  constructor(canvas: Canvas, zig: ZigCanvas) {
    this[ZIG] = zig;
    this.#canvas = canvas;
  }

  get canvas(): Canvas { return this.#canvas; }

  getContextAttributes(): {
    alpha: boolean;
    colorSpace: 'srgb';
    desynchronized: boolean;
    willReadFrequently: boolean;
  } {
    return {
      alpha: true,
      colorSpace: 'srgb',
      desynchronized: false,
      willReadFrequently: false,
    };
  }

  /**
   * Drop the JS-side references this context holds. The underlying SmCanvas
   * is owned by the SmSurface and is deinit'd when `Canvas#destroy()` runs;
   * this method is a no-op for Zig memory but releases JS-held strong refs
   * to gradient / pattern style objects so they GC sooner. Idempotent.
   */
  destroy(): void {
    this.#fillStyleObj = null;
    this.#strokeStyleObj = null;
    this.#fontInstance = null;
  }

  [Symbol.dispose](): void { this.destroy(); }

  // ---- State ------------------------------------------------------------
  save(): void { this[ZIG].save(); }
  restore(): void { this[ZIG].restore(); }
  reset(): void {
    this[ZIG].reset();
    // Reset JS-side mirror fields (those not stored in Zig).
    this.#fillStyleStr = '#000000';
    this.#strokeStyleStr = '#000000';
    this.#fillStyleObj = null;
    this.#strokeStyleObj = null;
    this.#fontStr = '10px sans-serif';
    this.#fontInstance = getFontInstance(parseCssFont(this.#fontStr)!);
    this.#textAlign = 'start';
    this.#textBaseline = 'alphabetic';
    this.#direction = 'inherit';
    this.#letterSpacing = '0px';
    this.#letterSpacingPx = 0;
    this.#wordSpacing = '0px';
    this.#wordSpacingPx = 0;
    this.#fontKerning = 'auto';
    this.#fontStretch = 'normal';
    this.#fontVariantCaps = 'normal';
    this.#textRendering = 'auto';
    this.#filter = 'none';
    this.#imageSmoothingEnabled = true;
    this.#imageSmoothingQuality = 'low';
    this.#shadowBlur = 0;
    this.#shadowColorStr = 'rgba(0, 0, 0, 0)';
    this.#shadowOffsetX = 0;
    this.#shadowOffsetY = 0;
    // Filter chain is cleared by the Zig reset() which empties filter_verbs.
    // Re-send an empty chain to be defensive in case zigar buffer state lags.
    this[ZIG].setFilterChain(new Uint8Array(0), new Float64Array(0));
  }

  // ---- Transforms -------------------------------------------------------
  translate(tx: number, ty: number): void { this[ZIG].translate(tx, ty); }
  rotate(angleRadians: number): void { this[ZIG].rotate(angleRadians); }
  scale(sx: number, sy: number): void { this[ZIG].scale(sx, sy); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this[ZIG].transform(a, b, c, d, e, f);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this[ZIG].setTransform(a, b, c, d, e, f);
  }
  resetTransform(): void { this[ZIG].resetTransform(); }
  getTransform(): DOMMatrix {
    return DOMMatrix[FROM_ZIG](this[ZIG].getTransform());
  }

  // ---- Styles (CSS strings per HTML5) -----------------------------------
  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.#fillStyleObj ?? this.#fillStyleStr;
  }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    if (v instanceof CanvasGradient) {
      this.#fillStyleObj = v;
      this[ZIG].setFillGradient(v[ZIG]);
      return;
    }
    if (v instanceof CanvasPattern) {
      this.#fillStyleObj = v;
      this[ZIG].setFillPattern(v[ZIG]);
      return;
    }
    if (typeof v !== 'string') return;
    const rgba = parseCssColor(v);
    if (rgba === null) return; // invalid input: silently ignored per spec
    this.#fillStyleObj = null;
    this.#fillStyleStr = rgbaU32ToCssString(rgba);
    this[ZIG].setFillStyle(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff, (rgba >>> 24) & 0xff);
  }
  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.#strokeStyleObj ?? this.#strokeStyleStr;
  }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    if (v instanceof CanvasGradient) {
      this.#strokeStyleObj = v;
      this[ZIG].setStrokeGradient(v[ZIG]);
      return;
    }
    if (v instanceof CanvasPattern) {
      this.#strokeStyleObj = v;
      this[ZIG].setStrokePattern(v[ZIG]);
      return;
    }
    if (typeof v !== 'string') return;
    const rgba = parseCssColor(v);
    if (rgba === null) return;
    this.#strokeStyleObj = null;
    this.#strokeStyleStr = rgbaU32ToCssString(rgba);
    this[ZIG].setStrokeStyle(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff, (rgba >>> 24) & 0xff);
  }
  get lineWidth(): number { return this[ZIG].lineWidth; }
  set lineWidth(v: number) {
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) return;
    this[ZIG].setLineWidth(v);
  }
  get lineCap(): string { return String(this[ZIG].lineCap); }
  set lineCap(v: string) {
    const mapped = HTML5_TO_LINECAP[v];
    if (mapped === undefined) return;
    this[ZIG].lineCap = mapped;
  }
  get lineJoin(): string { return String(this[ZIG].lineJoin); }
  set lineJoin(v: string) {
    const mapped = HTML5_TO_LINEJOIN[v];
    if (mapped === undefined) return;
    this[ZIG].lineJoin = mapped;
  }
  get miterLimit(): number { return this[ZIG].miterLimit; }
  set miterLimit(v: number) {
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) return;
    this[ZIG].setMiterLimit(v);
  }
  get lineDashOffset(): number { return this[ZIG].lineDashOffset; }
  set lineDashOffset(v: number) {
    if (typeof v !== 'number' || !isFinite(v)) return;
    this[ZIG].setLineDashOffset(v);
  }
  setLineDash(segments: number[]): void {
    if (!Array.isArray(segments)) return;
    // Spec: any non-finite or negative entry → invalid, ignored entirely.
    // The Zig setter re-validates as a defensive belt; we duplicate here so
    // we don't pay for a Float64Array allocation when the input is invalid.
    for (const s of segments) {
      if (typeof s !== 'number' || !isFinite(s) || s < 0) return;
    }
    const buf = new Float64Array(segments);
    this[ZIG].setLineDash(buf);
  }
  getLineDash(): number[] {
    const slice = this[ZIG].getLineDash();
    const out: number[] = [];
    for (let i = 0; i < slice.length; i++) out.push(slice[i] as number);
    return out;
  }

  // ---- Compositing ------------------------------------------------------
  get globalAlpha(): number { return this[ZIG].alpha / 255; }
  set globalAlpha(v: number) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) return;
    this[ZIG].alpha = Math.round(v * 255);
  }
  get globalCompositeOperation(): string {
    return BLEND_TO_HTML5[String(this[ZIG].blendMode)] ?? 'source-over';
  }
  set globalCompositeOperation(v: string) {
    const mapped = HTML5_TO_BLEND[v];
    if (mapped === undefined) return;
    this[ZIG].blendMode = mapped;
  }

  // ---- Drawing rectangles ----------------------------------------------
  fillRect(x: number, y: number, w: number, h: number): void {
    this[ZIG].fillRect(x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this[ZIG].strokeRect(x, y, w, h);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this[ZIG].clearRect(x, y, w, h);
  }

  // ---- Paths ------------------------------------------------------------
  beginPath(): void { this[ZIG].beginPath(); }
  closePath(): void { this[ZIG].closePath(); }
  moveTo(x: number, y: number): void { this[ZIG].moveTo(x, y); }
  lineTo(x: number, y: number): void { this[ZIG].lineTo(x, y); }
  bezierCurveTo(
    cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number,
  ): void {
    this[ZIG].bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this[ZIG].quadraticCurveTo(cpx, cpy, x, y);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this[ZIG].rect(x, y, w, h);
  }
  arc(
    cx: number, cy: number, r: number,
    startAngle: number, endAngle: number,
    counterclockwise: boolean = false,
  ): void {
    this[ZIG].arc(cx, cy, r, startAngle, endAngle, counterclockwise);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (typeof r === 'number' && isFinite(r) && r < 0) {
      throw new DOMException('arcTo: negative radius', 'IndexSizeError');
    }
    this[ZIG].arcTo(x1, y1, x2, y2, r);
  }
  roundRect(
    x: number, y: number, w: number, h: number,
    radii?: number | DOMPointInit | Array<number | DOMPointInit>,
  ): void {
    const rs = normalizeRoundRectRadii(radii);
    if (rs === null) return;
    this[ZIG].roundRect(x, y, w, h, rs[0], rs[1], rs[2], rs[3]);
  }
  ellipse(
    cx: number, cy: number, rx: number, ry: number, rotation: number,
    startAngle: number, endAngle: number,
    counterclockwise: boolean = false,
  ): void {
    this[ZIG].ellipse(cx, cy, rx, ry, rotation, startAngle, endAngle, counterclockwise);
  }
  fill(pathOrRule?: Path2D | 'nonzero' | 'evenodd', maybeRule?: 'nonzero' | 'evenodd'): void {
    let rule: ZigFillRuleName = 'nonzero';
    let path: Path2D | null = null;
    if (pathOrRule instanceof Path2D) {
      path = pathOrRule;
      if (maybeRule !== undefined) {
        const mapped = HTML5_TO_FILLRULE[maybeRule];
        if (mapped !== undefined) rule = mapped;
      }
    } else if (typeof pathOrRule === 'string') {
      const mapped = HTML5_TO_FILLRULE[pathOrRule];
      if (mapped !== undefined) rule = mapped;
    }
    if (path) {
      this[ZIG].fillPathExternal(path[ZIG], rule);
    } else {
      this[ZIG].fill(rule);
    }
  }
  stroke(path?: Path2D): void {
    if (path instanceof Path2D) {
      this[ZIG].strokePathExternal(path[ZIG]);
    } else {
      this[ZIG].stroke();
    }
  }
  isPointInPath(x: number, y: number, fillRule?: 'nonzero' | 'evenodd'): boolean;
  isPointInPath(path: Path2D, x: number, y: number, fillRule?: 'nonzero' | 'evenodd'): boolean;
  isPointInPath(
    a: Path2D | number,
    b: number,
    c?: number | 'nonzero' | 'evenodd',
    d?: 'nonzero' | 'evenodd',
  ): boolean {
    let path: Path2D | null = null;
    let x: number;
    let y: number;
    let rule: ZigFillRuleName = 'nonzero';
    if (a instanceof Path2D) {
      path = a;
      x = b;
      y = (c as number) ?? 0;
      const r = d;
      if (r !== undefined) {
        const mapped = HTML5_TO_FILLRULE[r];
        if (mapped !== undefined) rule = mapped;
      }
    } else {
      x = a;
      y = b;
      const r = c as 'nonzero' | 'evenodd' | undefined;
      if (r !== undefined) {
        const mapped = HTML5_TO_FILLRULE[r];
        if (mapped !== undefined) rule = mapped;
      }
    }
    if (path) return this[ZIG].isPointInPathExternal(path[ZIG], x, y, rule);
    return this[ZIG].isPointInPath(x, y, rule);
  }

  isPointInStroke(x: number, y: number): boolean;
  isPointInStroke(path: Path2D, x: number, y: number): boolean;
  isPointInStroke(a: Path2D | number, b: number, c?: number): boolean {
    if (a instanceof Path2D) {
      return this[ZIG].isPointInStrokeExternal(a[ZIG], b, c ?? 0);
    }
    return this[ZIG].isPointInStroke(a, b);
  }

  clip(pathOrRule?: Path2D | 'nonzero' | 'evenodd', maybeRule?: 'nonzero' | 'evenodd'): void {
    let rule: ZigFillRuleName = 'nonzero';
    let path: Path2D | null = null;
    if (pathOrRule instanceof Path2D) {
      path = pathOrRule;
      if (maybeRule !== undefined) {
        const mapped = HTML5_TO_FILLRULE[maybeRule];
        if (mapped !== undefined) rule = mapped;
      }
    } else if (typeof pathOrRule === 'string') {
      const mapped = HTML5_TO_FILLRULE[pathOrRule];
      if (mapped !== undefined) rule = mapped;
    }
    if (path) {
      this[ZIG].clipPath(path[ZIG], rule);
    } else {
      this[ZIG].clip(rule);
    }
  }

  // ---- Text -------------------------------------------------------------
  get font(): string { return this.#fontStr; }
  set font(v: string) {
    const parsed = parseCssFont(v);
    if (!parsed) return; // invalid: spec says ignore
    this.#fontStr = parsed.canonical;
    this.#fontInstance = getFontInstance(parsed);
  }
  get textAlign(): string { return this.#textAlign; }
  set textAlign(v: string) {
    if (TEXT_ALIGNS.has(v)) {
      this.#textAlign = v as 'start' | 'end' | 'left' | 'right' | 'center';
    }
  }
  get textBaseline(): string { return this.#textBaseline; }
  set textBaseline(v: string) {
    if (TEXT_BASELINES.has(v)) {
      this.#textBaseline = v as 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom';
    }
  }
  get direction(): string { return this.#direction; }
  set direction(v: string) {
    if (DIRECTIONS.has(v)) {
      this.#direction = v as 'ltr' | 'rtl' | 'inherit';
    }
  }
  get letterSpacing(): string { return this.#letterSpacing; }
  set letterSpacing(v: string) {
    const px = parseCssLengthPx(v);
    if (px === null) return;
    this.#letterSpacingPx = px;
    this.#letterSpacing = canonicalLengthPx(px);
  }
  get wordSpacing(): string { return this.#wordSpacing; }
  set wordSpacing(v: string) {
    const px = parseCssLengthPx(v);
    if (px === null) return;
    this.#wordSpacingPx = px;
    this.#wordSpacing = canonicalLengthPx(px);
  }
  get fontKerning(): string { return this.#fontKerning; }
  set fontKerning(v: string) {
    if (FONT_KERNINGS.has(v)) {
      this.#fontKerning = v as 'auto' | 'normal' | 'none';
    }
  }
  get fontStretch(): string { return this.#fontStretch; }
  set fontStretch(v: string) {
    // No font-variant infrastructure; accept any string but only round-trip.
    if (typeof v === 'string' && v.length > 0) this.#fontStretch = v;
  }
  get fontVariantCaps(): string { return this.#fontVariantCaps; }
  set fontVariantCaps(v: string) {
    if (typeof v === 'string' && v.length > 0) this.#fontVariantCaps = v;
  }
  get textRendering(): string { return this.#textRendering; }
  set textRendering(v: string) {
    if (typeof v === 'string' && v.length > 0) this.#textRendering = v;
  }
  get filter(): string { return this.#filter; }
  set filter(v: string) {
    if (typeof v !== 'string' || v.length === 0) return;
    const parsed = parseCssFilter(v);
    if (parsed === null) return; // Unparseable: silently ignored per spec.
    this.#filter = v.trim();
    const verbs = new Uint8Array(parsed.verbs);
    const params = new Float64Array(parsed.params);
    this[ZIG].setFilterChain(verbs, params);
  }
  get shadowBlur(): number { return this.#shadowBlur; }
  set shadowBlur(v: number) {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) return;
    this.#shadowBlur = v;
    this[ZIG].shadowBlur = v;
  }
  get shadowColor(): string { return this.#shadowColorStr; }
  set shadowColor(v: string) {
    if (typeof v !== 'string') return;
    const rgba = parseCssColor(v);
    if (rgba === null) return;
    this.#shadowColorStr = rgbaU32ToCssString(rgba);
    this[ZIG].shadowColor = rgba >>> 0;
  }
  get shadowOffsetX(): number { return this.#shadowOffsetX; }
  set shadowOffsetX(v: number) {
    if (typeof v !== 'number' || !isFinite(v)) return;
    this.#shadowOffsetX = v;
    this[ZIG].shadowOffsetX = v;
  }
  get shadowOffsetY(): number { return this.#shadowOffsetY; }
  set shadowOffsetY(v: number) {
    if (typeof v !== 'number' || !isFinite(v)) return;
    this.#shadowOffsetY = v;
    this[ZIG].shadowOffsetY = v;
  }
  get imageSmoothingEnabled(): boolean { return this.#imageSmoothingEnabled; }
  set imageSmoothingEnabled(v: boolean) {
    const b = !!v;
    this.#imageSmoothingEnabled = b;
    this[ZIG].imageSmoothingEnabled = b;
  }
  get imageSmoothingQuality(): string { return this.#imageSmoothingQuality; }
  set imageSmoothingQuality(v: string) {
    if (IMAGE_SMOOTHING_QUALITIES.has(v)) {
      this.#imageSmoothingQuality = v as 'low' | 'medium' | 'high';
      this[ZIG].imageSmoothingQuality = ({low:0, medium:1, high:2} as const)[this.#imageSmoothingQuality];
    }
  }

  fillText(text: string, x: number, y: number, _maxWidth?: number): void {
    if (typeof text !== 'string' || text.length === 0) return;
    const { adjX, adjY } = this.#applyTextOffsets(text, x, y);
    const ls = this.#letterSpacingPx;
    const ws = this.#wordSpacingPx;
    const kerning = this.#fontKerning !== 'none';
    if (ls === 0 && ws === 0 && !kerning) {
      this[ZIG].fillText(text, adjX, adjY, this.#getFontInstance());
    } else {
      this[ZIG].fillTextWithSpacing(text, adjX, adjY, this.#getFontInstance(), ls, ws, kerning);
    }
  }

  // strokeText — outlined glyphs require extracting glyph paths from the
  // font and feeding them through SmScan.strokePath. Not yet implemented;
  // v1 falls back to fillText so the API surface is callable. Tracked as a
  // follow-up; visual difference appears at large pt sizes.
  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.fillText(text, x, y, maxWidth);
  }

  measureText(text: string): TextMetrics {
    if (typeof text !== 'string' || text.length === 0) return new TextMetrics(0);
    const ls = this.#letterSpacingPx;
    const ws = this.#wordSpacingPx;
    const kerning = this.#fontKerning !== 'none';
    if (ls === 0 && ws === 0 && !kerning) {
      return new TextMetrics(this.#getFontInstance().measureWidth(text));
    }
    return new TextMetrics(this.#getFontInstance().measureWithSpacing(text, ls, ws, kerning));
  }

  /**
   * Apply textAlign + textBaseline to the user-supplied (x, y) so the
   * downstream Zig drawText sees a baseline-aligned, left-anchored pen.
   *
   * Per HTML5 spec, when direction='rtl': textAlign='start' aligns right
   * and textAlign='end' aligns left. 'left'/'right'/'center' are
   * direction-independent.
   */
  #applyTextOffsets(text: string, x: number, y: number): { adjX: number; adjY: number } {
    let adjX = x;
    let adjY = y;
    // Resolve direction-aware textAlign 'start'/'end' to absolute side.
    const isRtl = this.#direction === 'rtl';
    let resolved: 'left' | 'right' | 'center' = 'left';
    switch (this.#textAlign) {
      case 'left':   resolved = 'left'; break;
      case 'right':  resolved = 'right'; break;
      case 'center': resolved = 'center'; break;
      case 'start':  resolved = isRtl ? 'right' : 'left'; break;
      case 'end':    resolved = isRtl ? 'left'  : 'right'; break;
    }
    if (resolved !== 'left') {
      const ls = this.#letterSpacingPx;
      const ws = this.#wordSpacingPx;
      const kerning = this.#fontKerning !== 'none';
      const w = (ls === 0 && ws === 0 && !kerning)
        ? this.#getFontInstance().measureWidth(text)
        : this.#getFontInstance().measureWithSpacing(text, ls, ws, kerning);
      if (resolved === 'right') adjX -= w;
      else /* center */ adjX -= w / 2;
    }
    // Vertical baseline. SmCanvas.drawText takes y at the alphabetic
    // baseline, so 'alphabetic' is the no-op base.
    const m = this.#getFontInstance().getMetrics();
    switch (this.#textBaseline) {
      case 'alphabetic':
        break;
      case 'top':
      case 'hanging': // hanging is for Devanagari etc; approximate as 'top'.
        adjY += m.ascent;
        break;
      case 'middle':
        adjY += (m.ascent + m.descent) / 2;
        break;
      case 'bottom':
      case 'ideographic': // approximate as 'bottom'.
        adjY += m.descent;
        break;
    }
    return { adjX, adjY };
  }

  // ---- Image data -------------------------------------------------------
  createImageData(width: number, height: number, settings?: ImageDataSettings): ImageData;
  createImageData(imagedata: ImageData): ImageData;
  createImageData(
    arg1: number | ImageData,
    height?: number,
    settings?: ImageDataSettings,
  ): ImageData {
    if (typeof arg1 === 'number') {
      if (typeof height !== 'number') {
        throw new TypeError('createImageData: height required when first arg is a number');
      }
      return new ImageData(arg1, height, settings);
    }
    if (arg1 instanceof ImageData) {
      return new ImageData(arg1.width, arg1.height, {
        colorSpace: arg1.colorSpace as ImageDataSettings['colorSpace'],
        pixelFormat: arg1.pixelFormat as ImageDataSettings['pixelFormat'],
      });
    }
    throw new TypeError('createImageData: expected number or ImageData');
  }

  getImageData(
    sx: number, sy: number, sw: number, sh: number,
    settings?: ImageDataSettings,
  ): ImageData {
    const z = settings === undefined
      ? this[ZIG].getImageData(sx, sy, sw, sh)
      : this[ZIG].getImageDataSettings(sx, sy, sw, sh, settings as ZigBitmapSettings);
    return ImageData[FROM_ZIG](z);
  }

  putImageData(
    imageData: ImageData,
    dx: number, dy: number,
    dirtyX?: number, dirtyY?: number,
    dirtyW?: number, dirtyH?: number,
  ): void {
    if (dirtyX === undefined) {
      this[ZIG].writePixels(imageData[ZIG], dx, dy);
    } else {
      this[ZIG].writePixelsDirty(
        imageData[ZIG],
        dx, dy,
        dirtyX,
        dirtyY ?? 0,
        dirtyW ?? imageData.width,
        dirtyH ?? imageData.height,
      );
    }
  }

  // ---- drawImage --------------------------------------------------------
  drawImage(image: ImageData | Image | Canvas, dx: number, dy: number): void;
  drawImage(image: ImageData | Image | Canvas, dx: number, dy: number, dw: number, dh: number): void;
  drawImage(
    image: ImageData | Image | Canvas,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void;
  drawImage(
    image: ImageData | Image | Canvas,
    a: number, b: number,
    c?: number, d?: number,
    e?: number, f?: number,
    g?: number, h?: number,
  ): void {
    let bitmap: ZigBitmap;
    let snapshot = false;
    if (image instanceof Canvas) {
      // Snapshot the source canvas's surface contents.
      bitmap = image[ZIG].getCanvas().getImageData(0, 0, image.width, image.height);
      snapshot = true;
    } else if (image instanceof ImageData || image instanceof Image) {
      bitmap = image[ZIG];
    } else {
      throw new TypeError('drawImage: expected ImageData, Image, or Canvas');
    }

    if (c === undefined) {
      this[ZIG].drawImageAt(bitmap, a, b);
    } else if (e === undefined) {
      this[ZIG].drawImageScaled(bitmap, a, b, c, d!);
    } else {
      this[ZIG].drawImageScaledSub(bitmap, a, b, c, d!, e, f!, g!, h!);
    }

    if (snapshot) SmBitmap.release(bitmap);
  }

  // ---- Gradients --------------------------------------------------------
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    return new CanvasGradient(SmGradient.linear(x0, y0, x1, y1));
  }
  createRadialGradient(
    x0: number, y0: number, r0: number,
    x1: number, y1: number, r1: number,
  ): CanvasGradient {
    return new CanvasGradient(SmGradient.radial(x0, y0, r0, x1, y1, r1));
  }
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient {
    return new CanvasGradient(SmGradient.conic(startAngle, x, y));
  }

  // ---- Patterns ---------------------------------------------------------
  // image: ImageData / Image / another Canvas. HTMLImageElement / Blob / URL
  // require an HTTP-flavoured loader we don't ship — decode bytes via
  // Image.fromBytes first and pass the resulting Image here.
  // repetition: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat'. Empty
  // string and null both default to 'repeat' per HTML5 spec.
  createPattern(
    image: ImageData | Image | Canvas,
    repetition: string | null,
  ): CanvasPattern {
    const repKey = repetition === '' || repetition == null ? 'repeat' : repetition;
    const repEnum = REPETITION_TO_ENUM[repKey];
    if (repEnum === undefined) {
      throw new DOMException(
        `createPattern: invalid repetition '${repetition}'`,
        'SyntaxError',
      );
    }

    let bytes: Uint8Array;
    let width: number;
    let height: number;
    let snapshot: ZigBitmap | null = null;
    if (image instanceof Canvas) {
      // Snapshot via the same path drawImage uses; release the snapshot
      // immediately because SmPattern.create copies the bytes.
      snapshot = image[ZIG].getCanvas().getImageData(0, 0, image.width, image.height);
      bytes = snapshot.data;
      width = snapshot.width;
      height = snapshot.height;
    } else if (image instanceof ImageData || image instanceof Image) {
      bytes = image[ZIG].data;
      width = image[ZIG].width;
      height = image[ZIG].height;
    } else {
      throw new TypeError('createPattern: expected ImageData, Image, or Canvas');
    }

    // SmPattern.create copies the buffer; safe to release the snapshot now.
    const pattern = SmPattern.create(bytes, width, height, repEnum);
    if (snapshot) SmBitmap.release(snapshot);
    return new CanvasPattern(pattern);
  }
}

// =============================================================================
// HTML5: Canvas (HTMLCanvasElement-shaped)
// =============================================================================

export class Canvas {
  /** @internal */ [ZIG]: ZigSurface;
  #ctx: CanvasRenderingContext2D | null = null;
  #destroyed: boolean = false;

  constructor(width: number, height: number, opts?: CanvasOptions) {
    this[ZIG] = SmSurface.initDefault(width, height);
    surfaceRegistry.register(this, this[ZIG], this);
    if (opts?.fonts) {
      for (const f of opts.fonts) {
        registerFont(f.data, f.name, { weight: f.weight, style: f.style });
      }
    }
  }

  get width(): number { return this[ZIG].width; }
  set width(n: number) { this.#resize(n, this[ZIG].height); }

  get height(): number { return this[ZIG].height; }
  set height(n: number) { this.#resize(this[ZIG].width, n); }

  // HTML5 spec: assigning width or height — even to the same value —
  // reallocates the bitmap (transparent black) AND resets the rendering
  // context state. The cached ctx instance is preserved so user code that
  // captured it before the resize keeps working; the JS-side mirror
  // fields are re-synced via the existing `reset()` method.
  #resize(w: number, h: number): void {
    const sw = Number.isFinite(w) && w > 0 ? Math.floor(w) : 0;
    const sh = Number.isFinite(h) && h > 0 ? Math.floor(h) : 0;
    this[ZIG].resize(sw, sh);
    if (this.#ctx) this.#ctx.reset();
  }

  getContext(kind: '2d', _attrs?: object): CanvasRenderingContext2D {
    if (kind !== '2d') throw new Error('UnsupportedContext');
    if (!this.#ctx) {
      this.#ctx = new CanvasRenderingContext2D(this, this[ZIG].getCanvas());
    }
    return this.#ctx;
  }

  toDataURL(type?: string, quality?: number): string {
    const t = (type ?? 'image/png').toLowerCase();
    if (t === 'image/jpeg' || t === 'image/jpg') {
      const q = clampJpegQuality(quality);
      const bytes = this[ZIG].encodeJpeg(q);
      if (bytes.length === 0) return 'data:,';
      return 'data:image/jpeg;base64,' + bytesToBase64(bytes);
    }
    // PNG default — also covers unrecognized mime types per HTML5 fallback.
    const bytes = this[ZIG].encodePng();
    if (bytes.length === 0) return 'data:,';
    return 'data:image/png;base64,' + bytesToBase64(bytes);
  }

  /**
   * Encode the canvas and return the raw bytes. Skips the base64 round-trip
   * that `toDataURL()` does — pass directly to `new Response(...)`,
   * `fs.writeFile`, etc.
   *
   * `type` defaults to `'image/png'`; `'image/jpeg'` is also supported with
   * an optional `quality` in the HTML5 0.0–1.0 range (default 0.92).
   *
   * The returned `Uint8Array` is a JS-owned defensive copy; safe to retain
   * past further drawing.
   */
  toBytes(type?: string, quality?: number): Uint8Array {
    const t = (type ?? 'image/png').toLowerCase();
    if (t === 'image/jpeg' || t === 'image/jpg') {
      return zigBytesToU8(this[ZIG].encodeJpeg(clampJpegQuality(quality)));
    }
    return zigBytesToU8(this[ZIG].encodePng());
  }

  /**
   * Promise-returning sibling of `toBytes`. Mirrors `@napi-rs/canvas`'s
   * `encode(format)`: encodes off the JS thread on Node (real pthread
   * offload via zigar's WorkQueue — equivalent to N-API `AsyncWorker`).
   *
   * On WASM targets — browsers, Cloudflare Workers, edge runtimes — the
   * Zig WorkQueue is comptime-gated out and this falls through to a
   * microtask-yielded sync encode. CF Workers can't spawn worker threads
   * in any case, so the API shape stays uniform; only the offload behavior
   * differs by target.
   */
  async toBytesAsync(type?: string, quality?: number): Promise<Uint8Array> {
    const t = (type ?? 'image/png').toLowerCase();
    if (t === 'image/jpeg' || t === 'image/jpg') {
      if (typeof encodeJpegAsync === 'function') {
        return zigBytesToU8(await encodeJpegAsync(this[ZIG], clampJpegQuality(quality)));
      }
    } else if (typeof encodePngAsync === 'function') {
      return zigBytesToU8(await encodePngAsync(this[ZIG]));
    }
    await Promise.resolve();
    return this.toBytes(type, quality);
  }

  /**
   * Promise-returning sibling of `toDataURL`. Built on top of
   * `toBytesAsync`, so the same target-dependent offload story applies —
   * see that method's docstring.
   */
  async toDataURLAsync(type?: string, quality?: number): Promise<string> {
    const t = (type ?? 'image/png').toLowerCase();
    const bytes = await this.toBytesAsync(t, quality);
    if (bytes.length === 0) return 'data:,';
    const mime = (t === 'image/jpeg' || t === 'image/jpg') ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,` + Buffer.from(bytes).toString('base64');
  }

  /**
   * Eagerly release the underlying Zig surface (pixel buffer, cached
   * SmCanvas, last encoded payload). Idempotent. Calling any other method
   * after `destroy()` is undefined behavior — the wrapper's Zig handle is
   * dangling. Mirrors the pdf.js `BaseCanvasFactory#destroy` contract and
   * supports the Stage-3 `using` syntax (via `Symbol.dispose`).
   *
   * Without this, the same cleanup happens lazily through the
   * FinalizationRegistry when the wrapper is GC'd. Use `destroy()` to
   * release sooner — large canvases on long-lived servers, request-scoped
   * canvases under Cloudflare Workers' tight memory caps, etc.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    surfaceRegistry.unregister(this);
    if (this.#ctx) {
      this.#ctx.destroy();
      this.#ctx = null;
    }
    // SmSurface.deinit also tears down the cached SmCanvas.
    this[ZIG].deinit();
  }

  [Symbol.dispose](): void { this.destroy(); }
}

// HTML5 toDataURL/toBlob `quality` is a number in [0, 1]. stb expects 1..100.
// Non-finite, missing, or out-of-range falls back to 0.92 (matches Chromium).
function clampJpegQuality(q: number | undefined): number {
  const f = typeof q === 'number' && Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0.92;
  return Math.max(1, Math.min(100, Math.round(f * 100)));
}

// =============================================================================
// Public factory + utility re-exports
// =============================================================================

export function createCanvas(width: number, height: number, opts?: CanvasOptions): Canvas {
  return new Canvas(width, height, opts);
}

// MicroSharp — sharp-shaped fluent image-processing surface, the second
// binding on top of the same Zig core. Exposed as a named export from
// the package root (alongside `createCanvas`) so Node and WASM consumers
// reach it the same way: `import { microsharp } from 'simdra'`.
// TS-extension imports rely on `rewriteRelativeImportExtensions` in
// tsconfig.core.json — tsc emits `.js` in the build output; dev / test
// run the .ts files directly via Node's built-in TS support.
export { microsharp, MicroSharpPipeline } from './microsharp/index.ts';
export type {
  ImageFormat,
  ImageFormatName,
  ResizeOptions,
  ResizeKernel,
  ResizeFit,
  ResizePosition,
  ExtendOptions,
  ExtendWithMode,
  ExtractRegion,
  TrimOptions,
  CompositeImage,
  CompositeBlend,
  CompositeGravity,
  CompositeOverlayInput,
  CompositeRawDescriptor,
  CompositeCreateInput,
  ChannelSelector,
  BandBoolOp,
  PngOptions,
  JpegOptions,
  Metadata,
  MicroSharpInput,
  BackgroundInput,
  BackgroundColor,
  OutputInfo,
  ToBufferOptions,
} from './microsharp/index.ts';

export { parseCssColor };

/**
 * WASM source accepted by async `init()`.
 */
export type InitInput =
  | ArrayBuffer
  | ArrayBufferView
  | Response
  | WebAssembly.Module
  | Promise<ArrayBuffer | ArrayBufferView | Response | WebAssembly.Module>;

type WasmModule = { __initSync?: (mod: WebAssembly.Module) => void; __init?: (input?: InitInput) => Promise<void> };

/**
 * Synchronous init from a pre-compiled `WebAssembly.Module`. Designed for
 * Cloudflare Workers / Vercel Edge — call at module-init scope:
 *
 *     import { initSync, createCanvas } from 'simdra/wasm';
 *     import wasm from 'simdra/wasm/simdra.wasm';
 *     initSync(wasm);
 *
 * Workers forbids `WebAssembly.compile()` on raw bytes, but allows
 * `new WebAssembly.Instance(precompiledModule, imports)`. The runtime
 * compiles the imported `.wasm` at deploy time, so this stays sync.
 *
 * In dev (`npm test` via node-zigar) zigar loads the module itself, so this
 * is a no-op.
 */
export function initSync(mod: WebAssembly.Module): void {
  const fn = (zig as WasmModule).__initSync;
  if (fn) fn(mod);
}

/**
 * Async init for environments where `WebAssembly.compile()` is allowed
 * (Node, browsers). Accepts bytes / Response / a `Module`. Idempotent.
 */
export default async function init(input?: InitInput): Promise<void> {
  const fn = (zig as WasmModule).__init;
  if (fn) await fn(input);
}

