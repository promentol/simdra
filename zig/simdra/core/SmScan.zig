//! SmScan — scan converter (shape → coverage rows).
//!
//! Mirrors Skia's `SkScan`. Pure geometry: turns shapes into per-row spans
//! `(y, x_lo, x_hi[, coverage])` that the Blitter consumes. Doesn't touch
//! pixels itself.
//!
//! Rect + triangle scan emit full-coverage spans (axis-aligned shapes don't
//! need AA). `fillPath` / `strokePath` use `sweepEdges` — analytic-edge AA
//! via 8× Y-supersample + analytic-X partial coverage; per-row coverage is
//! quantized to a u8 row and dispatched through `SmBlitter.blitRow` (which
//! routes through every blend mode + clip mask). The clip-mask scan
//! (`sweepEdgesToMask`) intentionally stays binary — `SmCanvas.clipInternal`
//! intersects masks via per-pixel `min`, which assumes 0/0xFF values.

const std = @import("std");
const SmPath = @import("SmPath.zig");
const SmPaint = @import("SmPaint.zig");
const SmBlitter = @import("SmBlitter.zig");
const SmList = @import("../utils/SmList.zig").SmList;
const SmSpans = @import("SmSpans.zig");
const SmMatrix = @import("SmMatrix.zig");

/// HTML5 `fillRule` argument. Default `'nonzero'`. `'evenodd'` flips parity
/// at every edge crossing regardless of direction.
pub const FillRule = enum(u8) {
    nonzero = 0,
    evenodd = 1,
};

inline fn windingInside(winding: i32, fill_rule: FillRule) bool {
    return switch (fill_rule) {
        .nonzero => winding != 0,
        .evenodd => (winding & 1) != 0,
    };
}

/// Clipped axis-aligned rect in canvas pixel coordinates.
/// `x0, y0` inclusive; `x1, y1` exclusive.
pub const ClippedRect = struct {
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
};

/// clipRect — intersect a (possibly off-canvas) rect with canvas bounds.
/// Returns null if the result has zero area.
pub fn clipRect(
    canvas_w: u32,
    canvas_h: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) ?ClippedRect {
    const cw: i32 = @intCast(canvas_w);
    const ch: i32 = @intCast(canvas_h);
    const x0 = @max(0, x);
    const y0 = @max(0, y);
    const x1 = @min(cw, x + w);
    const y1 = @min(ch, y + h);
    if (x0 >= x1 or y0 >= y1) return null;
    return .{ .x0 = x0, .y0 = y0, .x1 = x1, .y1 = y1 };
}

// ---------------------------------------------------------------------------
// Path fill (T5) — flatten Béziers, build edge list, AET scanline sweep.
// ---------------------------------------------------------------------------
//
// Algorithm:
//   1. Walk path opcodes. Emit one Edge per line segment. Béziers are
//      flattened by recursive de Casteljau subdivision until each segment's
//      chord error is below `flatness_tolerance` (0.25 px).
//   2. Find overall y range, clip to canvas.
//   3. For each scanline y:
//      - Collect intersection x-coordinates of every active edge.
//      - Sort intersections by x.
//      - Walk left-to-right tracking winding number; emit a span between
//        every "0 → nonzero" and "nonzero → 0" transition (HTML5 nonzero
//        fill rule, the spec default).
//   4. Each span calls `SmBlitter.blitRow` — same downstream pipeline as
//      drawRect / drawTriangle. Inherits the SIMD blend kernels.
//
// SIMD note: the per-pixel hot path (Blitter.blitRow → simd kernels) is
// already vectorized. Edge intersection math runs O(edges × scanlines)
// — scalar but cache-friendly for typical canvas paths (≤ thousands of
// edges).

const flatness_tolerance: f64 = 0.25;
const flatness_tolerance_sq: f64 = flatness_tolerance * flatness_tolerance;

/// One non-horizontal line segment in the path's edge list.
pub const Edge = struct {
    y_min: f64,
    y_max: f64,
    x_at_y_min: f64,
    inv_slope: f64, // dx/dy
    direction: i8, // +1 if y increasing, -1 if y decreasing (winding contribution)
};

pub const EdgeBuf = SmList(Edge);

/// Add a line segment to the edge list, dropping horizontal segments
/// (no scanline contribution) and tracking direction for winding count.
fn addEdge(edges: *EdgeBuf, allocator: std.mem.Allocator, x0: f64, y0: f64, x1: f64, y1: f64) !void {
    if (y0 == y1) return; // horizontal — no coverage
    var e: Edge = undefined;
    if (y0 < y1) {
        e = .{
            .y_min = y0,
            .y_max = y1,
            .x_at_y_min = x0,
            .inv_slope = (x1 - x0) / (y1 - y0),
            .direction = 1,
        };
    } else {
        e = .{
            .y_min = y1,
            .y_max = y0,
            .x_at_y_min = x1,
            .inv_slope = (x0 - x1) / (y0 - y1),
            .direction = -1,
        };
    }
    try edges.append(allocator, e);
}

/// Read a little-endian f64 at byte offset.
inline fn readF64(data: []const u8, off: usize) f64 {
    var v: f64 = undefined;
    @memcpy(std.mem.asBytes(&v), data[off..][0..8]);
    return v;
}

/// True if quadratic Bézier (p0, cp, p1) is "flat enough" (chord-distance
/// from cp to line p0-p1 below the flatness tolerance).
fn isQuadFlat(p0x: f64, p0y: f64, cpx: f64, cpy: f64, p1x: f64, p1y: f64) bool {
    const dx = p1x - p0x;
    const dy = p1y - p0y;
    const len_sq = dx * dx + dy * dy;
    if (len_sq < 1e-9) return true; // degenerate: p0 ≈ p1
    const cross = (cpx - p0x) * dy - (cpy - p0y) * dx;
    return (cross * cross) < flatness_tolerance_sq * len_sq;
}

/// Recursively flatten a quadratic Bézier into line edges.
fn flattenQuad(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    p0x: f64,
    p0y: f64,
    cpx: f64,
    cpy: f64,
    p1x: f64,
    p1y: f64,
    depth: u32,
) !void {
    if (depth >= 16 or isQuadFlat(p0x, p0y, cpx, cpy, p1x, p1y)) {
        try addEdge(edges, allocator, p0x, p0y, p1x, p1y);
        return;
    }
    // Split at t = 0.5 via de Casteljau.
    const m1x = (p0x + cpx) * 0.5;
    const m1y = (p0y + cpy) * 0.5;
    const m2x = (cpx + p1x) * 0.5;
    const m2y = (cpy + p1y) * 0.5;
    const mx = (m1x + m2x) * 0.5;
    const my = (m1y + m2y) * 0.5;
    try flattenQuad(edges, allocator, p0x, p0y, m1x, m1y, mx, my, depth + 1);
    try flattenQuad(edges, allocator, mx, my, m2x, m2y, p1x, p1y, depth + 1);
}

/// True if cubic Bézier (p0, c1, c2, p1) is "flat enough". Both control
/// points must be within tolerance of chord p0-p1.
fn isCubicFlat(
    p0x: f64,
    p0y: f64,
    c1x: f64,
    c1y: f64,
    c2x: f64,
    c2y: f64,
    p1x: f64,
    p1y: f64,
) bool {
    const dx = p1x - p0x;
    const dy = p1y - p0y;
    const len_sq = dx * dx + dy * dy;
    if (len_sq < 1e-9) return true;
    const cross1 = (c1x - p0x) * dy - (c1y - p0y) * dx;
    const cross2 = (c2x - p0x) * dy - (c2y - p0y) * dx;
    const max_cross_sq = @max(cross1 * cross1, cross2 * cross2);
    return max_cross_sq < flatness_tolerance_sq * len_sq;
}

/// Recursively flatten a cubic Bézier into line edges.
fn flattenCubic(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    p0x: f64,
    p0y: f64,
    c1x: f64,
    c1y: f64,
    c2x: f64,
    c2y: f64,
    p1x: f64,
    p1y: f64,
    depth: u32,
) !void {
    if (depth >= 18 or isCubicFlat(p0x, p0y, c1x, c1y, c2x, c2y, p1x, p1y)) {
        try addEdge(edges, allocator, p0x, p0y, p1x, p1y);
        return;
    }
    // Split at t = 0.5 via de Casteljau.
    const m01x = (p0x + c1x) * 0.5;
    const m01y = (p0y + c1y) * 0.5;
    const m12x = (c1x + c2x) * 0.5;
    const m12y = (c1y + c2y) * 0.5;
    const m23x = (c2x + p1x) * 0.5;
    const m23y = (c2y + p1y) * 0.5;
    const m012x = (m01x + m12x) * 0.5;
    const m012y = (m01y + m12y) * 0.5;
    const m123x = (m12x + m23x) * 0.5;
    const m123y = (m12y + m23y) * 0.5;
    const mx = (m012x + m123x) * 0.5;
    const my = (m012y + m123y) * 0.5;
    try flattenCubic(edges, allocator, p0x, p0y, m01x, m01y, m012x, m012y, mx, my, depth + 1);
    try flattenCubic(edges, allocator, mx, my, m123x, m123y, m23x, m23y, p1x, p1y, depth + 1);
}

/// walkOpcodes — single typed walker over a path's `(verbs, points)` pair.
/// Each verb advances the points cursor by `SmPath.floatCount(verb)` and
/// invokes the matching `visitor.onXxx(...)` method. The visitor holds all
/// per-walk state (current point, subpath start, etc.); errors propagate
/// from visitor methods so consumers can fail on alloc.
///
/// Replaces the previous byte-stream loop that lived in both `walkPath`
/// and `strokeWalkPath` with offset arithmetic. Visitors below: `FillVisitor`
/// (edge generation for fillPath), `StrokeVisitor` (polyline accumulation
/// for strokePath).
fn walkOpcodes(verbs: []const u8, points: []const f64, visitor: anytype) !void {
    var pi: usize = 0;
    for (verbs) |tag| {
        const op: SmPath.Opcode = @enumFromInt(tag);
        switch (op) {
            .close => try visitor.onClose(),
            .move_to => try visitor.onMoveTo(points[pi], points[pi + 1]),
            .line_to => try visitor.onLineTo(points[pi], points[pi + 1]),
            .quad_to => try visitor.onQuadTo(
                points[pi],
                points[pi + 1],
                points[pi + 2],
                points[pi + 3],
            ),
            .bezier_to => try visitor.onBezierTo(
                points[pi],
                points[pi + 1],
                points[pi + 2],
                points[pi + 3],
                points[pi + 4],
                points[pi + 5],
            ),
            .rect_path => try visitor.onRect(
                points[pi],
                points[pi + 1],
                points[pi + 2],
                points[pi + 3],
            ),
        }
        pi += SmPath.floatCount(op);
    }
}

/// FillVisitor — per-walk state for `fillPath`. Emits one Edge per line
/// segment, flattens Béziers, and synthesizes an implicit close edge on
/// subpath transitions (HTML5 spec semantics for `fill()`).
const FillVisitor = struct {
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    cur_x: f64 = 0,
    cur_y: f64 = 0,
    subpath_x: f64 = 0,
    subpath_y: f64 = 0,
    subpath_open: bool = false,

    fn onClose(self: *FillVisitor) !void {
        if (self.subpath_open) {
            try addEdge(self.edges, self.allocator, self.cur_x, self.cur_y, self.subpath_x, self.subpath_y);
            self.cur_x = self.subpath_x;
            self.cur_y = self.subpath_y;
            self.subpath_open = false;
        }
    }

    fn onMoveTo(self: *FillVisitor, x: f64, y: f64) !void {
        if (self.subpath_open) {
            try addEdge(self.edges, self.allocator, self.cur_x, self.cur_y, self.subpath_x, self.subpath_y);
        }
        self.cur_x = x;
        self.cur_y = y;
        self.subpath_x = x;
        self.subpath_y = y;
        self.subpath_open = true;
    }

    fn onLineTo(self: *FillVisitor, x: f64, y: f64) !void {
        try addEdge(self.edges, self.allocator, self.cur_x, self.cur_y, x, y);
        self.cur_x = x;
        self.cur_y = y;
    }

    fn onQuadTo(self: *FillVisitor, cpx: f64, cpy: f64, x: f64, y: f64) !void {
        try flattenQuad(self.edges, self.allocator, self.cur_x, self.cur_y, cpx, cpy, x, y, 0);
        self.cur_x = x;
        self.cur_y = y;
    }

    fn onBezierTo(self: *FillVisitor, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64) !void {
        try flattenCubic(self.edges, self.allocator, self.cur_x, self.cur_y, c1x, c1y, c2x, c2y, x, y, 0);
        self.cur_x = x;
        self.cur_y = y;
    }

    fn onRect(self: *FillVisitor, rx: f64, ry: f64, rw: f64, rh: f64) !void {
        if (self.subpath_open) {
            try addEdge(self.edges, self.allocator, self.cur_x, self.cur_y, self.subpath_x, self.subpath_y);
        }
        // 4-edge closed subpath.
        try addEdge(self.edges, self.allocator, rx, ry, rx + rw, ry);
        try addEdge(self.edges, self.allocator, rx + rw, ry, rx + rw, ry + rh);
        try addEdge(self.edges, self.allocator, rx + rw, ry + rh, rx, ry + rh);
        try addEdge(self.edges, self.allocator, rx, ry + rh, rx, ry);
        self.subpath_open = false;
        self.cur_x = rx;
        self.cur_y = ry;
    }
};

/// One edge currently overlapping the row's vertical band. The Active Edge
/// Table holds these for `[y_int, y_int+1)`; per-sub-sample `x` is recomputed
/// from `x_at_y_min + (y_sub - y_min) * inv_slope` rather than incrementally
/// advanced — keeps every sub-sample independent and avoids accumulated
/// rounding error across 8 sub-y steps per row.
const ActiveEdge = struct {
    y_min: f64,
    y_max: f64,
    x_at_y_min: f64,
    inv_slope: f64,
    dir: i8,
};

const ActiveBuf = SmList(ActiveEdge);

/// (x, dir) pair for one active edge intersected with one sub-y sample.
/// Built fresh per sub-sample, sorted by x, then walked for inside spans.
const SubEdge = struct { x: f64, dir: i8 };

