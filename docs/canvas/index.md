---
title: Canvas 2D
description: HTML5 Canvas drawing API — Canvas, CanvasRenderingContext2D, Path2D, Image, ImageData.
---

# Canvas 2D — in a Worker

A complete HTML5 Canvas implementation that runs in a Cloudflare Worker, browser Web Worker, Vercel Edge function, or any V8 isolate that supports WASM-SIMD. Drop-in for code that already targets `<canvas>` or `@napi-rs/canvas`: `Canvas`, `CanvasRenderingContext2D`, `Path2D`, `Image`, `ImageData`, `DOMMatrix`, `CanvasGradient`, `CanvasPattern`. Spec divergences are listed in [Compatibility](./compatibility).

`@napi-rs/canvas` and `node-canvas` need Node-API or Cairo; neither runs in a Worker. simdra ships as a single ~500 KB gzipped WASM bundle with NEON / SSE / WASM-SIMD code paths under the hood. Same Canvas API, no native deps, no postinstall.

## Install

```bash
npm install simdra
```

For runtime-specific setup (Cloudflare Workers, Vercel Edge, Deno, Bun, browser bundlers, Web Workers), see [Installation](/installation).

## 60-second drawing

```ts
import { createCanvas } from 'simdra';
import { writeFileSync } from 'node:fs';

const canvas = createCanvas(400, 300);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#03a9f4';
ctx.fillRect(0, 0, 400, 300);

ctx.fillStyle = '#ffffff';
ctx.font = '32px sans-serif';
ctx.fillText('Hello, simdra', 20, 80);

writeFileSync('hello.png', canvas.toBytes());
// JPEG: writeFileSync('hello.jpg', canvas.toBytes('image/jpeg', 0.9));
```

## Read next

- [Installation](/installation) — Node, Cloudflare Workers, Vercel Edge, Deno, Bun, browser, Web Workers.
- [API reference](./api) — drawing, paths, transforms, text, images, encoding.
- [Compatibility](./compatibility) — HTML5 spec coverage matrix.
