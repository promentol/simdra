---
title: Image resize API
description: Cloudflare Worker endpoint that resizes an image based on query params and returns the result.
weight: 11
---

# Image resize API (Cloudflare Worker)

A general-purpose image resize endpoint. Accepts the image bytes as the request body **or** fetches them from a `?url=` parameter, then dispatches on `?w=&h=&fit=&q=&format=` to return a resized variant.

## What it covers

- Accepting image input three ways: raw POST body, multipart form, fetched URL.
- Parsing typed query params with sensible defaults.
- Sharp-shaped resize options (`fit`, `kernel`).
- Format and quality switching.
- Cache-control headers so a CDN can cache repeat hits.

## Full code

```ts
// src/index.ts
import { __initSync, microsharp } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

type Fit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
type Format = 'jpeg' | 'png' | 'webp';   // webp will fall through to jpeg

interface Params {
  width?: number;
  height?: number;
  fit: Fit;
  quality: number;
  format: Format;
}

function parseParams(url: URL): Params {
  const get = (k: string) => url.searchParams.get(k) ?? undefined;
  const num = (k: string) => {
    const v = get(k);
    return v && /^\d+$/.test(v) ? parseInt(v, 10) : undefined;
  };
  return {
    width: num('w') ?? num('width'),
    height: num('h') ?? num('height'),
    fit: ((get('fit') as Fit) ?? 'cover'),
    quality: Math.max(1, Math.min(100, num('q') ?? num('quality') ?? 85)),
    format: ((get('format') as Format) ?? 'jpeg'),
  };
}

async function loadInput(req: Request, url: URL): Promise<ReadableStream<Uint8Array> | Uint8Array> {
  const fetchUrl = url.searchParams.get('url');
  if (fetchUrl) {
    const r = await fetch(fetchUrl);
    if (!r.ok) throw new Error(`Upstream fetch ${fetchUrl} -> ${r.status}`);
    return r.body!;
  }
  if (req.body) return req.body;
  throw new Error('No image input — POST a body or pass ?url=');
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(req.url);
    const params = parseParams(url);

    if (params.width === undefined && params.height === undefined) {
      return badRequest('Specify ?w= and/or ?h= (e.g. ?w=800&h=600&fit=cover)');
    }
    if (params.format === 'webp') {
      // simdra doesn't ship a WebP encoder; fall through to JPEG.
      params.format = 'jpeg';
    }

    let pipeline;
    try {
      const input = await loadInput(req, url);
      pipeline = microsharp(input).resize(
        params.width,
        params.height,
        { fit: params.fit, kernel: 'lanczos3' },
      );
    } catch (err) {
      return badRequest((err as Error).message);
    }

    const out = params.format === 'png'
      ? await pipeline.png().toBuffer()
      : await pipeline.jpeg({ quality: params.quality / 100 }).toBuffer();

    return new Response(out, {
      headers: {
        'content-type': params.format === 'png' ? 'image/png' : 'image/jpeg',
        // Cache by full URL — query params identify the variant.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-simdra-bytes': String(out.byteLength),
      },
    });
  },
};
```

## Deploy

```toml
# wrangler.toml
name = "simdra-resize"
main = "src/index.ts"
compatibility_date = "2024-12-01"
```

```bash
wrangler deploy
```

## Try it

```bash
# Resize a remote image to 800×600, JPEG quality 85
curl -o out.jpg \
  "https://simdra-resize.your-worker.dev/?url=https://example.com/photo.jpg&w=800&h=600&q=85"

# Or POST the bytes directly
curl --data-binary @photo.jpg \
  -H 'content-type: image/jpeg' \
  "https://simdra-resize.your-worker.dev/?w=400&h=300&fit=contain" \
  -o out.jpg
```

## Why these defaults

- **`fit: 'cover'`** — most common request; preserves aspect, fills the box, crops the overflow.
- **`kernel: 'lanczos3'`** — sharp's default; best perceived sharpness for downscale.
- **`quality: 85`** — the sweet spot for JPEG; visible artifacts only on large flat areas.
- **`cache-control: immutable`** — the URL fully identifies the variant (every param is in the query string), so a CDN can cache forever. Ideal for `<img src="/resize?...">` traffic.

## Extending

- **Crop before resize** — add `?crop=l,t,w,h` parsing and chain `.extract({ left, top, width, height })` before `.resize()`.
- **Smart crop** — set `fit: 'cover'` and pass `position: 'attention'` for content-aware focus.
- **Strip alpha for JPEG** — chain `.flatten({ background: '#fff' })` so transparent inputs don't render black.
- **CORS** — add `'access-control-allow-origin': '*'` if you hit this from `<img>` tags on another origin.
- **Auth** — gate by signed URL (HMAC of the query params) before fetching `?url=` to prevent abuse as an open proxy.
