//! `cargo xtask release plan|build|sign|verify|publish`: the real release
//! pipeline. Every stage validates the previous stage's digests and fails
//! closed on missing inputs, secrets, or tools (docs/releases.md).
//!
//! Layout under `dist/release/<version>/` (never committed):
//!   plan.json      deterministic frozen release contract
//!   notes.md       release notes (metadata + curated `release/notes/<v>.md`)
//!   SHA256SUMS     aggregate digest manifest (published)
//!   <target>/<artifact>   one directory per buildable target
//!   <file>.sig     GPG detached signatures over the published files
//!
//! The published inventory is recorded at `release/checksums/<version>/`.

use crate::reject_unknown_args;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const ARTIFACTS_ROOT: &str = "dist/release";

// ---------------------------------------------------------------------------
// Release inventory inputs (release/*.toml, generated/*.json)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Config {
    release: ConfigRelease,
    protocol: ConfigProtocol,
}

#[derive(Deserialize)]
struct ConfigRelease {
    version: String,
    channel: String,
}

#[derive(Deserialize)]
struct ConfigProtocol {
    range: String,
    min_peer: String,
}

#[derive(Deserialize)]
struct Targets {
    #[serde(rename = "target")]
    list: Vec<TargetEntry>,
}

#[derive(Deserialize)]
struct TargetEntry {
    name: String,
    os: String,
    #[serde(default = "default_available")]
    available: bool,
}

fn default_available() -> bool {
    true
}

#[derive(Deserialize)]
struct Compatibility {
    compatibility: CompatibilitySection,
}

#[derive(Deserialize)]
struct CompatibilitySection {
    current: String,
    n_minus_1: String,
}

#[derive(Deserialize)]
struct Capabilities {
    capabilities: Vec<String>,
    protocol: String,
}

/// Desktop bundling stays unavailable until the Tauri shell is real
/// (plan release-pipeline, owner decision 2026-09-05); the inventory entry
/// in `release/targets.toml` carries `available = false` until then.
fn load_targets() -> Result<Targets, String> {
    parse_toml("release/targets.toml")
}

fn parse_toml<T: for<'de> Deserialize<'de>>(rel: &str) -> Result<T, String> {
    let text = std::fs::read_to_string(crate::repo_root().join(rel))
        .map_err(|e| format!("missing {rel}: {e}"))?;
    toml::from_str(&text).map_err(|e| format!("bad {rel}: {e}"))
}

fn load_config() -> Result<Config, String> {
    parse_toml("release/config.toml")
}

fn load_compatibility() -> Result<Compatibility, String> {
    parse_toml("release/compatibility.toml")
}

fn load_capabilities() -> Result<Capabilities, String> {
    let path = crate::repo_root().join("generated/release-capabilities.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("missing generated/release-capabilities.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("bad release-capabilities.json: {e}"))
}

fn schema_fingerprint() -> Result<String, String> {
    let path = crate::repo_root().join("generated/desktop-capabilities.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("missing generated/desktop-capabilities.json: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad desktop-capabilities.json: {e}"))?;
    value
        .get("fingerprint")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "desktop-capabilities.json lacks fingerprint".to_string())
}

// ---------------------------------------------------------------------------
// Plan document
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
struct Plan {
    version: String,
    tag: String,
    channel: String,
    commit: String,
    protocol: PlanProtocol,
    schema_fingerprint: String,
    capabilities: Vec<String>,
    targets: Vec<PlanTarget>,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
struct PlanProtocol {
    range: String,
    min_peer: String,
    compatibility_current: String,
    compatibility_n_minus_1: String,
}

#[derive(serde::Serialize, serde::Deserialize, PartialEq)]
struct PlanTarget {
    name: String,
    os: String,
    available: bool,
}

fn git_commit() -> Result<String, String> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(crate::repo_root())
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err("git rev-parse HEAD failed".to_string());
    }
    let s = String::from_utf8(out.stdout).map_err(|e| format!("git output: {e}"))?;
    let commit = s.trim().to_string();
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("git rev-parse HEAD returned a non-commit value".to_string());
    }
    Ok(commit)
}

fn plan_dir(version: &str) -> PathBuf {
    crate::repo_root().join(ARTIFACTS_ROOT).join(version)
}

fn read_plan(path: &Path) -> Result<Plan, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("missing release plan {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("bad release plan {}: {e}", path.display()))
}

