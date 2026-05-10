---
title: Avatar processing pipeline
description: Multipart upload → autoOrient → cover-crop to square → sharpen → JPEG. Worker / Vercel Edge.
weight: 13
---

# Avatar processing pipeline

The classic user-upload flow: take whatever the user gives you (HEIC from an iPhone, raw camera JPEG with EXIF orientation, oversized PNG) and emit a clean, consistently-sized, slightly-sharpened JPEG ready for storage.

## What it covers

- **Multipart form parsing** in a Worker (no Express, no body-parser).
- **EXIF auto-orientation** so iPhone photos don't come out sideways.
- **Cover-crop to square** with content-aware focus (`position: 'attention'`).
- **Soft sharpen** for downscale crispness.
- **Quality / size tradeoff** that's actually small (~12-25 KB per 256×256 avatar).

## Full code

```ts
// src/index.ts
import { __initSync, microsharp } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

const SIZES = [
  { name: 'large', dim: 512 },
  { name: 'medium', dim: 256 },
  { name: 'small', dim: 64 },
] as const;

const MAX_INPUT_BYTES = 10 * 1024 * 1024;   // 10 MB

interface Variants {
  [name: string]: {
    bytes: Uint8Array;
    width: number;
    height: number;
    size: number;
  };
}

async function readUpload(req: Request): Promise<Uint8Array> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.startsWith('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('avatar');
    if (!(file instanceof File)) {
      throw new Error('Form field "avatar" must be a file');
    }
    if (file.size > MAX_INPUT_BYTES) {
      throw new Error(`File too large (${file.size} > ${MAX_INPUT_BYTES} bytes)`);
    }
    return new Uint8Array(await file.arrayBuffer());
  }
  // Fallback: raw bytes in body
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`Body too large (${bytes.byteLength} > ${MAX_INPUT_BYTES} bytes)`);
  }
  return bytes;
}

async function buildVariants(input: Uint8Array): Promise<Variants> {
  const variants: Variants = {};
  for (const { name, dim } of SIZES) {
    const { data, info } = await microsharp(input)
      .rotate()                                          // autoOrient via EXIF
      .resize(dim, dim, {
        fit: 'cover',
        position: 'attention',                           // content-aware focus
        kernel: 'lanczos3',
      })
      .sharpen()                                         // 3×3 unsharp; cheap
      .jpeg({ quality: 0.85 })
      .toBuffer({ resolveWithObject: true });
    variants[name] = {
      bytes: data,
      width: info.width,
      height: info.height,
      size: info.size,
    };
  }
  return variants;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'POST' },
      });
    }

    let input: Uint8Array;
    try {
      input = await readUpload(req);
    } catch (err) {
      return jsonError(400, (err as Error).message);
    }

    let variants: Variants;
    try {
      variants = await buildVariants(input);
    } catch (err) {
      return jsonError(415, `Could not process image: ${(err as Error).message}`);
    }

    // Persist to R2 (or wherever) — use ctx.waitUntil so the response
    // doesn't block on the writes.
    const userId = req.headers.get('x-user-id') ?? 'anonymous';
    ctx.waitUntil((async () => {
      for (const [name, v] of Object.entries(variants)) {
        await env.R2.put(`avatars/${userId}/${name}.jpg`, v.bytes, {
          httpMetadata: { contentType: 'image/jpeg' },
        });
      }
    })());

    // Respond with a manifest the client can use immediately.
    return new Response(JSON.stringify({
      variants: Object.fromEntries(
        Object.entries(variants).map(([n, v]) => [
          n,
          { url: `/avatars/${userId}/${n}.jpg`, width: v.width, height: v.height, size: v.size },
        ]),
      ),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};

interface Env {
  R2: R2Bucket;
}
```

## Deploy

```toml
# wrangler.toml
name = "simdra-avatars"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[[r2_buckets]]
binding = "R2"
bucket_name = "user-avatars"
```

```bash
wrangler r2 bucket create user-avatars
wrangler deploy
```

## Try it

```bash
curl -X POST \
  -F "avatar=@photo.heic;type=image/heic" \
  -H "x-user-id: 42" \
  https://simdra-avatars.your-worker.dev/
# → { "variants": { "large":  { "url": "/avatars/42/large.jpg",  ... }, ... } }
```

## Why these choices

- **`.rotate()` no-args** → aliases `autoOrient()` for EXIF. iPhone photos default to landscape orientation in the file with an EXIF Orientation tag rotating them 90° at display time. Without `autoOrient`, the cropped square would be rotated.
- **`fit: 'cover', position: 'attention'`** → square output, content-aware crop. The `'attention'` heuristic picks the window with the highest local-luma gradient + saturation magnitude, which works well for faces and product shots.
- **`.sharpen()` no-args** → fast 3×3 unsharp kernel. Compensates for the softness Lanczos resampling introduces. For more aggressive sharpening on heavy downscales, use `.sharpen({ sigma: 1.5 })`.
- **JPEG quality 0.85** → the sweet spot. Drops to ~12 KB for 256×256 with no visible loss; 0.95 would double the size for negligible gain.
- **`ctx.waitUntil` for R2 writes** → the response goes back as soon as the image is processed; the persistence happens after. The client can render the avatar from in-memory bytes (returned in the response) or poll the URL.

## Extending

- **HEIC / HEIF input** — simdra (via stb_image) doesn't decode HEIC. Add a HEIC-to-JPEG step on the *client* using a small WASM HEIC decoder, or accept the input is JPEG/PNG only.
- **Animated avatars** — accept a GIF, decode the first frame (`SmBitmap.decode` does this automatically), or reject animated input with a clear error.
- **Centre-crop fallback** — if `attention` ever picks an awkward window, swap to `position: 'centre'` for a deterministic centre crop.
- **Ban images with no faces** — out of scope for simdra; add a face-detection step (TF.js / WebGPU) before processing.
- **Privacy** — strip EXIF *after* `autoOrient`. simdra doesn't write EXIF on output, so this is automatic — your stored avatars carry no GPS or device tags.
