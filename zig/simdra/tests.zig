//! Aggregator root for in-module Zig unit tests (`npm run test:zig`).
//!
//! Pulls in the modules that carry `test` blocks. Deliberately EXCLUDES
//! anything that transitively @cImports (SmCanvas → SmFont → stb_truetype;
//! decode/stb) so this runs with a plain `zig test` — no `-lc -I .`.
//! Allocator-leak tests live separately in ../leak_test.zig.

test {
    _ = @import("core/SmBlitter.zig");
    _ = @import("effects/SmGradient.zig");
    _ = @import("effects/SmPattern.zig");
}
