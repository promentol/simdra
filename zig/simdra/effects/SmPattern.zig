//! SmPattern — image tile shader. Backs the HTML5 `CanvasPattern` returned
//! by `ctx.createPattern(image, repetition)`. Owns its own RGBA buffer so
//! the source ImageData / Canvas can mutate or be GC'd freely after
//! construction (HTML5 spec: createPattern snapshots).
//!
//! Storage: straight-alpha RGBA8 (`r,g,b,a` little-endian into `u32`),
//! matching `SmBitmap` and the rest of the pipeline.
//!
//! Sampling: per-pixel `sample(x, y)` — apply `inv_transform`, then
//! repetition mode (`floorMod` for wrap modes — handles negative
//! coordinates), then nearest-neighbor texel fetch. Bilinear filtering
//! and SIMD row sampling are future work; v1 is correct first.

const std = @import("std");
const SmMatrix = @import("../core/SmMatrix.zig");

const SmPattern = @This();

/// HTML5 repetition modes. JS-side maps strings → enum integer.
pub const Repetition = enum(u8) {
    repeat = 0,
    repeat_x = 1,
    repeat_y = 2,
    no_repeat = 3,
};

/// Texel filtering. `.nearest` is the HTML5-facade default (published
/// behavior); `.bilinear` is a simdra extension used by the Flash (SWF)
/// renderer for "smoothed" bitmap fills. Append-only enum.
pub const Filter = enum(u8) {
    nearest = 0,
    bilinear = 1,
};

// Owned RGBA buffer (4 * width * height bytes). Allocated by the chosen
// allocator; freed by `deinit`. `width` and `height` are the source image
// dimensions in pixels.
data: []u8,
width: u32,
height: u32,
repetition: Repetition,
/// Texel filter. Defaulted so every existing construction (and the HTML5
/// facade) keeps nearest-neighbor behavior.
filter: Filter = .nearest,
/// Inverse pattern transform — applied to dst (x,y) before texel lookup.
/// `setTransform(a..f)` stores the *inverse* of the user-supplied matrix
/// so the per-pixel sampler is one matrix multiply, not a multiply + invert.
inv_transform: SmMatrix = .{},
allocator: std.mem.Allocator = std.heap.page_allocator,

/// create(rgba, width, height, repetition) — copies `rgba` into a freshly
/// allocated owned buffer (page_allocator). Backs JS `createPattern`.
pub fn create(rgba: []const u8, width: u32, height: u32, rep: Repetition) !SmPattern {
    return createWithAllocator(std.heap.page_allocator, rgba, width, height, rep);
}

/// createWithAllocator — pure-Zig variant for tests / explicit allocator
/// control.
pub fn createWithAllocator(
    allocator: std.mem.Allocator,
    rgba: []const u8,
    width: u32,
    height: u32,
    rep: Repetition,
) !SmPattern {
    const expected_len: usize = @as(usize, width) * @as(usize, height) * 4;
    std.debug.assert(rgba.len == expected_len);
    const buf = try allocator.alloc(u8, expected_len);
    @memcpy(buf, rgba);
    return .{
        .data = buf,
        .width = width,
        .height = height,
        .repetition = rep,
        .allocator = allocator,
    };
}

pub fn deinit(self: *SmPattern) void {
    self.allocator.free(self.data);
}

/// setFilter(mode) — select nearest / bilinear texel filtering. Setter
/// (not a factory parameter) so the existing factory arities stay
/// binding-compatible.
pub fn setFilter(self: *SmPattern, f: Filter) void {
    self.filter = f;
}

/// setTransform(a, b, c, d, e, f) — store the inverse of the supplied
/// 2D affine. Singular matrices (det ≈ 0) collapse to identity (silent
/// no-op per HTML5: "If matrix is not invertible, do nothing").
pub fn setTransform(
    self: *SmPattern,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
) void {
    var m = SmMatrix.components(a, b, c, d, e, f);
    _ = m.invertSelf();
    if (std.math.isNan(m.a)) {
        // Singular — keep current transform identity.
        self.inv_transform = .{};
        return;
    }
    self.inv_transform = m;
}

/// floorMod(a, n) — Euclidean modulo (always returns [0, n)). Required for
/// the repeat modes so that negative source coordinates wrap correctly.
inline fn floorMod(a: i64, n: i64) i64 {
    const r = @mod(a, n);
    return if (r < 0) r + n else r;
}

