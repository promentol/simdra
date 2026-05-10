// Ambient types for the `../zig/simdra.zig` module exposed by node-zigar /
// rollup-plugin-zigar.
//
// **THESE ARE INTERNAL TYPES.** Consumers must never import or reference
// the `Sm*` classes directly — they are implementation details. The public
// API is the wrapper layer in `src/index.ts`, which exports HTML5-spec
// classes (`Canvas`, `CanvasRenderingContext2D`, `ImageData`, `DOMMatrix`,
// `Path2D`, `CanvasGradient`) that wrap these proxies and never leak the
// Zig surface to the outside world.
//
// Values declared here are JavaScript proxies into Zig memory: the shapes
// below describe the *runtime view* — array/object indexing works, but
// Array.prototype methods do not exist on `data` etc.
//
// Construction is Skia-style: each type carries its own static factory
// methods (`SmSurface.init`, `SmBitmap.createBlank`, `SmMatrix.identity`,
// `SmPath.empty`, `SmGradient.linear`, ...). simdra.zig has no `createXxx`
// free functions.

declare module '*.zig' {
  // Enum value strings as carried through the proxy. At runtime the field is
  // a proxy *object* whose .toString() returns one of these literals, so
  // strict equality with a string literal is false; consumers compare via
  // `String(value)`. The type here is the logical value.
  export type ColorSpaceValue = 'srgb' | 'display_p3';
  export type PixelFormatValue = 'rgba_unorm8' | 'rgba_float16';

  export interface BitmapSettings {
    colorSpace?: ColorSpaceValue;
    pixelFormat?: PixelFormatValue;
  }

  // SmBitmap — owning RGBA pixel buffer (Skia: SkBitmap). The HTML5 ImageData
  // class (in src/index.ts) is a constructor-dispatch wrapper that returns
  // these proxies.
  export interface SmBitmap {
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly colorSpace: ColorSpaceValue;
    readonly pixelFormat: PixelFormatValue;
    /** Encode as PNG (page_allocator). Caller (or the JS Image / Canvas
     *  wrapper) is responsible for the lifetime of the returned bytes. */
    encodePng(): ZigBytes;
    /** PNG with stb's per-call compression level (0..9, mutex-guarded
     *  around stb's process-global). */
    encodePngWithLevel(level: number): ZigBytes;
    /** Encode as JPEG with stb's 1–100 quality scale. */
    encodeJpeg(quality: number): ZigBytes;
    /** 32-bit BMP V4 with alpha mask (stb's `comp=4` path). */
    encodeBmp(): ZigBytes;
  }

  // String-capable proxy returned by Zig binary functions (e.g. encodePng).
  // Also exposes a `dataView` accessor (zigar adds it for buffer-shaped
  // returns) — much faster than byte-by-byte indexing for kilobyte-sized
  // payloads such as embedded font blobs.
  export interface ZigBytes {
    readonly length: number;
    readonly [i: number]: number;
    readonly dataView: DataView;
  }

  // SmFont — TrueType / OpenType typeface bound to a fixed pixel size.
  // Skia: `SkTypeface` + `SkFont`. Backed by stb_truetype. The HTML5 façade
  // (`ctx.font`, `ctx.fillText`, `ctx.measureText`) wraps these.
  export interface FontMetrics {
    readonly ascent: number;
    readonly descent: number;
    readonly lineGap: number;
    readonly sizePx: number;
  }
  export interface SmFont {
    readonly size_px: number;
    readonly scale: number;
    readonly synth_bold: boolean;
    readonly synth_italic: boolean;
    getMetrics(): FontMetrics;
    glyphIndexFor(codepoint: number): number;
    glyphAdvanceWidth(glyph: number): number;
    measureWidth(text: string): number;
    measureWithSpacing(
      text: string,
      letterSpacingPx: number,
      wordSpacingPx: number,
      kerningOn: boolean,
    ): number;
    kernAdvance(prevCp: number, cp: number): number;
    setSynth(bold: boolean, italic: boolean): void;
    release(): void;
  }

  // SmPaint — Skia: SkPaint. Passed by const-pointer to draw methods.
  export type PaintStyle = 'fill' | 'stroke' | 'fill_and_stroke';
  export interface SmPaint {
    color: number;
    readonly style: PaintStyle;
    stroke_width: number;
  }

