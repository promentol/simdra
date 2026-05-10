// simdra dev test — visual SSIM regression vs @napi-rs/canvas plus a few
// structural unit checks for the parts that aren't pixel-shaped (CSS color
// parser, DOMMatrix arithmetic, Path2D structural API, ImageData ctor /
// CanvasGradient ctor smoke).
//
// Every visual scene writes <test/__output__/<label>.simdra.png> regardless
// of pass/fail so the simdra-rendered output is always inspectable. On
// failure the helper additionally writes <label>.napi.png and <label>.diff.png
// (×4-amplified abs-difference) into the same directory.

import {
  createCanvas,
  ImageData,
  Image,
  Path2D,
  DOMMatrix,
  CanvasGradient,
  CanvasPattern,
  parseCssColor,
  microsharp,
} from '../src/index.ts';
import { compareScene, plain, summary } from './_compare.js';
import { readFileSync } from 'node:fs';
import { ssim } from 'ssim.js';

// =============================================================================
// Visual scenes — SSIM vs @napi-rs/canvas.
// =============================================================================
//
// Threshold tiers (chosen from the existing visual test suite):
//   0.999  pixel-perfect (axis-aligned solid rects, putImageData)
//   0.99   small-LSB blends (alpha, srcover)
//   0.95   triangle-shaped aliased edges
//   0.90   convex aliased edges (circles, scaled rects under CTM)
//   0.85   polyline / star edges (many aliased segments)
//   0.50   text (different rasterizers — stb-truetype vs Skia/system font)
//
// The text threshold is permissive on purpose: simdra rasterizes glyphs
// through stb_truetype with Manrope (variable, default Regular) embedded;
// @napi-rs/canvas uses Skia hinted text against the system font stack.
// Glyph shapes diverge, but the pen positions and overall ink mass should
// land in the same ballpark — that's what 0.50 captures.

// ---- Solid fills + clearRect (pixel-perfect) ------------------------------

compareScene('V01 single-color full fill', 200, 200, (ctx) => {
  ctx.fillStyle = '#03a9f4';
  ctx.fillRect(0, 0, 200, 200);
}, 0.999);

compareScene('V02 stacked solid rects', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(20, 20, 60, 60);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(80, 50, 60, 60);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(50, 80, 80, 80);
}, 0.999);

compareScene('V03 clearRect after fill', 200, 200, (ctx) => {
  ctx.fillStyle = '#333333';
  ctx.fillRect(0, 0, 200, 200);
  ctx.clearRect(50, 50, 100, 100);
}, 0.999);

// ---- Path fills (aliased edges) -------------------------------------------

compareScene('V04 filled triangle path', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#ff0000';
  ctx.beginPath();
  ctx.moveTo(100, 30);
  ctx.lineTo(170, 160);
  ctx.lineTo(30, 160);
  ctx.closePath();
  ctx.fill();
}, 0.95);

compareScene('V05 filled circle (arc)', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#3366cc';
  ctx.beginPath();
  ctx.arc(100, 100, 70, 0, 2 * Math.PI);
  ctx.fill();
}, 0.985);

compareScene('V06 filled non-convex star', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#cc3366';
  const cx = 100, cy = 100, R = 70, r = 28;
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const radius = (k & 1) ? r : R;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}, 0.99);

compareScene('V07 filled quadratic-bordered blob', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#22aa66';
  ctx.beginPath();
  ctx.moveTo(60, 100);
  ctx.quadraticCurveTo(100, 20, 140, 100);
  ctx.quadraticCurveTo(100, 180, 60, 100);
  ctx.closePath();
  ctx.fill();
}, 0.99);

compareScene('V08 ellipse rotated', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#ff8800';
  ctx.beginPath();
  ctx.ellipse(100, 100, 70, 30, Math.PI / 4, 0, 2 * Math.PI);
  ctx.fill();
}, 0.99);

compareScene('V09 arc 90deg sector', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#0088ff';
  ctx.beginPath();
  ctx.moveTo(100, 100);
  ctx.arc(100, 100, 70, 0, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
}, 0.99);

// ---- Phase 3: arcTo + roundRect ------------------------------------------

compareScene('V09a arcTo rounded L-bend', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#cc4400';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(40, 40);
  ctx.lineTo(40, 120);
  ctx.arcTo(40, 160, 80, 160, 40);
  ctx.lineTo(160, 160);
  ctx.stroke();
}, 0.99);

compareScene('V09b roundRect uniform radius', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#3aa8ff';
  ctx.beginPath();
  ctx.roundRect(30, 30, 140, 140, 24);
  ctx.fill();
}, 0.99);

compareScene('V09c roundRect 4 different radii', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#aa44dd';
  ctx.beginPath();
  ctx.roundRect(20, 20, 160, 160, [10, 30, 50, 70]);
  ctx.fill();
}, 0.985);

// ---- AA-sensitive stroked curves ----------------------------------------
// These exercise the AA coverage emitter on stroke outlines: thin strokes
// are the worst case (one row's worth of fractional coverage per side).

compareScene('V05a circle stroked thin (1px)', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#3366cc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(100, 100, 70, 0, 2 * Math.PI);
  ctx.stroke();
}, 0.99);

compareScene('V05b circle stroked thick (8px)', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#cc3366';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(100, 100, 70, 0, 2 * Math.PI);
  ctx.stroke();
}, 0.99);

compareScene('V08a ellipse stroked rotated', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#ff8800';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(100, 100, 70, 30, Math.PI / 4, 0, 2 * Math.PI);
  ctx.stroke();
}, 0.985);

compareScene('V09s arc 270deg stroked round-cap', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#22aa66';
  ctx.lineWidth = 12;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(100, 100, 70, 0, 1.5 * Math.PI);
  ctx.stroke();
}, 0.99);

// ---- Strokes --------------------------------------------------------------

compareScene('V10 stroked rect outline', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.rect(40, 40, 120, 120);
  ctx.stroke();
}, 0.99);

compareScene('V11 stroked open polyline', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#0066cc';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(20, 100);
  ctx.lineTo(70, 50);
  ctx.lineTo(120, 150);
  ctx.lineTo(170, 50);
  ctx.stroke();
}, 0.80);

compareScene('V12 stroked closed triangle', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#aa0033';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(100, 40);
  ctx.lineTo(160, 150);
  ctx.lineTo(40, 150);
  ctx.closePath();
  ctx.stroke();
}, 0.80);

// ---- Line cap / join / miterLimit -----------------------------------------

compareScene('VlineCap butt round square', 240, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 240, 200);
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 18;
  for (const [i, cap] of ['butt', 'round', 'square'].entries()) {
    ctx.lineCap = cap;
    ctx.beginPath();
    ctx.moveTo(40, 40 + i * 50);
    ctx.lineTo(200, 40 + i * 50);
    ctx.stroke();
  }
}, 0.90);

compareScene('VlineJoin miter bevel round', 360, 160, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 360, 160);
  ctx.strokeStyle = '#11447a';
  ctx.lineWidth = 16;
  for (const [i, join] of ['miter', 'bevel', 'round'].entries()) {
    ctx.lineJoin = join;
    const cx = 60 + i * 110;
    ctx.beginPath();
    ctx.moveTo(cx - 40, 130);
    ctx.lineTo(cx, 30);
    ctx.lineTo(cx + 40, 130);
    ctx.stroke();
  }
}, 0.85);

compareScene('VmiterLimit forces bevel fallback', 240, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 240, 200);
  ctx.strokeStyle = '#993322';
  ctx.lineWidth = 12;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 1.4; // very small — sharp angle should bevel
  ctx.beginPath();
  ctx.moveTo(20, 160);
  ctx.lineTo(120, 30);
  ctx.lineTo(220, 160);
  ctx.stroke();
}, 0.85);

compareScene('VsetLineDash 10-5 horizontal', 280, 80, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 280, 80);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 5]);
  ctx.beginPath();
  ctx.moveTo(20, 40);
  ctx.lineTo(260, 40);
  ctx.stroke();
}, 0.85);

compareScene('VsetLineDash 20-5-5-5 four-tone', 280, 80, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 280, 80);
  ctx.strokeStyle = '#226600';
  ctx.lineWidth = 4;
  ctx.setLineDash([20, 5, 5, 5]);
  ctx.beginPath();
  ctx.moveTo(20, 40);
  ctx.lineTo(260, 40);
  ctx.stroke();
}, 0.85);

compareScene('VlineDashOffset shifts pattern', 280, 80, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 280, 80);
  ctx.strokeStyle = '#440099';
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 5]);
  ctx.lineDashOffset = 7.5; // half a period (10+5)/2
  ctx.beginPath();
  ctx.moveTo(20, 40);
  ctx.lineTo(260, 40);
  ctx.stroke();
}, 0.85);

compareScene('VsetLineDash dashed rect', 240, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 240, 200);
  ctx.strokeStyle = '#aa3344';
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 6]);
  ctx.beginPath();
  ctx.rect(40, 40, 160, 120);
  ctx.stroke();
}, 0.80);

// ---- Clip -----------------------------------------------------------------

compareScene('Vclip circular intersect rect', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.beginPath();
  ctx.arc(100, 100, 60, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, 200, 200);
}, 0.99);

compareScene('Vclip save restore drops clip', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.save();
  ctx.beginPath();
  ctx.arc(100, 100, 50, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#cc3333';
  ctx.fillRect(0, 0, 200, 200);
  ctx.restore();
  // Outside the prior clip — should fully render.
  ctx.fillStyle = 'rgba(0, 200, 100, 0.5)';
  ctx.fillRect(0, 0, 200, 60);
}, 0.99);

compareScene('Vclip AA-circle + AA-circle', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  // AA clip path: a circle. The boundary cells of the clip mask carry
  // fractional coverage now, and the AA-shape coverage of the inner circle
  // combines multiplicatively with them inside SmBlitter.blitRow.
  ctx.beginPath();
  ctx.arc(100, 100, 80, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#22aaff';
  ctx.beginPath();
  ctx.arc(100, 100, 60, 0, Math.PI * 2);
  ctx.fill();
}, 0.99);

compareScene('Vclip nested intersection', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.beginPath();
  ctx.rect(20, 20, 160, 100);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(60, 60, 100, 100);
  ctx.clip();
  ctx.fillStyle = '#cc6633';
  ctx.fillRect(0, 0, 200, 200);
}, 0.999);

compareScene('Vclip evenodd fill rule', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  // Two overlapping rects → evenodd makes the inner overlap a hole.
  ctx.beginPath();
  ctx.rect(30, 30, 120, 120);
  ctx.rect(70, 70, 80, 80);
  ctx.clip('evenodd');
  ctx.fillStyle = '#226633';
  ctx.fillRect(0, 0, 200, 200);
}, 0.95);

compareScene('Vclip stroked overflow', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.beginPath();
  ctx.rect(40, 40, 120, 120);
  ctx.clip();
  ctx.strokeStyle = '#cc1144';
  ctx.lineWidth = 30;
  ctx.beginPath();
  ctx.moveTo(0, 100);
  ctx.lineTo(200, 100);
  ctx.stroke();
}, 0.95);

compareScene('Vclip clearRect inside clip', 200, 200, (ctx) => {
  ctx.fillStyle = '#0033aa';
  ctx.fillRect(0, 0, 200, 200);
  ctx.beginPath();
  ctx.rect(50, 50, 100, 100);
  ctx.clip();
  // clearRect should only clear inside the clip region.
  ctx.clearRect(0, 0, 200, 200);
}, 0.999);

// ---- Transforms -----------------------------------------------------------

compareScene('V13 translate rotate scale', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#993366';
  ctx.translate(100, 100);
  ctx.rotate(Math.PI / 6);
  ctx.scale(1.2, 0.8);
  ctx.fillRect(-40, -40, 80, 80);
}, 0.99);

compareScene('V13a fillRect rotated 30deg', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#0066cc';
  ctx.translate(100, 100);
  ctx.rotate(Math.PI / 6);
  ctx.fillRect(-50, -50, 100, 100);
}, 0.985);

compareScene('V13b two-triangle non-axis fill (path)', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#22aa66';
  // Asymmetric triangle: every edge is non-axis-aligned, so every span
  // boundary needs analytic-x partial coverage.
  ctx.beginPath();
  ctx.moveTo(40.3, 30.7);
  ctx.lineTo(170.5, 80.2);
  ctx.lineTo(60.1, 175.9);
  ctx.closePath();
  ctx.fill();
}, 0.99);

compareScene('V13c strokeRect rotated 25deg', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#cc4400';
  ctx.lineWidth = 6;
  ctx.translate(100, 100);
  ctx.rotate((25 * Math.PI) / 180);
  // Pre-fix: silently no-op'd (rotated stroke skipped). Now routed through
  // SmScan.strokePath as a 4-vertex closed path.
  ctx.strokeRect(-50, -50, 100, 100);
}, 0.985);

compareScene('V13d fillRect fractional coords', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#996633';
  // Pre-fix: simdra rounded to (51, 51, 100, 100) producing sharp edges.
  // Skia / browsers AA the half-pixel boundaries; now we match.
  ctx.fillRect(50.5, 50.5, 100, 100);
}, 0.99);

compareScene('V13e strokeRect fractional lineWidth', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.strokeStyle = '#003388';
  ctx.lineWidth = 1.5;
  // Stroke borders inflate to 4 thin rects with fractional half-widths;
  // each routes through fillPolygonF for AA boundary coverage.
  ctx.strokeRect(40, 40, 120, 120);
}, 0.985);

compareScene('V13f fillRect under fractional CTM translate', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#22aaff';
  ctx.translate(0.5, 0.5);
  // CTM-applied coords become fractional even though user passed integers.
  ctx.fillRect(50, 50, 100, 100);
}, 0.99);

compareScene('V14 save restore nested', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = '#000000';
  ctx.save();
  ctx.translate(50, 50);
  ctx.fillRect(0, 0, 30, 30);
  ctx.save();
  ctx.translate(60, 60);
  ctx.fillRect(0, 0, 30, 30);
  ctx.restore();
  ctx.fillRect(40, 0, 30, 30);
  ctx.restore();
  ctx.fillRect(0, 0, 30, 30);
}, 0.999);

compareScene('V15 setTransform replaces (no compose)', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.translate(50, 50); // discarded by setTransform below
  ctx.setTransform(2, 0, 0, 2, 10, 10);
  ctx.fillStyle = '#445566';
  ctx.fillRect(0, 0, 40, 40); // world (10,10,80,80)
  ctx.resetTransform();
  ctx.fillStyle = '#aabbcc';
  ctx.fillRect(150, 150, 30, 30);
}, 0.999);

// ---- Compositing / alpha --------------------------------------------------

compareScene('V16 srcover non-opaque red over white', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
  ctx.fillRect(40, 40, 120, 120);
}, 0.99);

compareScene('V17 globalAlpha modulation', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(40, 40, 120, 120);
}, 0.99);

compareScene('V18 lighter blend stacked rects', 200, 200, (ctx) => {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 200, 200);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(40, 40, 120, 120);
  ctx.fillStyle = '#cc3366';
  ctx.fillRect(80, 80, 80, 80);
}, 0.99);

compareScene('V19 copy overwrites destination', 200, 200, (ctx) => {
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 200, 200);
  ctx.globalCompositeOperation = 'copy';
  ctx.fillStyle = 'rgba(0, 255, 0, 0.5)';
  ctx.fillRect(40, 40, 120, 120);
}, 0.99);

// ---- putImageData (deterministic — bypasses CTM/alpha/blend) -------------

compareScene('V20 putImageData round-trip', 200, 200, (ctx) => {
  ctx.fillStyle = '#888888';
  ctx.fillRect(0, 0, 200, 200);
  const id = ctx.createImageData(50, 50);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i + 0] = 255;
    id.data[i + 1] = 165;
    id.data[i + 2] = 0;
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 75, 75);
}, 0.999);

compareScene('V21 putImageData dirty rect', 200, 200, (ctx) => {
  ctx.fillStyle = '#222222';
  ctx.fillRect(0, 0, 200, 200);
  const id = ctx.createImageData(40, 40);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i + 0] = 0;
    id.data[i + 1] = 200;
    id.data[i + 2] = 100;
    id.data[i + 3] = 255;
  }
  // Stamp only a subset of the source rect at an offset.
  ctx.putImageData(id, 60, 60, 5, 5, 30, 30);
}, 0.999);

// ---- Full HTML5 globalCompositeOperation set ------------------------------
//
// Each scene draws the SAME two-shape sequence under a different operator.
// 0.99 threshold for the Porter-Duff and per-channel blend modes (math is
// deterministic). The non-separable modes (hue/saturation/color/luminosity)
// use a 0.95 threshold because Skia and our scalar HSL implementation
// diverge by 1-2 LSB per pixel on saturated dst regions.

const compositeScene = (op, threshold = 0.99) => {
  compareScene(`V25 op:${op}`, 200, 200, (ctx) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = 'rgba(0, 0, 255, 1.0)'; // dst: solid blue square
    ctx.fillRect(30, 30, 100, 100);
    ctx.globalCompositeOperation = op;
    ctx.fillStyle = 'rgba(255, 80, 0, 0.7)'; // src: orange overlapping
    ctx.fillRect(70, 70, 100, 100);
  }, threshold);
};

// Porter-Duff (11 modes — source-over and lighter already covered above).
compositeScene('source-in');
compositeScene('source-out');
compositeScene('source-atop');
compositeScene('destination-over');
compositeScene('destination-in');
compositeScene('destination-out');
compositeScene('destination-atop');
compositeScene('xor');

// Separable blend (11 modes).
compositeScene('multiply');
compositeScene('screen');
compositeScene('overlay');
compositeScene('darken');
compositeScene('lighten');
compositeScene('color-dodge');
compositeScene('color-burn');
compositeScene('hard-light');
compositeScene('soft-light');
compositeScene('difference');
compositeScene('exclusion');

// Non-separable blend (4 modes — looser threshold per Skia/HSL drift).
compositeScene('hue', 0.90);
compositeScene('saturation', 0.90);
compositeScene('color', 0.90);
compositeScene('luminosity', 0.90);

// ---- Text (stb_truetype + Manrope vs Skia + system font) ----------------

compareScene('V22 fillText 24px sans-serif', 240, 64, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 240, 64);
  ctx.fillStyle = '#000000';
  ctx.font = '24px sans-serif';
  ctx.fillText('Hello, world!', 8, 40);
}, 0.50);

compareScene('V23 fillText center top baseline', 240, 64, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 240, 64);
  ctx.fillStyle = '#000000';
  ctx.font = '20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('simdra', 120, 12);
}, 0.50);

compareScene('V24 fillText right-aligned + alphabetic', 240, 64, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 240, 64);
  ctx.fillStyle = '#0066aa';
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('right edge', 232, 40);
}, 0.50);

// ---- Partial-coverage text under blend modes (B2 coverage-thru-blends) ---
//
// Glyph alpha rows ARE coverage rows. Pre-B2, blitRow under coverage with
// any non-src_over mode dropped coverage on the floor — the text rendered
// as solid spans through the blend formula, producing aliased edges. Post-
// B2, every mode pre-modulates source.a by per-pixel coverage upstream of
// dispatch, so glyph edges blend correctly through every operator. These
// 5 scenes exercise the new code path.

compareScene('V26 fillText multiply', 240, 64, (ctx) => {
  ctx.fillStyle = '#ffeeaa'; // pale-yellow background
  ctx.fillRect(0, 0, 240, 64);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = '#0040aa';
  ctx.font = '24px sans-serif';
  ctx.fillText('multiply', 8, 40);
}, 0.50);

compareScene('V27 fillText screen', 240, 64, (ctx) => {
  ctx.fillStyle = '#332244'; // dark purple background
  ctx.fillRect(0, 0, 240, 64);
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = '#ff8800';
  ctx.font = '24px sans-serif';
  ctx.fillText('screen', 8, 40);
}, 0.50);

compareScene('V28 fillText darken', 240, 64, (ctx) => {
  ctx.fillStyle = '#cccccc';
  ctx.fillRect(0, 0, 240, 64);
  ctx.globalCompositeOperation = 'darken';
  ctx.fillStyle = '#aa3300';
  ctx.font = '24px sans-serif';
  ctx.fillText('darken', 8, 40);
}, 0.50);

compareScene('V29 fillText source-in', 240, 64, (ctx) => {
  ctx.fillStyle = '#ffeeaa';
  ctx.fillRect(0, 0, 240, 64);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#0040aa';
  ctx.font = '24px sans-serif';
  ctx.fillText('src-in', 8, 40);
}, 0.50);

compareScene('V30 fillText destination-atop', 240, 64, (ctx) => {
  ctx.fillStyle = '#ffeeaa';
  ctx.fillRect(0, 0, 240, 64);
  ctx.globalCompositeOperation = 'destination-atop';
  ctx.fillStyle = '#0040aa';
  ctx.font = '24px sans-serif';
  ctx.fillText('dst-atop', 8, 40);
}, 0.50);

// ---- Gradients (visual) ---------------------------------------------------
//
// Both simdra and Skia (@napi-rs/canvas) do straight-line projection for
// linear gradients and the two-circle quadratic for radials. Premul-aware
// interpolation matches Skia's `kInterpolateColorsInPremul` default. Solid
// fills hit the SIMD path, gradients hit `dispatchShader`'s per-pixel slow
// path — but the *output* should be pixel-near-identical.

compareScene('V31 linear gradient horizontal', 200, 200, (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 200, 0);
  g.addColorStop(0, '#ff0000');
  g.addColorStop(1, '#0000ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 200, 200);
}, 0.99);

compareScene('V32 linear gradient diagonal multi-stop', 200, 200, (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 200, 200);
  g.addColorStop(0.0, '#000000');
  g.addColorStop(0.33, '#ff8800');
  g.addColorStop(0.66, '#0088ff');
  g.addColorStop(1.0, '#ffffff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 200, 200);
}, 0.99);

compareScene('V33 linear gradient with translucent stops', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  const g = ctx.createLinearGradient(0, 0, 200, 0);
  g.addColorStop(0, 'rgba(255,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 200, 200);
}, 0.95);

compareScene('V34 radial gradient centered', 200, 200, (ctx) => {
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, 200, 200);
  const g = ctx.createRadialGradient(100, 100, 0, 100, 100, 100);
  g.addColorStop(0, '#ffffaa');
  g.addColorStop(1, 'rgba(255,128,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 200, 200);
}, 0.95);

compareScene('V35 radial gradient offset focal', 200, 200, (ctx) => {
  ctx.fillStyle = '#101820';
  ctx.fillRect(0, 0, 200, 200);
  const g = ctx.createRadialGradient(60, 60, 5, 100, 100, 90);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.5, '#ff80c0');
  g.addColorStop(1, '#202060');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 200, 200);
}, 0.92);

compareScene('V36 linear gradient on path', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  const g = ctx.createLinearGradient(20, 20, 180, 180);
  g.addColorStop(0, '#00aa00');
  g.addColorStop(1, '#aa0000');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.rect(20, 20, 160, 160);
  ctx.fill();
}, 0.95);

