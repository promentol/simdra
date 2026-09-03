//! Vector blend kernels — portable `@Vector` code that `neon.zig` exports
//! on aarch64 (and any backend may adopt). `generic.zig` stays the scalar
//! reference; `tolerance_test.zig` holds every kernel here to within ±1
//! LSB per channel of it, over random rows that include translucent and
//! zero-alpha destinations.
//!
//! Lane plan: 8 pixels per chunk. A `@Vector(8, u32)` of packed RGBA is
//! bit-cast to `@Vector(32, u8)` and widened to `@Vector(32, u16)`, one
//! lane per channel, R G B A per pixel, so the arithmetic is the scalar
//! kernel's u32 arithmetic on 32 lanes at once. Per-pixel scalars (alpha,
//! coverage) are broadcast to their four channel lanes with a shuffle.
//! On a Cortex-A53 LLVM splits each 32-lane op into 64-bit halves; the
//! chunk width trades loop overhead for register pressure and was chosen
//! by the A53 cost model in handyflash's M17, not by taste.
//!
//! The arithmetic idioms, each the scalar kernel's own so the two agree:
//!
//!   mul255v(x, y)  = (t + (t >> 8)) >> 8,  t = x*y + 0x80   exact, max 65407 fits u16
//!   d255v(t)       = (t + 1 + (t >> 8)) >> 8                == t/255 for t <= 65279 in u16
//!                    (the identity holds to 65534, the lanes to 65279;
//!                    every product here is <= 255*255 = 65025)
//!   unpremulv(x, a)= (x * inv255[a] + 0x8000) >> 16         ±1 LSB of (x*255 + a/2)/a
//!
//! The un-premultiply is the one place the scalar kernels divide by a
//! variable (the output alpha of a translucent destination). A 256-entry
//! reciprocal table turns it into a multiply-shift in u32 lanes; opaque
//! destinations — the whole Flash stage — never reach it: the output
//! alpha is 255 there and the premultiplied sum IS the straight colour,
//! which is exactly what the scalar kernels do too.
//!
//! What is here (each with generic.zig's scalar function as its tail):
//!
//!   blendSrcOverU32 / blendSrcOverCovU32 / blendSrcOverRowU32
//!   the separable family through `sepCore` — multiply, screen, darken,
//!     lighten, difference, exclusion, hard_light, overlay — as the solid,
//!     coverage (`Cov`) and per-pixel-source (`Row`) kernels
//!   blendFlashSubtract{U32,CovU32,RowU32}, blendAdd{CovU32,RowU32}
//!
//! The `Row` kernels take the per-pixel mask generic.zig's `rowOfSrc`
//! defines (0 = skip, 255 = blend, between = lerp); the lerp is exact
//! (`(a*(255-t) + b*t + 127)/255`, max 65152, inside the d255v bound),
//! so masked-out pixels keep their bytes. Colour dodge/burn, soft light
//! and the non-separable HSL modes divide per channel or run in floats
//! and stay scalar; none of them is reachable from SWF blend modes.

const std = @import("std");
const generic = @import("generic.zig");

pub const Px = 8;
const V8 = @Vector(Px, u16);
const V32 = @Vector(Px * 4, u16);
const V32w = @Vector(Px * 4, u32);
const B32 = @Vector(Px * 4, u8);
const P8 = @Vector(Px, u32);

inline fn splat32(x: u16) V32 {
    return @splat(x);
}

/// Load 8 packed pixels as 32 u16 channel lanes.
inline fn loadW(dst: []const u32) V32 {
    const p: P8 = dst[0..Px].*;
    const b: B32 = @bitCast(p);
    return @as(V32, b);
}

/// Store 32 u16 channel lanes (each <= 255) as 8 packed pixels.
inline fn storeW(dst: []u32, w: V32) void {
    const b: B32 = @intCast(w);
    const p: P8 = @bitCast(b);
    dst[0..Px].* = p;
}

/// The shuffle mask that repeats lane i/4: one value per pixel to its
/// four channel lanes.
const bcast_mask: [Px * 4]i32 = blk: {
    var m: [Px * 4]i32 = undefined;
    for (0..Px * 4) |i| m[i] = @intCast(i / 4);
    break :blk m;
};

