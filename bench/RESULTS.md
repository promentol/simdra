# Bench results

`zig build bench -Doptimize=ReleaseFast` (zig/bench.zig): 800×600, five
warm-ups, thirty timed runs, milliseconds per operation. The first row is
the historical JS-facade number from `bench/run.js` (node-zigar native
leg vs `@napi-rs/canvas`), kept for scale; the JS harness is parked until
node-zigar supports Zig 0.16.

| date | commit | machine | toolchain | solid | path | linear | radial | pattern | notes |
|---|---|---|---|---|---|---|---|---|---|
| 2026-08 | 93b61db | Apple M3 Pro | node-zigar 0.15.2 | — | — | 7.1 (Skia 1.4) | — | — | JS facade, `npm run bench` |
| 2026-09-03 | 93b61db | Apple M3 Pro, aarch64 | zig 0.16.0 ReleaseFast | 0.030 | 1.472 | 4.861 | 5.928 | 2.294 | Zig bench, before the analytic/NEON pass |
