---
title: Canvas2D API
description: HTML5 Canvas drawing API — Canvas, CanvasRenderingContext2D, Path2D, Image, ImageData.
weight: 20
---

simdra's Canvas2D surface mirrors the [HTML5 Canvas WebIDL](https://html.spec.whatwg.org/multipage/canvas.html) closely. If you've worked with `<canvas>` or `@napi-rs/canvas`, the API is familiar. Spec divergences are listed in [Compatibility](./compatibility).

## Construction

```ts
import { createCanvas, Canvas } from 'simdra';

const c = createCanvas(800, 600);          // factory (preferred)
const c2 = new Canvas(800, 600);            // class form, equivalent

// Optional: bundle custom fonts in the constructor.
const c3 = createCanvas(800, 600, {
  fonts: [
    { name: 'Inter', data: interTtfBytes },
    { name: 'Inter', data: interBoldBytes, weight: 700 },
  ],
});
```

`createCanvas(w, h)` returns a `Canvas`. Resizing via `canvas.width = N` reallocates to transparent black and resets the rendering-context state — same as the HTML5 spec.

## Getting a context

```ts
const ctx = canvas.getContext('2d');
```

Only `'2d'` is supported. `getContext('webgl')` etc. throw — simdra is a CPU rasterizer (see [Zig core](/zig/)).

## Drawing

### Rectangles

```ts
ctx.fillStyle = '#03a9f4';
ctx.fillRect(10, 10, 100, 50);

ctx.strokeStyle = '#ff5722';
ctx.lineWidth = 2;
ctx.strokeRect(10, 10, 100, 50);

ctx.clearRect(20, 20, 80, 30);
```

### Paths

Paths support all HTML5 verbs: `moveTo`, `lineTo`, `bezierCurveTo`, `quadraticCurveTo`, `arc`, `arcTo`, `ellipse`, `roundRect`, `rect`. Both fill rules (`nonzero` / `evenodd`) are honored.

```ts
ctx.beginPath();
ctx.moveTo(50, 50);
ctx.lineTo(150, 50);
ctx.lineTo(100, 150);
ctx.closePath();
ctx.fill();          // 'nonzero' default
ctx.fill('evenodd');
ctx.stroke();
```

`Path2D` is supported as a standalone class:

```ts
import { Path2D } from 'simdra';

const path = new Path2D();
path.moveTo(0, 0);
path.lineTo(100, 100);
path.arc(50, 50, 30, 0, Math.PI * 2);

ctx.stroke(path);
ctx.fill(path, 'evenodd');
ctx.clip(path);
```

### Transforms

Standard CTM stack: `translate`, `rotate`, `scale`, `transform`, `setTransform`, `resetTransform`, `getTransform`. `save()` / `restore()` push/pop the full graphics state (transform, fillStyle, line dash, clip region, …).

```ts
ctx.save();
ctx.translate(100, 100);
ctx.rotate(Math.PI / 4);
ctx.fillRect(-50, -50, 100, 100);
ctx.restore();
```

### Gradients & patterns

```ts
const grad = ctx.createLinearGradient(0, 0, 200, 0);
grad.addColorStop(0, '#03a9f4');
grad.addColorStop(1, '#ff5722');
ctx.fillStyle = grad;
ctx.fillRect(0, 0, 200, 200);

const radial = ctx.createRadialGradient(100, 100, 10, 100, 100, 90);
const conic = ctx.createConicGradient(0, 100, 100);

const pattern = ctx.createPattern(image, 'repeat');
ctx.fillStyle = pattern;
ctx.fillRect(0, 0, 800, 600);
```

`createPattern` accepts `ImageData`, `Image`, or another `Canvas`.

### Text

```ts
ctx.font = 'bold 24px sans-serif';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillStyle = '#000';
ctx.fillText('Hello', 100, 50);

const m = ctx.measureText('Hello');
console.log(m.width);
```

The default `sans-serif` / `serif` / `monospace` / `system-ui` families resolve to a single bundled face (Manrope variable, ~162 KB, OFL 1.1). Bold and italic against the default are faux-synthesised — register a real bold/italic file via `createCanvas(..., { fonts: [...] })` or the top-level `registerFont(bytes, family, descriptor)` to fix that. See [Compatibility — fonts](./compatibility#fonts) for caveats.

## Images

### Decoding bytes into an `Image`

```ts
import { Image } from 'simdra';
import { readFileSync } from 'node:fs';

const img = Image.fromBytes(readFileSync('photo.jpg'));
console.log(img.width, img.height);

ctx.drawImage(img, 0, 0);
ctx.drawImage(img, 0, 0, 200, 150);                    // scale
ctx.drawImage(img, 100, 50, 200, 100, 0, 0, 400, 200); // sub-rect
```

`Image.fromBytes` accepts PNG / JPEG / BMP / GIF (first frame only). Format auto-detected via stb_image. The decoded buffer is owned by the `Image` for its lifetime and freed when the JS object is garbage-collected.

`drawImage` also accepts:

- `ImageData` — typically built via `ctx.createImageData(...)` or `ctx.getImageData(...)`.
- `Canvas` — another simdra canvas; pixels are snapshotted at draw time.

### `ImageData`

```ts
const id = ctx.getImageData(0, 0, 100, 100);
// id.data is a Uint8Array of RGBA bytes — mutable.
for (let i = 0; i < id.data.length; i += 4) {
  id.data[i + 3] = 128;  // halve alpha
}
ctx.putImageData(id, 0, 0);  // bypasses CTM / blend / alpha — spec-correct
```

`ImageData` is for *raw pixel access*. For decoded image sources prefer `Image` and `drawImage` — `putImageData` ignores the current transform, which is rarely what you want when displaying decoded content.

## Encoding

```ts
canvas.toBytes();                      // PNG, default
canvas.toBytes('image/jpeg', 0.85);    // JPEG, quality 0–1

canvas.toDataURL();                            // 'data:image/png;base64,...'
canvas.toDataURL('image/jpeg', 0.85);          // 'data:image/jpeg;base64,...'
```

Quality is the HTML5 0.0–1.0 range; clamped and rounded to stb's 1–100 internally. Default is 0.92 (Chromium default). Unrecognized MIME types fall back to PNG.

PNG output uses `stb_image_write`'s real DEFLATE compression. JPEG uses `stb_image_write`'s baseline encoder. WebP encoding is not implemented (no stb path). `toBlob` is not implemented in v0 — use `toBytes(...)` and wrap manually.

## Memory

simdra's Zig types own page-allocator buffers that node-zigar does not GC. The wrapper classes (`Canvas`, `ImageData`, `Image`, `Path2D`, `CanvasGradient`, `CanvasPattern`) register with `FinalizationRegistry`, so when the JS object becomes unreachable, the Zig buffer is freed. **You never call `.deinit()` or `.releaseImageData()`** — those are not part of the public API.
