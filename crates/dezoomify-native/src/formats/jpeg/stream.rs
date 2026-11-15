use crate::pixel_pipe::{PixelPipe, PixelStrip};
use dezoomify::model::Error;
use std::cell::{Cell, RefCell};

/// image's JPEG encoder finishes full-width eight-row bands in order.
/// Only advancing to the next strip synchronizes with the producer.
pub(super) struct JpegView<'a> {
    pipe: &'a PixelPipe,
    current: RefCell<PixelStrip>,
    failed: Cell<bool>,
}
impl<'a> JpegView<'a> {
    pub(super) fn new(pipe: &'a PixelPipe) -> Result<Self, Error> {
        let current = pipe
            .receive()?
            .ok_or_else(|| Error::Internal("empty pixel stream".into()))?;
        Ok(Self {
            pipe,
            current: RefCell::new(current),
            failed: Cell::new(false),
        })
    }
    pub(super) fn finish(&self) {
        self.pipe.consumed_strip(&self.current.borrow());
    }
    fn advance(&self, y: u32) -> Result<(), Error> {
        let mut current = self.current.borrow_mut();
        self.pipe.consumed_strip(&current);
        let next = self
            .pipe
            .receive()?
            .ok_or_else(|| Error::Internal("JPEG exceeded pixel stream".into()))?;
        if y != next.first_row {
            return Err(Error::Internal("JPEG traversal skipped a strip".into()));
        }
        *current = next;
        Ok(())
    }
}
impl image::GenericImageView for JpegView<'_> {
    type Pixel = image::Rgb<u8>;
    fn dimensions(&self) -> (u32, u32) {
        (self.pipe.size.width, self.pipe.size.height)
    }
    #[inline]
    fn get_pixel(&self, x: u32, y: u32) -> Self::Pixel {
        if self.failed.get() {
            return image::Rgb([0; 3]);
        }
        let strip = self.current.borrow();
        if y < strip.first_row {
            drop(strip);
            self.failed.set(true);
            self.pipe
                .fail(Error::Internal("JPEG revisited a released strip".into()));
            return image::Rgb([0; 3]);
        }
        if y >= strip.first_row + strip.rows {
            drop(strip);
            if let Err(error) = self.advance(y) {
                self.failed.set(true);
                self.pipe.fail(error);
                return image::Rgb([0; 3]);
            }
            return self.get_pixel(x, y);
        }
        let offset =
            ((y - strip.first_row) as usize * self.pipe.size.width as usize + x as usize) * 4;
        let rgb = &strip.rgba[offset..offset + 3];
        image::Rgb([rgb[0], rgb[1], rgb[2]])
    }
}
