//! `cargo xtask check` architecture gate (todo 2.2): dependency direction.
//!
//! - `packages/shared-ui` is host-neutral: after stripping comments and
//!   string literals, no module may reference the host globals `window`,
//!   `fetch`, `chrome`, or `tauri` (the extension page's no-bundler replica
//!   and the browser runtimes own every host effect).
//! - `packages/browser-runtime` never imports `shared-ui`: save names and
//!   transport labels live one layer down (`save-name.ts`,
//!   `transport-labels.ts`) and shared-ui re-exports them, so the dependency
//!   points inward.
//!
//! Only quoted import/export specifiers count for the runtime rule, so prose
//! comments mentioning shared-ui stay allowed.

use std::path::{Path, PathBuf};

/// Host-global tokens forbidden in shared-ui code (lowercase compare).
const FORBIDDEN_TOKENS: &[&str] = &["window", "fetch", "chrome", "tauri"];

pub fn verify(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    let root = super::repo_root();
    check_shared_ui(&root.join("packages/shared-ui/src"))?;
    check_runtime(&root.join("packages/browser-runtime/src"))?;
    check_browser_single_sources(&root)?;
    println!("architecture: ok");
    Ok(())
}

fn check_browser_single_sources(root: &Path) -> Result<(), String> {
    let shim_path = root.join("src/webIntegration.ts");
    let shim = std::fs::read_to_string(&shim_path)
        .map_err(|e| format!("read {}: {e}", shim_path.display()))?;
    let code: String = shim
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    if code.trim() != "export * from \"../packages/browser-runtime/src/web-integration.ts\";" {
        return Err(format!(
            "website integration duplicate: {} must remain a re-export-only compatibility shim",
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

    #[test]
    fn repo_passes_the_gate() {
        assert!(super::verify(&[]).is_ok());
    }
}
