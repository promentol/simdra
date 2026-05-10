// Sanity check that the Vite-built bundle runs end-to-end without the
// node-zigar loader hook. Imports the dist artifact directly.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas, parseCssColor, registerFont, Image, microsharp } from '../dist/core/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const W = 300;
const H = 320;

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, W, H);
ctx.lineWidth = 10;
ctx.strokeStyle = '#03a9f4';
ctx.fillStyle = '#03a9f4';
ctx.strokeRect(75, 140, 150, 110);
ctx.fillRect(130, 190, 40, 60);
ctx.beginPath();
ctx.moveTo(50, 140);
ctx.lineTo(150, 60);
ctx.lineTo(250, 140);
ctx.closePath();
ctx.fill();

const url = canvas.toDataURL();
const comma = url.indexOf(',');
const pngBytes = Buffer.from(url.slice(comma + 1), 'base64');
const outPath = join(__dirname, 'house-built.png');
writeFileSync(outPath, pngBytes);
console.log(`built bundle ok: wrote ${outPath} (${pngBytes.length} bytes)`);

// Smoke-test the CSS color parser via the WASM bundle.
// packRGBA(255,0,0,255) = 0xFF0000FF; verify unsigned.
const red = parseCssColor('#ff0000');
const redOk = red !== null && (red >>> 0) === 0xFF0000FF;
console.log(`parseCssColor WASM smoke test: ${redOk ? 'PASS' : `FAIL (got ${red})`}`);
const transparentOk = (parseCssColor('transparent') >>> 0) === 0x00000000;
console.log(`parseCssColor transparent WASM: ${transparentOk ? 'PASS' : 'FAIL'}`);
const namedOk = (parseCssColor('rebeccapurple') >>> 0) === 0xFF993366;
console.log(`parseCssColor rebeccapurple WASM: ${namedOk ? 'PASS' : 'FAIL'}`);
const hslOk = (parseCssColor('hsl(0, 100%, 50%)') >>> 0) === 0xFF0000FF;
console.log(`parseCssColor hsl WASM: ${hslOk ? 'PASS' : 'FAIL'}`);
// Text smoke — exercises stb_truetype + AA coverage path through the WASM
// bundle. Catches bundling regressions in defaultFontBytes / SmFont /
// blendSrcOverCovU32.
const tc = createCanvas(240, 64);
const tx = tc.getContext('2d');
tx.fillStyle = '#ffffff';
tx.fillRect(0, 0, 240, 64);
tx.fillStyle = '#000000';
tx.font = '24px sans-serif';
const measured = tx.measureText('Hello').width;
tx.fillText('Hello', 8, 40);
const data = tx.getImageData(0, 0, 240, 64).data;
let inkPixels = 0;
for (let i = 0; i < data.length; i += 4) if (data[i] < 240) inkPixels += 1;
const textOk = measured > 30 && inkPixels > 50;
console.log(`text WASM smoke: width=${measured.toFixed(2)} ink=${inkPixels} ${textOk ? 'PASS' : 'FAIL'}`);
console.log(`registerFont exported: ${typeof registerFont === 'function' ? 'PASS' : 'FAIL'}`);

// createCanvas fonts: option survives the built bundle.
const fontPath = join(__dirname, '..', 'zig', 'simdra', 'assets', 'Manrope-Regular.ttf');
const fontBytes = readFileSync(fontPath);
const fc = createCanvas(120, 40, { fonts: [{ name: 'BuiltCustomFont', data: fontBytes }] });
const fctx = fc.getContext('2d');
fctx.font = '20px BuiltCustomFont';
const fontsOptOk = fctx.measureText('hi').width > 0;
console.log(`createCanvas fonts option WASM: ${fontsOptOk ? 'PASS' : 'FAIL'}`);

// stb_image: encode JPEG via the WASM bundle, decode it back through Image.fromBytes.
const jpegUrl = canvas.toDataURL('image/jpeg', 0.85);
const jpegOk = jpegUrl.startsWith('data:image/jpeg;base64,');
console.log(`toDataURL('image/jpeg') WASM: ${jpegOk ? 'PASS' : 'FAIL'}`);

const jpegBytes = canvas.toBytes('image/jpeg', 0.85);
const jpegMagicOk = jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8 && jpegBytes[2] === 0xff;
console.log(`Canvas.toBytes('image/jpeg') WASM: ${jpegMagicOk ? 'PASS' : 'FAIL'}`);

const decoded = Image.fromBytes(jpegBytes);
const decodeOk = decoded.width === W && decoded.height === H;
console.log(`Image.fromBytes WASM: ${decodeOk ? 'PASS' : `FAIL (got ${decoded.width}x${decoded.height})`}`);

// Sharp-shaped binding through the WASM bundle.
const pipeOut = await microsharp(pngBytes).jpeg(0.8).toBuffer();
const pipeOk =
  pipeOut instanceof Uint8Array &&
  pipeOut[0] === 0xff && pipeOut[1] === 0xd8 && pipeOut[2] === 0xff;
console.log(`microsharp WASM: ${pipeOk ? 'PASS' : 'FAIL'}`);

// resize through the WASM bundle — confirms effects/SmResampler.zig
// links and runs.
const resizedRaw = await microsharp(pngBytes).resize(64, 64, { kernel: 'lanczos3' })
  .raw().toBuffer();
const resizedOk = resizedRaw.length === 64 * 64 * 4;
console.log(`microsharp resize lanczos3 WASM: ${resizedOk ? 'PASS' : 'FAIL'}`);

// trim through the WASM bundle — confirms effects/SmTrim.zig links.
const trimSrc = createCanvas(40, 40);
const tsx = trimSrc.getContext('2d');
tsx.fillStyle = '#ff0000';
tsx.fillRect(8, 8, 24, 24);
const trimmedWasm = await microsharp(trimSrc.toBytes()).trim().raw().toBuffer();
const trimmedOk = trimmedWasm.length === 24 * 24 * 4;
console.log(`microsharp trim WASM: ${trimmedOk ? 'PASS' : 'FAIL'}`);

// composite through the WASM bundle — confirms effects/SmComposite.zig links.
const cBase = createCanvas(60, 40);
cBase.getContext('2d').fillStyle = '#3b82f6';
cBase.getContext('2d').fillRect(0, 0, 60, 40);
const cOver = createCanvas(20, 20);
cOver.getContext('2d').fillStyle = '#ffff00';
cOver.getContext('2d').fillRect(0, 0, 20, 20);
const composedWasm = await microsharp(cBase.toBytes()).composite([
  { input: cOver.toBytes(), blend: 'multiply', top: 5, left: 5 },
]).raw().toBuffer();
// multiply on (0x3b, 0x82, 0xf6) × (0xff, 0xff, 0x00) = (0x3b, 0x82, 0x00)
const composedOk =
  composedWasm.length === 60 * 40 * 4 &&
  composedWasm[(5 * 60 + 5) * 4 + 2] === 0x00;
console.log(`microsharp composite WASM: ${composedOk ? 'PASS' : 'FAIL'}`);

if (
  !redOk || !transparentOk || !namedOk || !hslOk || !textOk || !fontsOptOk ||
  !jpegOk || !jpegMagicOk || !decodeOk || !pipeOk || !resizedOk || !trimmedOk ||
  !composedOk
) {
  process.exitCode = 1;
}
