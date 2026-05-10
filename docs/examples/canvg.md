---
title: SVG → PNG via canvg
description: Render SVG to PNG using canvg on top of simdra.
weight: 21
---

# SVG → PNG via canvg

[`canvg`](https://github.com/canvg/canvg) renders SVG into a Canvas2D context. Hand it simdra's `createCanvas` and you get SVG → PNG anywhere simdra runs. Working code in [`examples/canvg/`](https://github.com/promentol/simdra/tree/main/examples/canvg).

## Install

```bash
pnpm add simdra canvg @xmldom/xmldom
pnpm add -D wrangler
```

## Cloudflare Worker

```js
import * as simdra from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';

import { DOMParser } from '@xmldom/xmldom';
import { Canvg, presets } from 'canvg';

simdra.initSync(wasm);

const preset = presets.node({
  DOMParser,
  canvas: { createCanvas: simdra.createCanvas },
  fetch: globalThis.fetch.bind(globalThis),
});

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const svgUrl = url.searchParams.get('url');
    const width = Number(url.searchParams.get('width') ?? '800');
    const height = Number(url.searchParams.get('height') ?? '600');

    const res = await fetch(svgUrl);
    if (!res.ok) return new Response(`Failed (${res.status})`, { status: 502 });
    const svg = await res.text();

    const canvas = preset.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const v = Canvg.fromString(ctx, svg, preset);
    await v.render();

    const png = await canvas.toBytesAsync();
    canvas.destroy();
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  },
};
```

## Node

```js
import { promises as fs } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import fetch from 'node-fetch';
import { Canvg, presets } from 'canvg';

import { createCanvas } from 'simdra';

const preset = presets.node({
  DOMParser,
  canvas: { createCanvas },
  fetch,
});

const svg = await fs.readFile('input.svg', 'utf8');
const canvas = preset.createCanvas(800, 600);
const ctx = canvas.getContext('2d');
const v = Canvg.fromString(ctx, svg, preset);
await v.render();
await fs.writeFile('output.png', canvas.toBytes());
```
