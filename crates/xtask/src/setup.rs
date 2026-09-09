//! `cargo xtask setup`: verify pinned tools and install the frozen JS
//! workspace. It never installs Rust toolchains or browser binaries.

pub fn run(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask setup (no options)".to_string());
    }
    configure_git_hooks()?;
    let mut failures: Vec<String> = Vec::new();

    let rustc = version_of("rustc", &["--version"])?;
    println!("rustc: {rustc}");
    let cargo = version_of("cargo", &["--version"])?;
    println!("cargo: {cargo}");
    if !rustc.contains("1.98.0") {
        failures.push(format!(
            "rust-toolchain.toml pins 1.98.0, found: {rustc} (run `rustup show` and `rustup update`)"
        ));
    }

    if let Err(e) = check_node() {
        failures.push(e);
    }
    if let Err(e) = check_pnpm() {
        failures.push(e);
    }
    if let Err(e) = check_wasm_target() {
        failures.push(e);
    }
    if let Err(e) = check_wasm_bindgen() {
        failures.push(e);
    }
    if failures.is_empty() {
        install_workspace_dependencies()?;
        // Playwright browsers are report-only: never fail, never install.
        report_playwright();
        println!("setup: pinned tools ok");
        Ok(())
    } else {
        report_playwright();
        Err(failures.join("\n"))
    }
}

/// Point this checkout at the versioned pre-commit checks.
fn configure_git_hooks() -> Result<(), String> {
    let root = super::repo_root();
    let status = std::process::Command::new("git")
        .args(["config", "--local", "core.hooksPath", ".githooks"])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to configure versioned Git hooks: {e}"))?;
    if status.success() {
        println!("git hooks: .githooks");
        Ok(())
    } else {
        Err("failed to configure versioned Git hooks".to_string())
    }
}

/// Verify `node --version` matches the major pinned in `.node-version`.
fn check_node() -> Result<(), String> {
    let pin_path = super::repo_root().join(".node-version");
    let pin = std::fs::read_to_string(&pin_path)
        .map_err(|e| {
            format!(
                "cannot read {}: {e} (restore the pinned Node major, e.g. `22`)",
                pin_path.display()
            )
        })?
        .trim()
        .to_string();
    if pin.is_empty() {
        return Err(
            ".node-version is empty (expected the pinned Node major, e.g. `22`)".to_string(),
        );
    }
    println!("node pin (.node-version): {pin}");
    let node = version_of("node", &["--version"]).map_err(|e| {
        format!("{e} (install Node {pin} so `node --version` works, e.g. `nvm install {pin}`)")
    })?;
    println!("node: {node}");
    let expected = node_major(&pin).ok_or_else(|| {
        format!("cannot parse Node major from .node-version pin `{pin}` (expected e.g. `22`)")
    })?;
    let found = node_major(&node).ok_or_else(|| {
        format!("cannot parse `node --version` output `{node}` (reinstall Node {expected})")
    })?;
    if expected != found {
        return Err(format!(
            "node major version mismatch: .node-version expects major {expected} (pin `{pin}`), found `{node}`. Install Node {expected} (e.g. `nvm install {expected}` / `fnm install {expected}`) and ensure `node --version` reports v{expected}."
        ));
    }
    Ok(())
}

/// Verify `pnpm` matches the exact version in the root `packageManager`
/// field. All workspace packages, including E2E harnesses, use this manager.
fn check_pnpm() -> Result<(), String> {
    let root = super::repo_root();
    let package_path = root.join("package.json");
    let text = std::fs::read_to_string(&package_path)
        .map_err(|e| format!("cannot read {}: {e}", package_path.display()))?;
    let package: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("invalid {}: {e}", package_path.display()))?;
    let manager = package
        .get("packageManager")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "package.json lacks an exact pnpm packageManager field".to_string())?;
    let expected = manager
        .strip_prefix("pnpm@")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            format!("package.json packageManager must be pnpm@<version>, found {manager}")
        })?;
    let mut command = super::desktop::pnpm_command()?;
    let output = command
        .arg("--version")
        .current_dir(&root)
        .output()
        .map_err(|e| format!("cannot run pnpm: {e}"))?;
    if !output.status.success() {
        return Err(format!("pnpm --version failed; install pnpm {expected}"));
    }
    let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
    println!("pnpm pin (package.json): {expected}");
    println!("pnpm: {found}");
    if found != expected {
        return Err(format!(
            "pnpm version mismatch: package.json expects {expected}, found {found}. Install pnpm {expected}"
        ));
    }
    Ok(())
}

