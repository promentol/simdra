# Internal design hardening

Spec for **non-feature** internal-design improvements to the pure-Zig layer (`zig/simdra/`). These don't add HTML5 surface — they pay down design debt that surfaced in a full read of the Zig codebase. Two buckets:

- **A — JS-binding compromises that bled into Zig.** node-zigar constraints (allocator GC, type-scanner branch quota, sentinel validator) shaped several Zig-side choices. Reversing them tightens the library when judged purely as a pure-Zig drawing library.
- **B — Internal correctness/architecture debts.** v0 shortcuts that get more expensive the longer the code grows on top of them. Best fixed before more features pile on.

Status emoji per item: 🔴 unchecked · 🟢 done · ⏭️ deferred (with reason).

Effort columns are focused-work hours. "Touches" lists the files most affected.

---

## A — JS-binding compromises (tighten the pure-Zig layer)

### A1 — 🟢 Single generic growable list (`utils/SmList.zig`)

**Status quo.** Six hand-rolled `{ ptr, len, cap, deinit, append, ensureCapacity }` triples, each a near-copy:

- `PathBuf` in `zig/simdra/core/SmPath.zig`
- `EdgeBuf`, `IntersectionBuf`, `PointBuf` in `zig/simdra/core/SmScan.zig`
- `StateStack` in `zig/simdra/core/SmCanvas.zig`
- `StopList` in `zig/simdra/effects/SmGradient.zig`

Comments at each site say "std.ArrayListUnmanaged blew zigar's comptime-branch quota."

**Goal.** One `utils/SmList.zig` exposing `SmList(comptime T)` with `append`, `ensureCapacity`, `deinit`, `slice()`. Replace all six bespoke copies with `SmList(Edge)`, `SmList(Vec2)`, etc.

**Constraint.** Keep zigar happy: keep the body straight-line (no inline-for over capacity classes); pre-instantiate only the `T`s actually used; if a specific `T` ever blows the quota, fall back to the bespoke copy locally without un-deduping the others.

**Files touched.** New `zig/simdra/utils/SmList.zig`; rewrites in `SmPath.zig`, `SmScan.zig`, `SmCanvas.zig`, `SmGradient.zig`.

**Effort.** 2–3 h.

**Acceptance.** All `npm test` visual scenes still pass. Total LOC drops by ~250.

