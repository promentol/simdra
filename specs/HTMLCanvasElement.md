# HTMLCanvasElement

MDN: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement

In simd-canvas this maps to `Canvas` (`zig/canvas/Canvas.zig`). Construction goes through the free function `createCanvas(width, height)` (mirrors `@napi-rs/canvas` and the implicit constructor pattern HTML uses via `document.createElement('canvas')`).

Priority is set by pdf.js. Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Instance properties

- [x] 🔴 `width: u32` — `zig/simdra/core/SmSurface.zig` (`resize`) + `src/index.ts` (`Canvas.width` setter). Reallocates to transparent black and resets ctx state per spec.
- [x] 🔴 `height: u32` — `zig/simdra/core/SmSurface.zig` (`resize`) + `src/index.ts` (`Canvas.height` setter). Same semantics as `width`.

## Instance methods

- [x] 🔴 `getContext(contextType: string)` → `CanvasRenderingContext2D` — `zig/canvas/Canvas.zig`. Caches on first call; only `"2d"` supported.
- [x] 🟡 `getContext(contextType, contextAttributes)` — `zig/canvas/Canvas.zig` as `getContextSettings(kind, settings)`. Attributes (alpha / colorSpace / desynchronized / willReadFrequently) are accepted and ignored; returns the same cached context as the no-arg form.
- [x] 🟡 `toDataURL()` → string — `zig/canvas/Canvas.zig`. Always emits `image/png`.
- [x] 🟡 `toDataURL(type)` → string — `zig/canvas/Canvas.zig` as `toDataURLType(mime)`. Falls back to png for unrecognized types.
- [x] 🟡 `toDataURL(type, quality)` — `src/index.ts` (`Canvas.toDataURL`) + `zig/simdra/encode/jpeg.zig` (stb_image_write). Recognizes `image/png` and `image/jpeg` (`quality` clamped from HTML5 0.0–1.0 to stb's 1–100, default 0.92); WebP still ⛔ (no stb path).
- [ ] ⛔ `toBlob(callback, type?, quality?)` — needs a Node Blob shim; encoders are now in place via `Canvas.toBytes(type, quality)`.
- [ ] ⛔ `toBlob` Promise variant.
- [ ] ⛔ `transferControlToOffscreen()` — relies on browser worker transfer.

## Out of scope (DOM-only)

- ⛔ `captureStream(frameRate?)` — depends on MediaStream.
- ⛔ Event listeners (`contextlost`, `contextrestored`, `webglcontext*`).
- ⛔ HTMLElement inheritance.

## Non-spec extensions (kept because they're load-bearing without GC)

- `deinit()` — frees pixel buffer + cached context + last data URL.
- `Canvas.toBytes(type?, quality?)` — same dispatch as `toDataURL` but returns the raw `Uint8Array` (skips the base64 round-trip).
- `Image.fromBytes(bytes)` (`src/index.ts`) — Node-canvas-style decoder for PNG / JPEG / BMP / GIF (first frame). Backed by stb_image. Browser-shaped helper; not the spec's HTMLImageElement (no `src`/`onload`).
