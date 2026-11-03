//! Desktop schedules discovered images; each save owns a fresh output Host.
use crate::{jobs::Registration, saved_outputs::SavedOutputs};
use dezoomify::{
    core::{DiscoveredEntry, DiscoveryCatalog, ResolvedImage},
    model::{
        DesktopBatch, DesktopBatchItem, DesktopBatchItemState, DesktopImageChoice, DesktopOutput,
        DesktopResult, DiagnosticLevel, Error, ImageChoiceEvent, Progress, TileAcquisition,
    },
    Host, Job,
};
use dezoomify_native::{JobOptions, NativeHost};
use std::{collections::VecDeque, sync::Arc};

/// Events are synchronous notifications; image/retry answers arrive through Registration.
pub trait SessionEvents {
    fn progress(&self, progress: Progress);
    fn retry(&self, question: u64, request: TileAcquisition);
    fn image_choice(&self, question: u64, event: ImageChoiceEvent) -> Result<(), Error>;
    fn batch(&self, batch: &DesktopBatch);
}

struct Session<'a> {
    options: JobOptions,
    registration: &'a Registration,
    outputs: Arc<SavedOutputs>,
    job: &'a str,
    events: &'a dyn SessionEvents,
}

impl Session<'_> {
    fn host(&self) -> Result<NativeHost<'_>, Error> {
        let mut host = NativeHost::with_diagnostics(
            self.options.clone(),
            self.registration.diagnostics.child(),
        )?;
        host.controls = self.registration.controls.clone();
        host.on_progress(|progress| self.events.progress(progress));
        host.on_retry(|request| {
            let (question, answer) = self.registration.request_retry();
            self.events.retry(question, request);
            Box::pin(async move { answer.await.map_err(|_| Error::InteractionExpired) })
        });
        Ok(host)
    }

    fn choose(
        &self,
        host: &NativeHost<'_>,
        catalog: &DiscoveryCatalog,
    ) -> Result<DesktopImageChoice, Error> {
        let public = catalog.public_catalog();
        if public.entries.len() == 1 {
            return Ok(DesktopImageChoice::One { index: 0 });
        }
        host.transport.block_on(async {
            let (question, answer) = self.registration.request_image(public.entries.len());
            self.events.image_choice(
                question,
                ImageChoiceEvent::Catalog {
                    catalog: public.clone(),
                },
            )?;
            host.catalog_answer(
                &public,
                async { answer.await.map_err(|_| Error::InteractionExpired) },
                |index, thumbnail| {
                    let _ = self
                        .events
                        .image_choice(question, ImageChoiceEvent::Preview { index, thumbnail });
                },
            )
            .await
        })
    }

    fn download(
        &self,
        job: &Job<'_>,
        image: ResolvedImage,
        persist: bool,
    ) -> Result<(DesktopOutput, std::path::PathBuf), Error> {
        let host = self.host()?;
        let output = host.transport.block_on(async {
            let result = job.download(image, &host).await;
            host.settle().await;
            result
        })?;
        let path = host
            .publication()
            .ok_or_else(|| {
                Error::Internal("a successful desktop save did not publish an output".into())
            })?
            .path;
        let saved_output = self.outputs.register(path.clone(), self.job).ok();
        if let Some(saved) = saved_output.as_ref().filter(|_| persist) {
            let outputs = Arc::clone(&self.outputs);
            let id = saved.id.clone();
            std::thread::spawn(move || {
                let _ = outputs.persist(&id);
            });
        }
        Ok((
            DesktopOutput {
                output,
                saved_output,
            },
            path,
        ))
    }

    fn run(&self) -> Result<(DesktopResult, Option<std::path::PathBuf>), Error> {
        let host = self.host()?;
        let options = host.algorithm_options();
        let result = (|| {
            let (mut discovery, mut catalog) =
                host.transport
                    .block_on(Job::start(host.inputs(), &options, &host))?;
            loop {
                match self.choose(&host, &catalog)? {
                    DesktopImageChoice::All => {
                        return Ok((
                            DesktopResult::Batch {
                                batch: self.run_all(&host, discovery, catalog),
                            },
                            None,
                        ));
                    }
                    DesktopImageChoice::One { index } => {
                        let entry = catalog
                            .into_entries()
                            .into_iter()
                            .nth(index as usize)
                            .ok_or_else(|| {
                                Error::InvalidInput("image selection is out of range".into())
                            })?;
                        match entry {
                            DiscoveredEntry::Deferred(resource) => {
                                catalog =
                                    host.transport.block_on(discovery.follow(resource, &host))?;
                            }
                            DiscoveredEntry::Ready(image) => {
                                let persist = self.options.input_url.starts_with("http://")
                                    || self.options.input_url.starts_with("https://");
                                let (result, path) = self.download(&discovery, image, persist)?;
                                return Ok((DesktopResult::Image { result }, Some(path)));
                            }
                        }
                    }
                }
            }
        })();
        host.transport.block_on(host.settle());
        result
    }

    fn run_all<'a>(
        &self,
        host: &NativeHost<'_>,
        discovery: Job<'a>,
        catalog: DiscoveryCatalog,
    ) -> DesktopBatch {
        let mut batch = DesktopBatch {
            items: Vec::new(),
            cancelled: false,
        };
        let mut next_id = 0;
        let mut queue = Self::expand(discovery, catalog, None, &mut next_id, &mut batch.items);
        self.events.batch(&batch);
        while let Some((id, mut discovery, entry)) = queue.pop_front() {
            if self.registration.controls.is_cancelled() {
                batch.cancelled = true;
                break;
            }
            let position = batch
                .items
                .iter()
                .position(|item| item.id == id)
                .expect("queued entries have visible batch items");
            batch.items[position].state = DesktopBatchItemState::Running;
            self.events.progress(Progress::default());
            self.registration.diagnostics.record(
                DiagnosticLevel::Info,
                "batch-item-started",
                serde_json::json!({"id": id, "title": batch.items[position].title, "source": batch.items[position].source_url}),
            );
            self.events.batch(&batch);
            let result = match entry {
                DiscoveredEntry::Deferred(resource) => {
                    match host.transport.block_on(discovery.follow(resource, host)) {
                        Ok(catalog) => {
                            let mut children = Vec::new();
                            let entries = Self::expand(
                                discovery,
                                catalog,
                                batch.items[position].title.clone(),
                                &mut next_id,
                                &mut children,
                            );
                            batch.items.splice(position..=position, children);
                            for entry in entries.into_iter().rev() {
                                queue.push_front(entry);
                            }
                            self.events.batch(&batch);
                            continue;
                        }
                        Err(error) => Err(error),
                    }
                }
                DiscoveredEntry::Ready(image) => self.download(&discovery, image, false),
            };
            match result {
                Ok((result, _)) => {
                    batch.items[position].state = DesktopBatchItemState::Saved { result }
                }
                Err(error) if matches!(error.cause(), Error::Cancelled) => {
                    batch.items[position].state = DesktopBatchItemState::Cancelled;
                    batch.cancelled = true;
                    break;
                }
                Err(error) => {
                    self.registration.diagnostics.record(
                        DiagnosticLevel::Error,
                        "batch-item-failed",
                        serde_json::json!({"id": id, "source": batch.items[position].source_url, "error": error}),
                    );
                    batch.items[position].state = DesktopBatchItemState::Failed { error };
                }
            }
            self.events.batch(&batch);
        }
        if batch.cancelled {
            for item in &mut batch.items {
                if matches!(
                    item.state,
                    DesktopBatchItemState::Pending | DesktopBatchItemState::Running
                ) {
                    item.state = DesktopBatchItemState::Cancelled;
                }
            }
        }
        self.events.batch(&batch);
        batch
    }

    fn expand<'a>(
        discovery: Job<'a>,
        catalog: DiscoveryCatalog,
        fallback_title: Option<String>,
        next_id: &mut u32,
        items: &mut Vec<DesktopBatchItem>,
    ) -> VecDeque<(u32, Job<'a>, DiscoveredEntry)> {
        let mut entries = catalog.into_entries();
        // A list label names singleton descendants until an image declares its own title.
        if let [entry] = entries.as_mut_slice() {
            let title = match entry {
                DiscoveredEntry::Ready(image) => &mut image.title,
                DiscoveredEntry::Deferred(image) => &mut image.title,
            };
            if title.as_deref().is_none_or(|title| title.trim().is_empty()) {
                *title = fallback_title;
            }
        }
        entries
            .into_iter()
            .map(|entry| {
                let (title, source_url) = match &entry {
                    DiscoveredEntry::Ready(image) => {
                        (image.title.clone(), image.source_url.clone())
                    }
                    DiscoveredEntry::Deferred(image) => {
                        (image.title.clone(), Some(image.uri.clone()))
                    }
                };
                let id = *next_id;
                *next_id += 1;
                items.push(DesktopBatchItem {
                    id,
                    title,
                    source_url,
                    state: DesktopBatchItemState::Pending,
                });
                (id, discovery.clone(), entry)
            })
            .collect()
    }
}

