// unpdf + simdra in a Cloudflare Worker.
//
// `unpdf` is a serverless-friendly PDF utility that wraps pdf.js with
// convenience helpers — `renderPageAsImage`, `extractText`, `extractImages`.
// We feed it simdra's `createCanvas` via the `canvasImport` option, which
// expects a function returning a module shaped like `@napi-rs/canvas`
// (i.e. `{ createCanvas(w, h) }`). simdra matches that shape exactly.
//
// pdf.js itself isn't compiled into unpdf — we hand it `pdfjs-serverless`
// (Mozilla's pdf.js redistributed as a single edge-compatible bundle) via
// `definePDFJSModule`. For Node, see ./node.js — same factory wiring,
// uses `pdfjs-dist` directly.
//
// Run locally:
//   pnpm add -D unpdf pdfjs-serverless wrangler
//   npm run build       # ensure dist/wasm/* exists
//   npx wrangler dev examples/unpdf/index.js
//
// Visit http://localhost:8787/ — fetches Mozilla's tracemonkey sample PDF
// (`?url=...` overrides), renders page 1 via simdra, returns PNG.
//
// Deploy:
//   npx wrangler deploy examples/unpdf/index.js

import * as simdra from '../../dist/wasm/index.mjs';
import wasm from '../../dist/wasm/simdra.wasm';

// Synchronously instantiate the simdra WASM module from the pre-compiled
// import — Workers forbids `WebAssembly.compile()` from raw bytes but
// allows `new WebAssembly.Instance(precompiledModule, ...)`.
simdra.initSync(wasm);

const { definePDFJSModule, renderPageAsImage } = await import('unpdf');

// Tell unpdf to use the edge-compatible pdf.js build instead of its
// bundled stripped variant. `definePDFJSModule` accepts an async
// loader; the dynamic import is evaluated once on first use.
await definePDFJSModule(() => import('pdfjs-serverless'));

// unpdf's `canvasImport` does `resolved.default || resolved` for CJS
// interop. simdra's WASM namespace exports a default `init()` function
// (the WASM bootstrap), so passing the namespace directly would resolve
// to `init` and `createCanvas` would be missing. Hand it a plain object
// with the names unpdf reads — `createCanvas` is what it calls; the
// other three are auto-installed on `globalThis` so pdf.js can see them.
const canvasModule = {
  createCanvas: simdra.createCanvas,
  DOMMatrix: simdra.DOMMatrix,
  ImageData: simdra.ImageData,
  Path2D: simdra.Path2D,
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pdfUrl = url.searchParams.get('url')
      ?? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';
    const pageNumber = Number(url.searchParams.get('page') ?? '1');
    const scale = Number(url.searchParams.get('scale') ?? '1.5');

    try {
      const res = await fetch(pdfUrl);
      if (!res.ok) {
        return new Response(`Failed to fetch PDF (${res.status})`, { status: 502 });
      }
      const pdfBytes = new Uint8Array(await res.arrayBuffer());

      // unpdf does the canvas creation, render, and encode internally —
      // we only supply (a) the bytes, (b) the page, (c) the canvas
      // module via `canvasImport`. Returns an ArrayBuffer of PNG bytes.
      const png = await renderPageAsImage(pdfBytes, pageNumber, {
        canvasImport: () => Promise.resolve(canvasModule),
        scale,
      });

      return new Response(png, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300',
        },
      });
    } catch (err) {
      return new Response(`Render failed: ${err?.message ?? err}`, { status: 500 });
    }
  },
};