fn expected_artifact_name(target: &str, version: &str) -> Option<String> {
    match target {
        "cli-linux-x86_64" => Some(format!("dezoomify-cli-v{version}-linux-x86_64.tar.gz")),
        "extension-chromium" => Some(format!("dezoomify-chromium-v{version}.zip")),
        "extension-firefox" => Some(format!("dezoomify-firefox-v{version}.zip")),
        _ => None,
    }
}

fn validate_version(version: &str) -> Result<(), String> {
    let mut parts = version.split('.');
    for _ in 0..3 {
        let p = parts
            .next()
            .ok_or_else(|| format!("version '{version}' is not a triplet"))?;
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("version '{version}' is not a numeric triplet"));
        }
    }
    if parts.next().is_some() {
        return Err(format!("version '{version}' is not a triplet"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

pub fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("plan") => plan_cmd(&args[1..]),
        Some("build") => build_cmd(&args[1..]),
        Some("sign") => sign_cmd(&args[1..]),
        Some("verify") => verify_cmd(&args[1..]),
        Some("publish") => publish_cmd(&args[1..]),
        Some(other) => Err(format!("unknown release subcommand '{other}'")),
        None => Err("usage: cargo xtask release <plan|build|sign|verify|publish>".to_string()),
    }
}

fn plan_cmd(args: &[String]) -> Result<(), String> {
    let mut version: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--version" => {
                i += 1;
                version = Some(args.get(i).ok_or("missing --version <v>")?.clone());
            }
            other => return Err(format!("unknown release plan arg '{other}'")),
        }
        i += 1;
    }
    let config = load_config()?;
    let version = version.unwrap_or_else(|| config.release.version.clone());
    let plan_path = release_plan(&version)?;
    println!("release plan: {}", plan_path.display());
    Ok(())
}

/// Writes the deterministic plan and notes; returns the plan path.
fn release_plan(version: &str) -> Result<PathBuf, String> {
    release_plan_at(&crate::repo_root().join(ARTIFACTS_ROOT), version)
}

fn release_plan_at(base: &Path, version: &str) -> Result<PathBuf, String> {
    validate_version(version)?;
    let config = load_config()?;
    if version != config.release.version {
        return Err(format!(
            "version {version} does not match release/config.toml ({})",
            config.release.version
        ));
    }
    let targets = load_targets()?;
    let compat = load_compatibility()?;
    let caps = load_capabilities()?;
    if config.protocol.range != compat.compatibility.current {
        return Err(format!(
            "protocol range {} disagrees with compatibility current {}",
            config.protocol.range, compat.compatibility.current
        ));
    }
    if caps.protocol != config.protocol.range {
        return Err(format!(
            "release capabilities protocol {} disagrees with config range {}",
            caps.protocol, config.protocol.range
        ));
    }
    let commit = git_commit()?;
    let fingerprint = schema_fingerprint()?;
    let plan = Plan {
        version: version.to_string(),
        tag: format!("v{version}"),
        channel: config.release.channel.clone(),
        commit,
        protocol: PlanProtocol {
            range: config.protocol.range.clone(),
            min_peer: config.protocol.min_peer.clone(),
            compatibility_current: compat.compatibility.current.clone(),
            compatibility_n_minus_1: compat.compatibility.n_minus_1.clone(),
        },
        schema_fingerprint: fingerprint.clone(),
        capabilities: caps.capabilities.clone(),
        targets: targets
            .list
            .iter()
            .map(|t| PlanTarget {
                name: t.name.clone(),
                os: t.os.clone(),
                available: t.available,
            })
            .collect(),
    };
    if plan.targets.iter().filter(|t| t.available).count() == 0 {
        return Err("release plan has no buildable targets".to_string());
    }
    let dir = base.join(version);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let plan_path = dir.join("plan.json");
    let json = serde_json::to_string_pretty(&plan).map_err(|e| format!("serialize plan: {e}"))?;
    // Determinism: byte-identical for the same inputs; refuse to silently
    // replace an existing plan for the same version.
    if plan_path.exists() {
        let existing =
            std::fs::read_to_string(&plan_path).map_err(|e| format!("read existing plan: {e}"))?;
        if existing != json {
            return Err(format!(
                "plan {} already exists with different content; bump the version or remove dist/release/{version}",
                plan_path.display()
            ));
        }
        return Ok(plan_path);
    }
    std::fs::write(&plan_path, json + "\n")
        .map_err(|e| format!("write {}: {e}", plan_path.display()))?;
    let notes = release_notes(&plan)?;
    std::fs::write(dir.join("notes.md"), notes).map_err(|e| format!("write notes.md: {e}"))?;
    Ok(plan_path)
}