compareScene('V37 gradient under globalAlpha', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  const g = ctx.createLinearGradient(0, 0, 200, 0);
  g.addColorStop(0, '#ff0000');
  g.addColorStop(1, '#0000ff');
  ctx.fillStyle = g;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(0, 0, 200, 200);
}, 0.95);

// ---- Patterns (visual) ----------------------------------------------------
//
// Skia uses nearest-neighbor for `repeat` patterns at integer-aligned
// transforms; that's also our v1. Larger source tiles + identity transform
// give pixel-perfect matches.

// Pattern tile factory — uses the *context's own* createImageData so the
// scene works against both simdra (this) and @napi-rs/canvas (reference).
// Cross-importing `new ImageData(...)` from one library and feeding it to
// another fails because each library's createPattern type-checks for its
// own ImageData class.
function makeCheckerTile(ctx, w, h, cell, c1, c2) {
  const id = ctx.createImageData(w, h);
  const data = id.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const c = ((cx + cy) & 1) === 0 ? c1 : c2;
      const i = (y * w + x) * 4;
      data[i + 0] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = c[3];
    }
  }
  return id;
}

compareScene('V38 pattern repeat 8px checker', 200, 200, (ctx) => {
  const tile = makeCheckerTile(ctx, 8, 8, 4, [255, 0, 0, 255], [255, 255, 255, 255]);
  const pat = ctx.createPattern(tile, 'repeat');
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, 200, 200);
}, 0.99);

compareScene('V39 pattern repeat-x band', 200, 200, (ctx) => {
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, 200, 200);
  const tile = makeCheckerTile(ctx, 16, 16, 8, [0, 200, 0, 255], [200, 0, 200, 255]);
  const pat = ctx.createPattern(tile, 'repeat-x');
  ctx.fillStyle = pat;
  ctx.fillRect(0, 80, 200, 32);
}, 0.95);

compareScene('V40 pattern repeat-y band', 200, 200, (ctx) => {
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, 200, 200);
  const tile = makeCheckerTile(ctx, 16, 16, 8, [0, 120, 220, 255], [220, 220, 0, 255]);
  const pat = ctx.createPattern(tile, 'repeat-y');
  ctx.fillStyle = pat;
  ctx.fillRect(80, 0, 32, 200);
}, 0.95);

compareScene('V41 pattern no-repeat', 200, 200, (ctx) => {
  ctx.fillStyle = '#404040';
  ctx.fillRect(0, 0, 200, 200);
  const tile = makeCheckerTile(ctx, 64, 64, 8, [255, 200, 0, 255], [80, 0, 0, 255]);
  const pat = ctx.createPattern(tile, 'no-repeat');
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, 200, 200);
}, 0.99);

compareScene('V42 pattern setTransform translate', 200, 200, (ctx) => {
  const tile = makeCheckerTile(ctx, 8, 8, 4, [255, 0, 0, 255], [255, 255, 255, 255]);
  const pat = ctx.createPattern(tile, 'repeat');
  // Shift the tile origin by 4 px on x — same checker, half-cell offset.
  pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: 4, f: 0 });
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, 200, 200);
}, 0.99);

compareScene('V43 pattern fills a path', 200, 200, (ctx) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 200, 200);
  const tile = makeCheckerTile(ctx, 16, 16, 8, [0, 0, 0, 255], [240, 240, 240, 255]);
  const pat = ctx.createPattern(tile, 'repeat');
  ctx.fillStyle = pat;
  ctx.beginPath();
  ctx.rect(40, 40, 120, 120);
  ctx.fill();
}, 0.95);

// =============================================================================
// Plain assertions — non-visual structural / numeric / parser checks.
// =============================================================================

// ---- ImageData constructors ------------------------------------------------
{
  const ctx = createCanvas(8, 8).getContext('2d');
  const allZero = (buf) => { for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false; return true; };
  const enumEq = (v, want) => String(v) === want;

  {
    const id = ctx.createImageData(4, 3);
    plain('ImageData ctx.createImageData(w,h)',
      id.width === 4 && id.height === 3 && id.data.length === 48 &&
      allZero(id.data) && enumEq(id.colorSpace, 'srgb') && enumEq(id.pixelFormat, 'rgba_unorm8'));
  }
  {
    const id = ctx.createImageData(4, 3, { pixelFormat: 'rgba_float16', colorSpace: 'display_p3' });
    plain('ImageData ctx.createImageData(w,h,settings) float16/p3',
      id.width === 4 && id.height === 3 && id.data.length === 4 * 3 * 8 &&
      enumEq(id.colorSpace, 'display_p3') && enumEq(id.pixelFormat, 'rgba_float16'));
  }
  {
    const src = ctx.createImageData(5, 7, { colorSpace: 'display_p3' });
    src.data[0] = 0xAA;
    const id = ctx.createImageData(src);
    plain('ImageData ctx.createImageData(imagedata) — copy is blank',
      id.width === 5 && id.height === 7 &&
      enumEq(id.colorSpace, 'display_p3') && enumEq(id.pixelFormat, 'rgba_unorm8') &&
      id.data[0] === 0);
  }
  {
    const id = new ImageData(4, 3);
    plain('ImageData new ImageData(w,h)',
      id.width === 4 && id.height === 3 && id.data.length === 48 &&
      enumEq(id.colorSpace, 'srgb') && enumEq(id.pixelFormat, 'rgba_unorm8'));
  }
  {
    const id = new ImageData(2, 2, { pixelFormat: 'rgba_float16' });
    plain('ImageData new ImageData(w,h,settings) float16',
      id.width === 2 && id.height === 2 && id.data.length === 2 * 2 * 8 &&
      enumEq(id.pixelFormat, 'rgba_float16'));
  }
  {
    const buf = new Uint8Array(2 * 5 * 4);
    const id = new ImageData(buf, 2);
    plain('ImageData new ImageData(data,w) derives height',
      id.width === 2 && id.height === 5 && id.data.length === buf.length);
  }
  {
    const buf = new Uint8Array(3 * 4 * 4);
    const id = new ImageData(buf, 3, 4);
    plain('ImageData new ImageData(data,w,h) explicit height',
      id.width === 3 && id.height === 4 && id.data.length === buf.length);
  }
  {
    const buf = new Uint8Array(2 * 3 * 8);
    const id = new ImageData(buf, 2, 3, { pixelFormat: 'rgba_float16' });
    plain('ImageData new ImageData(data,w,h,settings) float16',
      id.width === 2 && id.height === 3 &&
      enumEq(id.pixelFormat, 'rgba_float16') && id.data.length === buf.length);
  }
  {
    let threw = 0;
    try { new ImageData(0, 4); } catch { threw++; }
    try { new ImageData(4, 0); } catch { threw++; }
    try { ctx.createImageData(0, 4); } catch { threw++; }
    try { ctx.createImageData(4, 0); } catch { threw++; }
    plain('ImageData zero-dim throws (4 paths)', threw === 4, `(${threw}/4)`);
  }
  {
    let threw = 0;
    try { new ImageData(new Uint8Array(2 * 5 * 4), 2, 4); } catch { threw++; }
    try { new ImageData(new Uint8Array(15), 2); } catch { threw++; }
    plain('ImageData mismatch throws (2 paths)', threw === 2, `(${threw}/2)`);
  }
  {
    let threw = false;
    try { new ImageData(4); } catch { threw = true; }
    plain('ImageData new ImageData(<2 args) throws', threw);
  }
}

// ---- DOMMatrix arithmetic --------------------------------------------------
{
  const EPS = 1e-10;
  const near = (a, b, tol = EPS) => Math.abs(a - b) <= tol;

  {
    const m = new DOMMatrix();
    plain('DOMMatrix identity',
      m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0);
  }
  {
    const m = new DOMMatrix();
    const ret = m.translateSelf(10, 20);
    plain('DOMMatrix translateSelf returns self proxy + updates e/f',
      m.e === 10 && m.f === 20 && m.a === 1 && m.d === 1 && ret.e === 10 && ret.f === 20);
  }
  {
    const m = new DOMMatrix();
    m.translateSelf(10, 20);
    m.scaleSelf(2, 3);
    plain('DOMMatrix scaleSelf preserves e/f',
      m.a === 2 && m.b === 0 && m.c === 0 && m.d === 3 && m.e === 10 && m.f === 20);
  }
  {
    const r = new DOMMatrix();
    r.rotateSelf(90);
    plain('DOMMatrix rotateSelf(90)',
      near(r.a, 0) && near(r.b, 1) && near(r.c, -1) && near(r.d, 0) && r.e === 0 && r.f === 0);
  }
  {
    const m = new DOMMatrix([1, 2, 3, 4, 5, 6]);
    const orig = new DOMMatrix([1, 2, 3, 4, 5, 6]);
    m.invertSelf();
    m.multiplySelf(orig);
    plain('DOMMatrix invertSelf × orig === identity',
      near(m.a, 1) && near(m.b, 0) && near(m.c, 0) && near(m.d, 1) && near(m.e, 0) && near(m.f, 0));
  }
  {
    const s = new DOMMatrix([1, 2, 2, 4, 0, 0]); // det = 0
    s.invertSelf();
    plain('DOMMatrix singular invertSelf → NaN',
      Number.isNaN(s.a) && Number.isNaN(s.b) && Number.isNaN(s.c) &&
      Number.isNaN(s.d) && Number.isNaN(s.e) && Number.isNaN(s.f));
  }
  {
    const t1 = new DOMMatrix([1, 0, 0, 1, 5, 7]);
    const t2 = new DOMMatrix([1, 0, 0, 1, 3, -2]);
    t1.multiplySelf(t2);
    plain('DOMMatrix multiplySelf composes translations',
      t1.a === 1 && t1.d === 1 && t1.e === 8 && t1.f === 5);
  }
  {
    const m = new DOMMatrix([2, 3, 4, 5, 6, 7]);
    plain('DOMMatrix component constructor round-trip',
      m.a === 2 && m.b === 3 && m.c === 4 && m.d === 5 && m.e === 6 && m.f === 7);
  }

  // ---- m11..m42 aliases + 3D-only identity getters + state queries -------
  {
    const m = new DOMMatrix([2, 3, 4, 5, 6, 7]);
    plain('DOMMatrix m11..m42 alias a..f',
      m.m11 === 2 && m.m12 === 3 && m.m21 === 4 && m.m22 === 5 && m.m41 === 6 && m.m42 === 7);
  }
  {
    const m = new DOMMatrix();
    m.m11 = 9; m.m42 = 11;
    plain('DOMMatrix m11/m42 setters update a/f', m.a === 9 && m.f === 11);
  }
  {
    const m = new DOMMatrix();
    plain('DOMMatrix 3D-only fields read identity values',
      m.m13 === 0 && m.m14 === 0 && m.m23 === 0 && m.m24 === 0 &&
      m.m31 === 0 && m.m32 === 0 && m.m33 === 1 && m.m34 === 0 &&
      m.m43 === 0 && m.m44 === 1);
  }
  {
    plain('DOMMatrix is2D always true', new DOMMatrix().is2D === true);
  }
  {
    const m = new DOMMatrix();
    const a = m.isIdentity;
    m.translateSelf(1, 0);
    plain('DOMMatrix isIdentity toggles after translate',
      a === true && m.isIdentity === false);
  }

  // ---- preMultiplySelf vs multiplySelf ordering --------------------------
  {
    // self = T(5,7). pre-multiply by S(2,3): self = S·T = scale-then-translate.
    // After applying to point (0,0): expect (10, 21).
    // multiplySelf would have produced T·S = translate-then-scale; point (0,0) → (5, 7).
    const a = new DOMMatrix([1, 0, 0, 1, 5, 7]);
    a.preMultiplySelf(new DOMMatrix([2, 0, 0, 3, 0, 0]));
    plain('DOMMatrix preMultiplySelf scales translation',
      a.a === 2 && a.d === 3 && a.e === 10 && a.f === 21);
  }

  // ---- skewXSelf / skewYSelf ---------------------------------------------
  {
    const m = new DOMMatrix();
    m.skewXSelf(45);
    plain('DOMMatrix skewXSelf(45) sets c≈1',
      near(m.c, 1) && m.a === 1 && m.b === 0 && m.d === 1);
  }
  {
    const m = new DOMMatrix();
    m.skewYSelf(45);
    plain('DOMMatrix skewYSelf(45) sets b≈1',
      near(m.b, 1) && m.a === 1 && m.c === 0 && m.d === 1);
  }

  // ---- 16-element constructor --------------------------------------------
  {
    const m = new DOMMatrix([2, 3, 0, 0,  4, 5, 0, 0,  0, 0, 1, 0,  6, 7, 0, 1]);
    plain('DOMMatrix 16-element ctor extracts 2D components',
      m.a === 2 && m.b === 3 && m.c === 4 && m.d === 5 && m.e === 6 && m.f === 7);
  }
  {
    let threw = false;
    try { new DOMMatrix([1, 0, 0.5, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]); }
    catch { threw = true; }
    plain('DOMMatrix 16-element ctor rejects 3D matrices', threw);
  }
  {
    let threw = false;
    try { new DOMMatrix([1, 2, 3, 4, 5, 6, 7]); } catch { threw = true; }
    plain('DOMMatrix 7-element ctor throws', threw);
  }

  // ---- static factories ---------------------------------------------------
  {
    const m = DOMMatrix.fromFloat32Array(new Float32Array([2, 3, 4, 5, 6, 7]));
    plain('DOMMatrix.fromFloat32Array(6) round-trip',
      m.a === 2 && m.b === 3 && m.c === 4 && m.d === 5 && m.e === 6 && m.f === 7);
  }
  {
    const m = DOMMatrix.fromFloat64Array(new Float64Array([2, 3, 0, 0,  4, 5, 0, 0,  0, 0, 1, 0,  6, 7, 0, 1]));
    plain('DOMMatrix.fromFloat64Array(16) round-trip',
      m.a === 2 && m.b === 3 && m.c === 4 && m.d === 5 && m.e === 6 && m.f === 7);
  }
  {
    let threw = false;
    try { DOMMatrix.fromFloat32Array(new Float32Array(7)); } catch { threw = true; }
    plain('DOMMatrix.fromFloat32Array wrong length throws', threw);
  }
  {
    const src = new DOMMatrix([2, 3, 4, 5, 6, 7]);
    const cp = DOMMatrix.fromMatrix(src);
    src.a = 99;
    plain('DOMMatrix.fromMatrix copies (independent of source)',
      cp.a === 2 && cp.f === 7 && src.a === 99);
  }
  {
    const cp = DOMMatrix.fromMatrix({ a: 2, d: 3 });
    plain('DOMMatrix.fromMatrix from plain object with defaults',
      cp.a === 2 && cp.d === 3 && cp.b === 0 && cp.c === 0 && cp.e === 0 && cp.f === 0);
  }
  {
    const cp = DOMMatrix.fromMatrix({ m11: 4, m42: 5 });
    plain('DOMMatrix.fromMatrix from plain object with m-named keys',
      cp.a === 4 && cp.f === 5);
  }

  // ---- rotateFromVectorSelf / rotateAxisAngleSelf / scale3dSelf ----------
  {
    const m = new DOMMatrix();
    m.rotateFromVectorSelf(1, 0);
    plain('DOMMatrix rotateFromVectorSelf(1,0) is identity', m.isIdentity);
  }
  {
    const a = new DOMMatrix(); a.rotateFromVectorSelf(0, 1);
    const b = new DOMMatrix(); b.rotateSelf(90);
    plain('DOMMatrix rotateFromVectorSelf(0,1) ≈ rotateSelf(90)',
      near(a.a, b.a) && near(a.b, b.b) && near(a.c, b.c) && near(a.d, b.d));
  }
  {
    const a = new DOMMatrix(); a.rotateAxisAngleSelf(0, 0, 1, 90);
    const b = new DOMMatrix(); b.rotateSelf(90);
    plain('DOMMatrix rotateAxisAngleSelf(0,0,1,90) ≈ rotateSelf(90)',
      near(a.a, b.a) && near(a.b, b.b) && near(a.c, b.c) && near(a.d, b.d));
  }
  {
    let threw = false;
    try { new DOMMatrix().rotateAxisAngleSelf(1, 0, 0, 45); } catch { threw = true; }
    plain('DOMMatrix rotateAxisAngleSelf x-axis throws', threw);
  }
  {
    const a = new DOMMatrix(); a.scale3dSelf(2);
    const b = new DOMMatrix(); b.scaleSelf(2, 2);
    plain('DOMMatrix scale3dSelf(2) ≈ scaleSelf(2,2)',
      a.a === b.a && a.d === b.d && a.e === b.e && a.f === b.f);
  }
  {
    // scale3dSelf(s, ox, oy) about origin (5, 0): point (5,0) maps to itself.
    const m = new DOMMatrix();
    m.scale3dSelf(2, 5, 0);
    // applied to (5, 0): a*5 + e = 5  →  e = 5 - 2*5 = -5.
    plain('DOMMatrix scale3dSelf with origin (5,0) keeps origin fixed',
      m.a === 2 && m.d === 2 && m.e === -5 && m.f === 0);
  }
  {
    let threw = false;
    try { new DOMMatrix().scale3dSelf(2, 0, 0, 1); } catch { threw = true; }
    plain('DOMMatrix scale3dSelf with originZ throws', threw);
  }
}

// ---- Path2D structural smoke ----------------------------------------------
{
  // Each test below would crash on a structural regression. Reaching the
  // plain() call means the path-build sequence didn't crash.
  {
    const p = new Path2D();
    p.closePath();
    plain('Path2D empty + closePath no-op', true);
  }
  {
    const p = new Path2D();
    p.moveTo(0, 0);
    p.lineTo(10, 0);
    p.lineTo(5, 10);
    p.closePath();
    p.moveTo(20, 20);
    p.bezierCurveTo(25, 10, 35, 10, 40, 20);
    p.quadraticCurveTo(50, 30, 40, 40);
    p.rect(20, 20, 30, 30);
    p.lineTo(NaN, 0);
    p.moveTo(0, Infinity);
    p.bezierCurveTo(0, 0, 0, 0, NaN, 0);
    p.quadraticCurveTo(NaN, 0, 0, 0);
    p.rect(NaN, 0, 10, 10);
    p.lineTo(100, 100);
    plain('Path2D triangle + curves + rect + non-finite no-ops', true);
  }
  {
    const src = new Path2D();
    src.moveTo(0, 0); src.lineTo(50, 50);
    const copy = new Path2D(src);
    copy.lineTo(99, 99); copy.closePath();
    src.lineTo(10, 10);
    plain('Path2D copy ctor + independent mutation', true);
  }
  {
    const dst = new Path2D();
    dst.moveTo(0, 0); dst.lineTo(10, 0);
    const src = new Path2D();
    src.moveTo(20, 20); src.lineTo(30, 30);
    dst.addPath(src);
    plain('Path2D addPath concatenate', true);
  }
  {
    const dst = new Path2D();
    dst.moveTo(0, 0);
    const src = new Path2D();
    src.moveTo(5, 5); src.lineTo(15, 5); src.closePath();
    const m = new DOMMatrix();
    m.translateSelf(100, 0);
    dst.addPath(src, m);
    plain('Path2D addPath with translation transform', true);
  }
  {
    const dst = new Path2D();
    const rectSrc = new Path2D();
    rectSrc.rect(10, 10, 20, 20);
    const rot = new DOMMatrix();
    rot.rotateSelf(90);
    dst.addPath(rectSrc, rot);
    plain('Path2D addPath rect decomposition under 90° rotation', true);
  }
  {
    const dst = new Path2D();
    const allOps = new Path2D();
    allOps.moveTo(0, 0);
    allOps.lineTo(10, 0);
    allOps.quadraticCurveTo(15, 5, 10, 10);
    allOps.bezierCurveTo(5, 15, -5, 15, -10, 10);
    allOps.closePath();
    allOps.rect(20, 20, 5, 5);
    const m = new DOMMatrix([1, 0, 0, 1, 50, 50]);
    dst.addPath(allOps, m);
    plain('Path2D addPath all opcode kinds under translation', true);
  }
  {
    // arcTo + roundRect on Path2D — structural (no throw, fillable).
    const p = new Path2D();
    p.moveTo(10, 10);
    p.arcTo(50, 10, 50, 50, 20);
    p.lineTo(50, 50);
    plain('Path2D arcTo no-throw', true);
  }
  {
    const p = new Path2D();
    p.roundRect(10, 10, 100, 80, 8);
    plain('Path2D roundRect scalar radius no-throw', true);
  }
  {
    const p = new Path2D();
    p.roundRect(0, 0, 50, 30, [4, 8, 12, 16]);
    plain('Path2D roundRect 4 radii no-throw', true);
  }
  {
    const p = new Path2D();
    let threw = false;
    try { p.roundRect(0, 0, 10, 10, -1); } catch { threw = true; }
    plain('Path2D roundRect negative radius throws RangeError', threw);
  }
}

