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

// Owned RGBA buffer (4 * width * height bytes). Allocated by the chosen
// allocator; freed by `deinit`. `width` and `height` are the source image
// dimensions in pixels.
data: []u8,
width: u32,
height: u32,
repetition: Repetition,
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
/// non-tiled axis of `.repeat_x` / `.repeat_y`) returns 0 (transparent).
pub fn sample(self: *const SmPattern, x: f64, y: f64) u32 {
    if (self.width == 0 or self.height == 0) return 0;
    const src = self.inv_transform.applyToPoint(x, y);
    const sx = src[0];
    const sy = src[1];
    if (!std.math.isFinite(sx) or !std.math.isFinite(sy)) return 0;

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
