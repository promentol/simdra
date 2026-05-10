---
title: MicroSharp
description: Sharp-shaped fluent image-processing surface built on the simdra Zig core.
---

# MicroSharp — sharp's API, in a Worker

MicroSharp is simdra's sharp-shaped fluent image-processing surface, deployable to Cloudflare Workers, browser Web Workers, Vercel Edge, Deno Deploy, and any V8 isolate that supports WASM-SIMD. Same chainable shape as `sharp`, no libvips dependency, runs in WASM.

The function is exported from the package root as **`microsharp`** (alongside `createCanvas`); "MicroSharp" is the project name (smaller-than-`sharp`, narrower scope, no libvips dependency).

## Why MicroSharp

[`sharp`](https://sharp.pixelplumbing.com) is the de-facto image-processing library on Node. It's excellent — but it needs libvips native code and won't run on Cloudflare Workers, Vercel Edge, browsers, or any other restricted runtime. MicroSharp targets the same API shape — chainable, async, sharp-flavoured — built on the simdra Zig core that already runs native + WASM.

| Library | Cloudflare Workers? | Browser? | Native deps | Bundle |
|---|---|---|---|---|
| `sharp` | ❌ needs libvips | ❌ | yes (libvips) | — |
| **MicroSharp** | ✅ | ✅ | **no** | **~500 KB gz** |

It's not a sharp replacement for everyone. sharp has more ops, libvips' tile-streaming scheduler for huge images, and years of colour-management work. MicroSharp is the right answer when:

- You're deploying to an edge runtime (Workers, Vercel Edge, Deno Deploy).
- You're processing user-uploaded images in the browser without a server round-trip.
- You don't want a 30 MB native dependency in your build.

## What you give up vs sharp

- No multi-core throughput on a 16-core box. simdra is single-thread by design.
- No WebP / AVIF / JXL output — `stb_image_write` doesn't ship them. PNG / JPEG / BMP / raw RGBA only.
- No 16-bit / Lab / CMYK pipelines. RGBA8 sRGB only.
- No EXIF / ICC / XMP metadata round-tripping (only `Orientation` is read for `autoOrient`).
- No tile-streaming for very large images.

If any of those are dealbreakers, use sharp.

## Quick recipe

```ts
import { microsharp } from 'simdra';
import { readFileSync, writeFileSync } from 'node:fs';

const input = readFileSync('input.png');
const out = await microsharp(input).jpeg(0.85).toBuffer();
writeFileSync('output.jpg', out);

const meta = await microsharp(input).metadata();
console.log(`${meta.width}×${meta.height}`);
```

Workers idiom — `microsharp` accepts `Uint8Array`, `ArrayBuffer`, `Blob`, `ReadableStream`, or `Response` directly:

```ts
import { microsharp } from 'simdra/wasm';

export default {
  async fetch(req: Request) {
    const out = await microsharp(req.body!).jpeg(0.8).toBuffer();
    return new Response(out, { headers: { 'content-type': 'image/jpeg' } });
  },
};
```

## Read next

- [API reference](./api) — pipeline, terminals, async patterns, comparison with sharp.
- Cross-cutting: [Installation](/installation) covers Cloudflare Workers, Vercel Edge, Deno, Bun, browser bundlers, and the Web Worker / Service-Binding offload patterns — same setup applies to MicroSharp.
