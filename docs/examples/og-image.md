---
title: Open Graph card generator
description: Cloudflare Worker that renders 1200×630 OG / Twitter cards from query params.
weight: 12
---

# Open Graph card generator (Cloudflare Worker)

Render dynamic Open Graph / Twitter Card images at the edge. Takes `?title=&subtitle=&accent=&theme=` and returns a `1200 × 630` PNG drawn entirely with Canvas 2D primitives — no headless browser, no Puppeteer, no Vercel-OG pinning. ~30–80 ms cold, ~5–15 ms warm per render.

## What it covers

- Canvas 2D drawing surface — gradients, text, `Path2D`, transforms.
- Multi-line text wrapping (since `ctx.fillText` doesn't wrap).
- Theme switching (light / dark).
- Aggressive CDN caching keyed by the query-param URL.

## Full code

```ts
// src/index.ts
import { __initSync, createCanvas } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

interface CardParams {
  title: string;
  subtitle: string;
  accent: string;        // hex / CSS colour
  theme: 'light' | 'dark';
}

function parseParams(url: URL): CardParams {
  const get = (k: string, fallback: string) =>
    url.searchParams.get(k) ?? fallback;
  return {
    title: get('title', 'Untitled'),
    subtitle: get('subtitle', ''),
    accent: get('accent', '#10b981'),
    theme: (get('theme', 'dark') === 'light' ? 'light' : 'dark'),
  };
}

const PALETTES = {
  dark: { bg: '#0f172a', bgGrad: '#1e293b', fg: '#f1f5f9', muted: '#94a3b8' },
  light: { bg: '#fafafa', bgGrad: '#e5e7eb', fg: '#0f172a', muted: '#64748b' },
};

// Wrap text into ≤ `maxLines` lines that fit in `maxWidth` at the given font.
function wrapText(
  ctx: any,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines - 1) {
        // last line — collect remainder, ellipsise if still too wide.
        const rest = words.slice(words.indexOf(w)).join(' ');
        let truncated = rest;
        while (ctx.measureText(truncated + '…').width > maxWidth && truncated.length > 1) {
          truncated = truncated.slice(0, -1);
        }
        lines.push(truncated.length === rest.length ? rest : truncated + '…');
        return lines;
      }
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function renderCard(p: CardParams): Uint8Array {
  const palette = PALETTES[p.theme];
  const W = 1200, H = 630;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Diagonal gradient background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, palette.bg);
  bg.addColorStop(1, palette.bgGrad);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Accent stripe down the left edge
  ctx.fillStyle = p.accent;
  ctx.fillRect(0, 0, 16, H);

  // Decorative dot grid in the lower right
  ctx.fillStyle = palette.accent ?? p.accent;
  ctx.globalAlpha = 0.25;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 8; col++) {
      ctx.beginPath();
      ctx.arc(W - 380 + col * 40, H - 100 + row * 18, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // "simdra" wordmark in the corner
  ctx.fillStyle = palette.muted;
  ctx.font = '500 24px sans-serif';
  ctx.fillText('simdra', 64, H - 56);

  // Subtitle (above title)
  if (p.subtitle) {
    ctx.fillStyle = p.accent;
    ctx.font = '600 28px sans-serif';
    ctx.fillText(p.subtitle.toUpperCase(), 64, 130);
  }

  // Title — multi-line, big
  ctx.fillStyle = palette.fg;
  ctx.font = '700 80px sans-serif';
  const lines = wrapText(ctx, p.title, W - 128 - 16, 3);
  let y = p.subtitle ? 230 : 200;
  for (const line of lines) {
    ctx.fillText(line, 64, y);
    y += 96;
  }

  return canvas.toBytes();
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const url = new URL(req.url);
    const params = parseParams(url);
    if (!params.title.trim()) {
      return badRequest('Provide a ?title=');
    }
    if (!/^#[0-9a-fA-F]{3,8}$/.test(params.accent) &&
        !/^[a-z]+$/.test(params.accent)) {
      return badRequest('?accent= must be a hex colour or CSS named colour');
    }

    const png = renderCard(params);
    return new Response(png, {
      headers: {
        'content-type': 'image/png',
        // Same URL → same image; cache aggressively.
        'cache-control': 'public, max-age=86400, s-maxage=31536000, immutable',
      },
    });
  },
};
```

## Deploy

```toml
# wrangler.toml
name = "simdra-og"
main = "src/index.ts"
compatibility_date = "2024-12-01"
```

```bash
wrangler deploy
```

## Use in your site's `<head>`

```html
<meta property="og:image"
      content="https://simdra-og.your-worker.dev/?title=Hello%20World&subtitle=Blog%20post&accent=%2310b981" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image"
      content="https://simdra-og.your-worker.dev/?title=Hello%20World&subtitle=Blog%20post&accent=%2310b981" />
```

## Try it

```bash
curl -o card.png \
  "https://simdra-og.your-worker.dev/?title=Build%20a%20better%20edge&subtitle=announcement&accent=%23f97316&theme=dark"
open card.png
```

## Why this beats `@vercel/og` for some shops

- **No React / JSX dependency** — pure Canvas 2D draws are easier to lock down for a brand template.
- **No Satori / Resvg** — Vercel-OG's pipeline runs an SVG path through Resvg, which is itself ~3 MB of WASM. simdra's whole bundle is ~500 KB.
- **No font loading dance** — uses simdra's embedded Manrope fallback for `sans-serif` out of the box. Bring your own TTF via `createCanvas(w, h, { fonts: [...] })` if you need a brand font.

## What you give up

- **No HTML / JSX layout.** If your designer thinks in flexbox, Vercel-OG's React component model is a better fit. simdra is "you draw the rectangles."
- **No emoji / complex script shaping.** Manrope is a Latin variable font; for emoji or CJK you'd need to register a fallback font with `createCanvas({ fonts: [...] })`.

## Extending

- **Custom fonts** — bake a brand TTF into the Worker (`import font from './brand.ttf'`) and pass it to `createCanvas(w, h, { fonts: [{ name: 'Brand', data: font }] })`.
- **Logo overlay** — fetch your logo PNG, decode via `Image.fromBytes(...)`, draw with `ctx.drawImage`.
- **Per-author themes** — extend `PALETTES` with named theme keys, look up by `?theme=author-1`.
- **HMAC-signed URLs** — verify the params with a signing key so attackers can't fill your cache with garbage.
