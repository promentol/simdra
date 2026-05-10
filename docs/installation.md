---
title: Installation
description: Install simdra and run it on Node, browsers, Cloudflare Workers, Vercel Edge, Deno, and Bun.
weight: 5
---

# Installation

```bash
npm install simdra
# pnpm add simdra
# yarn add simdra
# bun add simdra
```

simdra ships **two builds under one package**:

| Entry | What it is | Where it runs |
|---|---|---|
| `simdra` / `simdra/core` | Native Node.js addon via [node-zigar](https://github.com/chung-leong/node-zigar). NEON kernels on aarch64. | Node.js (server, dev) |
| `simdra/wasm` | WASM bundle, ~440 KB raw / ~175 KB gzip. WASM-SIMD code paths. | Browsers, Workers, edge runtimes, Deno, Bun |
| `simdra/wasm/simdra.wasm` | Raw WASM module asset. | Used by the bundlers below to import the binary. |

Both builds expose the same JS surface: `createCanvas`, `microsharp`, `Path2D`, `DOMMatrix`, `ImageData`, `CanvasGradient`, `CanvasPattern`, `Image`, `parseCssColor`.

---

## Node.js (native)

```ts
import { createCanvas, microsharp } from 'simdra';
import { writeFileSync, readFileSync } from 'node:fs';

// Canvas 2D
const canvas = createCanvas(400, 300);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#03a9f4';
ctx.fillRect(0, 0, 400, 300);
ctx.fillStyle = '#fff';
ctx.font = '32px sans-serif';
ctx.fillText('Hello, simdra', 20, 80);
writeFileSync('hello.png', canvas.toBytes());

// MicroSharp
const out = await microsharp(readFileSync('photo.jpg'))
  .resize(800, 600, { fit: 'cover' })
  .jpeg({ quality: 85 })
  .toBuffer();
writeFileSync('thumb.jpg', out);
```

The native build uses `node-zigar` to load a `.node` binary at first import. No init required, no async setup. NEON kernels active on Apple Silicon and aarch64 Linux; `@Vector` generic baseline on x86.

---

## Cloudflare Workers

Cloudflare's runtime forbids `WebAssembly.compile()` from raw bytes at request time but **does** allow `new WebAssembly.Instance(precompiledModule, ...)` synchronously. Compile happens at deploy, not at request. Use `__initSync` at module-init scope:

```ts
import { __initSync, microsharp, createCanvas } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';   // imported as WebAssembly.Module
__initSync(wasm);

export default {
  async fetch(req: Request) {
    // microsharp pipeline straight from request body
    const out = await microsharp(req.body!)
      .resize(800, 600, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return new Response(out, {
      headers: { 'content-type': 'image/jpeg' },
    });
  },
};
```

`wrangler` recognises `.wasm` imports as `WebAssembly.Module` automatically. No `wrangler.toml` config needed beyond the standard Worker setup:

```toml
# wrangler.toml
name = "image-resize"
main = "src/index.ts"
compatibility_date = "2024-12-01"
```

### Bundle + CPU limits

| | Free | Paid |
|---|---|---|
| CPU per request | 10 ms | up to 5 min |
| Memory | 128 MB | 128 MB |
| Worker bundle | 1 MB | 10 MB |

simdra at ~440 KB WASM + a few KB of JS is well under the 1 MB free-tier bundle limit. CPU-wise: a 1024×1024 PNG encode is ~10–30 ms — at the edge of the 10 ms free-tier limit; comfortably within paid tiers.

### Service-Binding offload

If a single Worker doesn't have enough CPU budget for your encode, deploy simdra as a separate Worker and call it via a [Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/):

```toml
# wrangler.toml of the calling Worker
[[services]]
binding = "ENCODER"
service = "simdra-encoder"
```

```ts
// calling Worker
export default {
  async fetch(req: Request, env: Env) {
    const out = await env.ENCODER.encode(
      new Uint8Array(await req.arrayBuffer()),
      'jpeg',
      85,
    );
    return new Response(out, { headers: { 'content-type': 'image/jpeg' } });
  },
};
```

```ts
// simdra-encoder Worker (deployed separately)
import { WorkerEntrypoint } from 'cloudflare:workers';
import { __initSync, microsharp } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

export default class extends WorkerEntrypoint {
  async encode(input: Uint8Array, format: 'jpeg' | 'png', quality?: number) {
    return await microsharp(input)[format](quality).toBuffer();
  }
}
```

Each call gets its own isolate — its own CPU budget, its own memory.

### `waitUntil` (fire-and-forget)

If the work shouldn't block the response — generate a thumbnail and write to R2 *after* responding:

```ts
ctx.waitUntil((async () => {
  const thumb = await microsharp(input).jpeg(0.7).toBuffer();
  await env.R2.put(`thumb/${id}`, thumb);
})());
```

The response goes out immediately; the encode continues until the runtime evicts the isolate.

---

## Vercel Edge

Vercel Edge is V8 isolates with constraints similar to Cloudflare. `WebAssembly.compileStreaming` works during request handling, so `__init` is fine here.

```ts
// app/api/resize/route.ts (App Router)
export const runtime = 'edge';

import { __init, microsharp } from 'simdra/wasm';
import wasmUrl from 'simdra/wasm/simdra.wasm?url';

let ready: Promise<void> | null = null;
function ensureReady() {
  ready ??= __init(fetch(wasmUrl));
  return ready;
}

export async function POST(req: Request) {
  await ensureReady();
  const out = await microsharp(req.body!)
    .resize(800, 600, { fit: 'cover' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Response(out, {
    headers: { 'content-type': 'image/jpeg' },
  });
}
```

Memoise the init promise so subsequent invocations skip the compile. Vercel Edge supports WASM-SIMD; cold-start is dominated by the streaming compile (~30–80 ms depending on the region).

---

## Deno (Deploy + local)

```ts
import { __init, microsharp, createCanvas } from 'npm:simdra/wasm';
import wasmUrl from 'npm:simdra/wasm/simdra.wasm?url';

await __init(fetch(wasmUrl));

Deno.serve(async (req) => {
  const out = await microsharp(req.body!).jpeg(0.85).toBuffer();
  return new Response(out, { headers: { 'content-type': 'image/jpeg' } });
});
```

Deno supports the same fetch-streaming pattern as the browser. The `npm:` specifier installs the package on first run and caches it.

For Deno Deploy, package the WASM file as a static asset and import it the same way — Deploy supports WASM-SIMD and `WebAssembly.compileStreaming`.

---

## Bun

```ts
import { __init, microsharp } from 'simdra/wasm';
import wasmUrl from 'simdra/wasm/simdra.wasm?url';

await __init(fetch(wasmUrl));

Bun.serve({
  port: 3000,
  async fetch(req) {
    const out = await microsharp(req.body!).jpeg(0.85).toBuffer();
    return new Response(out, { headers: { 'content-type': 'image/jpeg' } });
  },
});
```

Bun supports WASM-SIMD natively. You can also import the native `simdra/core` if you're running on a platform with the prebuilt `.node` binary — Bun will prefer it.

---

## Browser

### Vite / Rollup

```ts
import { __init, createCanvas } from 'simdra/wasm';
import wasmUrl from 'simdra/wasm/simdra.wasm?url';

await __init(fetch(wasmUrl));

const canvas = createCanvas(400, 300);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#10b981';
ctx.fillRect(0, 0, 400, 300);

const blob = new Blob([canvas.toBytes()], { type: 'image/png' });
document.querySelector('img')!.src = URL.createObjectURL(blob);
```

Vite emits the WASM file with a content-hash filename and gives you the URL via `?url`. Rollup needs the equivalent emit-asset plugin; Webpack 5 uses `new URL('simdra/wasm/simdra.wasm', import.meta.url)`.

### Webpack 5

```ts
import { __init, createCanvas } from 'simdra/wasm';
const wasmUrl = new URL('simdra/wasm/simdra.wasm', import.meta.url);

await __init(fetch(wasmUrl));
// ...
```

### `<script type="module">` (no bundler)

```html
<script type="module">
  import { __init, createCanvas } from 'https://esm.sh/simdra/wasm';
  await __init(fetch('https://esm.sh/simdra/wasm/simdra.wasm'));

  const canvas = createCanvas(400, 300);
  // ...
</script>
```

simdra uses WASM SIMD (`v128`). All evergreen browsers (Chrome 91+, Firefox 89+, Safari 16.4+) support it; `__init` will throw on engines that don't.

---

## Web Worker (browser)

Run the heavy work off the main thread. Each Worker compiles its own copy of the WASM module (cached by HTTP cache, so the second worker is fast).

```ts
// worker.ts (Vite entry, type: 'module')
import { __init, microsharp } from 'simdra/wasm';
import wasmUrl from 'simdra/wasm/simdra.wasm?url';
await __init(fetch(wasmUrl));

self.onmessage = async (e: MessageEvent) => {
  const { id, input, format, quality } = e.data;
  try {
    const out = await microsharp(input)[format](quality).toBuffer();
    self.postMessage({ id, ok: true, out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, err: String(err) });
  }
};
```

```ts
// main.ts
const worker = new Worker(
  new URL('./worker.ts', import.meta.url),
  { type: 'module' },
);

const id = crypto.randomUUID();
worker.postMessage({ id, input, format: 'jpeg', quality: 85 }, [input.buffer]);
worker.addEventListener('message', (e) => {
  if (e.data.id === id && e.data.ok) {
    // e.data.out is a Uint8Array
  }
});
```

For multiple concurrent encodes, pool N workers (`navigator.hardwareConcurrency` is a sensible default).

---

## Async semantics — in case you're wondering

The `microsharp` API is `async` *shaped* but does its work synchronously on the calling thread. The Promise resolves with the result — there's no event-loop yielding, no built-in worker offload. This keeps single-thread-first-class behaviour and matches sharp's signature (so code that imported `sharp` can swap to `microsharp` with no signature changes).

If you need real async (free the event loop while a heavy encode runs), use one of the runtime-specific patterns above:

- **Browser:** Web Worker (see Web Worker section).
- **Cloudflare Workers:** Service Binding to a separate isolate, or `ctx.waitUntil` for fire-and-forget.
- **Node:** `worker_threads` (the `simdra/core` build supports this).

---

## Troubleshooting

### `WebAssembly.compile() is not allowed` (Cloudflare Workers)

You called `__init(...)` instead of `__initSync(precompiledModule)`. CF Workers forbid runtime compile; switch to `__initSync` at module-init scope, importing the `.wasm` file directly.

### `WebAssembly.Module is not a constructor` (older browsers)

simdra requires WASM-SIMD (`v128`). Update to Chrome 91+, Firefox 89+, or Safari 16.4+.

### `Cannot find module 'simdra/wasm/simdra.wasm'`

Your bundler doesn't recognise `?url` imports or `.wasm` imports. Use `new URL(...)` + `import.meta.url` instead, or configure the asset plugin per the bundler's docs.

### Bundle size unexpectedly large

The `simdra/core` (Node native) entry pulls in `node-zigar`'s native loader. For browser/edge bundles, import only from `simdra/wasm`.

---

## Read next

- [Canvas 2D API](/canvas/api) — drawing, paths, transforms, text, images, encoding.
- [MicroSharp API](/microsharp/api) — pipeline, terminals, all 22 image-ops methods.
- [Compatibility matrix](/canvas/compatibility) — HTML5 + sharp spec coverage.