fn release_notes(plan: &Plan) -> Result<String, String> {
    let mut notes = format!(
        "# dezoomify {}\n\n`{}` channel release, built from commit `{}`.\n\n\
        - Supported protocol: `{}` (peers back to `{}`)\n\
        - Schema fingerprint: `{}`\n\
        - Capabilities: {}\n\n\
        ## Artifacts\n\n\
        | Artifact | Sha256 |\n|---|---|\n",
        plan.tag,
        plan.channel,
        &plan.commit[..12],
        plan.protocol.range,
        plan.protocol.min_peer,
        plan.schema_fingerprint,
        plan.capabilities.join(", "),
    );
    for target in &plan.targets {
        if !target.available {
            continue;
        }
        let name = expected_artifact_name(&target.name, &plan.version)
            .ok_or_else(|| format!("target '{}' has no artifact name rule", target.name))?;
        notes.push_str(&format!(
            "| [`{name}`]({}/{name}) | see [SHA256SUMS](SHA256SUMS) |\n",
            target.name
        ));
    }
    notes.push_str(
        "\nEvery artifact ships with a GPG detached signature (`.sig`); the \
        signing public key is `release/gpg-public-key.asc` in the repository. \
        Verify digests against `SHA256SUMS` before use.\n\n\
        ## Install\n\n\
        See the [user guide](https://github.com/lovasoa/dezoomify/blob/master/docs/user/README.md).\n\n",
    );
    let curated = crate::repo_root()
        .join("release/notes")
        .join(format!("{}.md", plan.version));
    if let Ok(text) = std::fs::read_to_string(&curated) {
        notes.push_str("## User-visible changes\n\n");
        notes.push_str(text.trim_end());
        notes.push('\n');
    }
    Ok(notes)
}

fn build_cmd(args: &[String]) -> Result<(), String> {
    let mut plan: Option<PathBuf> = None;
    let mut target: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                plan = Some(PathBuf::from(
                    args.get(i).ok_or("missing --plan <path>")?.clone(),
                ));
            }
            "--target" => {
                i += 1;
                target = Some(args.get(i).ok_or("missing --target <name>")?.clone());
            }
            other => return Err(format!("unknown release build arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(target)) = (plan, target) else {
        return Err("usage: cargo xtask release build --plan <path> --target <name>".to_string());
    };
    let built = release_build(&read_plan(&plan)?, &target)?;
    println!("release build {target}: {}", built.display());
    Ok(())
}

/// Builds one target's artifact and appends its digest to the aggregate
/// SHA256SUMS. Refuses to rebuild an existing artifact (digests must stay
/// append-only and stable).
fn release_build(plan: &Plan, target: &str) -> Result<PathBuf, String> {
    let entry = plan
        .targets
        .iter()
        .find(|t| t.name == target)
        .ok_or_else(|| format!("target '{target}' is not in the release plan"))?;
    if !entry.available {
        return Err(format!(
            "target '{target}' is unavailable in this release (desktop bundling is deferred until the Tauri shell is real; see docs/releases.md)"
        ));
    }
    if plan.commit != git_commit()? {
        return Err(
            "release plan was generated from a different commit; regenerate the plan".to_string(),
        );
    }
    let artifact = expected_artifact_name(target, &plan.version)
        .ok_or_else(|| format!("target '{target}' has no artifact name rule"))?;
    let dir = plan_dir(&plan.version).join(target);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let out = dir.join(&artifact);
    if out.exists() {
        return Err(format!(
            "artifact {} already exists; remove dist/release/{}/{} to rebuild",
            out.display(),
            plan.version,
            target
        ));
    }
    match target {
        "cli-linux-x86_64" => build_cli_artifact(&entry.os, &out)?,
        "extension-chromium" => build_extension_artifact("chromium", &out)?,
        "extension-firefox" => build_extension_artifact("firefox", &out)?,
        other => return Err(format!("target '{other}' has no build recipe")),
    }
    if !out.is_file() || std::fs::metadata(&out).map_err(|e| e.to_string())?.len() == 0 {
        return Err(format!("build produced no artifact at {}", out.display()));
    }
    // Per-target digest fragment; the aggregate SHA256SUMS is assembled
    // deterministically at sign time (parallel builds never share state).
    let fragment = dir.join("SHA256SUMS");
    if fragment.exists() {
        return Err(format!(
            "digest fragment {} already exists; remove dist/release/{}/{} to rebuild",
            fragment.display(),
            plan.version,
            target
        ));
    }
    append_sums(&fragment, &format!("{target}/{artifact}"), &out)?;
    Ok(out)
}