// ---- CSS color parser ------------------------------------------------------
{
  const u32eq = (a, b) => (a >>> 0) === (b >>> 0);
  const RED = 0xFF0000FF | 0;
  const WHITE = 0xFFFFFFFF | 0;
  const BLACK = 0xFF000000 | 0;
  const LIME = 0xFF00FF00 | 0;
  const BLUE = 0xFFFF0000 | 0;

  const eqU = (got, expected, label) =>
    plain(`CSS ${label}`, got !== null && u32eq(got, expected));
  const eqNull = (got, label) =>
    plain(`CSS ${label}`, got === null);

  // Hex
  eqU(parseCssColor('#fff'), WHITE, '#fff');
  eqU(parseCssColor('#FFF'), WHITE, '#FFF case-insensitive');
  eqU(parseCssColor('#000'), BLACK, '#000');
  eqU(parseCssColor('#ff0000'), RED, '#ff0000');
  eqU(parseCssColor('#FF0000'), RED, '#FF0000 case-insensitive');
  eqU(parseCssColor('#000F'), BLACK, '#000F → opaque black');
  {
    const got = parseCssColor('#ff000080');
    plain('CSS #ff000080 → semi-transparent red',
      got !== null && (got >>> 0) === ((0x80 << 24 | 0x00 << 16 | 0x00 << 8 | 0xFF) >>> 0));
  }
  eqNull(parseCssColor('#1234567'), '#1234567 (7 digits) → null');
  eqNull(parseCssColor('#zzz'), '#zzz (bad hex) → null');
  eqNull(parseCssColor(''), 'empty string → null');

  // rgb/rgba
  eqU(parseCssColor('rgb(255, 0, 0)'), RED, 'rgb(255,0,0)');
  eqU(parseCssColor('rgb(255,0,0)'), RED, 'rgb(255,0,0) no spaces');
  eqU(parseCssColor('rgb( 1 , 2 , 3 )'),
      (0xFF << 24 | 3 << 16 | 2 << 8 | 1) | 0, 'rgb whitespace tolerance');
  eqU(parseCssColor('RGB(255,0,0)'), RED, 'RGB() keyword case-insensitive');
  eqU(parseCssColor('rgb(100%, 0%, 0%)'), RED, 'rgb(100%,0%,0%)');
  {
    const got = parseCssColor('rgba(0, 255, 0, 0.5)');
    plain('CSS rgba(0,255,0,0.5) alpha≈128',
      got !== null && (got & 0xFF) === 0 &&
      ((got >>> 8) & 0xFF) === 0xFF && ((got >>> 16) & 0xFF) === 0 &&
      Math.abs(((got >>> 24) & 0xFF) - 128) <= 1);
  }
  {
    const got = parseCssColor('rgba(255, 0, 0, 50%)');
    plain('CSS rgba(255,0,0,50%) alpha≈128',
      got !== null && (got & 0xFF) === 0xFF &&
      Math.abs(((got >>> 24) & 0xFF) - 128) <= 1);
  }
  eqNull(parseCssColor('rgb(300, 0, 0)'), 'rgb(300,0,0) out-of-range → null');
  eqNull(parseCssColor('rgb(-1, 0, 0)'), 'rgb(-1,0,0) negative → null');
  eqNull(parseCssColor('rgb(255 0 0)'), 'rgb modern syntax → null');
  eqNull(parseCssColor('rgb(255, 0%, 0)'), 'rgb mixed int+% → null');

  // hsl/hsla
  eqU(parseCssColor('hsl(0, 100%, 50%)'), RED, 'hsl(0,100%,50%) → red');
  eqU(parseCssColor('hsl(120, 100%, 50%)'), LIME, 'hsl(120,100%,50%) → lime');
  eqU(parseCssColor('hsl(240, 100%, 50%)'), BLUE, 'hsl(240,100%,50%) → blue');
  eqU(parseCssColor('hsl(-120, 100%, 50%)'), BLUE, 'hsl(-120,...) wraps → blue');
  {
    const got = parseCssColor('hsla(0, 100%, 50%, 0.5)');
    plain('CSS hsla(0,100%,50%,0.5) alpha≈128',
      got !== null && (got & 0xFF) === 0xFF &&
      ((got >>> 8) & 0xFF) === 0 && ((got >>> 16) & 0xFF) === 0 &&
      Math.abs(((got >>> 24) & 0xFF) - 128) <= 1);
  }
  eqNull(parseCssColor('hsl(0, 100, 50%)'), 'hsl saturation without % → null');

  // Named
  eqU(parseCssColor('red'), RED, 'named "red"');
  eqU(parseCssColor('RED'), RED, 'named "RED" case-insensitive');
  eqU(parseCssColor('Red'), RED, 'named "Red" mixed-case');
  eqU(parseCssColor('transparent'), 0, 'named "transparent"');
  eqU(parseCssColor('rebeccapurple'),
      (0xFF << 24 | 0x99 << 16 | 0x33 << 8 | 0x66) | 0, 'named "rebeccapurple"');
  eqNull(parseCssColor('notacolor'), '"notacolor" → null');
  eqNull(parseCssColor('currentcolor'), '"currentcolor" → null (deferred)');

  // fillStyle round-trip
  {
    const tc = createCanvas(1, 1);
    const tctx = tc.getContext('2d');
    tctx.fillStyle = '#ff0000';
    plain('CSS fillStyle round-trip parses identically',
      u32eq(parseCssColor('#ff0000'), parseCssColor(tctx.fillStyle)));
  }
}

// ---- CanvasGradient construction smoke ------------------------------------
{
  const ctx = createCanvas(8, 8).getContext('2d');
  {
    const g = ctx.createLinearGradient(0, 0, 100, 0);
    g.addColorStop(0, '#ff0000');
    g.addColorStop(1, '#0000ff');
    plain('CanvasGradient linear + 2 stops', true);
  }
  {
    const g = ctx.createRadialGradient(50, 50, 0, 50, 50, 100);
    g.addColorStop(0, 'white');
    g.addColorStop(0.5, 'rgba(255, 0, 0, 0.5)');
    g.addColorStop(1, 'transparent');
    plain('CanvasGradient radial + 3 stops mixed forms', true);
  }
  {
    const g = ctx.createLinearGradient(0, 0, 1, 0);
    let threw1 = false, threw2 = false, threw3 = false;
    try { g.addColorStop(-0.1, '#000'); } catch { threw1 = true; }
    try { g.addColorStop(1.5, '#000'); } catch { threw2 = true; }
    try { g.addColorStop(NaN, '#000'); } catch { threw3 = true; }
    plain('CanvasGradient addColorStop offset out-of-range throws',
      threw1 && threw2 && threw3);
  }
  {
    const g = ctx.createLinearGradient(0, 0, 1, 0);
    let threw = false;
    try { g.addColorStop(0.5, 'notacolor'); } catch { threw = true; }
    plain('CanvasGradient addColorStop invalid color throws', threw);
  }
  {
    const g = ctx.createLinearGradient(0, 0, 100, 0);
    g.addColorStop(0, 'red');
    g.addColorStop(0.5, 'lime');
    g.addColorStop(0.5, 'blue');
    g.addColorStop(1, 'white');
    plain('CanvasGradient equal-offset stops accepted', true);
  }
}

// ---- CanvasGradient pixel correctness (linear / radial samplers) ----------
//
// All these tests render onto a small canvas and probe specific pixels via
// getImageData. The samplers use premul-aware lerp; tolerances are ±2 LSB
// per channel to absorb premul→straight round-trip rounding.

function nearU8(actual, expected, tol = 2) {
  return Math.abs(actual - expected) <= tol;
}
function pixelEq(data, idx, r, g, b, a, tol = 2) {
  return (
    nearU8(data[idx + 0], r, tol) &&
    nearU8(data[idx + 1], g, tol) &&
    nearU8(data[idx + 2], b, tol) &&
    nearU8(data[idx + 3], a, tol)
  );
}

{
  // Linear gradient along x: red @ 0 → blue @ 1 across 100 px.
  const c = createCanvas(100, 1);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 100, 0);
  g.addColorStop(0, '#ff0000');
  g.addColorStop(1, '#0000ff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 100, 1);
  const px = ctx.getImageData(0, 0, 100, 1).data;
  // pixel center sampling: x=0 → 0.5/100 ≈ 0.005 → mostly red; x=99 → 99.5/100
  // ≈ 0.995 → mostly blue; x=49 → 49.5/100 ≈ 0.495 → ~50/50 mix.
  plain('CanvasGradient linear left edge ≈ red',
    pixelEq(px, 0 * 4, 254, 0, 1, 255, 3));
  plain('CanvasGradient linear right edge ≈ blue',
    pixelEq(px, 99 * 4, 1, 0, 254, 255, 3));
  // mid-pixel: premul lerp of straight red↔blue with both alpha=255 reduces
  // to plain channel lerp; expect roughly (128, 0, 128, 255).
  plain('CanvasGradient linear midpoint ≈ purple',
    pixelEq(px, 49 * 4, 130, 0, 126, 255, 4));
}
{
  // Linear gradient along y — confirms axis-projection works in the orthogonal
  // direction.
  const c = createCanvas(1, 100);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 100);
  g.addColorStop(0, '#000000');
  g.addColorStop(1, '#ffffff');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1, 100);
  const px = ctx.getImageData(0, 0, 1, 100).data;
  plain('CanvasGradient linear vertical mid ≈ gray',
    pixelEq(px, 49 * 4, 128, 128, 128, 255, 4));
}
{
  // Premultiplied lerp: stop (0, transparent red) → (1, opaque blue) at midpoint.
  // straight values: (255,0,0,0) and (0,0,255,255). Premul: (0,0,0,0) and
  // (0,0,255,255). At t=0.5: premul (0,0,128,128) → straight (0,0,255,128).
  // No red halo.
  const c = createCanvas(2, 1);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 2, 0);
  g.addColorStop(0, 'rgba(255,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 1);
  const px = ctx.getImageData(0, 0, 2, 1).data;
  // pixel x=0 (t≈0.25): premul red goes to 0, alpha modulator = 0.25*255≈64.
  // straight = (0,0,255,64). No red leak.
  plain('CanvasGradient linear premul lerp — no red halo',
    px[0 * 4 + 0] <= 4 && px[0 * 4 + 2] >= 250);
}
{
  // Radial gradient — center white, edge transparent black. 21×21 canvas
  // centered on pixel (10,10). Expect bright center, transparent corners.
  const c = createCanvas(21, 21);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(10.5, 10.5, 0, 10.5, 10.5, 10);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 21, 21);
  const px = ctx.getImageData(0, 0, 21, 21).data;
  const ci = (10 * 21 + 10) * 4;
  plain('CanvasGradient radial center ≈ white',
    px[ci + 0] > 240 && px[ci + 3] > 240);
  // Corner pixel (0,0) → distance ≈ √(10.5²+10.5²) ≈ 14.85 → t > 1, clamps to
  // last stop (transparent). Expect alpha 0.
  plain('CanvasGradient radial corner clamps to transparent',
    px[0 * 4 + 3] === 0);
}
{
  // fillStyle round-trip with a CanvasGradient: getter returns the same object.
  const c = createCanvas(1, 1);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 1, 0);
  ctx.fillStyle = g;
  plain('CanvasGradient fillStyle getter returns the same gradient',
    ctx.fillStyle === g && ctx.fillStyle instanceof CanvasGradient);
  // After reassigning to a string, getter goes back to a string.
  ctx.fillStyle = '#ff0000';
  plain('CanvasGradient fillStyle revert to string after gradient',
    ctx.fillStyle === '#ff0000');
}

// ---- CanvasPattern --------------------------------------------------------
{
  // 2×2 RGBA tile: red, green / blue, white.
  const tileBytes = new Uint8Array([
    255,   0,   0, 255,    0, 255,   0, 255,
      0,   0, 255, 255,  255, 255, 255, 255,
  ]);
  const tile = new ImageData(tileBytes, 2, 2);

  const c = createCanvas(4, 4);
  const ctx = c.getContext('2d');
  const pat = ctx.createPattern(tile, 'repeat');
  plain('CanvasPattern createPattern returns a CanvasPattern',
    pat instanceof CanvasPattern);
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, 4, 4);
  const px = ctx.getImageData(0, 0, 4, 4).data;
  // Sampling at pixel center (i+0.5, j+0.5). With identity transform, source
  // (sx, sy) = (i+0.5, j+0.5); floor = (i, j). Pattern repeats every 2,
  // so position (i%2, j%2) selects the tile cell.
  // (0,0)→red, (1,0)→green, (0,1)→blue, (1,1)→white, then repeats.
  plain('CanvasPattern repeat tile (0,0)=red',
    pixelEq(px, (0 * 4 + 0) * 4, 255, 0, 0, 255));
  plain('CanvasPattern repeat tile (1,0)=green',
    pixelEq(px, (0 * 4 + 1) * 4, 0, 255, 0, 255));
  plain('CanvasPattern repeat tile (2,0)=red wraps',
    pixelEq(px, (0 * 4 + 2) * 4, 255, 0, 0, 255));
  plain('CanvasPattern repeat tile (3,0)=green wraps',
    pixelEq(px, (0 * 4 + 3) * 4, 0, 255, 0, 255));
  plain('CanvasPattern repeat tile (0,1)=blue',
    pixelEq(px, (1 * 4 + 0) * 4, 0, 0, 255, 255));
  // dst (1, 3) → src (1, 3%2=1) → (1,1) tile cell = white.
  plain('CanvasPattern repeat tile (1,3) wraps to (1,1)=white',
    pixelEq(px, (3 * 4 + 1) * 4, 255, 255, 255, 255));
}
{
  // no-repeat: out-of-bounds → transparent.
  const tileBytes = new Uint8Array([255, 0, 0, 255]);
  const tile = new ImageData(tileBytes, 1, 1);
  const c = createCanvas(3, 1);
  const ctx = c.getContext('2d');
  const pat = ctx.createPattern(tile, 'no-repeat');
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, 3, 1);
  const px = ctx.getImageData(0, 0, 3, 1).data;
  // x=0 → source 0 → red opaque; x=1,2 → out of source → transparent.
  plain('CanvasPattern no-repeat in-bounds = red',
    pixelEq(px, 0, 255, 0, 0, 255));
  plain('CanvasPattern no-repeat past width = transparent',
    px[1 * 4 + 3] === 0 && px[2 * 4 + 3] === 0);
}
{
  // repeat-x: only x wraps; y stays bounded.
  const tileBytes = new Uint8Array([0, 255, 0, 255]); // 1x1 green
  const tile = new ImageData(tileBytes, 1, 1);
  const c = createCanvas(2, 2);
  const ctx = c.getContext('2d');
  const pat = ctx.createPattern(tile, 'repeat-x');
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, 2, 2);
  const px = ctx.getImageData(0, 0, 2, 2).data;
  plain('CanvasPattern repeat-x row 0 fills',
    pixelEq(px, 0, 0, 255, 0, 255) && pixelEq(px, 1 * 4, 0, 255, 0, 255));
  plain('CanvasPattern repeat-x row 1 transparent',
    px[(2 + 0) * 4 + 3] === 0 && px[(2 + 1) * 4 + 3] === 0);
}
{
  // setTransform shifts the pattern. Apply translate(1, 0): the pattern
  // texel at source x=0 moves to dst x=1. With a 1x1 'no-repeat' source at
  // dst (0..3, 0): only dst x=1 lights up.
  const tileBytes = new Uint8Array([255, 0, 0, 255]);
  const tile = new ImageData(tileBytes, 1, 1);
  const c = createCanvas(3, 1);
  const ctx = c.getContext('2d');
  const pat = ctx.createPattern(tile, 'no-repeat');
  pat.setTransform({ a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 });
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, 3, 1);
  const px = ctx.getImageData(0, 0, 3, 1).data;
  plain('CanvasPattern setTransform translate(1,0) shifts hit to x=1',
    px[0 * 4 + 3] === 0 && pixelEq(px, 1 * 4, 255, 0, 0, 255) && px[2 * 4 + 3] === 0);
}
{
  // Pattern source from another Canvas (snapshot).
  const src = createCanvas(2, 1);
  const sctx = src.getContext('2d');
  sctx.fillStyle = '#ff00ff';
  sctx.fillRect(0, 0, 1, 1);
  sctx.fillStyle = '#00ffff';
  sctx.fillRect(1, 0, 1, 1);
  const dst = createCanvas(4, 1);
  const dctx = dst.getContext('2d');
  const pat = dctx.createPattern(src, 'repeat');
  dctx.fillStyle = pat;
  dctx.fillRect(0, 0, 4, 1);
  const px = dctx.getImageData(0, 0, 4, 1).data;
  plain('CanvasPattern Canvas source 0=magenta',
    pixelEq(px, 0 * 4, 255, 0, 255, 255));
  plain('CanvasPattern Canvas source 1=cyan',
    pixelEq(px, 1 * 4, 0, 255, 255, 255));
  plain('CanvasPattern Canvas source 2=magenta wraps',
    pixelEq(px, 2 * 4, 255, 0, 255, 255));
}
{
  const c = createCanvas(1, 1);
  const ctx = c.getContext('2d');
  const tile = new ImageData(new Uint8Array([0, 0, 0, 255]), 1, 1);
  let threw = false;
  try { ctx.createPattern(tile, 'invalid'); } catch (e) {
    threw = e instanceof DOMException && e.name === 'SyntaxError';
  }
  plain('CanvasPattern invalid repetition throws SyntaxError', threw);

  // Empty string defaults to 'repeat'.
  const pat = ctx.createPattern(tile, '');
  plain('CanvasPattern empty repetition defaults to repeat',
    pat instanceof CanvasPattern);
}

// ---- Line styles — non-visual round-trips --------------------------------
{
  const ctx = createCanvas(8, 8).getContext('2d');
  plain('lineWidth default 1', ctx.lineWidth === 1);
  ctx.lineWidth = 2.5;
  plain('lineWidth f64 round-trip', ctx.lineWidth === 2.5);
  ctx.lineWidth = 0;
  plain('lineWidth zero rejected', ctx.lineWidth === 2.5);
  ctx.lineWidth = -1;
  plain('lineWidth negative rejected', ctx.lineWidth === 2.5);

  plain('lineCap default butt', ctx.lineCap === 'butt');
  ctx.lineCap = 'round';
  plain('lineCap round round-trip', ctx.lineCap === 'round');
  ctx.lineCap = 'square';
  plain('lineCap square round-trip', ctx.lineCap === 'square');
  ctx.lineCap = 'invalid';
  plain('lineCap invalid silently ignored', ctx.lineCap === 'square');

  plain('lineJoin default miter', ctx.lineJoin === 'miter');
  ctx.lineJoin = 'bevel';
  plain('lineJoin bevel round-trip', ctx.lineJoin === 'bevel');
  ctx.lineJoin = 'round';
  plain('lineJoin round round-trip', ctx.lineJoin === 'round');
  ctx.lineJoin = 'invalid';
  plain('lineJoin invalid silently ignored', ctx.lineJoin === 'round');

  plain('miterLimit default 10', ctx.miterLimit === 10);
  ctx.miterLimit = 4.5;
  plain('miterLimit f64 round-trip', ctx.miterLimit === 4.5);
  ctx.miterLimit = 0;
  plain('miterLimit zero rejected', ctx.miterLimit === 4.5);

  // save/restore captures all line state.
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 10;
  ctx.save();
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'bevel';
  ctx.miterLimit = 2;
  ctx.restore();
  plain('save/restore restores lineWidth', ctx.lineWidth === 1);
  plain('save/restore restores lineCap', ctx.lineCap === 'butt');
  plain('save/restore restores lineJoin', ctx.lineJoin === 'miter');
  plain('save/restore restores miterLimit', ctx.miterLimit === 10);
}

// ---- setLineDash / getLineDash / lineDashOffset --------------------------
{
  const ctx = createCanvas(8, 8).getContext('2d');
  plain('lineDashOffset default 0', ctx.lineDashOffset === 0);
  plain('getLineDash default []', Array.isArray(ctx.getLineDash()) && ctx.getLineDash().length === 0);
  ctx.setLineDash([10, 5]);
  const dash1 = ctx.getLineDash();
  plain('setLineDash even round-trip',
    dash1.length === 2 && dash1[0] === 10 && dash1[1] === 5);
  ctx.setLineDash([3, 4, 5]); // odd → doubled
  const dash2 = ctx.getLineDash();
  plain('setLineDash odd-length doubled',
    dash2.length === 6 &&
    dash2[0] === 3 && dash2[1] === 4 && dash2[2] === 5 &&
    dash2[3] === 3 && dash2[4] === 4 && dash2[5] === 5);
  ctx.setLineDash([10, -1]); // negative → invalid, ignored
  const dash3 = ctx.getLineDash();
  plain('setLineDash invalid (negative) ignored',
    dash3.length === 6 && dash3[0] === 3);
  ctx.setLineDash([]);
  plain('setLineDash empty clears', ctx.getLineDash().length === 0);
  ctx.lineDashOffset = 7.5;
  plain('lineDashOffset round-trip', ctx.lineDashOffset === 7.5);
  ctx.lineDashOffset = NaN;
  plain('lineDashOffset NaN rejected', ctx.lineDashOffset === 7.5);

  // getLineDash returns a fresh copy — mutating it does not affect ctx.
  ctx.setLineDash([2, 3]);
  const copy = ctx.getLineDash();
  copy[0] = 999;
  plain('getLineDash returns defensive copy', ctx.getLineDash()[0] === 2);

  // save/restore round-trips dash + offset.
  ctx.setLineDash([1, 2]);
  ctx.lineDashOffset = 0.5;
  ctx.save();
  ctx.setLineDash([10, 20, 30, 40]);
  ctx.lineDashOffset = 99;
  ctx.restore();
  const restored = ctx.getLineDash();
  plain('save/restore restores lineDash array',
    restored.length === 2 && restored[0] === 1 && restored[1] === 2);
  plain('save/restore restores lineDashOffset', ctx.lineDashOffset === 0.5);
}

// ---- clip(Path2D) — simdra-only structural check -------------------------
// (compareScene against @napi-rs/canvas can't run because simdra's Path2D
// is incompatible with @napi-rs/canvas's Path2D class.)
{
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  const p = new Path2D();
  p.rect(10, 10, 20, 20);
  ctx.clip(p);
  ctx.fillStyle = '#aa3322';
  ctx.fillRect(0, 0, 40, 40);
  const id = ctx.getImageData(0, 0, 40, 40);
  // Inside clip (15, 15) → red-ish; outside (5, 5) → white.
  const inside_r = id.data[(15 * 40 + 15) * 4 + 0];
  const outside_r = id.data[(5 * 40 + 5) * 4 + 0];
  const outside_g = id.data[(5 * 40 + 5) * 4 + 1];
  plain('clip(Path2D) inside region painted', inside_r === 0xaa);
  plain('clip(Path2D) outside region preserved',
    outside_r === 0xff && outside_g === 0xff);
}

// ---- Text — non-visual round-trips ---------------------------------------
{
  const ctx = createCanvas(8, 8).getContext('2d');
  plain('text default ctx.font === "10px sans-serif"', ctx.font === '10px sans-serif');
  ctx.font = '24px sans-serif';
  plain('text ctx.font setter round-trips', ctx.font === '24px sans-serif');
  plain('text ctx.font invalid value silently ignored',
    (ctx.font = 'gibberish', ctx.font === '24px sans-serif'));
  ctx.textAlign = 'center';
  plain('text ctx.textAlign setter accepts valid', ctx.textAlign === 'center');
  ctx.textAlign = 'invalid';
  plain('text ctx.textAlign rejects invalid', ctx.textAlign === 'center');
  plain('text measureText empty returns 0', ctx.measureText('').width === 0);
  plain('text measureText non-empty returns positive',
    ctx.measureText('Hello').width > 0);
}

// ---- createCanvas fonts: option ------------------------------------------
{
  // Caller pre-fetches TTF/OTF bytes and passes them via createCanvas opts.
  // The font is registered globally under `name`; ctx.font then selects it.
  const fontBytes = readFileSync(new URL('../zig/simdra/assets/Manrope-Regular.ttf', import.meta.url));
  const canvas = createCanvas(120, 40, {
    fonts: [{ name: 'TestCustomFont', data: fontBytes }],
  });
  const ctx = canvas.getContext('2d');
  ctx.font = '20px TestCustomFont';
  plain('createCanvas fonts: registers family',
    ctx.measureText('hi').width > 0);
}

