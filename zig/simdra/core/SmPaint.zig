//! SmPaint — drawing parameters bundled into one value. Mirrors Skia's
//! `SkPaint`. SmCanvas's `draw*` methods take a `*const SmPaint` rather
//! than reading canvas state; the HTML5-named sugar (`fillRect`,
//! `strokeRect`, …) bundles the current ctx state (`fillStyle` /
//! `strokeStyle` / `lineWidth`) into a SmPaint and calls the draw method.
//!
//! Pure value type — no allocator needed.

const SmGradient = @import("../effects/SmGradient.zig");
const SmPattern = @import("../effects/SmPattern.zig");

const SmPaint = @This();

/// Source for paint output. The blitter dispatches per-arm:
///   • `.solid`     → SIMD blend kernels (fast path).
///   • `.gradient`  → per-pixel `SmGradient.sampleLinear` / `sampleRadial`
///                    then through the same blend kernels.
///   • `.pattern`   → per-pixel `SmPattern.sample` then blend.
pub const Shader = union(enum) {
    solid: u32,
    gradient: *const SmGradient,
    pattern: *const SmPattern,
};

pub const Style = enum(u8) {
    fill = 0,
    stroke = 1,
    fill_and_stroke = 2,
};

/// Stroke endpoint shape for `lineCap` (HTML5 + Skia parity).
///   .butt   — perpendicular cut at the endpoint (default).
///   .round  — half-circle cap.
///   .square — perpendicular cut extended one half-width along the segment.
pub const LineCap = enum(u8) {
    butt = 0,
    round = 1,
    square = 2,
};

/// Stroke vertex join shape for `lineJoin`.
///   .miter — sharp intersection of outer offsets (bevel fallback when the
///            ratio exceeds `miter_limit`).
///   .bevel — straight chamfer between outer corners.
///   .round — circular fan between outer corners.
pub const LineJoin = enum(u8) {
    miter = 0,
    bevel = 1,
    round = 2,
};

/// Blend mode — operator that combines a source pixel with a destination
/// pixel. Covers the full HTML5 `globalCompositeOperation` set defined by
/// W3C Compositing and Blending Level 1, plus an internal `.src` mode used
/// by `clearRect` to write raw bytes without honoring composite mode.
///
/// JS-side mapping lives in `src/index.ts` (`HTML5_TO_BLEND` /
/// `BLEND_TO_HTML5`). Three families:
///
///   • Porter-Duff compositing (Fa, Fb pair) — `src_over`, `src_in`,
///     `src_out`, `src_atop`, `dst_over`, `dst_in`, `dst_out`, `dst_atop`,
///     `xor`, `add` ('lighter'), `copy`. `src` is internal — callers go
///     through `copy` for HTML5 semantics; clearRect uses `src` directly.
///   • Separable blend (per-channel B function): `multiply`, `screen`,
///     `overlay`, `darken`, `lighten`, `color_dodge`, `color_burn`,
///     `hard_light`, `soft_light`, `difference`, `exclusion`.
///   • Non-separable blend (HSL-shape color manipulation): `hue`,
///     `saturation`, `color`, `luminosity`.
pub const BlendMode = enum(u8) {
    // Porter-Duff
    src_over = 0,
    src_in = 1,
    src_out = 2,
    src_atop = 3,
    dst_over = 4,
    dst_in = 5,
    dst_out = 6,
    dst_atop = 7,
    src = 8, // internal — overwrite without blending; used by clearRect
    copy = 9, // HTML5 'copy' — same as src + canvas-wide pre-clear (handled in SmCanvas)
    xor = 10,
    add = 11, // HTML5 'lighter'

    // Separable blend
    multiply = 12,
    screen = 13,
    overlay = 14,
    darken = 15,
    lighten = 16,
    color_dodge = 17,
    color_burn = 18,
    hard_light = 19,
    soft_light = 20,
    difference = 21,
    exclusion = 22,

    // Non-separable blend
    hue = 23,
    saturation = 24,
    color = 25,
    luminosity = 26,

    /// Modes whose pixel formula yields a non-`dst` result OUTSIDE the
    /// source region (i.e. when the source has zero alpha). For these the
    /// blitter's row-by-row pass through the affected bbox is insufficient
    /// — the spec's "the shape is drawn as a separate layer, then that
    /// layer is composited with the canvas" model REQUIRES seeing the full
    /// canvas. Routed via `SmCanvas.beginCompositeLayer` /
    /// `endCompositeLayer`: render onto a transparent scratch with
    /// src_over, then composite scratch → canvas across every pixel.
    ///
    /// Derivation: for a Porter-Duff operator with αs=0 (outside source),
    /// αo = αb·Fb(0,αb). When Fb(0,αb)=0 (i.e. src_in, src_out, dst_in,
    /// dst_atop, copy), αo = 0 — pixels outside must be cleared. Other
    /// modes with Fb(0,αb)>0 produce dst unchanged outside, so a row-wise
    /// blit is fine. Source-over isn't here because Fb(0,αb)=1 → αo=αb.
    pub fn requiresLayerComposite(self: BlendMode) bool {
        return switch (self) {
            .src_in, .src_out, .dst_in, .dst_atop, .copy => true,
            else => false,
        };
    }
};

shader: Shader = .{ .solid = 0xFF000000 },
style: Style = .fill,
/// Stroke width in canvas pixels (HTML5 `lineWidth`, MDN
/// `unrestricted double`). f64 to match WebIDL semantics.
stroke_width: f64 = 1,
/// HTML5 `lineCap`. Applied at endpoints of OPEN polylines only.
line_cap: LineCap = .butt,
/// HTML5 `lineJoin`. Applied at interior polyline vertices and at the
/// closing seam of CLOSED subpaths.
line_join: LineJoin = .miter,
/// HTML5 `miterLimit`. Joins exceeding this ratio fall back to bevel.
miter_limit: f64 = 10.0,
blend_mode: BlendMode = .src_over,
/// Per-paint alpha modulator (0..255). Solid paints fold this into their
/// `Shader.solid` color at construction time (`SmCanvas.applyAlphaModulation`).
/// Gradient paints carry it through to `SmBlitter.dispatchGradient`, which
/// applies it per pixel after the sampler — so changing `globalAlpha`
/// between draw calls doesn't require resampling stops.
global_alpha: u8 = 0xFF,

// ---------------------------------------------------------------------------
// Static factories — Skia-style.
// ---------------------------------------------------------------------------

/// Solid-color fill paint.
pub fn fill(color: u32) SmPaint {
    return .{ .shader = .{ .solid = color }, .style = .fill };
}

/// Solid-color stroke paint.
pub fn stroke(color: u32, width: f64) SmPaint {
    return .{ .shader = .{ .solid = color }, .style = .stroke, .stroke_width = width };
}

// ---------------------------------------------------------------------------
// Style predicates — used by Canvas drawing dispatch.
// ---------------------------------------------------------------------------

pub inline fn includesFill(self: Style) bool {
    return self == .fill or self == .fill_and_stroke;
}

pub inline fn includesStroke(self: Style) bool {
    return self == .stroke or self == .fill_and_stroke;
}
