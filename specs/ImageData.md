# ImageData

MDN: https://developer.mozilla.org/en-US/docs/Web/API/ImageData

Plain data type returned by `CanvasRenderingContext2D.getImageData()` and consumed by `putImageData()`. Implemented as `zig/canvas/ImageData.zig` (file-is-struct).

Priority is set by pdf.js. Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Instance properties

- [x] 🔴 `data: Uint8ClampedArray | Float16Array` — `[]u8` field. JS receives a Uint8Array proxy; for `pixelFormat == 'rgba-float16'` consumers wrap it as a `Float16Array` view.
- [x] 🔴 `width: u32`.
- [x] 🔴 `height: u32`.
- [x] 🟡 `colorSpace: 'srgb' | 'display-p3'` — value is preserved end-to-end; sRGB↔P3 transform is **not** performed (acknowledged divergence). pdf.js works in sRGB.
- [x] 🟡 `pixelFormat: 'rgba-unorm8' | 'rgba-float16'` — pdf.js uses unorm8.

## Constructors

- [x] 🔴 `new ImageData(width, height, settings?)` — fresh transparent-black buffer. Core in `zig/canvas/ImageData.zig` (`createBlank`); WebIDL surface in `src/index.ts`.
- [x] 🟡 `new ImageData(data, width, height?, settings?)` — adopt an existing typed-array buffer (bytes copied into a page_allocator slice). Core in `zig/canvas/ImageData.zig` (`createFromBuffer`); WebIDL surface in `src/index.ts`.

Architectural split: Zig is the pure drawing library — it exposes the raw factory functions `createImageData*` from `zig/canvas.zig` plus the `ImageData.createBlank` / `createFromBuffer` static methods. The HTML5 / WebIDL compatibility layer lives entirely in TypeScript (`src/index.ts`):

- The global `class ImageData` constructor dispatches the WebIDL overload set by argument shape and returns the underlying Zig proxy.
- `CanvasRenderingContext2D.prototype.createImageData(...)` is augmented JS-side with the HTML5 ctx-method overloads (`(w, h, settings?)` and `(imagedata)`), so callers go through the regular `canvas.getContext('2d')` flow.

## Notes

- Spec specifies `data` as `Uint8ClampedArray` for unorm8 and `Float16Array` for float16. We expose `Uint8Array` for both — JS callers reinterpret with `new Float16Array(buffer, byteOffset, byteLength/2)` when needed. Worth revisiting if node-zigar grows native Uint8ClampedArray support.
- sRGB↔display-p3 conversion is a real matrix transform once we wire it. For now `colorSpace` is informational.
