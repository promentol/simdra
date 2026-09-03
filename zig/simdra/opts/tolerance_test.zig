//! The backend tolerance test: every kernel `vec_blend.zig` provides is
//! run beside `generic.zig`'s scalar version, on the same random rows, and
//! must agree to within ±1 LSB per channel. Both backends are imported
//! directly — not through `simd.zig` — so one run on any architecture
//! covers both, and the rows are chosen to reach every path: opaque,
//! zero-alpha and translucent destinations; source alphas 0, 1, 127, 254,
//! 255 and random; coverage the same; lengths 1..37 so the vector body and
//! the scalar tail both run.
//!
//! It also checks the arithmetic identities the vector kernels rest on,
//! exhaustively: the exact `/255` and `mul255` forms, and the reciprocal
//! un-premultiply against the scalar division.
//!
//! Every kernel vec_blend.zig exports has a row here; the test prints the
//! measured maximum per kernel so a change that widens one is visible in
//! the log before it fails the bound.

const std = @import("std");
const generic = @import("generic.zig");
const vec = @import("vec_blend.zig");

const ROWS = 4096;
const MAXLEN = 37;

fn maxChannelDelta(a: []const u32, b: []const u32) u32 {
    var m: u32 = 0;
    for (a, b) |x, y| {
        inline for (0..4) |ch| {
            const shift: u5 = @intCast(ch * 8);
            const xa: i32 = @intCast((x >> shift) & 0xFF);
            const yb: i32 = @intCast((y >> shift) & 0xFF);
            m = @max(m, @as(u32, @intCast(@abs(xa - yb))));
        }
    }
    return m;
}

fn fillDst(r: std.Random, dst: []u32, class: usize) void {
    for (dst) |*p| {
        const rgb = r.int(u32) & 0x00FFFFFF;
        const alpha: u32 = switch (class) {
            0 => 255,
            1 => 0,
            2 => r.int(u8),
            else => if (r.boolean()) 255 else r.int(u8),
        };
        p.* = rgb | (alpha << 24);
    }
}

fn pick(r: std.Random, sel: usize) u8 {
    return switch (sel % 6) {
        0 => 0,
        1 => 1,
        2 => 127,
        3 => 254,
        4 => 255,
        else => r.int(u8),
    };
}

test "vec_blend == generic within 1 LSB: blendSrcOverU32, blendSrcOverCovU32" {
    var prng = std.Random.DefaultPrng.init(0x7011);
    const r = prng.random();
    var a: [MAXLEN]u32 = undefined;
    var b: [MAXLEN]u32 = undefined;
    var cov: [MAXLEN]u8 = undefined;
    var worst_full: u32 = 0;
    var worst_cov: u32 = 0;
    var it: usize = 0;
    while (it < ROWS) : (it += 1) {
        const len = 1 + r.uintLessThan(usize, MAXLEN);
        const sa: u32 = pick(r, it);
        const src = (r.int(u32) & 0x00FFFFFF) | (sa << 24);
        fillDst(r, a[0..len], it % 4);
        @memcpy(b[0..len], a[0..len]);
        generic.blendSrcOverU32(a[0..len], src);
        vec.blendSrcOverU32(b[0..len], src);
        worst_full = @max(worst_full, maxChannelDelta(a[0..len], b[0..len]));

        fillDst(r, a[0..len], (it / 4) % 4);
        @memcpy(b[0..len], a[0..len]);
        const cov_sel = (it / 6) % 6;
        for (cov[0..len]) |*c| c.* = pick(r, cov_sel);
        generic.blendSrcOverCovU32(a[0..len], src, cov[0..len]);
        vec.blendSrcOverCovU32(b[0..len], src, cov[0..len]);
        worst_cov = @max(worst_cov, maxChannelDelta(a[0..len], b[0..len]));
    }
    std.debug.print("\ntolerance: blendSrcOverU32 max delta {d}, blendSrcOverCovU32 max delta {d}\n", .{ worst_full, worst_cov });
    try std.testing.expect(worst_full <= 1);
    try std.testing.expect(worst_cov <= 1);
}

