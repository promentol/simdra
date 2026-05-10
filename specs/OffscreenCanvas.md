# OffscreenCanvas

MDN: https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas

A canvas decoupled from the DOM, designed for use in workers. In Node we don't have the DOM in the first place, so an OffscreenCanvas is essentially the same shape as our existing `Canvas`. The motivation is API parity for code that targets both browser and Node.

Will live in (future) `zig/canvas/OffscreenCanvas.zig`. Most methods can delegate to `Canvas` directly.

Priority — pdf.js does use OffscreenCanvas in worker mode for tile rendering, but in Node usage the page renders happen on the main `Canvas` directly. Whole interface is therefore 🟡 (parity, not on the critical path). Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Constructors

- [ ] 🟡 `new OffscreenCanvas(width, height)`.

## Instance properties

- [ ] 🟡 `width: u32`.
- [ ] 🟡 `height: u32`.

## Instance methods

- [ ] 🟡 `getContext(contextType, contextAttributes?)` → 2D context.
- [ ] ⛔ `convertToBlob(options?)` → Promise<Blob>. Depends on Blob shim + jpeg/webp encoders.
- [ ] ⛔ `transferToImageBitmap()` → ImageBitmap. Requires the ImageBitmap type.

## Out of scope

- ⛔ Worker postMessage transfer semantics — Node `worker_threads` use a different mechanism; the Zig allocations are not transferable.