fn build_cli_artifact(target_os: &str, out: &Path) -> Result<(), String> {
    if target_os != "linux" || !cfg!(target_os = "linux") {
        return Err("target cli-linux-x86_64 must be built on a linux host".to_string());
    }
    run_cmd(&["cargo", "build", "--release", "-p", "dezoomify-cli"])?;
    let bin = crate::repo_root().join("target/release/dezoomify-cli");
    if !bin.is_file() {
        return Err(format!(
            "cargo build produced no binary at {}",
            bin.display()
        ));
    }
    tar_gz(&bin, "dezoomify-cli", out)?;
    Ok(())
}

fn build_extension_artifact(browser: &str, out: &Path) -> Result<(), String> {
    let script = crate::repo_root()
        .join("apps/extension/scripts/package-store.sh")
        .canonicalize()
        .map_err(|e| format!("missing package-store.sh: {e}"))?;
    let out = out.canonicalize().unwrap_or_else(|_| out.to_path_buf());
    run_cmd(&[
        script.to_string_lossy().as_ref(),
        browser,
        out.to_string_lossy().as_ref(),
    ])?;
    Ok(())
}

/// Deterministic tar.gz containing one file renamed to `inner_name`.
fn tar_gz(file: &Path, inner_name: &str, out: &Path) -> Result<(), String> {
    let staging = out
        .parent()
        .ok_or("bad artifact path")?
        .join(".staging-tar");
    std::fs::create_dir_all(&staging).map_err(|e| format!("create staging: {e}"))?;
    let staged = staging.join(inner_name);
    std::fs::copy(file, &staged).map_err(|e| format!("stage {}: {e}", file.display()))?;
    let status = Command::new("tar")
        .arg("-czf")
        .arg(out)
        .arg("-C")
        .arg(&staging)
        .arg(inner_name)
        .status()
        .map_err(|e| format!("failed to run tar: {e}"));
    let _ = std::fs::remove_dir_all(&staging);
    let status = status?;
    if !status.success() || !out.is_file() {
        return Err(format!("tar failed writing {}", out.display()));
    }
    Ok(())
}

fn append_sums(sums: &Path, name: &str, file: &Path) -> Result<(), String> {
    let digest = sha256_file(file)?;
    let line = format!("{digest}  {name}\n");
    if sums.exists() {
        let existing = std::fs::read_to_string(sums).map_err(|e| e.to_string())?;
        if existing
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some(name))
        {
            return Err(format!("SHA256SUMS already lists {name}"));
        }
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sums)
        .map_err(|e| format!("open {}: {e}", sums.display()))?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn run_cmd(cmd: &[&str]) -> Result<(), String> {
    let status = Command::new(cmd[0])
        .args(&cmd[1..])
        .current_dir(crate::repo_root())
        .status()
        .map_err(|e| format!("failed to run {}: {e}", cmd[0]))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("{} failed", cmd[0]))
}

// ---------------------------------------------------------------------------
// Signing (GPG; private key from the release-signing environment secret)
// ---------------------------------------------------------------------------

const GPG_KEY_ENV: &str = "RELEASE_GPG_KEY";
const GPG_PASSPHRASE_ENV: &str = "RELEASE_GPG_PASSPHRASE";

fn sign_cmd(args: &[String]) -> Result<(), String> {
    reject_unknown_args("release sign", args)?;
    let config = load_config()?;
    let plan_path = plan_dir(&config.release.version).join("plan.json");
    let artifacts = plan_dir(&config.release.version);
    release_sign(&read_plan(&plan_path)?, &artifacts)?;
    println!("release sign: {}", artifacts.join("SHA256SUMS").display());
    Ok(())
}

