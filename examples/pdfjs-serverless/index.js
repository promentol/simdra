// pdf.js + simdra in a Cloudflare Worker.
//
// Uses `pdfjs-serverless` — Mozilla's pdf.js redistributed as a single
// edge-compatible bundle (worker pre-inlined, browser-only globals
// stripped). Combined with simdra's WASM build, the whole stack is
// drop-in for Cloudflare Workers / Vercel Edge / Deno Deploy.
//
// Run locally:
//   pnpm add -D pdfjs-serverless wrangler
//   npm run build       # ensure dist/wasm/* exists
//   npx wrangler dev examples/pdfjs-serverless/index.js
//
// Visit http://localhost:8787/ — fetches Mozilla's sample tracemonkey
// PDF (`?url=...` overrides), renders page 1 via simdra, returns PNG.
//
// Deploy:
//   npx wrangler deploy examples/pdfjs-serverless/index.js
//
// For Node, see ./node.js — same factory, same render path, different
// init (uses `simdra` core via node-zigar instead of `simdra/wasm`).

import * as simdra from '../../dist/wasm/index.mjs';
import wasm from '../../dist/wasm/simdra.wasm';

import { SimdraCanvasFactory, installSimdraGlobals } from './factory.js';

// Init the WASM module synchronously — Workers forbids streaming compile
// of raw bytes but allows instantiating a pre-compiled module, which is
// exactly what `import wasm from '*.wasm'` gives us.
simdra.initSync(wasm);

// pdf.js needs Path2D / DOMMatrix / ImageData on globalThis. Install BEFORE
// the dynamic import so pdf.js's module-level code sees them.
installSimdraGlobals(simdra);

// Dynamic import so the polyfill runs first. Top-level await is supported
// in Workers + Deno Deploy + Vercel Edge + Node ≥18.
const pdfjsLib = await import('pdfjs-serverless');

const factory = new SimdraCanvasFactory(simdra.createCanvas);

async function renderPage(pdfBytes, pageNumber, scale) {
  const doc = await pdfjsLib.getDocument({
    data: pdfBytes,
    canvasFactory: factory,
    // Disable font-face loading: pdf.js can't fetch font files in a Worker
    // without filesystem access, and we don't ship pdf.js's standard font
    // bundle. With this off, embedded fonts that are subsetted in the PDF
    // are drawn as outlines (Path2D) — which is the simdra-friendly path.
    disableFontFace: true,
    useSystemFonts: false,
    // standardFontDataUrl / cMapUrl intentionally omitted — pdf.js
    // requires them to be a non-empty URL ending with `/`, and we don't
    // host one. Embedded fonts in the PDF are still rendered as outlines.
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
      const png = await renderPage(pdfBytes, pageNumber, scale);
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
