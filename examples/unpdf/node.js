// unpdf + simdra under Node — same render path as the Worker entry at
// ./index.js, but uses simdra's native (node-zigar) build for fast dev
// iteration. Useful for sanity-checking PDFs locally before deploying.
//
// Run from the project root:
//   node --loader=node-zigar --no-warnings examples/unpdf/node.js [pdf-url] [page] [scale]
//
// With no args, fetches Mozilla's tracemonkey sample PDF and renders
// page 1 at 1.5× into examples/unpdf/page.png.

import { writeFile } from 'node:fs/promises';
import * as simdra from '../../src/index.ts';

const { definePDFJSModule, renderPageAsImage } = await import('unpdf');

// Native Node has full pdfjs-dist available — but we need its `legacy`
// build, not the default. The default build uses TC39 stage-3
// `Map.prototype.getOrInsertComputed`, which lands in V8 in 2024+ but
// isn't available in Node 22/25. The legacy build polyfills it via
// core-js. Same warning pdf.js prints itself: "Please use the legacy
// build in Node.js environments."
await definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'));

// unpdf's `canvasImport` does `resolved.default || resolved` to support
// CJS interop. simdra's namespace exports a default `init()` function
// (the WASM bootstrap), so passing the namespace directly would yield
// `init` instead of the canvas module — `createCanvas` would be missing.
// We hand it a plain object with just the names unpdf reads off:
// `createCanvas`, plus `DOMMatrix` / `ImageData` / `Path2D` (which
// unpdf installs on `globalThis` itself).
const canvasModule = {
  createCanvas: simdra.createCanvas,
  DOMMatrix: simdra.DOMMatrix,
  ImageData: simdra.ImageData,
  Path2D: simdra.Path2D,
};

const [, , urlArg, pageArg, scaleArg] = process.argv;
const url = urlArg ?? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';
const pageNumber = Number(pageArg ?? '1');
const scale = Number(scaleArg ?? '1.5');

console.log(`Fetching ${url} ...`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
const pdfBytes = new Uint8Array(await res.arrayBuffer());

console.log(`Rendering page ${pageNumber} at scale ${scale} ...`);
const png = await renderPageAsImage(pdfBytes, pageNumber, {
  canvasImport: () => Promise.resolve(canvasModule),
  scale,
});

const outUrl = new URL('./page.png', import.meta.url);
await writeFile(outUrl, new Uint8Array(png));
console.log(`Wrote ${outUrl.pathname} (${png.byteLength} bytes)`);
