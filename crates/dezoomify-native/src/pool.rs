//! Fixed-size tile worker pool over std threads (no async runtime).
//!
//! The pool bounds concurrent fetch plus decode work to
//! [`crate::pipeline::MAX_CONCURRENT`] workers with backpressure: callers
//! submit one job per tile and block until every job finishes, so at most
//! `concurrency` tiles are in flight and decoded memory never grows with the
//! plan size. Workers are scoped to one batch and joined before the results
//! are replied, keeping ordering deterministic in plan order.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

type JobQueue<F> = Arc<Mutex<VecDeque<(usize, Option<F>)>>>;
type JobResults<T> = Arc<Mutex<Vec<Option<Option<T>>>>>;

/// Run `jobs` on a fixed pool of `concurrency` std threads, returning results
/// in submission order. Each job is `FnOnce() -> T`; panics surface as
/// `None` entries so one failing tile never poisons the batch.
pub fn run_bounded<T, F>(jobs: Vec<F>, concurrency: usize) -> Vec<Option<T>>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    if jobs.is_empty() {
        return Vec::new();
    }
    let concurrency = concurrency.clamp(1, 64).min(jobs.len());
    let queue: JobQueue<F> = Arc::new(Mutex::new(
        jobs.into_iter()
            .enumerate()
            .map(|(index, job)| (index, Some(job)))
            .collect(),
    ));
    let results: JobResults<T> = Arc::new(Mutex::new({
        let mut slots = Vec::new();
        slots.resize_with(queue.lock().map_or(0, |q| q.len()), || None);
        slots
    }));
    let mut handles: Vec<JoinHandle<()>> = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let queue = Arc::clone(&queue);
        let results = Arc::clone(&results);
        handles.push(std::thread::spawn(move || loop {
            let next = queue.lock().ok().and_then(|mut guard| guard.pop_front());
            let Some((index, job)) = next else {
                break;
            };
            let Some(job) = job else {
                break;
            };
            let output = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).ok();
            if let Ok(mut guard) = results.lock() {
                if let Some(slot) = guard.get_mut(index) {
                    *slot = Some(output);
                }
            }
        }));
    }
    for handle in handles {
        let _ = handle.join();
    }
    Arc::try_unwrap(results)
        .map(|mutex| mutex.into_inner().unwrap_or_default())
        .unwrap_or_default()
        .into_iter()
        .map(|slot| slot.flatten())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::run_bounded;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn preserves_submission_order() {
        let jobs: Vec<Box<dyn FnOnce() -> usize + Send>> = (0..8)
            .map(|index| {
                let boxed: Box<dyn FnOnce() -> usize + Send> = Box::new(move || index);
                boxed
            })
            .collect();
        let out = run_bounded(jobs, 3);
        let values: Vec<usize> = out
            .into_iter()
            .map(|slot| slot.unwrap_or(usize::MAX))
            .collect();
        assert_eq!(values, (0..8).collect::<Vec<_>>());
    }

    #[test]
    fn bounds_concurrency_to_the_pool_width() {
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs: Vec<Box<dyn FnOnce() + Send>> = Vec::new();
        for _ in 0..12 {
            let live = Arc::clone(&live);
            let peak = Arc::clone(&peak);
            let boxed: Box<dyn FnOnce() + Send> = Box::new(move || {
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(5));
                live.fetch_sub(1, Ordering::SeqCst);
            });
            jobs.push(boxed);
        }
        let out = run_bounded(jobs, 3);
        assert_eq!(out.len(), 12);
        assert!(
            peak.load(Ordering::SeqCst) <= 3,
            "pool must never exceed its width"
        );
    }

    #[test]
    fn panics_surface_as_none_without_poisoning_the_batch() {
        let jobs: Vec<Box<dyn FnOnce() -> u32 + Send>> = vec![
            Box::new(|| 1),
            Box::new(|| panic!("tile worker panic is isolated")),
            Box::new(|| 3),
        ];
        let out = run_bounded(jobs, 2);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], Some(1));
        assert_eq!(out[1], None);
        assert_eq!(out[2], Some(3));
    }
}
