//! simdra public entry point — pure-Zig drawing library surface.
//! Re-exports the core types using the Skia-style Sm* prefix: SmSurface
//! (pixel buffer owner), SmCanvas (drawing primitives — Skia's `SkCanvas`),
//! SmBitmap, SmPath, SmMatrix, SmGradient, SmPaint. Construction lives as
//! static factory methods on each type itself (Skia-style — `SmSurface.init`,
//! `SmBitmap.createBlank`, `SmMatrix.identity`, `SmPath.empty`,
//! `SmGradient.linear`, etc.) — node-zigar binds them as static methods on
//! the JS proxy class because the first parameter is not `*Self`.
//!
//! Naming note: the Zig `SmCanvas` here is Skia's `SkCanvas` — the drawing
//! API. The HTML5 `Canvas` class (HTMLCanvasElement-shaped, exposing
//! `getContext('2d')` / `toDataURL()`) lives JS-side in `src/index.ts` and
//! wraps `SmSurface`.
//!
//! The HTML5 façade (`Canvas`, `CanvasRenderingContext2D`, `new ImageData`,
//! `new DOMMatrix`, `new Path2D`, `getContext('2d')`, `toDataURL`) lives
//! JS-side in `src/index.ts` and dispatches to these Sm* static factories.

pub const SmSurface = @import("simdra/core/SmSurface.zig");
pub const SmCanvas = @import("simdra/core/SmCanvas.zig");
pub const SmBitmap = @import("simdra/core/SmBitmap.zig");
pub const SmMatrix = @import("simdra/core/SmMatrix.zig");
pub const SmPath = @import("simdra/core/SmPath.zig");
pub const SmPaint = @import("simdra/core/SmPaint.zig");
pub const SmGradient = @import("simdra/effects/SmGradient.zig");
pub const SmPattern = @import("simdra/effects/SmPattern.zig");

const types = @import("simdra/core/types.zig");
pub const ColorSpace = types.ColorSpace;
pub const PixelFormat = types.PixelFormat;
pub const BitmapSettings = types.BitmapSettings;

/// parseCssColor(s) — packed u32 (R:0-7, G:8-15, B:16-23, A:24-31), or null.
pub const parseCssColor = @import("simdra/utils/css_color.zig").parse;

pub const SmFont = @import("simdra/core/SmFont.zig");

// ---------------------------------------------------------------------------
// Default font — Manrope variable (~162 KB) embedded via @embedFile. Backs
// the "sans-serif" / "serif" / "monospace" family aliases until users
// register their own (top-level `registerFont` or the `fonts` option on
// `createCanvas`). The TTF is a Google Fonts variable build; stb_truetype
// reads its master/default instance (wght=400 / Regular). SIL Open Font
// License 1.1: see `simdra/assets/LICENSE-Manrope.txt`.
// ---------------------------------------------------------------------------

const default_font_bytes: []const u8 = @embedFile("simdra/assets/Manrope-Regular.ttf");

/// defaultFontBytes() — read-only slice into the embedded default font.
/// JS reads via `.dataView` to wrap as a typed array without copying.
pub fn defaultFontBytes() []const u8 {
    return default_font_bytes;
}

// ---------------------------------------------------------------------------
// Async encoding — comptime-gated to non-WASM targets.
//
// Mirrors napi-rs's `Canvas.encode(format)` and node-canvas's async
// `toBuffer(cb, mime)`: encodes off-thread so request handlers don't block.
// Uses zigar's `WorkQueue.promisify`, which on native Node spawns real
// pthreads — equivalent to N-API `AsyncWorker` / napi-rs `AsyncTask`.
//
// WASM consumers (browsers, Cloudflare Workers, edge runtimes) fall back to
// `Promise.resolve(syncImpl())` in `src/index.ts toBytesAsync` — Cloudflare
// Workers can't spawn worker threads anyway, and we keep the WorkQueue +
// `worker-support-compat` plumbing out of the WASM bundle entirely.
//
// Memory ownership: the async path can't reuse SmSurface's `last_encoded`
// slot because the worker thread returns control to the JS event loop
// before JS has copied the bytes — a second async encode would free the
// first encode's buffer mid-resolution. We instead append every result
// to a global ring of `pending_async_bufs` (cap 32) and free the oldest
// on overflow. With cap 32 and the typical await-then-encode pattern, the
// oldest entry is "32 encodes ago" — long since copied by JS into a
// `Uint8Array` (the `zigBytesToU8` defensive copy in `src/index.ts`).
// ---------------------------------------------------------------------------

const builtin = @import("builtin");

const enable_async_encoding = !builtin.cpu.arch.isWasm();

const _async_encoding = if (enable_async_encoding) struct {
    const std = @import("std");
    const zigar = @import("zigar");
    const encoder = @import("simdra/encode/encoder.zig");

    const PENDING_CAP: usize = 32;
    var pending_async_bufs = std.ArrayListUnmanaged([]u8){};
    var pending_mutex = std.Thread.Mutex{};

    fn trackOrFree(buf: []u8) !void {
        pending_mutex.lock();
        defer pending_mutex.unlock();
        if (pending_async_bufs.items.len >= PENDING_CAP) {
            const oldest = pending_async_bufs.orderedRemove(0);
            std.heap.page_allocator.free(oldest);
        }
        try pending_async_bufs.append(std.heap.page_allocator, buf);
    }

    pub const work_ns = struct {
        pub fn doEncodePng(surface: *SmSurface) ![]const u8 {
            const allocator = std.heap.page_allocator;
            if (surface.width == 0 or surface.height == 0) {
                const empty = try allocator.alloc(u8, 0);
                try trackOrFree(empty);
                return empty;
            }
            const rgba: []const u8 = std.mem.sliceAsBytes(surface.pixels);
            const bytes = try encoder.encodePng(allocator, rgba, surface.width, surface.height);
            errdefer allocator.free(bytes);
            try trackOrFree(bytes);
            return bytes;
        }

        pub fn doEncodeJpeg(surface: *SmSurface, quality: u8) ![]const u8 {
            const allocator = std.heap.page_allocator;
            if (surface.width == 0 or surface.height == 0) {
                const empty = try allocator.alloc(u8, 0);
                try trackOrFree(empty);
                return empty;
            }
            const rgba: []const u8 = std.mem.sliceAsBytes(surface.pixels);
            const bytes = try encoder.encodeJpeg(allocator, rgba, surface.width, surface.height, quality);
            errdefer allocator.free(bytes);
            try trackOrFree(bytes);
            return bytes;
        }
    };

    pub var queue: zigar.thread.WorkQueue(work_ns) = .{};

    pub const encodePngAsync = queue.promisify(work_ns.doEncodePng);
    pub const encodeJpegAsync = queue.promisify(work_ns.doEncodeJpeg);
} else struct {};

pub const encodePngAsync = if (enable_async_encoding) _async_encoding.encodePngAsync else {};
pub const encodeJpegAsync = if (enable_async_encoding) _async_encoding.encodeJpegAsync else {};
