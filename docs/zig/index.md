---
title: Zig core
description: Architecture of the simdra Zig core — Skia-style class taxonomy, Scan→Blitter pipeline, SIMD backends.
---

# Zig core

A Skia-shaped 2D drawing library (`SmCanvas` / `SmPaint` / `SmPath` / `SmBitmap`) written in Zig, vectorised through `@Vector`, exposed to JavaScript via [node-zigar](https://github.com/chung-leong/node-zigar) — both as a Node.js native addon and as a single WASM bundle. Single source, two consumers.

The "Canvas 2D" and "MicroSharp" bindings you see in the [API docs](/canvas/) are JS surfaces over the same set of `Sm*` primitives. This page describes the Zig layer itself — useful if you want to understand how the library works, embed simdra from Zig directly ([API](./api)), or contribute ([Contributing](./contributing)).

## Why it might interest you

- **Real-world `@Vector` workout.** The codebase is a tour of Zig's portable SIMD primitives applied across a non-trivial pipeline: `@Vector(N, u8)` byte ops, `@Vector(4, f32)` per-pixel FMA chains, `@select` for branchless masking, `@reduce(.Add, ...)` for dot-products, `@splat` for kernel-weight broadcast. Same source compiles to NEON on aarch64, SSE on x86, WASM-SIMD in browsers.
- **Skia-style class taxonomy without OOP.** File-is-struct pattern. Each file is the type. `pub fn` instance methods on `*Self`, `pub fn` static factories without `self`. No traits, no inheritance, just composition through `@import`.
- **Comptime SIMD backend dispatch.** `opts/simd.zig` is a thin comptime facade that picks `opts/neon.zig` on aarch64 and `opts/generic.zig` everywhere else (WASM, x86 baseline). Same shape as Skia's `SkOpts`. Per-arch backends export the same kernel signatures; arch tuning happens by replacing kernels in the matching backend file.
- **Two consumers, one library.** Same `zig/simdra.zig` entry point is consumed by node-zigar (native Node.js addon, fast iteration via `--loader=node-zigar`) AND by rollup-plugin-zigar (WASM bundle for Workers / browsers). No `if (target == .wasi)` shims in the source — comptime gating where it's needed (`builtin.cpu.arch.isWasm()`), identical Zig everywhere else.

Sharp's image-operations API (~22 ops across geometric, convolution, morphology, tone, histogram, HSV) is implemented from spec; divergences are tracked in [`COMPATIBILITY.md`](https://github.com/narekh/simdra/blob/main/COMPATIBILITY.md). If you want a worked example of "build a real library against a published spec," the commit history is the artefact.

## Two-layer design

```
┌──────────────────────────────────────────────────────────┐
│  src/index.ts            src/image/index.ts              │
│  Canvas / Path2D / ...    image() / .resize() / ...      │
│       ↓ private ZIG handle              ↓                │
└──────────────────────────────────────────────────────────┘
                         ↓
┌──────────────────────────────────────────────────────────┐
│  zig/simdra/                                             │
│  Sm-prefixed primitives (Skia-style)                     │
│   core/      SmCanvas, SmSurface, SmPaint, SmBitmap,     │
│              SmPath, SmMatrix, SmFont, SmScan,           │
│              SmBlitter                                    │
│   effects/   SmGradient                                   │
│   encode/    encoder.zig (PNG via stb or native, JPEG)   │
│   decode/    stb.zig (PNG/JPEG/BMP/GIF first frame)      │
│   opts/      SIMD kernels (NEON / @Vector(N) generic)    │
│   utils/     SmList, css_color, stb_truetype, stb_image  │
└──────────────────────────────────────────────────────────┘
```

The Zig layer is **HTML5-free**: no `CanvasRenderingContext2D`, no `Path2D`, no CSS strings. Class names follow Skia's `Sk*` taxonomy with an `Sm*` prefix — `SmSurface ≡ SkSurface`, `SmCanvas ≡ SkCanvas`, `SmPaint ≡ SkPaint`, etc. Method names use HTML5-shaped verbs (`fillRect`, `lineTo`) where they happen to match — but they take numeric args, not CSS.

The TypeScript layer in `src/index.ts` exposes both surfaces from the same package root — **strict HTML5** Canvas2D classes (`Canvas`, `CanvasRenderingContext2D`, `Path2D`, `DOMMatrix`, …) and the **strict sharp-shaped** `microsharp` factory. Internal handles to Sm* proxies are gated behind a module-private `Symbol` — consumers never see them.

## Drawing pipeline: Scan → Blitter

simdra is a **pure SIMD CPU rasterizer**. There is no GPU backend.

Every drawing call follows a Skia-style three-stage pipeline:

1. **Shape → coverage rows** (`SmScan`). Rectangles, triangles, paths all reduce to a sequence of *coverage rows*: `(y, x_start, x_end, optional_alpha_array)`.
2. **Coverage row → pixels** (`SmBlitter.blitRow`). One `blitRow` API handles all combinations of paint kind × blend mode × coverage. Today coverage is null (full ink); AA path rasterization slots in by passing a non-null coverage array — no new code path.
3. **Pixel writes** (`opts/`). SIMD kernels — NEON-tuned on aarch64, `@Vector(N)` generic everywhere else (including WASM, x86).

This means there is **no display list, no command queue, no flush.** `ctx.fillRect(...)` writes pixels into the surface buffer *during* the call. `getImageData(...)` reads the latest pixels.

`canvas.toBytes()` doesn't replay anything — it just encodes the bitmap that's already in memory.

## File-is-struct module layout

Every Zig "class" is one file using `const SmFoo = @This();`:

```zig
// zig/simdra/core/SmBitmap.zig
const std = @import("std");
const SmBitmap = @This();

data: []u8,
width: u32,
height: u32,
// ...

pub fn createBlank(width: u32, height: u32, ...) !SmBitmap { ... }
pub fn release(bitmap: SmBitmap) void { ... }
```

The file path becomes the type name in JS via [node-zigar](https://github.com/chung-leong/node-zigar).

## Memory ownership

Sm* types own page-allocator buffers. Releases happen via:

- **JS GC** — every wrapper class registers with a `FinalizationRegistry`. When the JS object is unreachable, the matching Zig buffer is freed. Consumers don't call `.deinit()`.
- **Explicit cache** — `SmSurface.last_encoded` holds the most recent PNG/JPEG bytes; freed on the next encode and on `deinit()`.
- **Pure-Zig callers** use the `releaseWithAllocator(allocator, value)` variants that skip the page_allocator default.

`std.mem.Allocator` is heap-stored and exposed to zigar as `*anyopaque` — its vtable function pointers don't survive zigar's WASM type scanner. `getAllocator()` casts back at every call site.

## SIMD backends

`opts/simd.zig` is a comptime facade. Per-arch backends:

- `opts/neon.zig` — aarch64-tuned (Apple Silicon, Linux ARM, Cloudflare Workers' aarch64 nodes).
- `opts/generic.zig` — portable `@Vector(N)` baseline. Used on x86 today and on **WASM** (where only `v128` SIMD is available, no NEON).

Each backend exports the same kernel signatures (`fillU32`, `copyU32`, `copyU32ToFloat16Norm`, …). Hardware-only operations (e.g., the `@Vector(N, f16)` cast that wasm32-wasi rejects) belong only in the arch backend that supports them — generic stays the byte-equal correctness reference.

## Encoders / decoders

PNG and JPEG go through stb_image / stb_image_write:

- `encode/encoder.zig` is a comptime facade with a `png_backend` flag (`.stb` default, `.native` fallback). Both encoder bodies stay in tree.
- `encode/jpeg.zig` is stb-only; no native fallback.
- `decode/stb.zig` wraps `stbi_load_from_memory` with `STBI_rgb_alpha` (forces 4-channel output). Auto-detects PNG / JPEG / BMP / GIF (first frame).
- HDR / PSD / PIC / PNM / TGA decoders are stripped at the C-build layer in `utils/stb_image.c` (saves ~22 KB compiled).

The C glue links libc (`useLibc: true` in node-zigar.config.json and vite.config.js) — same path stb_truetype already takes.

## Acyclic module graph

Direction of dependency is enforced by convention:

```
opts/            ← leaves (per-arch SIMD kernels)
utils/           ← leaves + types from core/
encode/, decode/ ← leaves (single direction; no upward imports)
effects/         ← core/ + utils/
core/            ← opts/, encode/, decode/  (e.g., SmSurface → encoder.zig,
                                                 SmBitmap  → decode/stb.zig)
```

`core/raster.zig` is the only file that may import `opts/simd.zig`. Drawing primitives in `raster.zig` take raw pixel slices + dimensions, not Sm* references — so they never need to import upward.

## Two bindings, one core

The TypeScript surfaces are **independent** — neither imports the other's wrappers — but both call the same Zig types:

| Sm* primitive | Canvas2D usage | `microsharp` usage |
|---|---|---|
| `SmBitmap.decode(bytes)` | `Image.fromBytes` | `microsharp(bytes).toBuffer()` |
| `bitmap.encodePng()` | `canvas.toBytes()` | `microsharp(buf).png().toBuffer()` |
| `bitmap.encodeJpeg(q)` | `canvas.toBytes('image/jpeg', q)` | `microsharp(buf).jpeg(q).toBuffer()` |
| `SmCanvas.drawImageAt(...)` | `ctx.drawImage(img, x, y)` | (not used yet) |

Adding a third binding (e.g., a node-canvas drop-in compat shim) is purely a TS-layer task — the Zig core needs no changes.
