---
layout: home

hero:
  name: simdra
  text: 2D canvas. In a Worker.
  tagline: SIMD-accelerated HTML5 Canvas + sharp-shaped image processing. One ~500 KB WASM bundle. Workers, browsers, edge.
  actions:
    - theme: brand
      text: Canvas 2D
      link: /canvas/
    - theme: alt
      text: MicroSharp
      link: /microsharp/
    - theme: alt
      text: Zig core
      link: /zig/

features:
  - icon: 🎨
    title: Canvas 2D
    details: Drop-in HTML5 Canvas. createCanvas, Path2D, ImageData, DOMMatrix, gradients, patterns. The API you already write in the browser.
    link: /canvas/
    linkText: Canvas 2D docs
  - icon: 🖼
    title: MicroSharp
    details: Drop-in sharp-shaped fluent API. resize, rotate, blur, sharpen, modulate, composite. No libvips. Runs in WASM.
    link: /microsharp/
    linkText: MicroSharp docs
  - icon: 🦎
    title: Zig core
    details: Skia-style Sm* primitives. File-is-struct, allocator-aware. A real-world @Vector workout. Embed directly.
    link: /zig/
    linkText: Zig core docs
  - icon: ⚡
    title: SIMD everywhere
    details: Hot loops lowered to NEON on aarch64, SSE on x86, WASM-SIMD in browsers. No thread pools. Predictable single-thread latency.
  - icon: 🌐
    title: Runs where sharp can't
    details: ~500 KB gzipped. Cloudflare Workers, Web Workers, Vercel Edge, Deno Deploy. Zero native deps, no postinstall.
  - icon: 🎯
    title: Honest scope
    details: Single core × SIMD × RGBA8 sRGB. No 16-bit / Lab / CMYK, no WebP / AVIF. Small, bounded, auditable.
---

<p align="center">
  <img src="/image.png" alt="simdra — SIMD-accelerated 2D canvas, in a Worker" style="max-width: 100%; border-radius: 8px;" />
</p>

## simdra is for the runtimes the multi-threaded image libraries can't reach

