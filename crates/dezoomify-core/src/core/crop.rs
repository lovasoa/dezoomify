//! Pure crop rectangle math for region selection.
//!
//! A crop is one rectangle in level pixels (`x,y,w,h`). All arithmetic is
//! overflow-safe: coordinates widen to `u64` before adding, clamping uses
//! checked subtraction, and byte estimates use checked multiplication. No
//! I/O, clocks, or image decoding happens here; hosts subset their tile
//! plan with [`tile_intersects`] and assemble the cropped canvas from the
//! intersection (see [`crop_intersection`]).

use crate::Vec2d;

/// One region in level pixels. `w` and `h` are sizes, never extents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl CropRect {
    #[must_use]
    pub const fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    /// Right edge as `u64` (never overflows).
    #[must_use]
    pub fn right(&self) -> u64 {
        u64::from(self.x) + u64::from(self.w)
    }

    /// Bottom edge as `u64` (never overflows).
    #[must_use]
    pub fn bottom(&self) -> u64 {
        u64::from(self.y) + u64::from(self.h)
    }
}

/// Parse `x,y,w,h` (level pixels). All four must be decimal integers;
/// `w` and `h` must be non-zero. Values beyond `u32` fail typed.
pub fn parse_crop(raw: &str) -> Result<CropRect, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("invalid --crop value: expected x,y,w,h".to_string());
    }
    let parts: Vec<&str> = trimmed.split(',').collect();
    if parts.len() != 4 {
        return Err(format!("invalid --crop value: '{raw}' (expected x,y,w,h)"));
    }
    let mut values = [0u32; 4];
    for (i, part) in parts.iter().enumerate() {
        let text = part.trim();
        if text.is_empty() {
            return Err(format!("invalid --crop value: '{raw}' (expected x,y,w,h)"));
        }
        if text.starts_with('+') {
            // Reject explicit plus: keep the grammar tight (`x,y,w,h` only).
            return Err(format!("invalid --crop value: '{raw}' (expected x,y,w,h)"));
        }
        let parsed: u32 = text
            .parse()
            .map_err(|_| format!("invalid --crop value: '{raw}' (expected x,y,w,h)"))?;
        values[i] = parsed;
    }
    let rect = CropRect::new(values[0], values[1], values[2], values[3]);
    if rect.w == 0 || rect.h == 0 {
        return Err(format!(
            "invalid --crop value: '{raw}' (width and height must be non-zero)"
        ));
    }
    Ok(rect)
}

/// Clamp a crop to the level canvas. Returns `None` for empty or
/// out-of-bounds crops (origin beyond the canvas). Otherwise the
/// intersection, which keeps the origin and shrinks `w`/`h` to fit.
#[must_use]
pub fn clamp_crop(rect: CropRect, canvas: Vec2d) -> Option<CropRect> {
    if rect.w == 0 || rect.h == 0 {
        return None;
    }
    if canvas.x == 0 || canvas.y == 0 {
        return None;
    }
    if rect.x >= canvas.x || rect.y >= canvas.y {
        return None;
    }
    let w = rect.w.min(canvas.x - rect.x);
    let h = rect.h.min(canvas.y - rect.y);
    if w == 0 || h == 0 {
        return None;
    }
    Some(CropRect::new(rect.x, rect.y, w, h))
}

/// True when the tile rectangle intersects the crop. Overflow-safe via
/// `u64` widening; zero-area tiles never intersect.
#[must_use]
pub fn tile_intersects(
    tile_x: u32,
    tile_y: u32,
    tile_w: u32,
    tile_h: u32,
    crop: &CropRect,
) -> bool {
    if tile_w == 0 || tile_h == 0 || crop.w == 0 || crop.h == 0 {
        return false;
    }
    let tile_right = u64::from(tile_x) + u64::from(tile_w);
    let tile_bottom = u64::from(tile_y) + u64::from(tile_h);
    let crop_right = crop.right();
    let crop_bottom = crop.bottom();
    u64::from(tile_x) < crop_right
        && u64::from(crop.x) < tile_right
        && u64::from(tile_y) < crop_bottom
        && u64::from(crop.y) < tile_bottom
}

