//! Signed updater assets and the static manifest uploaded with each release.

use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

use super::common::{expected_artifact_name, Plan};

/// Manifest keys include the package format when a platform has multiple bundles.
/// Keep the bare Linux key for existing Debian installations.
pub(crate) fn bundles(target: &str, version: &str) -> Vec<(&'static str, String)> {
    match target {
        "desktop-linux-x86_64" => vec![
            (
                "linux-x86_64",
                expected_artifact_name(target, version).expect("known desktop release target"),
            ),
            ("linux-x86_64-appimage", "dezoomify-desktop.AppImage".into()),
        ],
        "desktop-windows-x86_64" => vec![(
            "windows-x86_64",
            expected_artifact_name(target, version).expect("known desktop release target"),
        )],
        "desktop-macos-aarch64" => vec![(
            "darwin-aarch64",
            format!("dezoomify-desktop-v{version}-macos-aarch64.app.tar.gz"),
        )],
        _ => vec![],
    }
}

pub(crate) fn assets(plan: &Plan, artifacts: &Path) -> Vec<PathBuf> {
    // Signatures are verified and embedded in latest.json, not uploaded separately.
    plan.targets
        .iter()
        .flat_map(|target| {
            bundles(&target.name, &plan.version)
                .into_iter()
                .map(|(_, name)| artifacts.join(&target.name).join(name))
        })
        .collect()
}

fn public_key() -> Result<PublicKey, String> {
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(crate::repo_root().join("apps/desktop/src-tauri/tauri.conf.json"))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let encoded = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("missing updater public key")?;
    PublicKey::decode(&decode(encoded)?).map_err(|error| format!("updater public key: {error}"))
}

fn decode(value: &str) -> Result<String, String> {
    String::from_utf8(
        STANDARD
            .decode(value.trim())
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn verify_bundle(key: &PublicKey, bundle: &Path, signature: &str) -> Result<(), String> {
    let signature = Signature::decode(&decode(signature)?).map_err(|error| error.to_string())?;
    let mut verifier = key
        .verify_stream(&signature)
        .map_err(|error| error.to_string())?;
    let mut file = File::open(bundle).map_err(|error| format!("{}: {error}", bundle.display()))?;
    let mut buffer = [0; 64 * 1024];
    let mut size = 0;
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        size += count;
        verifier.update(&buffer[..count]);
    }
    if size == 0 {
        return Err(format!("empty update bundle: {}", bundle.display()));
    }
    verifier.finalize().map_err(|error| {
        format!(
            "invalid updater signature for {}: {error}",
            bundle.display()
        )
    })
}

fn manifest_with_key(
    plan: &Plan,
    artifacts: &Path,
    key: &PublicKey,
) -> Result<serde_json::Value, String> {
    let mut platforms = BTreeMap::new();
    for target in &plan.targets {
        for (platform, name) in bundles(&target.name, &plan.version) {
            let dir = artifacts.join(&target.name);
            let signature = std::fs::read_to_string(dir.join(format!("{name}.sig")))
                .map_err(|error| format!("missing updater signature for {name}: {error}"))?;
            verify_bundle(key, &dir.join(&name), &signature)?;
            platforms.insert(platform, serde_json::json!({
                "url": format!("https://github.com/dezoomify/dezoomify/releases/download/{}/{name}", plan.tag),
                "signature": signature.trim(),
            }));
        }
    }
    if platforms.len() != 4 {
        return Err("updater manifest requires all four desktop bundles".into());
    }
    let notes = std::fs::read_to_string(artifacts.join("notes.md"))
        .map_err(|error| format!("read updater release notes: {error}"))?;
    Ok(serde_json::json!({ "version": plan.version, "notes": notes, "platforms": platforms }))
}

pub(crate) fn manifest(plan: &Plan, artifacts: &Path) -> Result<serde_json::Value, String> {
    manifest_with_key(plan, artifacts, &public_key()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release::common::{plan_from_repo, temp_root};

    // Public test vector from minisign-verify's verify_prehashed test; signs b"test".
    const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn write_signed_bundles(plan: &Plan, root: &Path) -> String {
        let signature = STANDARD.encode(SIGNATURE);
        std::fs::write(root.join("notes.md"), "Release notes").unwrap();
        for target in &plan.targets {
            for (_, name) in bundles(&target.name, &plan.version) {
                let dir = root.join(&target.name);
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join(&name), b"test").unwrap();
                std::fs::write(dir.join(format!("{name}.sig")), &signature).unwrap();
            }
        }
        signature
    }

    #[test]
    fn manifest_keeps_downloads_pinned_to_the_release() {
        let root = temp_root("updater");
        let key = PublicKey::from_base64(KEY).unwrap();
        let plan = plan_from_repo();
        let signature = write_signed_bundles(&plan, &root);
        let manifest = manifest_with_key(&plan, &root, &key).unwrap();
        assert_eq!(manifest["version"], plan.version);
        assert_eq!(manifest["notes"], "Release notes");
        let platforms = manifest["platforms"].as_object().unwrap();
        assert_eq!(assets(&plan, &root).len(), 4);
        for (platform, target, extension) in [
            ("linux-x86_64", "desktop-linux-x86_64", ".deb"),
            ("linux-x86_64-appimage", "desktop-linux-x86_64", ".AppImage"),
            ("windows-x86_64", "desktop-windows-x86_64", ".exe"),
            ("darwin-aarch64", "desktop-macos-aarch64", ".app.tar.gz"),
        ] {
            let url = platforms[platform]["url"].as_str().unwrap();
            assert!(url.starts_with(&format!(
                "https://github.com/dezoomify/dezoomify/releases/download/{}/",
                plan.tag
            )));
            assert!(url.ends_with(extension));
            assert_eq!(platforms[platform]["signature"], signature);
            assert!(assets(&plan, &root)
                .contains(&root.join(target).join(url.rsplit('/').next().unwrap())));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_rejects_modified_or_unsigned_bundles() {
        let root = temp_root("updater-invalid");
        let key = PublicKey::from_base64(KEY).unwrap();
        let plan = plan_from_repo();
        write_signed_bundles(&plan, &root);
        let bundle = root
            .join("desktop-linux-x86_64")
            .join("dezoomify-desktop.AppImage");
        std::fs::write(&bundle, b"Test").unwrap();
        assert!(manifest_with_key(&plan, &root, &key).is_err());
        std::fs::write(&bundle, b"test").unwrap();
        std::fs::remove_file(bundle.with_file_name(format!(
            "{}.sig",
            bundle.file_name().unwrap().to_str().unwrap()
        )))
        .unwrap();
        assert!(manifest_with_key(&plan, &root, &key).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