**Implemented at:** new `zig/simdra/utils/SmList.zig` (78 LOC; layout `[*]T + len: usize + cap: usize` to keep zigar's type scanner happy). Rewrites:
- `SmPath.zig` — `PathBuf` removed; `buf: SmList(u8)`. `appendOpcode`/`appendSegment` moved as private methods on `SmPath` itself (path-specific encoding stays with the path type).
- `SmScan.zig` — `EdgeBuf`/`IntersectionBuf`/`PointBuf` collapsed to one-line type aliases over `SmList(Edge|Intersection|Vec2)`. `IntersectionBuf.ensureCapacity(xs.len + 1)` simplified to `xs.append(...)` at the only call site.
- `SmCanvas.zig` — `StateStack` is now `SmList(StateFrame)`. `push` becomes `append` with silent OOM swallow at the `save()` call site (preserves prior void-return behavior). `pop()` inlined into `restore()`.
- `SmGradient.zig` — `StopList = SmList(Stop)`; the `insertSorted` method became a free function `insertStopSorted(stops, stop)` since insertion-sort is gradient-specific, not list-generic.

LOC change: SmPath 411→369, SmScan ~−120, SmCanvas 1001→966, SmGradient 130→117. Net: ~−170 (close to spec's ~250 estimate; the gap is because SmPath's `appendOpcode`/`appendSegment` migrated rather than disappeared). Verified: `npm test` 120/120, `npm run typecheck`, `npm run build` (1.09 MB WASM bundle), `npm run test:built` all pass.

---

### A2 — 🟢 Thread an allocator instead of `std.heap.page_allocator`

**Status quo.** Every `Sm*.zig` declares `const allocator = std.heap.page_allocator;` at module scope. Hardcoded:

- `SmSurface.zig:14`, `SmCanvas.zig:32`, `SmPath.zig`, `SmScan.zig:17`, `SmGradient.zig:18`, `SmFont.zig`, `SmBitmap.zig`, plus the embedded `EdgeBuf`/`PointBuf`/etc.

**Why it matters.** Zig's design ethos is "allocators are explicit." Hardcoded `page_allocator` blocks: tracking allocators in long-lived processes, leak-checking GPA in tests, fixed-buffer allocators in embedded contexts, small pool allocators in WASM. Today CLAUDE.md acknowledges this is for node-zigar GC interop — but the pure-Zig library should not pay that cost.

**Goal.** `SmSurface.init(allocator, w, h)` takes an allocator; `SmSurface` stores it; everything reachable from a Surface uses that allocator. JS-binding shim in `simdra.zig` adds a thin `SmSurface.initDefault(w, h)` that passes `page_allocator` so node-zigar's call sites don't change.

**Files touched.** All `core/Sm*.zig`, `effects/SmGradient.zig`, `encode/png.zig` (already takes an allocator — no change). New `simdra.zig` re-export pair: explicit-alloc + page-allocator default.

**Effort.** 4–6 h.

**Acceptance.** Test suite green. Add one test that runs the full draw stack under `std.testing.allocator` (leak checker) — must pass.

**Implemented at:** allocator now flows through every Sm* type via the `std.ArrayListUnmanaged` pattern.

- `zig/simdra/utils/SmList.zig` — methods take `allocator: std.mem.Allocator` explicitly (`append`, `appendSlice`, `ensureUnusedCapacity`, `deinit`). Layout stays 3 fields (`ptr`, `len`, `cap`) — keeps zigar-safe.
- `zig/simdra/core/SmSurface.zig` — canonical allocator owner. `init(allocator, w, h)` takes an explicit allocator; **`initDefault(w, h)`** is the JS-binding shim that wraps with `std.heap.page_allocator`. Module-scope `const allocator` removed; every internal alloc uses `self.allocator`.
- `zig/simdra/core/SmCanvas.zig` — reads its allocator via `self.surface.allocator`. New `initFromSurface(surface)` factory called by `SmSurface.getCanvas`. The embedded `SmPath` inherits the surface's allocator at canvas-construction time. Module-scope `const allocator` removed; calls to `state_stack.append` / `releaseImageData` / `scratch_pixels` / `SmScan.{fillPath,strokePath}` all pass `self.surface.allocator` explicitly.
- `zig/simdra/core/SmPath.zig` — added `allocator: std.mem.Allocator = std.heap.page_allocator` field with default. New `emptyWithAllocator(allocator)` for explicit threading; JS-binding `empty()` keeps the page_alloc default.
- `zig/simdra/core/SmFont.zig` — same pattern. `fromBytes(bytes, size)` defaults to page_alloc; `fromBytesWithAllocator(allocator, bytes, size)` for tests.
- `zig/simdra/core/SmBitmap.zig` — bitmaps store their own allocator so `release(bitmap)` works regardless of provenance. `createBlank` / `createFromBuffer` JS factories default to page_alloc; `*WithAllocator` and `fromSurfacePixels(allocator, ...)` for explicit.
- `zig/simdra/effects/SmGradient.zig` — added allocator field with `linearWithAllocator` / `radialWithAllocator` factories. `addColorStop` uses `self.allocator`.
- `zig/simdra/core/SmScan.zig` — `fillPath` / `strokePath` / `addEdge` / `flattenQuad` / `flattenCubic` / `sweepEdges` / `strokePolyline` / `flattenQuadPoints` / `flattenCubicPoints` all take `allocator: std.mem.Allocator`. `FillVisitor` and `StrokeVisitor` carry an `allocator` field. Module-scope `const allocator` removed.
- `zig/simdra/core/SmTextRun.zig` — `shape(allocator, text, font)` takes allocator; `SmCanvas.drawText` passes `self.surface.allocator`.
- `src/index.ts` — `Canvas` constructor switched from `SmSurface.init(w, h)` to `SmSurface.initDefault(w, h)`. `src/simdra-zig.d.ts` updated to reflect the JS-callable shape.
- New `zig/leak_test.zig` (8 tests) exercises the full draw stack under `std.testing.allocator`: surface init/draw/deinit, save/restore (state stack frees), composite layer (scratch buffer frees), getImageData (bitmap frees), encodePng (last_png frees), standalone SmPath/SmGradient/SmBitmap. New `npm run test:leak` script (`zig test leak_test.zig -lc -I .`).

Verified: `npm test` 125/125, `npm run typecheck` clean, `npm run build` (1.26 MB WASM bundle), `npm run test:built` clean, `npm run test:leak` 8/8 (no leaks under `std.testing.allocator`).

---

### A3 — 🟢 Tagged union for `SmGradient` geometry

**Status quo.** `effects/SmGradient.zig:75-82` — `kind: Kind` discriminator + flat `x0/y0/r0/x1/y1/r1` fields where radial fields are dead when `kind = .linear`. Comment: "flat fields rather than a tagged union so zigar's type scanner has no nested namespaces to walk."

**Goal.**

```zig
pub const SmGradient = union(Kind) {
    linear: struct { x0: f64, y0: f64, x1: f64, y1: f64, stops: SmList(Stop) },
    radial: struct { x0: f64, y0: f64, r0: f64, x1: f64, y1: f64, r1: f64, stops: SmList(Stop) },
};
```

Switch on the union in `addColorStop` / `sampleLinear` / `sampleRadial`.

**Constraint.** If zigar still chokes on the union, re-flatten only at the JS boundary (a thin shim type) and keep the union internal.

**Files touched.** `effects/SmGradient.zig` only. Possibly `simdra.zig` re-export shim.

**Effort.** 1 h.

**Implemented at:** `zig/simdra/effects/SmGradient.zig`. Final shape: `geometry: Geometry` field (union(Kind) of `Linear { x0, y0, x1, y1 }` and `Radial { x0, y0, r0, x1, y1, r1 }`) plus a flat `stops: SmList(Stop)` shared across kinds. zigar accepted the union directly — **no JS-boundary shim needed**, the fallback strategy stays unused. The `Kind` enum is preserved as the union tag (kept public for any future external dispatch). `linear()` / `radial()` factory shapes unchanged so JS callers see no diff. Verified: `npm test` 120/120, `npm run build` (77 modules, 1.10 MB), `npm run test:built` all pass.

---

### A4 — 🟢 Sentinel-terminated string returns where natural

**Status quo.** All string returns use `[]const u8` with comment "zigar's sentinel validator is incompatible with `allocSentinel`." Currently affects `parseCssColor` ergonomics (callers that want to interop with C have to copy).

**Goal.** Audit every `[]const u8` return that crosses *into* C (stb_truetype already takes raw bytes — fine). Where a sentinel would be natural for C interop or std lib usage, use `[:0]const u8`. JS-facing returns stay `[]const u8`.

**Files touched.** `utils/css_color.zig`, possibly `SmFont.zig` family-name returns if any get added.

**Effort.** 30 min.

**Resolution (audit, no code change).** The audit of slice-returning functions found three results: `defaultFontBytes()` in `simdra.zig` (feeds stb_truetype as raw `(ptr, len)`; null terminator unused), `trim()` in `utils/css_color.zig` (private helper returning a sub-slice of input — callers re-trim, no C boundary), and `hslToRgb()` in `utils/css_color.zig` (returns a fixed `[3]u8`, not a slice). No public string returns currently cross into C in a shape that would benefit from `[:0]const u8`. The `[]const u8` rule remains correct as-is for this codebase.

---

### A5 — 🟢 Demote `parseCssColor` from entry point to `utils` re-export

**Status quo.** `simdra.zig:44-46` defines `parseCssColor` as a top-level free function with comment "stays here as a free function." The implementation already lives in `utils/css_color.zig`.

**Goal.** Replace the top-level `pub fn parseCssColor` with `pub const parseCssColor = @import("simdra/utils/css_color.zig").parse;`. Remove the apologetic comment. The entry point should only re-export type-shaped things.

**Files touched.** `simdra.zig`.

**Effort.** 5 min.

**Implemented at:** `zig/simdra.zig` (5-line re-export replacing 12-line wrapper). Verified via `npm test` (120/120) + `npm run build && npm run test:built` (WASM bundle parseCssColor smoke tests pass).

---

## B — Internal correctness / architecture debts

### B1 — 🟢 Active Edge Table for path scan (`SmScan.sweepEdges`)

**Status quo.** `core/SmScan.zig:472-516` re-tests every edge against every scanline:

```zig
for (edges.ptr[0..edges.len]) |e| {
    if (y_f >= e.y_min and y_f < e.y_max) { ... }
}
```

For a path with N edges and H scanlines, that's O(N·H). Skia, Cairo, FreeType, libart all maintain a sorted-by-y-min edge list plus an Active Edge Table that's incrementally advanced per scanline.

**Why it matters now.** AA path rasterization is the next 4 h of feature work (top of `INDEX.md` post-v0.1 roadmap). AA needs the AET anyway — the per-scanline coverage emitter walks the *active* edges, not all edges. Building AA on top of the current naive sweep means re-doing it. Cost rises with every feature that lands on top.

**Goal.**

1. Sort the edge list by `y_min` once after building.
2. Maintain `active: SmList(*Edge)` incrementally — add edges whose `y_min` ≤ current scanline, drop edges whose `y_max` < current scanline.
3. For each active edge keep an incremental `x = x_at_y_min + (y - y_min) * inv_slope` running variable; advance by `inv_slope` per scanline (one `+` instead of one `*` + `+`).
4. Sort *only the active list* per scanline (typically ≤ 16 entries) — insertion sort on the already-mostly-sorted list is O(active).

**Files touched.** `core/SmScan.zig` only — `sweepEdges` and the data layout of `Edge`. Public API unchanged (`fillPath` / `strokePath` signatures stay).

**Effort.** 4 h.

**Acceptance.** All visual scenes pass byte-equal vs current. Bench: complex path (≥ 200 edges) on a 1080p canvas runs ≥ 5× faster.

**Implemented at:** `zig/simdra/core/SmScan.zig`. Added `ActiveEdge { x, dx, y_max, dir }` plus `ActiveBuf = SmList(ActiveEdge)`. New `sortEdgesByYMin` (one-shot insertion sort, called once after edge generation) and `sortActiveByX` (per-scanline insertion sort over the typically-small active list). The new `sweepEdges` body: 1) sort edges by y_min, 2) walk scanlines, 3) drop expired edges via swap-remove, 4) admit new edges by walking a `next_idx` cursor through the sorted list, 5) sort active by x, 6) emit non-zero-winding spans, 7) advance every active edge's `x` by `dx`. The previous `IntersectionBuf` + `sortIntersections` machinery deleted (active list replaces it; per-scanline x is incremental, not recomputed).