const SubEdgeBuf = SmList(SubEdge);

/// Insertion sort by `x`. Optimal for small N (typically ≤ 16); active
/// edges shift by `inv_slope * (1/8)` between sub-samples so the input is
/// nearly-sorted across iterations — worst case is rare.
fn sortSubEdgesByX(xs: []SubEdge) void {
    var i: usize = 1;
    while (i < xs.len) : (i += 1) {
        const key = xs[i];
        var j: usize = i;
        while (j > 0 and xs[j - 1].x > key.x) : (j -= 1) {
            xs[j] = xs[j - 1];
        }
        xs[j] = key;
    }
}

/// Insertion sort the edge list by `y_min`. One-time cost after edge
/// generation; lets the main sweep walk a `next_idx` cursor instead of
/// re-checking every edge per scanline.
fn sortEdgesByYMin(edges: []Edge) void {
    // pdq: the flattener emits edges in path order, which is nowhere near
    // sorted by y, and the old insertion sort was O(N²) on every sweep —
    // a thousand-edge glyph paid ~250k struct moves before touching a
    // pixel. Equal y_min order is irrelevant downstream: the sub-scanline
    // walk re-sorts by x, and the analytic converter's deposits commute.
    std.sort.pdq(Edge, edges, {}, struct {
        fn lt(_: void, a: Edge, b: Edge) bool {
            return a.y_min < b.y_min;
        }
    }.lt);
}

/// flattenPathToFillEdges — populate `edges` with the line-segment edges
/// of `path`'s fill polygon. Béziers are recursively flattened. An
/// implicit close is synthesized at end-of-path. Used by `fillPath`,
/// `fillPathToCoverage`, and the hit-test helper `isPointInPath`.
pub fn flattenPathToFillEdges(
    allocator: std.mem.Allocator,
    path: *const SmPath,
    edges: *EdgeBuf,
) !void {
    if (path.verbs.len == 0) return;
    var visitor: FillVisitor = .{ .edges = edges, .allocator = allocator };
    try walkOpcodes(path.verbs.ptr[0..path.verbs.len], path.points.ptr[0..path.points.len], &visitor);
    if (visitor.subpath_open) {
        try addEdge(visitor.edges, allocator, visitor.cur_x, visitor.cur_y, visitor.subpath_x, visitor.subpath_y);
    }
}

/// pointInEdges — point-in-polygon test against a flattened edge list.
/// For `nonzero`, returns true if the signed winding of the edges crossed
/// to the left of (x, y) is non-zero. For `evenodd`, returns true if the
/// count of edges crossed is odd.
///
/// Edge inclusion rule: the half-open interval [y_min, y_max) — matches the
/// scanline rasterizer. This avoids double-counting when an edge endpoint
/// sits exactly on the query y.
pub fn pointInEdges(edges: []const Edge, x: f64, y: f64, fill_rule: FillRule) bool {
    var winding: i32 = 0;
    for (edges) |e| {
        if (y < e.y_min or y >= e.y_max) continue;
        const x_at_y = e.x_at_y_min + e.inv_slope * (y - e.y_min);
        if (x_at_y < x) winding += @as(i32, e.direction);
    }
    return windingInside(winding, fill_rule);
}

/// fillPath — main entry. Build edges from path, sweep, blit.
///
/// `aa_accum` and `cov_row` are caller-owned per-row scratch buffers,
/// each sized to at least `canvas_w`. Reused across scanlines and
/// across `fill()` / `stroke()` calls (allocated lazily on `SmCanvas`).
pub fn fillPath(
    allocator: std.mem.Allocator,
    pixels: []u32,
    canvas_w: u32,
    canvas_h: u32,
    path: *const SmPath,
    fill_rule: FillRule,
    clip: ?SmBlitter.Clip,
    paint: *const SmPaint,
    aa_accum: []f64,
    cov_row: []u8,
) !void {
    if (path.verbs.len == 0) return;
    if (canvas_w == 0 or canvas_h == 0) return;

    var edges: EdgeBuf = .{};
    defer edges.deinit(allocator);
    try flattenPathToFillEdges(allocator, path, &edges);
    try sweepFill(&edges, allocator, pixels, canvas_w, canvas_h, fill_rule, clip, paint, aa_accum, cov_row);
}

/// Pick the converter: the analytic one for antialiased fills unless the
/// paint asks for the supersampled sweep; one-sample-per-pixel fills
/// keep the sweep (its centre-in-span rule is Flash's "low" quality,
/// which no area-threshold reproduces).
fn sweepFill(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    pixels: []u32,
    canvas_w: u32,
    canvas_h: u32,
    fill_rule: FillRule,
    clip: ?SmBlitter.Clip,
    paint: *const SmPaint,
    aa_accum: []f64,
    cov_row: []u8,
) !void {
    if (paint.antialias and paint.aa_mode == .analytic) {
        const emit = struct {
            pixels: []u32,
            paint: *const SmPaint,
            clip: ?SmBlitter.Clip,
            fn run(self: @This(), canvas_w_: u32, x: i32, y: i32, cov: []const u8) void {
                SmBlitter.blitRow(self.pixels, canvas_w_, x, y, @intCast(cov.len), cov, self.paint, self.clip);
            }
        }{ .pixels = pixels, .paint = paint, .clip = clip };
        // Rows outside the clip's box are never deposited, let alone blitted.
        const y_clip: ?[2]i32 = if (clip) |c| .{ c.y0, c.y1 } else null;
        try sweepAnalytic(edges, allocator, canvas_w, canvas_h, fill_rule, aa_accum, cov_row, emit, y_clip);
    } else {
        try sweepEdges(edges, allocator, pixels, canvas_w, canvas_h, fill_rule, clip, paint, aa_accum, cov_row);
    }
}

/// fillPolygonF — fill an arbitrary simple polygon with anti-aliasing.
/// `vertices` is the closed ring; an implicit close from `vertices[n-1]`
/// to `vertices[0]` is added. Uses `.evenodd` fill rule so the caller
/// doesn't need to worry about winding direction (simple polygons fill
/// identically under either rule). Used by `SmCanvas.drawTriangle` and
/// the rotated-`drawRect` decomposition — keeps those paths AA without
/// going through the SmPath verb stream / Bézier flattener.
pub fn fillPolygonF(
    allocator: std.mem.Allocator,
    pixels: []u32,
    canvas_w: u32,
    canvas_h: u32,
    vertices: []const [2]f64,
    clip: ?SmBlitter.Clip,
    paint: *const SmPaint,
    aa_accum: []f64,
    cov_row: []u8,
) !void {
    if (vertices.len < 3) return;
    if (canvas_w == 0 or canvas_h == 0) return;
    var edges: EdgeBuf = .{};
    defer edges.deinit(allocator);
    var i: usize = 0;
    while (i < vertices.len) : (i += 1) {
        const j: usize = if (i + 1 == vertices.len) 0 else i + 1;
        try addEdge(
            &edges,
            allocator,
            vertices[i][0],
            vertices[i][1],
            vertices[j][0],
            vertices[j][1],
        );
    }
    try sweepFill(
        &edges,
        allocator,
        pixels,
        canvas_w,
        canvas_h,
        .evenodd,
        clip,
        paint,
        aa_accum,
        cov_row,
    );
}

/// fillPathToCoverage — same scan as `fillPath` but writes per-pixel u8
/// coverage into `mask` for every pixel inside the path. Used to build
/// the clip mask in `SmCanvas.clip`. Existing mask bytes are NOT touched
/// outside the painted region — caller is responsible for zero-initializing
/// if a fresh mask is wanted. Intersection with a prior mask is the
/// caller's job (see `SmCanvas.clipInternal`).
///
/// Coverage emission is AA (matches `sweepEdges`) so curved clip paths
/// produce fractional boundary coverage; the multiplicative intersection
/// in `clipInternal` and the existing `(cov * clip + 127) / 255` clip
/// combination inside `SmBlitter.blitRow` together compose AA shapes
/// correctly across AA clip boundaries.
///
/// Allocates per-row AA scratches (`aa_accum: []f64`, `cov_row: []u8`)
/// locally — clip is a save/restore-time op (rare), no need to thread
/// scratches through from `SmCanvas`.
pub fn fillPathToCoverage(
    allocator: std.mem.Allocator,
    mask: []u8,
    canvas_w: u32,
    canvas_h: u32,
    path: *const SmPath,
    fill_rule: FillRule,
    antialias: bool,
) !void {
    return fillPathToCoverageMode(allocator, mask, canvas_w, canvas_h, path, fill_rule, antialias, .analytic);
}

/// `fillPathToCoverage` with the converter chosen (the clip path has no
/// paint to carry `aa_mode`).
pub fn fillPathToCoverageMode(
    allocator: std.mem.Allocator,
    mask: []u8,
    canvas_w: u32,
    canvas_h: u32,
    path: *const SmPath,
    fill_rule: FillRule,
    antialias: bool,
    aa_mode: SmPaint.AaMode,
) !void {
    var box: RowBox = .{};
    return fillPathToCoverageBox(allocator, mask, canvas_w, canvas_h, path, fill_rule, antialias, aa_mode, &box);
}

/// The half-open bounding box of the rows and columns a coverage sweep
/// wrote non-zero bytes to; empty when x0 >= x1.
pub const RowBox = struct {
    x0: i32 = 0,
    y0: i32 = 0,
    x1: i32 = 0,
    y1: i32 = 0,

    pub inline fn isEmpty(self: RowBox) bool {
        return self.x0 >= self.x1 or self.y0 >= self.y1;
    }

    pub fn addRun(self: *RowBox, x: i32, y: i32, n: usize) void {
        const x_end = x + @as(i32, @intCast(n));
        if (self.isEmpty()) {
            self.* = .{ .x0 = x, .y0 = y, .x1 = x_end, .y1 = y + 1 };
            return;
        }
        self.x0 = @min(self.x0, x);
        self.x1 = @max(self.x1, x_end);
        self.y0 = @min(self.y0, y);
        self.y1 = @max(self.y1, y + 1);
    }

    pub fn intersect(self: RowBox, other: RowBox) RowBox {
        const r: RowBox = .{ .x0 = @max(self.x0, other.x0), .y0 = @max(self.y0, other.y0), .x1 = @min(self.x1, other.x1), .y1 = @min(self.y1, other.y1) };
        return if (r.isEmpty()) .{} else r;
    }
};

/// `fillPathToCoverageMode` that also reports the box of what it wrote.
pub fn fillPathToCoverageBox(
    allocator: std.mem.Allocator,
    mask: []u8,
    canvas_w: u32,
    canvas_h: u32,
    path: *const SmPath,
    fill_rule: FillRule,
    antialias: bool,
    aa_mode: SmPaint.AaMode,
    box: *RowBox,
) !void {
    box.* = .{};
    if (path.verbs.len == 0) return;
    if (canvas_w == 0 or canvas_h == 0) return;

    var edges: EdgeBuf = .{};
    defer edges.deinit(allocator);
    try flattenPathToFillEdges(allocator, path, &edges);

    const aa_accum = try allocator.alloc(f64, canvas_w + accum_slack);
    defer allocator.free(aa_accum);
    const cov_row = try allocator.alloc(u8, canvas_w);
    defer allocator.free(cov_row);

    if (antialias and aa_mode == .analytic) {
        const emit = struct {
            mask: []u8,
            box: *RowBox,
            fn run(self: @This(), canvas_w_: u32, x: i32, y: i32, cov: []const u8) void {
                const off = @as(usize, @intCast(y)) * @as(usize, canvas_w_) + @as(usize, @intCast(x));
                @memcpy(self.mask[off .. off + cov.len], cov);
                self.box.addRun(x, y, cov.len);
            }
        }{ .mask = mask, .box = box };
        try sweepAnalytic(&edges, allocator, canvas_w, canvas_h, fill_rule, aa_accum, cov_row, emit, null);
        return;
    }
    try sweepEdgesToCoverageMask(
        &edges,
        allocator,
        mask,
        canvas_w,
        canvas_h,
        fill_rule,
        aa_accum,
        cov_row,
        antialias,
        box,
    );
}

/// Cells the analytic accumulator needs beyond the canvas width: a
/// segment ending exactly at x = W deposits into cells W and W + 1.
pub const accum_slack: u32 = 2;

/// Number of sub-y samples per integer scanline for AA path fills.
/// 8 levels per axis combined with analytic-x partial coverage gives full
/// 256-level alpha output — the per-sub-sample contribution is a float,
/// summed without precision loss before the final u8 quantization.
const aa_sub_count: u32 = 8;
const aa_sub_weight: f32 = 1.0 / @as(f32, @floatFromInt(aa_sub_count));

/// depositSpan — accumulate fractional coverage for one sub-y horizontal
/// span `[x_lo, x_hi)` into the row's f32 accumulator at the per-sub-sample
/// `weight` (`= 1 / aa_sub_count`). Cells fully inside the span receive the
/// full weight; the leftmost / rightmost cells receive a fraction equal to
/// the analytic overlap length (analytic-x partial coverage). After all 8
/// sub-samples the accumulator holds the box-filtered pixel coverage in
/// `[0, 1]` — quantized to a u8 row before being fed to `SmBlitter.blitRow`.
/// depositSpanPoint — the ONE-SAMPLE rule: a pixel is in or out by
/// whether its CENTRE lies in the span. Flash's "low" quality rasterizes
/// this way, and a reference image taken that way has no partial pixels
/// at all — approximating it by thresholding area coverage is not the
/// same thing, because the area is itself quantized to the sub-sample
/// grid.
inline fn depositSpanPoint(accum: []f64, x_lo: f64, x_hi: f64, cw: i32) void {
    const first_f = @ceil(x_lo - 0.5);
    const last_f = @ceil(x_hi - 0.5) - 1.0;
    var i: i32 = @max(0, @as(i32, @intFromFloat(first_f)));
    const last: i32 = @min(cw - 1, @as(i32, @intFromFloat(last_f)));
    while (i <= last) : (i += 1) accum[@intCast(i)] = 1.0;
}