[`sharp`](https://sharp.pixelplumbing.com) is great. So is [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas). Neither runs in a Cloudflare Worker, browser Web Worker, or any other V8 isolate that doesn't let you spawn threads. simdra fills that gap: HTML5 Canvas 2D plus a sharp-shaped fluent surface, both compiled to one ~500 KB WASM bundle with NEON / SSE / WASM-SIMD code paths.

| Library | Cloudflare Workers? | Browser? | Native deps | Bundle |
|---|---|---|---|---|
| `sharp` | ❌ needs libvips | ❌ | yes (libvips) | — |
| `@napi-rs/canvas` | ❌ Node-API only | ❌ | yes (Skia) | — |
| `node-canvas` | ❌ Cairo native | ❌ | yes (Cairo) | — |
| `canvaskit-wasm` | ❌ too large | ✅ | no | ~7 MB |
| **`simdra`** | ✅ | ✅ | **no** | **~500 KB gz** |

CanvasKit is the closest comparable — both are WASM, both work in the browser — but CanvasKit is a full Skia port (~7 MB) that's too large for the Worker bundle limit and gives you the Skia API rather than HTML5 Canvas. simdra targets the smaller, more familiar Canvas surface plus the sharp shape, in 1/14 the size, and fits inside the Worker bundle budget.

## Quick examples

### Resize on a Cloudflare Worker

```ts
import { __initSync, microsharp } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

export default {
  async fetch(request: Request) {
    const out = await microsharp(request.body)
      .resize(800, 600, { fit: 'cover', kernel: 'lanczos3' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return new Response(out, {
      headers: { 'content-type': 'image/jpeg' },
    });
  },
};
```

### Draw on a Web Worker

```ts
// worker.ts
import { __initSync, createCanvas } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

self.onmessage = (e) => {
  const canvas = createCanvas(e.data.width, e.data.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#10b981';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = '24px sans-serif';
  ctx.fillText('Hello, Worker', 20, 40);
  const png = canvas.toBytes();
  self.postMessage(png, [png.buffer]);
};
```

### Sharp-style chain in the browser

```ts
import { __init, microsharp } from 'simdra/wasm';
import wasmUrl from 'simdra/wasm/simdra.wasm?url';
await __init(fetch(wasmUrl));

async function autoCrop(file: File) {
  const out = await microsharp(file)
    .rotate()                                  // autoOrient via EXIF
    .resize(1200, 800, { fit: 'cover', position: 'attention' })
    .modulate({ brightness: 1.1, saturation: 1.2 })
    .sharpen()
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Blob([out], { type: 'image/jpeg' });
}
```

### Full sharp image-ops chain — single-thread, in WASM

simdra implements sharp's full image-operations API (~22 ops):

```ts
const out = await microsharp(input)
  .rotate(90)                                  // 90° / 180° / 270° byte-exact
  .flip().flop()                               // mirrors
  .affine([1, 0.3, 0.1, 0.7])                  // affine transform
  .blur(2)                                     // separable Gaussian
  .sharpen({ sigma: 1, m1: 1, m2: 2 })         // libvips USM
  .median(3).dilate(1).erode(1)                // morphology
  .convolve({ width: 3, height: 3, kernel: [-1,0,1,-2,0,2,-1,0,1] })
  .gamma(2.2).negate({ alpha: false })         // tone curves
  .linear(1.2, -10).threshold(128)             // levels
  .normalise().clahe({ width: 16, height: 16 })
  .modulate({ brightness: 1.1, hue: 30 })
  .tint('#ff8800').greyscale()
  .png()
  .toBuffer();
```

### Drawing primitives — Canvas 2D in Node

```ts
import { createCanvas, Path2D } from 'simdra';
import { writeFileSync } from 'node:fs';

const canvas = createCanvas(400, 300);
const ctx = canvas.getContext('2d');

// Background
const grad = ctx.createLinearGradient(0, 0, 0, 300);
grad.addColorStop(0, '#1e3a8a');
grad.addColorStop(1, '#0f172a');
ctx.fillStyle = grad;
ctx.fillRect(0, 0, 400, 300);

// Path with stroke + fill
const path = new Path2D();
path.moveTo(200, 50);
path.lineTo(350, 250);
path.lineTo(50, 250);
path.closePath();

ctx.fillStyle = '#fbbf24';
ctx.fill(path);
ctx.lineWidth = 4;
ctx.strokeStyle = '#fff';
ctx.stroke(path);

writeFileSync('out.png', canvas.toBytes());
```

For complete, copy-pasteable integrations — image-resize APIs, OG-card generators, avatar pipelines, watermarking, format converters, document and chart renderers — see [Examples](/examples/). For per-runtime install / setup, see [Installation](/installation).

## Three surfaces, one core

| | Surface | Style | Use when |
|---|---|---|---|
| 🎨 | **[Canvas 2D](/canvas/)** | HTML5 immediate-mode (`ctx.fillRect(...)`) | Drawing, programmatic graphics, pdf.js-style rendering |
| 🖼 | **[MicroSharp](/microsharp/)** | sharp-shaped fluent (`microsharp(buf).jpeg().toBuffer()`) | Decode / re-encode / resize / image transforms |
| 🦎 | **[Zig core](/zig/)** | Skia-style primitives (`surface.getCanvas().drawRect(..., paint)`) | Embedding in another Zig project, contributing kernels |

The three surfaces are independent at the consumer layer but call the same Zig types underneath — same SIMD kernels, same encoders, same decoders.

## When NOT to use simdra

- Multi-core image-processing servers — use `sharp`. simdra is single-thread by design; sharp wins on a 16-core box.
- GPU-bound workloads — use Skia / WebGPU.
- Wide-gamut, 16-bit, ICC-aware pipelines — use libvips.
- WebP / AVIF / JXL output — `stb_image_write` doesn't ship them; use `sharp`.

The bullseye is: *"I'm shipping image processing in a Cloudflare Worker / Vercel Edge function / browser Web Worker / single-vCPU lambda, and the Node-API libraries don't run there."*