/// Broadcast one u16 per pixel to that pixel's four channel lanes.
inline fn bcast4(v: V8) V32 {
    return @shuffle(u16, v, undefined, bcast_mask);
}

/// The alpha lane of each pixel.
inline fn alphaOf(w: V32) V8 {
    const mask = comptime blk: {
        var m: [Px]i32 = undefined;
        for (0..Px) |i| m[i] = @intCast(i * 4 + 3);
        break :blk m;
    };
    return @shuffle(u16, w, undefined, mask);
}

/// One channel value per pixel repeated (r,g,b,a pattern) — the source
/// colour lanes for a solid paint.
inline fn solidLanes(src_color: u32, alpha_lane: u16) V32 {
    var arr: [Px * 4]u16 = undefined;
    const r: u16 = @intCast(src_color & 0xFF);
    const g: u16 = @intCast((src_color >> 8) & 0xFF);
    const b: u16 = @intCast((src_color >> 16) & 0xFF);
    for (0..Px) |i| {
        arr[i * 4 + 0] = r;
        arr[i * 4 + 1] = g;
        arr[i * 4 + 2] = b;
        arr[i * 4 + 3] = alpha_lane;
    }
    return arr;
}

pub inline fn mul255v(x: V32, y: V32) V32 {
    const t = x * y + splat32(0x80);
    return (t + (t >> @splat(8))) >> @splat(8);
}

pub inline fn d255v(t: V32) V32 {
    return (t + splat32(1) + (t >> @splat(8))) >> @splat(8);
}

inline fn d255v8(t: V8) V8 {
    return (t + @as(V8, @splat(1)) + (t >> @splat(8))) >> @splat(8);
}

/// 255 * 65536 / a, rounded — the reciprocal the un-premultiply uses.
/// inv[0] is never read (a == 0 lanes are forced to zero output).
pub const inv255: [256]u32 = blk: {
    var t: [256]u32 = undefined;
    t[0] = 0;
    for (1..256) |a| t[a] = @intCast((255 * 65536 + a / 2) / a);
    break :blk t;
};

/// Straight colour from a premultiplied channel and its alpha, all
/// lanes: `(x * inv255[a] + 0x8000) >> 16`, clamped to 255, zero where
/// the alpha is zero. Products stay under 2^32 (255 * 255 * 65536).
inline fn unpremulv(x: V32, a4: V32) V32 {
    var inv: [Px * 4]u32 = undefined;
    const a_arr: [Px * 4]u16 = a4;
    for (0..Px * 4) |i| inv[i] = inv255[a_arr[i]];
    const xw: V32w = @as(V32w, x);
    const q: V32w = (xw * @as(V32w, inv) + @as(V32w, @splat(0x8000))) >> @splat(16);
    const clamped = @min(q, @as(V32w, @splat(255)));
    return @intCast(clamped);
}

inline fn allOpaque(da: V8) bool {
    return @reduce(.And, da == @as(V8, @splat(255)));
}

/// True on every pixel's alpha lane.
const lane_is_alpha: @Vector(Px * 4, bool) = blk: {
    var m: [Px * 4]bool = undefined;
    for (0..Px * 4) |k| m[k] = (k % 4) == 3;
    break :blk m;
};

/// `rgb` with its alpha lanes replaced by those of `a4`.
inline fn withAlphaLane(rgb: V32, a4: V32) V32 {
    return @select(u16, lane_is_alpha, a4, rgb);
}

/// Per-pixel bool to its four channel lanes.
inline fn bcastBool(b: @Vector(Px, bool)) @Vector(Px * 4, bool) {
    return @shuffle(bool, b, undefined, bcast_mask);
}

/// `(a*(255-t) + b*t + 127)/255` per lane — generic.zig's lerpU32,
/// exactly (max 65152 < 65279).
inline fn lerpv(a: V32, b: V32, t4: V32) V32 {
    return d255v(a * (splat32(255) - t4) + b * t4 + splat32(127));
}

inline fn loadU8(row: []const u8) V8 {
    return @as(V8, @as(@Vector(Px, u8), row[0..Px].*));
}