  export type LineCapName = 'butt' | 'round' | 'square';
  export type LineJoinName = 'miter' | 'bevel' | 'round';
  export type FillRuleName = 'nonzero' | 'evenodd';

  export interface SmCanvas {
    fillStyle: number;
    strokeStyle: number;
    lineWidth: number;
    lineCap: LineCapName;
    lineJoin: LineJoinName;
    miterLimit: number;
    lineDashOffset: number;
    /** 0..255 alpha modulator. JS layer wraps as `globalAlpha` (0..1 float). */
    alpha: number;
    /** HTML5 imageSmoothingEnabled. Toggles bilinear vs nearest in drawImage. */
    imageSmoothingEnabled: boolean;
    /** Encoded quality hint: 0=low, 1=medium, 2=high (advisory). */
    imageSmoothingQuality: number;
    /** HTML5 shadowBlur in pixels (Gaussian blur radius). 0 disables. */
    shadowBlur: number;
    /** HTML5 shadowColor packed RGBA u32. Alpha=0 disables shadow. */
    shadowColor: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
    /** Replace the active filter chain. `verbs` and `params` are parallel
     * arrays produced by `parseCssFilter` in src/index.ts. */
    setFilterChain(verbs: Uint8Array, params: Float64Array): void;
    /** Default blend mode for new paints. JS layer wraps as `globalCompositeOperation`. */
    blendMode:
      | 'src_over' | 'src_in' | 'src_out' | 'src_atop'
      | 'dst_over' | 'dst_in' | 'dst_out' | 'dst_atop'
      | 'src' | 'copy' | 'xor' | 'add'
      | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
      | 'color_dodge' | 'color_burn' | 'hard_light' | 'soft_light'
      | 'difference' | 'exclusion'
      | 'hue' | 'saturation' | 'color' | 'luminosity';
    setFillStyle(r: number, g: number, b: number, a: number): void;
    setStrokeStyle(r: number, g: number, b: number, a: number): void;
    setFillGradient(g: SmGradient): void;
    setStrokeGradient(g: SmGradient): void;
    setFillPattern(p: SmPattern): void;
    setStrokePattern(p: SmPattern): void;
    setLineWidth(w: number): void;
    setLineCap(c: LineCapName): void;
    setLineJoin(j: LineJoinName): void;
    setMiterLimit(m: number): void;
    setLineDash(segments: ArrayBufferView): void;
    getLineDash(): { readonly length: number; readonly [i: number]: number };
    setLineDashOffset(o: number): void;

    // Transform stack — HTML5 CTM. `rotate` takes radians per HTML5 spec.
    translate(tx: number, ty: number): void;
    rotate(angleRadians: number): void;
    scale(sx: number, sy: number): void;
    transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
    resetTransform(): void;
    getTransform(): SmMatrix;
    save(): void;
    restore(): void;
    reset(): void;

    // Skia-style primary drawing methods — take a SmPaint.
    drawRect(x: number, y: number, w: number, h: number, paint: SmPaint): void;
    drawTriangle(
      x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
      paint: SmPaint,
    ): void;

    // HTML5-shaped sugar — bundle ctx state into a SmPaint internally.
    fillRect(x: number, y: number, w: number, h: number): void;
    strokeRect(x: number, y: number, w: number, h: number): void;
    clearRect(x: number, y: number, w: number, h: number): void;
    fillTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void;
    strokeTriangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void;

    beginPath(): void;
    closePath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
    rect(x: number, y: number, w: number, h: number): void;
    arc(
      cx: number, cy: number, r: number,
      startAngle: number, endAngle: number, ccw: boolean,
    ): void;
    arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
    roundRect(
      x: number, y: number, w: number, h: number,
      rTl: number, rTr: number, rBr: number, rBl: number,
    ): void;
    ellipse(
      cx: number, cy: number, rx: number, ry: number, rotation: number,
      startAngle: number, endAngle: number, ccw: boolean,
    ): void;
    /** Rasterize the current path with the given fill rule. */
    fill(fillRule: FillRuleName): void;
    /** Rasterize an external SmPath with the given fill rule. */
    fillPathExternal(path: SmPath, fillRule: FillRuleName): void;
    /** Outline the current path at lineWidth + cap/join/dash state. */
    stroke(): void;
    /** Outline an external SmPath at the current stroke state. */
    strokePathExternal(path: SmPath): void;
    /** Intersect the current clip region with the current path. */
    clip(fillRule: FillRuleName): void;
    /** Intersect the current clip region with an external SmPath. */
    clipPath(path: SmPath, fillRule: FillRuleName): void;

