#![allow(dead_code)]
use dezoomify::{Host, model::*};
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, VecDeque},
    task::Poll,
};

// ── shared discovery stubs ────────────────────────────────────────
// The single fetch stub and plan helpers live in `src/test_support.rs`
// (shared with in-crate format tests); this module adds the Host stub.
pub use dezoomify::{core, model};
#[path = "../../src/test_support.rs"]
mod stub;
#[allow(unused_imports)]
pub use stub::*;

#[derive(Default)]
pub struct MemoryHost {
    pub resources: HashMap<String, ResourceResponse>,
    pub fetch_failures: HashMap<String, Error>,
    pub fetched: RefCell<Vec<ResourceRequest>>,
    pub probes: RefCell<Vec<Tile>>,
    pub probe_results: RefCell<VecDeque<ProbeOutcome>>,
    pub acquired: RefCell<Vec<Tile>>,
    pub attempts: RefCell<Vec<u32>>,
    pub failures: RefCell<HashMap<u32, VecDeque<Error>>>,
    pub choices: RefCell<VecDeque<RecoveryChoice>>,
    pub partials: RefCell<Vec<MissingTiles>>,
    pub sleeps: RefCell<Vec<u32>>,
    pub progress: RefCell<Vec<Progress>>,
    pub warnings: RefCell<Vec<String>>,
    pub outputs: RefCell<Vec<FinishRequest>>,
    pub finish_error: RefCell<Option<Error>>,
    pub settled: Cell<u32>,
    pub active: Cell<u32>,
    pub peak: Cell<u32>,
    pub yield_tiles: Cell<bool>,
    pub cancelled: Cell<bool>,
    pub cancel_after: Cell<Option<usize>>,
    pub paused: Cell<bool>,
    pub pause_after_attempt: Cell<Option<usize>>,
    pub resume: RefCell<Option<futures::channel::oneshot::Receiver<()>>>,
    pub image: Cell<u32>,
    pub level: Cell<Option<u32>>,
    pub display_only: Cell<bool>,
}
struct Active<'a>(&'a Cell<u32>);
impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}
impl Host for MemoryHost {
    async fn fetch(&self, request: ResourceRequest, _: Interaction) -> Result<ResourceRead, Error> {
        let result = self.resources.get(&request.uri).cloned();
        let failure = self.fetch_failures.get(&request.uri).cloned();
        self.fetched.borrow_mut().push(request);
        if let Some(error) = failure {
            return Err(error);
        }
        result
            .map(|response| ResourceRead::Response { response })
            .ok_or_else(|| Error::DiscoveryFailed {
                failure: "missing fixture".to_string().into(),
                cause: None,
            })
    }
    async fn probe(&self, tile: Tile) -> Result<ProbeOutcome, Error> {
        self.probes.borrow_mut().push(tile);
        Ok(self
            .probe_results
            .borrow_mut()
            .pop_front()
            .unwrap_or(ProbeOutcome::Missing))
    }
    async fn acquire_tile(&self, tile: Tile) -> Result<(), Error> {
        self.active.set(self.active.get() + 1);
        self.peak.set(self.peak.get().max(self.active.get()));
        let _active = Active(&self.active);
        self.attempts.borrow_mut().push(tile.index);
        if self
            .pause_after_attempt
            .get()
            .is_some_and(|count| self.attempts.borrow().len() == count)
        {
            self.paused.set(true);
        }
        if self.yield_tiles.get() {
            let mut yielded = false;
            futures::future::poll_fn(|cx| {
                if yielded {
                    Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    Poll::Pending
                }
            })
            .await;
        }
        if let Some(error) = self
            .failures
            .borrow_mut()
            .get_mut(&tile.index)
            .and_then(VecDeque::pop_front)
        {
            return Err(error);
        }
        self.acquired.borrow_mut().push(tile);
        if self
            .cancel_after
            .get()
            .is_some_and(|count| self.acquired.borrow().len() >= count)
        {
            self.cancelled.set(true);
        }
        Ok(())
    }
    async fn finish(&self, request: FinishRequest) -> Result<Output, Error> {
        if let Some(error) = self.finish_error.borrow_mut().take() {
            return Err(error);
        }
        let output = Output {
            canvas: request.canvas.clone(),
            format: request.format,
            missing: request.missing.clone(),
            disposition: if self.display_only.get() {
                OutputDisposition::DisplayOnly
            } else {
                OutputDisposition::BrowserSaveReady
            },
        };
        self.outputs.borrow_mut().push(request);
        Ok(output)
    }
    async fn choose_image(&self, _: Catalog) -> Result<u32, Error> {
        Ok(self.image.get())
    }
    async fn choose_level(&self, image: Image) -> Result<u32, Error> {
        Ok(self.level.get().unwrap_or(image.levels.len() as u32 - 1))
    }
    async fn choose_partial(&self, missing: MissingTiles) -> Result<RecoveryChoice, Error> {
        self.partials.borrow_mut().push(missing);
        Ok(self
            .choices
            .borrow_mut()
            .pop_front()
            .unwrap_or(RecoveryChoice::Discard))
    }
    async fn checkpoint(&self, gate: Gate) -> Result<(), Error> {
        if self.cancelled.get() {
            Err(Error::Cancelled)
        } else if gate == Gate::Acquisition && self.paused.get() {
            let resume = self.resume.borrow_mut().take();
            resume
                .expect("test must install a resume barrier")
                .await
                .unwrap();
            Ok(())
        } else {
            Ok(())
        }
    }
    async fn sleep(&self, delay_ms: u32) -> Result<(), Error> {
        self.sleeps.borrow_mut().push(delay_ms);
        Ok(())
    }
    fn report(&self, progress: Progress) {
        self.progress.borrow_mut().push(progress);
    }
    fn warn(&self, message: String) {
        self.warnings.borrow_mut().push(message);
    }
    async fn settle(&self) {
        assert_eq!(self.active.get(), 0);
        self.settled.set(self.settled.get() + 1);
    }
}
