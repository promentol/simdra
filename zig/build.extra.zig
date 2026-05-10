//! Extension hook for zigar-compiler's build.zig — declares the extra C
//! source files and include paths the simdra module depends on. Picked up
//! automatically because this file lives next to the module entry source
//! (`zig/simdra.zig`); zigar's build script calls `getCSourceFiles` /
//! `getIncludePaths` if they're declared.
//!
//! Paths are resolved relative to the module dir (`zig/`).

const std = @import("std");

pub fn getCSourceFiles(_: *std.Build, _: anytype) []const []const u8 {
    return &.{
        "simdra/utils/stb_truetype.c",
        "simdra/utils/stb_image.c",
    };
}

// Note: zigar-compiler 0.15.2's build.zig has a bug in `getIncludePaths`
// (passes `.file` to `addIncludePath` which doesn't accept it). The module
// dir (`zig/`) is already added as an include path on the Zig side, so
// `@cInclude("simdra/utils/stb_truetype.h")` resolves without a custom path.
// C source files find sibling headers in their own directory automatically.
