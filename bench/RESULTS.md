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
| 2026-09-03 | 101912d | Apple M3 Pro, aarch64 | zig 0.16.0 ReleaseFast | 0.043–0.064 | 1.04–1.18 | 6.5–6.6 | 8.0–8.2 | 3.0–3.4 | after the range clear, pdq sort and vector src_over (G1–G4); loaded machine — same session as the rows below, interleaved |
| 2026-09-03 | ea0b240 | Apple M3 Pro, aarch64 | zig 0.16.0 ReleaseFast | 0.041 | 0.42–0.46 | 5.2–6.5 | 6.6–6.8 | 4.3–4.5 | analytic coverage converter + row samplers; the pattern row regressed (serial f64 texel walk) |
| 2026-09-03 | c0d127c | Apple M3 Pro, aarch64 | zig 0.16.0 ReleaseFast | 0.041 | 0.41–0.42 | 5.2–6.5 | 6.6–6.8 | 2.08–2.12 | fixed-point four-lane texel walk; end of the M17 pass. `linear`/`radial` here sample exactly (`Sampling.exact`, the bench's setting); with `.lut256` the row samplers index the ramp instead of scanning stops |

The 2026-09-03 rows after the first were taken on a loaded machine
(the solid fill, untouched throughout, reads 0.041 against 0.030 on
the quiet run); compare them with each other, not with the quiet row.
