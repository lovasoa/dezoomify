//! Streaming PDF object storage and final page tree. Payloads and cross-reference
//! offsets live on disk; only the small page list remains until publication.
use crate::{
    output::{write_failed, StagedFile},
    tile_budget::memory_check,
};
use dezoomify::model::Error;
use pdf_writer::{Chunk, Name, Ref};
use std::{
    fs::File,
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::AtomicBool,
};

#[derive(Clone, Copy)]
pub(crate) struct Checkpoint {
    position: u64,
    next_id: i32,
}

pub(crate) struct PdfDocument {
    staging: Option<StagedFile>,
    offsets: File,
    position: u64,
    next_id: i32,
    pages: Vec<Ref>,
    budget: u64,
    pub(crate) active: bool,
    failure: Option<Error>,
}

impl PdfDocument {
    pub(crate) fn new(destination: &Path, budget: u64) -> Result<Self, Error> {
        let mut staging = StagedFile::new(destination)?;
        let header = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
        staging
            .writer(&AtomicBool::new(false))
            .write_all(header)
            .map_err(|e| write_failed("PDF header failed", &e))?;
        let offsets = tempfile::tempfile_in(staging.path().parent().expect("staging parent"))
            .map_err(|e| write_failed("PDF index creation failed", &e))?;
        Ok(Self {
            staging: Some(staging),
            offsets,
            position: header.len() as u64,
            next_id: 3,
            pages: Vec::new(),
            budget,
            active: false,
            failure: None,
        })
    }

    pub(crate) fn retained_bytes(&self) -> u64 {
        self.pages.len() as u64 * 128
    }
    pub(crate) fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub(crate) fn begin_page(&mut self) -> Result<Checkpoint, Error> {
        self.check()?;
        if self.active || self.staging.is_none() {
            return Err(Error::InvalidState(
                "document already has an active page or has finished".into(),
            ));
        }
        memory_check(self.retained_bytes() + 128, self.budget)?;
        self.active = true;
        Ok(Checkpoint {
            position: self.position,
            next_id: self.next_id,
        })
    }

    pub(crate) fn rollback(&mut self, checkpoint: Checkpoint) {
        let result = self
            .staging
            .as_mut()
            .expect("active document")
            .truncate(checkpoint.position);
        if let Err(error) = result {
            self.failure = Some(error);
        }
        self.position = checkpoint.position;
        self.next_id = checkpoint.next_id;
        self.active = false;
    }

    pub(crate) fn seal_page(&mut self, page: Ref) {
        self.pages.push(page);
        self.active = false;
    }

    pub(crate) fn alloc(&mut self) -> Result<Ref, Error> {
        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or_else(|| Error::ResourceLimit("PDF object count exceeded".into()))?;
        Ok(Ref::new(id))
    }

    fn check(&self) -> Result<(), Error> {
        self.failure.clone().map_or(Ok(()), Err)
    }

    fn record_offset(&mut self, id: Ref) -> Result<(), Error> {
        self.offsets
            .seek(SeekFrom::Start(id.get() as u64 * 8))
            .and_then(|_| self.offsets.write_all(&self.position.to_be_bytes()))
            .map_err(|e| write_failed("PDF index write failed", &e))
    }

    /// Each chunk must contain exactly this one indirect object. IDs are allocated
    /// by this document; callers release the chunk immediately after writing it.
    pub(crate) fn write(
        &mut self,
        id: Ref,
        chunk: &Chunk,
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        self.check()?;
        self.record_offset(id)?;
        let staging = self.staging.as_mut().expect("unpublished PDF");
        let result = (|| {
            let mut writer = staging.writer(cancelled);
            for bytes in chunk.as_bytes().chunks(64 << 10) {
                writer.write_all(bytes)?;
            }
            Ok::<_, std::io::Error>(())
        })();
        staging.check_error()?;
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result.map_err(|e| write_failed("PDF object write failed", &e))?;
        self.position += chunk.len() as u64;
        Ok(())
    }

    /// Finish only after the active page has sealed or rolled back. The caller
    /// chooses whether cancellation should preserve already completed pages.
    pub(crate) fn finish(&mut self, cancelled: &AtomicBool) -> Result<StagedFile, Error> {
        self.check()?;
        if self.active || self.pages.is_empty() || self.staging.is_none() {
            return Err(Error::InvalidState(
                "document has an active page, no complete pages, or has finished".into(),
            ));
        }
        let mut catalog = Chunk::new();
        catalog
            .indirect(Ref::new(1))
            .dict()
            .pair(Name(b"Type"), Name(b"Catalog"))
            .pair(Name(b"Pages"), Ref::new(2));
        self.write(Ref::new(1), &catalog, cancelled)?;
        let mut tree = Chunk::new();
        tree.pages(Ref::new(2))
            .kids(self.pages.iter().copied())
            .count(self.pages.len() as i32);
        self.write(Ref::new(2), &tree, cancelled)?;
        self.write_xref(cancelled)?;
        Ok(self.staging.take().expect("finished PDF"))
    }

    fn write_xref(&mut self, cancelled: &AtomicBool) -> Result<(), Error> {
        let id = self.alloc()?;
        self.record_offset(id)?;
        let size = u64::from(id.get() as u32) + 1;
        let start = self.position;
        let staging = self.staging.as_mut().expect("unpublished PDF");
        let result = (|| {
            let mut writer = BufWriter::with_capacity(64 << 10, staging.writer(cancelled));
            write!(writer, "{} 0 obj\n<< /Type /XRef /Size {size} /Root 1 0 R /W [1 8 2] /Length {} >>\nstream\n", id.get(), size * 11)?;
            writer.write_all(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255])?;
            self.offsets.seek(SeekFrom::Start(8))?;
            let mut offset = [0; 8];
            for _ in 1..size {
                self.offsets.read_exact(&mut offset)?;
                writer.write_all(&[1])?;
                writer.write_all(&offset)?;
                writer.write_all(&[0, 0])?;
            }
            write!(writer, "\nendstream\nendobj\nstartxref\n{start}\n%%EOF\n")?;
            writer.flush()
        })();
        staging.check_error()?;
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        result.map_err(|e| write_failed("PDF cross-reference write failed", &e))
    }
}
