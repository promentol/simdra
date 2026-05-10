---
title: Document / report renderer
description: Canvas 2D drawing — invoice / receipt / report layout in one PNG.
weight: 16
---

# Document / report renderer (Canvas 2D)

Render an invoice-style document to a single PNG using Canvas 2D primitives. This is the "build a PDF page in a Worker without Puppeteer or pdf-lib" pattern, except you get a PNG back. Wire it up to a printer (or convert to PDF client-side) once it looks right.

## What it covers

- Multi-section layout — header band, table, totals row, footer.
- Gradients, `Path2D`, fills + strokes.
- Text alignment (`textAlign`, `textBaseline`).
- Coordinate-based positioning with named constants for readability.
- Cloudflare Worker shape so this runs at the edge per request.

## Full code

```ts
// src/index.ts
import { __initSync, createCanvas } from 'simdra/wasm';
import wasm from 'simdra/wasm/simdra.wasm';
__initSync(wasm);

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
}

interface Invoice {
  number: string;
  issued_at: string;            // ISO date
  due_at: string;               // ISO date
  vendor: { name: string; address: string };
  customer: { name: string; address: string };
  items: LineItem[];
  currency: string;             // e.g. 'USD'
  notes?: string;
}

const PAGE_W = 800;
const PAGE_H = 1100;
const MARGIN = 56;
const COL_QTY = PAGE_W - MARGIN - 280;
const COL_UNIT = PAGE_W - MARGIN - 180;
const COL_TOTAL = PAGE_W - MARGIN;

function fmtMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function renderInvoice(inv: Invoice): Uint8Array {
  const canvas = createCanvas(PAGE_W, PAGE_H);
  const ctx = canvas.getContext('2d');

  // Page background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  // Header band — gradient stripe at top
  const headerH = 120;
  const grad = ctx.createLinearGradient(0, 0, PAGE_W, 0);
  grad.addColorStop(0, '#1e3a8a');
  grad.addColorStop(1, '#3b82f6');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, PAGE_W, headerH);

  // Header text — vendor name
  ctx.fillStyle = '#fff';
  ctx.font = '700 36px sans-serif';
  ctx.fillText(inv.vendor.name, MARGIN, 64);

  ctx.font = '400 16px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const [i, line] of inv.vendor.address.split('\n').entries()) {
    ctx.fillText(line, MARGIN, 90 + i * 20);
  }

  // Right side of header — invoice number + dates
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  ctx.font = '600 20px sans-serif';
  ctx.fillText(`Invoice #${inv.number}`, PAGE_W - MARGIN, 64);
  ctx.font = '400 14px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`Issued ${fmtDate(inv.issued_at)}`, PAGE_W - MARGIN, 90);
  ctx.fillText(`Due ${fmtDate(inv.due_at)}`, PAGE_W - MARGIN, 110);
  ctx.textAlign = 'left';

  // Bill-to block
  let y = headerH + 48;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 12px sans-serif';
  ctx.fillText('BILL TO', MARGIN, y);
  y += 24;
  ctx.fillStyle = '#0f172a';
  ctx.font = '600 18px sans-serif';
  ctx.fillText(inv.customer.name, MARGIN, y);
  y += 22;
  ctx.font = '400 14px sans-serif';
  ctx.fillStyle = '#475569';
  for (const line of inv.customer.address.split('\n')) {
    ctx.fillText(line, MARGIN, y);
    y += 18;
  }

  // Line-item table — header row
  y += 32;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 12px sans-serif';
  ctx.fillText('DESCRIPTION', MARGIN, y);
  ctx.textAlign = 'right';
  ctx.fillText('QTY', COL_QTY, y);
  ctx.fillText('UNIT', COL_UNIT, y);
  ctx.fillText('TOTAL', COL_TOTAL, y);
  ctx.textAlign = 'left';
  y += 8;

  // Underline
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(PAGE_W - MARGIN, y);
  ctx.stroke();
  y += 16;

  // Item rows
  ctx.fillStyle = '#0f172a';
  ctx.font = '400 15px sans-serif';
  let subtotal = 0;
  for (const item of inv.items) {
    const lineTotal = item.quantity * item.unit_price;
    subtotal += lineTotal;
    ctx.fillText(item.description, MARGIN, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#475569';
    ctx.fillText(String(item.quantity), COL_QTY, y);
    ctx.fillText(fmtMoney(item.unit_price, inv.currency), COL_UNIT, y);
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 15px sans-serif';
    ctx.fillText(fmtMoney(lineTotal, inv.currency), COL_TOTAL, y);
    ctx.font = '400 15px sans-serif';
    ctx.textAlign = 'left';
    y += 28;
  }

  // Totals box on the right
  y += 16;
  ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.moveTo(MARGIN, y);
  ctx.lineTo(PAGE_W - MARGIN, y);
  ctx.stroke();
  y += 28;

  const tax = subtotal * 0.08;
  const total = subtotal + tax;

  ctx.textAlign = 'right';
  ctx.fillStyle = '#475569';
  ctx.font = '400 14px sans-serif';
  ctx.fillText('Subtotal', COL_UNIT, y);
  ctx.fillStyle = '#0f172a';
  ctx.fillText(fmtMoney(subtotal, inv.currency), COL_TOTAL, y);
  y += 24;

  ctx.fillStyle = '#475569';
  ctx.fillText('Tax (8%)', COL_UNIT, y);
  ctx.fillStyle = '#0f172a';
  ctx.fillText(fmtMoney(tax, inv.currency), COL_TOTAL, y);
  y += 32;

  // Total — bold, separator above
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(COL_UNIT - 20, y - 18);
  ctx.lineTo(PAGE_W - MARGIN, y - 18);
  ctx.stroke();
  ctx.fillStyle = '#0f172a';
  ctx.font = '700 20px sans-serif';
  ctx.fillText('TOTAL', COL_UNIT, y);
  ctx.fillText(fmtMoney(total, inv.currency), COL_TOTAL, y);

  ctx.textAlign = 'left';

  // Footer / notes
  if (inv.notes) {
    ctx.fillStyle = '#475569';
    ctx.font = '400 13px sans-serif';
    const lines = inv.notes.match(/.{1,80}(\s|$)/g) ?? [inv.notes];
    let fy = PAGE_H - MARGIN - lines.length * 18 - 32;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 11px sans-serif';
    ctx.fillText('NOTES', MARGIN, fy);
    fy += 18;
    ctx.fillStyle = '#475569';
    ctx.font = '400 13px sans-serif';
    for (const line of lines) {
      ctx.fillText(line.trim(), MARGIN, fy);
      fy += 18;
    }
  }

  // Footer bottom rule
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(MARGIN, PAGE_H - MARGIN);
  ctx.lineTo(PAGE_W - MARGIN, PAGE_H - MARGIN);
  ctx.stroke();
  ctx.fillStyle = '#94a3b8';
  ctx.font = '400 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Generated ${new Date().toISOString().slice(0, 10)} • ${inv.vendor.name}`,
    PAGE_W / 2,
    PAGE_H - MARGIN + 18,
  );

  return canvas.toBytes();
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('POST a JSON invoice', { status: 405 });
    }
    let invoice: Invoice;
    try {
      invoice = (await req.json()) as Invoice;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    const png = renderInvoice(invoice);
    return new Response(png, {
      headers: {
        'content-type': 'image/png',
        'content-disposition': `attachment; filename="invoice-${invoice.number}.png"`,
      },
    });
  },
};
```

## Try it

```bash
curl -X POST https://simdra-invoice.your-worker.dev/ \
  -H 'content-type: application/json' \
  -d '{
    "number": "2024-0042",
    "issued_at": "2024-12-01",
    "due_at": "2024-12-31",
    "vendor": { "name": "Acme Inc", "address": "123 Market St\nSan Francisco, CA 94103" },
    "customer": { "name": "Globex Corp", "address": "456 Big St\nNew York, NY 10001" },
    "items": [
      { "description": "Annual licence — simdra Pro", "quantity": 1, "unit_price": 999 },
      { "description": "Onboarding hours", "quantity": 4, "unit_price": 250 },
      { "description": "Custom kernel work", "quantity": 8, "unit_price": 180 }
    ],
    "currency": "USD",
    "notes": "Thank you for your business. Payment due within 30 days. Wire details on file."
  }' \
  -o invoice.png
