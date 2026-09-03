//! simdra build graph (Zig 0.16).
//!
//!   zig build test                          the unit tests, all of them
//!   zig build test-leak                     the allocator-threading leak check
//!   zig build test-format                   surface color-type scenes
//!   zig build bench -Doptimize=ReleaseFast  800×600 gradient / pattern fills, ms/op
//!
//! The Zig side of simdra is built and tested with Zig 0.16 only. The
//! node-zigar bindings (`npm test`, the JS canvas facade, the WASM bundle)
//! target node-zigar's pinned Zig and are not part of this graph; they
//! return when node-zigar ships a 0.16 release (Roadmap.md).
//!
//! Two test roots because of libc: `zig/simdra/tests.zig` reaches only the
//! pure-Zig kernels (blitter, gradients, patterns, scan converter, the
//! backend tolerance test), while anything that imports SmCanvas pulls
//! SmFont → stb_truetype and needs the C sources and libc
//! (`zig/simdra/tests_libc.zig`, `leak_test.zig`, `format_test.zig`).

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const test_filter = b.option([]const u8, "test-filter", "Only run tests whose name contains this");
    const filters: []const []const u8 = if (test_filter) |f| &.{f} else &.{};

    const stb_sources = [_][]const u8{
        "zig/simdra/utils/stb_image.c",
        "zig/simdra/utils/stb_truetype.c",
    };

    // --- pure-Zig tests -------------------------------------------------
    const pure = b.createModule(.{
        .root_source_file = b.path("zig/simdra/tests.zig"),
        .target = target,
        .optimize = optimize,
    });
    const pure_tests = b.addTest(.{ .root_module = pure, .filters = filters });
    const run_pure = b.addRunArtifact(pure_tests);

    // --- tests that reach SmCanvas (libc + stb) -------------------------
    const withlibc = b.createModule(.{
        .root_source_file = b.path("zig/simdra/tests_libc.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    withlibc.addIncludePath(b.path("zig"));
    withlibc.addCSourceFiles(.{ .files = &stb_sources });
    const libc_tests = b.addTest(.{ .root_module = withlibc, .filters = filters });
    const run_libc = b.addRunArtifact(libc_tests);

    const test_step = b.step("test", "Run the unit tests");
    test_step.dependOn(&run_pure.step);
    test_step.dependOn(&run_libc.step);

    // --- the two historical entry points, kept as their own steps -------
    inline for (.{
        .{ "test-leak", "zig/leak_test.zig", "Allocator-threading leak check under std.testing.allocator" },
        .{ "test-format", "zig/format_test.zig", "Surface color-type scenes (rgba8888 vs bgra8888)" },
    }) |entry| {
        const mod = b.createModule(.{
            .root_source_file = b.path(entry[1]),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        mod.addIncludePath(b.path("zig"));
        mod.addCSourceFiles(.{ .files = &stb_sources });
        const t = b.addTest(.{ .root_module = mod, .filters = filters });
        b.step(entry[0], entry[2]).dependOn(&b.addRunArtifact(t).step);
    }

    // --- bench -----------------------------------------------------------
    const bench_mod = b.createModule(.{
        .root_source_file = b.path("zig/bench.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    bench_mod.addIncludePath(b.path("zig"));
    bench_mod.addCSourceFiles(.{ .files = &stb_sources });
    const bench_exe = b.addExecutable(.{ .name = "simdra-bench", .root_module = bench_mod });
    const run_bench = b.addRunArtifact(bench_exe);
    if (b.args) |args| run_bench.addArgs(args);
    b.step("bench", "Time the 800x600 gradient and pattern fills (build with -Doptimize=ReleaseFast)")
        .dependOn(&run_bench.step);
    b.installArtifact(bench_exe);
}