/// Intersection of one tile with the crop, for cropped assembly.
///
/// Returns `(src_x, src_y, copy_w, copy_h, dst_x, dst_y)` where `(src_x,
/// src_y, copy_w, copy_h)` is the sub-rectangle inside the tile image and
/// `(dst_x, dst_y)` is its top-left inside the cropped canvas. `tile_w` and
/// `tile_h` are the effective tile extents (already clipped to the tile
/// image and the level). Returns `None` when there is no overlap.
#[must_use]
pub fn crop_intersection(
    tile_x: u32,
    tile_y: u32,
    tile_w: u32,
    tile_h: u32,
    crop: &CropRect,
) -> Option<(u32, u32, u32, u32, u32, u32)> {
    if !tile_intersects(tile_x, tile_y, tile_w, tile_h, crop) {
        return None;
    }
    let tile_right = u64::from(tile_x) + u64::from(tile_w);
    let tile_bottom = u64::from(tile_y) + u64::from(tile_h);
    let crop_right = crop.right();
    let crop_bottom = crop.bottom();
    let ix0 = u64::from(tile_x).max(u64::from(crop.x));
    let iy0 = u64::from(tile_y).max(u64::from(crop.y));
    let ix1 = tile_right.min(crop_right);
    let iy1 = tile_bottom.min(crop_bottom);
    if ix0 >= ix1 || iy0 >= iy1 {
        return None;
    }
    let src_x = u32::try_from(ix0 - u64::from(tile_x)).ok()?;
    let src_y = u32::try_from(iy0 - u64::from(tile_y)).ok()?;
    let copy_w = u32::try_from(ix1 - ix0).ok()?;
    let copy_h = u32::try_from(iy1 - iy0).ok()?;
    let dst_x = u32::try_from(ix0 - u64::from(crop.x)).ok()?;
    let dst_y = u32::try_from(iy0 - u64::from(crop.y)).ok()?;
    if copy_w == 0 || copy_h == 0 {
        return None;
    }
    Some((src_x, src_y, copy_w, copy_h, dst_x, dst_y))
}

/// RGBA byte estimate for a cropped canvas (`w*h*4`, `None` on overflow).
#[must_use]
pub fn crop_byte_estimate(rect: &CropRect) -> Option<u64> {
    u64::from(rect.w)
        .checked_mul(u64::from(rect.h))
        .and_then(|pixels| pixels.checked_mul(4))
}

/// Human size label for live estimates (`800x600`, no byte math).
#[must_use]
pub fn crop_size_label(rect: &CropRect) -> String {
    format!("{}x{}", rect.w, rect.h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_crop() {
        let rect = parse_crop("10,20,300,200").expect("parse");
        assert_eq!(rect, CropRect::new(10, 20, 300, 200));
        let spaced = parse_crop(" 10 , 20 , 300 , 200 ").expect("spaced parse");
        assert_eq!(spaced, rect);
    }

    #[test]
    fn rejects_malformed_and_empty_crops() {
        for bad in [
            "",
            "10,20,300",
            "10,20,300,200,5",
            "a,b,c,d",
            "10,20,0,5",
            "10,20,5,0",
            "+10,20,5,5",
            "10,20,4294967296,5",
        ] {
            assert!(parse_crop(bad).is_err(), "must reject '{bad}'");
        }
    }

    #[test]
    fn clamps_to_canvas_and_rejects_out_of_bounds() {
        let canvas = Vec2d { x: 512, y: 512 };
        let full = clamp_crop(CropRect::new(0, 0, 512, 512), canvas).expect("full fits");
        assert_eq!(full, CropRect::new(0, 0, 512, 512));
        let clipped = clamp_crop(CropRect::new(400, 400, 300, 300), canvas).expect("clipped");
        assert_eq!(clipped, CropRect::new(400, 400, 112, 112));
        assert!(clamp_crop(CropRect::new(512, 0, 10, 10), canvas).is_none());
        assert!(clamp_crop(CropRect::new(0, 512, 10, 10), canvas).is_none());
        assert!(clamp_crop(CropRect::new(0, 0, 0, 10), canvas).is_none());
        assert!(clamp_crop(CropRect::new(u32::MAX, u32::MAX, 10, 10), canvas).is_none());
    }

    #[test]
    fn overflow_safe_edges() {
        // u32::MAX corners must not wrap: widened to u64 before adding.
        let crop = CropRect::new(u32::MAX - 5, u32::MAX - 5, 10, 10);
        assert_eq!(crop.right(), u64::from(u32::MAX) + 5);
        assert!(tile_intersects(u32::MAX - 2, u32::MAX - 2, 4, 4, &crop));
        assert!(!tile_intersects(0, 0, 10, 10, &crop));
        // Byte estimate overflows honestly instead of wrapping.
        let huge = CropRect::new(0, 0, u32::MAX, u32::MAX);
        assert!(crop_byte_estimate(&huge).is_none());
        let small = CropRect::new(0, 0, 800, 600);
        assert_eq!(crop_byte_estimate(&small), Some(800 * 600 * 4));
    }

    #[test]
    fn intersection_maps_source_and_dest() {
        let crop = CropRect::new(100, 100, 200, 200);
        // Fully inside: source origin 0,0 and dest offset from crop origin.
        let inside = crop_intersection(120, 130, 50, 40, &crop).expect("inside");
        assert_eq!(inside, (0, 0, 50, 40, 20, 30));
        // Straddling the left/top edge: source offset, dest at 0,0.
        let edge = crop_intersection(50, 50, 100, 100, &crop).expect("edge");
        assert_eq!(edge, (50, 50, 50, 50, 0, 0));
        // Outside: no intersection.
        assert!(crop_intersection(0, 0, 50, 50, &crop).is_none());
    }
}
