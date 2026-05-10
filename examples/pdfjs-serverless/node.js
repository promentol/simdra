// pdf.js + simdra, running under Node — same factory as the Worker entry
// at ./index.js, but uses simdra's native (node-zigar) build for fast dev
// iteration. Useful for testing PDFs locally before deploying the Worker.
//
// Run from the project root:
//   node --loader=node-zigar --no-warnings examples/pdfjs-serverless/node.js [pdf-url] [page] [scale]
//
// With no args, fetches Mozilla's tracemonkey sample PDF and renders page 1
// at 1.5× into examples/pdfjs-serverless/page.png.

import { writeFile } from 'node:fs/promises';
import * as simdra from '../../src/index.ts';
import { SimdraCanvasFactory, installSimdraGlobals } from './factory.js';

installSimdraGlobals(simdra);
const pdfjsLib = await import('pdfjs-serverless');

const factory = new SimdraCanvasFactory(simdra.createCanvas);

async function renderPage(pdfBytes, pageNumber, scale) {
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
  return png;
}

const [, , urlArg, pageArg, scaleArg] = process.argv;
const url = urlArg ?? 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf';
const page = Number(pageArg ?? '1');
const scale = Number(scaleArg ?? '1.5');

console.log(`Fetching ${url} ...`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
const pdfBytes = new Uint8Array(await res.arrayBuffer());
console.log(`Rendering page ${page} at scale ${scale} ...`);
const png = await renderPage(pdfBytes, page, scale);

const outUrl = new URL('./page.png', import.meta.url);
await writeFile(outUrl, png);
console.log(`Wrote ${outUrl.pathname} (${png.byteLength} bytes)`);