/// sample(x, y) → packed RGBA. Out-of-bounds with `.no_repeat` (or the
/// non-tiled axis of `.repeat_x` / `.repeat_y`) returns 0 (transparent);
/// under `.bilinear`, out-of-bounds taps contribute transparent so edges
/// fade smoothly instead of cutting hard.
pub fn sample(self: *const SmPattern, x: f64, y: f64) u32 {
    if (self.width == 0 or self.height == 0) return 0;
    const src = self.inv_transform.applyToPoint(x, y);
    const sx = src[0];
    const sy = src[1];
    if (!std.math.isFinite(sx) or !std.math.isFinite(sy)) return 0;

    return switch (self.filter) {
        .nearest => self.sampleNearest(sx, sy),
        .bilinear => self.sampleBilinear(sx, sy),
    };
}

// --- Row sampling ----------------------------------------------------------
//
// Along a row the pattern-space point is affine in x, so the matrix is
// applied once per row and the texel coordinate stepped; tiled axes wrap
// the step by a compare instead of a division per pixel, and the
// bilinear taps blend in f32 with one reciprocal per pixel where the
// per-pixel sampler divided per channel and tap. The per-pixel samplers
// stay as the reference the row samplers are tested against.

/// sampleRow — `out[i]` = the colour at (x_start + i, y).
pub fn sampleRow(self: *const SmPattern, x_start: f64, y: f64, out: []u32) void {
    if (self.width == 0 or self.height == 0) {
        @memset(out, 0);
        return;
    }
    const p0 = self.inv_transform.applyToPoint(x_start, y);
    const p1 = self.inv_transform.applyToPoint(x_start + 1.0, y);
    const dsx = p1[0] - p0[0];
    const dsy = p1[1] - p0[1];
    if (!std.math.isFinite(p0[0]) or !std.math.isFinite(p0[1]) or !std.math.isFinite(dsx) or !std.math.isFinite(dsy)) {
        @memset(out, 0);
        return;
    }
    switch (self.filter) {
        .nearest => self.sampleNearestRow(p0[0], p0[1], dsx, dsy, out),
        .bilinear => self.sampleBilinearRow(p0[0], p0[1], dsx, dsy, out),
    }
}

/// One texel axis walked along the row: wrapped into [0, n) once, then
/// stepped with a compare per pixel (the step is first folded into
/// (-n, n) so one compare suffices). Non-tiled axes step unwrapped and
/// range-check per pixel.
const AxisWalk = struct {
    u: f64,
    du: f64,
    n: f64,
    tiled: bool,

    fn init(u_start: f64, du: f64, n: u32, tiled: bool) AxisWalk {
        const nf: f64 = @floatFromInt(n);
        if (!tiled) return .{ .u = u_start, .du = du, .n = nf, .tiled = false };
        var u = @mod(u_start, nf);
        if (u < 0 or u >= nf) u = 0;
        var d = @mod(du, nf);
        if (d < 0 or d >= nf) d = 0;
        return .{ .u = u, .du = d, .n = nf, .tiled = true };
    }

    inline fn step(self: *AxisWalk) void {
        self.u += self.du;
        if (self.tiled and self.u >= self.n) self.u -= self.n;
    }

    /// The texel index, or null off a non-tiled axis.
    inline fn index(self: *const AxisWalk) ?usize {
        if (self.tiled) return @intFromFloat(self.u);
        if (self.u < 0 or self.u >= self.n) return null;
        return @intFromFloat(@floor(self.u));
    }
};

fn sampleNearestRow(self: *const SmPattern, sx0: f64, sy0: f64, dsx: f64, dsy: f64, out: []u32) void {
    const tile_x = self.repetition == .repeat or self.repetition == .repeat_x;
    const tile_y = self.repetition == .repeat or self.repetition == .repeat_y;
    var ax = AxisWalk.init(sx0, dsx, self.width, tile_x);
    var ay = AxisWalk.init(sy0, dsy, self.height, tile_y);
    const w: usize = self.width;
    for (out) |*o| {
        const ix = ax.index();
        const iy = ay.index();
        if (ix != null and iy != null) {
            const idx = (iy.? * w + ix.?) * 4;
            const px: [4]u8 = self.data[idx..][0..4].*;
            o.* = @bitCast(px);
        } else {
            o.* = 0;
        }
        ax.step();
        ay.step();
    }
}

