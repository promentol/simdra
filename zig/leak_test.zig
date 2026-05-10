//! Leak-check test for the A2 allocator threading. Runs the public draw
//! stack under `std.testing.allocator` — the testing GPA's leak checker
//! (`std.heap.GeneralPurposeAllocator` with `safety = true`) panics at
//! deinit if any byte allocated through it is unfreed.
//!
//! Validates that every alloc reachable from `SmSurface.init(allocator, ...)`
//! actually flows through the passed-in allocator, not the module-scope
//! `std.heap.page_allocator` we used pre-A2.
//!
//! Coverage: surface / canvas / path / state stack / scratch composite
//! buffer / gradient / image-data bitmap. Skips SmFont (text rendering
//! pulls in stb_truetype C interop; the JS test suite's text scenes
//! already exercise it under page_alloc).
//!
//! Run via `npm run test:leak` (which sets `-lc -I zig` for the C deps
//! transitively pulled in by SmCanvas's SmFont import).

const std = @import("std");
const SmSurface = @import("simdra/core/SmSurface.zig");
const SmPath = @import("simdra/core/SmPath.zig");
const SmGradient = @import("simdra/effects/SmGradient.zig");
const SmBitmap = @import("simdra/core/SmBitmap.zig");

test "SmSurface basic draw stack — no leaks" {
    const a = std.testing.allocator;

    var surface = try SmSurface.init(a, 32, 32);
    defer surface.deinit();

    const ctx = try surface.getCanvas();

    ctx.setFillStyle(0xFF, 0x00, 0x00, 0xFF);
    ctx.fillRect(0, 0, 16, 16);

    ctx.setFillStyle(0x00, 0xFF, 0x00, 0xFF);
    ctx.beginPath();
    ctx.moveTo(20, 4);
    ctx.lineTo(28, 4);
    ctx.lineTo(28, 28);
    ctx.lineTo(20, 28);
    ctx.closePath();
    ctx.fill();

    ctx.setStrokeStyle(0x00, 0x00, 0xFF, 0xFF);
    ctx.setLineWidth(2);
    ctx.beginPath();
    ctx.moveTo(2, 28);
    ctx.lineTo(28, 28);
    ctx.stroke();
}

test "SmSurface save / restore — state stack frees" {
    const a = std.testing.allocator;

    var surface = try SmSurface.init(a, 16, 16);
    defer surface.deinit();

    const ctx = try surface.getCanvas();
    ctx.save();
    ctx.translate(4, 4);
    ctx.rotate(0.5);
    ctx.save();
    ctx.scale(2, 2);
    ctx.fillRect(0, 0, 4, 4);
    ctx.restore();
    ctx.fillRect(0, 0, 4, 4);
    ctx.restore();
}

test "SmSurface composite layer scratch — no leaks" {
    const a = std.testing.allocator;

    var surface = try SmSurface.init(a, 16, 16);
    defer surface.deinit();

    const ctx = try surface.getCanvas();
    ctx.setFillStyle(0xFF, 0xFF, 0xFF, 0xFF);
    ctx.fillRect(0, 0, 16, 16);
    // Trigger a layer-composite blend mode (uses scratch_pixels).
    ctx.blendMode = .src_in;
    ctx.setFillStyle(0xFF, 0x00, 0x00, 0xFF);
    ctx.fillRect(4, 4, 8, 8);
}

test "SmSurface getImageData — bitmap frees" {
    const a = std.testing.allocator;

    var surface = try SmSurface.init(a, 16, 16);
    defer surface.deinit();

    const ctx = try surface.getCanvas();
    ctx.setFillStyle(0x80, 0x80, 0x80, 0xFF);
    ctx.fillRect(0, 0, 16, 16);

    const bmp = try ctx.getImageData(0, 0, 16, 16);
    defer SmBitmap.releaseWithAllocator(a, bmp);
}

test "SmSurface PNG encode — last_png frees" {
    const a = std.testing.allocator;

    var surface = try SmSurface.init(a, 8, 8);
    defer surface.deinit();

    const ctx = try surface.getCanvas();
    ctx.setFillStyle(0xAA, 0xBB, 0xCC, 0xFF);
    ctx.fillRect(0, 0, 8, 8);

    _ = try surface.encodePng();
    // surface.deinit will free the cached last_png buffer.
}

test "SmPath standalone — emptyWithAllocator frees" {
    const a = std.testing.allocator;

    var path = SmPath.emptyWithAllocator(a);
    defer path.deinit();

    path.moveTo(0, 0);
    path.lineTo(10, 0);
    path.lineTo(10, 10);
    path.lineTo(0, 10);
    path.closePath();
}

test "SmGradient standalone — linearWithAllocator + addColorStop frees" {
    const a = std.testing.allocator;

    var grad = SmGradient.linearWithAllocator(a, 0, 0, 100, 100);
    defer grad.deinit();

    try grad.addColorStop(0.0, "red");
    try grad.addColorStop(0.5, "green");
    try grad.addColorStop(1.0, "blue");
}

test "SmBitmap standalone — createBlankWithAllocator + release frees" {
    const a = std.testing.allocator;

    const bmp = try SmBitmap.createBlankWithAllocator(a, 16, 16, .{});
    SmBitmap.releaseWithAllocator(a, bmp);
}