// -----------------------------------------------------------------------------
// blendSrcOverU32 — solid source over a row (generic.zig's Porter-Duff
// src_over with exact d255; sa in 1..254 reaches the loop).
// -----------------------------------------------------------------------------

pub fn blendSrcOverU32(dst: []u32, src_color: u32) void {
    const sa: u32 = (src_color >> 24) & 0xFF;
    if (sa == 0) return;
    if (sa == 0xFF) {
        generic.fillU32(dst, src_color);
        return;
    }
    // Premultiplied source lanes: csp = d255(cs * sa). The alpha lane is
    // built from 255 so that d255(255 * sa) == sa, the scalar kernel's
    // output-alpha term; the opaque path then lands on sa + inv_sa = 255.
    const cs = solidLanes(src_color, 255);
    const sa32 = splat32(@intCast(sa));
    const csp = d255v(cs * sa32);
    const inv_sa = splat32(@intCast(255 - sa));
    var i: usize = 0;
    while (i + Px <= dst.len) : (i += Px) {
        const dw = loadW(dst[i..]);
        const da8 = alphaOf(dw);
        if (allOpaque(da8)) {
            // ao = 255: co = csp + d255(cb * inv_sa), alpha lane = sa + d255(255*inv_sa) = 255.
            storeW(dst[i..], csp + d255v(dw * inv_sa));
        } else {
            const da4 = bcast4(da8);
            const cbp = d255v(dw * da4); // alpha lane: d255(da*da), overwritten below
            var co = csp + d255v(cbp * inv_sa);
            const ao8 = @as(V8, @splat(@intCast(sa))) + d255v8(da8 * @as(V8, @splat(@intCast(255 - sa))));
            const ao4 = bcast4(ao8);
            co = unpremulv(co, ao4);
            // Put the alpha back in its lane (unpremulv of the alpha lane is meaningless).
            storeW(dst[i..], withAlphaLane(co, ao4));
        }
    }
    if (i < dst.len) generic.blendSrcOverU32(dst[i..], src_color);
}

// -----------------------------------------------------------------------------
// blendSrcOverCovU32 — solid source with a coverage row (generic.zig's
// mul255-based kernel).
// -----------------------------------------------------------------------------

pub fn blendSrcOverCovU32(dst: []u32, src_color: u32, coverage: []const u8) void {
    std.debug.assert(dst.len == coverage.len);
    const sa: u32 = (src_color >> 24) & 0xFF;
    if (sa == 0) return;
    const sa8: V8 = @splat(@intCast(sa));
    // Source lanes with a 255 alpha lane: mul255(255, a_eff) == a_eff, so the
    // alpha lane of the product IS a_eff and the sum's alpha lane is the
    // straight output alpha.
    const src4 = solidLanes(src_color, 255);
    var i: usize = 0;
    while (i + Px <= dst.len) : (i += Px) {
        const cov8 = @as(V8, @as(@Vector(Px, u8), coverage[i..][0..Px].*));
        const t = sa8 * cov8 + @as(V8, @splat(0x80));
        const a_eff8 = (t + (t >> @splat(8))) >> @splat(8);
        const a4 = bcast4(a_eff8);
        const inv4 = splat32(255) - a4;
        const dw = loadW(dst[i..]);
        const sum = mul255v(src4, a4) + mul255v(dw, inv4);
        const da8 = alphaOf(dw);
        if (allOpaque(da8)) {
            // Lanes with a_eff == 0 give mul255(dst, 255) == dst: untouched, as the scalar skip.
            storeW(dst[i..], sum);
        } else {
            const ao8 = alphaOf(sum);
            const ao4 = bcast4(ao8);
            const co = unpremulv(sum, ao4);
            var out = withAlphaLane(co, ao4);
            // Pixels the scalar kernel skips (cov == 0 or a_eff == 0) keep dst exactly.
            out = @select(u16, bcastBool(a_eff8 == @as(V8, @splat(0))), dw, out);
            storeW(dst[i..], out);
        }
    }
    if (i < dst.len) generic.blendSrcOverCovU32(dst[i..], src_color, coverage[i..]);
}

// -----------------------------------------------------------------------------
// Cores: one 8-pixel step of a blend, source lanes in, result lanes out.
// Each is generic.zig's scalar arithmetic on lanes; the kernels below
// wrap a core in the three source shapes (solid, solid × coverage,
// per-pixel row) and hand the tail to the scalar function.
// -----------------------------------------------------------------------------

