# TextMetrics

MDN: https://developer.mozilla.org/en-US/docs/Web/API/TextMetrics

Returned by `CanvasRenderingContext2D.measureText(text)`. Pure data; no methods.

Blocked on the text-rendering pipeline (font loading + glyph rasterization).

Priority is set by pdf.js. pdf.js calls `measureText` heavily for layout but reads only `.width` from the result; the bounding-box fields come into play for selection and accessibility, which are lower priority. Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Instance properties

- [x] 🔴 `width: f64` — advance width of the rendered text. The one field pdf.js needs to render. — `src/index.ts` `TextMetrics` class, populated via `SmFont.measureWidth` (sum of scaled advance widths, no kerning yet).
- [ ] 🟡 `actualBoundingBoxLeft: f64`.
- [ ] 🟡 `actualBoundingBoxRight: f64`.
- [ ] 🟡 `actualBoundingBoxAscent: f64`.
- [ ] 🟡 `actualBoundingBoxDescent: f64`.
- [ ] 🟡 `fontBoundingBoxAscent: f64`.
- [ ] 🟡 `fontBoundingBoxDescent: f64`.
- [ ] 🟡 `emHeightAscent: f64`.
- [ ] 🟡 `emHeightDescent: f64`.
- [ ] 🟡 `hangingBaseline: f64`.
- [ ] 🟡 `alphabeticBaseline: f64`.
- [ ] 🟡 `ideographicBaseline: f64`.
