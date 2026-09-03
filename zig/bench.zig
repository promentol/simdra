//! `zig build bench -Doptimize=ReleaseFast` — the workloads bench/run.js
//! timed through the JS facade, now timed in Zig so the numbers survive
//! the JS path being parked (build.zig header).
//!
//! 800×600, five warm-ups, thirty timed runs, ms per operation:
//!   solid     fillRect over the whole canvas (the blitter, no coverage)
//!   path      one antialiased cubic blob covering most of the canvas
//!             (the scan converter + coverage blend)
//!   linear    full-canvas linear gradient, three stops (per-pixel shader)
//!   radial    full-canvas radial gradient (adds the per-pixel sqrt)
//!   pattern   full-canvas 16 px tile pattern (inverse transform + texel)
//!
//! Results are recorded by hand in bench/RESULTS.md with the machine and
//! commit; the historical JS numbers (simdra 7.1 ms vs Skia 1.4 ms for the
//! linear fill on an M3 Pro) are kept there for scale.

const std = @import("std");
const simdra = @import("simdra.zig");

const W: u32 = 800;
const H: u32 = 600;
const WARMUP = 5;
const RUNS = 30;

const Timer = struct {
    io: std.Io,
    fn now(self: Timer) std.Io.Clock.Timestamp {
        return std.Io.Clock.Timestamp.now(self.io, .awake);
    }
    fn ms(a: std.Io.Clock.Timestamp, b: std.Io.Clock.Timestamp) f64 {
        const ns: f64 = @floatFromInt(a.durationTo(b).raw.nanoseconds);
        return ns / 1e6;
    }
};

fn timeIt(t: Timer, comptime name: []const u8, ctx: anytype, comptime body: fn (@TypeOf(ctx)) anyerror!void, w: *std.Io.Writer) !void {
    var i: usize = 0;
    while (i < WARMUP) : (i += 1) try body(ctx);
    const t0 = t.now();
    i = 0;
    while (i < RUNS) : (i += 1) try body(ctx);
    const total = Timer.ms(t0, t.now());
    try w.print("{s:<8} {d:8.3} ms/op  ({d} runs)\n", .{ name, total / RUNS, RUNS });
}

const Scene = struct {
    canvas: *simdra.SmCanvas,
    linear: *simdra.SmGradient,
    radial: *simdra.SmGradient,
    pattern: *simdra.SmPattern,
};

fn solid(s: Scene) !void {
    s.canvas.setFillStyle(200, 100, 50, 255);
    s.canvas.fillRect(0, 0, W, H);
}

fn path(s: Scene) !void {
    s.canvas.setFillStyle(30, 60, 200, 255);
    s.canvas.beginPath();
    s.canvas.moveTo(100, 300);
    s.canvas.bezierCurveTo(100, 20, 700, 20, 700, 300);
    s.canvas.bezierCurveTo(700, 580, 100, 580, 100, 300);
    s.canvas.closePath();
    s.canvas.fill(.nonzero);
}

fn linear(s: Scene) !void {
    s.canvas.setFillGradient(s.linear);
    s.canvas.fillRect(0, 0, W, H);
}

fn radial(s: Scene) !void {
    s.canvas.setFillGradient(s.radial);
    s.canvas.fillRect(0, 0, W, H);
}

fn pattern(s: Scene) !void {
    s.canvas.setFillPattern(s.pattern);
    s.canvas.fillRect(0, 0, W, H);
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    var out_buf: [4096]u8 = undefined;
    var out_w = std.Io.File.stdout().writer(io, &out_buf);
    const out = &out_w.interface;

    var surface = try simdra.SmSurface.init(gpa, W, H);
    defer surface.deinit();
    const canvas = try surface.getCanvas();

    var lin = simdra.SmGradient.linearWithAllocator(gpa, 0, 0, W, 0);
    defer lin.deinit();
    try lin.addColorStop(0, "#ff0000");
    try lin.addColorStop(0.5, "#00ff00");
    try lin.addColorStop(1, "#0000ff");

    var rad = simdra.SmGradient.radialWithAllocator(gpa, W / 2, H / 2, 0, W / 2, H / 2, 400);
    defer rad.deinit();
    try rad.addColorStop(0, "#ffffff");
    try rad.addColorStop(1, "#000080");

    // A 16 px tile: opaque orange with an 8 px dark square in the corner.
    var tile: [16 * 16 * 4]u8 = undefined;
    for (0..16) |y| for (0..16) |x| {
        const i = (y * 16 + x) * 4;
        const dark = x < 8 and y < 8;
        tile[i + 0] = if (dark) 20 else 220;
        tile[i + 1] = if (dark) 30 else 120;
        tile[i + 2] = if (dark) 40 else 30;
        tile[i + 3] = 255;
    };
    var pat = try simdra.SmPattern.createWithAllocator(gpa, &tile, 16, 16, .repeat);
    defer pat.deinit();

    const scene: Scene = .{ .canvas = canvas, .linear = &lin, .radial = &rad, .pattern = &pat };
    const t: Timer = .{ .io = io };
    try out.print("simdra bench {d}x{d}, {s}, {s}\n", .{ W, H, @tagName(@import("builtin").mode), @tagName(@import("builtin").cpu.arch) });
    try timeIt(t, "solid", scene, solid, out);
    try timeIt(t, "path", scene, path, out);
    try timeIt(t, "linear", scene, linear, out);
    try timeIt(t, "radial", scene, radial, out);
    try timeIt(t, "pattern", scene, pattern, out);
    try out.flush();
}
