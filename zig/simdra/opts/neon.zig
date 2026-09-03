//! aarch64 / NEON backend.
//!
//! `simd.zig` selects this file on aarch64 builds. The tuned kernels live
//! in `vec_blend.zig` as portable `@Vector` code (no `asm`) and are
//! exported from here; everything else inherits from `generic.zig`
//! through the explicit re-exports below, so the two backends always
//! expose the same names.
//!
//! The rule for a tuned kernel: it agrees with the generic one within
//! ±1 LSB per channel, and `tolerance_test.zig` proves it by running both
//! in one binary over random rows (translucent and zero-alpha
//! destinations included). Byte equality is not required — the
//! reciprocal un-premultiply and the exact-shift `/255` are what make the
//! kernels fallback-free — but untouched pixels (zero source alpha, zero
//! coverage, a zero mask) keep their bytes.
//!
//! Tuned today: the src_over family (solid, coverage, per-pixel row), the
//! separable blend family multiply / screen / darken / lighten /
//! difference / exclusion / hard_light / overlay in all three shapes,
//! Flash subtract, and add's coverage and row kernels. Left scalar:
//! colour dodge/burn, soft light and the HSL modes (per-channel divides
//! or floats; not reachable from SWF), the Porter-Duff operators other
//! than src_over, and Flash invert/alpha/erase.
//!
//! Apple Silicon (and any ARMv8.4-A) has FP16 + dotprod always available;
//! `copyU32ToFloat16Norm` below relies on FP16. Cortex-A53 splits every
//! 32-lane u16 op into 64-bit halves, which is what the 8-pixel chunk
//! width in vec_blend.zig was chosen against.

const generic = @import("generic.zig");
const vec_blend = @import("vec_blend.zig");

// --- u32 RGBA → f16 RGBA with /255 normalization ---------------------------
// Lane plan per chunk (N = 8 pixels):
//   src   : @Vector(8, u32)               // 8 RGBA pixels packed
//   bytes : @Vector(32, u8)  = @bitCast   // R0,G0,B0,A0,R1,G1,B1,A1,...
//   wide  : @Vector(32, f32) = @floatFromInt   // → NEON `uxtl` + `ucvtf`
//   norm  : wide * splat(1/255)
//   half  : @Vector(32, f16) = @floatCast      // → NEON `fcvtn` (FP16 ext)
// Replaces the scalar generic version one-to-one — `raster.zig` doesn't
// know which path it gets.
pub const Float16ChunkPixels = 8;

pub fn copyU32ToFloat16Norm(dst: []f16, src: []const u32) void {
    const std = @import("std");
    std.debug.assert(dst.len == src.len * 4);
    const N = Float16ChunkPixels;
    const components = N * 4;
    const inv_255_v: @Vector(components, f32) = @splat(@as(f32, 1.0 / 255.0));

    var i: usize = 0;
    while (i + N <= src.len) : (i += N) {
        const px: @Vector(N, u32) = src[i..][0..N].*;
        const bytes: @Vector(components, u8) = @bitCast(px);
        const wide: @Vector(components, f32) = @floatFromInt(bytes);
        const norm = wide * inv_255_v;
        const half: @Vector(components, f16) = @floatCast(norm);
        dst[i * 4 ..][0..components].* = half;
    }

    // Scalar tail for the final < N pixels.
    const inv_255: f32 = 1.0 / 255.0;
    while (i < src.len) : (i += 1) {
        const px = src[i];
        const r: u8 = @truncate(px);
        const g: u8 = @truncate(px >> 8);
        const b: u8 = @truncate(px >> 16);
        const a: u8 = @truncate(px >> 24);
        const base = i * 4;
        dst[base + 0] = @floatCast(@as(f32, @floatFromInt(r)) * inv_255);
        dst[base + 1] = @floatCast(@as(f32, @floatFromInt(g)) * inv_255);
        dst[base + 2] = @floatCast(@as(f32, @floatFromInt(b)) * inv_255);
        dst[base + 3] = @floatCast(@as(f32, @floatFromInt(a)) * inv_255);
    }
}

// --- Inherited from generic (no NEON-specific tuning yet) ------------------

pub const ChunkSize = generic.ChunkSize;
pub const Chunk = generic.Chunk;
pub const SrcOverChunkPixels = generic.SrcOverChunkPixels;