inline fn depositSpan(accum: []f64, x_lo: f64, x_hi: f64, weight: f32, cw: i32) void {
    const cw_f: f64 = @floatFromInt(cw);
    const x_lo_c: f64 = @max(0.0, x_lo);
    const x_hi_c: f64 = @min(cw_f, x_hi);
    if (x_hi_c <= x_lo_c) return;

    const i_first: i32 = @as(i32, @intFromFloat(@floor(x_lo_c)));
    const i_last: i32 = @as(i32, @intFromFloat(@ceil(x_hi_c))) - 1;
    if (i_first == i_last) {
        accum[@intCast(i_first)] += @as(f64, @floatCast(weight * @as(f32, @floatCast(x_hi_c - x_lo_c))));
        return;
    }
    const left_partial: f64 = @as(f64, @floatFromInt(i_first + 1)) - x_lo_c;
    accum[@intCast(i_first)] += @as(f64, @floatCast(weight * @as(f32, @floatCast(left_partial))));
    var k: i32 = i_first + 1;
    while (k < i_last) : (k += 1) {
        accum[@intCast(k)] += @as(f64, @floatCast(weight));
    }
    const right_partial: f64 = x_hi_c - @as(f64, @floatFromInt(i_last));
    accum[@intCast(i_last)] += @as(f64, @floatCast(weight * @as(f32, @floatCast(right_partial))));
}

/// sweepEdges — scanline sweep with anti-aliased per-pixel coverage.
///
/// Per integer row `y_int`:
///   1. Drop active edges whose `y_max ≤ y_top` (left the row band).
///   2. Admit edges whose `y_min < y_bot` (entered the row at any sub-y).
///   3. Zero the f32 accumulator across the row's touched x-range.
///   4. For each of `aa_sub_count` sub-y samples spaced `1 / N` apart:
///      a. Build a (x, dir) sub-list of active edges live at `y_sub`
///         (`y_min ≤ y_sub < y_max`); compute x analytically from
///         `x_at_y_min + (y_sub - y_min) * inv_slope`.
///      b. Sort by x (insertion — input is near-sorted across sub-samples).
///      c. Walk for inside spans per `fill_rule`; deposit each `[x_lo, x_hi)`
///         span into the accumulator with weight `1 / N` and analytic-x
///         partial-pixel coverage on the leftmost / rightmost cells.
///   5. Quantize the accumulator into the u8 `cov_row`; emit one
///      `SmBlitter.blitRow` per non-zero run (blitter combines per-pixel
///      coverage with the optional clip mask, then dispatches by blend mode).
///
/// Acceptance bar: SSIM vs `@napi-rs/canvas` (Skia) on every curve scene.
/// Output is intentionally NOT byte-equal to the previous binary-span path
/// — every shape with a curved or non-axis-aligned edge changes.
fn sweepEdges(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    pixels: []u32,
    canvas_w: u32,
    canvas_h: u32,
    fill_rule: FillRule,
    clip: ?SmBlitter.Clip,
    paint: *const SmPaint,
    aa_accum: []f64,
    cov_row: []u8,
) !void {
    if (edges.len == 0) return;
    if (aa_accum.len < canvas_w or cov_row.len < canvas_w) return;

    sortEdgesByYMin(edges.ptr[0..edges.len]);

    var y_min_total: f64 = std.math.inf(f64);
    var y_max_total: f64 = -std.math.inf(f64);
    for (edges.ptr[0..edges.len]) |e| {
        if (e.y_min < y_min_total) y_min_total = e.y_min;
        if (e.y_max > y_max_total) y_max_total = e.y_max;
    }

    const ch_i: i32 = @intCast(canvas_h);
    const cw_i: i32 = @intCast(canvas_w);
    const y_start: i32 = @max(0, @as(i32, @intFromFloat(@floor(y_min_total))));
    const y_end: i32 = @min(ch_i, @as(i32, @intFromFloat(@ceil(y_max_total))));
    if (y_start >= y_end) return;

    // The accumulator is cleared ONCE here and then only over the range a
    // row actually touched (tracked as row_x_min/row_x_max below). The old
    // per-row full-width memset was 17 % of a Flash frame on a Cortex-A53
    // — 4·W bytes per scanline for shapes that touch a dozen pixels.
    @memset(aa_accum[0..canvas_w], 0.0);

    var active: ActiveBuf = .{};
    defer active.deinit(allocator);
    var sub_list: SubEdgeBuf = .{};
    defer sub_list.deinit(allocator);
    var next_idx: usize = 0;

    var y_int: i32 = y_start;
    while (y_int < y_end) : (y_int += 1) {
        const y_top: f64 = @floatFromInt(y_int);
        const y_bot: f64 = y_top + 1.0;

        // 1. Drop edges fully above this row.
        var k: usize = 0;
        while (k < active.len) {
            if (active.ptr[k].y_max <= y_top) {
                active.ptr[k] = active.ptr[active.len - 1];
                active.len -= 1;
            } else {
                k += 1;
            }
        }

        // 2. Admit edges that touch this row at any sub-y. Edges are sorted
        // by y_min, so once an edge fails the `y_min < y_bot` gate, all
        // later edges also fail.
        while (next_idx < edges.len and edges.ptr[next_idx].y_min < y_bot) {
            const e = edges.ptr[next_idx];
            try active.append(allocator, .{
                .y_min = e.y_min,
                .y_max = e.y_max,
                .x_at_y_min = e.x_at_y_min,
                .inv_slope = e.inv_slope,
                .dir = e.direction,
            });
            next_idx += 1;
        }

        if (active.len < 2) continue;

        // 3. The accumulator is already zero (entry clear + the range clear
        // at the end of every row). The cov_row is written only inside
        // non-zero runs below, so it needs no pre-zeroing either — the
        // blitter only reads the slice we hand it.
        var row_x_min: i32 = cw_i;
        var row_x_max: i32 = 0;

        // 4. Sub-y supersample sweep.
        const sub_count: u32 = if (paint.antialias) aa_sub_count else 1;
        var s: u32 = 0;
        while (s < sub_count) : (s += 1) {
            const y_sub: f64 = if (paint.antialias)
                y_top + (@as(f64, @floatFromInt(s)) + 0.5) / @as(f64, @floatFromInt(aa_sub_count))
            else
                y_top + 0.5;

            // Build (x, dir) list of edges live at this sub-y.
            sub_list.len = 0;
            for (active.ptr[0..active.len]) |a| {
                if (y_sub < a.y_min or y_sub >= a.y_max) continue;
                const x: f64 = a.x_at_y_min + (y_sub - a.y_min) * a.inv_slope;
                try sub_list.append(allocator, .{ .x = x, .dir = a.dir });
            }
            if (sub_list.len < 2) continue;
            sortSubEdgesByX(sub_list.ptr[0..sub_list.len]);

            // Walk for inside spans, deposit fractional coverage.
            var winding: i32 = 0;
            var span_lo: f64 = 0;
            for (sub_list.ptr[0..sub_list.len]) |se| {
                const prev_inside = windingInside(winding, fill_rule);
                winding += se.dir;
                const new_inside = windingInside(winding, fill_rule);
                if (!prev_inside and new_inside) {
                    span_lo = se.x;
                } else if (prev_inside and !new_inside) {
                    if (paint.antialias)
                        depositSpan(aa_accum, span_lo, se.x, aa_sub_weight, cw_i)
                    else
                        depositSpanPoint(aa_accum, span_lo, se.x, cw_i);
                    const lo_i: i32 = @max(0, @as(i32, @intFromFloat(@floor(span_lo))));
                    const hi_i: i32 = @min(cw_i, @as(i32, @intFromFloat(@ceil(se.x))));
                    if (lo_i < row_x_min) row_x_min = lo_i;
                    if (hi_i > row_x_max) row_x_max = hi_i;
                }
            }
        }

        // 5. Sparse-scan accumulator and emit blits per non-zero run.
        if (row_x_min >= row_x_max) continue;
        var x: i32 = row_x_min;
        while (x < row_x_max) {
            // Skip leading cells that round to coverage 0.
            while (x < row_x_max and aa_accum[@intCast(x)] * 256.0 < 1.0) : (x += 1) {}
            if (x >= row_x_max) break;
            const run_start = x;
            while (x < row_x_max and aa_accum[@intCast(x)] * 256.0 >= 1.0) : (x += 1) {
                const v = aa_accum[@intCast(x)] * 256.0;
                if (!paint.antialias) {
                    cov_row[@intCast(x)] = if (v >= 128.0) 255 else 0;
                    continue;
                }
                cov_row[@intCast(x)] = if (v >= 255.0) 255 else @intFromFloat(v);
            }
            const n: u32 = @intCast(x - run_start);
            SmBlitter.blitRow(
                pixels,
                canvas_w,
                run_start,
                y_int,
                n,
                cov_row[@intCast(run_start)..@intCast(x)],
                paint,
                clip,
            );
        }
        // 6. Clear only what this row touched: every deposit lands inside
        // [row_x_min, row_x_max) (depositSpan clamps to the same bounds the
        // range is built from), so the rest of the row is still zero.
        @memset(aa_accum[@intCast(row_x_min)..@intCast(row_x_max)], 0.0);
    }
}

// ---------------------------------------------------------------------------
// Analytic coverage (signed area accumulation).
// ---------------------------------------------------------------------------
//
// The exact area of the path inside each pixel, per row, from one pass
// over the active edges: each edge's segment within the row deposits its
// signed height ("cover", direction × dy) into the cells it crosses,
// split by the area the segment cuts off inside each cell, and a prefix
// sum across the row turns those deltas into the winding integral per
// cell. Nonzero coverage is min(1, |sum|); even-odd folds the sum onto a
// triangle wave. There is no sub-scanline, no per-sub-sample sort and no
// cost proportional to the fill area × 8: the work is the outline length
// plus one linear pass over the touched span. The accumulation is the
// one in font-rs (Raph Levien) and stb_truetype's v2 rasterizer.
//
// Edges are clipped to the canvas horizontally BEFORE the sweep: a piece
// left of x = 0 becomes a vertical edge at 0 (its cover applies to the
// whole row), a piece right of x = W a vertical at W (cells beyond the
// canvas, never read), so every deposit lands in [0, W + 1].
//
// The result is not byte-equal to the supersampled sweep: that one
// quantized the vertical position to eighths, this one does not. The
// test below measures the difference over seeded paths and pins it.

/// Deposit one row segment into the accumulator. `xa`, `xb` are the
/// segment's x at the row's entry and exit (either order, clamped to
/// [0, W]); `d` is direction × the segment's height within the row.
inline fn depositSegment(acc: []f64, xa: f64, xb: f64, d: f64) void {
    // All in f64: every quantity here is a difference or a fraction of
    // positions, which shifting the geometry by whole pixels leaves
    // bit-identical — so a shape swept in its own space deposits the
    // same numbers as the same shape swept in place (see sweepToSpans).
    // The old f32 arithmetic cast the absolute positions first, and a
    // position near 100 sits on a coarser f32 grid than one near 10.
    const x0 = @min(xa, xb);
    const x1 = @max(xa, xb);
    const x0floor = @floor(x0);
    const x0i: usize = @intFromFloat(x0floor);
    const x1ceil = @ceil(x1);
    const x1i: usize = @intFromFloat(x1ceil);
    if (x1i <= x0i + 1) {
        // Within one cell: the area right of the segment is the mean x.
        const xmf = 0.5 * (xa + xb) - x0floor;
        acc[x0i] += d - d * xmf;
        acc[x0i + 1] += d * xmf;
        return;
    }
    const s = 1.0 / (x1 - x0);
    const x0f = x0 - x0floor;
    const a0 = 0.5 * s * (1.0 - x0f) * (1.0 - x0f);
    const x1f = x1 - x1ceil + 1.0;
    const am = 0.5 * s * x1f * x1f;
    acc[x0i] += d * a0;
    if (x1i == x0i + 2) {
        acc[x0i + 1] += d * (1.0 - a0 - am);
    } else {
        const a1 = s * (1.5 - x0f);
        acc[x0i + 1] += d * (a1 - a0);
        var xi = x0i + 2;
        while (xi < x1i - 1) : (xi += 1) acc[xi] += d * s;
        const a2 = a1 + @as(f64, @floatFromInt(x1i - x0i - 3)) * s;
        acc[x1i - 1] += d * (1.0 - a2 - am);
    }
    acc[x1i] += d * am;
}

/// Split every edge at x = 0 and x = W and clamp the outside pieces to
/// verticals on the boundary (see the section comment).
fn clipEdgesToWidth(edges: *const EdgeBuf, allocator: std.mem.Allocator, out: *EdgeBuf, w: f64) !void {
    for (edges.ptr[0..edges.len]) |e| {
        var y_lo = e.y_min;
        const y_hi = e.y_max;
        var x_lo = e.x_at_y_min;
        const x_hi = e.x_at_y_min + (y_hi - y_lo) * e.inv_slope;
        // Up to two crossings; walk them in y order.
        var crossings: [2]f64 = undefined;
        var n: usize = 0;
        inline for (.{ 0.0, w }) |bx| {
            if ((x_lo < bx and x_hi > bx) or (x_lo > bx and x_hi < bx)) {
                crossings[n] = e.y_min + (bx - e.x_at_y_min) / e.inv_slope;
                n += 1;
            }
        }
        if (n == 2 and crossings[0] > crossings[1]) std.mem.swap(f64, &crossings[0], &crossings[1]);
        var k: usize = 0;
        while (true) {
            const y_cut = if (k < n) crossings[k] else y_hi;
            if (y_cut > y_lo) {
                const x_cut = e.x_at_y_min + (y_cut - e.y_min) * e.inv_slope;
                const mid = 0.5 * (x_lo + x_cut);
                var piece: Edge = .{ .y_min = y_lo, .y_max = y_cut, .x_at_y_min = x_lo, .inv_slope = e.inv_slope, .direction = e.direction };
                if (mid <= 0.0) {
                    piece.x_at_y_min = 0.0;
                    piece.inv_slope = 0.0;
                } else if (mid >= w) {
                    piece.x_at_y_min = w;
                    piece.inv_slope = 0.0;
                }
                try out.append(allocator, piece);
                y_lo = y_cut;
                x_lo = x_cut;
            }
            if (k >= n) break;
            k += 1;
        }
    }
}

