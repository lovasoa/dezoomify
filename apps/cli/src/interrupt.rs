//! One cooperative Ctrl+C listener for the batch runtime.
use dezoomify_native::Controls;

pub(crate) struct Interrupt {
    task: tokio::task::JoinHandle<()>,
}

impl Interrupt {
    /// Called within the batch runtime; dropping the guard stops the listener.
    pub(crate) fn watch(controls: Controls) -> Self {
        let task = tokio::spawn(async move {
            if let Err(error) = tokio::signal::ctrl_c().await {
                eprintln!("interrupt listener failed: {error}");
            }
            controls.cancel();
        });
        Self { task }
    }
}

impl Drop for Interrupt {
    fn drop(&mut self) {
        self.task.abort();
    }
}