fn sampleBilinearRow(self: *const SmPattern, sx0: f64, sy0: f64, dsx: f64, dsy: f64, out: []u32) void {
    const tile_x = self.repetition == .repeat or self.repetition == .repeat_x;
    const tile_y = self.repetition == .repeat or self.repetition == .repeat_y;
    const w_i: i64 = @intCast(self.width);
    const h_i: i64 = @intCast(self.height);
    // The -0.5 puts texel centres at integer offsets (see sampleBilinear).
    var ax = AxisWalk.init(sx0 - 0.5, dsx, self.width, tile_x);
    var ay = AxisWalk.init(sy0 - 0.5, dsy, self.height, tile_y);
    const w: usize = self.width;
    const inv255: f32 = 1.0 / 255.0;
    for (out) |*o| {
        const ufl = @floor(ax.u);
        const vfl = @floor(ay.u);
        const fx: f32 = @floatCast(ax.u - ufl);
        const fy: f32 = @floatCast(ay.u - vfl);
        const x0: i64 = @intFromFloat(ufl);
        const y0: i64 = @intFromFloat(vfl);
        const xs = [2]?i64{ resolveTap(x0, w_i, tile_x), resolveTap(x0 + 1, w_i, tile_x) };
        const ys = [2]?i64{ resolveTap(y0, h_i, tile_y), resolveTap(y0 + 1, h_i, tile_y) };
        const wx = [2]f32{ 1.0 - fx, fx };
        const wy = [2]f32{ 1.0 - fy, fy };
        var pr: f32 = 0;
        var pg: f32 = 0;
        var pb: f32 = 0;
        var pa: f32 = 0;
        inline for (0..2) |j| {
            if (ys[j]) |yy| {
                const row_base: usize = @as(usize, @intCast(yy)) * w;
                inline for (0..2) |k| {
                    if (xs[k]) |xx| {
                        const wt = wx[k] * wy[j];
                        const idx = (row_base + @as(usize, @intCast(xx))) * 4;
                        const a: f32 = @floatFromInt(self.data[idx + 3]);
                        const aw = a * wt;
                        pr += @as(f32, @floatFromInt(self.data[idx])) * aw;
                        pg += @as(f32, @floatFromInt(self.data[idx + 1])) * aw;
                        pb += @as(f32, @floatFromInt(self.data[idx + 2])) * aw;
                        pa += aw;
                    }
                }
            }
        }
        if (pa > 0) {
            // pr is Σ r·a·w; the straight colour is Σ r·a·w / Σ a·w.
            const inv = 1.0 / pa;
            const r: u32 = @intFromFloat(@round(@min(255.0, pr * inv)));
            const g: u32 = @intFromFloat(@round(@min(255.0, pg * inv)));
            const b: u32 = @intFromFloat(@round(@min(255.0, pb * inv)));
            const a: u32 = @intFromFloat(@round(@min(255.0, pa)));
            o.* = r | (g << 8) | (b << 16) | (a << 24);
        } else {
            o.* = 0;
        }
        _ = inv255;
        ax.step();
        ay.step();
    }
}

fn sampleNearest(self: *const SmPattern, sx: f64, sy: f64) u32 {
    const w_i: i64 = @intCast(self.width);
    const h_i: i64 = @intCast(self.height);
    const ix_raw: i64 = @intFromFloat(@floor(sx));
    const iy_raw: i64 = @intFromFloat(@floor(sy));

    var ix: i64 = ix_raw;
    var iy: i64 = iy_raw;

    switch (self.repetition) {
        .repeat => {
            ix = floorMod(ix_raw, w_i);
            iy = floorMod(iy_raw, h_i);
        },
        .repeat_x => {
            ix = floorMod(ix_raw, w_i);
            if (iy_raw < 0 or iy_raw >= h_i) return 0;
        },
        .repeat_y => {
            if (ix_raw < 0 or ix_raw >= w_i) return 0;
            iy = floorMod(iy_raw, h_i);
        },
        .no_repeat => {
            if (ix_raw < 0 or ix_raw >= w_i) return 0;
            if (iy_raw < 0 or iy_raw >= h_i) return 0;
        },
    }

    const idx: usize = (@as(usize, @intCast(iy)) * @as(usize, self.width) + @as(usize, @intCast(ix))) * 4;
    const r: u32 = self.data[idx];
    const g: u32 = self.data[idx + 1];
    const b: u32 = self.data[idx + 2];
    const a: u32 = self.data[idx + 3];
    return r | (g << 8) | (b << 16) | (a << 24);
}

/// Resolve one bilinear tap index along an axis: tiled axes wrap with
/// `floorMod` (so the filter blends across the tile seam); non-tiled axes
/// return null for out-of-range taps (they contribute transparent).
inline fn resolveTap(i: i64, n: i64, tiled: bool) ?i64 {
    if (tiled) return floorMod(i, n);
    if (i < 0 or i >= n) return null;
    return i;
}

