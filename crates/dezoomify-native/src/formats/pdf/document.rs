//! Native PDF page ownership and publication. Unused objects from incomplete
//! pages remain in the file; only sealed pages enter the final page tree.
use crate::output::{write_failed, StagedFile};
use dezoomify::model::Error;
use pdf_writer::{Pdf, Ref};
use std::{
    io::{BufWriter, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) struct PdfDocument {
    pdf: Option<Pdf<BufWriter<PdfFile>>>,
    next_id: i32,
    pages: Vec<Ref>,
    pub(crate) active: bool,
}

impl PdfDocument {
    pub(crate) fn new(destination: &Path) -> Result<Self, Error> {
        let staging = StagedFile::new(destination)?;
        Ok(Self {
            pdf: Some(Pdf::new(BufWriter::with_capacity(
                32 << 10,
                PdfFile(staging),
            ))),
            next_id: 3,
            pages: Vec::new(),
            active: false,
        })
    }

    pub(crate) fn retained_bytes(&self) -> u64 {
        self.pages.len() as u64 * 128
            + self
                .pdf
                .as_ref()
                .map_or(0, |pdf| pdf.refs().len() as u64 * 32)
    }

    pub(crate) fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub(crate) fn begin_page(&mut self) -> Result<(), Error> {
        if self.active || self.pdf.is_none() {
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

    /// Cancellation is checked between objects so it never leaves a partially
    /// serialized object or poisons the writer needed to finalize earlier pages.
    pub(crate) fn write(
        &mut self,
        cancelled: &AtomicBool,
        write: impl FnOnce(&mut Pdf<BufWriter<PdfFile>>),
    ) -> Result<(), Error> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let pdf = self.pdf.as_mut().expect("unpublished PDF");
        write(pdf);
        pdf.get_ref().get_ref().0.check_error()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        Ok(())
    }

    /// Call after the active page host has settled. Finalization checks retained
    /// serialization and buffered I/O errors before staging can be published.
    pub(crate) fn finish(&mut self, cancelled: &AtomicBool) -> Result<StagedFile, Error> {
        if self.active || self.pages.is_empty() || self.pdf.is_none() {
            return Err(Error::InvalidState(
                "document has an active page, no complete pages, or has finished".into(),
            ));
        }
        self.write(cancelled, |pdf| {
            pdf.catalog(Ref::new(1)).pages(Ref::new(2));
        })?;
        let pages = &self.pages;
        self.pdf
            .as_mut()
            .expect("unpublished PDF")
            .pages(Ref::new(2))
            .kids(pages.iter().copied())
            .count(pages.len() as i32);
        let xref = self.alloc()?;
        let sink = self
            .pdf
            .take()
            .expect("unpublished PDF")
            .finish_with_xref_stream(xref)
            .map_err(|error| write_failed("PDF finalization failed", &error))?
            .into_inner()
            .map_err(|error| write_failed("PDF flush failed", error.error()))?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        sink.0.check_error()?;
        Ok(sink.0)
    }
}

pub(crate) struct PdfFile(StagedFile);

impl Write for PdfFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.writer(&AtomicBool::new(false)).write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.writer(&AtomicBool::new(false)).flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_during_an_object_still_allows_clean_finalization() {
        let directory = tempfile::tempdir().unwrap();
        let mut document = PdfDocument::new(&directory.path().join("pages.pdf")).unwrap();
        let cancelled = AtomicBool::new(false);
        document.begin_page().unwrap();
        let page = document.alloc().unwrap();
        document
            .write(&cancelled, |pdf| {
                pdf.page(page)
                    .parent(Ref::new(2))
                    .media_box(pdf_writer::Rect::new(0.0, 0.0, 16.0, 16.0))
                    .resources();
            })
            .unwrap();
        document.seal_page(page);
        document.begin_page().unwrap();
        let image = document.alloc().unwrap();
        let result = document.write(&cancelled, |pdf| {
            let _stream = pdf.stream(image, &[42; 128 << 10]);
            cancelled.store(true, Ordering::SeqCst);
        });
        assert!(matches!(result, Err(Error::Cancelled)));
        document.active = false;
        let staging = document.finish(&AtomicBool::new(false)).unwrap();
        let pdf = hayro_syntax::Pdf::new(std::fs::read(staging.path()).unwrap()).unwrap();
        assert_eq!(pdf.pages().len(), 1);
    }
}