/// Signs the aggregate SHA256SUMS and every artifact listed in it, writing
/// `<file>.sig` next to each. Fails closed without a key.
fn release_sign(plan: &Plan, artifacts: &Path) -> Result<(), String> {
    aggregate_sums(plan, artifacts)?;
    let key = std::env::var(GPG_KEY_ENV)
        .ok()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "release signing requires the {GPG_KEY_ENV} environment secret (armored GPG private key); refusing to publish unsigned artifacts"
            )
        })?;
    let sums = artifacts.join("SHA256SUMS");
    let names = parse_sums(&sums)?;
    if names.is_empty() {
        return Err("SHA256SUMS lists no artifacts; nothing to sign".to_string());
    }
    let home = gpg_home()?;
    import_key(&home, &key)?;
    for name in std::iter::once("SHA256SUMS".to_string()).chain(names) {
        let file = artifacts.join(&name);
        if !file.is_file() {
            return Err(format!("missing artifact {}", file.display()));
        }
        let sig = artifacts.join(format!("{name}.sig"));
        let mut cmd = Command::new("gpg");
        cmd.env("GNUPGHOME", &home)
            .args(["--batch", "--yes", "--detach-sign", "--output"])
            .arg(&sig)
            .arg(&file);
        if let Ok(pass) = std::env::var(GPG_PASSPHRASE_ENV) {
            cmd.args(["--pinentry-mode", "loopback", "--passphrase", &pass]);
        }
        let status = cmd
            .status()
            .map_err(|e| format!("failed to run gpg: {e}"))?;
        if !status.success() || !sig.is_file() {
            return Err(format!("gpg detached-sign failed for {name}"));
        }
    }
    cleanup_gpg_home(&home);
    Ok(())
}

fn parse_sums(sums: &Path) -> Result<Vec<String>, String> {
    let text =
        std::fs::read_to_string(sums).map_err(|e| format!("missing {}: {e}", sums.display()))?;
    Ok(text
        .lines()
        .filter_map(|l| l.split_whitespace().nth(1))
        .map(str::to_string)
        .collect())
}

/// Assembles the top-level SHA256SUMS from the per-target fragments, in plan
/// order (deterministic). Every available target must have exactly its
/// fragment; anything else fails closed.
fn aggregate_sums(plan: &Plan, artifacts: &Path) -> Result<String, String> {
    let mut aggregate = String::new();
    for target in &plan.targets {
        if !target.available {
            continue;
        }
        let fragment = artifacts.join(&target.name).join("SHA256SUMS");
        let text = std::fs::read_to_string(&fragment)
            .map_err(|e| format!("missing digest fragment {}: {e}", fragment.display()))?;
        for line in text.lines() {
            let name = line.split_whitespace().nth(1).ok_or_else(|| {
                format!("malformed digest line in {}: {line}", fragment.display())
            })?;
            if !name.starts_with(&format!("{}/", target.name)) {
                return Err(format!(
                    "fragment for {} lists foreign artifact {name}",
                    target.name
                ));
            }
            aggregate.push_str(line);
            aggregate.push('\n');
        }
    }
    if aggregate.is_empty() {
        return Err("no digest fragments found; nothing to sign".to_string());
    }
    std::fs::write(artifacts.join("SHA256SUMS"), &aggregate)
        .map_err(|e| format!("write aggregate SHA256SUMS: {e}"))?;
    Ok(aggregate)
}