/// Wrap-aware 4-tap bilinear fetch. Premul-aware: premultiply each tap,
/// blend premultiplied channels + alpha, un-premultiply at the end (same
/// math as opts/generic.zig sampleImageBilinearRow — no halo around
/// transparent texels). The -0.5 shift puts neighbor texel centers at
/// integer offsets.
fn sampleBilinear(self: *const SmPattern, sx: f64, sy: f64) u32 {
    const w_i: i64 = @intCast(self.width);
    const h_i: i64 = @intCast(self.height);
    const u = sx - 0.5;
    const v = sy - 0.5;
    const x0: i64 = @intFromFloat(@floor(u));
    const y0: i64 = @intFromFloat(@floor(v));
    const fx = u - @as(f64, @floatFromInt(x0));
    const fy = v - @as(f64, @floatFromInt(y0));

    const tile_x = self.repetition == .repeat or self.repetition == .repeat_x;
    const tile_y = self.repetition == .repeat or self.repetition == .repeat_y;
    const xs = [2]?i64{ resolveTap(x0, w_i, tile_x), resolveTap(x0 + 1, w_i, tile_x) };
    const ys = [2]?i64{ resolveTap(y0, h_i, tile_y), resolveTap(y0 + 1, h_i, tile_y) };
    const wx = [2]f64{ 1.0 - fx, fx };
    const wy = [2]f64{ 1.0 - fy, fy };

    var sum_pr: f64 = 0;
    var sum_pg: f64 = 0;
    var sum_pb: f64 = 0;
    var sum_a: f64 = 0;
    for (ys, wy) |oy, wyv| {
        const yy = oy orelse continue;
        const row_base: usize = @as(usize, @intCast(yy)) * @as(usize, self.width);
        for (xs, wx) |ox, wxv| {
            const xx = ox orelse continue;
            const w = wxv * wyv;
            if (w == 0) continue;
            const idx: usize = (row_base + @as(usize, @intCast(xx))) * 4;
            const r: f64 = @floatFromInt(self.data[idx]);
            const g: f64 = @floatFromInt(self.data[idx + 1]);
            const b: f64 = @floatFromInt(self.data[idx + 2]);
            const a: f64 = @floatFromInt(self.data[idx + 3]);
            sum_pr += r * a / 255.0 * w;
            sum_pg += g * a / 255.0 * w;
            sum_pb += b * a / 255.0 * w;
            sum_a += a * w;
        }
    }

    var out_r: f64 = 0;
    var out_g: f64 = 0;
    var out_b: f64 = 0;
    if (sum_a > 0) {
        out_r = sum_pr * 255.0 / sum_a;
        out_g = sum_pg * 255.0 / sum_a;
        out_b = sum_pb * 255.0 / sum_a;
    }
    const r_u: u32 = @intFromFloat(@round(std.math.clamp(out_r, 0.0, 255.0)));
    const g_u: u32 = @intFromFloat(@round(std.math.clamp(out_g, 0.0, 255.0)));
    const b_u: u32 = @intFromFloat(@round(std.math.clamp(out_b, 0.0, 255.0)));
    const a_u: u32 = @intFromFloat(@round(std.math.clamp(sum_a, 0.0, 255.0)));
    return r_u | (g_u << 8) | (b_u << 16) | (a_u << 24);
}

// --- Tests ---------------------------------------------------------------

const t_alloc = std.testing.allocator;

fn checkerboard2x2(rep: Repetition) !SmPattern {
    // row 0: black, white · row 1: white, black — all opaque.
    const px = [16]u8{
        0,   0,   0,   255, 255, 255, 255, 255,
        255, 255, 255, 255, 0,   0,   0,   255,
    };
    return createWithAllocator(t_alloc, &px, 2, 2, rep);
}

test "bilinear at texel centers equals nearest" {
    var p = try checkerboard2x2(.repeat);
    defer p.deinit();
    p.setFilter(.bilinear);
    try std.testing.expectEqual(@as(u32, 0xFF000000), p.sample(0.5, 0.5));
    try std.testing.expectEqual(@as(u32, 0xFFFFFFFF), p.sample(1.5, 0.5));
    try std.testing.expectEqual(@as(u32, 0xFFFFFFFF), p.sample(0.5, 1.5));
}

test "bilinear at the 4-texel midpoint averages to gray" {
    var p = try checkerboard2x2(.repeat);
    defer p.deinit();
    p.setFilter(.bilinear);
    try std.testing.expectEqual(@as(u32, 0xFF808080), p.sample(1.0, 1.0));
}

test "bilinear wraps across the tile seam under .repeat" {
    var p = try checkerboard2x2(.repeat);
    defer p.deinit();
    p.setFilter(.bilinear);
    // x=2.0 row 0: taps texel 1 (white) and wrapped texel 0 (black) at 50%.
    try std.testing.expectEqual(@as(u32, 0xFF808080), p.sample(2.0, 0.5));
}