open invoice.png
```

## Why these choices

- **Single PNG instead of PDF** — simdra has no PDF encoder. PNG works for receipt printing, emailing, displaying in a UI. If you need a real PDF, generate the PNG here and wrap it with `pdf-lib` on the receiving end.
- **`textAlign`/`textBaseline` over `measureText`** — simpler code, the renderer handles the alignment math. `measureText` is exposed but only `width` is populated (not `actualBoundingBoxAscent`/etc.).
- **Manrope for `sans-serif`** — simdra ships an embedded Manrope variable TTF as the `sans-serif` fallback, so a Worker has a real font without needing to load anything. For brand fonts, register via `createCanvas(w, h, { fonts: [{ name: 'Brand', data: ttfBytes }] })`.
- **Constants for column positions** — laying out tables in immediate-mode drawing is fiddly; named constants (`COL_QTY`, `COL_UNIT`, `COL_TOTAL`) make the code legible and let designers tune the layout without grep-juggling magic numbers.

## Extending

- **Multi-page** — split `items` into chunks of 20 per page, render N canvases, return them concatenated as a PDF (with `pdf-lib`) or in a ZIP.
- **Letterhead** — `Image.fromBytes(letterheadPng)` and `ctx.drawImage` it into the header band.
- **QR code for payment** — bundle a QR encoder, render the matrix into the footer with `ctx.fillRect` per module.
- **Locale-aware money** — pass `locale` and `currency` from the request, use that for `Intl.NumberFormat`.
- **Right-to-left languages** — `ctx.direction = 'rtl'` works in spec but simdra's `direction` support is partial today. For now, render numbers/Latin in LTR and Hebrew/Arabic body text in a separate text canvas you composite.
