//! Streaming PDF object storage and final page tree. Objects from incomplete
//! pages remain unused in the file; only sealed pages enter the page tree.
use crate::output::{write_failed, StagedFile};
use dezoomify::model::Error;
use pdf_writer::{Chunk, Name, Ref};
use std::{
    io::{BufWriter, Write},
    path::Path,
    sync::atomic::AtomicBool,
};

pub(crate) struct PdfDocument {
    staging: Option<StagedFile>,
    offsets: Vec<u64>,
    position: u64,
    next_id: i32,
    pages: Vec<Ref>,
    pub(crate) active: bool,
}

impl PdfDocument {
    pub(crate) fn new(destination: &Path) -> Result<Self, Error> {
        let mut staging = StagedFile::new(destination)?;
        let header = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
        staging
            .writer(&AtomicBool::new(false))
            .write_all(header)
            .map_err(|e| write_failed("PDF header failed", &e))?;
        Ok(Self {
            staging: Some(staging),
            offsets: Vec::new(),
            position: header.len() as u64,
            next_id: 3,
            pages: Vec::new(),
            active: false,
        })
    }

    pub(crate) fn retained_bytes(&self) -> u64 {
        (self.pages.len() * 128 + self.offsets.len() * 8) as u64
    }
    pub(crate) fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub(crate) fn begin_page(&mut self) -> Result<(), Error> {
        if self.active || self.staging.is_none() {
            return Err(Error::InvalidState(
                "document already has an active page or has finished".into(),
            ));
        }

        self.active = true;
        Ok(())
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

    fn record_offset(&mut self, id: Ref) {
        let index = id.get() as usize;
        if self.offsets.len() <= index {
            self.offsets.resize(index + 1, 0);
        }
        self.offsets[index] = self.position;
    }

    /// Each chunk must contain exactly this one indirect object. IDs are allocated
    /// by this document; callers release the chunk immediately after writing it.
    /// Cancellation takes effect between objects to preserve a valid PDF suffix.
    pub(crate) fn write(
        &mut self,
        id: Ref,
        chunk: &Chunk,
        cancelled: &AtomicBool,
    ) -> Result<(), Error> {
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        self.record_offset(id);
        let staging = self.staging.as_mut().expect("unpublished PDF");
        let result = (|| {
            let uncancelled = AtomicBool::new(false);
            let mut writer = staging.writer(&uncancelled);
            for bytes in chunk.as_bytes().chunks(64 << 10) {
                writer.write_all(bytes)?;
            }
            Ok::<_, std::io::Error>(())
        })();
        staging.check_error()?;
        result.map_err(|e| write_failed("PDF object write failed", &e))?;
        self.position += chunk.len() as u64;
        if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        Ok(())
    }

    /// Finish only after the active page host has settled. The caller
    /// chooses whether cancellation should preserve already completed pages.
    pub(crate) fn finish(&mut self, cancelled: &AtomicBool) -> Result<StagedFile, Error> {
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
        self.record_offset(id);
        let size = u64::from(id.get() as u32) + 1;
        let start = self.position;
        let staging = self.staging.as_mut().expect("unpublished PDF");
        let result = (|| {
            let mut writer = BufWriter::with_capacity(64 << 10, staging.writer(cancelled));
            write!(writer, "{} 0 obj\n<< /Type /XRef /Size {size} /Root 1 0 R /W [1 8 2] /Length {} >>\nstream\n", id.get(), size * 11)?;
            writer.write_all(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255])?;
            for offset in &self.offsets[1..size as usize] {
                writer.write_all(&[u8::from(*offset != 0)])?;
                writer.write_all(&offset.to_be_bytes())?;
                writer.write_all(if *offset == 0 { &[255, 255] } else { &[0, 0] })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_an_object_still_allows_clean_finalization() {
        let directory = tempfile::tempdir().unwrap();
        let mut document = PdfDocument::new(&directory.path().join("pages.pdf")).unwrap();
        let cancelled = AtomicBool::new(false);
        document.begin_page().unwrap();
        let page = document.alloc().unwrap();
        let mut chunk = Chunk::new();
        chunk
            .page(page)
            .parent(Ref::new(2))
            .media_box(pdf_writer::Rect::new(0.0, 0.0, 16.0, 16.0))
            .resources();
        document.write(page, &chunk, &cancelled).unwrap();
        document.seal_page(page);
        document.begin_page().unwrap();
        let image = document.alloc().unwrap();
        let mut chunk = Chunk::new();
        chunk.stream(image, &[42; 128 << 10]);
        cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(
            document.write(image, &chunk, &cancelled),
            Err(Error::Cancelled)
        ));
        document.active = false;
        let staging = document.finish(&AtomicBool::new(false)).unwrap();
        let pdf = hayro_syntax::Pdf::new(std::fs::read(staging.path()).unwrap()).unwrap();
        assert_eq!(pdf.pages().len(), 1);
    }
}
