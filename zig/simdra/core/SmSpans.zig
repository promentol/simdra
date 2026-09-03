//! SmSpans — the scan converter's output for one path, kept apart from
//! any canvas: a list of coverage runs (row, start, length, bytes) that
//! `replay` blends through `SmBlitter.blitRow` at an integer offset with
//! whatever paint and clip the canvas has at that moment.
//!
//! The runs are built in SHAPE space — the path with its translation
//! reduced to the fractional part — so one build serves every position
//! that differs by whole pixels: the same shape drawn a frame later, two
//! pixels to the right, replays instead of flattening, sorting and
//! sweeping again. Interior stretches of full coverage are stored as
//! `SOLID` runs without bytes, so a large simple shape costs a few
//! entries per row rather than its area.
//!
//! Byte-exactness: a replayed run reaches `blitRow` with the same bytes
//! the direct sweep would have handed it, and a solid run carries a row
//! of 255s, so the blended pixels are those of a direct `fillPath` up to
//! the floating-point drift of shifting the geometry by whole pixels
//! (which the f32 deposit absorbs in practice; handyflash's
//! `--verify-render` compares every frame of its corpus both ways).

const std = @import("std");
const SmList = @import("../utils/SmList.zig").SmList;
const SmBlitter = @import("SmBlitter.zig");
const SmPaint = @import("SmPaint.zig");

const SmSpans = @This();

/// `Run.cov` value of a run whose coverage is 255 throughout.
pub const SOLID: u32 = std.math.maxInt(u32);
/// Shortest stretch of 255s split out as a `SOLID` run: shorter ones
/// stay inline, where a byte per pixel is cheaper than a run entry.
pub const SOLID_MIN: usize = 16;

pub const Run = struct {
    x: i32,
    y: i32,
    len: u32,
    /// Offset into `bytes`, or `SOLID`.
    cov: u32,
};

runs: SmList(Run) = .{},
bytes: SmList(u8) = .{},
/// Longest run, so a replay can size its row of 255s once.
max_run: u32 = 0,
/// Box of every run, shape space (x1/y1 exclusive).
x0: i32 = std.math.maxInt(i32),
y0: i32 = std.math.maxInt(i32),
x1: i32 = std.math.minInt(i32),
y1: i32 = std.math.minInt(i32),
/// An append failed while building; the spans are incomplete.
oom: bool = false,

pub fn deinit(self: *SmSpans, allocator: std.mem.Allocator) void {
    self.runs.deinit(allocator);
    self.bytes.deinit(allocator);
    self.* = .{};
}

pub fn isEmpty(self: *const SmSpans) bool {
    return self.runs.len == 0;
}

/// Heap bytes held, for a cache budget.
pub fn byteSize(self: *const SmSpans) usize {
    return self.runs.cap * @sizeOf(Run) + self.bytes.cap;
}

/// Append one emitted run, splitting stretches of full coverage of at
/// least `SOLID_MIN` pixels into `SOLID` runs.
pub fn addRun(self: *SmSpans, allocator: std.mem.Allocator, x: i32, y: i32, cov: []const u8) void {
    if (cov.len == 0) return;
    var i: usize = 0;
    while (i < cov.len) {
        // Partial stretch: up to the next long solid stretch.
        var j = i;
        while (j < cov.len) {
            if (cov[j] == 255) {
                var k = j;
                while (k < cov.len and cov[k] == 255) k += 1;
                if (k - j >= SOLID_MIN) break;
                j = k;
            } else {
                j += 1;
            }
        }
        if (j > i) self.push(allocator, x + @as(i32, @intCast(i)), y, cov[i..j]);
        i = j;
        if (i >= cov.len) break;
        // Solid stretch.
        var k = i;
        while (k < cov.len and cov[k] == 255) k += 1;
        self.pushSolid(allocator, x + @as(i32, @intCast(i)), y, @intCast(k - i));
        i = k;
    }
}

fn push(self: *SmSpans, allocator: std.mem.Allocator, x: i32, y: i32, cov: []const u8) void {
    const off: u32 = @intCast(self.bytes.len);
    self.bytes.appendSlice(allocator, cov) catch {
        self.oom = true;
        return;
    };
    self.runs.append(allocator, .{ .x = x, .y = y, .len = @intCast(cov.len), .cov = off }) catch {
        self.oom = true;
        return;
    };
    self.noteRun(x, y, @intCast(cov.len));
}

fn pushSolid(self: *SmSpans, allocator: std.mem.Allocator, x: i32, y: i32, len: u32) void {
    self.runs.append(allocator, .{ .x = x, .y = y, .len = len, .cov = SOLID }) catch {
        self.oom = true;
        return;
    };
    self.noteRun(x, y, len);
}

