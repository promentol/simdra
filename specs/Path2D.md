# Path2D

MDN: https://developer.mozilla.org/en-US/docs/Web/API/Path2D

A reusable, transferable path object. Once implemented, it shares the path-building methods with `CanvasRenderingContext2D` — the natural Zig refactor is to move the path-building methods into a shared module that both Path2D and Context call into.

Lives in `zig/canvas/Path2D.zig`; shared path machinery in `zig/canvas/Path.zig`.

Priority is set by pdf.js. Modern pdf.js builds prebuilt `Path2D` objects for repeated glyph and shape outlines, so the constructor + path-building set is on the critical path. Legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Constructors

- [x] 🔴 `new Path2D()` — empty path. pdf.js prebuilt-path cache. — `zig/canvas.zig` as `createPath2D()`.
- [x] 🔴 `new Path2D(path)` — copy from another Path2D. — `zig/canvas.zig` as `createPath2DFromPath(other)`.
- [ ] 🟡 `new Path2D(d)` — parse SVG path data string. pdf.js usually builds via methods, so this is a follow-up.

## Instance methods

- [x] 🔴 `addPath(path, transform?)` — pdf.js composes glyph paths. Ships as two forms: `addPath(path)` + paired `addPathTransform(path, matrix)` (project convention for optional transform arg). — `zig/canvas/Path2D.zig`.
- [x] 🔴 `closePath()`. — `zig/canvas/Path2D.zig` (delegates to `Path.zig`).
- [x] 🔴 `moveTo(x, y)`. — `zig/canvas/Path2D.zig` (delegates to `Path.zig`).
- [x] 🔴 `lineTo(x, y)`. — `zig/canvas/Path2D.zig` (delegates to `Path.zig`).
- [x] 🔴 `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)`. — `zig/canvas/Path2D.zig` (delegates to `Path.zig`).
- [x] 🔴 `quadraticCurveTo(cpx, cpy, x, y)`. — `zig/canvas/Path2D.zig` (delegates to `Path.zig`).
- [ ] 🟡 `arc(x, y, radius, startAngle, endAngle, counterclockwise?)`.
- [ ] 🟡 `arcTo(x1, y1, x2, y2, radius)`.
- [ ] 🟡 `ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise?)`.
- [x] 🔴 `rect(x, y, w, h)`. — `zig/canvas/Path2D.zig` (delegates to `Path.zig`).
- [ ] 🟡 `roundRect(x, y, w, h, radii)` — modern, pdf.js doesn't rely on it.

## Notes

- Internal representation: a flat opcode byte buffer (`zig/canvas/Path.zig`). Each entry is a 1-byte tag + fixed f64 payload. Curves are preserved as-is so paths remain transformable; the rasterizer will flatten them at fill/stroke time.
- SVG path data parser is its own task — useful sub-spec to track separately if it grows.