    /** HTML5 isPointInPath against the current path. */
    isPointInPath(x: number, y: number, fillRule: FillRuleName): boolean;
    /** HTML5 isPointInPath against an external Path2D. */
    isPointInPathExternal(path: SmPath, x: number, y: number, fillRule: FillRuleName): boolean;
    /** HTML5 isPointInStroke against the current path. */
    isPointInStroke(x: number, y: number): boolean;
    /** HTML5 isPointInStroke against an external Path2D. */
    isPointInStrokeExternal(path: SmPath, x: number, y: number): boolean;

    // Text — Sm-prefixed primitive with a HTML5 façade in src/index.ts.
    // `fillText` bundles the current ctx state into a SmPaint internally.
    fillText(text: string, x: number, y: number, font: SmFont): void;
    fillTextWithSpacing(
      text: string,
      x: number,
      y: number,
      font: SmFont,
      letterSpacingPx: number,
      wordSpacingPx: number,
      kerningOn: boolean,
    ): void;

    getImageData(sx: number, sy: number, sw: number, sh: number): SmBitmap;
    getImageDataSettings(
      sx: number, sy: number, sw: number, sh: number, settings: BitmapSettings,
    ): SmBitmap;
    releaseImageData(bitmap: SmBitmap): void;

    // Skia-style writePixels (bypasses CTM / globalAlpha / blend).
    writePixels(bitmap: SmBitmap, dx: number, dy: number): void;
    writePixelsDirty(
      bitmap: SmBitmap,
      dx: number, dy: number,
      dirtyX: number, dirtyY: number,
      dirtyW: number, dirtyH: number,
    ): void;

    // drawImage (3 / 5 / 9-arg HTML5 overloads). Respects CTM. Step 1 uses
    // nearest-neighbor sampling; bilinear is a follow-up sampler kernel.
    drawImageAt(bitmap: SmBitmap, dx: number, dy: number): void;
    drawImageScaled(bitmap: SmBitmap, dx: number, dy: number, dw: number, dh: number): void;
    drawImageScaledSub(
      bitmap: SmBitmap,
      sx: number, sy: number, sw: number, sh: number,
      dx: number, dy: number, dw: number, dh: number,
    ): void;

    // Patched JS-side in src/index.ts — HTML5 ctx.createImageData overloads,
    // ctx.createLinearGradient / ctx.createRadialGradient, and the
    // ctx.putImageData overload set (3-arg + 7-arg).
    createImageData(width: number, height: number, settings?: BitmapSettings): SmBitmap;
    createImageData(imagedata: SmBitmap): SmBitmap;
    createLinearGradient(x0: number, y0: number, x1: number, y1: number): SmGradient;
    createRadialGradient(
      x0: number, y0: number, r0: number, x1: number, y1: number, r1: number,
    ): SmGradient;
    putImageData(bitmap: SmBitmap, dx: number, dy: number): void;
    putImageData(
      bitmap: SmBitmap,
      dx: number, dy: number,
      dirtyX: number, dirtyY: number,
      dirtyW: number, dirtyH: number,
    ): void;
    drawImage(bitmap: SmBitmap, dx: number, dy: number): void;
    drawImage(bitmap: SmBitmap, dx: number, dy: number, dw: number, dh: number): void;
    drawImage(
      bitmap: SmBitmap,
      sx: number, sy: number, sw: number, sh: number,
      dx: number, dy: number, dw: number, dh: number,
    ): void;
  }

  export interface SmSurface {
    readonly width: number;
    readonly height: number;
    getCanvas(): SmCanvas;
    encodePng(): ZigBytes;
    encodeJpeg(quality: number): ZigBytes;
    resize(width: number, height: number): void;
    deinit(): void;
  }

  // SmPath — Skia-style single class. SmCanvas holds a `path: SmPath` field
  // for its current-path state; standalone Paths come from `SmPath.empty()`
  // / `existingPath.copy()`. The HTML5 Path2D class lives JS-side.
  export interface SmPath {
    closePath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
    rect(x: number, y: number, w: number, h: number): void;
    arc(
      cx: number, cy: number, r: number,
      startAngle: number, endAngle: number, ccw: boolean,
    ): void;
    arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
    roundRect(
      x: number, y: number, w: number, h: number,
      rTl: number, rTr: number, rBr: number, rBl: number,
    ): void;
    ellipse(
      cx: number, cy: number, rx: number, ry: number, rotation: number,
      startAngle: number, endAngle: number, ccw: boolean,
    ): void;
    addPath(other: SmPath): void;
    addPathTransform(other: SmPath, m: SmMatrix): void;
    copy(): SmPath;
    deinit(): void;
  }