/// The analytic converter. `emit.run(canvas_w, x, y, cov)` receives every
/// run of non-zero coverage bytes (the blitter for fills, the mask for
/// clips). `aa_accum` must have `canvas_w + accum_slack` cells.
/// The cells one segment's deposit touched, [lo, hi).
const CellIv = struct { lo: i32, hi: i32 };
const IvBuf = SmList(CellIv);

/// Insertion sort by `lo`: a row has a handful of segments.
fn sortIntervals(ivs: []CellIv) void {
    var i: usize = 1;
    while (i < ivs.len) : (i += 1) {
        const v = ivs[i];
        var j = i;
        while (j > 0 and ivs[j - 1].lo > v.lo) : (j -= 1) ivs[j] = ivs[j - 1];
        ivs[j] = v;
    }
}

/// The coverage of a prefix sum under the fill rule, quantized as the
/// walk always did: the sum in f64, the rule in f32.
inline fn coverageOf(sum: f64, fill_rule: FillRule) f32 {
    const sum32: f32 = @floatCast(sum);
    if (fill_rule == .nonzero) return @min(1.0, @abs(sum32));
    var t = @abs(sum32);
    t -= 2.0 * @floor(t * 0.5);
    return if (t > 1.0) 2.0 - t else t;
}

fn sweepAnalytic(
    edges_in: *EdgeBuf,
    allocator: std.mem.Allocator,
    canvas_w: u32,
    canvas_h: u32,
    fill_rule: FillRule,
    aa_accum: []f64,
    cov_row: []u8,
    emit: anytype,
    y_clip: ?[2]i32,
) !void {
    if (edges_in.len == 0) return;
    if (aa_accum.len < canvas_w + accum_slack or cov_row.len < canvas_w) return;

    var edges: EdgeBuf = .{};
    defer edges.deinit(allocator);
    try clipEdgesToWidth(edges_in, allocator, &edges, @floatFromInt(canvas_w));
    if (edges.len == 0) return;
    sortEdgesByYMin(edges.ptr[0..edges.len]);

    var y_min_total: f64 = std.math.inf(f64);
    var y_max_total: f64 = -std.math.inf(f64);
    for (edges.ptr[0..edges.len]) |e| {
        if (e.y_min < y_min_total) y_min_total = e.y_min;
        if (e.y_max > y_max_total) y_max_total = e.y_max;
    }
    const ch_i: i32 = @intCast(canvas_h);
    const cw_i: i32 = @intCast(canvas_w);
    var y_start: i32 = @max(0, @as(i32, @intFromFloat(@floor(y_min_total))));
    var y_end: i32 = @min(ch_i, @as(i32, @intFromFloat(@ceil(y_max_total))));
    if (y_clip) |yc| {
        // Edges that end above y_start are admitted and deposit nothing
        // (their row segment is empty), so clamping is safe.
        y_start = @max(y_start, yc[0]);
        y_end = @min(y_end, yc[1]);
    }
    if (y_start >= y_end) return;

    const acc = aa_accum[0 .. canvas_w + accum_slack];
    @memset(acc, 0.0);
    const w_f: f64 = @floatFromInt(canvas_w);

    var active: ActiveBuf = .{};
    defer active.deinit(allocator);
    var ivs: IvBuf = .{};
    defer ivs.deinit(allocator);
    var next_idx: usize = 0;

    var y_int: i32 = y_start;
    while (y_int < y_end) : (y_int += 1) {
        const y_top: f64 = @floatFromInt(y_int);
        const y_bot: f64 = y_top + 1.0;

        var k: usize = 0;
        while (k < active.len) {
            if (active.ptr[k].y_max <= y_top) {
                active.ptr[k] = active.ptr[active.len - 1];
                active.len -= 1;
            } else {
                k += 1;
            }
        }
        while (next_idx < edges.len and edges.ptr[next_idx].y_min < y_bot) {
            const e = edges.ptr[next_idx];
            try active.append(allocator, .{
                .y_min = e.y_min,
                .y_max = e.y_max,
                .x_at_y_min = e.x_at_y_min,
                .inv_slope = e.inv_slope,
                .dir = e.direction,
            });
            next_idx += 1;
        }
        if (active.len < 2) continue;

        // Deposit every active edge's segment within this row, noting
        // the cells each one touched.
        var row_x_min: i32 = cw_i + @as(i32, accum_slack);
        var row_x_max: i32 = 0;
        ivs.len = 0;
        for (active.ptr[0..active.len]) |a| {
            const ya = @max(y_top, a.y_min);
            const yb = @min(y_bot, a.y_max);
            if (yb <= ya) continue;
            const xa64 = @min(w_f, @max(0.0, a.x_at_y_min + (ya - a.y_min) * a.inv_slope));
            const xb64 = @min(w_f, @max(0.0, a.x_at_y_min + (yb - a.y_min) * a.inv_slope));
            const d: f64 = @as(f64, @floatFromInt(a.dir)) * (yb - ya);
            depositSegment(acc, xa64, xb64, d);
            const lo_i: i32 = @intFromFloat(@floor(@min(xa64, xb64)));
            const hi_i: i32 = @as(i32, @intFromFloat(@ceil(@max(xa64, xb64)))) + 2;
            if (lo_i < row_x_min) row_x_min = lo_i;
            if (hi_i > row_x_max) row_x_max = hi_i;
            try ivs.append(allocator, .{ .lo = lo_i, .hi = hi_i });
        }
        if (row_x_min >= row_x_max) continue;
        row_x_max = @min(row_x_max, cw_i + @as(i32, accum_slack));

        // Prefix sum → coverage → u8, emitting each non-zero run. The sum
        // is zero left of row_x_min (nothing deposited there) and the
        // visible cells end at W.
        const x_end: i32 = @min(row_x_max, cw_i);
        // The sum runs in f64 so that the order the segments were
        // deposited in, and the cell the walk starts from, cannot move
        // a coverage byte: the same shape swept at another offset (see
        // sweepToSpans) quantizes to the same bytes. The quantization
        // itself stays in f32, as it always was.
        //
        // Only the cells a segment touched are walked; between two
        // touched intervals nothing was deposited, the sum is what it
        // was, and every cell there takes the same byte — the interior
        // of a wide fill is a memset, not a walk. The bytes and the run
        // boundaries are exactly the walk's.
        sortIntervals(ivs.ptr[0..ivs.len]);
        var sum: f64 = 0.0;
        var x: i32 = row_x_min;
        var run_start: i32 = -1;
        var iv_i: usize = 0;
        while (x < x_end) {
            // The next touched interval at or past x, merged with the
            // ones overlapping it.
            while (iv_i < ivs.len and ivs.ptr[iv_i].hi <= x) iv_i += 1;
            var seg_lo: i32 = x_end;
            var seg_hi: i32 = x_end;
            if (iv_i < ivs.len) {
                seg_lo = @max(x, ivs.ptr[iv_i].lo);
                seg_hi = ivs.ptr[iv_i].hi;
                var m_i = iv_i + 1;
                while (m_i < ivs.len and ivs.ptr[m_i].lo <= seg_hi) : (m_i += 1) seg_hi = @max(seg_hi, ivs.ptr[m_i].hi);
                iv_i = m_i;
            }
            seg_lo = @min(seg_lo, x_end);
            seg_hi = @min(seg_hi, x_end);
            if (seg_lo > x) {
                // Gap [x, seg_lo): constant coverage.
                const cov = coverageOf(sum, fill_rule);
                const v = cov * 256.0;
                if (v < 1.0) {
                    if (run_start >= 0) {
                        emit.run(canvas_w, run_start, y_int, cov_row[@intCast(run_start)..@intCast(x)]);
                        run_start = -1;
                    }
                } else {
                    if (run_start < 0) run_start = x;
                    const byte: u8 = if (v >= 255.0) 255 else @intFromFloat(v);
                    @memset(cov_row[@intCast(x)..@intCast(seg_lo)], byte);
                }
                x = seg_lo;
            }
            while (x < seg_hi) : (x += 1) {
                sum += acc[@intCast(x)];
                const cov = coverageOf(sum, fill_rule);
                const v = cov * 256.0;
                if (v < 1.0) {
                    if (run_start >= 0) {
                        emit.run(canvas_w, run_start, y_int, cov_row[@intCast(run_start)..@intCast(x)]);
                        run_start = -1;
                    }
                    continue;
                }
                if (run_start < 0) run_start = x;
                cov_row[@intCast(x)] = if (v >= 255.0) 255 else @intFromFloat(v);
            }
        }
        if (run_start >= 0) emit.run(canvas_w, run_start, y_int, cov_row[@intCast(run_start)..@intCast(x_end)]);
        // Clear only the cells the deposits touched: a wide fill's row
        // is a few cells at each edge, not the whole width (the clear
        // of the whole range was the largest memset in a Flash frame).
        for (ivs.ptr[0..ivs.len]) |iv| {
            const lo: usize = @intCast(@max(iv.lo, 0));
            const hi: usize = @intCast(@min(iv.hi, row_x_max));
            if (lo < hi) @memset(acc[lo..hi], 0.0);
        }
    }
}

/// AA scanline sweep that writes per-pixel u8 coverage into `mask`.
/// Structurally identical to `sweepEdges`: 8× sub-y supersample +
/// analytic-x partial coverage → quantize to u8 → emit. The only
/// difference is the per-row emit step writes the cov_row into the
/// canvas-wide mask buffer instead of calling `SmBlitter.blitRow`.
///
/// AA boundary cells in the mask combine multiplicatively with the AA
/// shape coverage inside `SmBlitter.blitRow` (`(cov * clip + 127) / 255`)
/// — already wired, no further blitter changes needed.
fn sweepEdgesToCoverageMask(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    mask: []u8,
    canvas_w: u32,
    canvas_h: u32,
    fill_rule: FillRule,
    aa_accum: []f64,
    cov_row: []u8,
    antialias: bool,
    box: *RowBox,
) !void {
    if (edges.len == 0) return;
    if (aa_accum.len < canvas_w or cov_row.len < canvas_w) return;

    sortEdgesByYMin(edges.ptr[0..edges.len]);

    var y_min_total: f64 = std.math.inf(f64);
    var y_max_total: f64 = -std.math.inf(f64);
    for (edges.ptr[0..edges.len]) |e| {
        if (e.y_min < y_min_total) y_min_total = e.y_min;
        if (e.y_max > y_max_total) y_max_total = e.y_max;
    }

    const ch_i: i32 = @intCast(canvas_h);
    const cw_i: i32 = @intCast(canvas_w);
    const y_start: i32 = @max(0, @as(i32, @intFromFloat(@floor(y_min_total))));
    const y_end: i32 = @min(ch_i, @as(i32, @intFromFloat(@ceil(y_max_total))));
    if (y_start >= y_end) return;

    // Cleared once, then only over each row's touched range (see sweepEdges).
    @memset(aa_accum[0..canvas_w], 0.0);

    var active: ActiveBuf = .{};
    defer active.deinit(allocator);
    var sub_list: SubEdgeBuf = .{};
    defer sub_list.deinit(allocator);
    var next_idx: usize = 0;

    var y_int: i32 = y_start;
    while (y_int < y_end) : (y_int += 1) {
        const y_top: f64 = @floatFromInt(y_int);
        const y_bot: f64 = y_top + 1.0;

        // 1. Drop edges fully above this row.
        var k: usize = 0;
        while (k < active.len) {
            if (active.ptr[k].y_max <= y_top) {
                active.ptr[k] = active.ptr[active.len - 1];
                active.len -= 1;
            } else {
                k += 1;
            }
        }

        // 2. Admit edges that touch this row at any sub-y.
        while (next_idx < edges.len and edges.ptr[next_idx].y_min < y_bot) {
            const e = edges.ptr[next_idx];
            try active.append(allocator, .{
                .y_min = e.y_min,
                .y_max = e.y_max,
                .x_at_y_min = e.x_at_y_min,
                .inv_slope = e.inv_slope,
                .dir = e.direction,
            });
            next_idx += 1;
        }

        if (active.len < 2) continue;

        var row_x_min: i32 = cw_i;
        var row_x_max: i32 = 0;

        // 3. Sub-y supersample sweep.
        var s: u32 = 0;
        while (s < aa_sub_count) : (s += 1) {
            const y_sub: f64 = y_top + (@as(f64, @floatFromInt(s)) + 0.5) /
                @as(f64, @floatFromInt(aa_sub_count));

            sub_list.len = 0;
            for (active.ptr[0..active.len]) |a| {
                if (y_sub < a.y_min or y_sub >= a.y_max) continue;
                const x: f64 = a.x_at_y_min + (y_sub - a.y_min) * a.inv_slope;
                try sub_list.append(allocator, .{ .x = x, .dir = a.dir });
            }
            if (sub_list.len < 2) continue;
            sortSubEdgesByX(sub_list.ptr[0..sub_list.len]);

            var winding: i32 = 0;
            var span_lo: f64 = 0;
            for (sub_list.ptr[0..sub_list.len]) |se| {
                const prev_inside = windingInside(winding, fill_rule);
                winding += se.dir;
                const new_inside = windingInside(winding, fill_rule);
                if (!prev_inside and new_inside) {
                    span_lo = se.x;
                } else if (prev_inside and !new_inside) {
                    depositSpan(aa_accum, span_lo, se.x, aa_sub_weight, cw_i);
                    const lo_i: i32 = @max(0, @as(i32, @intFromFloat(@floor(span_lo))));
                    const hi_i: i32 = @min(cw_i, @as(i32, @intFromFloat(@ceil(se.x))));
                    if (lo_i < row_x_min) row_x_min = lo_i;
                    if (hi_i > row_x_max) row_x_max = hi_i;
                }
            }
        }

        // 4. Quantize accumulator → mask row.
        if (row_x_min >= row_x_max) continue;
        box.addRun(row_x_min, y_int, @intCast(row_x_max - row_x_min));
        const row_off: usize = @as(usize, @intCast(y_int)) * @as(usize, canvas_w);
        var x: i32 = row_x_min;
        while (x < row_x_max) : (x += 1) {
            const v = aa_accum[@intCast(x)] * 256.0;
            const cov_byte: u8 = if (v >= 255.0) 255 else if (v <= 0.0) 0 else @intFromFloat(v);
            mask[row_off + @as(usize, @intCast(x))] = if (antialias)
                cov_byte
            else if (cov_byte >= 128) 255 else 0;
        }
        @memset(aa_accum[@intCast(row_x_min)..@intCast(row_x_max)], 0.0);
    }
}

