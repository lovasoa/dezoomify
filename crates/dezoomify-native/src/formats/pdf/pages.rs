//! One native multi-page PDF. Page hosts own acquisition and
//! settlement; the caller closes the document after their workers have stopped.
use crate::{
    formats::pdf::document::PdfDocument,
    output::{self, StagedOutput},
    OutputTarget,
};
use dezoomify::model::{Error, OutputFormat};
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex, MutexGuard},
};

/// Owns the unpublished PDF across fresh image Hosts. Dropping it removes
/// staging after the last page handle is released. Call `finish` after settling
/// all hosts, even after cancellation, to preserve completed pages.
pub struct OutputDocument {
    writer: Arc<Mutex<PdfDocument>>,
    target: OutputTarget,
    overwrite: bool,
}

/// The actual shared file, available only after document finalization succeeds.
pub struct DocumentPublication {
    pub path: PathBuf,
    pub pages: usize,
    pub encoded_bytes: u64,
}

/// Exclusive page lease. Move it into one fresh NativeHost; dropping an
/// unsealed lease leaves its objects unused. Never finalize while a host owns it.
pub struct DocumentPage {
    pub(crate) writer: Arc<Mutex<PdfDocument>>,
    sealed: bool,
}

impl OutputDocument {
    /// Validate the destination before acquisition. Automatic output names use
    /// the normal collision policy; the target must select PDF.
    pub fn new(target: OutputTarget, overwrite: bool) -> Result<Self, Error> {
        let format = match &target {
            OutputTarget::File(path) => output::infer_from_path(path)?,
            OutputTarget::AutoDir { format, .. } => *format,
            OutputTarget::AutoImageDir { .. } => {
                return Err(Error::InvalidInput(
                    "a document requires an explicit output format".into(),
                ))
            }
        };
        if format != OutputFormat::Pdf {
            return Err(Error::InvalidInput(
                "a PDF document requires a PDF destination".into(),
            ));
        }
        let destination = output::destination_for(&target, None, format);
        output::validate_destination(&destination, &format, overwrite)?;
        let writer = PdfDocument::new(&destination)?;
        Ok(Self {
            writer: Arc::new(Mutex::new(writer)),
            target,
            overwrite,
        })
    }

    /// Acquire one page; the previous page host must have settled first.
    pub fn page(&mut self) -> Result<DocumentPage, Error> {
        self.writer.lock().map_err(poisoned)?.begin_page()?;
        Ok(DocumentPage {
            writer: Arc::clone(&self.writer),
            sealed: false,
        })
    }

    /// Close and publish complete pages, including after cooperative cancellation.
    /// This performs blocking I/O and must run after every page host has settled.
    /// No completed pages means no file. Publication failures preserve no output.
    pub fn finish(self) -> Result<Option<DocumentPublication>, Error> {
        let mut writer = self.writer.lock().map_err(poisoned)?;
        if writer.active {
            return Err(Error::InvalidState(
                "settle the page host before closing its document".into(),
            ));
        }
        let pages = writer.page_count();
        if pages == 0 {
            return Ok(None);
        }
        let cancelled = AtomicBool::new(false);
        let staging = writer.finish(&cancelled)?;
        drop(writer);
        let (path, encoded_bytes) = output::publish(
            StagedOutput::File(staging),
            &self.target,
            None,
            OutputFormat::Pdf,
            self.overwrite,
            &cancelled,
        )?;
        Ok(Some(DocumentPublication {
            path,
            pages,
            encoded_bytes,
        }))
    }

    pub(crate) fn take_staging(
        &mut self,
        cancelled: &AtomicBool,
    ) -> Result<crate::output::StagedFile, Error> {
        self.writer.lock().map_err(poisoned)?.finish(cancelled)
    }
}

impl DocumentPage {
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, PdfDocument>, Error> {
        self.writer.lock().map_err(poisoned)
    }
    pub(crate) fn seal(&mut self, page: pdf_writer::Ref) -> Result<(), Error> {
        self.lock()?.seal_page(page);
        self.sealed = true;
        Ok(())
    }
}

impl Drop for DocumentPage {
    fn drop(&mut self) {
        if !self.sealed {
            if let Ok(mut writer) = self.writer.lock() {
                writer.active = false;
            }
        }
    }
}

fn poisoned<T>(_: std::sync::PoisonError<T>) -> Error {
    Error::Internal("document writer poisoned".into())
}
