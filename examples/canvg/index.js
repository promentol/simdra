// Render an SVG to PNG using canvg on top of simdra.
//
// Run from the project root:
//   pnpm add -D canvg @xmldom/xmldom node-fetch
//   node --loader=node-zigar --no-warnings examples/canvg/index.js
//
// canvg's `presets.node` expects a node-canvas-shaped module — i.e. an
// object with `createCanvas(w, h)`. simdra's `createCanvas` matches that
// signature directly, so we hand canvg a thin shim. SVG `<image>` elements
// that reference raster bitmaps would also need an `Image` class; this
// example sticks to vector-only SVGs so the shim stays minimal.

import { promises as fs } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import fetch from 'node-fetch';
import { Canvg, presets } from 'canvg';

import { createCanvas } from '../../src/index.ts';

const preset = presets.node({
  DOMParser,
  canvas: { createCanvas },
  fetch,
});

(async (output, input) => {
  const svg = await fs.readFile(input, 'utf8');
  const canvas = preset.createCanvas(800, 600);
  const ctx = canvas.getContext('2d');
  const v = Canvg.fromString(ctx, svg, preset);

  // Render only the first frame, ignoring animations.
  await v.render();

  await fs.writeFile(output, canvas.toBytes());
})(
  new URL('./example.png', import.meta.url),
  new URL('./example.svg', import.meta.url),
);