// ---------------------------------------------------------------------------
// Path stroke (T7) — inflate path to outline polygon, fill via sweepEdges.
// ---------------------------------------------------------------------------
//
// Algorithm (Skia-style polygon inflation):
//   1. Walk path opcodes, building one polyline at a time. Béziers flatten
//      to line points via `flattenQuadPoints` / `flattenCubicPoints`.
//   2. For each polyline, compute per-vertex perpendicular offsets at
//      ±half_w to get "left" and "right" outline points.
//   3. At interior vertices, miter-join: bisector of the two segment normals.
//      If miter would exceed `miter_limit`, fall back to bevel.
//   4. At endpoints of an OPEN polyline, emit butt caps (perpendicular line
//      across the segment direction).
//   5. Emit edges of the outline polygon (left side forward, right side
//      backward, plus caps for open polylines).
//   6. Reuse `sweepEdges` to fill the outline polygon.
//
// All HTML5 caps/joins are now wired (butt/round/square × miter/bevel/round)
// — extension points described above are filled. Same Blitter pipeline; the
// different shapes show up purely as different outline-construction edges.

/// 2D point/vector. Used inside the stroke inflation only — public-facing
/// path coords stay as paired f64 args per the existing convention.
const Vec2 = struct { x: f64, y: f64 };

inline fn v2sub(a: Vec2, b: Vec2) Vec2 {
    return .{ .x = a.x - b.x, .y = a.y - b.y };
}
inline fn v2add(a: Vec2, b: Vec2) Vec2 {
    return .{ .x = a.x + b.x, .y = a.y + b.y };
}
inline fn v2scale(a: Vec2, s: f64) Vec2 {
    return .{ .x = a.x * s, .y = a.y * s };
}
/// Perpendicular (rotated 90° CCW): (x, y) → (-y, x).
inline fn v2perp(a: Vec2) Vec2 {
    return .{ .x = -a.y, .y = a.x };
}
inline fn v2lenSq(a: Vec2) f64 {
    return a.x * a.x + a.y * a.y;
}
inline fn v2normalize(a: Vec2) Vec2 {
    const l_sq = v2lenSq(a);
    if (l_sq < 1e-18) return .{ .x = 0, .y = 0 };
    const inv = 1.0 / @sqrt(l_sq);
    return .{ .x = a.x * inv, .y = a.y * inv };
}

const PointBuf = SmList(Vec2);

/// Recursively flatten a quadratic Bézier into line-endpoint Vec2s.
/// Appends only the chord ENDPOINTS (the starting point is already in
/// `pts`), to match how lineTo accumulates.
fn flattenQuadPoints(
    pts: *PointBuf,
    allocator: std.mem.Allocator,
    p0x: f64,
    p0y: f64,
    cpx: f64,
    cpy: f64,
    p1x: f64,
    p1y: f64,
    depth: u32,
) !void {
    if (depth >= 16 or isQuadFlat(p0x, p0y, cpx, cpy, p1x, p1y)) {
        try pts.append(allocator, .{ .x = p1x, .y = p1y });
        return;
    }
    const m1x = (p0x + cpx) * 0.5;
    const m1y = (p0y + cpy) * 0.5;
    const m2x = (cpx + p1x) * 0.5;
    const m2y = (cpy + p1y) * 0.5;
    const mx = (m1x + m2x) * 0.5;
    const my = (m1y + m2y) * 0.5;
    try flattenQuadPoints(pts, allocator, p0x, p0y, m1x, m1y, mx, my, depth + 1);
    try flattenQuadPoints(pts, allocator, mx, my, m2x, m2y, p1x, p1y, depth + 1);
}

fn flattenCubicPoints(
    pts: *PointBuf,
    allocator: std.mem.Allocator,
    p0x: f64,
    p0y: f64,
    c1x: f64,
    c1y: f64,
    c2x: f64,
    c2y: f64,
    p1x: f64,
    p1y: f64,
    depth: u32,
) !void {
    if (depth >= 18 or isCubicFlat(p0x, p0y, c1x, c1y, c2x, c2y, p1x, p1y)) {
        try pts.append(allocator, .{ .x = p1x, .y = p1y });
        return;
    }
    const m01x = (p0x + c1x) * 0.5;
    const m01y = (p0y + c1y) * 0.5;
    const m12x = (c1x + c2x) * 0.5;
    const m12y = (c1y + c2y) * 0.5;
    const m23x = (c2x + p1x) * 0.5;
    const m23y = (c2y + p1y) * 0.5;
    const m012x = (m01x + m12x) * 0.5;
    const m012y = (m01y + m12y) * 0.5;
    const m123x = (m12x + m23x) * 0.5;
    const m123y = (m12y + m23y) * 0.5;
    const mx = (m012x + m123x) * 0.5;
    const my = (m012y + m123y) * 0.5;
    try flattenCubicPoints(pts, allocator, p0x, p0y, m01x, m01y, m012x, m012y, mx, my, depth + 1);
    try flattenCubicPoints(pts, allocator, mx, my, m123x, m123y, m23x, m23y, p1x, p1y, depth + 1);
}

/// Append intermediate fan points along an arc of radius `half_w` around
/// `center`, from `start_off` to `end_off`. `sweep_sign` is +1 for CCW
/// (increasing angle), -1 for CW (decreasing angle). The endpoint vectors
/// must already have magnitude `half_w`. Endpoints themselves are NOT
/// appended — the caller is responsible for those, this just fills the arc
/// interior so consecutive-edge emission produces the fan.
fn emitArcFan(
    out: *PointBuf,
    allocator: std.mem.Allocator,
    center: Vec2,
    start_off: Vec2,
    end_off: Vec2,
    half_w: f64,
    sweep_sign: f64,
) !void {
    const two_pi: f64 = 2.0 * std.math.pi;
    const start_angle = std.math.atan2(start_off.y, start_off.x);
    const end_angle = std.math.atan2(end_off.y, end_off.x);
    var sweep = end_angle - start_angle;
    if (sweep_sign > 0) {
        while (sweep < 0) sweep += two_pi;
        if (sweep > two_pi - 1e-12) sweep -= two_pi;
    } else {
        while (sweep > 0) sweep -= two_pi;
        if (sweep < -two_pi + 1e-12) sweep += two_pi;
    }
    if (@abs(sweep) < 1e-9) return;
    const n = SmPath.arcSegmentCount(half_w, sweep);
    if (n <= 1) return;
    var i: u32 = 1;
    while (i < n) : (i += 1) {
        const t = @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(n));
        const ang = start_angle + sweep * t;
        try out.append(allocator, .{
            .x = center.x + half_w * @cos(ang),
            .y = center.y + half_w * @sin(ang),
        });
    }
}

/// Inflate one polyline (sequence of points) to its stroke outline polygon
/// edges. `closed=true` means wrap-around (last vertex joins first via the
/// configured `line_join`, no caps). `closed=false` adds caps per
/// `line_cap` at the endpoints.
///
/// Outline construction strategy:
///   • Walk vertices forward, appending per-vertex offset points to two
///     parallel buffers `left_pts` (CCW perpendicular) and `right_pts` (CW).
///     A miter join contributes one point to each; a bevel/round join
///     contributes two (or many, for round) points to the outer side and
///     one to the inner.
///   • For OPEN polylines, weld the two strands at the endpoints with the
///     configured `line_cap` (butt = single edge, square = +half_w
///     extension along the segment direction, round = arc fan).
///   • For CLOSED polylines, emit the left and right strands as two
///     separately-closed loops with opposite winding — non-zero fill rule
///     paints the donut and leaves the hole empty.
fn strokePolyline(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    pts_in: []const Vec2,
    half_w: f64,
    miter_limit: f64,
    line_cap: SmPaint.LineCap,
    line_join: SmPaint.LineJoin,
    closed: bool,
) !void {
    if (pts_in.len < 2 or half_w <= 0) return;

    // A zero-length segment has no direction, and a join against one has
    // no angle: the miter math ran away with it (a hairline on a Flash
    // morph shape reached 45 px past its geometry). Repeated points are
    // dropped first — lyon, Ruffle's stroker, does the same — so every
    // join sees two real directions and the miter limit means what it
    // says. A closed ring that ends where it starts loses the duplicate.
    var kept: PointBuf = .{};
    defer kept.deinit(allocator);
    for (pts_in) |p| {
        if (kept.len > 0 and v2lenSq(v2sub(p, kept.ptr[kept.len - 1])) < 1e-12) continue;
        try kept.append(allocator, p);
    }
    if (closed and kept.len > 1 and v2lenSq(v2sub(kept.ptr[0], kept.ptr[kept.len - 1])) < 1e-12) kept.len -= 1;
    const pts: []const Vec2 = kept.ptr[0..kept.len];
    if (pts.len < 2) return;
    const n = pts.len;

    // Threshold on (1 + cos θ) below which we bevel instead of miter.
    // miter_length / half_w = 1 / cos(θ/2). Bound to miter_limit:
    //   1/cos(θ/2) ≤ miter_limit  ⟹  2·cos²(θ/2) ≥ 2/miter_limit²
    //   ⟹  1 + cos θ ≥ 2/miter_limit².
    const miter_threshold: f64 = 2.0 / (miter_limit * miter_limit);

    var left_pts: PointBuf = .{};
    defer left_pts.deinit(allocator);
    var right_pts: PointBuf = .{};
    defer right_pts.deinit(allocator);

    // Cached for square/round end-caps below — the segment directions at the
    // first and last vertices of an OPEN polyline.
    var first_d_next: Vec2 = .{ .x = 1, .y = 0 };
    var last_d_prev: Vec2 = .{ .x = 1, .y = 0 };

    for (0..n) |i| {
        const has_prev = i > 0 or closed;
        const has_next = i < n - 1 or closed;

        var d_prev: ?Vec2 = null;
        var np_off: ?Vec2 = null;
        var d_next: ?Vec2 = null;
        var nn_off: ?Vec2 = null;

        if (has_prev) {
            const idx_prev: usize = if (i == 0) n - 1 else i - 1;
            const dir = v2normalize(v2sub(pts[i], pts[idx_prev]));
            d_prev = dir;
            np_off = v2scale(v2perp(dir), half_w);
            if (i == n - 1 and !closed) last_d_prev = dir;
        }
        if (has_next) {
            const idx_next: usize = if (i == n - 1) 0 else i + 1;
            const dir = v2normalize(v2sub(pts[idx_next], pts[i]));
            d_next = dir;
            nn_off = v2scale(v2perp(dir), half_w);
            if (i == 0 and !closed) first_d_next = dir;
        }

        if (np_off != null and nn_off != null) {
            // Interior vertex.
            const np = np_off.?;
            const nn = nn_off.?;
            const dp = d_prev.?;
            const dn = d_next.?;
            const cos_theta = dp.x * dn.x + dp.y * dn.y;
            const denom = 1.0 + cos_theta;
            // Cross product of segment directions tells turn direction.
            //   cross > 0 → CCW turn → outer corner is on the +perp ('left') side.
            //   cross < 0 → CW turn  → outer corner is on the -perp ('right') side.
            const cross = dp.x * dn.y - dp.y * dn.x;

            const use_miter = (line_join == .miter) and (denom > miter_threshold);

            if (use_miter or denom < 1e-9 or @abs(cross) < 1e-9) {
                // Single-point miter on both sides — covers smooth interior
                // vertices and the "miter is fine" join case. Also used as
                // safe fallback for nearly-collinear / degenerate corners.
                const safe_denom = if (denom > 1e-9) denom else 1.0;
                const sum = v2add(np, nn);
                const miter = v2scale(sum, 1.0 / safe_denom);
                try left_pts.append(allocator, v2add(pts[i], miter));
                try right_pts.append(allocator, v2add(pts[i], v2scale(miter, -1)));
            } else {
                // Bevel or round join: the OUTER side gets two outline
                // points (entrance + exit perpendicular), with an arc fan
                // filling the gap for round. The INNER side keeps a single
                // miter point so the outline polygon stays simple — but
                // only while that point lies on both adjacent segments.
                // The inner offset lines meet at the miter tip, half_w /
                // cos(θ/2) from the vertex; when a segment is shorter than
                // that (a curve flattened into short pieces, or a path
                // folding back on itself, where the tip runs to infinity)
                // the tip pokes past the outer strand and the nonzero rule
                // paints the excursion as a spike. Skia's stroker pivots
                // the inner side through the vertex in that case; so do we.
                const safe_denom = if (denom > 1e-9) denom else 1e-9;
                const sum = v2add(np, nn);
                const miter = v2scale(sum, 1.0 / safe_denom);
                const idx_prev: usize = if (i == 0) n - 1 else i - 1;
                const idx_next: usize = if (i == n - 1) 0 else i + 1;
                const seg_min_sq = @min(v2lenSq(v2sub(pts[i], pts[idx_prev])), v2lenSq(v2sub(pts[idx_next], pts[i])));
                const inner_pivot = v2lenSq(miter) > seg_min_sq;

                // Which side is OUTER follows the turn: with
                // `perp(d) = (-d.y, d.x)`, the +perp ('left') side is the
                // outer one when the cross product is NEGATIVE. The arc
                // has to sweep the SHORT way round, so its direction
                // flips with the side — getting one without the other
                // spirals the outline and the polygon stops closing.
                if (cross < 0) {
                    try left_pts.append(allocator, v2add(pts[i], np));
                    if (line_join == .round) {
                        try emitArcFan(&left_pts, allocator, pts[i], np, nn, half_w, -1.0);
                    }
                    try left_pts.append(allocator, v2add(pts[i], nn));
                    if (inner_pivot) {
                        try right_pts.append(allocator, v2add(pts[i], v2scale(np, -1)));
                        try right_pts.append(allocator, pts[i]);
                        try right_pts.append(allocator, v2add(pts[i], v2scale(nn, -1)));
                    } else {
                        try right_pts.append(allocator, v2add(pts[i], v2scale(miter, -1)));
                    }
                } else {
                    if (inner_pivot) {
                        try left_pts.append(allocator, v2add(pts[i], np));
                        try left_pts.append(allocator, pts[i]);
                        try left_pts.append(allocator, v2add(pts[i], nn));
                    } else {
                        try left_pts.append(allocator, v2add(pts[i], miter));
                    }
                    const np_neg: Vec2 = .{ .x = -np.x, .y = -np.y };
                    const nn_neg: Vec2 = .{ .x = -nn.x, .y = -nn.y };
                    try right_pts.append(allocator, v2add(pts[i], np_neg));
                    if (line_join == .round) {
                        try emitArcFan(&right_pts, allocator, pts[i], np_neg, nn_neg, half_w, 1.0);
                    }
                    try right_pts.append(allocator, v2add(pts[i], nn_neg));
                }
            }
        } else if (np_off != null) {
            // End vertex of OPEN polyline: butt-equivalent perpendicular.
            // Cap shape is emitted later between the end of left_pts and the
            // end of right_pts.
            const np = np_off.?;
            try left_pts.append(allocator, v2add(pts[i], np));
            try right_pts.append(allocator, v2add(pts[i], v2scale(np, -1)));
        } else if (nn_off != null) {
            // Start vertex of OPEN polyline.
            const nn = nn_off.?;
            try left_pts.append(allocator, v2add(pts[i], nn));
            try right_pts.append(allocator, v2add(pts[i], v2scale(nn, -1)));
        }
    }

    if (left_pts.len < 2 or right_pts.len < 2) return;

    const lp = left_pts.ptr[0..left_pts.len];
    const rp = right_pts.ptr[0..right_pts.len];

    if (closed) {
        // Two independent loops; non-zero winding fills the donut.
        // Outer loop (left strand) — forward, then close.
        for (0..lp.len - 1) |i| {
            try addEdge(edges, allocator, lp[i].x, lp[i].y, lp[i + 1].x, lp[i + 1].y);
        }
        try addEdge(edges, allocator, lp[lp.len - 1].x, lp[lp.len - 1].y, lp[0].x, lp[0].y);
        // Inner loop (right strand) — backward (so winding is opposite).
        var i: usize = rp.len - 1;
        while (i > 0) : (i -= 1) {
            try addEdge(edges, allocator, rp[i].x, rp[i].y, rp[i - 1].x, rp[i - 1].y);
        }
        try addEdge(edges, allocator, rp[0].x, rp[0].y, rp[rp.len - 1].x, rp[rp.len - 1].y);
        return;
    }

    // OPEN polyline: single loop = left forward + end cap + right backward + start cap.

    // Left forward.
    for (0..lp.len - 1) |i| {
        try addEdge(edges, allocator, lp[i].x, lp[i].y, lp[i + 1].x, lp[i + 1].y);
    }

    // End cap: connects lp[end] → rp[end].
    const l_end = lp[lp.len - 1];
    const r_end = rp[rp.len - 1];
    try emitCapEdges(edges, allocator, l_end, r_end, pts[n - 1], last_d_prev, half_w, line_cap, true);

    // Right backward.
    var i: usize = rp.len - 1;
    while (i > 0) : (i -= 1) {
        try addEdge(edges, allocator, rp[i].x, rp[i].y, rp[i - 1].x, rp[i - 1].y);
    }

    // Start cap: connects rp[0] → lp[0].
    try emitCapEdges(edges, allocator, rp[0], lp[0], pts[0], first_d_next, half_w, line_cap, false);
}

