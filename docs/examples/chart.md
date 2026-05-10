---
title: Bar chart from JSON
description: Worker endpoint that takes a JSON payload and returns a bar-chart PNG.
weight: 17
---

# Bar chart from JSON (Canvas 2D)

Render a labelled bar chart from a JSON payload. The "build a chart in a Worker without `chart.js`, `d3-node`, or a headless browser" pattern. ~5 ms to render a 800×500 chart with 10 bars at the edge.

## What it covers

- Drawing axes, gridlines, tick labels.
- Bar rendering with a vertical gradient.
- Auto-scaling the y-axis with sensible nice numbers.
- Multi-line title block and value labels above each bar.
- JSON-in / PNG-out in a single Worker handler.

## Full code

```ts
// src/index.ts
import { __initSync, createCanvas } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

interface ChartPayload {
  title: string;
  subtitle?: string;
  labels: string[];
  values: number[];
  units?: string;       // 'USD', 'ms', '%' — appended to value labels
  accent?: string;      // bar gradient top colour
  background?: string;
  width?: number;       // default 800
  height?: number;      // default 500
}

const DEFAULT_W = 800;
const DEFAULT_H = 500;
const PAD = { top: 90, right: 32, bottom: 70, left: 56 };

// Find a "nice" round step size for the y-axis grid given the data range.
function niceStep(range: number, targetTicks = 5): number {
  const rough = range / targetTicks;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / power;
  if (norm < 1.5) return 1 * power;
  if (norm < 3.5) return 2 * power;
  if (norm < 7.5) return 5 * power;
  return 10 * power;
}

function fmtValue(v: number, units?: string): string {
  const formatted = Number.isInteger(v)
    ? v.toLocaleString('en-US')
    : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return units ? `${formatted} ${units}` : formatted;
}

function renderChart(p: ChartPayload): Uint8Array {
  const W = p.width ?? DEFAULT_W;
  const H = p.height ?? DEFAULT_H;
  const accent = p.accent ?? '#3b82f6';
  const bg = p.background ?? '#ffffff';

  if (p.labels.length !== p.values.length || p.values.length === 0) {
    throw new Error('labels and values must be non-empty arrays of equal length');
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Y-axis range — nice steps from 0 (or below if values are negative)
  const dataMax = Math.max(...p.values);
  const dataMin = Math.min(...p.values, 0);
  const step = niceStep(dataMax - dataMin || 1, 5);
  const yMax = Math.ceil(dataMax / step) * step;
  const yMin = Math.floor(dataMin / step) * step;

  const plotX = PAD.left;
  const plotY = PAD.top;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const yToPx = (v: number) => plotY + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Title
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 22px sans-serif';
  ctx.fillText(p.title, PAD.left, 42);
  if (p.subtitle) {
    ctx.fillStyle = '#64748b';
    ctx.font = '400 14px sans-serif';
    ctx.fillText(p.subtitle, PAD.left, 64);
  }

  // Gridlines + y-axis tick labels
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '400 12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = yMin; v <= yMax + 1e-9; v += step) {
    const y = yToPx(v);
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();
    ctx.fillText(fmtValue(v, p.units), plotX - 8, y);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Bars
  const n = p.values.length;
  const slot = plotW / n;
  const barW = Math.min(64, slot * 0.65);

  for (let i = 0; i < n; i++) {
    const x = plotX + slot * i + (slot - barW) / 2;
    const yTop = yToPx(p.values[i]);
    const yZero = yToPx(0);
    const h = Math.abs(yTop - yZero);
    const top = Math.min(yTop, yZero);

    // Vertical gradient inside each bar
    const grad = ctx.createLinearGradient(0, top, 0, top + h);
    grad.addColorStop(0, accent);
    grad.addColorStop(1, shade(accent, -0.3));    // darken at the bottom
    ctx.fillStyle = grad;
    ctx.fillRect(x, top, barW, h);

    // Value label above the bar
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(fmtValue(p.values[i], p.units), x + barW / 2, top - 8);

    // X-axis label below the chart area
    ctx.fillStyle = '#475569';
    ctx.font = '400 12px sans-serif';
    ctx.fillText(p.labels[i], x + barW / 2, plotY + plotH + 22);
    ctx.textAlign = 'left';
  }

  // Axis lines
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(plotX, plotY);
  ctx.lineTo(plotX, plotY + plotH);
  ctx.lineTo(plotX + plotW, plotY + plotH);
  ctx.stroke();

  return canvas.toBytes();
}

// Lighten / darken a hex colour by a -1..1 factor.
function shade(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{3,8})$/i.exec(hex);
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const adj = (c: number) => {
    const t = factor < 0 ? 0 : 255;
    return Math.round(c + (t - c) * Math.abs(factor));
  };
  const ar = adj(r), ag = adj(g), ab = adj(b);
  return `#${[ar, ag, ab].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('POST a JSON chart payload', { status: 405 });
    }
    let payload: ChartPayload;
    try {
      payload = (await req.json()) as ChartPayload;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    let png: Uint8Array;
    try {
      png = renderChart(payload);
    } catch (err) {
      return new Response(JSON.stringify({ error: (err as Error).message }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(png, {
      headers: { 'content-type': 'image/png' },
    });
  },
};
```

## Try it

```bash
curl -X POST https://simdra-chart.your-worker.dev/ \
  -H 'content-type: application/json' \
  -d '{
    "title": "Quarterly revenue",
    "subtitle": "FY2024",
    "labels": ["Q1","Q2","Q3","Q4"],
    "values": [120, 185, 240, 310],
    "units": "k USD",
    "accent": "#10b981"
  }' \
  -o chart.png
open chart.png
```

## Why these choices

- **`niceStep` for the y-axis** — without it, a chart with values up to 237 would have ugly tick labels like 47.4, 94.8, etc. Snapping to powers of 1/2/5 × 10ⁿ gives "nice" tick numbers (50, 100, 150, …).
- **Vertical gradient inside each bar** — adds depth without a third-party library. The `shade(accent, -0.3)` derives a darker stop from the user's accent colour automatically.
- **Value labels above bars** — clearer than hovering tooltips when the chart is rendered as a static PNG (no JS at the consumer).
- **`textAlign` / `textBaseline` instead of `measureText` math** — `measureText` only populates `width` in simdra; alignment via the spec attributes is portable and matches what browsers do.
- **Negative values supported** — `yMin = Math.floor(dataMin / step) * step` extends the axis below 0 if the data needs it. Bars draw downward from the zero line in that case.

## Extending

- **Stacked / grouped bars** — accept `values: number[][]` (one inner array per series), draw side-by-side or stacked.
- **Line chart variant** — replace the bar loop with a `Path2D` + `lineTo`, then `ctx.stroke()`. Optional area fill via `ctx.fillStyle` between the line and `yZero`.
- **Pie / donut chart** — `ctx.arc()` for each slice, label outside via `Math.cos`/`Math.sin` from the slice midpoint angle.
- **Data labels with units in the y-axis** — pass `units: 'USD'` and the y-axis ticks become `100 USD, 200 USD, …`.
- **Brand font** — register a TTF with `createCanvas(w, h, { fonts: [{ name: 'Brand', data: ttf }] })`, then `ctx.font = '600 12px Brand'`.
- **Chart on Vercel Edge / Deno** — same code, swap `__initSync(wasm)` for `await __init(fetch(wasmUrl))`. See [Installation](/installation).
