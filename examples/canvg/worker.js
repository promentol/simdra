// canvg + simdra in a Cloudflare Worker — render SVG to PNG at the edge.
//
// canvg's `presets.node` wants three things: a `DOMParser` (parse SVG),
// a `canvas` module shaped like node-canvas (`{ createCanvas(w, h) }`),
// and a `fetch` impl (resolve external `<image>` / `<style>` references).
// Workers gives us global `fetch` for free; we hand canvg `@xmldom/xmldom`
// for DOMParser and simdra for the canvas — simdra's exported
// `createCanvas` matches the node-canvas signature exactly.
//
// Run locally:
//   pnpm add -D canvg @xmldom/xmldom wrangler
//   npm run build       # ensure dist/wasm/* exists
//   npx wrangler dev --config examples/canvg/wrangler.jsonc
//
// Visit http://localhost:8787/ — fetches a built-in sample SVG (or `?url=`),
// renders it via simdra, returns PNG.
//
// Deploy:
//   npx wrangler deploy --config examples/canvg/wrangler.jsonc

import * as simdra from '../../dist/wasm/index.mjs';
import wasm from '../../dist/wasm/simdra.wasm';

import { DOMParser } from '@xmldom/xmldom';
import { Canvg, presets } from 'canvg';

// Synchronous WASM init — see other CF examples for the rationale.
simdra.initSync(wasm);

const preset = presets.node({
  DOMParser,
  canvas: { createCanvas: simdra.createCanvas },
  fetch: globalThis.fetch.bind(globalThis),
});

// Default SVG when no `?url=` is provided. Mirrors examples/canvg/example.svg.
const SAMPLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
  </defs>
  <rect width="800" height="600" fill="url(#bg)"/>
  <text x="80" y="180" fill="#f8fafc" font-family="sans-serif" font-size="96" font-weight="bold">simdra</text>
  <text x="80" y="240" fill="rgba(248,250,252,0.7)" font-family="sans-serif" font-size="28">SVG → PNG via canvg</text>
  <rect x="80" y="200" width="380" height="4" fill="url(#accent)"/>
</svg>`;

async function loadSvg(url) {
  if (!url) return SAMPLE_SVG;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch SVG (${res.status})`);
  return res.text();
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const svgUrl = url.searchParams.get('url');
    const width = Number(url.searchParams.get('width') ?? '800');
    const height = Number(url.searchParams.get('height') ?? '600');

    try {
      const svg = await loadSvg(svgUrl);
      const canvas = preset.createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      const v = Canvg.fromString(ctx, svg, preset);
      // First frame only — SVG animations would need `.start()` instead.
      await v.render();

      const png = await canvas.toBytesAsync();
      canvas.destroy();

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
