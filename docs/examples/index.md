---
title: Examples
description: Real-world integration examples — Cloudflare Workers, Vercel Edge, browsers, Node.
weight: 10
---

# Examples

Complete, copy-pasteable integrations grouped by use case. Every example below ships in this repo as a single self-contained file you can read end-to-end.

For per-runtime install + setup snippets (CF Workers, Vercel Edge, Deno, Bun, browsers, Web Workers), see [Installation](/installation). The examples here go further — full handlers with parameter parsing, error handling, and content negotiation.

## Canvas 2D drawing recipes

Render dynamic images using HTML5 Canvas primitives — gradients, `Path2D`, text, transforms.

- [**Open Graph card generator**](./og-image) — `1200×630` social-card image rendered from query params (`?title=&subtitle=&accent=`). Multi-line text wrap, gradient backgrounds, theme switching.
- [**Document / invoice renderer**](./document-render) — Canvas 2D drawing chops: gradients, `Path2D`, headers, rectangles, multi-column text. The "build a PDF page in a Worker" pattern.
- [**Bar chart from JSON**](./chart) — Worker endpoint that takes a JSON payload (`{ labels, values, title }`), renders a chart with axes, gridlines, and gradient bars, returns PNG.

## Image-processing endpoints

Use the `microsharp` (sharp-shaped) surface for decode → transform → re-encode pipelines.

- [**Image resize API**](./resize-api) — accept an image POST or fetched URL, parse `?w=&h=&fit=&q=&format=`, return the resized variant. The bread-and-butter Workers image endpoint.
- [**Avatar processing pipeline**](./avatar-pipeline) — multipart upload → autoOrient via EXIF → cover-crop to square → sharpen → JPEG. Worker / Vercel Edge.
- [**Watermark / branded screenshot**](./watermark) — composite a logo overlay at gravity southeast over an input image. Worker shape and Node CLI shape.
- [**Format converter**](./format-converter) — any input → PNG / JPEG / BMP / raw based on the request's `Accept` header. Content negotiation done right.

## Library integrations

simdra's `createCanvas` matches the [node-canvas](https://github.com/Automattic/node-canvas) signature, so libraries that already accept "any node-canvas-shaped module" plug in cleanly. The three below have working code in the [`examples/`](https://github.com/promentol/simdra/tree/main/examples) folder of the repo.

- [**SVG → PNG via `canvg`**](./canvg) — Render any SVG to PNG at the edge. canvg + `@xmldom/xmldom` + simdra in a Cloudflare Worker. No headless browser, no Resvg, ~1 MB total bundle.
- [**PDF → PNG via `pdfjs-serverless`**](./pdfjs) — Mozilla's pdf.js redistributed for edge runtimes, paired with a custom `SimdraCanvasFactory`. Renders any PDF page to PNG. Drop-in for Cloudflare / Vercel Edge / Deno Deploy.
- [**PDF → PNG via `unpdf`**](./unpdf) — Higher-level pdf.js wrapper (`renderPageAsImage`, `extractText`, `extractImages`). Less glue, fewer knobs. Same edge runtimes.

## Where to go next

- Need to handle a use case not listed? Each example is structured so the input/output adapter (request parsing, response building) is small and replaceable. The image-processing core stays the same across runtimes.
- For deeper API references, see the [Canvas 2D API](/canvas/api) and [MicroSharp API](/microsharp/api) pages.
- For deployment specifics — bundle limits, CPU budgets, async-offload via Service Bindings — see [Installation](/installation).