fn noteRun(self: *SmSpans, x: i32, y: i32, len: u32) void {
    self.max_run = @max(self.max_run, len);
    self.x0 = @min(self.x0, x);
    self.x1 = @max(self.x1, x + @as(i32, @intCast(len)));
    self.y0 = @min(self.y0, y);
    self.y1 = @max(self.y1, y + 1);
}

/// Blend every run into `pixels` (a `dst_w` × `dst_h` surface), shifted
/// by (`dx`, `dy`), through `blitRow` with `paint` under `clip`.
/// `solid_row` is at least `max_run` bytes of 255 (a solid run is blended
/// with the same coverage kernel as an inline one, so the bytes match a
/// direct sweep exactly).
pub fn replay(
    self: *const SmSpans,
    pixels: []u32,
    dst_w: u32,
    dst_h: u32,
    dx: i32,
    dy: i32,
    paint: *const SmPaint,
    clip: ?SmBlitter.Clip,
    solid_row: []const u8,
) void {
    if (self.runs.len == 0) return;
    std.debug.assert(solid_row.len >= self.max_run);
    // Every run is trimmed to the surface by the clip box: the blitter
    // never bounds-checks a run on its own.
    var c: SmBlitter.Clip = if (clip) |k| k else .{ .mask = null, .x0 = 0, .y0 = 0, .x1 = @intCast(dst_w), .y1 = @intCast(dst_h) };
    c.x0 = @max(c.x0, 0);
    c.y0 = @max(c.y0, 0);
    c.x1 = @min(c.x1, @as(i32, @intCast(dst_w)));
    c.y1 = @min(c.y1, @as(i32, @intCast(dst_h)));
    if (c.isEmpty()) return;
    // The whole box misses the clip: nothing to walk.
    if (self.x1 + dx <= c.x0 or self.x0 + dx >= c.x1 or self.y1 + dy <= c.y0 or self.y0 + dy >= c.y1) return;
    const bytes = self.bytes.ptr[0..self.bytes.len];
    for (self.runs.ptr[0..self.runs.len]) |r| {
        const y = r.y + dy;
        if (y < c.y0 or y >= c.y1) continue;
        const x = r.x + dx;
        if (x >= c.x1 or x + @as(i32, @intCast(r.len)) <= c.x0) continue;
        const cov: []const u8 = if (r.cov == SOLID) solid_row[0..r.len] else bytes[r.cov..][0..r.len];
        SmBlitter.blitRow(pixels, dst_w, x, y, r.len, cov, paint, c);
    }
}

test "addRun splits long solid stretches and keeps short ones inline" {
    const a = std.testing.allocator;
    var s: SmSpans = .{};
    defer s.deinit(a);
    var cov: [64]u8 = undefined;
    @memset(&cov, 255);
    cov[0] = 10;
    cov[1] = 200;
    cov[40] = 128; // splits the solid stretch: 38 solids, one partial, 23 solids
    cov[63] = 3;
    s.addRun(a, 5, 7, &cov);
    // partial [0..2), solid [2..40), partial [40..41), solid [41..63), partial [63..64)
    try std.testing.expectEqual(@as(usize, 5), s.runs.len);
    const r = s.runs.ptr[0..s.runs.len];
    try std.testing.expectEqual(@as(i32, 5), r[0].x);
    try std.testing.expectEqual(@as(u32, 2), r[0].len);
    try std.testing.expectEqual(SOLID, r[1].cov);
    try std.testing.expectEqual(@as(i32, 7), r[1].x);
    try std.testing.expectEqual(@as(u32, 38), r[1].len);
    try std.testing.expectEqual(@as(u32, 1), r[2].len);
    try std.testing.expectEqual(SOLID, r[3].cov);
    try std.testing.expectEqual(@as(u32, 22), r[3].len);
    try std.testing.expectEqual(@as(u32, 1), r[4].len);
    try std.testing.expectEqual(@as(u32, 38), s.max_run);
    try std.testing.expectEqual(@as(i32, 5), s.x0);
    try std.testing.expectEqual(@as(i32, 69), s.x1);
    // A short solid stretch stays inline.
    var s2: SmSpans = .{};
    defer s2.deinit(a);
    var short: [14]u8 = undefined;
    @memset(&short, 255);
    short[0] = 1;
    short[13] = 1;
    s2.addRun(a, 0, 0, &short);
    try std.testing.expectEqual(@as(usize, 1), s2.runs.len);
    try std.testing.expectEqual(@as(usize, 14), s2.bytes.len);
}
