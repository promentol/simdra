---
title: Compatibility
description: HTML5 Canvas spec coverage matrix.
weight: 60
---

Side-by-side coverage of the HTML5 Canvas WebIDL surface. Source of truth is [`COMPATIBILITY.md`](https://github.com/promentol/simdra/blob/main/COMPATIBILITY.md) and the per-interface specs under [`specs/`](https://github.com/promentol/simdra/tree/main/specs).

**Legend**

| Mark | Meaning |
|---|---|
| ✅ | Fully implemented per spec |
| 🟡 | Partial / accepted-but-different / spec divergence (see notes) |
| ❌ | Not implemented yet (planned) |
| ⛔ | Out of scope (DOM / Blob / MediaStream / encoder dependencies) |

## Summary

| Class | Browser | simdra | Headline gap |
|---|---|---|---|
| HTMLCanvasElement (`Canvas`) | ✅ | 🟡 | `toBlob` needs Node `Blob` shim; WebP encoder missing (no stb path); JPEG done via stb_image_write |
| CanvasRenderingContext2D | ✅ | ✅ | — |
| ImageData | ✅ | ✅ | Exposes `Uint8Array` instead of `Uint8ClampedArray`; `colorSpace` informational only |
| Image (`Image.fromBytes`) | ✅ (HTMLImageElement) | 🟡 | Sync `fromBytes` factory rather than `<img src=…> + onload`; no async loader, no DOM lifecycle |
| Path2D | ✅ | 🟡 | `Path2D(d)` SVG ctor; `arc`/`arcTo`/`ellipse`/`roundRect` on Path2D |
| DOMMatrix | ✅ | 🟡 | `setMatrixValue(transformList)` + string-form ctor (CSS parser out of scope) |
| CanvasGradient | ✅ | 🟡 | `createConicGradient` |
| CanvasPattern | ✅ | ✅ | — |
| TextMetrics | ✅ | 🟡 | Only `width` populated; bbox / baseline fields not implemented |
| OffscreenCanvas | ✅ | ❌ | Whole interface unimplemented (low priority — Node has no worker transfer) |

## HTMLCanvasElement (`Canvas`)

| Member | Browser | simdra | Notes |
|---|---|---|---|
| `width` | ✅ | ✅ | Read/write; assignment reallocates the bitmap (transparent black) and resets ctx state per spec |
| `height` | ✅ | ✅ | Same as `width` |
| `getContext('2d')` | ✅ | ✅ | Caches on first call; only `'2d'` supported |
| `getContext(type, attrs)` | ✅ | 🟡 | Attributes accepted and ignored |
| `toDataURL()` | ✅ | ✅ | Emits `image/png` |
| `toDataURL(type)` | ✅ | 🟡 | Recognizes `image/png` and `image/jpeg`; falls back to png for unrecognized types |
| `toDataURL(type, quality)` | ✅ | 🟡 | PNG + JPEG via stb_image_write; WebP still ⛔ (no stb path) |
| `toBlob(...)` | ✅ | ⛔ | Needs Node `Blob` shim; encode primitives are in place via `Canvas.toBytes(type, quality)` |
| `transferControlToOffscreen()` | ✅ | ⛔ | Browser worker transfer model |
| `captureStream()` | ✅ | ⛔ | MediaStream API |
| Event listeners (`contextlost`, …) | ✅ | ⛔ | DOM-only |

### simdra extensions (non-spec)

| Member | Notes |
|---|---|
| `Canvas.toBytes(type?, quality?)` | Same dispatch as `toDataURL` but skips the base64 round-trip |
| `Image.fromBytes(bytes)` | Decoded image source for `drawImage` / `createPattern`. Backed by stb_image (PNG / JPEG / BMP / GIF first frame). Browser-shaped helper but not the spec's HTMLImageElement (no `src` / `onload`; bytes go in synchronously) |
| `microsharp` named export | Sharp-shaped fluent surface on the same Zig core. Accepts `Uint8Array` / `ArrayBuffer` / `Blob` / `ReadableStream` / `Response` |
| `createCanvas(w, h, { fonts: [{ name, data, weight?, style? }] })` | Optional 3rd arg — pin custom faces at construction time |
| `registerFont(bytes, family, descriptor?)` | Top-level equivalent of the constructor's `fonts` option. Mirrors `node-canvas` / `@napi-rs/canvas` |

## Fonts

| | Browser | simdra |
|---|---|---|
| `ctx.font` shorthand | full CSS `font` shorthand | size + family + weight + style; `font-variant`, `font-stretch`, `font-size-adjust` accepted but no-op |
| Font registration | system fonts | embedded default (Manrope variable, ~162 KB, OFL 1.1) + `registerFont` for custom |
| Faux bold/italic | partial (Skia synthesises) | when no real face matches, faux-bold (1 px horizontal smear) + faux-italic (12° row shift) |
| `font-variant` (small-caps, etc.) | full | accepted, no effect |
| Variable axes (`wght`/`wdth`) | full | not yet wired (uses each axis's default instance) |
| Complex scripts (Arabic, Devanagari) | full | no shaping; latin / CJK punch-and-place only |

## Spec drift / known caveats

- **`ImageData.data`** is a `Uint8Array` view rather than `Uint8ClampedArray`. Mutation with out-of-range values *will not* be clamped on assignment — values are stored modulo 256. This will be fixed once node-zigar's typed-array marshalling supports clamped views.
- **Color spaces** (`colorSpace: 'display-p3'`) are accepted on the `ImageData` constructor and `getImageData(..., {colorSpace: ...})` but currently informational — all rasterization is sRGB.
- **`globalCompositeOperation`** supports the full Porter-Duff set; CSS-color-3 modes (`multiply`, `screen`, `overlay`, etc.) are implemented but slower than the Skia/Cairo equivalents pending SIMD-tuning.
- **Text shaping** is stb_truetype's punch-and-place — no kerning beyond the `kern` table, no GSUB ligatures, no BiDi, no complex script support. Latin and CJK are fine; everything else needs a real shaper (HarfBuzz integration is a roadmap item).

For the line-by-line view, see [`COMPATIBILITY.md`](https://github.com/promentol/simdra/blob/main/COMPATIBILITY.md) in the repo.