pub const fillU32 = generic.fillU32;
pub const copyU32 = generic.copyU32;
pub const clipCombineU8 = generic.clipCombineU8;
pub const blendSrcOverU32 = vec_blend.blendSrcOverU32;
pub const blendSrcOverCovU32 = vec_blend.blendSrcOverCovU32;
pub const blendAddU32 = generic.blendAddU32;

pub const blendSrcInU32 = generic.blendSrcInU32;
pub const blendSrcOutU32 = generic.blendSrcOutU32;
pub const blendSrcAtopU32 = generic.blendSrcAtopU32;
pub const blendDstOverU32 = generic.blendDstOverU32;
pub const blendDstInU32 = generic.blendDstInU32;
pub const blendDstOutU32 = generic.blendDstOutU32;
pub const blendDstAtopU32 = generic.blendDstAtopU32;
pub const blendXorU32 = generic.blendXorU32;
pub const blendMultiplyU32 = vec_blend.blendMultiplyU32;
pub const blendScreenU32 = vec_blend.blendScreenU32;
pub const blendOverlayU32 = vec_blend.blendOverlayU32;
pub const blendDarkenU32 = vec_blend.blendDarkenU32;
pub const blendLightenU32 = vec_blend.blendLightenU32;
pub const blendColorDodgeU32 = generic.blendColorDodgeU32;
pub const blendColorBurnU32 = generic.blendColorBurnU32;
pub const blendHardLightU32 = vec_blend.blendHardLightU32;
pub const blendSoftLightU32 = generic.blendSoftLightU32;
pub const blendDifferenceU32 = vec_blend.blendDifferenceU32;
pub const blendExclusionU32 = vec_blend.blendExclusionU32;
pub const blendHueU32 = generic.blendHueU32;
pub const blendSaturationU32 = generic.blendSaturationU32;
pub const blendColorU32 = generic.blendColorU32;
pub const blendLuminosityU32 = generic.blendLuminosityU32;

// Coverage variants — one per non-fast-path blend mode.
pub const blendSrcInCovU32 = generic.blendSrcInCovU32;
pub const blendSrcOutCovU32 = generic.blendSrcOutCovU32;
pub const blendSrcAtopCovU32 = generic.blendSrcAtopCovU32;
pub const blendDstOverCovU32 = generic.blendDstOverCovU32;
pub const blendDstInCovU32 = generic.blendDstInCovU32;
pub const blendDstOutCovU32 = generic.blendDstOutCovU32;
pub const blendDstAtopCovU32 = generic.blendDstAtopCovU32;
pub const blendXorCovU32 = generic.blendXorCovU32;
pub const blendAddCovU32 = vec_blend.blendAddCovU32;
pub const blendMultiplyCovU32 = vec_blend.blendMultiplyCovU32;
pub const blendScreenCovU32 = vec_blend.blendScreenCovU32;
pub const blendOverlayCovU32 = vec_blend.blendOverlayCovU32;
pub const blendDarkenCovU32 = vec_blend.blendDarkenCovU32;
pub const blendLightenCovU32 = vec_blend.blendLightenCovU32;
pub const blendColorDodgeCovU32 = generic.blendColorDodgeCovU32;
pub const blendColorBurnCovU32 = generic.blendColorBurnCovU32;
pub const blendHardLightCovU32 = vec_blend.blendHardLightCovU32;
pub const blendSoftLightCovU32 = generic.blendSoftLightCovU32;
pub const blendDifferenceCovU32 = vec_blend.blendDifferenceCovU32;
pub const blendExclusionCovU32 = vec_blend.blendExclusionCovU32;
pub const blendHueCovU32 = generic.blendHueCovU32;
pub const blendSaturationCovU32 = generic.blendSaturationCovU32;
pub const blendColorCovU32 = generic.blendColorCovU32;
pub const blendLuminosityCovU32 = generic.blendLuminosityCovU32;

// BGRA-destination non-separable variants + R/B swizzle (color-type support).
pub const blendHueBgraU32 = generic.blendHueBgraU32;
pub const blendSaturationBgraU32 = generic.blendSaturationBgraU32;
pub const blendColorBgraU32 = generic.blendColorBgraU32;
pub const blendLuminosityBgraU32 = generic.blendLuminosityBgraU32;
pub const blendHueCovBgraU32 = generic.blendHueCovBgraU32;
pub const blendSaturationCovBgraU32 = generic.blendSaturationCovBgraU32;
pub const blendColorCovBgraU32 = generic.blendColorCovBgraU32;
pub const blendLuminosityCovBgraU32 = generic.blendLuminosityCovBgraU32;
pub const swizzleRB = generic.swizzleRB;
pub const swizzleRBCopyU32 = generic.swizzleRBCopyU32;