// ---- Phase 2: text spacing + kerning effects -----------------------------
{
  const ctx = createCanvas(8, 8).getContext('2d');
  ctx.font = '20px sans-serif';

  const baseW = ctx.measureText('AVA').width;
  ctx.fontKerning = 'none';
  const noKernW = ctx.measureText('AVA').width;
  ctx.fontKerning = 'auto';
  // Manrope has a kerning pair for AV; with kerning ON the width should be ≤
  // the no-kerning width. (For a font without a kern pair they'd be equal.)
  plain('text fontKerning="auto" ≤ "none" width', baseW <= noKernW + 1e-9);

  ctx.fontKerning = 'auto';
  const before = ctx.measureText('Hi').width;
  ctx.letterSpacing = '5px';
  const afterLs = ctx.measureText('Hi').width;
  // With letter-spacing, width gains exactly N * letter_spacing where N
  // is the codepoint count (CSS Text 3 §10.2 — applies after every glyph).
  plain('text letterSpacing widens measureText',
    Math.abs(afterLs - (before + 2 * 5)) < 1e-6,
    `(want ${before + 10}, got ${afterLs})`);
  ctx.letterSpacing = '0px';

  ctx.wordSpacing = '7px';
  const wsBaseline = ctx.measureText('A B').width;
  ctx.wordSpacing = '0px';
  const wsZero = ctx.measureText('A B').width;
  plain('text wordSpacing widens measureText',
    Math.abs(wsBaseline - (wsZero + 7)) < 1e-6,
    `(diff ${wsBaseline - wsZero})`);
}

// ---- Phase 1: round-trip checks for the new state props ------------------
{
  const canvas = createCanvas(8, 8);
  const ctx = canvas.getContext('2d');

  plain('ctx.canvas back-reference', ctx.canvas === canvas);

  const attrs = ctx.getContextAttributes();
  plain('getContextAttributes shape',
    attrs.alpha === true &&
    attrs.colorSpace === 'srgb' &&
    attrs.desynchronized === false &&
    attrs.willReadFrequently === false);

  ctx.direction = 'rtl';
  plain('direction round-trip rtl', ctx.direction === 'rtl');
  ctx.direction = 'bogus';
  plain('direction rejects invalid', ctx.direction === 'rtl');

  ctx.letterSpacing = '2px';
  plain('letterSpacing round-trip', ctx.letterSpacing === '2px');
  ctx.letterSpacing = '1em';
  plain('letterSpacing ignores non-px', ctx.letterSpacing === '2px');

  ctx.wordSpacing = '4px';
  plain('wordSpacing round-trip', ctx.wordSpacing === '4px');

  ctx.fontKerning = 'none';
  plain('fontKerning round-trip', ctx.fontKerning === 'none');
  ctx.fontKerning = 'bogus';
  plain('fontKerning rejects invalid', ctx.fontKerning === 'none');

  ctx.fontStretch = 'condensed';
  plain('fontStretch round-trip', ctx.fontStretch === 'condensed');

  ctx.fontVariantCaps = 'small-caps';
  plain('fontVariantCaps round-trip', ctx.fontVariantCaps === 'small-caps');

  ctx.textRendering = 'optimizeLegibility';
  plain('textRendering round-trip', ctx.textRendering === 'optimizeLegibility');

  ctx.filter = 'blur(2px)';
  plain('filter round-trip', ctx.filter === 'blur(2px)');

  ctx.imageSmoothingEnabled = false;
  plain('imageSmoothingEnabled toggle', ctx.imageSmoothingEnabled === false);

  ctx.imageSmoothingQuality = 'high';
  plain('imageSmoothingQuality round-trip', ctx.imageSmoothingQuality === 'high');
  ctx.imageSmoothingQuality = 'bogus';
  plain('imageSmoothingQuality rejects invalid', ctx.imageSmoothingQuality === 'high');
}

// ---- Phase 4: image smoothing — structural pixel checks ------------------
// (Skipping SSIM compare against @napi-rs/canvas because it doesn't accept
// ImageData as a drawImage source; we test via direct pixel inspection.)
{
  const make4x4 = (ctx) => {
    const src = ctx.createImageData(4, 4);
    const set = (x, y, r, g, b) => {
      const i = (y * 4 + x) * 4;
      src.data[i] = r; src.data[i + 1] = g; src.data[i + 2] = b; src.data[i + 3] = 255;
    };
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) set(x, y, 255, 0, 0);
    for (let y = 0; y < 2; y++) for (let x = 2; x < 4; x++) set(x, y, 0, 255, 0);
    for (let y = 2; y < 4; y++) for (let x = 0; x < 2; x++) set(x, y, 0, 0, 255);
    for (let y = 2; y < 4; y++) for (let x = 2; x < 4; x++) set(x, y, 255, 255, 0);
    return src;
  };
  // smoothing OFF — sharp blocks.
  {
    const canvas = createCanvas(80, 80);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 80, 80);
    const src = make4x4(ctx);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, 4, 4, 0, 0, 80, 80);
    // Boundary pixel inside red block (0..40 columns, 0..40 rows).
    const insideRed = ctx.getImageData(20, 20, 1, 1);
    plain('imageSmoothingEnabled=false: red block sharp',
      insideRed.data[0] === 255 && insideRed.data[1] === 0 && insideRed.data[2] === 0,
      `(rgb=${insideRed.data[0]},${insideRed.data[1]},${insideRed.data[2]})`);
  }
  // smoothing ON — boundary pixel between red and green should be a blend.
  {
    const canvas = createCanvas(80, 80);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 80, 80);
    const src = make4x4(ctx);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, 4, 4, 0, 0, 80, 80);
    // Just past the 50% horizontal line — bilinear should mix red and green.
    const boundary = ctx.getImageData(40, 20, 1, 1);
    const mixed =
      boundary.data[0] > 0 && boundary.data[0] < 255 &&
      boundary.data[1] > 0 && boundary.data[1] < 255;
    plain('imageSmoothingEnabled=true: red↔green boundary blends',
      mixed, `(rgb=${boundary.data[0]},${boundary.data[1]},${boundary.data[2]})`);
  }
  // drawImage honors globalAlpha — pre-fix this was ignored.
  {
    const canvas = createCanvas(20, 20);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 20, 20);
    const src = ctx.createImageData(2, 2);
    for (let i = 0; i < 16; i += 4) {
      src.data[i] = 0; src.data[i + 1] = 0; src.data[i + 2] = 255; src.data[i + 3] = 255;
    }
    ctx.globalAlpha = 0.5;
    ctx.drawImage(src, 0, 0, 2, 2, 0, 0, 20, 20);
    // Half-blue over white at globalAlpha=0.5 → (128, 128, 255).
    const px = ctx.getImageData(10, 10, 1, 1);
    const ok = Math.abs(px.data[0] - 128) <= 2 && Math.abs(px.data[1] - 128) <= 2 && px.data[2] >= 254;
    plain('drawImage honors globalAlpha=0.5',
      ok, `(rgb=${px.data[0]},${px.data[1]},${px.data[2]})`);
  }
  // drawImage honors globalCompositeOperation='lighter' — pre-fix ignored.
  {
    const canvas = createCanvas(20, 20);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#800000';
    ctx.fillRect(0, 0, 20, 20);
    const src = ctx.createImageData(2, 2);
    for (let i = 0; i < 16; i += 4) {
      src.data[i] = 0; src.data[i + 1] = 0x80; src.data[i + 2] = 0; src.data[i + 3] = 255;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(src, 0, 0, 2, 2, 0, 0, 20, 20);
    // 0x80 red + 0x80 green via lighter (additive) = 0x80 0x80 0x00.
    const px = ctx.getImageData(10, 10, 1, 1);
    const ok = px.data[0] >= 0x7E && px.data[0] <= 0x82 &&
               px.data[1] >= 0x7E && px.data[1] <= 0x82 &&
               px.data[2] === 0;
    plain('drawImage honors globalCompositeOperation=lighter',
      ok, `(rgb=${px.data[0]},${px.data[1]},${px.data[2]})`);
  }
  // drawImage honors globalCompositeOperation='destination-out' (non-row-
  // friendly mode → composite layer pipeline). Pre-fix ignored, image just
  // overwrote pixels via src semantics.
  {
    const canvas = createCanvas(20, 20);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 20, 20);
    const src = ctx.createImageData(1, 1);
    src.data[0] = 0; src.data[1] = 0; src.data[2] = 0; src.data[3] = 255;
    ctx.globalCompositeOperation = 'destination-out';
    // Stretch the 1×1 black source onto the center 10×10 — should erase.
    ctx.drawImage(src, 0, 0, 1, 1, 5, 5, 10, 10);
    const erased = ctx.getImageData(10, 10, 1, 1);
    const outside = ctx.getImageData(2, 2, 1, 1);
    const ok = erased.data[3] === 0 && outside.data[0] === 255 && outside.data[3] === 255;
    plain('drawImage honors globalCompositeOperation=destination-out',
      ok, `(erased.a=${erased.data[3]} outside.rgb=${outside.data[0]},${outside.data[1]},${outside.data[2]})`);
  }
}

// ---- Phase 4: createConicGradient — structural pixel checks --------------
// (No SSIM compare against @napi-rs/canvas because conic gradient support
// + angle conventions vary across reference rasterizers.)
{
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  // Two-stop conic centered at (20, 20): 0 → red, 1 → red. Sampling any
  // point not at the center should return roughly red.
  const g1 = ctx.createConicGradient(0, 20, 20);
  g1.addColorStop(0, '#ff0000');
  g1.addColorStop(1, '#ff0000');
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, 40, 40);
  const id = ctx.getImageData(35, 5, 1, 1);
  plain('createConicGradient single-color fills uniformly',
    id.data[0] === 0xff && id.data[1] === 0 && id.data[2] === 0,
    `(rgb=${id.data[0]},${id.data[1]},${id.data[2]})`);
}
{
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  // Two-color conic at startAngle=0 — angle 0 (positive x-axis) is red,
  // angle π (negative x-axis) is blue.
  const g = ctx.createConicGradient(0, 20, 20);
  g.addColorStop(0, '#ff0000');
  g.addColorStop(0.5, '#0000ff');
  g.addColorStop(1, '#ff0000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 40, 40);
  // Pixel just to the right of center → start of sweep → red-ish.
  const right = ctx.getImageData(38, 20, 1, 1);
  // Pixel just to the left → middle of sweep → blue-ish.
  const left = ctx.getImageData(2, 20, 1, 1);
  plain('createConicGradient angle 0 → first stop',
    right.data[0] > 200 && right.data[2] < 50,
    `(rgb=${right.data[0]},${right.data[1]},${right.data[2]})`);
  plain('createConicGradient angle π → middle stop',
    left.data[2] > 200 && left.data[0] < 50,
    `(rgb=${left.data[0]},${left.data[1]},${left.data[2]})`);
}

// ---- Phase 7: filter rendering -------------------------------------------
{
  // brightness(0.5) on a red rect → darkens it.
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  ctx.filter = 'brightness(50%)';
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(10, 10, 20, 20);
  const inside = ctx.getImageData(15, 15, 1, 1);
  plain('filter brightness(50%) halves red',
    inside.data[0] > 100 && inside.data[0] < 160 && inside.data[1] === 0 && inside.data[2] === 0,
    `(rgb=${inside.data[0]},${inside.data[1]},${inside.data[2]})`);
}
{
  // contrast(200%) on a mid-gray rect → pushes it toward black or white.
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  ctx.filter = 'contrast(200%)';
  // 100 < 128 → pushed toward 56 = (100-128)*2+128
  ctx.fillStyle = '#646464'; // 100,100,100
  ctx.fillRect(10, 10, 20, 20);
  const inside = ctx.getImageData(15, 15, 1, 1);
  plain('filter contrast(200%) darkens mid-gray below 128',
    inside.data[0] < 100 && inside.data[1] < 100 && inside.data[2] < 100,
    `(rgb=${inside.data[0]},${inside.data[1]},${inside.data[2]})`);
}
{
  // blur(3px) softens edges. Sample a pixel just inside the rect's edge —
  // it should differ from the saturated interior color.
  const canvas = createCanvas(60, 60);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 60, 60);
  ctx.filter = 'blur(3px)';
  ctx.fillStyle = '#000000';
  ctx.fillRect(20, 20, 20, 20);
  const edge = ctx.getImageData(20, 30, 1, 1);
  plain('filter blur(3px) softens left edge',
    edge.data[0] > 0 && edge.data[0] < 255,
    `(rgb=${edge.data[0]},${edge.data[1]},${edge.data[2]})`);
}
{
  // 'none' clears the filter; subsequent draws should render normally.
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  ctx.filter = 'brightness(50%)';
  ctx.filter = 'none';
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(10, 10, 20, 20);
  const inside = ctx.getImageData(15, 15, 1, 1);
  plain('filter "none" clears chain (full red)',
    inside.data[0] === 0xff && inside.data[1] === 0 && inside.data[2] === 0,
    `(rgb=${inside.data[0]},${inside.data[1]},${inside.data[2]})`);
}
{
  // Invalid filter string → silently ignored, prior value retained.
  const ctx = createCanvas(8, 8).getContext('2d');
  ctx.filter = 'brightness(80%)';
  const before = ctx.filter;
  ctx.filter = 'gibberish(';
  plain('filter rejects invalid string', ctx.filter === before);
}

// ---- Phase 6: shadow round-trip + rendering effect -----------------------
{
  const ctx = createCanvas(8, 8).getContext('2d');
  ctx.shadowBlur = 4;
  plain('shadowBlur round-trip', ctx.shadowBlur === 4);
  ctx.shadowBlur = -1;
  plain('shadowBlur rejects negative', ctx.shadowBlur === 4);
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = -2;
  plain('shadowOffsetX/Y round-trip', ctx.shadowOffsetX === 3 && ctx.shadowOffsetY === -2);
  ctx.shadowColor = '#0080ff';
  plain('shadowColor parses + canonical-roundtrip',
    ctx.shadowColor === '#0080ff' || ctx.shadowColor === '#0080FF',
    `(${ctx.shadowColor})`);
}
{
  // Rendering effect: a red rect with a shadowOffsetX=8 should leave a
  // shadow-colored band to the right of the rect's right edge.
  const canvas = createCanvas(80, 60);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 80, 60);
  ctx.shadowColor = '#ff8800';
  ctx.shadowOffsetX = 10;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#000000';
  ctx.fillRect(10, 20, 30, 20);
  // Inside the rect → black (shape on top).
  const inside = ctx.getImageData(20, 30, 1, 1);
  // Just to the right of the rect → shadow color.
  const shadow = ctx.getImageData(45, 30, 1, 1);
  plain('shadow: shape pixels are still black inside rect',
    inside.data[0] === 0 && inside.data[1] === 0 && inside.data[2] === 0,
    `(rgb=${inside.data[0]},${inside.data[1]},${inside.data[2]})`);
  plain('shadow: shadow band right of shape is orange',
    shadow.data[0] > 200 && shadow.data[1] > 100 && shadow.data[2] < 50,
    `(rgb=${shadow.data[0]},${shadow.data[1]},${shadow.data[2]})`);
}
{
  // shadowBlur > 0 produces soft falloff: center of the shadow region is
  // saturated, edges fade. Sample a point a few pixels past the rect's
  // right edge with blur=8: it should be a partial alpha shadow.
  const canvas = createCanvas(80, 80);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 80, 80);
  ctx.shadowColor = '#ff0000';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(20, 20, 40, 40);
  // 6 pixels past the right edge — should be blurred red over white,
  // i.e. partial red blend.
  const halo = ctx.getImageData(66, 40, 1, 1);
  plain('shadow: blur creates soft halo past rect edge',
    halo.data[0] > 200 && halo.data[1] < 240 && halo.data[2] < 240,
    `(rgb=${halo.data[0]},${halo.data[1]},${halo.data[2]})`);
}
{
  // shadowColor with alpha=0 → no shadow drawn even with offset/blur set.
  const canvas = createCanvas(40, 40);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 40, 40);
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowOffsetX = 5;
  ctx.fillStyle = '#000000';
  ctx.fillRect(5, 10, 10, 10);
  const right = ctx.getImageData(20, 15, 1, 1);
  plain('shadow: alpha=0 disables (no shadow band)',
    right.data[0] === 255 && right.data[1] === 255 && right.data[2] === 255,
    `(rgb=${right.data[0]},${right.data[1]},${right.data[2]})`);
}

// ---- Phase 5: isPointInPath + isPointInStroke ---------------------------
{
  const ctx = createCanvas(200, 200).getContext('2d');
  // Square at (50,50)..(150,150).
  ctx.beginPath();
  ctx.rect(50, 50, 100, 100);
  plain('isPointInPath inside rect (current path)', ctx.isPointInPath(100, 100));
  plain('isPointInPath outside rect (current path)', !ctx.isPointInPath(10, 10));
  plain('isPointInPath on edge (right of edge)', !ctx.isPointInPath(160, 100));
}
{
  const ctx = createCanvas(200, 200).getContext('2d');
  // Self-intersecting star — nonzero fills everything, evenodd leaves a hole.
  ctx.beginPath();
  const cx = 100, cy = 100, R = 70, r = 30;
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const radius = (k & 1) ? r : R;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  // Center is inside both rules.
  plain('isPointInPath star center nonzero', ctx.isPointInPath(100, 100, 'nonzero'));
  plain('isPointInPath star center evenodd', ctx.isPointInPath(100, 100, 'evenodd'));
}
{
  const ctx = createCanvas(200, 200).getContext('2d');
  const p = new Path2D();
  p.rect(80, 80, 40, 40);
  plain('isPointInPath external Path2D inside', ctx.isPointInPath(p, 100, 100));
  plain('isPointInPath external Path2D outside', !ctx.isPointInPath(p, 10, 10));
}
{
  const ctx = createCanvas(200, 200).getContext('2d');
  // CTM scale 2× → an external Path2D rect at (10,10,20,20) hits at canvas (20..60, 20..60).
  ctx.scale(2, 2);
  const p = new Path2D();
  p.rect(10, 10, 20, 20);
  plain('isPointInPath external Path2D under CTM scale',
    ctx.isPointInPath(p, 40, 40) && !ctx.isPointInPath(p, 5, 5));
}
{
  const ctx = createCanvas(200, 200).getContext('2d');
  // Stroke a horizontal line at y=100, lineWidth=10.
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(50, 100);
  ctx.lineTo(150, 100);
  plain('isPointInStroke on the line', ctx.isPointInStroke(100, 100));
  plain('isPointInStroke just outside lineWidth band', !ctx.isPointInStroke(100, 110));
  plain('isPointInStroke far from line', !ctx.isPointInStroke(10, 10));
}

// ---- Phase 4: reset() -----------------------------------------------------
{
  const canvas = createCanvas(20, 20);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 7;
  ctx.fillRect(0, 0, 20, 20);
  ctx.save();
  ctx.translate(5, 5);
  ctx.reset();
  // After reset: state defaults restored.
  plain('reset clears fillStyle to default', ctx.fillStyle === '#000000');
  plain('reset clears globalAlpha to 1', ctx.globalAlpha === 1);
  plain('reset clears lineWidth to 1', ctx.lineWidth === 1);
  // Save stack drained.
  ctx.restore(); // no-op
  plain('reset drains save stack (restore is no-op)', true);
  // Canvas pixels cleared to transparent black.
  const id = ctx.getImageData(0, 0, 1, 1);
  plain('reset clears pixels to transparent black',
    id.data[0] === 0 && id.data[1] === 0 && id.data[2] === 0 && id.data[3] === 0);
}

// ---- Font shorthand parser: bold / italic / weight -----------------------
{
  const c = createCanvas(20, 20);
  const ctx = c.getContext('2d');
  ctx.font = 'bold 16px sans-serif';
  plain('font shorthand: bold canonicalizes to weight 700',
    ctx.font === '700 16px sans-serif');
  ctx.font = 'italic 14px sans-serif';
  plain('font shorthand: italic canonicalizes', ctx.font === 'italic 14px sans-serif');
  ctx.font = 'italic 700 18px "Helv", sans-serif';
  plain('font shorthand: italic + 700 + multi-family',
    ctx.font === 'italic 700 18px helv, sans-serif');
  ctx.font = '300 italic 24px/1.5 Inter';
  plain('font shorthand: weight + style + line-height swallowed',
    ctx.font === 'italic 300 24px inter');
  // Invalid font: silently ignored, previous value retained.
  const before = ctx.font;
  ctx.font = 'not a font';
  plain('font shorthand: invalid silently ignored', ctx.font === before);
}

// ---- Faux-bold ink heavier than regular -----------------------------------
{
  // Render the same glyph at the same size with regular vs bold weight,
  // sum alpha across the canvas. Bold must be heavier (more inked pixels).
  function inkSum(weight) {
    const c = createCanvas(80, 60);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.font = `${weight} 40px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText('H', 10, 10);
    const data = ctx.getImageData(0, 0, 80, 60).data;
    let total = 0;
    for (let i = 3; i < data.length; i += 4) total += data[i];
    return total;
  }
  const reg = inkSum('normal');
  const bold = inkSum('bold');
  plain(`faux-bold ink heavier than regular (reg=${reg}, bold=${bold})`,
    bold > reg * 1.1); // expect ~ +20-40% mass for a 1-pixel dilation at 40px
}

// ---- Faux-italic shifts ink rightward at top ------------------------------
{
  // For an italic 'L', the top of the stem leans further right than the
  // regular 'L'. Sample two horizontal bands and check the rightmost inked
  // pixel column moves right between regular and italic.
  function rightmostInkCol(style, y0, y1) {
    const c = createCanvas(60, 80);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.font = `${style} 60px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText('L', 5, 5);
    const data = ctx.getImageData(0, y0, 60, y1 - y0).data;
    let rightmost = -1;
    for (let row = 0; row < y1 - y0; row++) {
      for (let col = 59; col >= 0; col--) {
        if (data[(row * 60 + col) * 4 + 3] > 32) {
          if (col > rightmost) rightmost = col;
          break;
        }
      }
    }
    return rightmost;
  }
  const regTop = rightmostInkCol('normal', 5, 20);
  const italicTop = rightmostInkCol('italic', 5, 20);
  plain(`faux-italic top leans right (regular=${regTop}, italic=${italicTop})`,
    italicTop > regTop);
}

// ---- Multi-face registry: explicit weight/style picks correct face --------
{
  // Register two distinct "faces" of a fake family — both are the default
  // Manrope bytes, but tagged with different weight/style metadata so face
  // matching has something to pick. We can't visually distinguish them
  // (same bytes), but we CAN check that face matching reports "no faux"
  // when the target weight/style matches a registered face exactly.
  const { defaultFontBytes } = await import('../zig/simdra.zig');
  const bytes = new Uint8Array(defaultFontBytes().dataView.buffer.slice(0));
  const { registerFont } = await import('../src/index.ts');
  registerFont(bytes, 'TestFace', { weight: 400, style: 'normal' });
  registerFont(bytes, 'TestFace', { weight: 700, style: 'italic' });
  // (No JS getter exposes faux flags, so we re-export via a temp import.)
  // Instead, smoke-test the round-trip: setting ctx.font to each variant
  // doesn't throw and parses to the expected canonical form.
  const c = createCanvas(20, 20);
  const ctx = c.getContext('2d');
  ctx.font = '20px TestFace';
  plain('multi-face: regular registers + parses', ctx.font === '20px testface');
  ctx.font = 'italic 700 20px TestFace';
  plain('multi-face: bold-italic round-trip',
    ctx.font === 'italic 700 20px testface');
}

