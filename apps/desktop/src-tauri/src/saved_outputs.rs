//! Saved-file references outlive invocation resources. All disk methods run on workers.
use dezoomify::model::{Error, SavedOutput, SavedOutputState};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

pub struct SavedOutputs {
    directory: PathBuf,
    paths: Mutex<HashMap<String, PathBuf>>,
    writes: Mutex<()>,
}

impl SavedOutputs {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            paths: Mutex::new(HashMap::new()),
            writes: Mutex::new(()),
        }
    }

    /// Registration is memory-only; persistence must never delay the job result.
    pub fn register(&self, path: PathBuf, invocation: &str) -> Result<SavedOutput, Error> {
        let mut digest = Sha256::new();
        digest.update(invocation.as_bytes());
        digest.update([0]);
        digest.update(path.as_os_str().as_encoded_bytes());
        let id: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let filename = path
            .file_name()
            .ok_or(Error::OutputNoParent)?
            .to_string_lossy()
            .into_owned();
        self.paths
            .lock()
            .map_err(|_| Error::ShellLock)?
            .insert(id.clone(), path);
        Ok(SavedOutput { id, filename })
    }

    fn record_path(&self, id: &str) -> Result<PathBuf, Error> {
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::InvalidInput("invalid saved-output reference".into()));
        }
        Ok(self.directory.join(format!("{id}.json")))
    }

    pub fn persist(&self, id: &str) -> Result<(), Error> {
        let record = self.record_path(id)?;
        let _writer = self.writes.lock().map_err(|_| Error::ShellLock)?;
        let Some(path) = self
            .paths
            .lock()
            .map_err(|_| Error::ShellLock)?
            .get(id)
            .cloned()
        else {
            return Ok(()); // Removed while persistence was waiting.
        };
        std::fs::create_dir_all(&self.directory).map_err(unavailable)?;
        let bytes = serde_json::to_vec(&path).map_err(unavailable)?;
        let temporary = record.with_extension("tmp");
        std::fs::write(&temporary, bytes).map_err(unavailable)?;
        // An invocation has one immutable reference; repeated persistence needs no overwrite.
        if record.exists() {
            std::fs::remove_file(temporary).map_err(unavailable)?;
        } else {
            std::fs::rename(temporary, record).map_err(unavailable)?;
        }
        Ok(())
    }

    pub fn resolve(&self, id: &str) -> Result<PathBuf, Error> {
        let record = self.record_path(id)?;
        if let Some(path) = self
            .paths
            .lock()
            .map_err(|_| Error::ShellLock)?
            .get(id)
            .cloned()
        {
            return Ok(path);
        }
        // Missing provenance is an access error, not proof that the image was deleted.
        serde_json::from_slice(&std::fs::read(record).map_err(unavailable)?).map_err(unavailable)
    }

    pub fn inspect(&self, id: &str) -> Result<SavedOutputState, Error> {
        match std::fs::metadata(self.resolve(id)?) {
            Ok(_) => Ok(SavedOutputState::Available),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(SavedOutputState::Deleted)
            }
            Err(error) => Err(unavailable(error)),
        }
    }

    /// Forget provenance only; never delete a user's published image.
    pub fn forget(&self, id: &str) -> Result<(), Error> {
        let record = self.record_path(id)?;
        let _writer = self.writes.lock().map_err(|_| Error::ShellLock)?;
        self.paths.lock().map_err(|_| Error::ShellLock)?.remove(id);
        match std::fs::remove_file(record) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(unavailable(error)),
        }
    }
}

fn unavailable(error: impl std::error::Error + 'static) -> Error {
    Error::OutputUnavailable(dezoomify::model::chain_text(&error).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_survive_restart_distinguish_missing_files_and_forget_without_deleting() {
        let root = std::env::temp_dir().join(format!("dezoomify-saved-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("saved image.png");
        std::fs::write(&path, b"image").unwrap();
        let registry = SavedOutputs::new(root.join("references"));
        let saved = registry.register(path.clone(), "job:first").unwrap();
        assert_eq!(saved.filename, "saved image.png");
        registry.persist(&saved.id).unwrap();
        let restored = SavedOutputs::new(root.join("references"));
        assert_eq!(restored.resolve(&saved.id).unwrap(), path);
        assert_eq!(
            restored.inspect(&saved.id).unwrap(),
            SavedOutputState::Available
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            restored.inspect(&saved.id).unwrap(),
            SavedOutputState::Deleted
        );
        std::fs::write(&path, b"restored image").unwrap();
        assert_eq!(
            restored.inspect(&saved.id).unwrap(),
            SavedOutputState::Available
        );
        registry.forget(&saved.id).unwrap();
        registry.persist(&saved.id).unwrap();
        let next = registry.register(path.clone(), "job:next").unwrap();
        registry.persist(&next.id).unwrap();
        registry.forget(&saved.id).unwrap();
        assert_ne!(saved.id, next.id);
        assert_eq!(
            registry.inspect(&next.id).unwrap(),
            SavedOutputState::Available
        );
        assert!(path.exists());
        assert!(matches!(
            restored.inspect(&saved.id),
            Err(Error::OutputUnavailable(_))
        ));
        assert!(restored.resolve("../../image").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
