---
title: Watermark / logo composite
description: Composite a logo overlay onto an input image. Worker fetch and Node CLI shapes.
weight: 14
---

# Watermark / logo composite

Take an input image, drop a logo into a corner with adjustable opacity, return the result. Two shapes — a Cloudflare Worker fetch handler, and a Node-only CLI script for batch processing.

## What it covers

- `microsharp.composite()` with a logo overlay.
- `gravity` placement (`southeast`, `northwest`, etc.).
- Opacity via the logo's alpha channel — pre-bake or set at runtime.
- Tinted variant — recolour the logo to match brand without re-exporting.

## Cloudflare Worker — `?logo=` overlay endpoint

```ts
// src/index.ts
import { __initSync, microsharp } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

import logoBytes from './logo.png';   // bundled at build time

interface Params {
  gravity: 'northwest' | 'northeast' | 'southwest' | 'southeast' | 'centre';
  opacity: number;            // 0..1
  scale: number;              // logo width as fraction of base width, 0..1
  tint: string | null;        // hex/CSS colour or null
}

function parseParams(url: URL): Params {
  const get = (k: string) => url.searchParams.get(k);
  return {
    gravity: ((get('gravity') as Params['gravity']) ?? 'southeast'),
    opacity: Math.max(0, Math.min(1, parseFloat(get('opacity') ?? '0.85'))),
    scale: Math.max(0.05, Math.min(0.5, parseFloat(get('scale') ?? '0.18'))),
    tint: get('tint'),
  };
}

async function buildLogo(p: Params, baseWidth: number): Promise<Uint8Array> {
  const { width: lw } = await microsharp(new Uint8Array(logoBytes)).metadata();
  const targetWidth = Math.round(baseWidth * p.scale);
  // Build the logo at the right size + opacity in one chain.
  let pipeline = microsharp(new Uint8Array(logoBytes))
    .resize(targetWidth, undefined, { kernel: 'lanczos3' })
    .ensureAlpha(p.opacity);
  if (p.tint) pipeline = pipeline.tint(p.tint);
  return pipeline.png().toBuffer();
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('POST an image', { status: 405 });
    }
    const url = new URL(req.url);
    const params = parseParams(url);
    const inputBytes = new Uint8Array(await req.arrayBuffer());

    // We need the base image width to scale the logo. Read it via metadata
    // (header-only, no decode allocation).
    const { width: baseWidth } = await microsharp(inputBytes).metadata();
    const logo = await buildLogo(params, baseWidth);

    const out = await microsharp(inputBytes)
      .composite([{ input: logo, gravity: params.gravity, blend: 'over' }])
      .jpeg({ quality: 90 })
      .toBuffer();

    return new Response(out, {
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  },
};
```

```toml
# wrangler.toml
name = "simdra-watermark"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[[rules]]
type = "Data"
globs = ["**/*.png"]
fallthrough = false
```

The `[[rules]]` block lets `wrangler` bundle the bundled `logo.png` as binary data.

## Try it

```bash
curl --data-binary @photo.jpg \
  -H 'content-type: image/jpeg' \
  "https://simdra-watermark.your-worker.dev/?gravity=southeast&opacity=0.7&scale=0.15" \
  -o watermarked.jpg
```

## Node CLI — batch watermark a directory

```ts
// scripts/watermark.ts
import { microsharp } from 'simdra';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, parse } from 'node:path';

const [, , inputDir, outputDir, logoPath] = process.argv;
if (!inputDir || !outputDir || !logoPath) {
  console.error('Usage: tsx watermark.ts <inputDir> <outputDir> <logo.png>');
  process.exit(1);
}

const logo = readFileSync(logoPath);

for (const file of readdirSync(inputDir)) {
  const fullPath = join(inputDir, file);
  if (!statSync(fullPath).isFile()) continue;
  if (!/\.(jpe?g|png)$/i.test(file)) continue;

  const input = readFileSync(fullPath);
  const { width } = await microsharp(input).metadata();

  const sizedLogo = await microsharp(logo)
    .resize(Math.round(width * 0.15), undefined, { kernel: 'lanczos3' })
    .ensureAlpha(0.85)
    .png()
    .toBuffer();

  const out = await microsharp(input)
    .composite([{ input: sizedLogo, gravity: 'southeast' }])
    .jpeg({ quality: 0.9 })
    .toBuffer();

  const outPath = join(outputDir, parse(file).name + '.jpg');
  writeFileSync(outPath, out);
  console.log(`✓ ${file} → ${outPath}`);
}
```

```bash
npx tsx scripts/watermark.ts ./photos ./watermarked ./logo.png
```

## Why these choices

- **Logo as a separate `microsharp` chain** — building the sized + tinted logo as its own bitmap means the composite step takes pre-prepared pixels, no per-pixel resize during composition.
- **`ensureAlpha(0.85)`** — sets the logo's α to 0.85 uniformly. Since the composite uses `blend: 'over'` (default), this gives a 15%-translucent overlay that doesn't fight with the underlying photo.
- **`scale` fraction of base width** — logos that are a fixed pixel size look weird across phone vs desktop captures. Sizing by fraction keeps the logo proportional.
- **`gravity: 'southeast'`** — bottom-right is where users expect a watermark; `'centre'` is for full-image stamps.
- **Pre-baked `tint`** — if your logo is white-on-transparent and you want it red on this image, `.tint('#ff0000')` recolours per-pixel by the luminance pattern. Cheap and chromatic.

## Extending

- **Conditional tint based on background** — `.metadata()` can sample the average colour of the placement region; if it's dark, use the white logo, if it's light, use the black one. Two pre-baked logos and a switch.
- **Repeating watermark** — pass `tile: true` in the composite entry. The logo tiles across the entire base.
- **Multiple overlays** — `composite([...])` takes an array. Stack a logo at southeast and a copyright notice at northwest in one pipeline.
- **`mix-blend-mode: multiply`** — `blend: 'multiply'` for an ink-stamp look. The logo's dark pixels darken the underlay; light pixels disappear.
