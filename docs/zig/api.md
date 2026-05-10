---
title: Using simdra from Zig
description: Direct Zig API — SmSurface, SmCanvas, SmBitmap. Skia-style file-is-struct primitives.
---

# Using simdra from Zig

If you're embedding simdra in another Zig project — a CLI tool, a server, a different host — you can skip the JS bindings entirely and call the `Sm*` primitives directly. The Zig surface is **HTML5-free** by design: no CSS strings, no `Path2D`, just numeric primitives in the Skia `SkSurface`/`SkCanvas`/`SkPaint` style.

## Module entry

`zig/simdra.zig` re-exports the public types:

```zig
const simdra = @import("simdra");

const SmSurface = simdra.SmSurface;
const SmCanvas  = simdra.SmCanvas;
const SmBitmap  = simdra.SmBitmap;
const SmPaint   = simdra.SmPaint;
const SmPath    = simdra.SmPath;
const SmMatrix  = simdra.SmMatrix;
```

## Drawing — the explicit pattern

Skia's "give me a surface, get a canvas, draw with explicit paint" model:

```zig
const std = @import("std");
const simdra = @import("simdra");

pub fn main() !void {
    // 1. Surface owns the pixel buffer.
    var surface = try simdra.SmSurface.init(std.heap.page_allocator, 400, 300);
    defer surface.deinit();

    // 2. Canvas is the drawing API bound to the surface.
    const canvas = try surface.getCanvas();

    // 3. Paint carries the drawing state (color, stroke width, blend mode).
    const fill = simdra.SmPaint.fill(0xFF03A9F4);   // ARGB or RGBA u32
    const stroke = simdra.SmPaint.stroke(0xFFFF5722, 2.0);

    // 4. Draw — explicit paint per call, Skia-style.
    canvas.drawRect(0, 0, 400, 300, &fill);

    canvas.beginPath();
    canvas.moveTo(50, 50);
    canvas.lineTo(150, 50);
    canvas.lineTo(100, 150);
    canvas.closePath();
    canvas.fill(.nonzero);

    // 5. Encode.
    const png_bytes = try surface.encodePng();
    // png_bytes is owned by the surface (last_encoded slot). Do not free.

    try std.fs.cwd().writeFile(.{ .sub_path = "out.png", .data = png_bytes });
}
```

## SmBitmap as a standalone unit

`SmBitmap` is the owning RGBA pixel buffer. Use it when you don't need a `SmCanvas` — e.g., decoding bytes, encoding bytes, copying buffers:

```zig
// Decode PNG / JPEG / BMP / GIF (first frame) → SmBitmap.
const bytes = try std.fs.cwd().readFileAlloc(allocator, "input.jpg", 10 << 20);
defer allocator.free(bytes);

var bitmap = try simdra.SmBitmap.decodeWithAllocator(allocator, bytes);
defer simdra.SmBitmap.releaseWithAllocator(allocator, bitmap);

// Inspect.
std.debug.print("{d}x{d}\n", .{ bitmap.width, bitmap.height });

// Re-encode as JPEG.
const jpeg = try bitmap.encodeJpegWithAllocator(allocator, 85);
defer allocator.free(jpeg);
```

## Allocator ownership

simdra is allocator-aware throughout. Two factory variants for every "creates a buffer" entry point:

| JS-binding default (page_allocator) | Pure-Zig explicit |
|---|---|
| `SmSurface.initDefault(w, h)` | `SmSurface.init(allocator, w, h)` |
| `SmBitmap.createBlank(w, h, settings)` | `SmBitmap.createBlankWithAllocator(allocator, ...)` |
| `SmBitmap.createFromBuffer(...)` | `SmBitmap.createFromBufferWithAllocator(...)` |
| `SmBitmap.decode(bytes)` | `SmBitmap.decodeWithAllocator(allocator, bytes)` |
| `bitmap.encodePng()` | `bitmap.encodePngWithAllocator(allocator)` |
| `bitmap.encodeJpeg(q)` | `bitmap.encodeJpegWithAllocator(allocator, q)` |

The first column exists because node-zigar can't pass an `Allocator` value across the JS boundary (the vtable function pointers don't survive type scanning). Pure-Zig callers should always use the explicit variant — it composes with arenas, GeneralPurposeAllocator, testing allocator.

`SmSurface` is the canonical allocator owner — every type reachable from a Surface (its Canvas, paths, gradients, scratch buffers) inherits the surface's allocator. `getAllocator()` recovers it from the heap-stored handle.

## Path2D-equivalent

```zig
var path = try simdra.SmPath.empty();
defer path.deinit();

path.moveTo(0, 0);
path.lineTo(100, 100);
path.bezierCurveTo(150, 0, 200, 100, 250, 50);

canvas.fillPathExternal(&path, .nonzero);
canvas.strokePathExternal(&path);
```

`SmPath` is one struct that backs both the canvas's current-path and standalone Path2D-equivalent paths. `path.copy()` clones; `path.addPathTransform(other, matrix)` glues paths under a CTM.

## Matrix arithmetic

`SmMatrix` is 2D affine, SIMD-tuned via `@Vector(2, f64)`:

```zig
var m = simdra.SmMatrix.identity();
_ = m.translateSelf(100, 50);
_ = m.rotateSelf(15.0);          // degrees
_ = m.scaleSelf(2.0, 2.0);

canvas.transform(m.a, m.b, m.c, m.d, m.e, m.f);
```

The chaining methods return `*SmMatrix` so you can chain or capture as needed.

## What's not on the Zig surface

Strict by design:

- **No CSS strings.** No `parseFillStyle("rgba(...)")` or `parseFont("16px sans-serif")`. Use `simdra.parseCssColor("...")` if you need it (it's a separate utility); the canvas API takes packed `u32` RGBA.
- **No `Image` class.** That's a JS wrapper concept. From Zig you decode bytes directly into a `SmBitmap`.
- **No `getContext('2d')`.** `surface.getCanvas()` returns the `*SmCanvas` directly.
- **No `toDataURL`.** Encode bytes via `surface.encodePng()` / `surface.encodeJpeg(quality)` — base64 is JS-shaped, not Zig-shaped.

These all live in `src/index.ts` (Canvas 2D binding) or `src/microsharp/index.ts` (MicroSharp).

## Build integration

Add simdra as a dependency in your `build.zig.zon`:

```zig
.simdra = .{
    .url = "https://github.com/promentol/simdra/archive/<commit>.tar.gz",
    .hash = "...",
},
```

Then in `build.zig`:

```zig
const simdra = b.dependency("simdra", .{ .target = target, .optimize = optimize });
exe.root_module.addImport("simdra", simdra.module("simdra"));
exe.linkLibC();   // stb_truetype + stb_image want libc for malloc/realloc/free.
```

Min Zig version: 0.15.x (matches what node-zigar 0.15.2 expects). 0.16+ support tracks node-zigar.

## See also

- [Architecture](./) — raster pipeline, Sm* taxonomy, module graph.
- [Contributing](./contributing) — adding a new SIMD kernel, adding a new spec member.