  // SmMatrix — 2D affine transform (Skia: SkMatrix). Methods chain by
  // returning the same SmMatrix proxy.
  export interface SmMatrix {
    a: number; b: number; c: number; d: number; e: number; f: number;
    multiplySelf(other: SmMatrix): SmMatrix;
    preMultiplySelf(other: SmMatrix): SmMatrix;
    translateSelf(tx: number, ty: number): SmMatrix;
    scaleSelf(sx: number, sy: number): SmMatrix;
    rotateSelf(angleDegrees: number): SmMatrix;
    skewXSelf(angleDegrees: number): SmMatrix;
    skewYSelf(angleDegrees: number): SmMatrix;
    invertSelf(): SmMatrix;
  }

  // SmGradient — Skia: SkGradientShader. Construction via SmGradient.linear /
  // SmGradient.radial static factories.
  export interface SmGradient {
    readonly kind: 'linear' | 'radial';
    x0: number; y0: number; r0: number;
    x1: number; y1: number; r1: number;
    addColorStop(offset: number, color: string): void;
    deinit(): void;
  }

  // Repetition mode for SmPattern. Enum integer matches the Zig Repetition.
  export type SmPatternRepetition = 0 | 1 | 2 | 3;

  // SmPattern — image tile shader. Backs HTML5 CanvasPattern. Owns its RGBA
  // bytes (snapshot at construction). Construction via SmPattern.create
  // static factory.
  export interface SmPattern {
    readonly width: number;
    readonly height: number;
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
    deinit(): void;
  }

  // Constructor proxies for the exported Zig types. The static factories
  // listed below the class const are the Skia-style construction surface.
  export const SmSurface: {
    prototype: SmSurface;
    /** JS-binding factory using `page_allocator`. */
    initDefault(width: number, height: number): SmSurface;
  };
  export const SmCanvas: { prototype: SmCanvas };
  // Header-only metadata read — wraps stbi_info_from_memory +
  // stbi_is_16_bit_from_memory. No allocation, no pixel decode.
  // `channels` is the **source** count (1=grey, 2=grey+alpha, 3=rgb, 4=rgba),
  // not our forced-RGBA decode output.
  export interface ImageInfo {
    readonly width: number;
    readonly height: number;
    readonly channels: number;
    readonly bits_per_sample: number;
  }

  /** Sharp-shaped resampling kernel. node-zigar marshals as a string
   *  proxy at runtime — pass kernel-name strings and use String(value)
   *  to compare. */
  export type ResampleKernelName =
    | 'nearest' | 'linear'
    | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3' | 'mks2013' | 'mks2021';

  export type ExtendModeName = 'background' | 'copy' | 'repeat' | 'mirror';
  export type CropStrategyName = 'entropy' | 'attention';

