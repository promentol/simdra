# CanvasGradient

MDN: https://developer.mozilla.org/en-US/docs/Web/API/CanvasGradient

Returned by `createLinearGradient` / `createRadialGradient` / `createConicGradient`. A list of color stops + a geometry, sampled per pixel during fill/stroke.

Lives in `zig/simdra/effects/SmGradient.zig` (Skia: `SkGradientShader`). Construction is via Skia-style static factories `SmGradient.linear(x0,y0,x1,y1)` / `SmGradient.radial(x0,y0,r0,x1,y1,r1)`; the HTML5 `CanvasRenderingContext2D.createLinearGradient` / `createRadialGradient` methods (in `src/index.ts`) wrap those into a `CanvasGradient` JS class.

Priority is set by pdf.js. PDF axial and radial shading patterns lower to canvas linear/radial gradients, so the type and `addColorStop` are on the critical path. Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Instance methods

- [x] 🔴 `addColorStop(offset: f64, color: string)` — `zig/simdra/effects/SmGradient.zig`. `offset` ∈ [0,1] (throws IndexSizeError otherwise); `color` parsed via `parseCssColor` (throws SyntaxError on parse failure). Equal-offset stops keep insertion order.

## Internal shape (as implemented)

```zig
const Kind = enum(u8) { linear, radial };
const Stop = struct { offset: f64, rgba: u32 };

kind: Kind,
x0, y0, x1, y1, r0, r1: f64,           // flat fields; r0/r1 ignored for linear
stops: { ptr: [*]Stop, len: usize, cap: usize }, // hand-rolled; std.ArrayListUnmanaged blew zigar's quota
```

Geometry is flat fields rather than a tagged union so node-zigar's type scanner has no nested namespaces to walk. `kind` discriminates: linear uses `(x0, y0, x1, y1)`; radial uses all six.

## Per-pixel sampling

Implemented in `zig/simdra/effects/SmGradient.zig`. Premultiplied-alpha 8-bit lerp via the private `colorAt(t)` helper — translucent stops don't bleed RGB across an alpha edge.

- [x] 🔴 `sampleLinear(x, y) u32` — projects `(x, y)` onto the gradient line, clamps `t` to `[0, 1]` (HTML5 pad mode), interpolates between adjacent stops. Degenerate (zero-length) gradient returns the first stop's color. — `zig/simdra/effects/SmGradient.zig`.
- [x] 🔴 `sampleRadial(x, y) u32` — solves the two-circle quadratic at `(x, y)`, picks the larger root that yields a non-negative interpolated radius (Skia rule). Concentric / focal-on-edge cases collapse to linear in `t`. Returns transparent when no valid root exists. — `zig/simdra/effects/SmGradient.zig`.
- [ ] 🟡 `sampleConic(x, y) u32` — pdf.js doesn't use conic gradients; deferred.

## Dependencies

- 🔴 ✅ CSS color string parser (`zig/simdra/utils/css_color.zig`, shared with `fillStyle`/`strokeStyle`).
- 🔴 ✅ Per-pixel sampler dispatch in `zig/simdra/core/SmBlitter.zig` (`dispatchShader`) — `.gradient` and `.pattern` shaders bypass the SIMD fast path and sample per pixel; reuses `dispatchSolid` for the 27-mode blend switch.
- 🔴 ✅ `SmPaint.Shader` widened to `solid | gradient | pattern` (`zig/simdra/core/SmPaint.zig`); `SmCanvas.fillStyle` / `strokeStyle` carry the union directly.
- 🔴 ✅ `CanvasRenderingContext2D.createLinearGradient` / `createRadialGradient` instance methods — `src/index.ts`.

## Memory ownership

Per project no-GC policy: callers MUST call `gradient.deinit()` before the JS proxy is GC'd, otherwise the heap-allocated stop list leaks. Same model as `Path2D`.
