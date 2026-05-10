---
title: Contributing
description: Build system, file conventions, and how to extend the Zig core.
---

# Contributing

The Zig core lives in `zig/simdra/`. The TypeScript bindings (`src/index.ts` plus `src/microsharp/index.ts`, both surfaced from the package root) sit on top. Most contributions land at one of these layers.

## Layout

```
zig/
├── simdra.zig                          # entry: re-exports of Sm* types + parseCssColor
└── simdra/
    ├── core/                           # Sm* drawing types + raster pipeline
    │   ├── SmSurface.zig
    │   ├── SmCanvas.zig
    │   ├── SmPaint.zig
    │   ├── SmBitmap.zig
    │   ├── SmPath.zig
    │   ├── SmMatrix.zig
    │   ├── SmFont.zig
    │   ├── SmScan.zig                  # shape → coverage rows
    │   ├── SmBlitter.zig               # coverage rows → pixels
    │   └── types.zig                   # internal enums
    ├── effects/                        # SmGradient, future filters
    ├── encode/                         # PNG / JPEG encoders
    ├── decode/                         # stb_image
    ├── opts/                           # SIMD kernels (NEON / generic)
    └── utils/                          # SmList, css_color, vendored stb headers

src/
├── index.ts                            # Canvas 2D binding
├── image/index.ts                      # MicroSharp binding
└── simdra-zig.d.ts                     # ambient types
```

## Build & test

```bash
npm test                                # native via node-zigar — fast iteration
npm run build                           # WASM bundle via vite (rollup-plugin-zigar)
npm run test:built                      # post-build smoke test
npm run typecheck                       # tsc --noEmit
```

`npm test` is the inner loop for any change to Zig or TS. Visual regressions render against `@napi-rs/canvas` with SSIM thresholds; structural assertions cover the rest.

Zig version: pin via `zvm` or similar to the version node-zigar expects (`0.15.x` today). Mismatch produces "Unsupported Zig version" at build time.

## Conventions

### File-is-struct, Sm-prefixed

One Zig "class" per file, Sm-prefixed:

```zig
// zig/simdra/core/SmFoo.zig
const std = @import("std");
const SmFoo = @This();

field_a: u32,
field_b: []u8,

pub fn init(allocator: std.mem.Allocator) !SmFoo { ... }
pub fn deinit(self: *SmFoo) void { ... }
```

The file path becomes the JS-visible type name through node-zigar.

### Skia-style static factories

Construction is a static method on the type. The first parameter must NOT be `*Self` — node-zigar dispatches it as a static member of the JS proxy class:

```zig
pub fn createBlank(width: u32, height: u32, settings: BitmapSettings) !SmBitmap { ... }
pub fn createBlankWithAllocator(allocator: std.mem.Allocator, ...) !SmBitmap { ... }
```

Always provide both variants for memory-touching factories: a JS-callable form using `page_allocator`, and a pure-Zig form taking an explicit allocator.

### Drawing methods take a SmPaint

```zig
pub fn drawRect(self: *SmCanvas, x: f64, y: f64, w: f64, h: f64, paint: *const SmPaint) void
```

HTML5-shaped sugar (`fillRect`/`strokeRect`/`clearRect`) is a thin wrapper that bundles the current ctx state into a paint and calls `drawRect`. Add the paint-explicit form first; add a sugar wrapper only if the WebIDL surface needs one.

### One `blitRow` API for everything

`SmBlitter.blitRow` takes `(pixels, dst_w, x, y, n, ?coverage, *const SmPaint)`. The `?coverage` parameter is what makes the same blitter handle:

- Scanline rasterization (today, coverage = `null` = full ink).
- Anti-aliased path rasterization (future, coverage filled by SmScan).
- Tile-based rasterization (future, coverage filled by tile binner).

**Don't write a parallel "AA fill" or "tile fill" code path.** Extend `blitRow`'s dispatch on `paint.kind`, `paint.blend_mode`, and non-null coverage.

### Module graph

Acyclic dependencies, enforced by convention:

```
opts/            ← leaves (per-arch SIMD kernels)
utils/           ← leaves + types from core/
encode/, decode/ ← leaves (no upward imports)
effects/         ← core/ + utils/
core/            ← opts/, encode/, decode/
```

`core/raster.zig` is the only file allowed to import `opts/simd.zig`.

### Numeric types

Canvas API floats are `f64` (WebIDL `unrestricted double`). Widths and heights are `u32`. `f32` is wrong and easy to get wrong — review math carefully.

### String returns

Use `[]const u8`, **not** `[:0]const u8`. zigar's sentinel validator is incompatible with Zig's `allocSentinel`. The `[]const u8` slice is auto-flagged string-capable; JS reads it via `.string`.

## Adding a new spec member

1. Find the interface in [`specs/`](https://github.com/your-org/simdra/tree/main/specs) and the unchecked member.
2. Decide which folder:
   - Pure drawing/data primitive → `core/Sm*.zig` (static or instance method).
   - Shader / gradient / filter → `effects/`.
   - Image encoder → `encode/`.
   - SIMD kernel → `opts/{generic,neon}.zig` + facade in `opts/simd.zig`.
   - HTML5 surface (CSS-string handling, data URLs, etc.) → `src/index.ts`, delegating to the Sm* primitive.
3. Exercise it in `test/index.js` — visual scene via `compareScene` if pixel-shaped, structural via `plain` if not.
4. `npm test` to verify, then `npm run build && npm run test:built`.
5. Tick the spec checkbox; note the implementation file/path.

## Adding a SIMD kernel

Per-arch kernels live in `opts/`. Each backend exports the same signatures; the dispatcher in `opts/simd.zig` picks the right one at comptime:

```zig
// zig/simdra/opts/simd.zig
const builtin = @import("builtin");
pub const fillU32 = if (builtin.target.cpu.arch == .aarch64)
    @import("neon.zig").fillU32
else
    @import("generic.zig").fillU32;
```

When adding a new kernel:

1. Add the **generic** version first in `opts/generic.zig` — `@Vector(N)`-based, byte-equal correctness reference. This is what WASM uses (only `v128` SIMD; no NEON).
2. Add the dispatcher entry in `opts/simd.zig`.
3. Tune in `opts/neon.zig` only if profiling shows it matters. Keep generic as the spec.

## Adding a vendor library

simdra vendors stb_truetype and stb_image. Adding another:

1. Drop the header(s) into `zig/simdra/utils/`.
2. Write a single TU (`zig/simdra/utils/<lib>.c`) defining the `*_IMPLEMENTATION` macro and stripping unused features at the C build level.
3. Append to `getCSourceFiles()` in `zig/build.extra.zig`.
4. Bind from a Zig file via `@cImport({ @cInclude("simdra/utils/<lib>.h") });`.

`useLibc: true` is already on in `node-zigar.config.json` and `vite.config.js` — libc malloc/realloc/free is available everywhere we ship.

## Pull request flow

Right now simdra is in its early days; PRs land via direct review. When opening one:

1. Run `npm run typecheck && npm test && npm run build && npm run test:built`. All four should be green.
2. Update [`COMPATIBILITY.md`](https://github.com/your-org/simdra/blob/main/COMPATIBILITY.md) if you touched a spec-member.
3. Update [`CLAUDE.md`](https://github.com/your-org/simdra/blob/main/CLAUDE.md) if you changed conventions or added a folder.
4. Tick spec checkboxes in `specs/` for any newly-implemented member.

## See also

- [Architecture](./) — raster pipeline, Sm* taxonomy, where things live.
- [Using simdra from Zig](./api) — direct Zig API surface.