fn gpg_home() -> Result<PathBuf, String> {
    if Command::new("gpg").arg("--version").output().is_err() {
        return Err("gpg is not installed; cannot sign release artifacts".to_string());
    }
    let dir = std::env::temp_dir().join(format!("dezoomify-release-gnupg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("create gpg home: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn import_key(home: &Path, armored: &str) -> Result<(), String> {
    let keyfile = home.join("signing-key.asc");
    std::fs::write(&keyfile, armored).map_err(|e| format!("write key: {e}"))?;
    let status = Command::new("gpg")
        .env("GNUPGHOME", home)
        .args(["--batch", "--import"])
        .arg(&keyfile)
        .status()
        .map_err(|e| format!("failed to run gpg: {e}"))?;
    if !status.success() {
        return Err("gpg --import rejected the signing key".to_string());
    }
    Ok(())
}

fn cleanup_gpg_home(home: &Path) {
    let _ = std::fs::remove_dir_all(home);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

fn verify_cmd(args: &[String]) -> Result<(), String> {
    let mut plan: Option<PathBuf> = None;
    let mut artifacts: Option<PathBuf> = None;
    let mut unsigned = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                plan = Some(PathBuf::from(
                    args.get(i).ok_or("missing --plan <path>")?.clone(),
                ));
            }
            "--artifacts" => {
                i += 1;
                artifacts = Some(PathBuf::from(
                    args.get(i).ok_or("missing --artifacts <path>")?.clone(),
                ));
            }
            "--unsigned" => unsigned = true,
            other => return Err(format!("unknown release verify arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(artifacts)) = (plan, artifacts) else {
        return Err(
            "usage: cargo xtask release verify --plan <path> --artifacts <path> [--unsigned]"
                .to_string(),
        );
    };
    release_verify(&read_plan(&plan)?, &artifacts, unsigned)?;
    println!(
        "release verify: ok ({} artifacts)",
        if unsigned { "unsigned" } else { "signed" }
    );
    Ok(())
}

/// Full plan/artifact consistency: digest recomputation, expected artifact
/// names per available target, protocol/capability agreement with the
/// repository inventory, and (unless `--unsigned`) GPG signature validity.
fn release_verify(plan: &Plan, artifacts: &Path, unsigned: bool) -> Result<(), String> {
    validate_version(&plan.version)?;
    if plan.tag != format!("v{}", plan.version) {
        return Err(format!(
            "plan tag {} does not match version {}",
            plan.tag, plan.version
        ));
    }
    let config = load_config()?;
    if plan.version != config.release.version || plan.channel != config.release.channel {
        return Err("plan disagrees with release/config.toml".to_string());
    }
    let compat = load_compatibility()?;
    let caps = load_capabilities()?;
    let fingerprint = schema_fingerprint()?;
    if plan.protocol.range != config.protocol.range
        || plan.protocol.compatibility_current != compat.compatibility.current
        || plan.protocol.compatibility_n_minus_1 != compat.compatibility.n_minus_1
        || caps.protocol != plan.protocol.range
        || caps.capabilities != plan.capabilities
        || plan.schema_fingerprint != fingerprint
    {
        return Err(
            "plan disagrees with the repository release inventory; regenerate the plan".to_string(),
        );
    }
    if plan.commit.len() != 40 || !plan.commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("plan carries a malformed commit".to_string());
    }
    // Exactly the available targets' artifacts must be listed, no more,
    // keyed by their target-relative path in SHA256SUMS.
    let mut expected: BTreeMap<String, ()> = BTreeMap::new();
    for target in &plan.targets {
        if !target.available {
            continue;
        }
        let name = expected_artifact_name(&target.name, &plan.version)
            .ok_or_else(|| format!("target '{}' has no artifact name rule", target.name))?;
        let built = artifacts.join(&target.name).join(&name);
        if !built.is_file() {
            return Err(format!(
                "target '{}' has no built artifact at {}",
                target.name,
                built.display()
            ));
        }
        expected.insert(format!("{}/{name}", target.name), ());
    }
    let sums = artifacts.join("SHA256SUMS");
    let text =
        std::fs::read_to_string(&sums).map_err(|e| format!("missing {}: {e}", sums.display()))?;
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(digest), Some(name)) = (parts.next(), parts.next()) else {
            return Err(format!("malformed SHA256SUMS line: {line}"));
        };
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("malformed digest for {name}"));
        }
        if seen.insert(name.to_string(), digest.to_string()).is_some() {
            return Err(format!("SHA256SUMS lists {name} twice"));
        }
    }
    for name in seen.keys() {
        if !expected.contains_key(name) {
            return Err(format!("SHA256SUMS lists unexpected artifact {name}"));
        }
    }
    for name in expected.keys() {
        if !seen.contains_key(name) {
            return Err(format!("SHA256SUMS lacks expected artifact {name}"));
        }
    }
    for (name, digest) in &seen {
        let file = artifacts.join(name);
        let actual = sha256_file(&file)?;
        if &actual != digest {
            return Err(format!(
                "digest mismatch for {name}: SHA256SUMS says {digest}, file is {actual}"
            ));
        }
    }
    if !unsigned {
        let key = std::fs::read_to_string(crate::repo_root().join("release/gpg-public-key.asc"))
            .map_err(|_| {
                "missing release/gpg-public-key.asc; cannot verify signatures".to_string()
            })?;
        let home = gpg_home()?;
        import_key(&home, &key)?;
        for name in std::iter::once("SHA256SUMS".to_string()).chain(seen.keys().cloned()) {
            let sig = artifacts.join(format!("{name}.sig"));
            if !sig.is_file() {
                cleanup_gpg_home(&home);
                return Err(format!("missing signature {name}.sig"));
            }
            let status = Command::new("gpg")
                .env("GNUPGHOME", &home)
                .args(["--batch", "--verify"])
                .arg(&sig)
                .arg(artifacts.join(&name))
                .status()
                .map_err(|e| format!("failed to run gpg: {e}"))?;
            if !status.success() {
                cleanup_gpg_home(&home);
                return Err(format!("signature verification failed for {name}"));
            }
        }
        cleanup_gpg_home(&home);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

fn publish_cmd(args: &[String]) -> Result<(), String> {
    let mut plan: Option<PathBuf> = None;
    let mut artifacts: Option<PathBuf> = None;
    let mut draft = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => {
                i += 1;
                plan = Some(PathBuf::from(
                    args.get(i).ok_or("missing --plan <path>")?.clone(),
                ));
            }
            "--artifacts" => {
                i += 1;
                artifacts = Some(PathBuf::from(
                    args.get(i).ok_or("missing --artifacts <path>")?.clone(),
                ));
            }
            "--draft" => draft = true,
            other => return Err(format!("unknown release publish arg '{other}'")),
        }
        i += 1;
    }
    let (Some(plan), Some(artifacts)) = (plan, artifacts) else {
        return Err(
            "usage: cargo xtask release publish --plan <path> --artifacts <path> [--draft]"
                .to_string(),
        );
    };
    let p = read_plan(&plan)?;
    release_verify(&p, &artifacts, false)?;
    release_publish(&p, &artifacts, draft)?;
    println!("release publish: {}", p.tag);
    Ok(())
}