const Core = fn (sw: V32, dw: V32) callconv(.@"inline") V32;

/// generic.zig's `pdKernel(faOne, faInvSa)` (srcOverScalarPD) with the
/// row kernel's exits: a zero source alpha keeps the destination bytes
/// (the scalar row returns early), 255 lands on the source exactly.
inline fn srcOverCore(sw: V32, dw: V32) V32 {
    const sa8 = alphaOf(sw);
    const da8 = alphaOf(dw);
    const inv_sa8 = @as(V8, @splat(255)) - sa8;
    const sa4 = bcast4(sa8);
    const da4 = bcast4(da8);
    const inv_sa4 = bcast4(inv_sa8);
    const csp = d255v(sw * sa4);
    const cbp = d255v(dw * da4);
    const cp = @min(csp + d255v(cbp * inv_sa4), splat32(255));
    var out: V32 = undefined;
    if (allOpaque(da8)) {
        out = withAlphaLane(cp, splat32(255));
    } else {
        const ao4 = bcast4(sa8 + d255v8(da8 * inv_sa8));
        out = withAlphaLane(unpremulv(cp, ao4), ao4);
    }
    return @select(u16, bcastBool(sa8 == @as(V8, @splat(0))), dw, out);
}

/// generic.zig's `sepKernel(B)`: source-over alpha, the three-term
/// premultiplied colour, reciprocal un-premultiply (skipped on opaque
/// rows, where ao == 255 and the sum is already the straight colour —
/// the same identity the scalar takes). `B(cb, cs)` gets whole lane
/// vectors; its alpha lanes are computed and discarded.
inline fn sepCore(comptime B: fn (cb: V32, cs: V32) callconv(.@"inline") V32, sw: V32, dw: V32) V32 {
    const sa8 = alphaOf(sw);
    const da8 = alphaOf(dw);
    const inv_sa8 = @as(V8, @splat(255)) - sa8;
    if (allOpaque(da8)) {
        const sa4 = bcast4(sa8);
        const inv_sa4 = bcast4(inv_sa8);
        const cp = @min(d255v(inv_sa4 * dw) + d255v(sa4 * B(dw, sw)), splat32(255));
        return withAlphaLane(cp, splat32(255));
    }
    const inv_da8 = @as(V8, @splat(255)) - da8;
    const ao8 = @min(sa8 + d255v8(da8 * inv_sa8), @as(V8, @splat(255)));
    const t1 = bcast4(d255v8(inv_da8 * sa8));
    const t2 = bcast4(d255v8(inv_sa8 * da8));
    const t3 = bcast4(d255v8(sa8 * da8));
    const cp = @min(d255v(t1 * sw) + d255v(t2 * dw) + d255v(t3 * B(dw, sw)), splat32(255));
    const ao4 = bcast4(ao8);
    return withAlphaLane(unpremulv(cp, ao4), ao4);
}

// Per-channel blend functions on lanes — generic.zig's b* one for one.
inline fn bMultiply(cb: V32, cs: V32) V32 {
    return d255v(cb * cs);
}
inline fn bScreen(cb: V32, cs: V32) V32 {
    return cb + cs - d255v(cb * cs);
}
inline fn bDarken(cb: V32, cs: V32) V32 {
    return @min(cb, cs);
}
inline fn bLighten(cb: V32, cs: V32) V32 {
    return @max(cb, cs);
}
inline fn bDifference(cb: V32, cs: V32) V32 {
    return @max(cb, cs) - @min(cb, cs);
}
inline fn bExclusion(cb: V32, cs: V32) V32 {
    return cb + cs - splat32(2) * d255v(cb * cs);
}
inline fn bHardLight(cb: V32, cs: V32) V32 {
    // cs <= 127: multiply(cb, 2cs); else screen(cb, 2cs - 255). Both
    // branches are computed on every lane, so each operand is clamped to
    // the range its branch is selected for (the products must fit u16).
    const cs2 = cs * splat32(2);
    const lo = d255v(cb * @min(cs2, splat32(254)));
    const cs2m = cs2 -| splat32(255);
    const hi = cb + cs2m - d255v(cb * cs2m);
    return @select(u16, cs <= splat32(127), lo, hi);
}
inline fn bOverlay(cb: V32, cs: V32) V32 {
    return bHardLight(cs, cb);
}

