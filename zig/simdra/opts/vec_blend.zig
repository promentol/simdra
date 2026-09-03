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
            const lane_is_alpha = comptime blk: {
                var m: [Px * 4]bool = undefined;
                for (0..Px * 4) |k| m[k] = (k % 4) == 3;
                break :blk m;
            };
            const out = @select(u16, @as(@Vector(Px * 4, bool), lane_is_alpha), ao4, co);
            storeW(dst[i..], out);
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
            const lane_is_alpha = comptime blk: {
                var m: [Px * 4]bool = undefined;
                for (0..Px * 4) |k| m[k] = (k % 4) == 3;
                break :blk m;
            };
            var out = @select(u16, @as(@Vector(Px * 4, bool), lane_is_alpha), ao4, co);
            // Pixels the scalar kernel skips (cov == 0 or a_eff == 0) keep dst exactly.
            const keep8 = a_eff8 == @as(V8, @splat(0));
            const keep4 = @shuffle(bool, keep8, undefined, bcast_mask);
            out = @select(u16, keep4, dw, out);
            storeW(dst[i..], out);
        }
    }
    if (i < dst.len) generic.blendSrcOverCovU32(dst[i..], src_color, coverage[i..]);
}
