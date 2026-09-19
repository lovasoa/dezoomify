//! `cargo xtask check` architecture gate: dependency direction.
//!
//! - `packages/shared-ui` is host-neutral: after stripping comments and
//!   string literals, no module may reference the host globals `window`,
//!   `fetch`, `chrome`, or `tauri` (the extension page's no-bundler replica
//!   and the browser runtimes own every host effect). Shared UI never
//!   imports `packages/browser-runtime`: canonical presentation helpers
//!   (transport labels, save names, history) live in
//!   `packages/app-model` and shared-ui re-exports them.
//! - `packages/app-model` is host-neutral and React-free: no host globals,
//!   no `react`/`react-dom`, no host storage or canvas access. It imports
//!   generated contract types (`@dezoomify/wasm-bindings`) and relative
//!   siblings only.
//! - `packages/browser-runtime` never imports `shared-ui` or `app-model`
//!   consumers in the wrong direction: save names and transport labels stay
//!   consumable without a runtime-to-UI import.
//! - `apps/desktop/src/jobService.ts` uses the public Tauri API only
//!   (`@tauri-apps/api/core`, `@tauri-apps/api/event`): no
//!   host-injected Tauri globals, no validation-only fallbacks.
//!
//! Only quoted import/export specifiers count for the runtime rule, so prose
//! comments mentioning shared-ui stay allowed.

use std::path::{Path, PathBuf};

/// Host-global tokens forbidden in shared-ui code (lowercase compare).
const FORBIDDEN_TOKENS: &[&str] = &["window", "fetch", "chrome", "tauri"];

/// Host-global and framework tokens forbidden in app-model code.
const APP_MODEL_FORBIDDEN_TOKENS: &[&str] = &[
    "window",
    "document",
    "fetch",
    "chrome",
    "tauri",
    "react",
    "localstorage",
];

pub fn verify(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    let root = super::repo_root();
    check_shared_ui(&root.join("packages/shared-ui/src"))?;
    check_app_model(&root.join("packages/app-model/src"))?;
    check_runtime(&root.join("packages/browser-runtime/src"))?;
    check_desktop_service(&root.join("apps/desktop/src/jobService.ts"))?;
    check_browser_single_sources(&root)?;
    check_website_runtime_usage(&root)?;
    check_protocol_boundaries(&root)?;
    check_engine_single_api(&root)?;
    println!("architecture: ok");
    Ok(())
}

/// The engine exposes one lifecycle implementation: hosts drive
/// `EngineJob` (`start`/`command`/`complete`/`provide_metadata`) and never
/// the old command surface (`Job::on_command`, `drain_messages`,
/// `JobCommand`, `Outcome`). The old items stay crate-private inside
/// `dezoomify-engine` for the facade bridge only.
fn check_engine_single_api(root: &Path) -> Result<(), String> {
    for dir in [
        "crates/dezoomify-native/src",
        "crates/dezoomify-wasm/src",
        "apps/desktop/src-tauri/src",
        "apps/cli/src",
    ] {
        let base = root.join(dir);
        for file in list_rs(&base)? {
            let text = std::fs::read_to_string(&file)
                .map_err(|e| format!("read {}: {e}", file.display()))?;
            let code = strip_comments(&text);
            // The ABI `JobCommand` (protocol DTO) shares its name with the
            // old engine surface, so only engine-qualified paths and the
            // old driving methods are forbidden here.
            for forbidden in [
                "on_command(",
                "drain_messages(",
                "JobMessageBody",
                "dezoomify_engine::JobCommand",
                "dezoomify_engine::Outcome",
                "engine::JobCommand",
                "engine::Outcome",
                "transition::Job",
                "state::State",
            ] {
                if contains_word(&code, forbidden) {
                    return Err(format!(
                        "engine duality: {} references `{forbidden}`; hosts drive EngineJob only",
                        file.display()
                    ));
                }
            }
        }
    }
    Ok(())
}

/// True when `token` occurs with a non-identifier boundary on both sides.
fn contains_word(code: &str, token: &str) -> bool {
    let mut start = 0;
    while let Some(index) = code[start..].find(token) {
        let from = start + index;
        let to = from + token.len();
        let before = code[..from].chars().next_back();
        let after = code[to..].chars().next();
        let boundary = |c: Option<char>| c.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        if boundary(before) && boundary(after) {
            return true;
        }
        start = to;
    }
    false
}

fn list_rs(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut entries: Vec<_> = entries
        .map(|e| e.map_err(|e| format!("dir entry: {e}")))
        .collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            out.extend(list_rs(&path)?);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            out.push(path);
        }
    }
    Ok(out)
}