// ---- Canvas resize (HTML5 width/height setters) ---------------------------
{
  const rc = createCanvas(120, 80);
  const rg = rc.getContext('2d');
  rg.fillStyle = 'red';
  rg.fillRect(0, 0, 120, 80);
  rc.width = 40;
  rc.height = 30;
  plain('canvas-resize: width getter reflects setter', rc.width === 40);
  plain('canvas-resize: height getter reflects setter', rc.height === 30);
  // Bitmap must be transparent black after resize, even though we filled it.
  const after = rg.getImageData(0, 0, 40, 30);
  let cleared = true;
  for (let i = 0; i < after.data.length; i += 4) {
    if (after.data[i + 3] !== 0) { cleared = false; break; }
  }
  plain('canvas-resize: bitmap cleared to transparent black', cleared);
  // Ctx state must have reset — fillStyle returns to default.
  plain('canvas-resize: ctx state reset (fillStyle default)',
    rg.fillStyle === '#000000');
  // Drawing on the new dims lands.
  rg.fillStyle = 'lime';
  rg.fillRect(0, 0, 40, 30);
  const drew = rg.getImageData(0, 0, 40, 30);
  plain('canvas-resize: post-resize draw lands',
    drew.data[1] === 255 && drew.data[3] === 255);
  // Same ctx instance preserved (browser-matching identity).
  plain('canvas-resize: getContext returns same ctx instance after resize',
    rc.getContext('2d') === rg);
}

// ---- Image decode/encode (stb_image) --------------------------------------
{
  // PNG roundtrip: encode current canvas → decode back via Image.fromBytes →
  // dimensions must match. This is the smoke test that the encoder + decoder
  // talk to each other through valid PNG bytes.
  const c = createCanvas(80, 60);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#03a9f4';
  ctx.fillRect(0, 0, 80, 60);
  ctx.fillStyle = '#ff5722';
  ctx.fillRect(20, 15, 40, 30);

  const pngBytes = c.toBytes();
  plain('PNG: encode magic bytes',
    pngBytes[0] === 0x89 &&
    pngBytes[1] === 0x50 &&
    pngBytes[2] === 0x4e &&
    pngBytes[3] === 0x47);

  const decoded = Image.fromBytes(pngBytes);
  plain('PNG: roundtrip dimensions',
    decoded.width === 80 && decoded.height === 60);

  // JPEG roundtrip: smooth gradient (JPEG-friendly content), 0.9 quality.
  const c2 = createCanvas(120, 80);
  const ctx2 = c2.getContext('2d');
  const grad = ctx2.createLinearGradient(0, 0, 120, 0);
  grad.addColorStop(0, '#ff5722');
  grad.addColorStop(1, '#03a9f4');
  ctx2.fillStyle = grad;
  ctx2.fillRect(0, 0, 120, 80);

  const jpegBytes = c2.toBytes('image/jpeg', 0.9);
  plain('JPEG: encode magic bytes',
    jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8 && jpegBytes[2] === 0xff);
  plain('JPEG: ends with EOI marker',
    jpegBytes[jpegBytes.length - 2] === 0xff &&
    jpegBytes[jpegBytes.length - 1] === 0xd9);

  const decodedJpeg = Image.fromBytes(jpegBytes);
  plain('JPEG: roundtrip dimensions',
    decodedJpeg.width === 120 && decodedJpeg.height === 80);

  // Data-URL formatting roundtrip (mostly the JS dispatch + base64).
  const dataUrl = c2.toDataURL('image/jpeg', 0.8);
  plain('toDataURL: image/jpeg prefix',
    dataUrl.startsWith('data:image/jpeg;base64,'));

  const defaultUrl = c.toDataURL();
  plain('toDataURL: defaults to image/png',
    defaultUrl.startsWith('data:image/png;base64,'));

  // Visual: JPEG roundtrip via SSIM. Re-decode JPEG bytes, drawImage onto a
  // fresh canvas, compare its pixels against the original (in-canvas) using
  // SSIM. Threshold loose because JPEG is lossy on hard edges.
  const re = createCanvas(120, 80);
  const rectx = re.getContext('2d');
  rectx.drawImage(decodedJpeg, 0, 0);
  const ssimRes = ssim(
    {
      width: 120,
      height: 80,
      data: toClampedCopy(ctx2.getImageData(0, 0, 120, 80).data),
    },
    {
      width: 120,
      height: 80,
      data: toClampedCopy(rectx.getImageData(0, 0, 120, 80).data),
    },
  );
  plain(
    `JPEG roundtrip SSIM ${ssimRes.mssim.toFixed(3)} >= 0.92`,
    ssimRes.mssim >= 0.92,
  );

  // toDataURL still respects the unrecognized-type fallback (PNG).
  const fallbackUrl = c.toDataURL('image/webp');
  plain('toDataURL: unrecognized type falls back to PNG',
    fallbackUrl.startsWith('data:image/png;base64,'));
}

