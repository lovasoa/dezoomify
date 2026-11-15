//! Encoders consume completed regions while acquisition continues. Composition
//! uses adaptive storage; buffered codecs still require the complete RGBA image.
use crate::{host::Controls, output::StagedFile, pixel_pipe::PixelPipe};
use dezoomify::model::{Error, OutputFormat, OutputGrid, Size};
use std::{
    io::{Seek, Write},
    path::Path,
    sync::Arc,
};

/// Dropping requests cancellation but cannot join the blocking encoder. The host
/// must consume this through `wait` or `abort` before releasing job resources.
#[must_use]
pub(crate) struct EncoderTask {
    pub(crate) pipe: Arc<PixelPipe>,
    task: Option<tokio::task::JoinHandle<Result<StagedFile, Error>>>,
}

impl EncoderTask {
    pub(crate) fn start(
        destination: &Path,
        size: Size,
        grid: Option<&OutputGrid>,
        format: OutputFormat,
        compression: u8,
        controls: Controls,
    ) -> Result<Self, Error> {
        if size.width == 0 || size.height == 0 {
            return Err(Error::InvalidState("empty raster dimensions".into()));
        }
        crate::imaging::check_dimensions(format, &size)?;
        let encoder = crate::formats::raster_encoder(format, compression)?;
        let grid = encoder.grid(&size, grid)?;

        let directory = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let pipe = PixelPipe::with_grid(size, directory, grid.as_ref())?;
        let staging = StagedFile::new(destination)?;
        controls.watch(&pipe);
        let reader = Arc::clone(&pipe);
        let task = tokio::task::spawn_blocking(move || {
            let result = encoder.encode(staging, &reader, &controls);
            let result = reader.error().map_or(result, Err);
            if let Err(error) = &result {
                reader.fail(error.clone());
            }
            result
        });
        Ok(Self {
            pipe,
            task: Some(task),
        })
    }
    pub(crate) async fn wait(mut self) -> Result<StagedFile, Error> {
        self.task
            .take()
            .expect("encoder task")
            .await
            .map_err(|_| Error::Internal("image encoder task failed".into()))?
    }
    pub(crate) async fn abort(mut self) {
        self.pipe.fail(Error::Cancelled);
        let _ = self.task.take().expect("encoder task").await;
    }
}
impl Drop for EncoderTask {
    fn drop(&mut self) {
        if self.task.is_some() {
            self.pipe.fail(Error::Cancelled);
        }
    }
}

pub(crate) struct PipeWriter<W> {
    pub(crate) inner: W,
    pub(crate) pipe: Arc<PixelPipe>,
}
impl<W> PipeWriter<W> {
    fn check(&self) -> std::io::Result<()> {
        if self.pipe.error().is_some() {
            Err(std::io::Error::other("pixel source failed"))
        } else {
            Ok(())
        }
    }
}
impl<W: Write> Write for PipeWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.check()?;
        self.inner.write(bytes).inspect_err(|error| {
            self.pipe.fail(crate::output::write_failed(
                "image output write failed",
                error,
            ))
        })
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.check()?;
        self.inner.flush().inspect_err(|error| {
            self.pipe.fail(crate::output::write_failed(
                "image output flush failed",
                error,
            ))
        })
    }
}
impl<W: Seek> Seek for PipeWriter<W> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.check()?;
        self.inner.seek(pos)
    }
}
#[cfg(test)]
pub(crate) mod tests;