/// generic.zig's flashSubtractScalar: dst - src*sa per colour channel,
/// saturating at 0, destination alpha kept. A zero source alpha subtracts
/// nothing (0x80 >> 8 == 0), which is the scalar's early return.
inline fn flashSubtractCore(sw: V32, dw: V32) V32 {
    const sa4 = bcast4(alphaOf(sw));
    const eff = (sw * sa4 + splat32(0x80)) >> @splat(8);
    return withAlphaLane(dw -| eff, dw);
}

/// generic.zig's blendAddScalar: saturating add of the source weighted by
/// its own alpha (the alpha lane by 255, i.e. itself).
inline fn addCore(sw: V32, dw: V32) V32 {
    const m = withAlphaLane(bcast4(alphaOf(sw)), splat32(255));
    return @min(dw + mul255v(sw, m), splat32(255));
}

// -----------------------------------------------------------------------------
// Source shapes.
// -----------------------------------------------------------------------------

const FullFn = fn (dst: []u32, src_color: u32) void;
const CovFn = fn (dst: []u32, src_color: u32, cov: []const u8) void;
const RowFn = fn (dst: []u32, src: []const u32, mask: ?[]const u8) void;

/// Solid source: the source lanes are one constant vector.
fn fullOf(comptime core: Core, comptime tail: FullFn) FullFn {
    return struct {
        fn run(dst: []u32, src_color: u32) void {
            const sw = solidLanes(src_color, @intCast((src_color >> 24) & 0xFF));
            var i: usize = 0;
            while (i + Px <= dst.len) : (i += Px) {
                storeW(dst[i..], core(sw, loadW(dst[i..])));
            }
            if (i < dst.len) tail(dst[i..], src_color);
        }
    }.run;
}

/// Solid source with a coverage row: generic.zig's `rowOfCov`, the
/// source alpha per pixel is `(sa*cov + 0x80) >> 8` (modulateAlphaByCov).
fn covOf(comptime core: Core, comptime tail: CovFn) CovFn {
    return struct {
        fn run(dst: []u32, src_color: u32, cov: []const u8) void {
            std.debug.assert(dst.len == cov.len);
            const rgb = solidLanes(src_color, 0);
            const sa8: V8 = @splat(@intCast((src_color >> 24) & 0xFF));
            var i: usize = 0;
            while (i + Px <= dst.len) : (i += Px) {
                const a8 = (sa8 * loadU8(cov[i..]) + @as(V8, @splat(0x80))) >> @splat(8);
                const sw = withAlphaLane(rgb, bcast4(a8));
                storeW(dst[i..], core(sw, loadW(dst[i..])));
            }
            if (i < dst.len) tail(dst[i..], src_color, cov[i..]);
        }
    }.run;
}

/// Per-pixel source with generic.zig's `rowOfSrc` mask rule.
fn rowOf(comptime core: Core, comptime tail: RowFn) RowFn {
    return struct {
        fn run(dst: []u32, src: []const u32, mask: ?[]const u8) void {
            std.debug.assert(dst.len == src.len);
            var i: usize = 0;
            if (mask) |m| {
                std.debug.assert(m.len == dst.len);
                while (i + Px <= dst.len) : (i += Px) {
                    const t8 = loadU8(m[i..]);
                    if (@reduce(.And, t8 == @as(V8, @splat(0)))) continue;
                    const dw = loadW(dst[i..]);
                    const out = core(loadW(src[i..]), dw);
                    storeW(dst[i..], lerpv(dw, out, bcast4(t8)));
                }
            } else {
                while (i + Px <= dst.len) : (i += Px) {
                    storeW(dst[i..], core(loadW(src[i..]), loadW(dst[i..])));
                }
            }
            if (i < dst.len) tail(dst[i..], src[i..], if (mask) |m| m[i..] else null);
        }
    }.run;
}

fn sepOf(comptime B: fn (cb: V32, cs: V32) callconv(.@"inline") V32) Core {
    return struct {
        inline fn core(sw: V32, dw: V32) V32 {
            return sepCore(B, sw, dw);
        }
    }.core;
}

