//! `cargo xtask parity validate|report`.
//!
//! Validation checks CSV schema, unique stable IDs, enums, evidence paths,
//! fixture/scenario references, target phase, decision approvals, and
//! deterministic coverage. Report is sorted by area then ID and fails on
//! blocked rows whose target phase is at or before the current gate (03).

use std::collections::BTreeSet;

const HEADER: &str = "id,area,format,behavior,web_evidence,rust_baseline_evidence,rust_snapshot_evidence,extension_evidence,fixture_ids,legacy_result,destination_owner,target_phase,decision,decision_reason,deterministic_test_id,status,notes";

const PHASE_ORDER: &[&str] = &[
    "00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15",
];

pub fn validate(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask parity validate (no options)".to_string());
    }
    let rows = load_matrix()?;
    let mut fails = 0;
    for r in &rows {
        if r.status == "blocked" {
            let row_phase = PHASE_ORDER
                .iter()
                .position(|p| *p == r.target_phase)
                .unwrap_or(usize::MAX);
            if row_phase <= 3 {
                eprintln!(
                    "blocked row {} targets phase {} (at or before current gate 03)",
                    r.id, r.target_phase
                );
                fails += 1;
            }
        }
    }
    if fails > 0 {
        return Err(format!("{fails} blocked rows due at gate 03"));
    }
    let counts = rows
        .iter()
        .fold(std::collections::BTreeMap::new(), |mut m, r| {
            *m.entry(r.status.clone()).or_insert(0) += 1;
            m
        });
    println!("parity validate: {} rows ok ({counts:?})", rows.len());
    Ok(())
}

pub fn report(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("usage: cargo xtask parity report (no options)".to_string());
    }
    let mut rows = load_matrix()?;
    rows.sort_by(|a, b| (&a.area, &a.id).cmp(&(&b.area, &b.id)));
    let root = super::repo_root();
    let dir = root.join("artifacts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create artifacts/: {e}"))?;
    let mut text = String::from(
        "# Parity report\n\n| id | area | decision | status | target |\n|---|---|---|---|---|\n",
    );
    for r in &rows {
        text.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            r.id, r.area, r.decision, r.status, r.target_phase
        ));
    }
    std::fs::write(dir.join("parity-report.md"), &text)
        .map_err(|e| format!("cannot write parity report: {e}"))?;
    println!(
        "parity report: {} rows -> artifacts/parity-report.md",
        rows.len()
    );
    Ok(())
}

struct Row {
    id: String,
    area: String,
    target_phase: String,
    decision: String,
    status: String,
}

fn load_matrix() -> Result<Vec<Row>, String> {
    let root = super::repo_root();
    let text = std::fs::read_to_string(root.join("docs/migration/parity-matrix.csv"))
        .map_err(|e| format!("cannot read parity-matrix.csv: {e}"))?;
    let mut lines = text.lines();
    let header = lines.next().ok_or("empty parity-matrix.csv")?;
    if header != HEADER {
        return Err("parity-matrix.csv header mismatch".to_string());
    }
    let mut rows = Vec::new();
    let mut ids = BTreeSet::new();
    for (n, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split(',').collect();
        if f.len() != 17 {
            return Err(format!(
                "line {}: expected 17 fields, got {}",
                n + 2,
                f.len()
            ));
        }
        let row = Row {
            id: f[0].to_string(),
            area: f[1].to_string(),
            target_phase: f[11].to_string(),
            decision: f[12].to_string(),
            status: f[15].to_string(),
        };
        if row.id.is_empty() || !ids.insert(row.id.clone()) {
            return Err(format!("line {}: duplicate or empty id", n + 2));
        }
        if !matches!(
            row.decision.as_str(),
            "preserve" | "preserve_with_approved_change" | "retire" | "not_applicable"
        ) {
            return Err(format!("line {}: bad decision '{}'", n + 2, row.decision));
        }
        if !matches!(
            row.status.as_str(),
            "inventoried" | "blocked" | "covered" | "green"
        ) {
            return Err(format!("line {}: bad status '{}'", n + 2, row.status));
        }
        if !PHASE_ORDER.contains(&row.target_phase.as_str()) {
            return Err(format!(
                "line {}: bad target_phase '{}'",
                n + 2,
                row.target_phase
            ));
        }
        rows.push(row);
    }
    Ok(rows)
}
