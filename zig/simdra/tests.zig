//! Aggregator root for the C-free unit tests (`zig build test` runs this
//! and tests_libc.zig; the latter holds everything that reaches SmCanvas
//! and therefore stb_truetype). Pulls in the modules that carry `test`
//! blocks. Allocator-leak tests live separately in ../leak_test.zig.

test {
    _ = @import("core/SmBlitter.zig");
    _ = @import("core/SmScan.zig");
    _ = @import("effects/SmGradient.zig");
    _ = @import("effects/SmPattern.zig");
    _ = @import("opts/generic.zig");
}