Notable: tests came back **byte-equal** (125/125 at the same SSIM thresholds the spec already used), even though the spec allowed up to SSIM ≥ 0.999. The active-list / sorted-edges algorithm produces the same intersection ordering as the naive sweep on the test scenes — the tie-break risk noted in the plan exists in theory but didn't manifest. If a future scene shows divergence, the SSIM ≥ 0.999 fallback bar applies. `npm run build` (1.16 MB), `npm run test:built` all pass.

The AET is also the prerequisite for the next feature work (analytic-edge AA path fills): the per-scanline coverage emitter walks `active` and emits per-pixel coverage proportional to (signed area) of edge intersection within each pixel box. SmBlitter's coverage path is already plumbed end-to-end (B2), so the only thing missing for AA is the coverage-row generator on top of the AET.

---

### B2 — 🟢 Coverage routes through *every* blend mode

**Status quo.** `core/SmBlitter.zig:60-63` — only `src_over` / `src` / `copy` honor coverage. Other blend modes drop coverage on the floor, comment: "visually wrong on partial-coverage edges, but functional for solid spans."

**Why it matters.** Once AA paths land (B1 + the AA coverage emitter), every blend mode must produce correct AA output, not just `src_over`. A path filled with `multiply` or `screen` gets stair-stepped edges today.

**Goal.** Pre-modulate `paint.color` 's source.a by per-pixel coverage **upstream** of the blend dispatch:

```zig
if (coverage) |cov| {
    // Modulate sa per-pixel into a temporary row of effective src colors,
    // then dispatch into the same per-mode kernels with that row as input.
    // Or: pass `cov` through to a coverage-aware variant of every kernel.
}
```

Two implementation options:

- **(a) Build effective-src row.** One pass over `cov`, produce `[N]u32` of `(rgb, sa*cov)`. Then call the existing per-mode kernel that takes a SOLID source — except now the source is per-pixel. Requires lifting every `blendXxxU32(dst, src_color: u32)` to `blendXxxU32Row(dst, src_row: []const u32)`. Larger change, cleaner end state.
- **(b) Coverage-parameter on every kernel.** Pass `coverage: ?[]const u8` through every blend kernel. Branches inside each. Smaller change, slightly worse codegen on the no-coverage hot path.

