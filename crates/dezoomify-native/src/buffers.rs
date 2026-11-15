//! Fallible allocation for owned pixel buffers and growing encoder output.
use std::io::{self, Write};

pub(crate) fn allocation_error(error: impl std::fmt::Display) -> dezoomify::model::Error {
    dezoomify::model::Error::ResourceLimit(format!("buffer allocation: {error}").into())
}

pub(crate) fn zeroed(length: u64) -> io::Result<Vec<u8>> {
    let length = usize::try_from(length)
        .map_err(|error| io::Error::new(io::ErrorKind::OutOfMemory, error))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|error| io::Error::new(io::ErrorKind::OutOfMemory, error))?;
    bytes.resize(length, 0);
    Ok(bytes)
}

pub(crate) fn copy(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    result
        .try_reserve_exact(bytes.len())
        .map_err(|error| io::Error::new(io::ErrorKind::OutOfMemory, error))?;
    result.extend_from_slice(bytes);
    Ok(result)
}

#[derive(Default)]
pub(crate) struct Buffer(Vec<u8>);

impl Buffer {
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }
    pub(crate) fn into_vec(self) -> Vec<u8> {
        self.0
    }
}

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.0.capacity() - self.0.len() {
            // Grow geometrically, but retry with only the required capacity.
            let extra = bytes.len().max(self.0.capacity());
            if self.0.try_reserve_exact(extra).is_err() {
                self.0
                    .try_reserve_exact(bytes.len())
                    .map_err(|error| io::Error::new(io::ErrorKind::OutOfMemory, error))?;
            }
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_buffer_returns_an_error() {
        assert!(zeroed(u64::MAX).is_err());
    }
}