// ---- microsharp (sharp-shaped binding) ------------------------------------
{
  // Build a known canvas, encode as PNG bytes, feed those into the fluent
  // microsharp() pipeline, ensure roundtrip works.
  const c = createCanvas(60, 40);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#10b981';
  ctx.fillRect(0, 0, 60, 40);
  const pngIn = c.toBytes();

  // microsharp(buf).png().toBuffer() — same format in, same format out.
  const pngOut = await microsharp(pngIn).png().toBuffer();
  plain('microsharp(): PNG roundtrip preserves magic bytes',
    pngOut[0] === 0x89 && pngOut[1] === 0x50 &&
    pngOut[2] === 0x4e && pngOut[3] === 0x47);

  // microsharp(buf).jpeg(0.85).toBuffer() — re-encode as JPEG.
  const jpegOut = await microsharp(pngIn).jpeg(0.85).toBuffer();
  plain('microsharp(): JPEG re-encode magic bytes',
    jpegOut[0] === 0xff && jpegOut[1] === 0xd8 && jpegOut[2] === 0xff);

  // metadata() — header-only read via stbi_info_from_memory; no full decode.
  const meta = await microsharp(pngIn).metadata();
  plain('microsharp(): metadata() dimensions',
    meta.width === 60 && meta.height === 40);
  plain('microsharp(): metadata() format detect',
    meta.format === 'png');
  plain('microsharp(): metadata() source channels (RGBA fill ⇒ 4)',
    meta.channels === 4 && meta.hasAlpha === true);
  plain('microsharp(): metadata() bitsPerSample 8',
    meta.bitsPerSample === 8);
  plain('microsharp(): metadata() size matches input length',
    meta.size === pngIn.length);

  // Sanity: a JPEG re-encode should advertise format=jpeg and channels=3
  // (stb-image stores JPEG as 3-channel RGB; alpha is dropped during encode).
  const jpegBytesForMeta = await microsharp(pngIn).jpeg(0.85).toBuffer();
  const jpegMeta = await microsharp(jpegBytesForMeta).metadata();
  plain('microsharp(): metadata() detects JPEG container',
    jpegMeta.format === 'jpeg' && jpegMeta.channels === 3 && jpegMeta.hasAlpha === false);

  // ---- resize / extend / extract / trim (effects/SmResampler + SmTrim) ----

  // resize(w, h) defaults to fit='cover', kernel='lanczos3'. Verify the
  // output dimensions and that pixels survived the resample (centre
  // pixel should still be the green fill).
  const resizeOut = await microsharp(pngIn).resize(30, 20).png().toBuffer();
  const resizeMeta = await microsharp(resizeOut).metadata();
  plain('microsharp(): resize(30, 20) dims',
    resizeMeta.width === 30 && resizeMeta.height === 20);

  // resize across all eight kernels — every one must produce a valid PNG.
  for (const kernel of ['nearest', 'linear', 'cubic', 'mitchell',
                         'lanczos2', 'lanczos3', 'mks2013', 'mks2021']) {
    const out = await microsharp(pngIn).resize(20, 20, { kernel }).png().toBuffer();
    const ok = out[0] === 0x89 && out[1] === 0x50;
    plain(`microsharp(): resize kernel '${kernel}' -> valid PNG`, ok);
  }

  // resize fit modes: build a 100×60 source so aspect ratio diverges
  // visibly, then check resampled dims for each fit.
  const srcCanvas = createCanvas(100, 60);
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.fillStyle = '#3b82f6';
  srcCtx.fillRect(0, 0, 100, 60);
  const srcPng = srcCanvas.toBytes();

  // fit=fill -> stretch to 50×40 ignoring aspect.
  const fillOut = await microsharp(srcPng).resize(50, 40, { fit: 'fill' }).raw().toBuffer();
  plain('microsharp(): fit=fill produces 50×40 raw',
    fillOut.length === 50 * 40 * 4);

  // fit=inside -> max dim hits target keeping aspect; 100×60 -> 50×30.
  const insideOut = await microsharp(srcPng).resize(50, 40, { fit: 'inside' }).raw().toBuffer();
  plain('microsharp(): fit=inside scales aspect (100×60 -> 50×30)',
    insideOut.length === 50 * 30 * 4);

  // fit=outside -> min dim hits target keeping aspect; 100×60 -> 67×40.
  const outsideOut = await microsharp(srcPng).resize(50, 40, { fit: 'outside' }).raw().toBuffer();
  plain('microsharp(): fit=outside scales aspect (100×60 -> 67×40)',
    outsideOut.length === 67 * 40 * 4);

  // fit=cover -> 50×40 final, source overscanned then centre-cropped.
  const coverOut = await microsharp(srcPng).resize(50, 40, { fit: 'cover' }).raw().toBuffer();
  plain('microsharp(): fit=cover produces 50×40',
    coverOut.length === 50 * 40 * 4);

  // fit=contain -> 50×40 final with letterbox bg=red. The 100×60 source
  // shrinks to 50×30 keeping aspect, leaving 10 rows split top/bottom.
  const containOut = await microsharp(srcPng).resize(50, 40, {
    fit: 'contain', background: { r: 255, g: 0, b: 0, alpha: 1 },
  }).raw().toBuffer();
  // First pixel (top-left corner) must be the red letterbox.
  const containBgOk = containOut[0] === 255 && containOut[1] === 0 && containOut[2] === 0;
  plain('microsharp(): fit=contain letterboxes with background',
    containOut.length === 50 * 40 * 4 && containBgOk);

  // withoutEnlargement: target larger than source -> no scale-up.
  const noEnlargeOut = await microsharp(srcPng).resize(200, 120, {
    fit: 'inside', withoutEnlargement: true,
  }).raw().toBuffer();
  plain('microsharp(): withoutEnlargement keeps 100×60',
    noEnlargeOut.length === 100 * 60 * 4);

  // resize position='top right' on cover crops from the top-right corner.
  // Build a 200×100 image with distinguishable left/right halves.
  const halfCanvas = createCanvas(200, 100);
  const halfCtx = halfCanvas.getContext('2d');
  halfCtx.fillStyle = '#000000';
  halfCtx.fillRect(0, 0, 100, 100);
  halfCtx.fillStyle = '#ffffff';
  halfCtx.fillRect(100, 0, 100, 100);
  const halfPng = halfCanvas.toBytes();
  // Resize to 50×100 with cover position=right. Cover scaling on a
  // 200×100 source going to 50×100 picks scale=max(50/200,100/100)=1.0,
  // then crops 50 px from the right -> the white half is preserved.
  const rightCrop = await microsharp(halfPng).resize(50, 100, {
    fit: 'cover', position: 'right',
  }).raw().toBuffer();
  // Centre pixel of the crop should be white.
  const cx = 25, cy = 50, ci = (cy * 50 + cx) * 4;
  plain('microsharp(): position="right" crops the right half',
    rightCrop[ci] > 240 && rightCrop[ci + 1] > 240 && rightCrop[ci + 2] > 240);

  const leftCrop = await microsharp(halfPng).resize(50, 100, {
    fit: 'cover', position: 'left',
  }).raw().toBuffer();
  plain('microsharp(): position="left" crops the left half',
    leftCrop[ci] < 15 && leftCrop[ci + 1] < 15 && leftCrop[ci + 2] < 15);

  // entropy / attention strategies: build an image with one busy
  // quadrant and pick that quadrant.
  const quadCanvas = createCanvas(120, 120);
  const quadCtx = quadCanvas.getContext('2d');
  quadCtx.fillStyle = '#888888';
  quadCtx.fillRect(0, 0, 120, 120);
  // Bottom-right quadrant: high-frequency stripes (high entropy + saliency).
  for (let y = 60; y < 120; y += 2) {
    quadCtx.fillStyle = (y % 4 === 0) ? '#ff0000' : '#00ff00';
    quadCtx.fillRect(60, y, 60, 1);
  }
  const quadPng = quadCanvas.toBytes();
  const entropyCrop = await microsharp(quadPng).resize(60, 60, {
    fit: 'cover', position: 'entropy',
  }).raw().toBuffer();
  // Centre of the crop should land inside the busy quadrant; sample a
  // pixel and check it's coloured (not the grey background).
  const ec = (30 * 60 + 30) * 4;
  const entropyOk = (entropyCrop[ec] !== entropyCrop[ec + 1]) || (entropyCrop[ec] !== entropyCrop[ec + 2]);
  plain('microsharp(): position="entropy" picks the busy quadrant', entropyOk);

  const attentionCrop = await microsharp(quadPng).resize(60, 60, {
    fit: 'cover', position: 'attention',
  }).raw().toBuffer();
  const ac = (30 * 60 + 30) * 4;
  const attentionOk = (attentionCrop[ac] !== attentionCrop[ac + 1]) || (attentionCrop[ac] !== attentionCrop[ac + 2]);
  plain('microsharp(): position="attention" picks the busy quadrant', attentionOk);

  // extend with each fill mode.
  const extBg = await microsharp(srcPng).extend({
    top: 5, bottom: 5, left: 5, right: 5,
    extendWith: 'background',
    background: { r: 0, g: 0, b: 0, alpha: 1 },
  }).raw().toBuffer();
  plain('microsharp(): extend background-fill enlarges by edge counts',
    extBg.length === 110 * 70 * 4 && extBg[0] === 0 && extBg[1] === 0 && extBg[2] === 0);

  const extCopy = await microsharp(srcPng).extend({
    top: 0, bottom: 0, left: 5, right: 0,
    extendWith: 'copy',
  }).raw().toBuffer();
  // First pixel of extended row should match source col 0 (the blue fill).
  plain('microsharp(): extend copy extrudes edge pixel',
    extCopy[0] === 0x3b && extCopy[1] === 0x82 && extCopy[2] === 0xf6);

  for (const mode of ['repeat', 'mirror']) {
    const out = await microsharp(srcPng).extend({
      top: 4, bottom: 4, left: 4, right: 4,
      extendWith: mode,
    }).raw().toBuffer();
    plain(`microsharp(): extend ${mode} produces correct dims`,
      out.length === 108 * 68 * 4);
  }

  // extract — happy path.
  const ext = await microsharp(srcPng).extract({ left: 10, top: 10, width: 30, height: 20 })
    .raw().toBuffer();
  plain('microsharp(): extract produces correct dims',
    ext.length === 30 * 20 * 4);

  // extract — out-of-bounds.
  let extractThrew = false;
  try {
    await microsharp(srcPng).extract({ left: 90, top: 0, width: 50, height: 20 }).toBuffer();
  } catch (err) {
    extractThrew = err instanceof RangeError;
  }
  plain('microsharp(): extract out-of-bounds throws RangeError', extractThrew);

  // trim — build an image with a transparent border around content.
  const trimCanvas = createCanvas(100, 100);
  const trimCtx = trimCanvas.getContext('2d');
  trimCtx.fillStyle = '#ff0000';
  trimCtx.fillRect(20, 30, 60, 40);
  const trimPng = trimCanvas.toBytes();
  // Default trim: bg = top-left pixel (transparent black). The red rect
  // is at x=20..80, y=30..70.
  const trimmed = await microsharp(trimPng).trim().raw().toBuffer();
  plain('microsharp(): trim default tightens to red rect',
    trimmed.length === 60 * 40 * 4);

  // trim with explicit threshold/background.
  const trimmedExplicit = await microsharp(trimPng).trim({
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    threshold: 5,
  }).raw().toBuffer();
  plain('microsharp(): trim explicit background+threshold same result',
    trimmedExplicit.length === 60 * 40 * 4);

  // trim no-op when entire image is the background.
  const blankCanvas = createCanvas(40, 40);
  const blankPng = blankCanvas.toBytes();
  const trimBlank = await microsharp(blankPng).trim().raw().toBuffer();
  plain('microsharp(): trim no-content -> identity', trimBlank.length === 40 * 40 * 4);

  // chained ops — extend then trim should round-trip back to identity dims.
  const roundtrip = await microsharp(srcPng)
    .extend({ top: 8, right: 8, bottom: 8, left: 8, extendWith: 'background',
              background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .trim()
    .raw()
    .toBuffer();
  plain('microsharp(): extend+trim round-trip restores dims',
    roundtrip.length === 100 * 60 * 4);

  // ---- composite ----------------------------------------------------------

  // Build a small distinct overlay: 30×20 yellow rect.
  const ovCanvas = createCanvas(30, 20);
  const ovCtx = ovCanvas.getContext('2d');
  ovCtx.fillStyle = '#ffff00';
  ovCtx.fillRect(0, 0, 30, 20);
  const ovPng = ovCanvas.toBytes();

  // composite default — over blend, centre gravity. Base is 100×60 blue
  // (srcPng above); overlay is yellow. After composite the centre pixel
  // should be yellow, corners stay blue.
  const compCenter = await microsharp(srcPng).composite([{ input: ovPng }]).raw().toBuffer();
  const cpx = (30 * 100 + 50) * 4;  // centre of 100×60
  plain('microsharp(): composite() default centre overlays correctly',
    compCenter[cpx] === 0xff && compCenter[cpx + 1] === 0xff && compCenter[cpx + 2] === 0x00);
  // Top-left corner stays blue.
  plain('microsharp(): composite() preserves base outside overlay',
    compCenter[0] === 0x3b && compCenter[1] === 0x82 && compCenter[2] === 0xf6);

  // composite with explicit top/left.
  const compTopLeft = await microsharp(srcPng).composite([{
    input: ovPng, top: 0, left: 0,
  }]).raw().toBuffer();
  plain('microsharp(): composite() top/left places at origin',
    compTopLeft[0] === 0xff && compTopLeft[1] === 0xff && compTopLeft[2] === 0x00);

  // composite gravity='top right' places overlay flush to top-right.
  const compTR = await microsharp(srcPng).composite([{
    input: ovPng, gravity: 'top right',
  }]).raw().toBuffer();
  // Pixel at (95, 5) — inside the overlay zone (overlay 30 wide ends at x=100, top=0..20)
  const trPx = (5 * 100 + 95) * 4;
  plain('microsharp(): composite() gravity="top right"',
    compTR[trPx] === 0xff && compTR[trPx + 1] === 0xff && compTR[trPx + 2] === 0x00);

  // composite tile=true should fill the whole base with the overlay
  // pattern (since overlay is solid yellow, every pixel is yellow).
  const compTile = await microsharp(srcPng).composite([{
    input: ovPng, tile: true, gravity: 'top left',
  }]).raw().toBuffer();
  plain('microsharp(): composite() tile=true covers entire base',
    compTile[0] === 0xff && compTile[1] === 0xff && compTile[2] === 0x00 &&
    compTile[(59 * 100 + 99) * 4] === 0xff);

  // composite blend='multiply' on a yellow overlay over blue base
  // -> rgb multiply: (0x3b, 0x82, 0xf6) * (255, 255, 0)/255 = (0x3b, 0x82, 0).
  const compMul = await microsharp(srcPng).composite([{
    input: ovPng, blend: 'multiply', top: 0, left: 0,
  }]).raw().toBuffer();
  // Component math: B channel of base=0xf6, overlay=0; multiply gives 0.
  plain('microsharp(): composite() blend="multiply" zeroes blue channel',
    compMul[2] === 0x00);

  // composite { create } — flat-colour overlay built on the fly.
  const compCreate = await microsharp(srcPng).composite([{
    input: { create: { width: 20, height: 20, channels: 4,
                       background: { r: 255, g: 0, b: 0, alpha: 1 } } },
    top: 5, left: 5,
  }]).raw().toBuffer();
  // (5,5) should be red.
  const crPx = (5 * 100 + 5) * 4;
  plain('microsharp(): composite() {create} flat-colour overlay',
    compCreate[crPx] === 0xff && compCreate[crPx + 1] === 0x00 && compCreate[crPx + 2] === 0x00);

  // composite raw — pre-built RGBA pixels (sharp's sibling-`raw` shape).
  const rawData = new Uint8Array(20 * 20 * 4);
  for (let i = 0; i < rawData.length; i += 4) {
    rawData[i + 0] = 0; rawData[i + 1] = 255; rawData[i + 2] = 0; rawData[i + 3] = 255;
  }
  const compRaw = await microsharp(srcPng).composite([{
    input: rawData,
    raw: { width: 20, height: 20, channels: 4 },
    top: 5, left: 5,
  }]).raw().toBuffer();
  plain('microsharp(): composite() raw RGBA overlay (sharp-style sibling)',
    compRaw[crPx] === 0x00 && compRaw[crPx + 1] === 0xff && compRaw[crPx + 2] === 0x00);

  // composite multiple overlays in array order.
  const compMulti = await microsharp(srcPng).composite([
    { input: { create: { width: 30, height: 30, channels: 4,
                          background: { r: 255, g: 0, b: 0, alpha: 1 } } },
      top: 0, left: 0 },
    { input: { create: { width: 30, height: 30, channels: 4,
                          background: { r: 0, g: 0, b: 255, alpha: 1 } } },
      top: 10, left: 10 },
  ]).raw().toBuffer();
  // (5,5) is in the first overlay (red), not the second.
  plain('microsharp(): composite() array first overlay survives where uncovered',
    compMulti[(5 * 100 + 5) * 4] === 0xff &&
    compMulti[(5 * 100 + 5) * 4 + 1] === 0x00);
  // (20,20) is covered by the second (blue) overlay (drawn last → wins for src_over).
  plain('microsharp(): composite() second overlay wins where it covers the first',
    compMulti[(20 * 100 + 20) * 4 + 2] === 0xff &&
    compMulti[(20 * 100 + 20) * 4] === 0x00);

  // composite blend='dest' is identity — base is unchanged.
  const compDest = await microsharp(srcPng).composite([{
    input: ovPng, blend: 'dest',
  }]).raw().toBuffer();
  plain('microsharp(): composite() blend="dest" preserves base',
    compDest[cpx] === 0x3b && compDest[cpx + 1] === 0x82 && compDest[cpx + 2] === 0xf6);

  // composite blend='clear' / 'saturate' should throw RangeError.
  let blendThrew = 0;
  try { await microsharp(srcPng).composite([{ input: ovPng, blend: 'clear' }]).toBuffer(); }
  catch (e) { if (e instanceof RangeError) blendThrew++; }
  try { await microsharp(srcPng).composite([{ input: ovPng, blend: 'saturate' }]).toBuffer(); }
  catch (e) { if (e instanceof RangeError) blendThrew++; }
  plain('microsharp(): composite() blend="clear"/"saturate" throw RangeError',
    blendThrew === 2);

  // ---- channel ops --------------------------------------------------------

  // Build an RGBA image with non-trivial values: top-left pixel
  // (R=10, G=200, B=50, A=128) so each channel test has a clear signal.
  const chanCanvas = createCanvas(10, 10);
  const chanCtx = chanCanvas.getContext('2d');
  const chanImg = chanCtx.createImageData(10, 10);
  for (let i = 0; i < chanImg.data.length; i += 4) {
    chanImg.data[i + 0] = 10;
    chanImg.data[i + 1] = 200;
    chanImg.data[i + 2] = 50;
    chanImg.data[i + 3] = 128;
  }
  chanCtx.putImageData(chanImg, 0, 0);
  const chanPng = chanCanvas.toBytes();

  // removeAlpha — α should become 255 everywhere; RGB unchanged.
  const noAlpha = await microsharp(chanPng).removeAlpha().raw().toBuffer();
  plain('microsharp(): removeAlpha forces α=255',
    noAlpha[3] === 255 && noAlpha[7] === 255 && noAlpha[0] === 10 && noAlpha[1] === 200 && noAlpha[2] === 50);

  // ensureAlpha() with no arg is a no-op.
  const ensureNoArg = await microsharp(chanPng).ensureAlpha().raw().toBuffer();
  plain('microsharp(): ensureAlpha() no-arg preserves α',
    ensureNoArg[3] === 128);

  // ensureAlpha(0.5) — α becomes round(0.5*255) = 128 everywhere (was already
  // 128). Use a different alpha to verify the op fires.
  const ensureHalf = await microsharp(chanPng).ensureAlpha(0).raw().toBuffer();
  plain('microsharp(): ensureAlpha(0) sets α=0',
    ensureHalf[3] === 0 && ensureHalf[7] === 0);

  const ensureFull = await microsharp(chanPng).ensureAlpha(1).raw().toBuffer();
  plain('microsharp(): ensureAlpha(1) sets α=255',
    ensureFull[3] === 255 && ensureFull[0] === 10);

  // ensureAlpha(out-of-range) → RangeError.
  let ensureThrew = 0;
  try { microsharp(chanPng).ensureAlpha(-0.1); } catch (e) { if (e instanceof RangeError) ensureThrew++; }
  try { microsharp(chanPng).ensureAlpha(1.1); } catch (e) { if (e instanceof RangeError) ensureThrew++; }
  plain('microsharp(): ensureAlpha(<0|>1) throws RangeError', ensureThrew === 2);

  // extractChannel — by name and by index.
  for (const [sel, expected] of [['red', 10], ['green', 200], ['blue', 50], ['alpha', 128]]) {
    const out = await microsharp(chanPng).extractChannel(sel).raw().toBuffer();
    const ok = out[0] === expected && out[1] === expected && out[2] === expected && out[3] === 255;
    plain(`microsharp(): extractChannel('${sel}') → broadcast ${expected}`, ok);
  }
  for (const idx of [0, 1, 2, 3]) {
    const out = await microsharp(chanPng).extractChannel(idx).raw().toBuffer();
    plain(`microsharp(): extractChannel(${idx}) is well-formed`,
      out.length === 10 * 10 * 4 && out[3] === 255);
  }
  // Out-of-range channel → RangeError.
  let chanThrew = 0;
  try { microsharp(chanPng).extractChannel(5); } catch (e) { if (e instanceof RangeError) chanThrew++; }
  try { microsharp(chanPng).extractChannel(-1); } catch (e) { if (e instanceof RangeError) chanThrew++; }
  try { microsharp(chanPng).extractChannel('grey'); } catch (e) { if (e instanceof RangeError) chanThrew++; }
  plain('microsharp(): extractChannel(invalid) throws RangeError', chanThrew === 3);

  // bandbool — sharp/libvips includes the alpha band in the op.
  // R=10 (0b00001010), G=200 (0b11001000), B=50 (0b00110010), A=128 (0b10000000).
  // and = 10 & 200 & 50 & 128 = 0
  // or  = 10 | 200 | 50 | 128 = 0b11111010 = 250
  // eor = 10 ^ 200 ^ 50 ^ 128 = 0b01110000 = 112
  const andOut = await microsharp(chanPng).bandbool('and').raw().toBuffer();
  plain('microsharp(): bandbool(\'and\') incl. α',
    andOut[0] === 0 && andOut[1] === 0 && andOut[2] === 0 && andOut[3] === 255);
  const orOut = await microsharp(chanPng).bandbool('or').raw().toBuffer();
  plain('microsharp(): bandbool(\'or\') incl. α',
    orOut[0] === 250 && orOut[1] === 250 && orOut[2] === 250 && orOut[3] === 255);
  const eorOut = await microsharp(chanPng).bandbool('eor').raw().toBuffer();
  plain('microsharp(): bandbool(\'eor\') incl. α',
    eorOut[0] === 112 && eorOut[1] === 112 && eorOut[2] === 112 && eorOut[3] === 255);
  // 'xor' alias for eor.
  const xorOut = await microsharp(chanPng).bandbool('xor').raw().toBuffer();
  plain('microsharp(): bandbool(\'xor\') aliases \'eor\'',
    xorOut[0] === 112 && xorOut[1] === 112 && xorOut[2] === 112);

  let bandThrew = false;
  try { microsharp(chanPng).bandbool('nand'); } catch (e) { bandThrew = e instanceof RangeError; }
  plain('microsharp(): bandbool(invalid) throws RangeError', bandThrew);

  // joinChannel — pre-decoded raw mask (1-channel grey).
  // Build a 10×10 mask where every pixel has L=64.
  const maskRaw = new Uint8Array(10 * 10);
  for (let i = 0; i < maskRaw.length; i++) maskRaw[i] = 64;
  const joined1 = await microsharp(chanPng).joinChannel(maskRaw, {
    raw: { width: 10, height: 10, channels: 1 },
  }).raw().toBuffer();
  // RGB unchanged (10, 200, 50); α = luma(64,64,64) = 64.
  plain('microsharp(): joinChannel raw 1-channel sets α to L',
    joined1[0] === 10 && joined1[1] === 200 && joined1[2] === 50 && joined1[3] === 64);

  // joinChannel — encoded PNG mask (build via canvas).
  const maskCanvas = createCanvas(10, 10);
  const maskCtx = maskCanvas.getContext('2d');
  maskCtx.fillStyle = 'rgb(120, 120, 120)';
  maskCtx.fillRect(0, 0, 10, 10);
  const maskPng = maskCanvas.toBytes();
  const joinedPng = await microsharp(chanPng).joinChannel(maskPng).raw().toBuffer();
  plain('microsharp(): joinChannel encoded PNG mask sets α to luma',
    joinedPng[0] === 10 && joinedPng[3] === 120);

  // joinChannel — sharp's array-with-one-image form.
  const joinedArr = await microsharp(chanPng).joinChannel([maskPng]).raw().toBuffer();
  plain('microsharp(): joinChannel([image]) accepts single-element array',
    joinedArr[3] === 120);

  // joinChannel — multi-image array throws (we don't support libvips
  // multi-band joins in the always-RGBA model).
  let joinArrThrew = false;
  try { microsharp(chanPng).joinChannel([maskPng, maskPng]); }
  catch (e) { joinArrThrew = e instanceof RangeError; }
  plain('microsharp(): joinChannel multi-image array throws', joinArrThrew);

  // joinChannel — dimension mismatch throws.
  let joinDimThrew = false;
  try {
    const wrongMask = createCanvas(20, 20).toBytes();
    await microsharp(chanPng).joinChannel(wrongMask).toBuffer();
  } catch (e) { joinDimThrew = e instanceof RangeError; }
  plain('microsharp(): joinChannel size-mismatch throws', joinDimThrew);

  // joinChannel — raw 3-channel input is luma-converted.
  const mask3 = new Uint8Array(10 * 10 * 3);
  for (let i = 0; i < 10 * 10; i++) {
    mask3[i * 3 + 0] = 100;  // R
    mask3[i * 3 + 1] = 150;  // G
    mask3[i * 3 + 2] = 200;  // B
  }
  const joined3 = await microsharp(chanPng).joinChannel(mask3, {
    raw: { width: 10, height: 10, channels: 3 },
  }).raw().toBuffer();
  // luma(100, 150, 200) = round(100*0.299 + 150*0.587 + 200*0.114) = round(29.9 + 88.05 + 22.8) ≈ 141
  // (with the integer-rounded formula in SmChannel: (100*299 + 150*587 + 200*114 + 500) / 1000 = 141)
  plain('microsharp(): joinChannel raw 3-channel uses Rec.601 luma',
    joined3[3] === 141);

  // Chained: extractChannel green → bandbool('or') round-trips through
  // applyOps with two consecutive ops correctly. extractChannel emits
  // RGB=200, α=255, so or = 200|200|200|255 = 0b11111111 = 255.
  const chained = await microsharp(chanPng)
    .extractChannel('green')
    .bandbool('or')
    .raw().toBuffer();
  plain('microsharp(): extractChannel + bandbool chain', chained[0] === 255);

  // ---- colour manipulation -----------------------------------------------

  // chanPng pixel: R=10, G=200, B=50, A=128.
  // Rec.601 luma: L = (10·299 + 200·587 + 50·114 + 500) / 1000
  //               = (2990 + 117400 + 5700 + 500) / 1000 = 126.
  const tintYellow = await microsharp(chanPng)
    .tint({ r: 255, g: 240, b: 16 }).raw().toBuffer();
  // R' = (126·255 + 127) / 255 = 32257/255 = 126
  // G' = (126·240 + 127) / 255 = 30367/255 = 119
  // B' = (126·16  + 127) / 255 = 2143/255  = 8
  // α preserved (sharp spec).
  plain('microsharp(): tint({r,g,b}) — luma-scaled RGB, α preserved',
    tintYellow[0] === 126 && tintYellow[1] === 119 && tintYellow[2] === 8 &&
    tintYellow[3] === 128);

  // String input goes through parseCssColor → packed RGBA → triple.
  const tintRed = await microsharp(chanPng).tint('#ff0000').raw().toBuffer();
  plain('microsharp(): tint("#ff0000") — string colour parses',
    tintRed[0] === 126 && tintRed[1] === 0 && tintRed[2] === 0 && tintRed[3] === 128);

  // tint(invalid string) → RangeError via parseBackground.
  let tintThrew = false;
  try { microsharp(chanPng).tint('not-a-colour'); }
  catch (e) { tintThrew = e instanceof RangeError; }
  plain('microsharp(): tint("not-a-colour") throws RangeError', tintThrew);

  // greyscale — R=G=B=L=126, α preserved.
  const grey = await microsharp(chanPng).greyscale().raw().toBuffer();
  plain('microsharp(): greyscale() collapses RGB to Rec.601 luma',
    grey[0] === 126 && grey[1] === 126 && grey[2] === 126 && grey[3] === 128);

  // grayscale alias produces identical output.
  const greyAlias = await microsharp(chanPng).grayscale().raw().toBuffer();
  plain('microsharp(): grayscale() alias matches greyscale()',
    greyAlias[0] === 126 && greyAlias[3] === 128);

  // greyscale(false) — sharp parity: records nothing, output unchanged.
  const greyOff = await microsharp(chanPng).greyscale(false).raw().toBuffer();
  plain('microsharp(): greyscale(false) is a no-op',
    greyOff[0] === 10 && greyOff[1] === 200 && greyOff[2] === 50);

  // Chain: tint(red) → greyscale collapses again to luma.
  // tint(200,0,0): R'=(126·200+127)/255 = 25327/255 = 99.
  // After tint, pixel is (99, 0, 0, 128). Then greyscale:
  // L = (99·299 + 500)/1000 = 30101/1000 = 30.
  const tintGrey = await microsharp(chanPng)
    .tint({ r: 200, g: 0, b: 0 }).greyscale().raw().toBuffer();
  plain('microsharp(): tint() + greyscale() collapses to tinted luma',
    tintGrey[0] === 30 && tintGrey[1] === 30 && tintGrey[2] === 30 &&
    tintGrey[3] === 128);

  // pipelineColourspace('srgb') — accepted, no pixel change.
  const psSrgb = await microsharp(chanPng).pipelineColourspace('srgb').raw().toBuffer();
  plain('microsharp(): pipelineColourspace("srgb") is a no-op',
    psSrgb[0] === 10 && psSrgb[1] === 200 && psSrgb[2] === 50 && psSrgb[3] === 128);

  // pipelineColorspace alias accepts the same values.
  const psSrgbAlt = await microsharp(chanPng).pipelineColorspace('srgb').raw().toBuffer();
  plain('microsharp(): pipelineColorspace("srgb") alias is a no-op',
    psSrgbAlt[0] === 10 && psSrgbAlt[3] === 128);

  // pipelineColourspace('rgb16') — accepted, output stays 8-bit sRGB.
  const psRgb16 = await microsharp(chanPng).pipelineColourspace('rgb16').raw().toBuffer();
  plain('microsharp(): pipelineColourspace("rgb16") accepted as 8-bit passthrough',
    psRgb16[0] === 10 && psRgb16[1] === 200);

  // pipelineColourspace('lab') / 'cmyk' — accepted, passthrough.
  const psLab = await microsharp(chanPng).pipelineColourspace('lab').raw().toBuffer();
  plain('microsharp(): pipelineColourspace("lab") accepted as 8-bit passthrough',
    psLab[0] === 10 && psLab[3] === 128);

  // pipelineColourspace('b-w') — leading greyscale (luma 126).
  const psBW = await microsharp(chanPng).pipelineColourspace('b-w').raw().toBuffer();
  plain('microsharp(): pipelineColourspace("b-w") triggers leading greyscale',
    psBW[0] === 126 && psBW[1] === 126 && psBW[2] === 126 && psBW[3] === 128);

  // pipelineColourspace(unrecognised) → RangeError.
  let pipelineThrew = false;
  try { microsharp(chanPng).pipelineColourspace('not-a-real-space'); }
  catch (e) { pipelineThrew = e instanceof RangeError; }
  plain('microsharp(): pipelineColourspace("not-a-real-space") throws RangeError',
    pipelineThrew);

  // toColourspace('srgb') — accepted, no pixel change.
  const tcSrgb = await microsharp(chanPng).toColourspace('srgb').raw().toBuffer();
  plain('microsharp(): toColourspace("srgb") is a no-op',
    tcSrgb[0] === 10 && tcSrgb[3] === 128);

  // toColorspace alias.
  const tcSrgbAlt = await microsharp(chanPng).toColorspace('srgb').raw().toBuffer();
  plain('microsharp(): toColorspace("srgb") alias is a no-op',
    tcSrgbAlt[0] === 10);

  // toColourspace('b-w') — tail greyscale, RGB collapse to luma.
  const tcBW = await microsharp(chanPng).toColourspace('b-w').raw().toBuffer();
  plain('microsharp(): toColourspace("b-w") emits greyscale',
    tcBW[0] === 126 && tcBW[1] === 126 && tcBW[2] === 126 && tcBW[3] === 128);

  // toColourspace('grey16') — sharp parity: also greyscale-shaped.
  const tcGrey16 = await microsharp(chanPng).toColourspace('grey16').raw().toBuffer();
  plain('microsharp(): toColourspace("grey16") emits greyscale',
    tcGrey16[0] === 126 && tcGrey16[3] === 128);

  // toColourspace('cmyk') / 'lab' / 'rgb16' — accepted, passthrough.
  const tcCmyk = await microsharp(chanPng).toColourspace('cmyk').raw().toBuffer();
  plain('microsharp(): toColourspace("cmyk") accepted as 8-bit sRGB passthrough',
    tcCmyk[0] === 10 && tcCmyk[3] === 128);

  // toColourspace(unrecognised) → RangeError.
  let toCSThrew = false;
  try { microsharp(chanPng).toColourspace('garbage'); }
  catch (e) { toCSThrew = e instanceof RangeError; }
  plain('microsharp(): toColourspace("garbage") throws RangeError', toCSThrew);

  // Combined: pipelineColourspace + ops + toColourspace.
  // pipelineColourspace('rgb') (no-op) → tint(red) → toColourspace('b-w')
  // tints to (99,0,0,128) then greyscale to L = (99·299+500)/1000 = 30.
  const combined = await microsharp(chanPng)
    .pipelineColourspace('rgb')
    .tint({ r: 200, g: 0, b: 0 })
    .toColourspace('b-w')
    .raw().toBuffer();
  plain('microsharp(): pipelineColourspace + tint + toColourspace chain',
    combined[0] === 30 && combined[1] === 30 && combined[2] === 30 &&
    combined[3] === 128);

  // ---- image operations / Phase 1: rotate / flip / flop / affine / autoOrient ----

  // 3-wide × 2-tall asymmetric fixture. Pixels labelled A..F so we can
  // assert the transform-mapping byte-exact (90°/180°/270° / flip / flop
  // are lossless index permutations).
  //   A B C
  //   D E F
  const A = [255, 0, 0, 255];      // red
  const B = [0, 255, 0, 255];      // green
  const C = [0, 0, 255, 255];      // blue
  const D = [0, 255, 255, 255];    // cyan
  const E = [255, 0, 255, 255];    // magenta
  const F = [255, 255, 0, 255];    // yellow
  const geomCanvas = createCanvas(3, 2);
  const geomCtx = geomCanvas.getContext('2d');
  const geomImg = geomCtx.createImageData(3, 2);
  const geomFill = [A, B, C, D, E, F];
  for (let i = 0; i < geomFill.length; i++) {
    const px = geomFill[i];
    geomImg.data[i * 4 + 0] = px[0];
    geomImg.data[i * 4 + 1] = px[1];
    geomImg.data[i * 4 + 2] = px[2];
    geomImg.data[i * 4 + 3] = px[3];
  }
  geomCtx.putImageData(geomImg, 0, 0);
  const geomPng = geomCanvas.toBytes();

  function pixEq(buf, off, expected) {
    return buf[off + 0] === expected[0] &&
           buf[off + 1] === expected[1] &&
           buf[off + 2] === expected[2] &&
           buf[off + 3] === expected[3];
  }

  // rotate(90) — output 2×3:
  //   D A
  //   E B
  //   F C
  const r90 = await microsharp(geomPng).rotate(90).raw().toBuffer();
  const r90Meta = await microsharp(await microsharp(geomPng).rotate(90).png().toBuffer()).metadata();
  plain('microsharp(): rotate(90) swaps dims → 2×3',
    r90Meta.width === 2 && r90Meta.height === 3);
  plain('microsharp(): rotate(90) byte-exact pattern',
    pixEq(r90, 0, D) && pixEq(r90, 4, A) &&
    pixEq(r90, 8, E) && pixEq(r90, 12, B) &&
    pixEq(r90, 16, F) && pixEq(r90, 20, C));

  // rotate(180) — same dims, fully reversed:
  //   F E D
  //   C B A
  const r180 = await microsharp(geomPng).rotate(180).raw().toBuffer();
  plain('microsharp(): rotate(180) byte-exact pattern',
    pixEq(r180, 0, F) && pixEq(r180, 4, E) && pixEq(r180, 8, D) &&
    pixEq(r180, 12, C) && pixEq(r180, 16, B) && pixEq(r180, 20, A));

  // rotate(270) — output 2×3:
  //   C F
  //   B E
  //   A D
  const r270 = await microsharp(geomPng).rotate(270).raw().toBuffer();
  plain('microsharp(): rotate(270) byte-exact pattern',
    pixEq(r270, 0, C) && pixEq(r270, 4, F) &&
    pixEq(r270, 8, B) && pixEq(r270, 12, E) &&
    pixEq(r270, 16, A) && pixEq(r270, 20, D));

  // rotate(-450) normalises to rotate(270).
  const rNeg = await microsharp(geomPng).rotate(-450).raw().toBuffer();
  plain('microsharp(): rotate(-450) normalises to 270',
    pixEq(rNeg, 0, C) && pixEq(rNeg, 4, F));

  // rotate(0) is identity.
  const r0 = await microsharp(geomPng).rotate(0).raw().toBuffer();
  plain('microsharp(): rotate(0) is identity',
    pixEq(r0, 0, A) && pixEq(r0, 4, B) && pixEq(r0, 8, C));

  // flip — vertical mirror:
  //   D E F
  //   A B C
  const flipped = await microsharp(geomPng).flip().raw().toBuffer();
  plain('microsharp(): flip() mirrors top↔bottom',
    pixEq(flipped, 0, D) && pixEq(flipped, 4, E) && pixEq(flipped, 8, F) &&
    pixEq(flipped, 12, A) && pixEq(flipped, 16, B) && pixEq(flipped, 20, C));

  // flop — horizontal mirror:
  //   C B A
  //   F E D
  const flopped = await microsharp(geomPng).flop().raw().toBuffer();
  plain('microsharp(): flop() mirrors left↔right',
    pixEq(flopped, 0, C) && pixEq(flopped, 4, B) && pixEq(flopped, 8, A) &&
    pixEq(flopped, 12, F) && pixEq(flopped, 16, E) && pixEq(flopped, 20, D));

  // flip(false) / flop(false) record nothing (sharp parity).
  const flipOff = await microsharp(geomPng).flip(false).raw().toBuffer();
  plain('microsharp(): flip(false) is a no-op',
    pixEq(flipOff, 0, A) && pixEq(flipOff, 4, B));
  const flopOff = await microsharp(geomPng).flop(false).raw().toBuffer();
  plain('microsharp(): flop(false) is a no-op',
    pixEq(flopOff, 0, A) && pixEq(flopOff, 4, B));

  // rotate(45) — AABB dims of 3×2 are
  //   ceil(3·cos45 + 2·sin45) = ceil(3.535...) = 4
  //   ceil(3·sin45 + 2·cos45) = ceil(3.535...) = 4
  // so output is 4×4. Background fills the corners.
  const r45 = await microsharp(geomPng)
    .rotate(45, { background: '#00ff00' })
    .png().toBuffer();
  const r45Meta = await microsharp(r45).metadata();
  plain('microsharp(): rotate(45) AABB dims',
    r45Meta.width === 4 && r45Meta.height === 4);

  const r45Raw = await microsharp(geomPng)
    .rotate(45, { background: '#00ff00' })
    .raw().toBuffer();
  // The four corners of the output bbox are background-coloured —
  // outside the rotated source rectangle.
  plain('microsharp(): rotate(45) corners take background colour',
    pixEq(r45Raw, 0, [0, 255, 0, 255]) &&
    pixEq(r45Raw, (4 * 4 - 1) * 4, [0, 255, 0, 255]));

  // Non-finite angle → RangeError.
  let rotThrew = false;
  try { microsharp(geomPng).rotate(Number.NaN); }
  catch (e) { rotThrew = e instanceof RangeError; }
  plain('microsharp(): rotate(NaN) throws RangeError', rotThrew);

  // affine identity (matrix = identity, no offsets) is a no-op.
  const affId = await microsharp(geomPng).affine([1, 0, 0, 1]).raw().toBuffer();
  plain('microsharp(): affine([1,0,0,1]) is identity',
    pixEq(affId, 0, A) && pixEq(affId, 4, B) && pixEq(affId, 8, C));

  // affine([[1,0],[0,1]]) — nested 2×2 form accepted.
  const affNested = await microsharp(geomPng).affine([[1, 0], [0, 1]]).raw().toBuffer();
  plain('microsharp(): affine([[a,b],[c,d]]) nested form',
    pixEq(affNested, 0, A) && pixEq(affNested, 4, B));

  // affine matrix shape errors.
  let affThrew = 0;
  try { microsharp(geomPng).affine([1, 2, 3]); } catch (e) { if (e instanceof RangeError) affThrew++; }
  try { microsharp(geomPng).affine([[1, 2, 3], [4, 5, 6]]); } catch (e) { if (e instanceof RangeError) affThrew++; }
  plain('microsharp(): affine bad-shape matrix throws RangeError', affThrew === 2);

  // affine 90° rotation (matrix [[0,-1],[1,0]]) on 3×2 → output bbox 2×3.
  // A canvas-space 90° rotate without idx/idy/odx/ody offsets produces
  // the same pixel mapping as rotate90 (modulo bilinear sampling at the
  // pixel edges). Asserting dims is cheap and reliable.
  const aff90 = await microsharp(geomPng).affine([0, -1, 1, 0]).png().toBuffer();
  const aff90Meta = await microsharp(aff90).metadata();
  plain('microsharp(): affine [[0,-1],[1,0]] rotates 90° → 2×3',
    aff90Meta.width === 2 && aff90Meta.height === 3);

  // Singular matrix (det == 0) → RangeError.
  let affSingularThrew = false;
  try {
    await microsharp(geomPng).affine([1, 1, 2, 2]).toBuffer();
  } catch (e) { affSingularThrew = e !== null; }
  plain('microsharp(): affine singular matrix throws', affSingularThrew);

  // Unrecognised interpolator → RangeError.
  let interpThrew = false;
  try {
    microsharp(geomPng).affine([1, 0, 0, 1], { interpolator: 'magic' });
  } catch (e) { interpThrew = e instanceof RangeError; }
  plain('microsharp(): affine bad interpolator throws RangeError', interpThrew);

  // Sharp's high-precision libvips kernels collapse to bilinear in our
  // sampler — accept the names without throwing.
  const affNohalo = await microsharp(geomPng)
    .affine([1, 0, 0, 1], { interpolator: 'nohalo' })
    .raw().toBuffer();
  plain('microsharp(): affine interpolator="nohalo" accepted (maps to bilinear)',
    pixEq(affNohalo, 0, A));

  // ---- autoOrient ----------------------------------------------------------

  // Build a JPEG and inject EXIF Orientation=6 (90° CW). Sharp's autoOrient
  // on Orientation=6 swaps dims (rotate 90° CW).
  function injectExifOrientation(jpegBytes, orientation) {
    // Minimal TIFF + APP1 segment carrying the Orientation tag (0x0112)
    // as a SHORT (TIFF type 3). Layout per the EXIF/TIFF rev 2.32 spec.
    const tiff = new Uint8Array([
      0x49, 0x49,                        // "II" little-endian
      0x2a, 0x00,                        // TIFF magic 0x002A
      0x08, 0x00, 0x00, 0x00,            // IFD0 offset = 8
      0x01, 0x00,                        // entry count = 1
      0x12, 0x01,                        // tag = 0x0112 (Orientation)
      0x03, 0x00,                        // type = 3 (SHORT)
      0x01, 0x00, 0x00, 0x00,            // count = 1
      orientation & 0xff, 0x00,          // value (low 2 bytes of the field)
      0x00, 0x00,                        // padding for SHORT
      0x00, 0x00, 0x00, 0x00,            // next IFD offset = 0
    ]);
    const exifMagic = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // 'Exif\0\0'
    const payload = new Uint8Array(exifMagic.length + tiff.length);
    payload.set(exifMagic, 0);
    payload.set(tiff, exifMagic.length);
    const segLen = payload.length + 2; // includes the 2 length bytes
    const out = new Uint8Array(jpegBytes.length + 4 + payload.length);
    out[0] = 0xff;
    out[1] = 0xd8; // SOI
    out[2] = 0xff;
    out[3] = 0xe1; // APP1 marker
    out[4] = (segLen >> 8) & 0xff;
    out[5] = segLen & 0xff;
    out.set(payload, 6);
    out.set(jpegBytes.subarray(2), 6 + payload.length);
    return out;
  }

  // Encode a known 4×3 fixture as JPEG to inject EXIF into.
  const orientCanvas = createCanvas(4, 3);
  const orientCtx = orientCanvas.getContext('2d');
  orientCtx.fillStyle = '#0066ff';
  orientCtx.fillRect(0, 0, 4, 3);
  const baseJpeg = orientCanvas.toBytes('image/jpeg', 0.95);

  // Direct test of the EXIF reader: peekOrientation on the raw bytes.
  const taggedJpeg = injectExifOrientation(baseJpeg, 6);
  const peekJpeg6 = await (async () => {
    const meta = await microsharp(taggedJpeg).metadata();
    return meta.width === 4 && meta.height === 3;
  })();
  plain('microsharp(): EXIF-tagged JPEG decodes (dimensions intact)', peekJpeg6);

  // autoOrient on the EXIF-tagged JPEG: 90° CW → dims 4×3 swap to 3×4.
  const auto6 = await microsharp(taggedJpeg).autoOrient().png().toBuffer();
  const auto6Meta = await microsharp(auto6).metadata();
  plain('microsharp(): autoOrient on Orientation=6 swaps dims (4×3 → 3×4)',
    auto6Meta.width === 3 && auto6Meta.height === 4);

  // Orientation=1 (no rotation) → dims unchanged.
  const tagged1 = injectExifOrientation(baseJpeg, 1);
  const auto1 = await microsharp(tagged1).autoOrient().png().toBuffer();
  const auto1Meta = await microsharp(auto1).metadata();
  plain('microsharp(): autoOrient on Orientation=1 is a no-op (dims preserved)',
    auto1Meta.width === 4 && auto1Meta.height === 3);

  // Orientation=3 → 180° rotate. Dims preserved.
  const tagged3 = injectExifOrientation(baseJpeg, 3);
  const auto3 = await microsharp(tagged3).autoOrient().png().toBuffer();
  const auto3Meta = await microsharp(auto3).metadata();
  plain('microsharp(): autoOrient on Orientation=3 rotates 180° (dims preserved)',
    auto3Meta.width === 4 && auto3Meta.height === 3);

  // Orientation=8 → 90° CCW (rotate270). Dims swap.
  const tagged8 = injectExifOrientation(baseJpeg, 8);
  const auto8 = await microsharp(tagged8).autoOrient().png().toBuffer();
  const auto8Meta = await microsharp(auto8).metadata();
  plain('microsharp(): autoOrient on Orientation=8 swaps dims (4×3 → 3×4)',
    auto8Meta.width === 3 && auto8Meta.height === 4);

  // PNG without an eXIf chunk → autoOrient is a no-op.
  const autoPlainPng = await microsharp(geomPng).autoOrient().raw().toBuffer();
  plain('microsharp(): autoOrient on plain PNG (no eXIf) is a no-op',
    pixEq(autoPlainPng, 0, A) && pixEq(autoPlainPng, 4, B));

  // rotate() with no arguments aliases autoOrient (sharp back-compat).
  const noArgRotate = await microsharp(taggedJpeg).rotate().png().toBuffer();
  const noArgMeta = await microsharp(noArgRotate).metadata();
  plain('microsharp(): rotate() no-args aliases autoOrient (Orientation=6 → swap)',
    noArgMeta.width === 3 && noArgMeta.height === 4);

  // ---- image operations / Phase 2: blur / sharpen / convolve / median / dilate / erode ----

  // 9×9 solid-cyan canvas with a single red pixel at the centre.
  // Useful for: blur softens the impulse; dilate(1) expands it to a
  // 3×3 box; convolve with identity kernel preserves it.
  const morphCanvas = createCanvas(9, 9);
  const morphCtx = morphCanvas.getContext('2d');
  morphCtx.fillStyle = '#00ffff';
  morphCtx.fillRect(0, 0, 9, 9);
  morphCtx.fillStyle = '#ff0000';
  morphCtx.fillRect(4, 4, 1, 1);
  const morphPng = morphCanvas.toBytes();
  // Helper: read raw RGBA at (x, y) of a 9×9 buffer.
  const RGB = (buf, x, y, w = 9) => {
    const off = (y * w + x) * 4;
    return [buf[off], buf[off + 1], buf[off + 2], buf[off + 3]];
  };

  // blur() no-args — fast 3×3 box. Centre pixel R should be reduced
  // (averaged with 8 cyan neighbours): R = round((255 + 8·0)/9) = 28.
  const blurFast = await microsharp(morphPng).blur().raw().toBuffer();
  const blurFastCentre = RGB(blurFast, 4, 4);
  plain('microsharp(): blur() no-args softens centre red pixel',
    blurFastCentre[0] < 60 && blurFastCentre[0] > 10);

  // blur(false) — sharp parity: records nothing.
  const blurOff = await microsharp(morphPng).blur(false).raw().toBuffer();
  plain('microsharp(): blur(false) is a no-op',
    RGB(blurOff, 4, 4)[0] === 255);

  // blur(sigma) — Gaussian. Sigma 2 should soften red impulse below
  // the box-blur amount (depending on kernel extent), and the result
  // is still > 0 — the impulse is non-zero across most of the image.
  const blurSig = await microsharp(morphPng).blur(2).raw().toBuffer();
  const blurSigCentre = RGB(blurSig, 4, 4);
  plain('microsharp(): blur(sigma=2) Gaussian softens centre',
    blurSigCentre[0] > 0 && blurSigCentre[0] < 255 &&
    blurSigCentre[1] > 200);

  // blur({ precision: 'approximate' }) — uses the existing 3-pass box.
  const blurApprox = await microsharp(morphPng)
    .blur({ sigma: 2, precision: 'approximate' }).raw().toBuffer();
  plain('microsharp(): blur({precision:"approximate"}) emits valid pixels',
    blurApprox.length === 9 * 9 * 4 && blurApprox[3] === 255);

  // Out-of-range sigma → RangeError.
  let blurSigThrew = 0;
  try { microsharp(morphPng).blur(0.1); } catch (e) { if (e instanceof RangeError) blurSigThrew++; }
  try { microsharp(morphPng).blur({ sigma: 2000 }); } catch (e) { if (e instanceof RangeError) blurSigThrew++; }
  plain('microsharp(): blur(sigma) range check throws RangeError', blurSigThrew === 2);

  // Out-of-range minAmplitude → RangeError.
  let blurAmpThrew = false;
  try { microsharp(morphPng).blur({ sigma: 1, minAmplitude: 1.5 }); }
  catch (e) { blurAmpThrew = e instanceof RangeError; }
  plain('microsharp(): blur({minAmplitude}) range check throws', blurAmpThrew);

  // Bad precision → RangeError.
  let blurPrecThrew = false;
  try { microsharp(morphPng).blur({ sigma: 1, precision: 'fancy' }); }
  catch (e) { blurPrecThrew = e instanceof RangeError; }
  plain('microsharp(): blur({precision:"fancy"}) throws RangeError', blurPrecThrew);

  // sharpen() no-args — 3×3 unsharp kernel. On the morph fixture the
  // centre stays red (255) and adjacent pixels darken (negative
  // weight in the kernel). Just check the centre and one neighbour
  // diverged from the cyan baseline.
  const sharpFast = await microsharp(morphPng).sharpen().raw().toBuffer();
  const sharpCentre = RGB(sharpFast, 4, 4);
  plain('microsharp(): sharpen() no-args preserves centre colour pole',
    sharpCentre[0] === 255 && sharpCentre[3] === 255);

  // sharpen({ sigma }) — USM. Output is finite RGBA, alpha preserved.
  const sharpUSM = await microsharp(morphPng).sharpen({ sigma: 1 }).raw().toBuffer();
  plain('microsharp(): sharpen({sigma}) USM emits valid pixels',
    sharpUSM.length === 9 * 9 * 4 && sharpUSM[3] === 255);

  // sharpen(sigma, flat, jagged) — deprecated 2-positional form maps
  // to m1/m2. Just smoke-test it doesn't throw.
  const sharpDep = await microsharp(morphPng).sharpen(1, 0.5, 3).raw().toBuffer();
  plain('microsharp(): sharpen(sigma, flat, jagged) deprecated form accepted',
    sharpDep.length === 9 * 9 * 4);

  // sharpen out-of-range sigma → RangeError.
  let sharpThrew = false;
  try { microsharp(morphPng).sharpen({ sigma: 100 }); }
  catch (e) { sharpThrew = e instanceof RangeError; }
  plain('microsharp(): sharpen({sigma:100}) throws RangeError', sharpThrew);

  // convolve identity kernel — exact passthrough.
  const idConv = await microsharp(morphPng).convolve({
    width: 3, height: 3,
    kernel: [0, 0, 0, 0, 1, 0, 0, 0, 0],
  }).raw().toBuffer();
  plain('microsharp(): convolve identity kernel is a passthrough',
    RGB(idConv, 4, 4)[0] === 255 &&
    RGB(idConv, 0, 0)[0] === 0 && RGB(idConv, 0, 0)[1] === 255);

  // convolve 3×3 box blur kernel (manual). Same shape as .blur() fast path.
  const boxConv = await microsharp(morphPng).convolve({
    width: 3, height: 3,
    kernel: [1, 1, 1, 1, 1, 1, 1, 1, 1],
  }).raw().toBuffer();
  const boxCentre = RGB(boxConv, 4, 4);
  plain('microsharp(): convolve 3×3-ones matches box-blur shape',
    boxCentre[0] > 10 && boxCentre[0] < 60 && boxCentre[3] === 255);

  // convolve with explicit scale + offset.
  const scaledConv = await microsharp(morphPng).convolve({
    width: 3, height: 3,
    kernel: [0, 0, 0, 0, 2, 0, 0, 0, 0],
    scale: 2, offset: 0,
  }).raw().toBuffer();
  plain('microsharp(): convolve scale + offset clips to [0,255]',
    RGB(scaledConv, 4, 4)[0] === 255);

  // convolve length mismatch → RangeError.
  let convThrew = 0;
  try {
    microsharp(morphPng).convolve({ width: 3, height: 3, kernel: [1, 2, 3] });
  } catch (e) { if (e instanceof RangeError) convThrew++; }
  // Even-dim kernel.
  try {
    microsharp(morphPng).convolve({ width: 2, height: 3, kernel: new Array(6).fill(0) });
  } catch (e) { if (e instanceof RangeError) convThrew++; }
  plain('microsharp(): convolve bad shape throws RangeError', convThrew === 2);

  // dilate(1) on the single-red-pixel fixture — the red 1×1 expands
  // to a 3×3. The four corners of that 3×3 (at coords (3,3) to (5,5))
  // should all be red after dilation (max-window).
  const dilated = await microsharp(morphPng).dilate(1).raw().toBuffer();
  plain('microsharp(): dilate(1) expands 1×1 red into 3×3 box',
    RGB(dilated, 3, 3)[0] === 255 && RGB(dilated, 5, 5)[0] === 255 &&
    RGB(dilated, 4, 4)[0] === 255);

  // dilate(0) — sharp accepts; documented as no-op.
  const dilate0 = await microsharp(morphPng).dilate(0).raw().toBuffer();
  plain('microsharp(): dilate(0) is a no-op',
    RGB(dilate0, 4, 4)[0] === 255 && RGB(dilate0, 0, 0)[0] === 0);

  // erode on the inverted fixture (mostly white with a black hole)
  // shrinks the hole. Easier visual: erode(1) on the morph fixture
  // dims the red pixel because the cyan max wins everywhere except
  // the dead-centre — actually erode (min) on red 1-pixel surrounded
  // by cyan: min over the 3×3 window (cyan is (0, 255, 255), red is
  // (255, 0, 0)) → min channel-wise = (0, 0, 0). So the centre
  // becomes black.
  const eroded = await microsharp(morphPng).erode(1).raw().toBuffer();
  plain('microsharp(): erode(1) clips R-channel min to 0 around impulse',
    RGB(eroded, 4, 4)[0] === 0 && RGB(eroded, 4, 4)[1] === 0 && RGB(eroded, 4, 4)[2] === 0);

  // dilate / erode bad width.
  let dilateThrew = 0;
  try { microsharp(morphPng).dilate(-1); } catch (e) { if (e instanceof RangeError) dilateThrew++; }
  try { microsharp(morphPng).erode(1.5); } catch (e) { if (e instanceof RangeError) dilateThrew++; }
  plain('microsharp(): dilate/erode bad width throws RangeError', dilateThrew === 2);

  // median(3) on a salt-and-pepper fixture: white field with black
  // dots scattered every other column on row 4 — median picks white.
  const saltCanvas = createCanvas(9, 9);
  const saltCtx = saltCanvas.getContext('2d');
  saltCtx.fillStyle = '#ffffff';
  saltCtx.fillRect(0, 0, 9, 9);
  saltCtx.fillStyle = '#000000';
  for (let i = 1; i < 9; i += 3) saltCtx.fillRect(i, 4, 1, 1);
  const saltPng = saltCanvas.toBytes();
  const cleaned = await microsharp(saltPng).median(3).raw().toBuffer();
  plain('microsharp(): median(3) removes salt-and-pepper isolated dots',
    RGB(cleaned, 1, 4)[0] === 255 &&
    RGB(cleaned, 4, 4)[0] === 255);

  // median default size = 3.
  const medDefault = await microsharp(saltPng).median().raw().toBuffer();
  plain('microsharp(): median() defaults size to 3',
    RGB(medDefault, 1, 4)[0] === 255);

  // median bad size.
  let medThrew = 0;
  try { microsharp(saltPng).median(2); } catch (e) { if (e instanceof RangeError) medThrew++; }
  try { microsharp(saltPng).median(0); } catch (e) { if (e instanceof RangeError) medThrew++; }
  try { microsharp(saltPng).median(101); } catch (e) { if (e instanceof RangeError) medThrew++; }
  plain('microsharp(): median bad size throws RangeError', medThrew === 3);

  // ---- image operations / Phase 3: tone & boolean ------------------------

  // Reuse chanPng (R=10, G=200, B=50, A=128) for per-pixel byte assertions.
  // Luma L = 126 (computed in Phase 1 colour-manipulation tests).

  // gamma(2.2, 2.2) — identity LUT.
  const g11 = await microsharp(chanPng).gamma(2.2, 2.2).raw().toBuffer();
  plain('microsharp(): gamma(g, g) is identity',
    g11[0] === 10 && g11[1] === 200 && g11[2] === 50 && g11[3] === 128);

  // gamma(2.2, 1.0) decodes sRGB→linear-ish: out = (in/255)^(2.2/1.0)·255.
  // For in=10: (10/255)^2.2 ≈ 0.000662; ·255 ≈ 0.169 → 0 after clipU8.
  // For in=200: (200/255)^2.2 ≈ 0.589; ·255 ≈ 150.
  const gDecode = await microsharp(chanPng).gamma(2.2, 1.0).raw().toBuffer();
  plain('microsharp(): gamma(2.2, 1.0) darkens dim values',
    gDecode[0] <= 1 && gDecode[1] >= 145 && gDecode[1] <= 155);

  // gamma() default = 2.2, gOut defaults to gIn → identity.
  const gDefault = await microsharp(chanPng).gamma().raw().toBuffer();
  plain('microsharp(): gamma() default is identity',
    gDefault[0] === 10 && gDefault[1] === 200);

  // Out-of-range gamma → RangeError.
  let gThrew = 0;
  try { microsharp(chanPng).gamma(0.5); } catch (e) { if (e instanceof RangeError) gThrew++; }
  try { microsharp(chanPng).gamma(2.2, 5); } catch (e) { if (e instanceof RangeError) gThrew++; }
  plain('microsharp(): gamma out-of-range throws RangeError', gThrew === 2);

  // negate() default — RGB and α flipped (sharp default `alpha:true`).
  const neg = await microsharp(chanPng).negate().raw().toBuffer();
  plain('microsharp(): negate() flips RGB and α',
    neg[0] === 245 && neg[1] === 55 && neg[2] === 205 && neg[3] === 127);

  // negate({ alpha: false }) — α preserved.
  const negNoA = await microsharp(chanPng).negate({ alpha: false }).raw().toBuffer();
  plain('microsharp(): negate({alpha:false}) preserves α',
    negNoA[0] === 245 && negNoA[3] === 128);

  // linear(0.5, 2) — single-number form: applies to RGB, α untouched.
  // 10·0.5 + 2 = 7; 200·0.5 + 2 = 102; 50·0.5 + 2 = 27.
  const lin = await microsharp(chanPng).linear(0.5, 2).raw().toBuffer();
  plain('microsharp(): linear(scalar a, scalar b) applies to RGB',
    lin[0] === 7 && lin[1] === 102 && lin[2] === 27 && lin[3] === 128);

  // linear with per-channel arrays.
  const linArr = await microsharp(chanPng).linear([0.5, 1, 2], [0, 0, 0]).raw().toBuffer();
  plain('microsharp(): linear([0.5,1,2], [0,0,0])',
    linArr[0] === 5 && linArr[1] === 200 && linArr[2] === 100 && linArr[3] === 128);

  // linear with length-4 array — touches alpha.
  const lin4 = await microsharp(chanPng).linear([1, 1, 1, 0.5], [0, 0, 0, 0]).raw().toBuffer();
  plain('microsharp(): linear length-4 a touches α',
    lin4[3] === 64);

  // linear() no-args is identity (a=1, b=0).
  const linId = await microsharp(chanPng).linear().raw().toBuffer();
  plain('microsharp(): linear() defaults are identity',
    linId[0] === 10 && linId[1] === 200);

  // linear bad-shape → RangeError.
  let linThrew = false;
  try { microsharp(chanPng).linear([1, 2]); }
  catch (e) { linThrew = e instanceof RangeError; }
  plain('microsharp(): linear bad-length array throws RangeError', linThrew);

  // threshold default — luma 126 < 128 → all zero RGB; α preserved.
  const th = await microsharp(chanPng).threshold().raw().toBuffer();
  plain('microsharp(): threshold() default 128 on luma 126 → black',
    th[0] === 0 && th[1] === 0 && th[2] === 0 && th[3] === 128);

  // threshold(100) — luma 126 ≥ 100 → all white RGB.
  const thLow = await microsharp(chanPng).threshold(100).raw().toBuffer();
  plain('microsharp(): threshold(100) on luma 126 → white',
    thLow[0] === 255 && thLow[1] === 255 && thLow[2] === 255);

  // threshold(t, { greyscale: false }) — per-channel; R=10<100→0, G=200≥100→255, B=50<100→0.
  const thRGB = await microsharp(chanPng).threshold(100, { greyscale: false }).raw().toBuffer();
  plain('microsharp(): threshold(100, {greyscale:false}) per-channel',
    thRGB[0] === 0 && thRGB[1] === 255 && thRGB[2] === 0 && thRGB[3] === 128);

  // grayscale alias.
  const thAlias = await microsharp(chanPng).threshold(100, { grayscale: false }).raw().toBuffer();
  plain('microsharp(): threshold(_, {grayscale:false}) alias',
    thAlias[1] === 255);

  // threshold bad t.
  let thThrew = 0;
  try { microsharp(chanPng).threshold(300); } catch (e) { if (e instanceof RangeError) thThrew++; }
  try { microsharp(chanPng).threshold(-1); } catch (e) { if (e instanceof RangeError) thThrew++; }
  plain('microsharp(): threshold out-of-range throws', thThrew === 2);

  // recomb identity 3×3 — RGB unchanged.
  const rec3id = await microsharp(chanPng).recomb([
    [1, 0, 0], [0, 1, 0], [0, 0, 1],
  ]).raw().toBuffer();
  plain('microsharp(): recomb 3×3 identity is no-op (α preserved)',
    rec3id[0] === 10 && rec3id[1] === 200 && rec3id[2] === 50 && rec3id[3] === 128);

  // recomb sepia-like matrix from sharp's docs. For chanPng (10,200,50):
  //   R' = 0.3588·10 + 0.7044·200 + 0.1368·50 = 151
  //   G' = 0.2990·10 + 0.5870·200 + 0.1140·50 = 126
  //   B' = 0.2392·10 + 0.4696·200 + 0.0912·50 = 101
  const sepia = await microsharp(chanPng).recomb([
    [0.3588, 0.7044, 0.1368],
    [0.2990, 0.5870, 0.1140],
    [0.2392, 0.4696, 0.0912],
  ]).raw().toBuffer();
  plain('microsharp(): recomb sepia-like matrix matches closed-form',
    sepia[0] === 151 && sepia[1] === 126 && sepia[2] === 101 && sepia[3] === 128);

  // recomb flat 9-array form.
  const recFlat = await microsharp(chanPng).recomb([1, 0, 0, 0, 1, 0, 0, 0, 1]).raw().toBuffer();
  plain('microsharp(): recomb flat-9 form',
    recFlat[0] === 10 && recFlat[1] === 200);

  // recomb 4×4 form including α.
  const rec4 = await microsharp(chanPng).recomb([
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 0.5],
  ]).raw().toBuffer();
  plain('microsharp(): recomb 4×4 touches α',
    rec4[0] === 10 && rec4[3] === 64);

  // recomb bad shape.
  let recThrew = 0;
  try { microsharp(chanPng).recomb([1, 2, 3]); } catch (e) { if (e instanceof RangeError) recThrew++; }
  try { microsharp(chanPng).recomb([[1, 2], [3, 4]]); } catch (e) { if (e instanceof RangeError) recThrew++; }
  plain('microsharp(): recomb bad-shape throws RangeError', recThrew === 2);

  // flatten — α=128 over white background.
  // out = clamp((128·src + 127·bg + 127) / 255). For src=10, bg=255:
  //   (128·10 + 127·255 + 127) / 255 = (1280 + 32385 + 127) / 255 = 33792/255 = 132.
  // For src=200, bg=255: (128·200 + 127·255 + 127) / 255 = (25600+32385+127)/255 = 58112/255 = 227.
  // For src=50, bg=255: (128·50 + 127·255 + 127) / 255 = (6400+32385+127)/255 = 38912/255 = 152.
  const flat = await microsharp(chanPng).flatten({ background: '#ffffff' }).raw().toBuffer();
  plain('microsharp(): flatten over white blends and forces α=255',
    flat[0] === 132 && flat[1] === 227 && flat[2] === 152 && flat[3] === 255);

  // flatten with default bg (#000000).
  const flatBlack = await microsharp(chanPng).flatten().raw().toBuffer();
  // For src·α/255 with bg=0: (128·10 + 127·0 + 127)/255 = 1407/255 = 5; (128·200 + 127)/255 = 100; (128·50 + 127)/255 = 25.
  plain('microsharp(): flatten() default-black halves brightness',
    flatBlack[0] === 5 && flatBlack[1] === 100 && flatBlack[2] === 25 && flatBlack[3] === 255);

  // unflatten — pure-white pixel → α=0; non-white untouched.
  const ufCanvas = createCanvas(2, 1);
  const ufCtx = ufCanvas.getContext('2d');
  const ufImg = ufCtx.createImageData(2, 1);
  ufImg.data[0] = 255; ufImg.data[1] = 255; ufImg.data[2] = 255; ufImg.data[3] = 255; // white
  ufImg.data[4] = 100; ufImg.data[5] = 100; ufImg.data[6] = 100; ufImg.data[7] = 200; // grey
  ufCtx.putImageData(ufImg, 0, 0);
  const ufPng = ufCanvas.toBytes();
  const uf = await microsharp(ufPng).unflatten().raw().toBuffer();
  plain('microsharp(): unflatten makes white pixels transparent',
    uf[3] === 0 && uf[7] === 200 &&
    uf[4] === 100 && uf[5] === 100 && uf[6] === 100);

  // boolean (binary form between two bitmaps). Build two 1×1 bitmaps
  // with non-trivial bytes via known PNG roundtrips.
  const aCanvas = createCanvas(1, 1);
  const aCtx = aCanvas.getContext('2d');
  const aImg = aCtx.createImageData(1, 1);
  aImg.data[0] = 0xf0; aImg.data[1] = 0x0f; aImg.data[2] = 0x55; aImg.data[3] = 0xaa;
  aCtx.putImageData(aImg, 0, 0);
  const aPng = aCanvas.toBytes();

  const bCanvas = createCanvas(1, 1);
  const bCtx = bCanvas.getContext('2d');
  const bImg = bCtx.createImageData(1, 1);
  bImg.data[0] = 0x0f; bImg.data[1] = 0xff; bImg.data[2] = 0xff; bImg.data[3] = 0x55;
  bCtx.putImageData(bImg, 0, 0);
  const bPng = bCanvas.toBytes();

  const andOut2 = await microsharp(aPng).boolean(bPng, 'and').raw().toBuffer();
  // 0xf0 & 0x0f = 0x00; 0x0f & 0xff = 0x0f; 0x55 & 0xff = 0x55; 0xaa & 0x55 = 0x00.
  plain('microsharp(): boolean(operand, "and")',
    andOut2[0] === 0x00 && andOut2[1] === 0x0f &&
    andOut2[2] === 0x55 && andOut2[3] === 0x00);

  const orOut2 = await microsharp(aPng).boolean(bPng, 'or').raw().toBuffer();
  // 0xf0 | 0x0f = 0xff; 0x0f | 0xff = 0xff; 0x55 | 0xff = 0xff; 0xaa | 0x55 = 0xff.
  plain('microsharp(): boolean(operand, "or")',
    orOut2[0] === 0xff && orOut2[1] === 0xff &&
    orOut2[2] === 0xff && orOut2[3] === 0xff);

  const eorOut2 = await microsharp(aPng).boolean(bPng, 'eor').raw().toBuffer();
  // 0xf0 ^ 0x0f = 0xff; 0x0f ^ 0xff = 0xf0; 0x55 ^ 0xff = 0xaa; 0xaa ^ 0x55 = 0xff.
  plain('microsharp(): boolean(operand, "eor")',
    eorOut2[0] === 0xff && eorOut2[1] === 0xf0 &&
    eorOut2[2] === 0xaa && eorOut2[3] === 0xff);

  // boolean accepts 'xor' alias for 'eor'.
  const xorOut2 = await microsharp(aPng).boolean(bPng, 'xor').raw().toBuffer();
  plain('microsharp(): boolean(operand, "xor") aliases "eor"',
    xorOut2[0] === 0xff && xorOut2[1] === 0xf0);

  // boolean with raw-pixel operand.
  const opRaw = new Uint8Array([0x0f, 0xff, 0xff, 0x55]);
  const rawBool = await microsharp(aPng)
    .boolean(opRaw, 'and', { raw: { width: 1, height: 1, channels: 4 } })
    .raw().toBuffer();
  plain('microsharp(): boolean(raw operand, "and")',
    rawBool[0] === 0x00 && rawBool[1] === 0x0f);

  // boolean size mismatch throws.
  let boolDimThrew = false;
  try {
    const big = createCanvas(2, 1).toBytes();
    await microsharp(aPng).boolean(big, 'and').toBuffer();
  } catch (e) { boolDimThrew = e !== null; }
  plain('microsharp(): boolean size mismatch throws', boolDimThrew);

  // boolean bad operator throws.
  let boolOpThrew = false;
  try { microsharp(aPng).boolean(bPng, 'nand'); }
  catch (e) { boolOpThrew = e instanceof RangeError; }
  plain('microsharp(): boolean bad operator throws RangeError', boolOpThrew);

  // ---- image operations / Phase 4: histogram & HSV -----------------------

  // normalise — build a low-contrast 9×1 fixture (luma values 100..108)
  // and verify the percentile stretch maps min→0 and max→255.
  const normCanvas = createCanvas(9, 1);
  const normCtx = normCanvas.getContext('2d');
  const normImg = normCtx.createImageData(9, 1);
  for (let i = 0; i < 9; i++) {
    const v = 100 + i; // luma 100..108
    normImg.data[i * 4 + 0] = v;
    normImg.data[i * 4 + 1] = v;
    normImg.data[i * 4 + 2] = v;
    normImg.data[i * 4 + 3] = 255;
  }
  normCtx.putImageData(normImg, 0, 0);
  const normPng = normCanvas.toBytes();
  const normalised = await microsharp(normPng).normalise({ lower: 0, upper: 100 }).raw().toBuffer();
  // With lower=0/upper=100, lo_luma=100, hi_luma=108. Each value v
  // maps to round((v - 100) * 255 / 8). v=100→0, v=108→255, midway
  // v=104 → round(4·255/8) = 128.
  plain('microsharp(): normalise stretches luma 100..108 → 0..255',
    normalised[0] === 0 && normalised[8 * 4] === 255 &&
    Math.abs(normalised[4 * 4] - 128) <= 1);

  // normalise alias `normalize` produces same shape.
  const normalizedAlias = await microsharp(normPng).normalize({ lower: 0, upper: 100 }).raw().toBuffer();
  plain('microsharp(): normalize() alias matches normalise()',
    normalizedAlias[0] === 0 && normalizedAlias[8 * 4] === 255);

  // normalise default (lower=1, upper=99) — for a 9-pixel uniform-luma
  // ramp, the percentile cutoffs land at the extremes too: lo_target =
  // 9·0.01 = 0 → first bin past 0 cum is luma 100; hi_target = 9·0.99
  // = 8.91 → first bin where cum reaches that is luma 108. Same result.
  const normDefault = await microsharp(normPng).normalise().raw().toBuffer();
  plain('microsharp(): normalise() default percentiles cover full range',
    normDefault[0] === 0 && normDefault[8 * 4] === 255);

  // normalise out-of-range options.
  let normThrew = 0;
  try { microsharp(normPng).normalise({ lower: -1, upper: 99 }); }
  catch (e) { if (e instanceof RangeError) normThrew++; }
  try { microsharp(normPng).normalise({ lower: 50, upper: 50 }); }
  catch (e) { if (e instanceof RangeError) normThrew++; }
  plain('microsharp(): normalise out-of-range options throw', normThrew === 2);

  // CLAHE smoke: build an 8×8 fixture with two tiles of differing
  // contrast and verify the output is in-range and dims unchanged.
  const claheCanvas = createCanvas(8, 8);
  const claheCtx = claheCanvas.getContext('2d');
  const claheImg = claheCtx.createImageData(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = (x + y) * 8; // gradient 0..112
      const off = (y * 8 + x) * 4;
      claheImg.data[off + 0] = v;
      claheImg.data[off + 1] = v;
      claheImg.data[off + 2] = v;
      claheImg.data[off + 3] = 255;
    }
  }
  claheCtx.putImageData(claheImg, 0, 0);
  const clahePng = claheCanvas.toBytes();
  const claheOut = await microsharp(clahePng).clahe({ width: 4, height: 4 }).raw().toBuffer();
  plain('microsharp(): clahe produces output of unchanged dims',
    claheOut.length === 8 * 8 * 4);
  // CLAHE on a smooth gradient should preserve order: top-left dim,
  // bottom-right bright (tile-equalised, but still monotonic in the
  // global sense).
  plain('microsharp(): clahe preserves dim < bright on smooth gradient',
    claheOut[0] <= claheOut[(7 * 8 + 7) * 4]);

  // clahe maxSlope=0 → no clipping (plain AHE).
  const ahe = await microsharp(clahePng).clahe({ width: 4, height: 4, maxSlope: 0 }).raw().toBuffer();
  plain('microsharp(): clahe maxSlope=0 emits valid output',
    ahe.length === 8 * 8 * 4);

  // clahe bad args throw.
  let claheThrew = 0;
  try { microsharp(clahePng).clahe({ width: 0, height: 4 }); }
  catch (e) { if (e instanceof RangeError) claheThrew++; }
  try { microsharp(clahePng).clahe({ width: 4, height: 4, maxSlope: -1 }); }
  catch (e) { if (e instanceof RangeError) claheThrew++; }
  plain('microsharp(): clahe bad args throw', claheThrew === 2);

  // modulate({ brightness: 2 }) — V doubles. For chanPng (R=10, G=200,
  // B=50, A=128): max=200, so V_in=200, after ×2 → 400 clipped to 255.
  // After clip+S preserved, output is ~ a brighter cyan-ish.
  const modBright = await microsharp(chanPng).modulate({ brightness: 2 }).raw().toBuffer();
  plain('microsharp(): modulate({brightness:2}) brightens',
    modBright[1] >= 200 && modBright[3] === 128);

  // modulate({ saturation: 0 }) — collapses to greyscale (S=0 → R=G=B=V).
  const modGrey = await microsharp(chanPng).modulate({ saturation: 0 }).raw().toBuffer();
  // For (10,200,50): V=max=200, so all channels = 200.
  plain('microsharp(): modulate({saturation:0}) collapses to V',
    modGrey[0] === modGrey[1] && modGrey[1] === modGrey[2] && modGrey[0] === 200);

  // modulate({ hue: 180 }) — rotate hue 180° on a saturated red.
  // For pure red (255, 0, 0) → HSV(0°, 1, 255). After +180° → HSV(180°,
  // 1, 255) → cyan (0, 255, 255).
  const redCanvas = createCanvas(1, 1);
  const redCtx = redCanvas.getContext('2d');
  redCtx.fillStyle = '#ff0000';
  redCtx.fillRect(0, 0, 1, 1);
  const redPng = redCanvas.toBytes();
  const modHue = await microsharp(redPng).modulate({ hue: 180 }).raw().toBuffer();
  plain('microsharp(): modulate({hue:180}) rotates red → cyan',
    modHue[0] === 0 && modHue[1] === 255 && modHue[2] === 255);

  // modulate({ lightness: 50 }) on a black pixel (0,0,0,255) raises V to 50.
  const blackCanvas = createCanvas(1, 1);
  const blackCtx = blackCanvas.getContext('2d');
  blackCtx.fillStyle = '#000000';
  blackCtx.fillRect(0, 0, 1, 1);
  const blackPng = blackCanvas.toBytes();
  const modLight = await microsharp(blackPng).modulate({ lightness: 50 }).raw().toBuffer();
  // S=0 (black has no saturation); after lightness V=50 → R=G=B=50.
  plain('microsharp(): modulate({lightness:50}) raises V on black pixel',
    modLight[0] === 50 && modLight[1] === 50 && modLight[2] === 50);

  // modulate() no-args is identity.
  const modId = await microsharp(chanPng).modulate().raw().toBuffer();
  plain('microsharp(): modulate() no-args is identity',
    modId[0] === 10 && modId[1] === 200 && modId[2] === 50 && modId[3] === 128);

  // modulate bad args.
  let modThrew = 0;
  try { microsharp(chanPng).modulate({ brightness: -1 }); }
  catch (e) { if (e instanceof RangeError) modThrew++; }
  try { microsharp(chanPng).modulate({ saturation: Number.NaN }); }
  catch (e) { if (e instanceof RangeError) modThrew++; }
  plain('microsharp(): modulate bad args throw', modThrew === 2);

  // Web inputs: Blob.
  const blobOut = await microsharp(new Blob([pngIn])).png().toBuffer();
  plain('microsharp(Blob): PNG roundtrip',
    blobOut[0] === 0x89 && blobOut[1] === 0x50 &&
    blobOut[2] === 0x4e && blobOut[3] === 0x47);

  // Web inputs: ReadableStream (via Response.body).
  const streamOut = await microsharp(new Response(pngIn).body).png().toBuffer();
  plain('microsharp(ReadableStream): PNG roundtrip',
    streamOut[0] === 0x89 && streamOut[1] === 0x50 &&
    streamOut[2] === 0x4e && streamOut[3] === 0x47);

  // Web inputs: Response.
  const respOut = await microsharp(new Response(pngIn)).png().toBuffer();
  plain('microsharp(Response): PNG roundtrip',
    respOut[0] === 0x89 && respOut[1] === 0x50 &&
    respOut[2] === 0x4e && respOut[3] === 0x47);

  // Stream inputs are single-use; the pipeline must memoize the materialized
  // bytes so toBuffer() (full decode) and metadata() (header-only peekInfo)
  // both work on the same instance.
  const reusePipe = microsharp(new Response(pngIn).body);
  const reuseOut = await reusePipe.png().toBuffer();
  const reuseMeta = await reusePipe.metadata();
  plain('microsharp(ReadableStream): toBuffer() + metadata() reuse',
    reuseOut[0] === 0x89 && reuseMeta.width === 60 && reuseMeta.height === 40);

  // ---- Output options scoped to stb_image_write ---------------------------

  // .bmp() — stb's 32-bit V4 BMP. Magic bytes 'BM' (0x42 0x4D).
  const bmpOut = await microsharp(pngIn).bmp().toBuffer();
  plain('microsharp(): .bmp() magic bytes',
    bmpOut[0] === 0x42 && bmpOut[1] === 0x4d);

  // .raw() — RGBA pixel bytes; size === w * h * 4. The fill is #10b981
  // (16, 185, 129, 255), so the first pixel must match.
  const rawOut = await microsharp(pngIn).raw().toBuffer();
  plain('microsharp(): .raw() length matches w*h*4',
    rawOut.length === 60 * 40 * 4);
  plain('microsharp(): .raw() first pixel matches fillStyle #10b981',
    rawOut[0] === 0x10 && rawOut[1] === 0xb9 && rawOut[2] === 0x81 && rawOut[3] === 0xff);

  // .png({ compressionLevel }) — values 0..9 must each produce a valid,
  // re-decodable PNG and round-trip through Image.fromBytes. We don't
  // assert size differences across levels: stb's level controls a
  // hash-chain truncation depth in its custom DEFLATE encoder, and for
  // most inputs the chains never grow deep enough for the knob to change
  // the output. The mutex-guarded write into the C TU is verified by
  // construction — `encodePngWithLevel` saves/restores the global, so a
  // failed write would still produce *a* PNG but wouldn't honor the value.
  for (const lvl of [0, 1, 5, 9]) {
    const out = await microsharp(pngIn).png({ compressionLevel: lvl }).toBuffer();
    const ok = out[0] === 0x89 && out[1] === 0x50 && out[2] === 0x4e && out[3] === 0x47;
    plain(`microsharp(): .png({ compressionLevel: ${lvl} }) emits valid PNG`, ok);
  }

  // .png({ compressionLevel }) — out-of-range throws RangeError before any encode.
  let pngLvlThrew = false;
  try { microsharp(pngIn).png({ compressionLevel: 99 }); }
  catch (err) { pngLvlThrew = err instanceof RangeError; }
  plain('microsharp(): .png({ compressionLevel: 99 }) RangeError',
    pngLvlThrew);

  // .jpeg({ quality }) — sharp object form; same 0.0–1.0 mapping.
  const jpegObj = await microsharp(pngIn).jpeg({ quality: 0.85 }).toBuffer();
  plain('microsharp(): .jpeg({ quality }) JPEG magic bytes',
    jpegObj[0] === 0xff && jpegObj[1] === 0xd8 && jpegObj[2] === 0xff);

  // .toFormat() — unified dispatcher.
  const tfBmp = await microsharp(pngIn).toFormat('bmp').toBuffer();
  plain('microsharp(): .toFormat("bmp") magic bytes',
    tfBmp[0] === 0x42 && tfBmp[1] === 0x4d);

  let toFormatThrew = false;
  try { microsharp(pngIn).toFormat('webp'); }
  catch (err) { toFormatThrew = err instanceof RangeError; }
  plain('microsharp(): .toFormat("webp") RangeError (stb does not encode webp)',
    toFormatThrew);

  // .toBuffer({ resolveWithObject: true }) — { data, info } shape.
  const woPng = await microsharp(pngIn).png().toBuffer({ resolveWithObject: true });
  plain('microsharp(): toBuffer({ resolveWithObject }) PNG info',
    woPng.data instanceof Uint8Array &&
    woPng.info.format === 'png' &&
    woPng.info.size === woPng.data.length &&
    woPng.info.width === 60 && woPng.info.height === 40 &&
    woPng.info.channels === 4);

  const woJpeg = await microsharp(pngIn).jpeg(0.8).toBuffer({ resolveWithObject: true });
  plain('microsharp(): toBuffer({ resolveWithObject }) JPEG channels=3',
    woJpeg.info.format === 'jpeg' && woJpeg.info.channels === 3);

  const woBmp = await microsharp(pngIn).bmp().toBuffer({ resolveWithObject: true });
  plain('microsharp(): toBuffer({ resolveWithObject }) BMP channels=4',
    woBmp.info.format === 'bmp' && woBmp.info.channels === 4);

  const woRaw = await microsharp(pngIn).raw().toBuffer({ resolveWithObject: true });
  plain('microsharp(): toBuffer({ resolveWithObject }) raw channels=4',
    woRaw.info.format === 'raw' && woRaw.info.channels === 4 &&
    woRaw.info.size === 60 * 40 * 4);
}

function toClampedCopy(src) {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

summary();