fn check_protocol_boundaries(root: &Path) -> Result<(), String> {
    let core_model_path = root.join("crates/dezoomify-core/src/core/model.rs");
    let core_model = std::fs::read_to_string(&core_model_path)
        .map_err(|e| format!("read {}: {e}", core_model_path.display()))?;
    if core_model.contains("StableId") {
        return Err("core catalogs must use immutable positions, not StableId".to_string());
    }
    for path in [
        "crates/dezoomify-engine/src/job.rs",
        "crates/dezoomify-engine/src/transition.rs",
        "crates/dezoomify-native/src/runner.rs",
        "crates/dezoomify-wasm/src/session.rs",
    ] {
        let file = root.join(path);
        let text =
            std::fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        if text.contains("serde_json::Value") {
            return Err(format!(
                "typed job boundary violation: {} uses serde_json::Value",
                file.display()
            ));
        }
    }
    for path in [
        "packages/browser-runtime/src/worker-host.ts",
        "packages/browser-runtime/src/engine-host.ts",
        "apps/extension/src/job/index.ts",
        "apps/extension/src/runtime/nativeHandoff.ts",
        "src/main.ts",
    ] {
        let text =
            std::fs::read_to_string(root.join(path)).map_err(|e| format!("read {path}: {e}"))?;
        if !text.contains("@dezoomify/wasm-bindings") {
            return Err(format!(
                "typed boundary violation: {path} must import generated Rust/WASM bindings"
            ));
        }
    }
    Ok(())
}

fn check_website_runtime_usage(root: &Path) -> Result<(), String> {
    let main_path = root.join("src/main.ts");
    let main = std::fs::read_to_string(&main_path)
        .map_err(|e| format!("read {}: {e}", main_path.display()))?;
    for required in [
        "createJobActivity",
        "createTileDecoder",
        "createBrowserRunner",
        "createCanvasAssembly",
        "createProbeSize",
        "createTileThrottle",
        "createWebFetcher",
        "canvasToPngBlob",
        "saveBlobViaAnchor",
        "setCanvasVisible",
    ] {
        if !main.contains(required) {
            return Err(format!(
                "website runtime bypass: {} must use `{required}` from packages/browser-runtime",
                main_path.display()
            ));
        }
    }
    for duplicate in [
        "function fetchDirect(",
        "function fetchViaProxy(",
        "function fetchMetadataFor(",
        "function fetchTileFor(",
        "function loadTileImage(",
        "function drawTile(",
        "function tileDecodeWorkerCode(",
        "function scheduleBatchedUpdate(",
        "function setCanvasVisible(",
        "canvas.toBlob(",
        "new Image()",
    ] {
        if main.contains(duplicate) {
            return Err(format!(
                "website runtime duplicate: {} contains `{duplicate}`; use packages/browser-runtime",
                main_path.display()
            ));
        }
    }
    Ok(())
}

fn check_browser_single_sources(root: &Path) -> Result<(), String> {
    // The old `src/webIntegration.ts` re-export shim is deleted: the website
    // imports the shared browser runtime directly. The shim must not return.
    let shim_path = root.join("src/webIntegration.ts");
    if shim_path.exists() {
        return Err(format!(
            "website integration duplicate: {} must not exist; import ../packages/browser-runtime/src/web-integration.ts directly",
            shim_path.display()
        ));
    }

    let types_path = root.join("packages/browser-runtime/src/types.ts");
    let types = std::fs::read_to_string(&types_path)
        .map_err(|e| format!("read {}: {e}", types_path.display()))?;
    for literal in [
        "Direct from your browser",
        "Metadata proxy",
        "Display only",
        "Browser session",
        "Native",
    ] {
        if types.contains(literal) {
            return Err(format!(
                "transport label duplicate: {} contains `{literal}`; labels live only in transport-labels.ts",
                types_path.display()
            ));
        }
    }
    Ok(())
}

fn check_shared_ui(dir: &Path) -> Result<(), String> {
    for file in list_ts(dir)? {
        let text =
            std::fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let code = strip_comments_and_strings(&text);
        for token in tokens(&code) {
            if FORBIDDEN_TOKENS.contains(&token.as_str()) {
                return Err(format!(
                    "shared-ui host leak: {} references `{token}` (shared-ui never imports window/fetch/chrome/tauri)",
                    file.display()
                ));
            }
        }
        for spec in quoted_specifiers(&strip_comments(&text)) {
            if spec.contains("browser-runtime") {
                return Err(format!(
                    "shared-ui inversion: {} imports `{spec}` (canonical helpers live in @dezoomify/app-model)",
                    file.display()
                ));
            }
        }
    }
    Ok(())
}

fn check_app_model(dir: &Path) -> Result<(), String> {
    for file in list_ts(dir)? {
        let text =
            std::fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let code = strip_comments_and_strings(&text);
        for token in tokens(&code) {
            if APP_MODEL_FORBIDDEN_TOKENS.contains(&token.as_str()) {
                return Err(format!(
                    "app-model host leak: {} references `{token}` (app-model is React-free with no host globals)",
                    file.display()
                ));
            }
        }
        for spec in quoted_specifiers(&strip_comments(&text)) {
            if spec.contains("browser-runtime")
                || spec.contains("shared-ui")
                || spec == "react"
                || spec.starts_with("react/")
                || spec == "react-dom"
                || spec.starts_with("react-dom/")
                || spec.contains("@tauri")
            {
                return Err(format!(
                    "app-model inversion: {} imports `{spec}` (app-model imports generated bindings and siblings only)",
                    file.display()
                ));
            }
        }
    }
    Ok(())
}

