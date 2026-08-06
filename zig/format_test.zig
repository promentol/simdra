//! Canvas-level surface color-type tests (`npm run test:format`).
//!
//! Runs with `-lc -I . simdra/utils/stb_image.c simdra/utils/stb_truetype.c`
//! (SmCanvas transitively pulls the stb C sources) — same invocation shape
//! as leak_test.zig. Pure-kernel color-type tests live in
//! simdra/core/SmBlitter.zig and run C-free via `npm run test:zig`.

const std = @import("std");
const simdra = @import("simdra.zig");
const simd = @import("simdra/opts/simd.zig");

const SmSurface = simdra.SmSurface;

fn drawScene(surface: *SmSurface) !void {
    const ctx = try surface.getCanvas();
    ctx.setFillStyle(200, 100, 50, 255);
    ctx.fillRect(0, 0, 8, 4);
    ctx.setFillStyle(20, 220, 130, 128);
    ctx.fillRect(2, 1, 4, 2);
    ctx.beginPath();
    ctx.moveTo(1, 1);
    ctx.lineTo(7, 1);
    ctx.lineTo(4, 3);
    ctx.closePath();
    ctx.setFillStyle(10, 30, 250, 200);
    ctx.fill(.nonzero);
}

test "bgra surface pixels are the R/B swap of the rgba surface" {
    const ta = std.testing.allocator;
    var s_rgba = try SmSurface.init(ta, 8, 4);
    defer s_rgba.deinit();
    var s_bgra = try SmSurface.initWithColorType(ta, 8, 4, .bgra8888);
    defer s_bgra.deinit();

    try drawScene(&s_rgba);
    try drawScene(&s_bgra);

    for (s_rgba.pixels, s_bgra.pixels) |a, b| {
        try std.testing.expectEqual(simd.swizzleRB(a), b);
    }
}

test "getImageData from a bgra surface returns RGBA bytes (WHATWG)" {
    const ta = std.testing.allocator;
    var s_rgba = try SmSurface.init(ta, 8, 4);
    defer s_rgba.deinit();
    var s_bgra = try SmSurface.initWithColorType(ta, 8, 4, .bgra8888);
    defer s_bgra.deinit();
    try drawScene(&s_rgba);
    try drawScene(&s_bgra);

    const bmp_r = try (try s_rgba.getCanvas()).getImageData(0, 0, 8, 4);
    defer ta.free(bmp_r.data);
    const bmp_b = try (try s_bgra.getCanvas()).getImageData(0, 0, 8, 4);
    defer ta.free(bmp_b.data);
    try std.testing.expectEqualSlices(u8, bmp_r.data, bmp_b.data);
}

test "putImageData writes RGBA into a bgra surface correctly" {
    const ta = std.testing.allocator;
    var s = try SmSurface.initWithColorType(ta, 4, 1, .bgra8888);
    defer s.deinit();
    const ctx = try s.getCanvas();

    // RGBA bitmap bytes: one orange pixel row.
    var bmp_data = [16]u8{
        255, 165, 0, 255, 255, 165, 0, 255,
        255, 165, 0, 255, 255, 165, 0, 255,
    };
    const bmp: simdra.SmBitmap = .{
        .data = &bmp_data,
        .width = 4,
        .height = 1,
        .colorSpace = .srgb,
        .pixelFormat = .rgba_unorm8,
    };
    ctx.writePixels(bmp, 0, 0);
    // Surface stores BGRA: bytes B,G,R,A = 0,165,255,255 → u32 LE.
    for (s.pixels) |p| {
        try std.testing.expectEqual(@as(u32, 0 | (165 << 8) | (255 << 16) | (255 << 24)), p);
    }
    // And reading back through getImageData restores RGBA bytes.
    const back = try ctx.getImageData(0, 0, 4, 1);
    defer ta.free(back.data);
    try std.testing.expectEqualSlices(u8, &bmp_data, back.data);
}

test "encodePng of a bgra surface equals the rgba surface's encoding" {
    const ta = std.testing.allocator;
    var s_rgba = try SmSurface.init(ta, 8, 4);
    defer s_rgba.deinit();
    var s_bgra = try SmSurface.initWithColorType(ta, 8, 4, .bgra8888);
    defer s_bgra.deinit();
    try drawScene(&s_rgba);
    try drawScene(&s_bgra);

    const png_r = try s_rgba.encodePng();
    const png_b = try s_bgra.encodePng();
    try std.testing.expectEqualSlices(u8, png_r, png_b);
}