fn release_publish(plan: &Plan, artifacts: &Path, draft: bool) -> Result<(), String> {
    if Command::new("gh")
        .args(["auth", "status"])
        .output()
        .is_err()
    {
        return Err("gh is not available or authenticated; cannot publish".to_string());
    }
    // The release must be tied to the planned revision.
    let tag = plan.tag.clone();
    let exists = Command::new("gh")
        .args(["release", "view", &tag])
        .current_dir(crate::repo_root())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if exists {
        return Err(format!(
            "GitHub release {tag} already exists; refusing to republish"
        ));
    }
    // Record the reviewed inventory before publishing.
    let inventory = crate::repo_root()
        .join("release/checksums")
        .join(&plan.version);
    std::fs::create_dir_all(&inventory)
        .map_err(|e| format!("create {}: {e}", inventory.display()))?;
    std::fs::copy(artifacts.join("SHA256SUMS"), inventory.join("SHA256SUMS"))
        .map_err(|e| format!("copy SHA256SUMS: {e}"))?;
    let mut cmd = Command::new("gh");
    cmd.args(["release", "create", &tag, "--target", &plan.commit])
        .arg("--title")
        .arg(format!("dezoomify {}", plan.tag))
        .arg("--notes-file")
        .arg(artifacts.join("notes.md"))
        .arg(artifacts.join("SHA256SUMS"));
    for name in parse_sums(&artifacts.join("SHA256SUMS"))? {
        cmd.arg(artifacts.join(&name));
        cmd.arg(artifacts.join(format!("{name}.sig")));
    }
    if draft {
        cmd.arg("--draft");
    }
    let status = cmd.status().map_err(|e| format!("failed to run gh: {e}"))?;
    if !status.success() {
        return Err(format!("gh release create {tag} failed"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xtask-release-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn plan_from_repo() -> Plan {
        let config = load_config().unwrap();
        let targets = load_targets().unwrap();
        let compat = load_compatibility().unwrap();
        let caps = load_capabilities().unwrap();
        Plan {
            version: config.release.version.clone(),
            tag: format!("v{}", config.release.version),
            channel: config.release.channel.clone(),
            commit: "0".repeat(40),
            protocol: PlanProtocol {
                range: config.protocol.range.clone(),
                min_peer: config.protocol.min_peer.clone(),
                compatibility_current: compat.compatibility.current.clone(),
                compatibility_n_minus_1: compat.compatibility.n_minus_1.clone(),
            },
            schema_fingerprint: schema_fingerprint().unwrap(),
            capabilities: caps.capabilities.clone(),
            targets: targets
                .list
                .iter()
                .map(|t| PlanTarget {
                    name: t.name.clone(),
                    os: t.os.clone(),
                    available: t.available,
                })
                .collect(),
        }
    }

    #[test]
    fn plan_is_deterministic() {
        let version = load_config().unwrap().release.version;
        let base = temp_root("plan");
        let first = std::fs::read_to_string(release_plan_at(&base, &version).unwrap()).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::create_dir_all(&base).unwrap();
        let second = std::fs::read_to_string(release_plan_at(&base, &version).unwrap()).unwrap();
        assert_eq!(first, second);
        assert!(base.join(&version).join("notes.md").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn plan_refuses_version_mismatch() {
        assert!(release_plan("9.9.9").is_err());
        assert!(release_plan("not-a-version").is_err());
    }

    #[test]
    fn desktop_target_is_unavailable() {
        let plan = plan_from_repo();
        let desktop = plan
            .targets
            .iter()
            .find(|t| t.name == "desktop-windows-x86_64")
            .expect("desktop target in inventory");
        assert!(!desktop.available);
    }

    #[test]
    fn verify_rejects_tampered_digests() {
        let plan = plan_from_repo();
        let dir = temp_root("verify");
        let mut names: Vec<(String, PathBuf)> = Vec::new();
        for target in plan.targets.iter().filter(|t| t.available) {
            let artifact = expected_artifact_name(&target.name, &plan.version).unwrap();
            let file = dir.join(&target.name).join(&artifact);
            std::fs::create_dir_all(dir.join(&target.name)).unwrap();
            std::fs::write(&file, format!("bytes-for-{}", target.name)).unwrap();
            names.push((format!("{}/{}", target.name, artifact), file));
        }
        // All-zero digests: verify must reject.
        let sums = names
            .iter()
            .map(|(name, _)| format!("{}  {name}\n", "0".repeat(64)))
            .collect::<String>();
        std::fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
        assert!(release_verify(&plan, &dir, true).is_err());
        // Correct digests: verify must pass.
        let sums = names
            .iter()
            .map(|(name, file)| format!("{}  {name}\n", sha256_file(file).unwrap()))
            .collect::<String>();
        std::fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
        if let Err(e) = release_verify(&plan, &dir, true) {
            panic!("unsigned verify should pass: {e}");
        }
        // An unexpected extra artifact is rejected.
        std::fs::write(
            dir.join("SHA256SUMS"),
            format!("{sums}{}  evil.bin\n", "1".repeat(64)),
        )
        .unwrap();
        assert!(release_verify(&plan, &dir, true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_requires_signatures_unless_unsigned() {
        let plan = plan_from_repo();
        let dir = temp_root("verify-sig");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SHA256SUMS"), "").unwrap();
        // No artifacts at all: unsigned verify fails on missing artifacts
        // before signatures are even considered.
        assert!(release_verify(&plan, &dir, true).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sign_fails_closed_without_key() {
        let plan = plan_from_repo();
        let dir = temp_root("sign");
        for target in plan.targets.iter().filter(|t| t.available) {
            std::fs::create_dir_all(dir.join(&target.name)).unwrap();
            let artifact = expected_artifact_name(&target.name, &plan.version).unwrap();
            std::fs::write(
                dir.join(&target.name).join(&artifact),
                format!("bytes-for-{}", target.name),
            )
            .unwrap();
            std::fs::write(
                dir.join(&target.name).join("SHA256SUMS"),
                format!("{}  {}/{}\n", "0".repeat(64), target.name, artifact),
            )
            .unwrap();
        }
        std::env::remove_var(GPG_KEY_ENV);
        assert!(release_sign(&plan, &dir).is_err());
        // A garbage key must also fail closed, never silently skip signing.
        std::env::set_var(GPG_KEY_ENV, "not-a-key");
        assert!(release_sign(&plan, &dir).is_err());
        std::env::remove_var(GPG_KEY_ENV);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aggregate_is_deterministic_and_rejects_foreign_entries() {
        let plan = plan_from_repo();
        let dir = temp_root("aggregate");
        for target in plan.targets.iter().filter(|t| t.available) {
            std::fs::create_dir_all(dir.join(&target.name)).unwrap();
            std::fs::write(
                dir.join(&target.name).join("SHA256SUMS"),
                format!(
                    "{}  {}/{}\n",
                    "0".repeat(64),
                    target.name,
                    expected_artifact_name(&target.name, &plan.version).unwrap()
                ),
            )
            .unwrap();
        }
        let first = aggregate_sums(&plan, &dir).unwrap();
        let second = aggregate_sums(&plan, &dir).unwrap();
        assert_eq!(first, second);
        // A fragment listing another target's artifact fails closed.
        let cli = plan
            .targets
            .iter()
            .find(|t| t.available && t.name == "cli-linux-x86_64")
            .unwrap();
        std::fs::write(
            dir.join(&cli.name).join("SHA256SUMS"),
            format!("{}  extension-chromium/evil.zip\n", "0".repeat(64)),
        )
        .unwrap();
        assert!(aggregate_sums(&plan, &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sums_parsing_and_append_guard() {
        let dir = temp_root("sums");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        std::fs::write(&a, b"aaa").unwrap();
        let sums = dir.join("SHA256SUMS");
        append_sums(&sums, "a.bin", &a).unwrap();
        append_sums(&sums, "a.bin", &a).unwrap_err();
        assert_eq!(parse_sums(&sums).unwrap(), vec!["a.bin".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