test "bilinear no_repeat edge taps contribute transparent" {
    var p = try checkerboard2x2(.no_repeat);
    defer p.deinit();
    p.setFilter(.bilinear);
    // x=2.0 row 0: only the white in-bounds tap at weight 0.5 → white at
    // half alpha (edge fades out instead of hard-cutting).
    try std.testing.expectEqual(@as(u32, 0x80FFFFFF), p.sample(2.0, 0.5));
}

test "bilinear premul blend has no color fringe from transparent texels" {
    // 2×1: transparent RED next to opaque BLUE.
    const px = [8]u8{ 255, 0, 0, 0, 0, 0, 255, 255 };
    var p = try createWithAllocator(t_alloc, &px, 2, 1, .no_repeat);
    defer p.deinit();
    p.setFilter(.bilinear);
    const c = p.sample(1.0, 0.5); // midpoint between the two texels
    try std.testing.expectEqual(@as(u32, 0), c & 0xFF); // zero red
    try std.testing.expectEqual(@as(u32, 255), (c >> 16) & 0xFF); // full blue
    try std.testing.expectEqual(@as(u32, 128), (c >> 24) & 0xFF); // half alpha
}

test "default filter is nearest" {
    var p = try checkerboard2x2(.repeat);
    defer p.deinit();
    try std.testing.expectEqual(Filter.nearest, p.filter);
    // Nearest at a midpoint picks the floor texel — no blending.
    try std.testing.expectEqual(@as(u32, 0xFF000000), p.sample(0.9, 0.9));
}

test "row samplers match the per-pixel samplers: nearest and bilinear, every repetition, rotated" {
    const ta = std.testing.allocator;
    var prng = std.Random.DefaultPrng.init(0x9a77);
    const r = prng.random();
    var tile: [7 * 5 * 4]u8 = undefined;
    for (&tile) |*b| b.* = r.int(u8);
    const N = 131;
    var row: [N]u32 = undefined;
    var ref: [N]u32 = undefined;
    inline for (.{ Repetition.repeat, Repetition.repeat_x, Repetition.repeat_y, Repetition.no_repeat }) |rep| {
        inline for (.{ Filter.nearest, Filter.bilinear }) |filter| {
            var pat = try createWithAllocator(ta, &tile, 7, 5, rep);
            defer pat.deinit();
            pat.setFilter(filter);
            // A rotation with scale and a translation, inverted for sampling.
            pat.setTransform(0.83, 0.31, -0.27, 0.91, 12.5, -3.25);
            var worst: u32 = 0;
            var y: f64 = -9.5;
            while (y < 40) : (y += 3.75) {
                pat.sampleRow(-14.5, y, &row);
                for (&ref, 0..) |*o, i| o.* = pat.sample(-14.5 + @as(f64, @floatFromInt(i)), y);
                for (ref, row, 0..) |x, z, i| {
                    // Nearest sampling on an exact texel boundary may pick
                    // either neighbour (the stepped coordinate and the
                    // per-pixel one differ by an ulp); skip those pixels.
                    if (filter == .nearest) {
                        const sp = pat.inv_transform.applyToPoint(-14.5 + @as(f64, @floatFromInt(i)), y);
                        const fx = sp[0] - @floor(sp[0]);
                        const fy = sp[1] - @floor(sp[1]);
                        if (fx < 1e-9 or fx > 1.0 - 1e-9 or fy < 1e-9 or fy > 1.0 - 1e-9) continue;
                    }
                    var d: u32 = 0;
                    inline for (0..4) |ch| {
                        const shift: u5 = @intCast(ch * 8);
                        const xa: i32 = @intCast((x >> shift) & 0xFF);
                        const yb: i32 = @intCast((z >> shift) & 0xFF);
                        d = @max(d, @as(u32, @intCast(@abs(xa - yb))));
                    }
                    if (d > 2 and d > worst) {
                        const sp = pat.inv_transform.applyToPoint(-14.5 + @as(f64, @floatFromInt(i)), y);
                        std.debug.print("\n{s} {s}: i={d} y={d:.2} ref={x:0>8} row={x:0>8} src=({d:.6},{d:.6})\n", .{ @tagName(rep), @tagName(filter), i, y, x, z, sp[0], sp[1] });
                    }
                    worst = @max(worst, d);
                }
            }
            // Nearest is exact except where the stepped coordinate lands on
            // a texel boundary; bilinear rounds in f32 instead of f64.
            try std.testing.expect(worst <= 2);
        }
    }
}
