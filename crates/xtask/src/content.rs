//! Content guards: stale limits, banned vocab, timeout spread, encoder drift.
use std::path::Path;
use std::process::Command;
const ALLOW: &[&str] = &[
    "--dezoomer",
    "supportedDezoomers",
    "ALL_DEZOOMERS",
    "const dezoomers",
    "dezoomers.forEach",
    "dezoomer?:",
    "Generic dezoomer",
];
pub fn verify(a: &[String]) -> Result<(), String> {
    if !a.is_empty() {
        return Err("usage: cargo xtask check (no options)".to_string());
    }
    let r = super::repo_root();
    f(
        &r,
        &["1 GiB", "docs/user/start-here.md"],
        "stale 1 GiB in start-here.md (canonical is 8 GiB)",
    )?;
    f(
        &r,
        &["2 GB per tab"],
        "stale 2 GB per tab (use 8 GiB canvas limit)",
    )?;
    f(
        &r,
        &["268435456|16384", "docs/user/"],
        "raw canvas constant in docs/user/ (state limits in GiB)",
    )?;
    let o = g(
        &r,
        &[
            "-n",
            "-i",
            "dezoomer|readable tile bytes|tainted|blob allocation|multi[ -]?core",
            "docs/user/",
            "packages/shared-ui/src/view.ts",
            "packages/shared-ui/src/components.ts",
        ],
    )?;
    let v: Vec<&str> = o
        .lines()
        .filter(|l| !ALLOW.iter().any(|x| l.contains(x)))
        .collect();
    if !v.is_empty() {
        return Err(format!("banned vocab outside allowlist:\n{}", v.join("\n")));
    }
    if g(
        &r,
        &[
            "-o",
            "-N",
            "250 ?ms",
            "docs/user/",
            "packages/shared-ui/src/view.ts",
            "packages/shared-ui/src/components.ts",
        ],
    )?
    .lines()
    .count()
        > 2
    {
        return Err("250 ms appears >2x outside canonical transport docs".to_string());
    }
    let (p, q, d) = (
        std::fs::read_to_string(r.join("docs/product.md"))
            .map_err(|e| format!("read product.md: {e}"))?,
        std::fs::read_to_string(r.join("docs/protocol.md"))
            .map_err(|e| format!("read protocol.md: {e}"))?,
        std::fs::read_to_string(r.join("crates/dezoomify-protocol/src/dto.rs"))
            .map_err(|e| format!("read dto.rs: {e}"))?,
    );
    let b = |t: &str| {
        t.find("encoders `[")
            .and_then(|i| t[i..].find(']').map(|j| t[i..i + j + 1].to_string()))
    };
    if b(&p) != b(&q)
        || !["png", "jpeg", "tiff"]
            .iter()
            .all(|e| d.contains(&format!("\"{e}\"")))
    {
        return Err(format!(
            "encoder-list drift: product.md {:?} vs protocol.md {:?} vs dto.rs [png, jpeg, tiff]",
            b(&p),
            b(&q)
        ));
    }
    println!("content: ok");
    Ok(())
}
fn f(r: &Path, a: &[&str], m: &str) -> Result<(), String> {
    let o = g(r, &[&["-n"], a].concat())?;
    if o.trim().is_empty() {
        Ok(())
    } else {
        Err(format!("{m}:\n{o}"))
    }
}
fn g(r: &Path, a: &[&str]) -> Result<String, String> {
    let o = Command::new("rg")
        .args([
            "--no-heading",
            "--glob",
            "!.git/**",
            "--glob",
            "!target/**",
            "--glob",
            "!node_modules/**",
            "--glob",
            "!dist/**",
            "--glob",
            "!artifacts/**",
            "--glob",
            "!testdata/**",
            "--glob",
            "!crates/xtask/src/content.rs",
        ])
        .args(a)
        .current_dir(r)
        .output()
        .map_err(|e| format!("failed to run rg: {e}"))?;
    match o.status.code() {
        Some(0) => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Some(1) => Ok(String::new()),
        _ => Err(format!("rg failed: {}", String::from_utf8_lossy(&o.stderr))),
    }
}
