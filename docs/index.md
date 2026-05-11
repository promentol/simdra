---
layout: home

hero:
  name: simdra
  text: HTML5 Canvas. In a Worker.
  tagline: SIMD-accelerated 2D canvas for Cloudflare Workers, browsers, Vercel Edge, Deno — anywhere V8 supports WASM-SIMD. Drop-in HTML5 API. One ~500 KB bundle.
  actions:
    - theme: brand
      text: Canvas 2D docs
      link: /canvas/
    - theme: alt
      text: Quick examples
      link: /examples/
    - theme: alt
      text: Install
      link: /installation

features:
  - icon: 🎨
    title: Drop-in HTML5 Canvas
    details: createCanvas, getContext('2d'), Path2D, ImageData, DOMMatrix, gradients, patterns, text. The exact API browsers ship.
    link: /canvas/api
    linkText: Canvas API reference
  - icon: 📜
    title: Paths, transforms, text
    details: Bezier curves, arcs, ellipses, roundRect. Full DOMMatrix. fillText / strokeText with an embedded Manrope variable font.
    link: /canvas/
    linkText: Canvas overview
  - icon: ⚡
    title: SIMD everywhere
    details: Hot loops vectorised through @Vector. Lowered to NEON on aarch64, SSE on x86, WASM-SIMD in browsers. No thread pools. Predictable single-thread latency.
  - icon: 🌐
    title: Runs in a Worker
    details: ~500 KB gzipped. Cloudflare Workers, browser Web Workers, Vercel Edge, Deno Deploy. Zero native deps, no postinstall.
    link: /installation
    linkText: Install for every runtime
  - icon: 🖼
    title: Bonus — image ops
    details: A sharp-shaped fluent API (microsharp) ships on the same core. resize, rotate, blur, modulate, composite. No libvips.
    link: /microsharp/
    linkText: MicroSharp docs
  - icon: 🎯
    title: Honest scope
    details: Single core × SIMD × RGBA8 sRGB. No 16-bit / Lab / CMYK, no WebP / AVIF. Small, bounded, auditable.
---

<div align="center">

![simdra — SIMD-accelerated 2D canvas, in a Worker](/image.png)

</div>

## A drop-in Canvas 2D for the runtimes `<canvas>` can't reach

You can render to `<canvas>` in browsers. You can't render to `<canvas>` in a Cloudflare Worker, a Vercel Edge function, a Deno Deploy isolate, or any other V8 runtime that doesn't ship the DOM. The native Node bindings ([`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas), [`node-canvas`](https://github.com/Automattic/node-canvas)) don't help either — they need Skia or Cairo as a C dependency, and those don't load in Workers.

simdra fills that gap: **a full HTML5 Canvas implementation compiled to a ~500 KB WASM bundle.** Drop-in for code that already targets `<canvas>` or `@napi-rs/canvas`. NEON / SSE / WASM-SIMD code paths under the hood. No native deps, no postinstall.

| Library | Workers? | Browser? | API | Bundle |
|---|---|---|---|---|
| `@napi-rs/canvas` | ❌ Node-API only | ❌ | Skia | — |
| `node-canvas` | ❌ Cairo native | ❌ | Cairo | — |
| `canvaskit-wasm` | ❌ too large | ✅ | Skia (not HTML5) | ~7 MB |
| **`simdra`** | ✅ | ✅ | **HTML5 Canvas** | **~500 KB gz** |

CanvasKit is the closest comparable — both are WASM, both work in the browser — but CanvasKit is a full Skia port (~7 MB), and it gives you the Skia API rather than HTML5 Canvas. simdra targets the smaller, more familiar Canvas surface that you already write.

## Quick examples

### Draw in a Web Worker

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

### Canvas 2D in Node — gradients + Path2D

```ts
import { createCanvas, Path2D } from 'simdra';
import { writeFileSync } from 'node:fs';

const canvas = createCanvas(400, 300);
const ctx = canvas.getContext('2d');

// Background gradient
const grad = ctx.createLinearGradient(0, 0, 0, 300);
grad.addColorStop(0, '#1e3a8a');
grad.addColorStop(1, '#0f172a');
ctx.fillStyle = grad;
ctx.fillRect(0, 0, 400, 300);

// Stroked + filled triangle
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

### Render an Open Graph card at the edge

```ts
// Cloudflare Worker — dynamic OG image from query params
import { __initSync, createCanvas } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

export default {
  async fetch(req: Request) {
    const title = new URL(req.url).searchParams.get('title') ?? 'simdra';
    const canvas = createCanvas(1200, 630);
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 1200, 630);
    bg.addColorStop(0, '#0f172a');
    bg.addColorStop(1, '#1e293b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1200, 630);

    ctx.fillStyle = '#fff';
    ctx.font = '700 80px sans-serif';
    ctx.fillText(title, 64, 320);

    return new Response(canvas.toBytes(), {
      headers: { 'content-type': 'image/png' },
    });
  },
};
```

### Bonus: image processing with the sharp-shaped surface

simdra also ships **`microsharp`** — a drop-in sharp-API-shaped fluent surface on the same Zig core. Same install, no extra dependency.

```ts
import { __initSync, microsharp } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

export default {
  async fetch(req: Request) {
    const out = await microsharp(req.body)
      .resize(800, 600, { fit: 'cover', kernel: 'lanczos3' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return new Response(out, {
      headers: { 'content-type': 'image/jpeg' },
    });
  },
};
```

[See the full sharp-shaped API →](/microsharp/api)

For more complete integrations — OG-card generators, avatar pipelines, watermarking, format converters, document and chart renderers, plus canvg / pdfjs-serverless / unpdf integrations — see [Examples](/examples/). For per-runtime install / setup, see [Installation](/installation).

## Three surfaces, one SIMD core

| | Surface | Style | Use when |
|---|---|---|---|
| 🎨 | **[Canvas 2D](/canvas/)** | HTML5 immediate-mode (`ctx.fillRect(...)`) | Drawing, programmatic graphics, OG cards, charts, pdf.js |
| 🖼 | **[MicroSharp](/microsharp/)** | Fluent pipeline (`microsharp(buf).resize().toBuffer()`) | Re-encoding, resizing, image transforms |
| 🦎 | **[Zig core](/zig/)** | Skia-style primitives (`surface.getCanvas().drawRect(..., paint)`) | Embedding in another Zig project, contributing kernels |

The three surfaces are independent at the consumer layer but call the same Zig types underneath — same SIMD kernels, same encoders, same decoders.

## When NOT to use simdra

- **Multi-core image-processing servers** — use `sharp`. simdra is single-thread by design; sharp wins on a 16-core box.
- **GPU-bound workloads** — use Skia / WebGPU.
- **Wide-gamut, 16-bit, ICC-aware pipelines** — use libvips.
- **WebP / AVIF / JXL output** — `stb_image_write` doesn't ship them; use `sharp`.

The bullseye is: *"I need a Canvas 2D API in a Cloudflare Worker / Vercel Edge function / browser Web Worker / single-vCPU lambda, and the existing libraries don't run there."*