  export interface BitmapRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  }

  // Extend SmBitmap with the bitmap-direct ops backing microsharp's
  // resize / extract / extend / trim.
  export interface SmBitmap {
    /** Resample to (target_w, target_h) using the chosen kernel. */
    resample(targetW: number, targetH: number, kernel: ResampleKernelName): SmBitmap;
    /** Copy a sub-rectangle into a freshly-allocated bitmap. */
    extract(left: number, top: number, width: number, height: number): SmBitmap;
    /** Pad with the chosen edge-fill mode. `bg_*` consulted only when
     *  `mode === 'background'`. */
    extend(
      top: number, right: number, bottom: number, left: number,
      mode: ExtendModeName,
      bgR: number, bgG: number, bgB: number, bgA: number,
    ): SmBitmap;
    /** Bounding box of pixels that differ from `bg` by more than
     *  `threshold` on any channel. Throws `NoContent` if every pixel
     *  matches bg within threshold. */
    findOpaqueBounds(
      bgR: number, bgG: number, bgB: number, bgA: number,
      threshold: number,
    ): BitmapRect;
    /** Pick a `target_w × target_h` window with the highest content
     *  score per the chosen strategy. */
    contentBounds(
      targetW: number, targetH: number,
      strategy: CropStrategyName,
    ): BitmapRect;
    /** Composite `overlay` onto a copy of this bitmap with the given
     *  blend mode and pixel offset; tile the overlay across the base
     *  when `tile=true`. Returns a fresh bitmap. */
    composite(
      overlay: SmBitmap,
      mode: BlendModeName,
      dx: number, dy: number,
      tile: boolean,
    ): SmBitmap;
    /** Channel ops: each returns a fresh bitmap. */
    removeAlpha(): SmBitmap;
    setAlphaConstant(alpha: number): SmBitmap;
    extractChannel(channel: number): SmBitmap;
    bandbool(op: BoolOpName): SmBitmap;
    /** Rec.601 luma: R=G=B=L; α preserved. Backs sharp's `greyscale()`. */
    greyscale(): SmBitmap;
    /** Recolour by `out_C = L · tint_C / 255`; α preserved. Backs sharp's `tint()`. */
    tint(r: number, g: number, b: number): SmBitmap;
    /** Replace this bitmap's alpha with Rec.601 luma of `mask.RGB`.
     *  `mask` must have the same dimensions; throws otherwise. */
    joinAlphaFromMask(mask: SmBitmap): SmBitmap;
    /** Geometric ops (Phase 1). 90°/180°/270° rotate + flip/flop are
     *  lossless index permutations; rotateArbitrary / affine sample
     *  through a bilinear or nearest-neighbor row kernel and pad the
     *  bbox gap with the bg colour. */
    rotate90(): SmBitmap;
    rotate180(): SmBitmap;
    rotate270(): SmBitmap;
    flipH(): SmBitmap;
    flipV(): SmBitmap;
    rotateArbitrary(
      angleDeg: number,
      bgR: number, bgG: number, bgB: number, bgA: number,
      interp: InterpolatorName,
    ): SmBitmap;
    affine(
      m00: number, m01: number, m10: number, m11: number,
      idx: number, idy: number, odx: number, ody: number,
      bgR: number, bgG: number, bgB: number, bgA: number,
      interp: InterpolatorName,
    ): SmBitmap;
    /** Convolution / morphology / median (Phase 2). */
    blurBox3(): SmBitmap;
    blurGaussian(sigma: number, precision: BlurPrecisionName, minAmplitude: number): SmBitmap;
    convolve(
      kw: number, kh: number,
      kernel: ArrayBufferView | readonly number[],
      scale: number, offset: number,
    ): SmBitmap;
    sharpenFast(): SmBitmap;
    sharpenUSM(
      sigma: number, m1: number, m2: number,
      x1: number, y2: number, y3: number,
    ): SmBitmap;
    dilate(width: number): SmBitmap;
    erode(width: number): SmBitmap;
    median(size: number): SmBitmap;
    /** Tone / boolean (Phase 3). */
    gamma(gIn: number, gOut: number): SmBitmap;
    negate(alpha: boolean): SmBitmap;
    linear(a: ArrayBufferView | readonly number[], b: ArrayBufferView | readonly number[]): SmBitmap;
    threshold(t: number, greyscale: boolean): SmBitmap;
    recomb(matrix: ArrayBufferView | readonly number[]): SmBitmap;
    flatten(bgR: number, bgG: number, bgB: number): SmBitmap;
    unflatten(): SmBitmap;
    booleanWith(operand: SmBitmap, op: BoolOpName): SmBitmap;
    /** Histogram / HSV (Phase 4). */
    normalise(lowerPct: number, upperPct: number): SmBitmap;
    clahe(tileW: number, tileH: number, maxSlope: number): SmBitmap;
    modulate(brightness: number, saturation: number, hueDeg: number, lightness: number): SmBitmap;
  }

  /** Sampling kernel for SmBitmap.rotateArbitrary / affine. */
  export type InterpolatorName = 'nearest' | 'bilinear';

  /** Precision setting for blurGaussian — sharp's `precision` option. */
  export type BlurPrecisionName = 'integer' | 'float' | 'approximate';

  /** Sharp's bitwise band-boolean op names (libvips's `eor` = XOR). */
  export type BoolOpName = 'and' | 'or' | 'eor';

  /** Sharp-shaped composite blend mode names. node-zigar marshals as
   *  string proxies; the simdra side maps these directly to the 27
   *  blend kernels in `core/SmPaint.zig::BlendMode`. */
  export type BlendModeName =
    | 'src_over' | 'src_in' | 'src_out' | 'src_atop'
    | 'dst_over' | 'dst_in' | 'dst_out' | 'dst_atop'
    | 'src' | 'copy' | 'xor' | 'add'
    | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
    | 'color_dodge' | 'color_burn' | 'hard_light' | 'soft_light'
    | 'difference' | 'exclusion'
    | 'hue' | 'saturation' | 'color' | 'luminosity';

  export const SmBitmap: {
    prototype: SmBitmap;
    createBlank(width: number, height: number, settings: BitmapSettings): SmBitmap;
    createFromBuffer(
      data: ArrayBufferView,
      width: number,
      height: number | null,
      settings: BitmapSettings,
    ): SmBitmap;
    /** Decode PNG / JPEG / BMP / GIF (first frame) bytes into a fresh
     *  RGBA8 SmBitmap allocated from page_allocator. */
    decode(bytes: ArrayBufferView): SmBitmap;
    /** Header-only metadata. No pixel decode, no allocation. */
    peekInfo(bytes: ArrayBufferView): ImageInfo;
    /** Read the EXIF Orientation tag from JPEG APP1 / PNG eXIf
     *  (returns 1..8). Returns 1 on any malformed / missing input.
     *  No allocation. */
    peekOrientation(bytes: ArrayBufferView): number;
    /** Free the page-allocator backing buffer. Called by the JS finalizer. */
    release(bitmap: SmBitmap): void;
  };
  export const SmMatrix: {
    prototype: SmMatrix;
    identity(): SmMatrix;
    components(a: number, b: number, c: number, d: number, e: number, f: number): SmMatrix;
  };
  export const SmPath: {
    prototype: SmPath;
    empty(): SmPath;
  };
  export const SmGradient: {
    prototype: SmGradient;
    linear(x0: number, y0: number, x1: number, y1: number): SmGradient;
    radial(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): SmGradient;
    conic(startAngle: number, x: number, y: number): SmGradient;
  };
  export const SmPattern: {
    prototype: SmPattern;
    create(
      rgba: ArrayBufferView,
      width: number,
      height: number,
      repetition: SmPatternRepetition,
    ): SmPattern;
  };
  export const SmPaint: {
    prototype: SmPaint;
    fill(color: number): SmPaint;
    stroke(color: number, width: number): SmPaint;
  };
  export const SmFont: {
    prototype: SmFont;
    fromBytes(ttfBytes: ArrayBufferView, sizePx: number): SmFont;
  };

  /** Read-only slice into the embedded default TTF (Inter Regular v4). */
  export function defaultFontBytes(): ZigBytes;
  export const ColorSpace: object;
  export const PixelFormat: object;
  export const BitmapSettings: object;

  export function parseCssColor(s: string): number | null;

  /**
   * Encode `surface` as PNG off the JS thread via zigar's WorkQueue (real
   * pthread offload — equivalent to N-API `AsyncWorker`). Comptime-gated to
   * non-WASM targets in `zig/simdra.zig`; on the WASM build this binding
   * resolves to `void` (`typeof === 'undefined'`), so feature-detect with
   * `typeof encodePngAsync === 'function'` before calling.
   */
  export const encodePngAsync: undefined | ((surface: SmSurface) => Promise<ZigBytes>);

  /** JPEG sibling of `encodePngAsync`. Same gating rules. */
  export const encodeJpegAsync: undefined | ((surface: SmSurface, quality: number) => Promise<ZigBytes>);

  /**
   * Injected by the `simdra-inject-init` plugin in `vite.config.js` for the
   * `dist/wasm/index.mjs` build. Synchronous instantiation from a
   * pre-compiled `WebAssembly.Module` — Workers-safe at module-init scope.
   * Absent in dev (node-zigar) and in the `dist/core` build.
   */
  export function __initSync(mod: WebAssembly.Module): void;

  /**
   * Async sibling of `__initSync` — accepts bytes / Response. Calls
   * `WebAssembly.compile`, which is forbidden on Workers but fine in Node /
   * browsers. Re-exported as the default `init` in `src/index.ts`.
   */
  export function __init(
    input?:
      | ArrayBuffer
      | ArrayBufferView
      | Response
      | WebAssembly.Module
      | Promise<ArrayBuffer | ArrayBufferView | Response | WebAssembly.Module>,
  ): Promise<void>;
}
