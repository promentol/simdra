---
title: PDF → PNG via unpdf
description: Render PDF pages with unpdf's renderPageAsImage helper on top of simdra.
weight: 23
---

# PDF → PNG via unpdf

[`unpdf`](https://github.com/unjs/unpdf) is a serverless-friendly pdf.js wrapper with `renderPageAsImage`, `extractText`, and `extractImages` helpers. Hand it simdra via `canvasImport` and you're done. Working code in [`examples/unpdf/`](https://github.com/promentol/simdra/tree/main/examples/unpdf).

## Install

```bash
pnpm add simdra unpdf pdfjs-serverless
pnpm add -D wrangler
```

## Cloudflare Worker

```js
import * as simdra from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';

simdra.initSync(wasm);

const { definePDFJSModule, renderPageAsImage } = await import('unpdf');
await definePDFJSModule(() => import('pdfjs-serverless'));

const canvasModule = {
  createCanvas: simdra.createCanvas,
  DOMMatrix: simdra.DOMMatrix,
  ImageData: simdra.ImageData,
  Path2D: simdra.Path2D,
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pdfUrl = url.searchParams.get('url');
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const scale = Number(url.searchParams.get('scale') ?? '1.5');

    const res = await fetch(pdfUrl);
    const pdfBytes = new Uint8Array(await res.arrayBuffer());

    const png = await renderPageAsImage(pdfBytes, pageNumber, {
      canvasImport: () => Promise.resolve(canvasModule),
      scale,
    });

    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  },
};
```

## Node

```js
import { writeFile } from 'node:fs/promises';
import * as simdra from 'simdra';

const { definePDFJSModule, renderPageAsImage } = await import('unpdf');
// Node ≤22 needs the legacy build (Map.prototype.getOrInsertComputed polyfill).
await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));

const canvasModule = {
  createCanvas: simdra.createCanvas,
  DOMMatrix: simdra.DOMMatrix,
  ImageData: simdra.ImageData,
  Path2D: simdra.Path2D,
};

const res = await fetch('https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf');
const pdfBytes = new Uint8Array(await res.arrayBuffer());

const png = await renderPageAsImage(pdfBytes, 1, {
  canvasImport: () => Promise.resolve(canvasModule),
  scale: 1.5,
});

await writeFile('page.png', new Uint8Array(png));
```