/// Emit the polygon edges for one stroke endpoint cap.
///   `from` / `to`     — the two outline points the cap must bridge.
///   `center`          — the polyline endpoint position.
///   `tangent`         — unit vector pointing INTO the polyline at the cap
///                       (i.e. d_prev for end caps, d_next for start caps).
///                       Outward direction = `+tangent` for end, `-tangent`
///                       for start (selected via `is_end`).
///   `is_end`          — true for end-of-polyline caps, false for start.
fn emitCapEdges(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    from: Vec2,
    to: Vec2,
    center: Vec2,
    tangent: Vec2,
    half_w: f64,
    line_cap: SmPaint.LineCap,
    is_end: bool,
) !void {
    switch (line_cap) {
        .butt => {
            try addEdge(edges, allocator, from.x, from.y, to.x, to.y);
        },
        .square => {
            // Extend BOTH endpoints along the outward tangent by half_w,
            // forming a 3-edge square cap.
            const sign: f64 = if (is_end) 1.0 else -1.0;
            const ext: Vec2 = .{ .x = sign * tangent.x * half_w, .y = sign * tangent.y * half_w };
            const from_ext = v2add(from, ext);
            const to_ext = v2add(to, ext);
            try addEdge(edges, allocator, from.x, from.y, from_ext.x, from_ext.y);
            try addEdge(edges, allocator, from_ext.x, from_ext.y, to_ext.x, to_ext.y);
            try addEdge(edges, allocator, to_ext.x, to_ext.y, to.x, to.y);
        },
        .round => {
            // Half-circle fan from `from` through outward tangent to `to`.
            // Both end-cap and start-cap sweep CW by π in screen-Y coords.
            var fan: PointBuf = .{};
            defer fan.deinit(allocator);
            const start_off: Vec2 = .{ .x = from.x - center.x, .y = from.y - center.y };
            const end_off: Vec2 = .{ .x = to.x - center.x, .y = to.y - center.y };
            try emitArcFan(&fan, allocator, center, start_off, end_off, half_w, -1.0);
            var prev = from;
            for (fan.ptr[0..fan.len]) |p| {
                try addEdge(edges, allocator, prev.x, prev.y, p.x, p.y);
                prev = p;
            }
            try addEdge(edges, allocator, prev.x, prev.y, to.x, to.y);
        },
    }
}

