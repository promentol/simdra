//! Enums, settings structs, and small color helpers shared by the canvas modules.
//! Names mirror the WebIDL enums exposed by CanvasRenderingContext2D.

pub const ColorSpace = enum {
    srgb,
    display_p3,
};

pub const PixelFormat = enum {
    rgba_unorm8,
    rgba_float16,
};

pub const BitmapSettings = struct {
    colorSpace: ColorSpace = .srgb,
    pixelFormat: PixelFormat = .rgba_unorm8,
};

pub const GetContextSettings = struct {
    alpha: bool = true,
    colorSpace: ColorSpace = .srgb,
    desynchronized: bool = false,
    willReadFrequently: bool = false,
};

pub inline fn packRGBA(r: u8, g: u8, b: u8, a: u8) u32 {
    return @as(u32, r) |
        (@as(u32, g) << 8) |
        (@as(u32, b) << 16) |
        (@as(u32, a) << 24);
}