(a) is the right end state; (b) is acceptable as a transitional step.

**Files touched.** `core/SmBlitter.zig`, `opts/generic.zig` (every `blend*U32` row kernel), `opts/neon.zig` re-exports.

**Effort.** 6 h for (a), 4 h for (b).

**Depends on.** Lands cleanly *before* AA (B1) so AA gets correct compositing for free. Ordering: do this first.

**Implemented at:** `zig/simdra/opts/generic.zig` — added 23 per-mode `blend*CovU32` kernels (8 Porter-Duff + 11 separable + 4 non-separable HSL + saturating-add), all generated via two comptime helpers (`rowOfCov(comptime k: BlendKernel)` and `rowOfCovNonSep(comptime kind: NonSepKind)`) on top of the unified `blendScalar` from B6 — each new kernel is a one-line `pub const`. The shared `modulateAlphaByCov(src_color, cov_byte)` helper produces the effective per-pixel source `(rgb, sa·cov/255)`, then the existing per-mode evaluator runs unchanged. `add` ('lighter') gets a manual coverage variant since its non-coverage kernel is direct saturating add (not a `blendScalar` consumer). Re-exports added in `zig/simdra/opts/simd.zig` and `zig/simdra/opts/neon.zig`. `zig/simdra/core/SmBlitter.zig` — `blitRow`'s coverage branch now calls a new `dispatchCoverage(row, solid_color, cov, mode)` helper that switches on `paint.blend_mode` across all 26 modes; `src` / `src_over` / `copy` keep the optimized `blendSrcOverCovU32` fast path.

5 new visual scenes added in `test/index.js` (V26-V30): `fillText` under `multiply`, `screen`, `darken`, `source-in`, `destination-atop`. Glyph alpha rows exercise the new coverage paths; pre-B2 these would have rendered solid-span (coverage dropped) for non-src_over modes; post-B2 the partial-coverage edges blend correctly through every operator. The 2 layer-composite scenes (`source-in`, `destination-atop`) also validate the existing `beginCompositeLayer` plumbing under the new dispatch. Test suite: **120 → 125 passing** (47 → 52 visual; 73 plain unchanged). `npm run build` (1.14 MB), `npm run test:built` all pass.

---

### B3 — 🔴 `SmCanvas` god-object split

**Status quo.** `core/SmCanvas.zig` is 1001 lines and carries: pixels (duplicated from Surface), width/height (duplicated), state (transform / styles / blend / alpha), state stack, scratch composite layer, the path buffer, paint construction, CTM transform application, text layout. Skia explicitly splits these across `SkCanvas` + `SkClipStack` + `SkRecord` + `SkRasterDevice`.

**Why it matters.** A 1000-line god-object is hard to reason about and harder to test in isolation. State management, composite-layer scratch lifecycle, and per-method dispatch are three distinct concerns currently entangled. Each one wants its own test surface; today they only get tested through end-to-end visual scenes.

**Goal — minimum split.**

- `core/SmCanvasState.zig` — `transform`, `fillStyle`, `strokeStyle`, `lineWidth`, `alpha`, `blendMode`, `state_stack`, `save()`, `restore()`. Pure state, no pixels. Independently unit-testable.
- `core/SmCompositeLayer.zig` — the `scratch_pixels` buffer + `beginCompositeLayer` / `endCompositeLayer` / `blitFull` glue. Used by the 5 layer-composite blend modes.
- `core/SmCanvas.zig` — keeps the dispatch surface (`drawRect`, `drawTriangle`, `fillPath`, `strokePath`, `drawText`, `drawImage`); holds a `state: SmCanvasState`, a `composite: SmCompositeLayer`, and a back-reference to its `*SmSurface`.

**Files touched.** `core/SmCanvas.zig` shrinks from 1001 → ~600. New `SmCanvasState.zig` (~150 LOC) and `SmCompositeLayer.zig` (~100 LOC).

**Effort.** 4–6 h.

**Acceptance.** All tests pass. No public API change.

---

### B4 — 🟡 Remove pixel/dimension duplication: `SmCanvas` → `*SmSurface`

**Status quo.** `core/SmCanvas.zig:85-88` — `pixels: []u32`, `width: u32`, `height: u32`, `colorSpace: types.ColorSpace`, all copied from `SmSurface` at `getCanvas()` time. If `SmSurface` ever gains a `resize()` method (it doesn't today, but it's a normal extension), the two desync.

**Goal.** Replace those four fields with a single `surface: *SmSurface` back-reference. Every call that needs `self.pixels` becomes `self.surface.pixels`. Ownership invariant ("one Canvas per Surface") is already enforced in `SmSurface.getCanvas` via the `ctx_ptr` cache.

**Files touched.** `core/SmCanvas.zig` (replace fields, plumb), `core/SmSurface.zig` (no public change). Every `self.pixels` / `self.width` / `self.height` inside SmCanvas updates.

**Effort.** 1 h.

**Depends on / pairs with.** B3 — clean to land together.

**Implemented (partial) at:** `zig/simdra/core/SmCanvas.zig` (added `surface: *SmSurface` back-ref; removed `width`, `height`, `colorSpace` fields; ~20 sites updated to read `self.surface.width` / `.height` / `.colorSpace`); `zig/simdra/core/SmSurface.zig` (`getCanvas` now constructs `c.* = .{ .surface = self, .pixels = self.pixels }` instead of copying the four fields). `pixels` stays on SmCanvas because it is **not** a static copy of `surface.pixels` — it is the live render target that `beginCompositeLayer` swaps to a scratch buffer during the 5 layer-composite blend modes (`src-in`, `src-out`, `dst-in`, `dst-atop`, `copy`). Full pixels removal pairs with **B3** when SmCompositeLayer extracts the swap mechanism into its own type. The 3 always-static fields (width/height/colorSpace) were the real desync risk and they're gone now. Status downgraded to 🟡 partial; `pixels` removal lands with B3. Verified: `npm test` 120/120, `npm run build` (1.13 MB), `npm run test:built` all pass.

