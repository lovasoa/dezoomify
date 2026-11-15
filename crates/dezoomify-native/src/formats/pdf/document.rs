//! Native PDF page transactions and publication policy. PDF serialization,
//! object indexing, and byte rollback belong to pdf-writer.
use crate::{
    output::{write_failed, StagedFile},
    Controls,
};
use dezoomify::model::Error;
use pdf_writer::{Pdf, Ref, RollbackWrite};
use std::{
    io::{BufWriter, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Copy)]
pub(crate) struct Checkpoint {
    next_id: i32,
}

pub(crate) struct PdfDocument {
    pdf: Option<Pdf<BufWriter<PdfFile>>>,
    next_id: i32,
    pages: Vec<Ref>,
    pub(crate) active: bool,
    failure: Option<Error>,
}

impl PdfDocument {
    pub(crate) fn new(destination: &Path) -> Result<Self, Error> {
        let staging = StagedFile::new(destination)?;
        let sink = BufWriter::with_capacity(
            32 << 10,
            PdfFile {
                staging,
                controls: None,
            },
        );
        let mut pdf = Pdf::new(sink);
        pdf.flush()
            .map_err(|e| write_failed("PDF creation failed", &e))?;
        Ok(Self {
            pdf: Some(pdf),
            next_id: 3,
            pages: Vec::new(),
            active: false,
            failure: None,
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

    pub(crate) fn set_controls(&mut self, controls: Option<Controls>) {
        self.pdf
            .as_mut()
            .expect("unpublished PDF")
            .get_mut()
            .get_mut()
            .controls = controls;
    }

    pub(crate) fn begin_page(&mut self) -> Result<Checkpoint, Error> {
        self.check()?;
        if self.active || self.pdf.is_none() {
            return Err(Error::InvalidState(
                "document already has an active page or has finished".into(),
            ));
        }
        self.set_controls(None);
        self.pdf
            .as_mut()
            .expect("unpublished PDF")
            .begin_transaction()
            .map_err(|e| write_failed("PDF checkpoint failed", &e))?;
        self.active = true;
        Ok(Checkpoint {
            next_id: self.next_id,
        })
    }

    pub(crate) fn rollback(&mut self, checkpoint: Checkpoint) {
        self.set_controls(None);
        if self.failure.is_none() {
            if let Err(error) = self
                .pdf
                .as_mut()
                .expect("active document")
                .rollback_transaction()
            {
                self.failure = Some(write_failed("PDF rollback failed", &error));
            }
        }
        self.next_id = checkpoint.next_id;
        self.active = false;
    }

    pub(crate) fn seal_page(&mut self, page: Ref) -> Result<(), Error> {
        self.check()?;
        let pdf = self.pdf.as_mut().expect("active document");
        let result = pdf.commit_transaction();
        let file = pdf.get_mut().get_mut();
        file.staging.check_error()?;
        if file.controls.as_ref().is_some_and(Controls::is_cancelled) {
            return Err(Error::Cancelled);
        }
        result.map_err(|e| write_failed("PDF page commit failed", &e))?;
        self.pages.push(page);
        self.active = false;
        Ok(())
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

    /// Real disk failures remain terminal even if the current page is discarded.
    pub(crate) fn write(
        &mut self,
        cancelled: &AtomicBool,
        write: impl FnOnce(&mut Pdf<BufWriter<PdfFile>>),
    ) -> Result<(), Error> {
        self.check()?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let pdf = self.pdf.as_mut().expect("unpublished PDF");
        write(pdf);
        let result = pdf.flush();
        let result = pdf
            .get_mut()
            .get_mut()
            .staging
            .check_error()
            .and_then(|()| {
                if cancelled.load(Ordering::SeqCst) {
                    Err(Error::Cancelled)
                } else {
                    result.map_err(|e| write_failed("PDF object write failed", &e))
                }
            });
        if let Err(error) = &result {
            if !matches!(error, Error::Cancelled) {
                self.failure = Some(error.clone());
            }
        }
        result
    }

    /// Finish only after the active page has sealed or rolled back. Clear page
    /// controls first when cancellation should preserve completed pages.
    pub(crate) fn finish(&mut self, cancelled: &AtomicBool) -> Result<StagedFile, Error> {
        self.check()?;
        if self.active || self.pages.is_empty() || self.pdf.is_none() {
            return Err(Error::InvalidState(
                "document has an active page, no complete pages, or has finished".into(),
            ));
        }
        self.write(cancelled, |pdf| {
            pdf.catalog(Ref::new(1)).pages(Ref::new(2));
        })?;
        let pages = self.pages.clone();
        self.write(cancelled, |pdf| {
            pdf.pages(Ref::new(2))
                .kids(pages.iter().copied())
                .count(pages.len() as i32);
        })?;
        let xref = self.alloc()?;
        let sink = self
            .pdf
            .take()
            .expect("unpublished PDF")
            .finish_with_xref_stream(xref)
            .map_err(|error| {
                match error
                    .get_ref()
                    .and_then(|cause| cause.downcast_ref::<Error>())
                {
                    Some(Error::Cancelled) => Error::Cancelled,
                    _ => write_failed("PDF finalization failed", &error),
                }
            })?;
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::Cancelled);
        }
        let sink = sink
            .into_inner()
            .map_err(|e| write_failed("PDF flush failed", e.error()))?;
        sink.staging.check_error()?;
        Ok(sink.staging)
    }
}

pub(crate) struct PdfFile {
    staging: StagedFile,
    controls: Option<Controls>,
}

impl Write for PdfFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let uncancelled = AtomicBool::new(false);
        let cancelled = self
            .controls
            .as_ref()
            .map_or(&uncancelled, Controls::cancel_flag);
        self.staging
            .writer(cancelled)
            .write(&bytes[..bytes.len().min(64 << 10)])
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let uncancelled = AtomicBool::new(false);
        let cancelled = self
            .controls
            .as_ref()
            .map_or(&uncancelled, Controls::cancel_flag);
        self.staging.writer(cancelled).flush()
    }
}

impl RollbackWrite for PdfFile {
    fn rollback_to(&mut self, position: u64) -> std::io::Result<()> {
        self.staging
            .truncate(position)
            .map_err(std::io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_page_commit_preserves_completed_pages() {
        let directory = tempfile::tempdir().unwrap();
        let mut document = PdfDocument::new(&directory.path().join("pages.pdf")).unwrap();
        for cancel in [false, true] {
            let checkpoint = document.begin_page().unwrap();
            let controls = Controls::default();
            document.set_controls(Some(controls.clone()));
            let id = document.alloc().unwrap();
            document
                .write(controls.cancel_flag(), |pdf| {
                    pdf.page(id)
                        .parent(Ref::new(2))
                        .media_box(pdf_writer::Rect::new(0.0, 0.0, 16.0, 16.0))
                        .resources();
                })
                .unwrap();
            if cancel {
                controls.cancel();
                assert!(matches!(document.seal_page(id), Err(Error::Cancelled)));
                document.rollback(checkpoint);
            } else {
                document.seal_page(id).unwrap();
            }
        }
        let staging = document.finish(&AtomicBool::new(false)).unwrap();
        let pdf = hayro_syntax::Pdf::new(std::fs::read(staging.path()).unwrap()).unwrap();
        assert_eq!(pdf.pages().len(), 1);
    }
}
