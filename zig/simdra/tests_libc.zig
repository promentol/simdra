//! Test root for everything that reaches SmCanvas — which imports SmFont
//! and therefore stb_truetype, so this root links libc and the stb C
//! sources (`zig build test` wires that up; `tests.zig` is the C-free
//! root for the kernels). Add a file here when its tests need a canvas.

test {
    _ = @import("core/SmCanvas.zig");
    _ = @import("core/SmSurface.zig");
}