/// Slice the polyline `pts` per the dash array, calling `strokePolyline`
/// on each "on" sub-polyline. `closed` polylines are treated by appending
/// `pts[0]` to the end so the closing edge is dashed as a regular segment.
fn dashAndStrokePolyline(
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    pts: []const Vec2,
    half_w: f64,
    miter_limit: f64,
    line_cap: SmPaint.LineCap,
    line_join: SmPaint.LineJoin,
    line_dash: []const f64,
    line_dash_offset: f64,
    closed: bool,
) !void {
    if (pts.len < 2 or half_w <= 0 or line_dash.len == 0) return;
    var total_dash: f64 = 0;
    for (line_dash) |d| total_dash += d;
    if (total_dash <= 0) return;

    // Build the working polyline. For closed paths we append pts[0] so the
    // closing edge participates in dashing as a regular segment.
    var pts_buf: PointBuf = .{};
    defer pts_buf.deinit(allocator);
    try pts_buf.appendSlice(allocator, pts);
    if (closed) try pts_buf.append(allocator, pts[0]);
    const work = pts_buf.ptr[0..pts_buf.len];

    // Resolve initial dash phase from `line_dash_offset` (HTML5: positive
    // shifts the pattern in the dash direction; we wrap modulo total_dash).
    var pos: f64 = @mod(line_dash_offset, total_dash);
    if (pos < 0) pos += total_dash;
    var dash_idx: usize = 0;
    var on: bool = true;
    while (pos >= line_dash[dash_idx]) {
        pos -= line_dash[dash_idx];
        dash_idx = (dash_idx + 1) % line_dash.len;
        on = !on;
    }
    var remaining_in_dash: f64 = line_dash[dash_idx] - pos;

    // Sub-polyline accumulator. Flushed on every dash boundary (and at end).
    var sub: PointBuf = .{};
    defer sub.deinit(allocator);

    for (1..work.len) |i| {
        const a = work[i - 1];
        const b = work[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const seg_len = @sqrt(dx * dx + dy * dy);
        if (seg_len < 1e-12) continue;

        var seg_pos: f64 = 0;
        while (seg_pos < seg_len) {
            // Some dash entries can be exactly 0 (e.g. `[0, 5]` = "always
            // off, then 5px on"); guard so we don't infinite-loop on those.
            if (remaining_in_dash <= 1e-12) {
                if (on and sub.len >= 2) {
                    try strokePolyline(
                        edges,
                        allocator,
                        sub.ptr[0..sub.len],
                        half_w,
                        miter_limit,
                        line_cap,
                        line_join,
                        false,
                    );
                }
                sub.len = 0;
                on = !on;
                dash_idx = (dash_idx + 1) % line_dash.len;
                remaining_in_dash = line_dash[dash_idx];
                continue;
            }
            const step = @min(remaining_in_dash, seg_len - seg_pos);
            if (on) {
                if (sub.len == 0) {
                    const t_start = seg_pos / seg_len;
                    try sub.append(allocator, .{
                        .x = a.x + dx * t_start,
                        .y = a.y + dy * t_start,
                    });
                }
                const t_end = (seg_pos + step) / seg_len;
                try sub.append(allocator, .{
                    .x = a.x + dx * t_end,
                    .y = a.y + dy * t_end,
                });
            }
            seg_pos += step;
            remaining_in_dash -= step;
            if (remaining_in_dash <= 1e-12) {
                if (on and sub.len >= 2) {
                    try strokePolyline(
                        edges,
                        allocator,
                        sub.ptr[0..sub.len],
                        half_w,
                        miter_limit,
                        line_cap,
                        line_join,
                        false,
                    );
                }
                sub.len = 0;
                on = !on;
                dash_idx = (dash_idx + 1) % line_dash.len;
                remaining_in_dash = line_dash[dash_idx];
            }
        }
    }
    // Flush trailing on-interval.
    if (on and sub.len >= 2) {
        try strokePolyline(
            edges,
            allocator,
            sub.ptr[0..sub.len],
            half_w,
            miter_limit,
            line_cap,
            line_join,
            false,
        );
    }
}

/// StrokeVisitor — per-walk state for `strokePath`. Accumulates a polyline
/// per subpath and emits inflated outline edges to `strokePolyline` at
/// subpath boundaries (close / new moveTo / rect / end-of-path).
const StrokeVisitor = struct {
    edges: *EdgeBuf,
    allocator: std.mem.Allocator,
    pts: PointBuf,
    half_w: f64,
    miter_limit: f64,
    line_cap: SmPaint.LineCap,
    line_join: SmPaint.LineJoin,
    line_dash: []const f64,
    line_dash_offset: f64,

    fn flush(self: *StrokeVisitor, closed: bool) !void {
        if (self.pts.len >= 2) {
            if (self.line_dash.len > 0) {
                try dashAndStrokePolyline(
                    self.edges,
                    self.allocator,
                    self.pts.ptr[0..self.pts.len],
                    self.half_w,
                    self.miter_limit,
                    self.line_cap,
                    self.line_join,
                    self.line_dash,
                    self.line_dash_offset,
                    closed,
                );
            } else {
                try strokePolyline(
                    self.edges,
                    self.allocator,
                    self.pts.ptr[0..self.pts.len],
                    self.half_w,
                    self.miter_limit,
                    self.line_cap,
                    self.line_join,
                    closed,
                );
            }
        }
        self.pts.len = 0;
    }

    fn onClose(self: *StrokeVisitor) !void {
        try self.flush(true);
    }

    fn onMoveTo(self: *StrokeVisitor, x: f64, y: f64) !void {
        try self.flush(false);
        try self.pts.append(self.allocator, .{ .x = x, .y = y });
    }

    fn onLineTo(self: *StrokeVisitor, x: f64, y: f64) !void {
        if (self.pts.len == 0) try self.pts.append(self.allocator, .{ .x = x, .y = y });
        try self.pts.append(self.allocator, .{ .x = x, .y = y });
    }

    fn onQuadTo(self: *StrokeVisitor, cpx: f64, cpy: f64, x: f64, y: f64) !void {
        var p0x: f64 = cpx;
        var p0y: f64 = cpy;
        if (self.pts.len == 0) {
            try self.pts.append(self.allocator, .{ .x = cpx, .y = cpy });
        } else {
            p0x = self.pts.ptr[self.pts.len - 1].x;
            p0y = self.pts.ptr[self.pts.len - 1].y;
        }
        try flattenQuadPoints(&self.pts, self.allocator, p0x, p0y, cpx, cpy, x, y, 0);
    }

    fn onBezierTo(self: *StrokeVisitor, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64) !void {
        var p0x: f64 = c1x;
        var p0y: f64 = c1y;
        if (self.pts.len == 0) {
            try self.pts.append(self.allocator, .{ .x = c1x, .y = c1y });
        } else {
            p0x = self.pts.ptr[self.pts.len - 1].x;
            p0y = self.pts.ptr[self.pts.len - 1].y;
        }
        try flattenCubicPoints(&self.pts, self.allocator, p0x, p0y, c1x, c1y, c2x, c2y, x, y, 0);
    }

    fn onRect(self: *StrokeVisitor, rx: f64, ry: f64, rw: f64, rh: f64) !void {
        try self.flush(false);
        try self.pts.append(self.allocator, .{ .x = rx, .y = ry });
        try self.pts.append(self.allocator, .{ .x = rx + rw, .y = ry });
        try self.pts.append(self.allocator, .{ .x = rx + rw, .y = ry + rh });
        try self.pts.append(self.allocator, .{ .x = rx, .y = ry + rh });
        try self.flush(true);
    }
};

/// flattenPathToStrokeEdges — populate `edges` with the inflated outline
/// of `path` rendered with the given line-width/cap/join/miter-limit and
/// optional dash pattern. Outline is the same polygon `strokePath` would
/// rasterize. Used by `strokePath` and the hit-test helper
/// `isPointInStroke`.
pub fn flattenPathToStrokeEdges(
    allocator: std.mem.Allocator,
    path: *const SmPath,
    edges: *EdgeBuf,
    line_width: f64,
    line_cap: SmPaint.LineCap,
    line_join: SmPaint.LineJoin,
    miter_limit: f64,
    line_dash: []const f64,
    line_dash_offset: f64,
) !void {
    if (path.verbs.len == 0 or line_width <= 0) return;
    var visitor: StrokeVisitor = .{
        .edges = edges,
        .allocator = allocator,
        .pts = .{},
        .half_w = line_width / 2.0,
        .miter_limit = miter_limit,
        .line_cap = line_cap,
        .line_join = line_join,
        .line_dash = line_dash,
        .line_dash_offset = line_dash_offset,
    };
    defer visitor.pts.deinit(allocator);
    try walkOpcodes(path.verbs.ptr[0..path.verbs.len], path.points.ptr[0..path.points.len], &visitor);
    try visitor.flush(false);
}

/// strokePath — public entry. Builds inflated outline edges, sweeps, blits.
///
/// `aa_accum` and `cov_row` are caller-owned per-row scratch buffers,
/// each sized to at least `canvas_w`. See `fillPath` for ownership notes.
pub fn strokePath(
    allocator: std.mem.Allocator,
    pixels: []u32,
    canvas_w: u32,
    canvas_h: u32,
    path: *const SmPath,
    line_width: f64,
    line_cap: SmPaint.LineCap,
    line_join: SmPaint.LineJoin,
    miter_limit: f64,
    line_dash: []const f64,
    line_dash_offset: f64,
    clip: ?SmBlitter.Clip,
    paint: *const SmPaint,
    aa_accum: []f64,
    cov_row: []u8,
) !void {
    if (path.verbs.len == 0 or line_width <= 0) return;
    if (canvas_w == 0 or canvas_h == 0) return;

    var edges: EdgeBuf = .{};
    defer edges.deinit(allocator);
    try flattenPathToStrokeEdges(
        allocator,
        path,
        &edges,
        line_width,
        line_cap,
        line_join,
        miter_limit,
        line_dash,
        line_dash_offset,
    );
    // Stroke outline polygon is filled with the standard non-zero winding
    // rule (the donut is built CCW outer + CW inner) — fill rule is not
    // user-controllable for strokes.
    try sweepFill(&edges, allocator, pixels, canvas_w, canvas_h, .nonzero, clip, paint, aa_accum, cov_row);
}

// ---------------------------------------------------------------------------
// Spans: the sweep's runs kept for replay (see SmSpans.zig)
// ---------------------------------------------------------------------------

/// Largest shape-space box a span build accepts; beyond it the caller
/// draws directly (the sweep would otherwise cover the whole shape, not
/// just the part on the canvas).
pub const spans_max_side: u32 = 4096;

/// The per-row scratch a span build sweeps with, grown to the widest
/// shape seen and kept by the caller across builds.
pub const SweepScratch = struct {
    accum: []f64 = &.{},
    cov: []u8 = &.{},

    pub fn deinit(self: *SweepScratch, allocator: std.mem.Allocator) void {
        if (self.accum.len > 0) allocator.free(self.accum);
        if (self.cov.len > 0) allocator.free(self.cov);
        self.* = .{};
    }

    fn ensure(self: *SweepScratch, allocator: std.mem.Allocator, w: usize) !void {
        if (self.accum.len < w + accum_slack) {
            if (self.accum.len > 0) allocator.free(self.accum);
            self.accum = &.{};
            self.accum = try allocator.alloc(f64, w + accum_slack);
        }
        if (self.cov.len < w) {
            if (self.cov.len > 0) allocator.free(self.cov);
            self.cov = &.{};
            self.cov = try allocator.alloc(u8, w);
        }
    }
};

/// fillPathToSpans — the analytic sweep of `path` (already in device
/// space) recorded into `spans` instead of blended. The sweep runs over
/// the path's own box, so nothing is clipped to a canvas width: the runs
/// are complete and `SmSpans.replay` trims them to the surface they
/// land on. `y_clip`, in the path's own space, limits the ROWS swept
/// (rows are independent, so the bytes of the rows kept are those of
/// the full sweep) — for a shape far taller than the surface.
pub fn fillPathToSpans(
    allocator: std.mem.Allocator,
    path: *const SmPath,
    fill_rule: FillRule,
    spans: *SmSpans,
    scratch: *SweepScratch,
    y_clip: ?[2]i32,
) !void {
    if (path.verbs.len == 0) return;
    var edges: EdgeBuf = .{};
    defer edges.deinit(allocator);
    try flattenPathToFillEdges(allocator, path, &edges);
    try sweepToSpans(&edges, allocator, fill_rule, spans, scratch, y_clip);
}

/// strokePathToSpans — `strokePath`'s outline recorded like
/// `fillPathToSpans`.
pub fn strokePathToSpans(
    allocator: std.mem.Allocator,
    path: *const SmPath,
    line_width: f64,
    line_cap: SmPaint.LineCap,
    line_join: SmPaint.LineJoin,
    miter_limit: f64,
    line_dash: []const f64,
    line_dash_offset: f64,
    spans: *SmSpans,
    scratch: *SweepScratch,
    y_clip: ?[2]i32,
) !void {
    if (path.verbs.len == 0 or line_width <= 0) return;
    var edges: EdgeBuf = .{};
    defer edges.deinit(allocator);
    try flattenPathToStrokeEdges(allocator, path, &edges, line_width, line_cap, line_join, miter_limit, line_dash, line_dash_offset);
    try sweepToSpans(&edges, allocator, .nonzero, spans, scratch, y_clip);
}

/// Shift the edges so their box starts at (1, 0), sweep that box, and
/// record every run shifted back. The shift is by whole pixels, so the
/// cells a segment deposits into are the same cells, moved.
fn sweepToSpans(edges: *EdgeBuf, allocator: std.mem.Allocator, fill_rule: FillRule, spans: *SmSpans, scratch: *SweepScratch, y_clip: ?[2]i32) !void {
    if (edges.len == 0) return;
    var min_x: f64 = std.math.inf(f64);
    var max_x: f64 = -std.math.inf(f64);
    var min_y: f64 = std.math.inf(f64);
    var max_y: f64 = -std.math.inf(f64);
    for (edges.ptr[0..edges.len]) |e| {
        const x_end = e.x_at_y_min + (e.y_max - e.y_min) * e.inv_slope;
        min_x = @min(min_x, @min(e.x_at_y_min, x_end));
        max_x = @max(max_x, @max(e.x_at_y_min, x_end));
        min_y = @min(min_y, e.y_min);
        max_y = @max(max_y, e.y_max);
    }
    if (!std.math.isFinite(min_x) or !std.math.isFinite(max_x) or !std.math.isFinite(min_y) or !std.math.isFinite(max_y)) return error.Unsupported;
    const lim: f64 = @floatFromInt(spans_max_side);
    if (max_x - min_x > lim) return error.TooLarge;
    if (y_clip) |yc| {
        min_y = @max(min_y, @as(f64, @floatFromInt(yc[0])));
        max_y = @min(max_y, @as(f64, @floatFromInt(yc[1])));
        if (min_y >= max_y) return;
    }
    if (max_y - min_y > lim) return error.TooLarge;
    // One spare column on the left keeps every edge strictly inside the
    // box (the width clip clamps edges AT the boundary to verticals).
    const x0: i32 = @as(i32, @intFromFloat(@floor(min_x))) - 1;
    const y0: i32 = @intFromFloat(@floor(min_y));
    const w: u32 = @intCast(@as(i32, @intFromFloat(@ceil(max_x))) - x0 + 2);
    const h: u32 = @intCast(@as(i32, @intFromFloat(@ceil(max_y))) - y0 + 1);
    const fx: f64 = @floatFromInt(x0);
    const fy: f64 = @floatFromInt(y0);
    for (edges.ptr[0..edges.len]) |*e| {
        e.x_at_y_min -= fx;
        e.y_min -= fy;
        e.y_max -= fy;
    }
    try scratch.ensure(allocator, w);
    const emit = struct {
        spans: *SmSpans,
        allocator: std.mem.Allocator,
        x0: i32,
        y0: i32,
        fn run(self: @This(), canvas_w_: u32, x: i32, y: i32, c: []const u8) void {
            _ = canvas_w_;
            self.spans.addRun(self.allocator, x + self.x0, y + self.y0, c);
        }
    }{ .spans = spans, .allocator = allocator, .x0 = x0, .y0 = y0 };
    try sweepAnalytic(edges, allocator, w, h, fill_rule, scratch.accum, scratch.cov, emit, null);
    if (spans.oom) return error.OutOfMemory;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "spans replay the direct fill byte for byte: 32 seeded paths, whole-pixel offsets" {
    // Every seeded path is filled directly on a canvas large enough to
    // hold it whole (the direct sweep clips edges at the canvas border,
    // and the split moves an f32 area share by an ulp — see the next
    // test), and built as spans and replayed at the integer offset; a
    // second replay two pixels down and three right must equal the
    // direct fill of the path moved the same way.
    const a = std.testing.allocator;
    // Seeded coordinates run from -8 to 104, and a seeded rect can reach
    // 64 further: 20 px of margin on the left, 100 on the right.
    const W: u32 = 224;
    const H: u32 = 200;
    const direct = try a.alloc(u32, W * H);
    defer a.free(direct);
    const via = try a.alloc(u32, W * H);
    defer a.free(via);
    const accum = try a.alloc(f64, W + accum_slack);
    defer a.free(accum);
    const cov = try a.alloc(u8, W);
    defer a.free(cov);
    const solid = try a.alloc(u8, 8192);
    defer a.free(solid);
    @memset(solid, 255);
    var scratch: SweepScratch = .{};
    defer scratch.deinit(a);
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const r = prng.random();
    var mismatched: usize = 0;
    var i: usize = 0;
    while (i < 32) : (i += 1) {
        var seeded = try testPath(a, r, i);
        defer seeded.deinit();
        // Seeded coordinates run from -8 to 104: move them inside.
        var path = SmPath.emptyWithAllocator(a);
        defer path.deinit();
        try path.addPathTransform(&seeded, &SmMatrix.components(1, 0, 0, 1, 20, 24));
        const rule: FillRule = if (i % 2 == 0) .nonzero else .evenodd;
        const paint: SmPaint = .{ .shader = .{ .solid = if (i % 3 == 0) 0xFF3050C0 else 0x80C05030 }, .style = .fill, .blend_mode = .src_over, .antialias = true };
        @memset(direct, 0xFFFFFFFF);
        try fillPath(a, direct, W, H, &path, rule, null, &paint, accum, cov);
        var spans: SmSpans = .{};
        defer spans.deinit(a);
        try fillPathToSpans(a, &path, rule, &spans, &scratch, null);
        @memset(via, 0xFFFFFFFF);
        spans.replay(via, W, H, 0, 0, &paint, null, solid);
        if (!std.mem.eql(u32, direct, via)) {
            mismatched += 1;
            var n: usize = 0;
            for (direct, via) |d, v| n += @intFromBool(d != v);
            std.debug.print("spans mismatch: path {d} at offset 0, {d} px\n", .{ i, n });
        }
        var moved = SmPath.emptyWithAllocator(a);
        defer moved.deinit();
        try moved.addPathTransform(&path, &SmMatrix.components(1, 0, 0, 1, 3, 2));
        @memset(direct, 0xFFFFFFFF);
        try fillPath(a, direct, W, H, &moved, rule, null, &paint, accum, cov);
        @memset(via, 0xFFFFFFFF);
        spans.replay(via, W, H, 3, 2, &paint, null, solid);
        if (!std.mem.eql(u32, direct, via)) {
            mismatched += 1;
            var n: usize = 0;
            for (direct, via) |d, v| n += @intFromBool(d != v);
            std.debug.print("spans mismatch: path {d} moved, {d} px\n", .{ i, n });
        }
    }
    try std.testing.expectEqual(@as(usize, 0), mismatched);
}

test "spans of a path crossing the canvas border stay within one LSB of the direct fill" {
    const a = std.testing.allocator;
    const W: u32 = 128;
    const H: u32 = 128;
    const direct = try a.alloc(u32, W * H);
    defer a.free(direct);
    const via = try a.alloc(u32, W * H);
    defer a.free(via);
    const accum = try a.alloc(f64, W + accum_slack);
    defer a.free(accum);
    const cov = try a.alloc(u8, W);
    defer a.free(cov);
    const solid = try a.alloc(u8, 8192);
    defer a.free(solid);
    @memset(solid, 255);
    var scratch: SweepScratch = .{};
    defer scratch.deinit(a);
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const r = prng.random();
    var worst: u32 = 0;
    var differing: usize = 0;
    var i: usize = 0;
    while (i < 32) : (i += 1) {
        var path = try testPath(a, r, i);
        defer path.deinit();
        const rule: FillRule = if (i % 2 == 0) .nonzero else .evenodd;
        const paint: SmPaint = .{ .shader = .{ .solid = 0xFF3050C0 }, .style = .fill, .blend_mode = .src_over, .antialias = true };
        @memset(direct, 0xFFFFFFFF);
        try fillPath(a, direct, W, H, &path, rule, null, &paint, accum, cov);
        var spans: SmSpans = .{};
        defer spans.deinit(a);
        // Rows clipped to the canvas, as a renderer would for a tall shape.
        try fillPathToSpans(a, &path, rule, &spans, &scratch, .{ 0, @intCast(H) });
        @memset(via, 0xFFFFFFFF);
        spans.replay(via, W, H, 0, 0, &paint, null, solid);
        for (direct, via) |d, v| {
            if (d == v) continue;
            differing += 1;
            inline for (0..4) |ch| {
                const dc: u32 = (d >> (8 * ch)) & 0xFF;
                const vc: u32 = (v >> (8 * ch)) & 0xFF;
                worst = @max(worst, if (dc > vc) dc - vc else vc - dc);
            }
        }
    }
    std.debug.print("\nborder spans vs direct: {d} px differ, worst {d} LSB\n", .{ differing, worst });
    try std.testing.expect(worst <= 1);
    // A handful of border cells at most, over 32 × 16k pixels.
    try std.testing.expect(differing < 64);
}

test "stroke spans replay the direct stroke, under a box clip and a mask" {
    const a = std.testing.allocator;
    const W: u32 = 96;
    const H: u32 = 80;
    const direct = try a.alloc(u32, W * H);
    defer a.free(direct);
    const via = try a.alloc(u32, W * H);
    defer a.free(via);
    const accum = try a.alloc(f64, W + accum_slack);
    defer a.free(accum);
    const cov = try a.alloc(u8, W);
    defer a.free(cov);
    const solid = try a.alloc(u8, 4096);
    defer a.free(solid);
    @memset(solid, 255);
    const mask = try a.alloc(u8, W * H);
    defer a.free(mask);
    for (mask, 0..) |*m, k| m.* = @intCast((k * 7) % 256);
    var path = SmPath.emptyWithAllocator(a);
    defer path.deinit();
    path.moveTo(12.3, 12.7);
    path.quadraticCurveTo(40.1, 8.2, 70.6, 30.4);
    path.lineTo(84.2, 60.9);
    path.bezierCurveTo(50.5, 70.1, 20.2, 66.3, 9.5, 40.4);
    const paint: SmPaint = .{ .shader = .{ .solid = 0xC0203040 }, .style = .fill, .blend_mode = .src_over, .antialias = true };
    const clips = [_]?SmBlitter.Clip{
        null,
        .{ .mask = null, .x0 = 8, .y0 = 5, .x1 = 70, .y1 = 60 },
        .{ .mask = mask, .x0 = 3, .y0 = 2, .x1 = 90, .y1 = 75 },
    };
    for (clips) |clip| {
        @memset(direct, 0xFF102030);
        try strokePath(a, direct, W, H, &path, 6.5, .round, .miter, 10.0, &.{}, 0, clip, &paint, accum, cov);
        var spans: SmSpans = .{};
        defer spans.deinit(a);
        var scratch: SweepScratch = .{};
        defer scratch.deinit(a);
        try strokePathToSpans(a, &path, 6.5, .round, .miter, 10.0, &.{}, 0, &spans, &scratch, null);
        @memset(via, 0xFF102030);
        spans.replay(via, W, H, 0, 0, &paint, clip, solid);
        try std.testing.expect(std.mem.eql(u32, direct, via));
    }
}

/// The 32 seeded paths every scan-converter test draws: lines, quads,
/// cubics and rects with coordinates that run past the canvas on every
/// side, half nonzero / half even-odd, one in four without antialiasing.
/// Deterministic, so the same paths pin a golden hash across changes that
/// must not move a byte, and feed the analytic-vs-supersample comparison.
fn testPath(allocator: std.mem.Allocator, r: std.Random, i: usize) !SmPath {
    var path = SmPath.emptyWithAllocator(allocator);
    errdefer path.deinit();
    const span: f64 = 112.0;
    const off: f64 = -8.0;
    const rnd = struct {
        fn c(rr: std.Random, sp: f64, o: f64) f64 {
            return o + rr.float(f64) * sp;
        }
    };
    if (i % 5 == 4) {
        path.rect(rnd.c(r, span, off), rnd.c(r, span, off), 4 + r.float(f64) * 60, 4 + r.float(f64) * 40);
        return path;
    }
    path.moveTo(rnd.c(r, span, off), rnd.c(r, span, off));
    const segs = 3 + r.uintLessThan(usize, 6);
    var k: usize = 0;
    while (k < segs) : (k += 1) {
        switch (r.uintLessThan(u8, 3)) {
            0 => path.lineTo(rnd.c(r, span, off), rnd.c(r, span, off)),
            1 => path.quadraticCurveTo(rnd.c(r, span, off), rnd.c(r, span, off), rnd.c(r, span, off), rnd.c(r, span, off)),
            else => path.bezierCurveTo(rnd.c(r, span, off), rnd.c(r, span, off), rnd.c(r, span, off), rnd.c(r, span, off), rnd.c(r, span, off), rnd.c(r, span, off)),
        }
    }
    path.closePath();
    return path;
}

/// The goldens: a Wyhash over the pixels of `fillPath` and the mask of
/// `fillPathToCoverage` for the 32 test paths, one per converter. The
/// supersampled one is the pre-M17 output and must not move; the
/// analytic one was taken on the converter's first run and later groups
/// must not move it either. `0` prints the hash instead of checking it.
const golden_supersample8: u64 = 0x82e80ad2a7f05938;
const golden_analytic: u64 = 0x69a51f067f3fca65;

/// The analytic converter against the supersampled sweep, over the mask
/// bytes of the antialiased test paths where either is non-zero. First
/// run (2026-09-03): 32,088 covered pixels, mean 0.353 LSB, p99.9 66,
/// max 201; pinned with headroom on the mean and the percentile. The
/// maximum is reported, not gated: the random cubics self-intersect with
/// mixed winding signs, and inside one pixel the signed-area sum cancels
/// where the supersampled spans did not (the approximation every
/// signed-area converter makes; Skia's falls back to supersampling for
/// such paths). Shapes whose winding is 0/1 everywhere — every distilled
/// SWF fill — accumulate exactly, which the rectangle paths check: their
/// only difference is the sweep's eighth-of-a-row vertical quantization
/// on the top and bottom rows (at most 1/8 of coverage, 32 LSB).
const tol_mean_max: f64 = 0.75;
const tol_p999_max: u32 = 96;
const tol_rect_max: u32 = 33;

fn maxChannelDelta(a: []const u32, b: []const u32) u32 {
    var m: u32 = 0;
    for (a, b) |x, y| {
        inline for (0..4) |ch| {
            const shift: u5 = @intCast(ch * 8);
            const xa: i32 = @intCast((x >> shift) & 0xFF);
            const yb: i32 = @intCast((y >> shift) & 0xFF);
            m = @max(m, @as(u32, @intCast(@abs(xa - yb))));
        }
    }
    return m;
}

test "coverage goldens and the analytic tolerance: 32 seeded paths through fillPath and fillPathToCoverage" {
    const a = std.testing.allocator;
    const W: u32 = 96;
    const H: u32 = 64;
    var prng = std.Random.DefaultPrng.init(0x5eed_c0de);
    const r = prng.random();
    const pixels = try a.alloc(u32, W * H);
    defer a.free(pixels);
    const pixels_ref = try a.alloc(u32, W * H);
    defer a.free(pixels_ref);
    const mask = try a.alloc(u8, W * H);
    defer a.free(mask);
    const mask_ref = try a.alloc(u8, W * H);
    defer a.free(mask_ref);
    const accum = try a.alloc(f64, W + accum_slack);
    defer a.free(accum);
    const cov = try a.alloc(u8, W);
    defer a.free(cov);
    var h_ss = std.hash.Wyhash.init(0);
    var h_an = std.hash.Wyhash.init(0);
    var hist = [_]u64{0} ** 256;
    var sum_delta: u64 = 0;
    var count: u64 = 0;
    var max_px: u32 = 0;
    var max_rect: u32 = 0;
    var i: usize = 0;
    while (i < 32) : (i += 1) {
        var path = try testPath(a, r, i);
        defer path.deinit();
        const rule: FillRule = if (i & 1 == 0) .nonzero else .evenodd;
        const aa = (i % 4) != 3;
        inline for (.{ SmPaint.AaMode.supersample8, SmPaint.AaMode.analytic }) |mode| {
            const px = if (mode == .supersample8) pixels_ref else pixels;
            const mk = if (mode == .supersample8) mask_ref else mask;
            const hs = if (mode == .supersample8) &h_ss else &h_an;
            @memset(px, 0xFF202020);
            const paint: SmPaint = .{ .shader = .{ .solid = 0xFFE0A040 }, .style = .fill, .blend_mode = .src_over, .antialias = aa, .aa_mode = mode };
            try fillPath(a, px, W, H, &path, rule, null, &paint, accum, cov);
            hs.update(std.mem.sliceAsBytes(px));
            @memset(mk, 0);
            try fillPathToCoverageMode(a, mk, W, H, &path, rule, aa, mode);
            hs.update(mk);
        }
        if (!aa) {
            // One sample per pixel takes the same sweep in both modes.
            try std.testing.expectEqualSlices(u8, mask_ref, mask);
            try std.testing.expectEqualSlices(u32, pixels_ref, pixels);
            continue;
        }
        const is_rect = (i % 5) == 4;
        for (mask, mask_ref) |m, mr| {
            if (m == 0 and mr == 0) continue;
            const d: u32 = @intCast(@abs(@as(i32, m) - @as(i32, mr)));
            hist[d] += 1;
            sum_delta += d;
            count += 1;
            if (is_rect) max_rect = @max(max_rect, d);
        }
        max_px = @max(max_px, maxChannelDelta(pixels, pixels_ref));
    }
    var acc: u64 = 0;
    var p999: u32 = 0;
    var max_d: u32 = 0;
    const target = count - count / 1000;
    for (hist, 0..) |n, d| {
        if (n > 0) max_d = @intCast(d);
        if (p999 == 0 and n > 0) {
            acc += n;
            if (acc >= target) p999 = @intCast(d);
        }
    }
    const mean = @as(f64, @floatFromInt(sum_delta)) / @as(f64, @floatFromInt(@max(count, 1)));
    std.debug.print("\nanalytic vs supersample8 over {d} covered pixels: mean {d:.3} LSB, p99.9 {d}, max {d} (rects {d}); pixel max {d}\n", .{ count, mean, p999, max_d, max_rect, max_px });
    try std.testing.expectEqual(golden_supersample8, h_ss.final());
    const h = h_an.final();
    if (golden_analytic == 0) {
        std.debug.print("golden_analytic = 0x{x}\n", .{h});
    } else {
        try std.testing.expectEqual(golden_analytic, h);
    }
    try std.testing.expect(mean <= tol_mean_max);
    try std.testing.expect(p999 <= tol_p999_max);
    try std.testing.expect(max_rect <= tol_rect_max);
}

test "stroke: repeated points change nothing, and a hairline with a zero-length segment stays within its miter reach" {
    const a = std.testing.allocator;
    const W: u32 = 96;
    const H: u32 = 64;
    const pixels = try a.alloc(u32, W * H);
    defer a.free(pixels);
    const ref = try a.alloc(u32, W * H);
    defer a.free(ref);
    const accum = try a.alloc(f64, W + accum_slack);
    defer a.free(accum);
    const cov = try a.alloc(u8, W);
    defer a.free(cov);
    const paint: SmPaint = .{ .shader = .{ .solid = 0xFF2040E0 }, .style = .stroke, .stroke_width = 1.0, .blend_mode = .src_over };

    // The same polyline with and without a repeated vertex.
    var clean = SmPath.emptyWithAllocator(a);
    defer clean.deinit();
    clean.moveTo(10, 40);
    clean.lineTo(50, 12);
    clean.lineTo(80, 50);
    var dup = SmPath.emptyWithAllocator(a);
    defer dup.deinit();
    dup.moveTo(10, 40);
    dup.lineTo(50, 12);
    dup.lineTo(50, 12);
    dup.lineTo(80, 50);
    @memset(ref, 0);
    try strokePath(a, ref, W, H, &clean, 1.0, .round, .round, 10.0, &.{}, 0, null, &paint, accum, cov);
    @memset(pixels, 0);
    try strokePath(a, pixels, W, H, &dup, 1.0, .round, .round, 10.0, &.{}, 0, null, &paint, accum, cov);
    try std.testing.expectEqualSlices(u32, ref, pixels);

    // Every painted pixel lies within the points' box plus the reach a
    // hairline's miter may have (half a pixel times the default limit).
    var x_min: u32 = W;
    var x_max: u32 = 0;
    var y_min: u32 = H;
    var y_max: u32 = 0;
    for (pixels, 0..) |p, i| {
        if (p == 0) continue;
        const x: u32 = @intCast(i % W);
        const y: u32 = @intCast(i / W);
        x_min = @min(x_min, x);
        x_max = @max(x_max, x);
        y_min = @min(y_min, y);
        y_max = @max(y_max, y);
    }
    const reach: u32 = 6;
    try std.testing.expect(x_min + reach >= 10 and x_max <= 80 + reach);
    try std.testing.expect(y_min + reach >= 12 and y_max <= 50 + reach);
}

test "stroke inner join: a closed hairline folding back on itself stays inside its geometry" {
    // Regression: the inner side of a round join took the unclamped miter
    // point. Where the closing segment reversed the last flattened piece
    // of a curve almost exactly, that point landed 45 px away and the
    // nonzero rule painted the excursion as a spike (Journe Yofj morph
    // shape 126 in handyflash). The device-space path is the one the
    // renderer handed the canvas.
    const a = std.testing.allocator;
    const W: u32 = 176;
    const H: u32 = 208;
    const pixels = try a.alloc(u32, W * H);
    defer a.free(pixels);
    const accum = try a.alloc(f64, W + accum_slack);
    defer a.free(accum);
    const cov = try a.alloc(u8, W);
    defer a.free(cov);
    const paint: SmPaint = .{ .shader = .{ .solid = 0xFF2040E0 }, .style = .stroke, .stroke_width = 1.0, .blend_mode = .src_over };
    // Device-space path exactly as the renderer handed it to the canvas
    // (twips through the object's CTM); the closed hairline revisits its
    // start point (155.99, 166.28) mid-way.
    var path = SmPath.emptyWithAllocator(a);
    defer path.deinit();
    path.moveTo(155.9885, 166.2813);
    path.lineTo(155.9981, 167.3251);
    path.quadraticCurveTo(159.5727, 167.6928, 162.8963, 169.7895);
    path.quadraticCurveTo(162.4372, 167.6509, 155.9885, 166.2813);
    path.lineTo(155.9981, 167.3251);
    path.quadraticCurveTo(159.5727, 167.6928, 162.8963, 169.7895);
    path.closePath();
    @memset(pixels, 0);
    try strokePath(a, pixels, W, H, &path, 1.0, .round, .round, 10.0, &.{}, 0, null, &paint, accum, cov);
    var x_min: u32 = W;
    var x_max: u32 = 0;
    var y_min: u32 = H;
    var y_max: u32 = 0;
    var n: u32 = 0;
    for (pixels, 0..) |p, i| {
        if (p == 0) continue;
        n += 1;
        const x: u32 = @intCast(i % W);
        const y: u32 = @intCast(i / W);
        x_min = @min(x_min, x);
        x_max = @max(x_max, x);
        y_min = @min(y_min, y);
        y_max = @max(y_max, y);
    }
    // Geometry spans x155..163, y166..170; a 1 px stroke may reach one
    // pixel beyond it and nowhere near the spike's x95 / y136.
    try std.testing.expect(n > 0 and n < 80);
    try std.testing.expect(x_min >= 154 and x_max <= 164);
    try std.testing.expect(y_min >= 165 and y_max <= 171);
}
