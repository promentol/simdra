---
title: Format converter
description: Worker that picks the output format from the request's Accept header.
weight: 15
---

# Format converter (Accept-header dispatch)

Take any input image, return PNG / JPEG / BMP / raw RGBA based on the request's `Accept` header. Showcases content negotiation done right — clients ask for what they want, the server gives them the best match.

## What it covers

- Parsing `Accept` with quality values (`q=0.8`).
- Mapping MIME types to simdra's encoder set.
- Falling back gracefully when none of the requested types are supported.
- The `Vary: Accept` header so caches don't cross-pollute responses.

## Full code

```ts
// src/index.ts
import { __initSync, microsharp } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

type SupportedFormat = 'png' | 'jpeg' | 'bmp' | 'raw';

const FORMAT_TYPES: Record<SupportedFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  raw: 'application/octet-stream',
};

interface AcceptEntry { type: string; q: number; }

function parseAccept(header: string | null): AcceptEntry[] {
  if (!header) return [{ type: '*/*', q: 1 }];
  return header.split(',').map((part) => {
    const [type, ...attrs] = part.trim().split(';').map((s) => s.trim());
    let q = 1;
    for (const a of attrs) {
      const [k, v] = a.split('=').map((s) => s.trim());
      if (k === 'q') q = parseFloat(v) || 0;
    }
    return { type, q };
  }).sort((a, b) => b.q - a.q);
}

function pickFormat(header: string | null): SupportedFormat {
  const entries = parseAccept(header);
  for (const { type, q } of entries) {
    if (q === 0) continue;
    if (type === '*/*' || type === 'image/*') return 'png';
    for (const [fmt, mime] of Object.entries(FORMAT_TYPES) as [SupportedFormat, string][]) {
      if (type === mime) return fmt;
    }
    // Common aliases
    if (type === 'image/jpg') return 'jpeg';
    if (type === 'image/x-bmp' || type === 'image/x-ms-bmp') return 'bmp';
  }
  // No match — default to PNG.
  return 'png';
}

function unsupported(format: string): Response {
  return new Response(JSON.stringify({
    error: `Unsupported output format`,
    requested: format,
    supported: Object.values(FORMAT_TYPES),
  }), {
    status: 406,
    headers: {
      'content-type': 'application/json',
      'vary': 'Accept',
    },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('POST an image to convert', { status: 405 });
    }

    const accept = req.headers.get('accept');
    const format = pickFormat(accept);

    // If the client *explicitly* asked for a format we don't ship (webp,
    // avif, jxl, gif) and gave it q > 0, return 406.
    if (accept) {
      const explicit = parseAccept(accept).filter((e) => e.q > 0);
      const unshipped = explicit.find((e) =>
        /^image\/(webp|avif|jxl|gif|tiff|heic|heif)$/.test(e.type),
      );
      if (unshipped && !explicit.some((e) =>
        Object.values(FORMAT_TYPES).includes(e.type) || e.type.includes('*'),
      )) {
        return unsupported(unshipped.type);
      }
    }

    const inputBytes = new Uint8Array(await req.arrayBuffer());
    if (inputBytes.byteLength === 0) {
      return new Response('Empty body', { status: 400 });
    }

    let pipeline = microsharp(inputBytes);

    // Optional resize via query params (?w=, ?h=).
    const url = new URL(req.url);
    const w = url.searchParams.get('w');
    const h = url.searchParams.get('h');
    if (w || h) {
      pipeline = pipeline.resize(
        w ? parseInt(w, 10) : undefined,
        h ? parseInt(h, 10) : undefined,
        { fit: 'inside' },
      );
    }

    // JPEG accepts a quality query param too.
    const out = format === 'jpeg'
      ? await pipeline.jpeg({
          quality: parseFloat(url.searchParams.get('q') ?? '0.85'),
        }).toBuffer()
      : format === 'png' ? await pipeline.png().toBuffer()
      : format === 'bmp' ? await pipeline.bmp().toBuffer()
      : await pipeline.raw().toBuffer();

    return new Response(out, {
      headers: {
        'content-type': FORMAT_TYPES[format],
        'vary': 'Accept',
        'x-simdra-format': format,
        'x-simdra-bytes': String(out.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  },
};
```

## Try it

```bash
# Browser-style accept header — PNG comes back
curl --data-binary @photo.jpg \
  -H 'accept: image/png' \
  https://simdra-converter.your-worker.dev/ \
  -o out.png

# Multiple types with quality preferences
curl --data-binary @photo.jpg \
  -H 'accept: image/avif;q=1, image/jpeg;q=0.8, image/png;q=0.5' \
  -v https://simdra-converter.your-worker.dev/ \
  -o out
# → AVIF requested but not shipped; falls through to JPEG (next preferred)
# → response: image/jpeg

# Wildcard
curl --data-binary @photo.bmp \
  -H 'accept: image/*' \
  https://simdra-converter.your-worker.dev/ \
  -o out.png
# → defaults to PNG

# Resize while converting
curl --data-binary @photo.jpg \
  -H 'accept: image/jpeg' \
  "https://simdra-converter.your-worker.dev/?w=800&q=0.9" \
  -o out.jpg
```

## Why these choices

- **Accept-header parsing with `q` values** — proper RFC 7231 handling. Browsers send things like `image/webp,image/apng,image/*,*/*;q=0.8` and you should respect the precedence.
- **Wildcard → PNG** — when the client says "anything image", PNG is the safe lossless default. Some Worker users go JPEG here for size; we go quality.
- **`Vary: Accept`** — without this, a CDN could cache the JPEG response and serve it to a client that asked for PNG. With it, each Accept variant gets its own cache entry.
- **406 for explicitly unsupported formats** — if a client *only* asks for AVIF and we can't deliver it, returning 406 (Not Acceptable) is the spec-correct answer. Clients can detect this and re-request with a broader `Accept`.
- **`x-simdra-format` response header** — useful for clients that want to log what they actually got vs what they requested.

## Extending

- **Add a `?strip-alpha=true` flag** — chain `.flatten({ background: '#fff' })` before encoding, so transparent PNGs don't render black when converted to JPEG.
- **Quality tiers** — instead of `?q=`, accept `?quality=high|medium|low` and map each to a sensible setting per format.
- **Watermark while converting** — chain `.composite([{ input: logoBytes, gravity: 'southeast' }])` before the format step. See the [watermark example](./watermark).
- **Reject very large inputs** — content-negotiating endpoints become a target for amplification attacks. Add `if (inputBytes.byteLength > MAX) return 413;`.
- **HEIC / HEIF input** — simdra (via stb_image) decodes PNG / JPEG / BMP / GIF. For HEIC, route to a separate HEIC-decoder Worker via Service Binding before this one.