/// Run on a blocking worker. Options stay frozen; cancellation stops pending work.
/// Completion is published only after every active Host has settled, including failures.
pub fn run_session(
    options: JobOptions,
    registration: &Registration,
    outputs: Arc<SavedOutputs>,
    job: &str,
    events: &dyn SessionEvents,
) -> Result<DesktopResult, Error> {
    let result = Session {
        options,
        registration,
        outputs,
        job,
        events,
    }
    .run();
    let path = result.as_ref().ok().and_then(|(_, path)| path.clone());
    registration.finish(path);
    let result = result.map(|(result, _)| result);
    match &result {
        Err(error) => registration.diagnostics.finish(
            if matches!(error.cause(), Error::Cancelled) {
                "cancelled"
            } else {
                "failed"
            },
            serde_json::json!({"error": error}),
        ),
        Ok(DesktopResult::Image { result }) => registration
            .diagnostics
            .finish("completed", serde_json::json!({"output": result.output})),
        Ok(DesktopResult::Batch { batch }) => {
            let saved = batch
                .items
                .iter()
                .filter(|item| matches!(item.state, DesktopBatchItemState::Saved { .. }))
                .count();
            let failed = batch
                .items
                .iter()
                .filter(|item| matches!(item.state, DesktopBatchItemState::Failed { .. }))
                .count();
            registration.diagnostics.finish(
                if batch.cancelled { "cancelled" } else if failed > 0 { "failed" } else { "completed" },
                serde_json::json!({"images": batch.items.len(), "saved": saved, "failed": failed, "cancelled": batch.cancelled}),
            );
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use dezoomify::model::ProgressPhase;
    use dezoomify_fixture_server::{temp_dir, NodeServer, RawResponse};
    use dezoomify_native::OutputTarget;
    use std::{
        cell::{Cell, RefCell},
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct Events<'a> {
        registration: &'a Registration,
        choices: RefCell<VecDeque<DesktopImageChoice>>,
        snapshots: RefCell<Vec<DesktopBatch>>,
        phases: RefCell<Vec<ProgressPhase>>,
        cancel_second: bool,
        running: Cell<usize>,
    }

    impl SessionEvents for Events<'_> {
        fn progress(&self, progress: Progress) {
            self.phases.borrow_mut().push(progress.phase);
            if self.cancel_second
                && self.running.get() == 1
                && progress.phase == ProgressPhase::Acquisition
            {
                self.registration.controls.cancel();
            }
        }
        fn retry(&self, _: u64, _: TileAcquisition) {
            panic!("fixtures do not ask for retry approval");
        }
        fn image_choice(&self, question: u64, event: ImageChoiceEvent) -> Result<(), Error> {
            if matches!(event, ImageChoiceEvent::Catalog { .. }) {
                let choice = self
                    .choices
                    .borrow_mut()
                    .pop_front()
                    .expect("scripted catalog answer");
                self.registration.answer_image(question, choice)?;
            }
            Ok(())
        }
        fn batch(&self, batch: &DesktopBatch) {
            if let Some(position) = batch
                .items
                .iter()
                .position(|item| matches!(item.state, DesktopBatchItemState::Running))
            {
                self.running.set(position);
            }
            self.snapshots.borrow_mut().push(batch.clone());
        }
    }

    fn events(registration: &Registration, choices: Vec<DesktopImageChoice>) -> Events<'_> {
        Events {
            registration,
            choices: RefCell::new(choices.into()),
            snapshots: RefCell::new(Vec::new()),
            phases: RefCell::new(Vec::new()),
            cancel_second: false,
            running: Cell::new(0),
        }
    }

    fn fixture() -> (NodeServer, Arc<AtomicUsize>) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/tiles");
        let red = std::fs::read(root.join("0-0.png")).unwrap();
        let green = std::fs::read(root.join("1-0.png")).unwrap();
        let discoveries = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&discoveries);
        let server = NodeServer::raw("127.0.0.1", move |request| {
            let authority = request
                .head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("host").then(|| value.trim())
                })
                .unwrap();
            let origin = format!("http://{authority}");
            let (content_type, body) = match request.path.as_str() {
                "/catalog" => {
                    count.fetch_add(1, Ordering::SeqCst);
                    ("text/html", br#"<script type="application/json">[
                        {"TileSize":256,"Overlap":0,"Format":"png","Url":"first/","Size":{"Width":256,"Height":256}},
                        {"TileSize":256,"Overlap":0,"Format":"png","Url":"second/","Size":{"Width":256,"Height":256}}
                    ]</script>"#.to_vec())
                }
                "/nested.txt" => ("text/plain", format!("{origin}/one/metadata First painting\n{origin}/two.dzi Second painting\n").into_bytes()),
                "/one/metadata" => ("application/json", serde_json::to_vec(&serde_json::json!({
                    "@context": "http://iiif.io/api/image/3/context.json", "id": format!("{origin}/one"),
                    "type": "ImageService3", "protocol": "http://iiif.io/api/image", "profile": "level2",
                    "preferredFormats": ["png"], "width": 256, "height": 256, "tiles": [{"width": 256, "scaleFactors": [1]}]
                })).unwrap()),
                "/list.txt" => ("text/plain", format!("{origin}/nested.txt\n{origin}/missing.dzi\n{origin}/last.dzi\n").into_bytes()),
                "/cancel.txt" => ("text/plain", format!("{origin}/one.dzi\n{origin}/two.dzi\n{origin}/last.dzi\n").into_bytes()),
                "/one.dzi" | "/two.dzi" | "/last.dzi" => ("application/xml", br#"<Image TileSize="256" Overlap="0" Format="png"><Size Width="256" Height="256" /></Image>"#.to_vec()),
                "/first/8/0_0.png" | "/one_files/8/0_0.png" | "/last_files/8/0_0.png" | "/one/0,0,256,256/256,256/0/default.png" => ("image/png", red.clone()),
                "/second/8/0_0.png" | "/two_files/8/0_0.png" => ("image/png", green.clone()),
                _ => return RawResponse::from(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
            };
            let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
            response.extend(body);
            response.into()
        });
        (server, discoveries)
    }

    fn options(input_url: String, directory: &std::path::Path) -> JobOptions {
        JobOptions {
            input_url,
            output: OutputTarget::AutoDir {
                dir: directory.to_path_buf(),
                format: dezoomify::model::OutputFormat::Png,
            },
            max_retries: 0,
            largest: true,
            ..Default::default()
        }
    }

    fn saved(batch: &DesktopBatch) -> Vec<&DesktopOutput> {
        batch
            .items
            .iter()
            .filter_map(|item| match &item.state {
                DesktopBatchItemState::Saved { result } => Some(result),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn all_keeps_distinct_ready_images_from_one_discovery_snapshot() {
        let (server, discoveries) = fixture();
        let directory = temp_dir("desktop-ready-batch");
        let registration = Registration::new();
        let events = events(&registration, vec![DesktopImageChoice::All]);
        let outputs = Arc::new(SavedOutputs::new(directory.join("references")));
        let result = run_session(
            options(format!("{}/catalog", server.origin), &directory),
            &registration,
            Arc::clone(&outputs),
            "job:batch",
            &events,
        )
        .unwrap();
        let DesktopResult::Batch { batch } = result else {
            panic!("batch result");
        };
        assert!(!batch.cancelled);
        assert_eq!(
            discoveries.load(Ordering::SeqCst),
            1,
            "parent discovery is never replayed"
        );
        let saved = saved(&batch);
        assert_eq!(saved.len(), 2);
        let pixels: Vec<_> = saved
            .iter()
            .map(|result| {
                let reference = result.saved_output.as_ref().unwrap();
                let image = image::open(outputs.resolve(&reference.id).unwrap())
                    .unwrap()
                    .to_rgb8();
                assert_eq!(image.dimensions(), (256, 256));
                image.get_pixel(128, 128).0
            })
            .collect();
        assert!(pixels[0][0] > pixels[0][1], "first image is red");
        assert!(pixels[1][1] > pixels[1][0], "second image is green");
        assert!(registration.completed.load(Ordering::SeqCst));
        assert!(
            registration.saved_path.lock().unwrap().is_none(),
            "batch files use their own saved references"
        );
        assert_eq!(
            registration.diagnostics.report().outcome.unwrap().event,
            "completed"
        );
    }

    #[test]
    fn all_expands_nested_lists_and_continues_after_an_entry_fails() {
        let (server, _) = fixture();
        let directory = temp_dir("desktop-nested-batch");
        let registration = Registration::new();
        let events = events(&registration, vec![DesktopImageChoice::All]);
        let result = run_session(
            options(format!("{}/list.txt", server.origin), &directory),
            &registration,
            Arc::new(SavedOutputs::new(directory.join("references"))),
            "job:nested",
            &events,
        )
        .unwrap();
        let DesktopResult::Batch { batch } = result else {
            panic!("batch result");
        };
        assert!(!batch.cancelled);
        assert_eq!(batch.items.len(), 4);
        assert_eq!(saved(&batch).len(), 3);
        assert_eq!(batch.items[0].title.as_deref(), Some("First painting"));
        assert_eq!(
            saved(&batch)[0].saved_output.as_ref().unwrap().filename,
            "First-painting.png"
        );
        assert!(
            events
                .phases
                .borrow()
                .windows(2)
                .any(|phases| phases == [ProgressPhase::Output, ProgressPhase::Discovery]),
            "a new entry clears the previous save phase"
        );
        assert!(matches!(
            batch.items[2].state,
            DesktopBatchItemState::Failed { .. }
        ));
        assert!(
            matches!(batch.items[3].state, DesktopBatchItemState::Saved { .. }),
            "later entries still download"
        );
        assert!(
            events.choices.borrow().is_empty(),
            "nested catalogs need no more answers"
        );
        assert_eq!(
            registration.diagnostics.report().outcome.unwrap().event,
            "failed"
        );
    }

    #[test]
    fn cancelling_an_active_item_keeps_saved_outputs_and_stops_pending_work() {
        let (server, _) = fixture();
        let directory = temp_dir("desktop-cancel-batch");
        let registration = Registration::new();
        let mut events = events(&registration, vec![DesktopImageChoice::All]);
        events.cancel_second = true;
        let outputs = Arc::new(SavedOutputs::new(directory.join("references")));
        let result = run_session(
            options(format!("{}/cancel.txt", server.origin), &directory),
            &registration,
            Arc::clone(&outputs),
            "job:cancel",
            &events,
        )
        .unwrap();
        let DesktopResult::Batch { batch } = result else {
            panic!("batch result");
        };
        assert!(batch.cancelled);
        assert_eq!(saved(&batch).len(), 1);
        assert!(batch.items[1..]
            .iter()
            .all(|item| matches!(item.state, DesktopBatchItemState::Cancelled)));
        let pngs: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "png")
            })
            .collect();
        assert_eq!(pngs.len(), 1, "settlement removes unfinished output");
        let saved = saved(&batch)[0].saved_output.as_ref().unwrap();
        assert!(outputs.resolve(&saved.id).unwrap().is_file());
        assert!(registration.completed.load(Ordering::SeqCst));
        assert_eq!(
            registration.diagnostics.report().outcome.unwrap().event,
            "cancelled"
        );
    }

    #[test]
    fn choosing_one_keeps_nested_picker_behavior_and_single_result() {
        let (server, _) = fixture();
        let directory = temp_dir("desktop-one-nested");
        let registration = Registration::new();
        let events = events(
            &registration,
            vec![
                DesktopImageChoice::One { index: 0 },
                DesktopImageChoice::One { index: 1 },
            ],
        );
        let result = run_session(
            options(format!("{}/list.txt", server.origin), &directory),
            &registration,
            Arc::new(SavedOutputs::new(directory.join("references"))),
            "job:one",
            &events,
        )
        .unwrap();
        let DesktopResult::Image { result } = result else {
            panic!("single image result");
        };
        assert!(result.saved_output.is_some());
        let path = registration.saved_path.lock().unwrap().clone().unwrap();
        let image = image::open(path).unwrap().to_rgb8();
        let pixel = image.get_pixel(128, 128).0;
        assert!(pixel[1] > pixel[0], "nested picker selected second image");
        assert!(events.snapshots.borrow().is_empty());
    }

    #[test]
    fn opened_local_metadata_and_url_lists_save_their_sibling_tiles() {
        let directory = temp_dir("desktop-local-sources").join("a painting 雪#%7B%");
        std::fs::create_dir_all(&directory).unwrap();
        let tile =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/tiles/0-0.png");
        let expected = image::open(&tile).unwrap().to_rgba8();
        for (name, metadata, relative_tile) in [
            (
                "painting.dzi",
                r#"<Image TileSize="256" Overlap="0" Format="png"><Size Width="256" Height="256" /></Image>"#,
                "painting_files/8/0_0.png",
            ),
            (
                "info.json",
                r#"{"@context":"http://iiif.io/api/image/2/context.json","width":256,"height":256,"tiles":[{"width":256,"scaleFactors":[1]}],"formats":["png"]}"#,
                "0,0,256,256/256,256/0/default.png",
            ),
            ("list.urls", "./painting.dzi", "painting_files/8/0_0.png"),
        ] {
            let path = directory.join(name);
            std::fs::write(&path, metadata).unwrap();
            let destination = directory.join(relative_tile);
            std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
            std::fs::copy(&tile, destination).unwrap();
            let source = dezoomify::model::DesktopSource::File {
                path: path.to_str().unwrap().into(),
            };
            let input = crate::commands::source_input(&source).unwrap();
            let registration = Registration::new();
            let events = events(&registration, vec![]);
            let outputs = Arc::new(SavedOutputs::new(directory.join("references")));
            let result = run_session(
                options(input, &directory),
                &registration,
                Arc::clone(&outputs),
                "job:local",
                &events,
            )
            .unwrap();
            let DesktopResult::Image { result } = result else {
                panic!("single local image");
            };
            let saved = result.saved_output.unwrap();
            assert_eq!(
                image::open(outputs.resolve(&saved.id).unwrap())
                    .unwrap()
                    .to_rgba8(),
                expected
            );
            assert!(
                !directory.join("references").exists(),
                "local paths have no persisted URL history reference"
            );
        }
    }
}