fn check_desktop_service(path: &Path) -> Result<(), String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    for required in ["@tauri-apps/api/core", "@tauri-apps/api/event"] {
        if !text.contains(required) {
            return Err(format!(
                "desktop service bypass: {} must use the public Tauri API `{required}`",
                path.display()
            ));
        }
    }
    for forbidden in ["__TAURI_INTERNALS__", "__TAURI_EVENT__", "__TAURI__"] {
        if text.contains(forbidden) {
            return Err(format!(
                "desktop service host leak: {} references `{forbidden}` (use @tauri-apps/api with explicit doubles)",
                path.display()
            ));
        }
    }
    Ok(())
}

fn check_runtime(dir: &Path) -> Result<(), String> {
    for file in list_ts(dir)? {
        let text =
            std::fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        for spec in quoted_specifiers(&strip_comments(&text)) {
            if spec.contains("shared-ui") {
                return Err(format!(
                    "browser-runtime inversion: {} imports `{spec}` (browser-runtime never imports shared-ui)",
                    file.display()
                ));
            }
        }
    }
    Ok(())
}

fn list_ts(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    let mut entries: Vec<_> = entries
        .map(|e| e.map_err(|e| format!("dir entry: {e}")))
        .collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            out.extend(list_ts(&path)?);
        } else if path.extension().and_then(|e| e.to_str()) == Some("ts") {
            out.push(path);
        }
    }
    Ok(out)
}

/// Split code into lowercase identifier tokens after removing comments and
/// string/template literals (template `${...}` interpolations stay code).
fn tokens(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in code.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Quoted literal segments (import/export specifiers live here).
fn quoted_specifiers(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = code.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let q = bytes[i];
        if q == b'\'' || q == b'"' {
            let mut j = i + 1;
            let mut seg = String::new();
            while j < bytes.len() && bytes[j] != q {
                if bytes[j] == b'\\' && j + 1 < bytes.len() {
                    j += 1;
                }
                seg.push(bytes[j] as char);
                j += 1;
            }
            out.push(seg);
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Remove line/block comments only; strings stay so import/export
/// specifiers remain visible to the specifier scan.
fn strip_comments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else if c == b'\'' || c == b'"' {
            let end = skip_quoted(bytes, i);
            out.push_str(&text[i..end.min(text.len())]);
            i = end;
        } else if c == b'`' {
            let mut tmp = String::new();
            i = skip_template(bytes, i, &mut tmp);
            out.push_str(&tmp);
        } else {
            out.push(c as char);
            i += 1;
        }
    }
    out
}

/// Remove line/block comments plus string and template literals. Template
/// `${...}` interpolation contents are kept (they are code, not text).
fn strip_comments_and_strings(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else if c == b'\'' || c == b'"' {
            i = skip_quoted(bytes, i);
        } else if c == b'`' {
            i = skip_template(bytes, i, &mut out);
        } else {
            out.push(c as char);
            i += 1;
        }
    }
    out
}

fn skip_quoted(bytes: &[u8], start: usize) -> usize {
    let q = bytes[start];
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == q {
            return i + 1;
        }
        i += 1;
    }
    i
}

/// Skip a template literal, preserving `${...}` interpolations as code.
fn skip_template(bytes: &[u8], start: usize, out: &mut String) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b'`' {
            return i + 1;
        }
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            out.push(' ');
            let mut depth = 1;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'{' {
                    depth += 1;
                } else if bytes[i] == b'}' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                out.push(bytes[i] as char);
                i += 1;
            }
            out.push(' ');
            i += 1;
            continue;
        }
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::{quoted_specifiers, strip_comments, strip_comments_and_strings, tokens};

    #[test]
    fn shared_ui_chrome_copy_is_not_a_host_leak() {
        // "Chrome Web Store" user copy plus "Modal chrome" comments must not
        // trip the gate: strings and comments are stripped first.
        let code = strip_comments_and_strings(
            "// Modal chrome (shared view.ts openModal).\nconst s = \"Chrome Web Store\";\nrenderView(root);\n",
        );
        assert!(!tokens(&code).iter().any(|t| t == "chrome"));
    }

    #[test]
    fn template_interpolations_stay_code() {
        let code = strip_comments_and_strings("const s = `hello ${window.location} world`;\n");
        assert!(tokens(&code).iter().any(|t| t == "window"));
    }

    #[test]
    fn specifier_scan_spots_shared_ui_imports() {
        let specs = quoted_specifiers(&strip_comments(
            "import { x } from \"../../shared-ui/src/saveName.ts\";\n",
        ));
        assert!(specs.iter().any(|s| s.contains("shared-ui")));
        let clean = quoted_specifiers(&strip_comments(
            "import { y } from \"./save-name.ts\";\n// shared-ui mentioned here is fine\n",
        ));
        assert!(!clean.iter().any(|s| s.contains("shared-ui")));
    }
}