---

### B5 — 🟢 `fillStyle` / `strokeStyle` as a `Shader` union, not `u32`

**Status quo.** `SmCanvas.fillStyle: u32 = 0xFF000000` and `SmCanvas.strokeStyle: u32`. SmGradient *exists* as a type but cannot be used as a fill style — only solid colors. The SmPaint comment already foresees `shader: ?*const Gradient = null` (line 11).

**Why it matters.** `INDEX.md` post-v0.1 roadmap lists "Gradient as `fillStyle`" as 3 h of work. Today the gradient code is a half-built bridge. Committing to the union now keeps every paint-construction site uniform.

**Goal.**

```zig
pub const Shader = union(enum) {
    solid: u32,
    gradient: *const SmGradient,
    pattern: *const SmPattern, // not yet — placeholder for INDEX.md A4 item
};
```

`SmCanvas.fillStyle: Shader = .{ .solid = 0xFF000000 }`. Same for `strokeStyle`. `SmPaint.color: u32` widens to `SmPaint.shader: Shader`. The `Sm*Blitter` dispatch on `paint.shader` instead of `paint.color`.

**Files touched.** `core/SmPaint.zig` (rename `color` → `shader`), `core/SmCanvas.zig` (state fields + every paint construction site), `core/SmBlitter.zig` (dispatch on `shader`), `opts/generic.zig` + `opts/neon.zig` (kernel signatures stay; gradient kernels added later).

**Effort.** 3 h for the type widening (no gradient sampling yet — `gradient` arm just `unreachable` until the gradient sampler kernel lands).

**Depends on.** Slots cleanly under the existing "Gradient as fillStyle" 3 h roadmap item — combined effort is 4–5 h instead of 3 h, but eliminates a future migration.

**Implemented at:** `zig/simdra/core/SmPaint.zig` (added `Shader = union(enum) { solid: u32, gradient: *const SmGradient }`, renamed `color: u32` → `shader: Shader`, updated `fill()`/`stroke()` factories to wrap `u32 → .{ .solid = u32 }`); `zig/simdra/core/SmCanvas.zig` (`fillStyle`/`strokeStyle` widened to `SmPaint.Shader` with `.solid` defaults; `setFillStyle` / `setStrokeStyle` wrap into Shader; new `solidColorWithAlpha(shader, modulator)` helper switches on the union and panics on `.gradient` for now; `StateFrame` widened to capture Shader); `zig/simdra/core/SmBlitter.zig` (added `solidColorOf(shader)` helper; `dispatchSolid` extracts `solid_color = solidColorOf(paint.shader)` once at the top, then dispatches by blend_mode using `solid` rather than `paint.color`; `blitFull` constructs single-pixel paints with `.shader = .{ .solid = single_src }`). The `gradient` arm panics with `unreachable` — JS façade only writes solid-color CSS strings, so today nothing reaches the panic. The dispatch is now positioned to plug a gradient sampler in by replacing each `unreachable` with the sampler call. Verified: `npm test` 120/120, `npm run typecheck`, `npm run build` (1.10 MB), `npm run test:built` all pass.

---

### B6 — 🟢 Unify `pdScalar` / `sepScalar` / `nonSepScalar` evaluators

**Status quo.** `opts/generic.zig:244` (Porter-Duff), `opts/generic.zig:314` (separable), `opts/generic.zig:516` (non-separable HSL) — three parallel evaluators. All share the shape: premultiply src/dst → weighted-sum of (Fa·src + Fb·dst + extra·B(Cb,Cs)) → un-premultiply. Three half-deduped copies of the W3C spec.

**Goal.** A single comptime-parameterized evaluator:

```zig
const BlendKernel = struct {
    /// Returns (co_premult, ao) given premultiplied src/dst components and alphas.
    co_of: fn (sr_p: u32, dr_p: u32, sa: u32, da: u32) u32,
    ao_of: fn (sa: u32, da: u32) u32,
};

inline fn blendScalar(src: u32, dst: u32, comptime k: BlendKernel) u32 { ... }
```

Per-mode kernel structs replace `pdScalar(faOne, faInvSa)` / `sepScalar(bMultiply)` / `nonSepScalar(.hue)`. Zig's comptime fully inlines them — zero runtime cost.

**Files touched.** `opts/generic.zig` — the three evaluators replaced by one. `opts/neon.zig` re-exports unchanged.

**Effort.** 3 h.

**Acceptance.** Byte-equal output to the current evaluators on all 47 visual scenes.