/// Install every workspace package from the single frozen root lockfile.
fn install_workspace_dependencies() -> Result<(), String> {
    let root = super::repo_root();
    let status = super::desktop::pnpm_command()?
        .args(["install", "--frozen-lockfile"])
        .current_dir(root)
        .status()
        .map_err(|e| format!("failed to run pnpm install: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "pnpm install --frozen-lockfile failed".to_string())
}

/// Verify the `wasm32-unknown-unknown` target is installed. Read-only:
/// reports the fix, never runs `rustup target add`.
fn check_wasm_target() -> Result<(), String> {
    const TARGET: &str = "wasm32-unknown-unknown";
    let out = std::process::Command::new("rustup")
        .args(["target", "list", "--installed"])
        .output()
        .map_err(|e| {
            format!(
                "cannot run `rustup target list --installed`: {e} (install rustup, then `rustup target add {TARGET}`)"
            )
        })?;
    if !out.status.success() {
        return Err(format!(
            "`rustup target list --installed` failed (ensure rustup works, then `rustup target add {TARGET}`)"
        ));
    }
    let installed = String::from_utf8_lossy(&out.stdout);
    if installed.lines().any(|l| l.trim() == TARGET) {
        println!("{TARGET} target: installed");
        Ok(())
    } else {
        Err(format!(
            "{TARGET} target missing (rust-toolchain.toml targets it). Install with `rustup target add {TARGET}` (setup never installs)"
        ))
    }
}

/// Verify `wasm-bindgen-cli` is present and matches the `wasm-bindgen`
/// version pinned in `Cargo.lock`. Read-only: reports the fix, never runs
/// `cargo install`.
fn check_wasm_bindgen() -> Result<(), String> {
    let locked = lock_wasm_bindgen_version();
    match version_of("wasm-bindgen", &["--version"]) {
        Ok(found) => {
            println!("wasm-bindgen: {found}");
            if let Some(pinned) = locked {
                if !found.contains(&pinned) {
                    return Err(format!(
                        "wasm-bindgen-cli version mismatch: Cargo.lock pins {pinned}, found `{found}`. Install with `cargo install wasm-bindgen-cli --version {pinned}` (setup never installs)"
                    ));
                }
            }
            Ok(())
        }
        Err(e) => {
            let hint = locked.map_or_else(
                || "`cargo install wasm-bindgen-cli`".to_string(),
                |v| {
                    format!(
                        "`cargo install wasm-bindgen-cli --version {v}` (must match Cargo.lock)"
                    )
                },
            );
            Err(format!(
                "wasm-bindgen-cli missing ({e}). Install with {hint} (setup never installs)"
            ))
        }
    }
}

/// Resolve the `wasm-bindgen` crate version from `Cargo.lock`.
fn lock_wasm_bindgen_version() -> Option<String> {
    let text = std::fs::read_to_string(super::repo_root().join("Cargo.lock")).ok()?;
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim() == "name = \"wasm-bindgen\"" {
            for next in lines.by_ref() {
                let trimmed = next.trim();
                if let Some(rest) = trimmed.strip_prefix("version = \"") {
                    if let Some(version) = rest.strip_suffix('"') {
                        return Some(version.to_string());
                    }
                }
                if trimmed.starts_with("name = ") || trimmed.starts_with('[') {
                    break;
                }
            }
        }
    }
    None
}

/// Report Playwright availability. Informational only: never fails the
/// setup gate and never installs browsers.
fn report_playwright() {
    let e2e_dir = super::repo_root().join("crates/fixture-server/tests/webapp-e2e");
    let cli = e2e_dir.join("node_modules/.bin/playwright");
    let version = if cli.exists() {
        std::process::Command::new(&cli)
            .arg("--version")
            .current_dir(&e2e_dir)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        None
    };
    match version {
        Some(v) => println!("playwright: {v}"),
        None => {
            println!(
                "playwright: not found (report-only; run `cargo xtask setup` to install workspace dependencies)"
            );
            report_playwright_browsers();
            return;
        }
    }
    report_playwright_browsers();
}

/// Report whether a Playwright chromium engine is cached. Read-only cache
/// probe; never runs `playwright install`.
fn report_playwright_browsers() {
    let cache_dir = std::env::var_os("PLAYWRIGHT_BROWSERS_PATH")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|h| std::path::PathBuf::from(h).join(".cache/ms-playwright"))
        });
    let has_chromium = cache_dir.as_ref().is_some_and(|dir| {
        std::fs::read_dir(dir).ok().is_some_and(|entries| {
            entries
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("chromium"))
        })
    });
    match (cache_dir, has_chromium) {
        (Some(dir), true) => println!(
            "playwright browsers: chromium present under {} (report-only; setup never installs)",
            dir.display()
        ),
        (Some(dir), false) => println!(
            "playwright browsers: no chromium under {} (report-only; when E2E is needed run `pnpm --filter webapp-e2e exec playwright install --with-deps chromium`)",
            dir.display()
        ),
        (None, _) => println!(
            "playwright browsers: unknown cache location (report-only; when E2E is needed run `pnpm --filter webapp-e2e exec playwright install --with-deps chromium`)"
        ),
    }
}

/// Extract the leading numeric major from a version string such as `22`,
/// `22.12.0`, `v22.12.0`, or `22.x`.
fn node_major(version: &str) -> Option<String> {
    let stripped = version.trim().strip_prefix('v').unwrap_or(version.trim());
    let major = stripped.split(['.', 'x', 'X']).next()?.trim();
    if major.chars().all(|c| c.is_ascii_digit()) && !major.is_empty() {
        Some(major.to_string())
    } else {
        None
    }
}

fn version_of(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("cannot run {cmd}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{cmd} failed"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