pub const blendSrcOverRowU32 = rowOf(srcOverCore, generic.blendSrcOverRowU32);

pub const blendMultiplyU32 = fullOf(sepOf(bMultiply), generic.blendMultiplyU32);
pub const blendScreenU32 = fullOf(sepOf(bScreen), generic.blendScreenU32);
pub const blendDarkenU32 = fullOf(sepOf(bDarken), generic.blendDarkenU32);
pub const blendLightenU32 = fullOf(sepOf(bLighten), generic.blendLightenU32);
pub const blendDifferenceU32 = fullOf(sepOf(bDifference), generic.blendDifferenceU32);
pub const blendExclusionU32 = fullOf(sepOf(bExclusion), generic.blendExclusionU32);
pub const blendHardLightU32 = fullOf(sepOf(bHardLight), generic.blendHardLightU32);
pub const blendOverlayU32 = fullOf(sepOf(bOverlay), generic.blendOverlayU32);
pub const blendFlashSubtractU32 = fullOf(flashSubtractCore, generic.blendFlashSubtractU32);

pub const blendMultiplyCovU32 = covOf(sepOf(bMultiply), generic.blendMultiplyCovU32);
pub const blendScreenCovU32 = covOf(sepOf(bScreen), generic.blendScreenCovU32);
pub const blendDarkenCovU32 = covOf(sepOf(bDarken), generic.blendDarkenCovU32);
pub const blendLightenCovU32 = covOf(sepOf(bLighten), generic.blendLightenCovU32);
pub const blendDifferenceCovU32 = covOf(sepOf(bDifference), generic.blendDifferenceCovU32);
pub const blendExclusionCovU32 = covOf(sepOf(bExclusion), generic.blendExclusionCovU32);
pub const blendHardLightCovU32 = covOf(sepOf(bHardLight), generic.blendHardLightCovU32);
pub const blendOverlayCovU32 = covOf(sepOf(bOverlay), generic.blendOverlayCovU32);
pub const blendFlashSubtractCovU32 = covOf(flashSubtractCore, generic.blendFlashSubtractCovU32);

pub const blendMultiplyRowU32 = rowOf(sepOf(bMultiply), generic.blendMultiplyRowU32);
pub const blendScreenRowU32 = rowOf(sepOf(bScreen), generic.blendScreenRowU32);
pub const blendDarkenRowU32 = rowOf(sepOf(bDarken), generic.blendDarkenRowU32);
pub const blendLightenRowU32 = rowOf(sepOf(bLighten), generic.blendLightenRowU32);
pub const blendDifferenceRowU32 = rowOf(sepOf(bDifference), generic.blendDifferenceRowU32);
pub const blendExclusionRowU32 = rowOf(sepOf(bExclusion), generic.blendExclusionRowU32);
pub const blendHardLightRowU32 = rowOf(sepOf(bHardLight), generic.blendHardLightRowU32);
pub const blendOverlayRowU32 = rowOf(sepOf(bOverlay), generic.blendOverlayRowU32);
pub const blendFlashSubtractRowU32 = rowOf(flashSubtractCore, generic.blendFlashSubtractRowU32);
pub const blendAddRowU32 = rowOf(addCore, generic.blendAddRowU32);

/// generic.zig's blendAddCovU32: every channel, alpha included, scaled by
/// `(c*cov + 0x80) >> 8` and added with saturation (it does not weight by
/// the source alpha; the scalar is the contract).
pub fn blendAddCovU32(dst: []u32, src_color: u32, cov: []const u8) void {
    std.debug.assert(dst.len == cov.len);
    const src4 = solidLanes(src_color, @intCast((src_color >> 24) & 0xFF));
    var i: usize = 0;
    while (i + Px <= dst.len) : (i += Px) {
        const c4 = bcast4(loadU8(cov[i..]));
        const e = (src4 * c4 + splat32(0x80)) >> @splat(8);
        storeW(dst[i..], @min(loadW(dst[i..]) + e, splat32(255)));
    }
    if (i < dst.len) generic.blendAddCovU32(dst[i..], src_color, cov[i..]);
}