**Implemented at:** `zig/simdra/opts/generic.zig`. The 22 Porter-Duff + separable-blend modes share one envelope: `inline fn blendScalar(src, dst, comptime k: BlendKernel) u32` with the kernel struct `{ aoOf, coOf }` (the spec's exact shape). Two factories — `pdKernel(comptime fa, comptime fb)` and `sepKernel(comptime B)` — synthesize the kernels at comptime via the standard Zig "anonymous-struct closure" pattern. Per-mode wrappers became one-liners (`fn srcInScalar(src, dst) u32 { return blendScalar(src, dst, pdKernel(faDa, faZero)); }`).

Non-separable HSL blend (`hue/saturation/color/luminosity`) was **deliberately left untouched**. Its un-premult is float-arithmetic-throughout (single rounding at the very end); routing it through the integer u64-widened un-premult would change rounding by up to 1 LSB and risk regressing the HSL scenes' SSIM thresholds. The honest result: 22 of 26 modes share one evaluator; non-sep stays as a parallel float pipeline. That's 2 evaluators instead of 3, with a documented reason for the remaining split. Verified: `npm test` 120/120 (byte-equal — comptime monomorphization through the function-pointer fields produces the same machine code), `npm run build` (1.10 MB, 77 modules), `npm run test:built` all pass.

---

### B7 — 🟢 Single path-opcode walker (`walkOpcodes(data, comptime Visitor)`)

**Status quo.** `core/SmScan.zig:321` (`walkPath` for fills) and `core/SmScan.zig:765` (`strokeWalkPath` for strokes) both reimplement the opcode-byte-stream dispatch over `SmPath.Opcode`. ~150 lines duplicated.

**Goal.**

```zig
fn walkOpcodes(data: []const u8, comptime visitor: anytype) !void {
    // single switch on tag, calls visitor.moveTo / lineTo / quadTo / bezierTo / rect / close
}
```

Two visitor structs:

- `FillVisitor` — wraps an `EdgeBuf`, calls `addEdge` / `flattenQuad` / `flattenCubic`.
- `StrokeVisitor` — wraps a `PointBuf` and emits `strokePolyline` at subpath boundaries.

**Files touched.** `core/SmScan.zig` only.

**Effort.** 2 h.

**Acceptance.** Byte-equal output. Net LOC drops ~80.

**Implemented at:** `zig/simdra/core/SmScan.zig`. Single `walkOpcodes(verbs, points, visitor: anytype)` runs the typed pair-of-cursors loop and dispatches per opcode to the visitor's `onClose / onMoveTo / onLineTo / onQuadTo / onBezierTo / onRect`. Two visitor structs replace the old hand-rolled walkers: `FillVisitor` (holds `cur_x/y`, `subpath_x/y`, `subpath_open`, calls `addEdge` / `flattenQuad` / `flattenCubic`) and `StrokeVisitor` (holds the `pts: PointBuf`, `half_w`, `miter_limit`, calls `strokePolyline` at subpath boundaries). End-of-path implicit-close logic (fill) and final-polyline-flush (stroke) live at the call site, after `walkOpcodes` returns. Net LOC drop ~80 in SmScan; the gain is conceptual — adding a new opcode now means adding one method per visitor, not two parallel switch arms. Lands together with B8 (typed storage). Verified byte-equal: `npm test` 125/125 (52 visual SSIM at threshold, 73 plain).

---

### B8 — 🟢 Typed path opcode array instead of byte stream

**Status quo.** `core/SmPath.zig` stores path as `tag_byte | f64 | f64 | ...` little-endian byte sequence; consumers in `SmScan.zig` use `readF64(data, off)` at byte offsets. Memory-dense but every consumer reimplements the offset arithmetic.

**Goal.** Two parallel arrays (Skia's `SkPath` shape):

```zig
verbs: SmList(Verb),       // u8 tag per segment
points: SmList(f64),       // 2*N floats, indexed by verb's point count
```

Walker becomes a typed pair-of-cursors loop instead of byte-offset arithmetic.

**Cost.** Path memory footprint goes from `1 + n*8` per segment to `1 + n*8 + 1/8` bytes amortized (the verbs array). Negligible compared to pixel buffers.

**Files touched.** `core/SmPath.zig` (storage rewrite), `core/SmScan.zig` (consumer rewrite — pairs with B7).

**Effort.** 3 h.

**Depends on / pairs with.** B7 — same surgery; do them together.

**Implemented at:** `zig/simdra/core/SmPath.zig`. Storage rewritten from one byte-stream `buf: SmList(u8)` to two parallel lists `verbs: SmList(u8) + points: SmList(f64)`. New helper `pub fn floatCount(op: Opcode) u8` exposes the per-verb point count (consumed by `walkOpcodes` in SmScan). `appendOpcode` and `appendSegment` were rewritten to push to the typed lists; `addPath` now does two `appendSlice` calls (one per list); `addPathTransform` walks via `(verbs, points)` cursor pair, applying the matrix to each verb's points. `readF64` byte-offset helper deleted — no consumer reads bytes anymore. SmScan consumers track a `pi` (point index) and read `points[pi..][0..floatCount(op)]`. Verified byte-equal: 125/125 tests pass at the same SSIM thresholds.

---

### B9 — 🟢 Hoist text shaping out of `SmCanvas.drawText` into `core/SmTextRun.zig`

**Status quo.** `SmCanvas.drawText` (`core/SmCanvas.zig:930-990`) does UTF-8 decode, baseline math, glyph rasterization, blit — all inline. As soon as kerning / bidi / sub-pixel positioning land (post-v0.1 roadmap "Text v2"), this method grows another few hundred lines. Skia hoists this into `SkTextBlob` for exactly that reason.

**Goal.**

- `core/SmTextRun.zig` — pre-shaped sequence of `(glyph_index, dx, dy)` triples produced from a `(text_utf8, font, options)` input. Holds the shaping output, not the rendering.
- `SmCanvas.drawText` becomes: `const run = try SmTextRun.shape(text, font, options); self.drawTextRun(&run, x, y, paint);`

Today's shaping is trivial (advance widths only), but the type slot exists for kerning / bidi / sub-pixel.

**Files touched.** New `core/SmTextRun.zig`. `core/SmCanvas.zig:930-990` shrinks.

**Effort.** 2 h now (mechanical extraction). Saves much more later.

**Depends on.** Doesn't depend on anything; can land any time.

**Implemented at:** new `zig/simdra/core/SmTextRun.zig` (~50 LOC) — exposes `Glyph { index: i32, dx: f64, dy: f64 }` + `glyphs: SmList(Glyph)` + `shape(text_utf8, font)` factory + `deinit`. `SmCanvas.drawText` now shapes a run via `SmTextRun.shape(...)` and delegates to a new `drawTextRun(run, x, y, font, paint)` method which holds the rasterize-and-blit loop. Glyph rasterization stays render-side because the cache lives on `SmFont`. v1 shaping is UTF-8 decode + horizontal advance accumulation; the slot is ready for kerning / sub-pixel / bidi without further surgery on the rendering loop. Verified: `npm test` 120/120 (text scenes byte-equal — same shape pipeline, just routed through a typed run), `npm run build` (1.13 MB), `npm run test:built` all pass.

---

### B10 — 🟢 Anti-aliased path rasterization (`SmScan.sweepEdges`)

**Status quo (pre-fix).** `sweepEdges` rounded each scanline's float edge intersections to the nearest integer (`@round(span_start_x)` / `@round(a.x)`) and called `SmBlitter.blitRow(..., coverage = null, ...)`. Every pixel was fully painted or fully skipped — every curved or non-axis-aligned edge produced a per-row staircase. The Blitter coverage path (B2) was already wired end-to-end across all 27 blend modes (proven by the glyph render path); the only missing piece was the coverage-row generator.

**Why it mattered.** Highest-impact visual quality jump in the post-v0.1 roadmap. `INDEX.md:78` budgeted 4 h. Required before pdf.js end-to-end and any chart-library output looks acceptable.

**Algorithm chosen.** **8× Y-supersample with analytic-X partial coverage** — the standard FreeType/Cairo hybrid:

  1. Per integer scanline, run the existing AET admit / expire at row-band granularity (`y_min < y_bot`, `y_max > y_top`).
  2. For each of 8 sub-y samples spaced `1/8` apart, build a transient `(x, dir)` list of edges live at `y_sub = y_int + (k + 0.5)/8`, sort by x (insertion — near-sorted across sub-samples), walk for inside spans per fill rule.
  3. Each sub-y span deposits coverage into a per-row `f32` accumulator with weight `1/8`. Boundary cells receive analytic-x partial fractions (`right − left`); fully-interior cells receive the full per-sub-sample weight. Summed across 8 sub-samples this preserves full 256-level coverage — the analytic-x fractions sum without precision loss before quantization.
  4. After 8 sub-samples, sparse-scan the accumulator for non-zero runs; each run is quantized to the `u8` `cov_row` and handed to `SmBlitter.blitRow`. The Blitter's existing coverage path (B2) routes through every blend mode and combines per-pixel with `clip_mask`.

Pure analytic AA (Skia "AAA") was rejected: same 256-level output, ~1× the per-row cost vs ~8× for the hybrid, but the partial-pixel pixel-box-area math has 8 trapezoid cases per edge crossing plus tricky overlap handling. The hybrid is correct for any path (including self-intersecting and winding-overlap) by virtue of re-running the AET per sub-sample. Pure analytic remains a future perf optimization.

**Files touched.**
- `zig/simdra/core/SmScan.zig` — rewrote `sweepEdges`. New `aa_sub_count = 8`, `depositSpan(...)`, `SubEdge { x, dir }` + `sortSubEdgesByX`. The `ActiveEdge` struct shape changed from `(x, dx, y_max, dir)` to `(y_min, y_max, x_at_y_min, inv_slope, dir)` — sub-samples recompute x from the cached edge fields rather than incrementally advancing, avoiding accumulated rounding error across 8 sub-y steps. `sweepEdgesToMask` (the binary clip-mask path) was updated to the new `ActiveEdge` shape but stays aliased — clip masks must be 0/0xFF for the existing `SmCanvas.clipInternal` `min` intersection. `fillPath`/`strokePath` signatures gain `aa_accum: []f32` + `cov_row: []u8` scratch params. New public `fillPolygonF(allocator, pixels, ..., vertices: []const [2]f64, ...)` sits next to `fillPath` — builds an `EdgeBuf` from arbitrary float vertices and routes through the same `sweepEdges` pipeline, used by the non-path triangle / rotated-rect helpers. The legacy `TriangleScan` + `Point` types were removed (last user gone).
- `zig/simdra/core/SmCanvas.zig` — added `aa_accum: ?[]f32` + `aa_coverage: ?[]u8` scratch fields with `ensureAaScratch` helper, freed in `deinit`. Threaded into `fill()` / `fillPathExternal()` / `strokeInternal()` callsites. `drawTriangleNoTransform` widened to `f64` vertices and routed through `SmScan.fillPolygonF`. `drawTriangle` (public) passes f64 directly without `@round` so sub-pixel CTM positioning preserves its precision through to the rasterizer. The rotated-`drawRect` decomposition was rewritten from two-triangle `drawTriangleNoTransform` calls into a single 4-vertex `fillPolygonF` call — eliminates the diagonal seam that two-triangle AA would have left where each triangle's coverage tapers off internally. The axis-aligned `drawRect` fast path stays binary (integer-coord rects don't need AA, and `clearRect` requires binary semantics under `.src` blend).
- `test/index.js` — bumped SSIM thresholds for V05–V09c from 0.85–0.90 to 0.985–0.99 (every curve scene jumped to ≥ 0.997 actual). Bumped V13 (`fillRect` under translate+rotate+scale CTM) from 0.90 → 0.99 — the rotated-rect path went from 0.9689 to 0.9999 once it routed through AA. Added 7 new scenes total: 4 stroked-curve (V05a/V05b/V08a/V09s, exercising AA on stroke outlines where thin strokes are the worst-case workload — one row's worth of fractional coverage per side) and 3 polygon (V13a `fillRect` rotated 30°, V13b non-axis-aligned triangle path with sub-pixel vertices).

**Effort.** ~3 h.

**Acceptance.** SSIM ≥ 0.985 vs `@napi-rs/canvas` (Skia, used as the reference at runtime via `compareScene`) on every curve / stroked-curve scene. Output is intentionally NOT byte-equal to the previous binary-span path — every shape with a curved or non-axis-aligned edge changes by design. Verified: `npm test` 295/295, `npm run typecheck` clean, `npm run build` (WASM 383 KB / 153 KB gzip), `npm run test:built` clean.

**Follow-up landings (same plan).**

- **`i32 → f64` drawing-op signatures.** `drawRect`, `fillRect`, `strokeRect`, `clearRect`, `drawTriangle`, `fillTriangle`, `strokeTriangle` (and the internal chain `drawRectAxisAligned` / `fillRectSpan`) now take `f64` for coordinates. JS already passes `number`; node-zigar previously truncated to i32. After widening, fractional coords reach the rasterizer and are AA'd.

- **Rotated `strokeRect` + outlined `strokeTriangle`.** Both previously degraded (silent no-op / fill-as-stroke). Now build a 4-vertex / 3-vertex closed `SmPath` from CTM-applied corners and route through `SmScan.strokePath`, honoring `lineCap` / `lineJoin` / `miterLimit` / `setLineDash` / `lineDashOffset`.

- **AA on axis-aligned fractional-coord rects.** `fillRectSpan` branches on integer-alignment: integer-aligned coords (and `.src` blend for `clearRect`) keep the binary `blitRow` fast path; fractional coords route through `SmScan.fillPolygonF` so half-pixel boundaries get analytic-x partial coverage. `fillRect(50.5, 50.5, 100, 100)` now matches Skia at SSIM 1.0000.

- **AA-aware clip mask.** `SmScan.fillPathToCoverage` now writes fractional u8 coverage via a new `sweepEdgesToCoverageMask` (AA mirror of `sweepEdges`). `SmCanvas.clipInternal` switched from `@min(a, b)` to multiplicative `(a * b + 127) / 255` intersection — `SmBlitter.blitRow`'s clip combination at line 104-109 already uses the same formula, so AA shapes near AA clip boundaries compose correctly with no further blitter changes. The previously-binary `sweepEdgesToMask` was retired (last user gone).

- **Tighter arc chord tolerance.** `SmPath.arc_chord_tolerance` 0.25 → 0.1. Cuts the per-vertex coverage discontinuity along stroked curves (V05a thin / V05b thick / V09s round-cap diff PNGs showed periodic vertex pulses on the polygon-flattened stroke outline). Stroke outline inflation in `SmScan.emitArcFan` reads the same constant, so cap silhouettes tighten too. Curve scenes jumped: V05 0.9975 → 0.9998, V05a 0.9926 → 0.9972, V05b 0.9929 → 0.9970, V09s 0.9881 → 0.9922. Tightening to 0.05 was diminishing-returns (only ~+0.001) at ~70% more segments — left at 0.1.

- **`drawImage` honors `globalCompositeOperation` + `globalAlpha`.** `drawImageScaledSub` previously sampled directly into `dst_row` and ignored both. Now opens `beginCompositeLayer` for non-row-friendly modes (src-in, src-out, dst-in, dst-atop, copy), samples into a per-row src scratch (stack [1024]u32 + heap fallback), and routes through new `SmBlitter.blitRowFromSource` — mirrors the per-pixel shape of `dispatchShader` (gradient/pattern path) but takes a pre-sampled `src` row instead of invoking a shader sampler. The legacy snapshot/restore clip dance disappears: clip is honored row-wise via the per-pixel `clip_row` check inside `blitRowFromSource`.

**Future work.** Pure analytic AA (drop Y-supersampling) is a perf-only optimization — analogous to Skia's "AAA" path. ~1× the per-row work for the same 256-level output (vs current 8× sub-y sweep). Trapezoid case-handling (8 entry/exit shapes per edge crossing, plus near-horizontal edges and pixel-grid coincidences) is the bug surface; correctness risk justified deferring it. Same `SmBlitter` interface, can land any time without API change.

---

## Cross-cutting: encoder layer (informational only, no checkbox)

`encode/png.zig` always uses uncompressed DEFLATE stored blocks (output ~2× ideal size). The honest comment names this. Not an architectural debt — it's a `std.compress` API stability call. When `std.compress.flate` stabilizes across Zig 0.15 → 0.16, swap it in. No spec checkbox: this is a one-line dependency change, not a design item.

---

## Suggested ordering

If you only do five, do them in this order — each unlocks or de-risks the next:

1. **B2** (coverage through every blend mode) — must land *before* AA paths so AA gets correct compositing for free. Otherwise every new blend mode's AA story is wrong-by-default.
2. **B1** (Active Edge Table) — also a prerequisite for AA. Pairs with B2.
3. **B5** (Shader union for fillStyle) — pairs with the existing "Gradient as fillStyle" 3 h roadmap item. Doing them combined is cheaper than serial.
4. **B3** + **B4** (SmCanvas split + Surface back-reference) — does not block features, but the longer SmCanvas grows the harder it gets to split. Cheapest right now.
5. **A1** (`SmList(T)`) — biggest LOC win for least risk. Good warm-up task.

A2 (allocator threading) is a one-day project of its own; schedule when there's space, not interleaved with feature work.

---

## How to use this spec

1. Pick a 🔴 item.
2. Read its **Goal** and **Files touched**. Read CLAUDE.md for the file-is-struct + module-graph conventions.
3. Implement. Keep `npm test` green at every commit (47 visual SSIM + 73 plain).
4. If a JS-binding constraint blocks the change (zigar quota, sentinel validator, etc.), document it in a comment at the implementation site and downgrade the item to ⏭️ deferred with the specific blocker — don't silently regress.
5. Tick the box, note the implementing file/path next to it.
