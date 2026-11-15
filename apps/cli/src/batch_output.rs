//! Batch destinations and final publication.
use super::{arguments::Args, bulk_output_for, report};
use dezoomify::model::Error;
use dezoomify_native::{DocumentPage, OutputDocument, OutputTarget};
use std::path::PathBuf;

pub(crate) enum BatchOutput {
    Files(Option<PathBuf>),
    Document {
        path: PathBuf,
        document: OutputDocument,
    },
}

impl BatchOutput {
    pub(crate) fn new(parsed: &Args) -> Result<Self, Error> {
        let base = parsed.bulk_output_file();
        if let Some(path) = &base {
            if dezoomify_native::output::infer_from_path(path)
                .is_ok_and(|format| format.supports_pages())
            {
                return Ok(Self::Document {
                    path: path.clone(),
                    document: OutputDocument::new(
                        OutputTarget::File(path.clone()),
                        parsed.overwrite,
                    )?,
                });
            }
        }
        Ok(Self::Files(base))
    }

    pub(crate) fn path(&self, title: Option<&str>, index: usize) -> PathBuf {
        match self {
            Self::Files(base) => bulk_output_for(base.as_deref(), title, index),
            Self::Document { path, .. } => path.clone(),
        }
    }

    /// The previous host must settle before acquiring another page.
    pub(crate) fn page(&mut self) -> Result<Option<DocumentPage>, Error> {
        match self {
            Self::Files(_) => Ok(None),
            Self::Document { document, .. } => document.page().map(Some),
        }
    }

    /// Document items remain buffered until `finish` confirms publication.
    pub(crate) fn completed_item(
        &self,
        index: usize,
        url: &str,
        publication: Option<dezoomify_native::Publication>,
    ) -> Result<report::BulkItem, Error> {
        match self {
            Self::Files(_) => {
                let publication = publication
                    .ok_or_else(|| Error::Internal("output was not published".into()))?;
                Ok(report::BulkItem::ok(
                    index,
                    url,
                    &publication.path.to_string_lossy(),
                ))
            }
            Self::Document { path, .. } => {
                let mut item = report::BulkItem::ok(index, url, &path.to_string_lossy());
                item.page = Some(index + 1);
                Ok(item)
            }
        }
    }

    /// Call after all hosts have settled. Publish completed pages even after a
    /// download failure, then report document items and the final batch summary.
    pub(crate) fn finish(
        self,
        parsed: &Args,
        total: usize,
        mut items: Vec<report::BulkItem>,
        mut failure: Option<Error>,
    ) -> Result<bool, Error> {
        let publication = match self {
            Self::Files(_) => None,
            Self::Document { document, .. } => {
                let publication = match document.finish() {
                    Ok(publication) => publication,
                    Err(error) => {
                        // Prepared pages are failures if their file cannot be published.
                        for item in &mut items {
                            if item.status == "ok" {
                                *item = report::BulkItem::failed(
                                    item.index,
                                    &item.url,
                                    &item.output,
                                    &error,
                                );
                            }
                        }
                        failure = Some(error);
                        None
                    }
                };
                for item in &items {
                    report::print_bulk_item(parsed, item);
                }
                publication
            }
        };
        report::print_bulk_summary(
            parsed,
            total,
            &items,
            failure.as_ref(),
            publication.as_ref(),
        )?;
        Ok(failure.is_some())
    }
}