test "identities: d255v == t/255 for t <= 65279, mul255v == exact mul255" {
    // 65279 is the u16 lane bound (t + 1 + (t >> 8) must not wrap); the
    // kernels' largest argument is 255 * 255 = 65025.
    const V = @Vector(vec.Px * 4, u16);
    var t: u32 = 0;
    while (t + vec.Px * 4 <= 65280) : (t += vec.Px * 4) {
        var arr: [vec.Px * 4]u16 = undefined;
        for (0..vec.Px * 4) |k| arr[k] = @intCast(t + k);
        const q: [vec.Px * 4]u16 = vec.d255v(@as(V, arr));
        for (0..vec.Px * 4) |k| {
            const want: u16 = @intCast((t + k) / 255);
            try std.testing.expectEqual(want, q[k]);
        }
    }
    // mul255: every (x, y) pair in 0..255, 32 lanes at a time.
    var x: u32 = 0;
    while (x < 256) : (x += 1) {
        var y: u32 = 0;
        while (y < 256) : (y += vec.Px * 4) {
            var xs: [vec.Px * 4]u16 = undefined;
            var ys: [vec.Px * 4]u16 = undefined;
            for (0..vec.Px * 4) |k| {
                xs[k] = @intCast(x);
                ys[k] = @intCast(y + k);
            }
            const q: [vec.Px * 4]u16 = vec.mul255v(@as(V, xs), @as(V, ys));
            for (0..vec.Px * 4) |k| {
                const tt: u32 = x * (y + @as(u32, @intCast(k))) + 0x80;
                const want: u16 = @intCast((tt + (tt >> 8)) >> 8);
                try std.testing.expectEqual(want, q[k]);
            }
        }
    }
}

test "identities: reciprocal un-premultiply within 1 LSB of the scalar division" {
    var worst: u32 = 0;
    var a: u32 = 1;
    while (a < 256) : (a += 1) {
        var x: u32 = 0;
        while (x <= a) : (x += 1) {
            const q: u32 = @min(255, (x * vec.inv255[a] + 0x8000) >> 16);
            const exact_round: u32 = @min(255, (x * 255 + a / 2) / a);
            const exact_trunc: u32 = @min(255, x * 255 / a);
            const d1: u32 = @intCast(@abs(@as(i32, @intCast(q)) - @as(i32, @intCast(exact_round))));
            const d2: u32 = @intCast(@abs(@as(i32, @intCast(q)) - @as(i32, @intCast(exact_trunc))));
            worst = @max(worst, @min(d1, d2));
            try std.testing.expect(d1 <= 1);
            try std.testing.expect(d2 <= 1);
        }
    }
    try std.testing.expect(worst <= 1);
}

const FullFn = fn (dst: []u32, src_color: u32) void;
const CovFn = fn (dst: []u32, src_color: u32, cov: []const u8) void;
const RowFn = fn (dst: []u32, src: []const u32, mask: ?[]const u8) void;

/// Random source pixels: alpha from `pick`, colour random.
fn fillSrc(r: std.Random, src: []u32, sel: usize) void {
    for (src, 0..) |*p, i| {
        const a: u32 = pick(r, sel + i);
        p.* = (r.int(u32) & 0x00FFFFFF) | (a << 24);
    }
}

fn worstFull(comptime g: FullFn, comptime v: FullFn, seed: u64) u32 {
    var prng = std.Random.DefaultPrng.init(seed);
    const r = prng.random();
    var a: [MAXLEN]u32 = undefined;
    var b: [MAXLEN]u32 = undefined;
    var worst: u32 = 0;
    var it: usize = 0;
    while (it < ROWS) : (it += 1) {
        const len = 1 + r.uintLessThan(usize, MAXLEN);
        const src = (r.int(u32) & 0x00FFFFFF) | (@as(u32, pick(r, it)) << 24);
        fillDst(r, a[0..len], it % 4);
        @memcpy(b[0..len], a[0..len]);
        g(a[0..len], src);
        v(b[0..len], src);
        worst = @max(worst, maxChannelDelta(a[0..len], b[0..len]));
    }
    return worst;
}

fn worstCov(comptime g: CovFn, comptime v: CovFn, seed: u64) u32 {
    var prng = std.Random.DefaultPrng.init(seed);
    const r = prng.random();
    var a: [MAXLEN]u32 = undefined;
    var b: [MAXLEN]u32 = undefined;
    var cov: [MAXLEN]u8 = undefined;
    var worst: u32 = 0;
    var it: usize = 0;
    while (it < ROWS) : (it += 1) {
        const len = 1 + r.uintLessThan(usize, MAXLEN);
        const src = (r.int(u32) & 0x00FFFFFF) | (@as(u32, pick(r, it)) << 24);
        fillDst(r, a[0..len], it % 4);
        @memcpy(b[0..len], a[0..len]);
        const cov_sel = (it / 6) % 6;
        for (cov[0..len]) |*c| c.* = pick(r, cov_sel);
        g(a[0..len], src, cov[0..len]);
        v(b[0..len], src, cov[0..len]);
        worst = @max(worst, maxChannelDelta(a[0..len], b[0..len]));
    }
    return worst;
}