// Flash (SWF) blend modes — subtract/invert/alpha/erase (PlaceObject3).
pub const blendFlashSubtractU32 = vec_blend.blendFlashSubtractU32;
pub const blendFlashInvertU32 = generic.blendFlashInvertU32;
pub const blendFlashAlphaU32 = generic.blendFlashAlphaU32;
pub const blendFlashEraseU32 = generic.blendFlashEraseU32;
pub const blendFlashSubtractCovU32 = vec_blend.blendFlashSubtractCovU32;
pub const blendFlashInvertCovU32 = generic.blendFlashInvertCovU32;
pub const blendFlashAlphaCovU32 = generic.blendFlashAlphaCovU32;
pub const blendFlashEraseCovU32 = generic.blendFlashEraseCovU32;
pub const colorMatrixU32 = generic.colorMatrixU32;

pub const sampleImageNearestRow = generic.sampleImageNearestRow;
pub const sampleImageBilinearRow = generic.sampleImageBilinearRow;
pub const NearestSampleChunkPixels = generic.NearestSampleChunkPixels;

pub const boxBlurAlphaH = generic.boxBlurAlphaH;
pub const boxBlurAlphaV = generic.boxBlurAlphaV;
pub const gaussianBlurAlpha = generic.gaussianBlurAlpha;
pub const gaussianBlurU32 = generic.gaussianBlurU32;
pub const brightnessU32 = generic.brightnessU32;
pub const contrastU32 = generic.contrastU32;

// Per-pixel-source row family (see generic.zig).
pub const lerpU32 = generic.lerpU32;
pub const blendSrcRowU32 = generic.blendSrcRowU32;
pub const blendSrcOverRowU32 = vec_blend.blendSrcOverRowU32;
pub const blendSrcInRowU32 = generic.blendSrcInRowU32;
pub const blendSrcOutRowU32 = generic.blendSrcOutRowU32;
pub const blendSrcAtopRowU32 = generic.blendSrcAtopRowU32;
pub const blendDstOverRowU32 = generic.blendDstOverRowU32;
pub const blendDstInRowU32 = generic.blendDstInRowU32;
pub const blendDstOutRowU32 = generic.blendDstOutRowU32;
pub const blendDstAtopRowU32 = generic.blendDstAtopRowU32;
pub const blendXorRowU32 = generic.blendXorRowU32;
pub const blendAddRowU32 = vec_blend.blendAddRowU32;
pub const blendMultiplyRowU32 = vec_blend.blendMultiplyRowU32;
pub const blendScreenRowU32 = vec_blend.blendScreenRowU32;
pub const blendOverlayRowU32 = vec_blend.blendOverlayRowU32;
pub const blendDarkenRowU32 = vec_blend.blendDarkenRowU32;
pub const blendLightenRowU32 = vec_blend.blendLightenRowU32;
pub const blendColorDodgeRowU32 = generic.blendColorDodgeRowU32;
pub const blendColorBurnRowU32 = generic.blendColorBurnRowU32;
pub const blendHardLightRowU32 = vec_blend.blendHardLightRowU32;
pub const blendSoftLightRowU32 = generic.blendSoftLightRowU32;
pub const blendDifferenceRowU32 = vec_blend.blendDifferenceRowU32;
pub const blendExclusionRowU32 = vec_blend.blendExclusionRowU32;
pub const blendHueRowU32 = generic.blendHueRowU32;
pub const blendSaturationRowU32 = generic.blendSaturationRowU32;
pub const blendColorRowU32 = generic.blendColorRowU32;
pub const blendLuminosityRowU32 = generic.blendLuminosityRowU32;
pub const blendFlashSubtractRowU32 = vec_blend.blendFlashSubtractRowU32;
pub const blendFlashInvertRowU32 = generic.blendFlashInvertRowU32;
pub const blendFlashAlphaRowU32 = generic.blendFlashAlphaRowU32;
pub const blendFlashEraseRowU32 = generic.blendFlashEraseRowU32;
pub const blendHueRowBgraU32 = generic.blendHueRowBgraU32;
pub const blendSaturationRowBgraU32 = generic.blendSaturationRowBgraU32;
pub const blendColorRowBgraU32 = generic.blendColorRowBgraU32;
pub const blendLuminosityRowBgraU32 = generic.blendLuminosityRowBgraU32;
