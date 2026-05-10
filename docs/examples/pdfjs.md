---
title: PDF → PNG via pdfjs-serverless
description: Render PDF pages with Mozilla's pdf.js + a custom simdra canvas factory.
weight: 22
---

# PDF → PNG via pdfjs-serverless

[`pdfjs-serverless`](https://github.com/unjs/pdfjs-serverless) is Mozilla's pdf.js redistributed for edge runtimes. Pair it with a small canvas-factory shim and simdra renders any PDF page to PNG. Working code in [`examples/pdfjs-serverless/`](https://github.com/narekh/simdra/tree/main/examples/pdfjs-serverless).

## Install

```bash
pnpm add simdra pdfjs-serverless
pnpm add -D wrangler
```

## Canvas factory

```js
// factory.js
export class SimdraCanvasFactory {
  constructor(createCanvas) {
    this.createCanvas = createCanvas;
  }

  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = this.createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(cac, width, height) {
    if (!cac.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    cac.canvas.width = width;
    cac.canvas.height = height;
  }

  destroy(cac) {
    if (!cac.canvas) throw new Error('Canvas is not specified');
    cac.canvas.destroy();
    cac.canvas = null;
    cac.context = null;
  }
}

export function installSimdraGlobals(simdra) {
  if (!globalThis.Path2D) globalThis.Path2D = simdra.Path2D;
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = simdra.DOMMatrix;
  if (!globalThis.ImageData) globalThis.ImageData = simdra.ImageData;
}
```

## Cloudflare Worker

```js
import * as simdra from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
import { SimdraCanvasFactory, installSimdraGlobals } from './factory.js';

simdra.initSync(wasm);
installSimdraGlobals(simdra);

const pdfjsLib = await import('pdfjs-serverless');
const factory = new SimdraCanvasFactory(simdra.createCanvas);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pdfUrl = url.searchParams.get('url');
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const scale = Number(url.searchParams.get('scale') ?? '1.5');

    const res = await fetch(pdfUrl);
    const pdfBytes = new Uint8Array(await res.arrayBuffer());

    const doc = await pdfjsLib.getDocument({
      data: pdfBytes,
      canvasFactory: factory,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;

    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const cac = factory.create(viewport.width, viewport.height);

    await page.render({
      canvasContext: cac.context,
      viewport,
      canvasFactory: factory,
    }).promise;

    const png = cac.canvas.toBytes();
    factory.destroy(cac);
    await page.cleanup();
    await doc.destroy();

    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  },
};
```

## Node

```js
import { writeFile } from 'node:fs/promises';
import * as simdra from 'simdra';
import { SimdraCanvasFactory, installSimdraGlobals } from './factory.js';

installSimdraGlobals(simdra);
const pdfjsLib = await import('pdfjs-serverless');
const factory = new SimdraCanvasFactory(simdra.createCanvas);

const res = await fetch('https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf');
const pdfBytes = new Uint8Array(await res.arrayBuffer());

const doc = await pdfjsLib.getDocument({
  data: pdfBytes,
  canvasFactory: factory,
  disableFontFace: true,
  useSystemFonts: false,
}).promise;

const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 1.5 });
const cac = factory.create(viewport.width, viewport.height);
await page.render({ canvasContext: cac.context, viewport, canvasFactory: factory }).promise;

await writeFile('page.png', cac.canvas.toBytes());
factory.destroy(cac);
await page.cleanup();
await doc.destroy();
```
