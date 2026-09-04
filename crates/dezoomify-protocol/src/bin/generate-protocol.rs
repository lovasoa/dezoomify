//! `generate-protocol`: deterministic Rust -> TypeScript/schema generator.
//! Usage: `generate-protocol --out <dir> [--check]`.

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out: Option<PathBuf> = None;
    let mut check = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                i += 1;
                out = args.get(i).map(PathBuf::from);
            }
            "--check" => check = true,
            other => {
                eprintln!("unknown arg {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }
    let out = out.unwrap_or_else(|| PathBuf::from("packages/protocol-ts"));
    if check {
        let tmp = std::env::temp_dir().join(format!("proto-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        dezoomify_protocol::generate::write_all(&tmp).expect("generate to tmp");
        let mut drift = Vec::new();
        for rel in [
            "src/generated.ts",
            "schema/protocol-v1.schema.json",
            "schema/capabilities-v1.schema.json",
            "fingerprints.json",
        ] {
            let expected = std::fs::read_to_string(tmp.join(rel)).expect("read tmp artifact");
            let current = std::fs::read_to_string(out.join(rel)).unwrap_or_default();
            if expected != current {
                drift.push(rel.to_string());
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        if !drift.is_empty() {
            eprintln!("protocol artifacts drift: {}", drift.join(", "));
            eprintln!("run `cargo xtask protocol generate` to regenerate");
            std::process::exit(1);
        }
        println!("protocol artifacts: clean");
    } else {
        let written = dezoomify_protocol::generate::write_all(&out).expect("write artifacts");
        println!("protocol artifacts: wrote {}", written.join(", "));
    }
}
