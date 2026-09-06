//! Normalized human/machine reporting: stdout = JSON events with --json,
//! stderr = human progress. Never mixed.

use std::collections::BTreeMap;

#[must_use]
pub fn machine_event_detail(
    job: &str,
    seq: u64,
    kind: &str,
    detail: &BTreeMap<String, String>,
) -> String {
    serde_json::json!({"job": job, "seq": seq, "kind": kind, "detail": detail}).to_string()
}

#[must_use]
pub fn machine_completed(
    job: &str,
    seq: u64,
    output_hash: &str,
    format: &str,
    width: u32,
    height: u32,
    tile_count: usize,
) -> String {
    serde_json::json!({
        "job": job,
        "seq": seq,
        "kind": "completed",
        "outputHash": output_hash,
        "format": format,
        "width": width,
        "height": height,
        "tileCount": tile_count,
    })
    .to_string()
}

/// One bulk entry outcome for summaries: `ok` with an output hash, or
/// `failed` with a stable error code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BulkItem {
    pub index: usize,
    pub url: String,
    pub output: String,
    pub status: String,
    pub detail: String,
}

impl BulkItem {
    #[must_use]
    pub fn ok(index: usize, url: &str, output: &str, output_hash: &str) -> Self {
        Self {
            index,
            url: url.to_string(),
            output: output.to_string(),
            status: "ok".to_string(),
            detail: output_hash.to_string(),
        }
    }

    #[must_use]
    pub fn failed(index: usize, url: &str, output: &str, code: &str, message: &str) -> Self {
        Self {
            index,
            url: url.to_string(),
            output: output.to_string(),
            status: "failed".to_string(),
            detail: format!("{code}: {message}"),
        }
    }
}

#[must_use]
pub fn human_bulk_summary(total: usize, succeeded: usize, failed: usize) -> String {
    format!("bulk: {succeeded} succeeded, {failed} failed, {total} total")
}

#[must_use]
pub fn machine_bulk_summary(total: usize, succeeded: usize, failed: usize) -> String {
    serde_json::json!({
        "kind": "bulk-completed",
        "total": total,
        "succeeded": succeeded,
        "failed": failed,
    })
    .to_string()
}

#[must_use]
pub fn machine_bulk_item(item: &BulkItem) -> String {
    serde_json::json!({
        "kind": "bulk-item",
        "index": item.index,
        "url": item.url,
        "output": item.output,
        "status": item.status,
        "detail": item.detail,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_summary_shapes() {
        assert_eq!(
            human_bulk_summary(3, 2, 1),
            "bulk: 2 succeeded, 1 failed, 3 total"
        );
        let machine: serde_json::Value =
            serde_json::from_str(&machine_bulk_summary(3, 2, 1)).expect("json");
        assert_eq!(machine["kind"], "bulk-completed");
        assert_eq!(machine["total"], 3);
        assert_eq!(machine["succeeded"], 2);
        assert_eq!(machine["failed"], 1);
        let item = BulkItem::ok(0, "https://example.test/a.dzi", "a_1.png", "sha256:abc");
        let line: serde_json::Value =
            serde_json::from_str(&machine_bulk_item(&item)).expect("json");
        assert_eq!(line["kind"], "bulk-item");
        assert_eq!(line["status"], "ok");
    }
}
