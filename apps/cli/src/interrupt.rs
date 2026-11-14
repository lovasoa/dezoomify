//! Cooperative Ctrl+C for a document spanning several native runtimes.
use dezoomify::model::Error;
use dezoomify_native::Controls;

pub(crate) struct Interrupt {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
    interrupted: std::sync::mpsc::Receiver<()>,
}

impl Interrupt {
    pub(crate) fn watch(controls: Controls) -> Result<Self, Error> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                Error::Internal(format!("interrupt runtime failed: {error}").into())
            })?;
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let (interrupted, signal) = std::sync::mpsc::channel();
        let worker = std::thread::Builder::new().name("cli-interrupt".into()).spawn(move || {
            runtime.block_on(async {
                tokio::select! {
                    result = tokio::signal::ctrl_c() => {
                        if let Err(error) = result { eprintln!("interrupt listener failed: {error}"); }
                        controls.cancel();
                        let _ = interrupted.send(());
                    },
                    _ = stopped => {},
                }
            });
        }).map_err(|error| Error::Internal(format!("interrupt listener failed: {error}").into()))?;
        Ok(Self {
            stop: Some(stop),
            worker: Some(worker),
            interrupted: signal,
        })
    }

    /// Keep inter-image pacing interruptible without starting another runtime.
    pub(crate) fn wait(&self, duration: std::time::Duration) -> bool {
        !matches!(
            self.interrupted.recv_timeout(duration),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        )
    }
}

impl Drop for Interrupt {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