/// Row kernels: a third of the rows unmasked, a third with a mask of the
/// `pick` values (zeros and 255s included), a third fully random.
fn worstRow(comptime g: RowFn, comptime v: RowFn, seed: u64) u32 {
    var prng = std.Random.DefaultPrng.init(seed);
    const r = prng.random();
    var a: [MAXLEN]u32 = undefined;
    var b: [MAXLEN]u32 = undefined;
    var src: [MAXLEN]u32 = undefined;
    var mask: [MAXLEN]u8 = undefined;
    var worst: u32 = 0;
    var it: usize = 0;
    while (it < ROWS) : (it += 1) {
        const len = 1 + r.uintLessThan(usize, MAXLEN);
        fillSrc(r, src[0..len], it);
        fillDst(r, a[0..len], it % 4);
        @memcpy(b[0..len], a[0..len]);
        const m: ?[]const u8 = switch (it % 3) {
            0 => null,
            1 => blk: {
                for (mask[0..len], 0..) |*c, i| c.* = pick(r, (it / 3) + i);
                break :blk mask[0..len];
            },
            else => blk: {
                for (mask[0..len]) |*c| c.* = r.int(u8);
                break :blk mask[0..len];
            },
        };
        g(a[0..len], src[0..len], m);
        v(b[0..len], src[0..len], m);
        worst = @max(worst, maxChannelDelta(a[0..len], b[0..len]));
    }
    return worst;
}

test "vec_blend == generic within 1 LSB: separable family, flash_subtract, add, src_over row" {
    const sep = .{ "Multiply", "Screen", "Darken", "Lighten", "Difference", "Exclusion", "HardLight", "Overlay", "FlashSubtract" };
    var failed = false;
    std.debug.print("\ntolerance (max LSB): kernel  full  cov  row\n", .{});
    inline for (sep, 0..) |n, k| {
        const wf = worstFull(@field(generic, "blend" ++ n ++ "U32"), @field(vec, "blend" ++ n ++ "U32"), 0x5e_0000 + k);
        const wc = worstCov(@field(generic, "blend" ++ n ++ "CovU32"), @field(vec, "blend" ++ n ++ "CovU32"), 0x5e_1000 + k);
        const wr = worstRow(@field(generic, "blend" ++ n ++ "RowU32"), @field(vec, "blend" ++ n ++ "RowU32"), 0x5e_2000 + k);
        std.debug.print("  {s:<14} {d}     {d}    {d}\n", .{ n, wf, wc, wr });
        if (wf > 1 or wc > 1 or wr > 1) failed = true;
    }
    const add_c = worstCov(generic.blendAddCovU32, vec.blendAddCovU32, 0x5e_3000);
    const add_r = worstRow(generic.blendAddRowU32, vec.blendAddRowU32, 0x5e_3001);
    const so_r = worstRow(generic.blendSrcOverRowU32, vec.blendSrcOverRowU32, 0x5e_3002);
    std.debug.print("  {s:<14} -     {d}    {d}\n", .{ "Add", add_c, add_r });
    std.debug.print("  {s:<14} -     -    {d}\n", .{ "SrcOver", so_r });
    if (add_c > 1 or add_r > 1 or so_r > 1) failed = true;
    try std.testing.expect(!failed);
}

test "row kernels keep masked-out pixels byte for byte" {
    var prng = std.Random.DefaultPrng.init(0x0f0f);
    const r = prng.random();
    const names = .{ "SrcOver", "Multiply", "Screen", "Darken", "Lighten", "Difference", "Exclusion", "HardLight", "Overlay", "FlashSubtract", "Add" };
    inline for (names) |n| {
        var dst: [MAXLEN]u32 = undefined;
        var src: [MAXLEN]u32 = undefined;
        var mask: [MAXLEN]u8 = undefined;
        fillDst(r, &dst, 2);
        fillSrc(r, &src, 5);
        for (&mask, 0..) |*m, i| m.* = if (i % 2 == 0) 0 else r.int(u8);
        const before = dst;
        @field(vec, "blend" ++ n ++ "RowU32")(&dst, &src, &mask);
        for (0..MAXLEN) |i| {
            if (mask[i] == 0) try std.testing.expectEqual(before[i], dst[i]);
        }
    }
}
