# DOMMatrix

MDN: https://developer.mozilla.org/en-US/docs/Web/API/DOMMatrix

A mutable 4×4 matrix used throughout the Canvas API for transforms. This implementation stores only the 2D 6-element form `a, b, c, d, e, f` (all `f64`); 3D fields are synthesized as identity values when read. 3D-only methods are out of scope.

Maps to `zig/canvas/DOMMatrix.zig`. Constructed via free functions in `zig/canvas.zig` following the `createCanvas` precedent.

Priority legend: 🔴 high · 🟡 low · ⛔ unplanned.

## Constructors (via zig/canvas.zig free functions)

- [x] 🔴 `new DOMMatrix()` → `createDOMMatrix()` — returns identity matrix — zig/canvas/DOMMatrix.zig
- [x] 🔴 `new DOMMatrix(init)` 6-number array form → `createDOMMatrix2D(a, b, c, d, e, f)` — zig/canvas/DOMMatrix.zig
- [x] 🟡 `new DOMMatrix(init)` 16-number array form — validates 3D positions are at identity — src/index.ts
- [ ] 🟡 `new DOMMatrix(init)` string form (CSS transform list) — deferred (out of scope without CSS parser)

## Instance properties — 2D aliases

- [x] 🔴 `a, b, c, d, e, f: f64` — mutable fields; alias m11/m12/m21/m22/m41/m42 per spec — zig/canvas/DOMMatrix.zig

## Instance properties — 4×4 elements

- [x] 🟡 `m11, m12, m21, m22, m41, m42` — paired getters/setters aliasing a–f — src/index.ts
- [x] 🟡 `m13, m14, m23, m24, m31, m32, m33, m34, m43, m44` — read-only identity-valued (off-diagonal=0, m33/m44=1) — src/index.ts
- [x] 🟡 `is2D` — always true — src/index.ts
- [x] 🟡 `isIdentity` — computed from a..f — src/index.ts

## Instance methods

- [x] 🔴 `multiplySelf(other)` — post-multiply A := A·B; returns self — zig/canvas/DOMMatrix.zig
- [x] 🔴 `translateSelf(tx, ty)` — 2D translation post-multiply; returns self (tz dropped, node-zigar is positional) — zig/canvas/DOMMatrix.zig
- [x] 🔴 `scaleSelf(sx, sy)` — 2D scale post-multiply; returns self (origin args + sz dropped; add `scaleSelfWithOrigin` variant if needed) — zig/canvas/DOMMatrix.zig
- [x] 🔴 `rotateSelf(angleDegrees)` — single-arg form (MDN: single arg means rotZ in degrees); converts degrees→radians; returns self — zig/canvas/DOMMatrix.zig
- [x] 🔴 `invertSelf()` — closed-form 2D affine inverse; NaNs all components when det ≈ 0; returns self — zig/canvas/DOMMatrix.zig
- [x] 🟡 `preMultiplySelf(other)` — pre-multiply A := B·A; returns self — zig/simdra/core/SmMatrix.zig
- [ ] 🟡 `setMatrixValue(transformList)` — deferred (CSS transform-list parser out of scope)
- [x] 🟡 `skewXSelf(angleDegrees)` — degrees in (matches `rotateSelf`); returns self — zig/simdra/core/SmMatrix.zig
- [x] 🟡 `skewYSelf(angleDegrees)` — degrees in; returns self — zig/simdra/core/SmMatrix.zig
- [x] 🟡 `rotateAxisAngleSelf(x, y, z, angle)` — 2D-restricted: only `(0, 0, +z)` axis is supported (≡ rotateSelf); throws otherwise — src/index.ts
- [x] 🟡 `rotateFromVectorSelf(x, y)` — `atan2(y, x)`; both-zero → no-op — src/index.ts
- [x] 🟡 `scale3dSelf(scale, originX?, originY?, originZ?)` — 2D-restricted: throws if `originZ !== 0`; uniform scale about (originX, originY) — src/index.ts

## Static methods

- [x] 🟡 `fromFloat32Array(array32)` — 6- or 16-element forms — src/index.ts
- [x] 🟡 `fromFloat64Array(array64)` — 6- or 16-element forms — src/index.ts
- [x] 🟡 `fromMatrix(other)` — accepts `DOMMatrix | DOMMatrix2DInit` (a–f or m-named keys) — src/index.ts

## Out of scope

- ⛔ Anything 3D-only with no canvas relevance.
