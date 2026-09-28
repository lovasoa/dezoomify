//! Bounded local observations, separate from the authoritative engine state.
use dezoomify::model::{
    DiagnosticFailureGroup, DiagnosticLevel, DiagnosticRecord, DiagnosticReport, DiagnosticValue,
    Snapshot,
};
use regex::{Captures, Regex};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, LazyLock, Mutex,
};
use std::time::Instant;

pub const MAX_BYTES: usize = 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("(?i)authorization|cookie|password|secret|token|signature|api.?key|credential|(^|[._-])(auth|session|sig|key|policy)($|[._-])|^x-amz-|^x-goog-").expect("constant regex")
});
static QUERY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([?&#])([^=&#\s]+)=([^&#\s]*)").expect("constant regex"));
static USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(https?://)[^\s/@]+@").expect("constant regex"));
static AUTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+").expect("constant regex")
});
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(authorization|auth|cookie|passwd|password|secret|session(?:id|token)?|sid|ticket|token|signature|api[_-]?key)\s*[:=]\s*[^\s,;&#]+").expect("constant regex")
});
static PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)file://[^\s"'<>]+|(?:^|[\s"'(])(?:/(?:home|Users|tmp|private|var)/|[A-Z]:\\)[^\s"'<>)]*"#).expect("constant regex")
});

pub fn redact(text: &str) -> String {
    let text = USERINFO.replace_all(text, "$1[redacted]@");
    let text = QUERY.replace_all(&text, |c: &Captures<'_>| {
        let decoded = url::form_urlencoded::parse(format!("{}=", &c[2]).as_bytes())
            .next()
            .map(|(key, _)| key.into_owned())
            .unwrap_or_default();
        if SECRET.is_match(&decoded)
            || matches!(
                decoded.to_ascii_lowercase().as_str(),
                "bearer" | "code" | "passwd" | "sessionid" | "sid" | "state" | "ticket"
            )
        {
            format!("{}{}=[redacted]", &c[1], &c[2])
        } else {
            c[0].to_owned()
        }
    });
    let text = AUTH.replace_all(&text, "$1 [redacted]");
    let text = TOKENS.replace_all(&text, "$1=[redacted]");
    PATH.replace_all(&text, "[local path]")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

fn fields(value: Value, truncated: &mut u32) -> BTreeMap<String, DiagnosticValue> {
    fn visit(
        key: String,
        value: Value,
        depth: usize,
        left: &mut usize,
        truncated: &mut u32,
        out: &mut BTreeMap<String, DiagnosticValue>,
    ) {
        let key: String = redact(&key).chars().take(256).collect();
        if out.len() >= 48 || depth > 4 {
            *truncated += 1;
            return;
        }
        if SECRET.is_match(&key)
            && !key.contains("header_names")
            && !key.contains("credentials_present")
        {
            out.insert(key, DiagnosticValue::Text("[redacted]".into()));
            return;
        }
        match value {
            Value::String(s) => {
                let text = redact(&s);
                let limit = (*left).min(4096);
                let mut bounded: String = text.chars().take(limit).collect();
                *left = left.saturating_sub(bounded.chars().count());
                if bounded.len() < text.len() {
                    bounded.push_str("…[truncated]");
                    *truncated += 1;
                }
                out.insert(key, DiagnosticValue::Text(bounded));
            }
            Value::Number(n) => {
                if let Some(n) = n.as_f64() {
                    out.insert(key, DiagnosticValue::Number(n));
                }
            }
            Value::Bool(b) => {
                out.insert(key, DiagnosticValue::Bool(b));
            }
            Value::Object(map) => {
                for (name, value) in map {
                    if matches!(name.as_str(), "contents" | "body" | "pixels" | "tile_bytes")
                        || (name == "bytes" && !value.is_number())
                    {
                        continue;
                    }
                    let next = if key.is_empty() {
                        name.clone()
                    } else {
                        format!("{key}.{name}")
                    };
                    let value = if matches!(
                        name.as_str(),
                        "path" | "destination" | "output_dir" | "cache_dir"
                    ) {
                        Value::String("[local path]".into())
                    } else {
                        value
                    };
                    visit(next, value, depth + 1, left, truncated, out);
                }
            }
            Value::Array(items) => {
                for (index, value) in items.into_iter().take(48).enumerate() {
                    visit(
                        format!("{key}.{index}"),
                        value,
                        depth + 1,
                        left,
                        truncated,
                        out,
                    );
                }
            }
            Value::Null => {}
        }
    }
    let mut result = BTreeMap::new();
    visit(String::new(), value, 0, &mut 8192, truncated, &mut result);
    result
}

#[derive(Clone)]
pub struct Diagnostics {
    inner: Arc<Mutex<State>>,
    started: Instant,
}

type Sink = Arc<dyn Fn(&DiagnosticRecord) + Send + Sync>;
struct State {
    sink: Option<Sink>,
    report: DiagnosticReport,
    sequence: u32,
    bytes: usize,
    phase: String,
    selection: String,
}

impl std::fmt::Debug for Diagnostics {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Diagnostics { .. }")
    }
}

impl Diagnostics {
    pub fn new(product: &str, version: &str) -> Self {
        let result = Self {
            started: Instant::now(),
            inner: Arc::new(Mutex::new(State {
                report: DiagnosticReport {
                    schema_version: 1,
                    id: format!(
                        "{product}-{}-{}",
                        std::process::id(),
                        NEXT.fetch_add(1, Ordering::Relaxed)
                    ),
                    context: BTreeMap::new(),
                    counters: BTreeMap::new(),
                    failures: Vec::new(),
                    records: Vec::new(),
                    outcome: None,
                    omitted_records: 0,
                    truncated_fields: 0,
                },
                sink: None,
                sequence: 0,
                bytes: 0,
                phase: String::new(),
                selection: String::new(),
            })),
        };
        result.context(json!({"product": product, "version": version, "protocol": "2.0", "os": std::env::consts::OS, "arch": std::env::consts::ARCH}));
        result
    }

    pub fn context(&self, facts: Value) {
        if let Ok(mut state) = self.inner.lock() {
            let clean = fields(facts, &mut state.report.truncated_fields);
            for (key, value) in clean {
                if state.report.context.len() < 128 || state.report.context.contains_key(&key) {
                    state.report.context.insert(key, value);
                }
            }
        }
    }

    pub fn count(&self, name: &str, value: f64) {
        if !value.is_finite() {
            return;
        }
        let name: String = redact(name).chars().take(128).collect();
        if let Ok(mut state) = self.inner.lock() {
            if state.report.counters.len() < 48 || state.report.counters.contains_key(&name) {
                *state.report.counters.entry(name).or_default() += value;
            }
        }
    }

    pub fn record(&self, level: DiagnosticLevel, event: &str, facts: Value) {
        let mut notification = None;
        if let Ok(mut state) = self.inner.lock() {
            state.sequence = state.sequence.saturating_add(1);
            let entry = DiagnosticRecord {
                sequence: state.sequence,
                elapsed_ms: self.started.elapsed().as_secs_f64() * 1000.0,
                level,
                event: redact(event).chars().take(128).collect(),
                fields: fields(facts, &mut state.report.truncated_fields),
            };
            let mut repeated = false;
            if matches!(level, DiagnosticLevel::Warn | DiagnosticLevel::Error) {
                let key = format!(
                    "{}|{:?}|{:?}|{:?}|{:?}",
                    entry.event,
                    entry.fields.get("code"),
                    entry.fields.get("transport"),
                    entry.fields.get("http"),
                    entry.fields.get("purpose")
                );
                if let Some(group) = state.report.failures.iter_mut().find(|g| g.key == key) {
                    group.count = group.count.saturating_add(1);
                    group.last = entry.clone();
                    repeated = true;
                } else if state.report.failures.len() < 16 {
                    state.report.failures.push(DiagnosticFailureGroup {
                        key,
                        count: 1,
                        first: entry.clone(),
                        last: entry.clone(),
                    });
                }
            }
            if level != DiagnosticLevel::Trace && !repeated {
                let bytes = serde_json::to_vec(&entry).map_or(0, |v| v.len());
                while !state.report.records.is_empty()
                    && (state.report.records.len() >= 1000 || state.bytes + bytes > 256 * 1024)
                {
                    let first = state.report.records.remove(0);
                    state.bytes = state
                        .bytes
                        .saturating_sub(serde_json::to_vec(&first).map_or(0, |v| v.len()));
                    state.report.omitted_records += 1;
                }
                state.bytes += bytes;
                state.report.records.push(entry.clone());
            }
            if !repeated {
                notification = state.sink.clone().map(|sink| (sink, entry));
            }
        }
        if let Some((sink, entry)) = notification {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(&entry)));
        }
    }

    pub fn set_sink(&self, sink: impl Fn(&DiagnosticRecord) + Send + Sync + 'static) {
        if let Ok(mut state) = self.inner.lock() {
            state.sink = Some(Arc::new(sink));
        }
    }

    pub fn finish(&self, event: &str, facts: Value) {
        if self.inner.lock().is_ok_and(|s| s.report.outcome.is_some()) {
            return;
        }
        self.record(
            if event.contains("failed") {
                DiagnosticLevel::Error
            } else {
                DiagnosticLevel::Info
            },
            event,
            facts.clone(),
        );
        if let Ok(mut state) = self.inner.lock() {
            if state.report.outcome.is_none() {
                state.report.outcome = Some(DiagnosticRecord {
                    sequence: state.sequence,
                    elapsed_ms: self.started.elapsed().as_secs_f64() * 1000.0,
                    level: if event.contains("failed") {
                        DiagnosticLevel::Error
                    } else {
                        DiagnosticLevel::Info
                    },
                    event: redact(event).chars().take(128).collect(),
                    fields: fields(facts, &mut state.report.truncated_fields),
                });
            }
        }
    }

    pub fn observe(&self, snapshot: &Snapshot) {
        let phase = format!("{:?}:{}", snapshot.lifecycle, snapshot.paused);
        let (changed, selected) = if let Ok(mut state) = self.inner.lock() {
            state
                .report
                .counters
                .insert("tiles_completed".into(), snapshot.progress.completed as f64);
            if let Some(total) = snapshot.progress.total {
                state
                    .report
                    .counters
                    .insert("tiles_total".into(), total as f64);
            }
            let changed = state.phase != phase;
            state.phase = phase;
            let selection = format!(
                "{:?}:{:?}",
                snapshot.selection.image, snapshot.selection.level
            );
            let selected = selection != state.selection;
            state.selection = selection;
            (changed, selected)
        } else {
            return;
        };
        if changed {
            self.record(DiagnosticLevel::Info, "phase", json!({"phase": snapshot.lifecycle, "paused": snapshot.paused, "revision": snapshot.revision}));
        }
        if selected {
            if let Some(dezoomify::model::CatalogEntry::Image(image)) =
                snapshot.selection.catalog.as_ref().and_then(|c| {
                    c.entries
                        .get(snapshot.selection.image.unwrap_or(u32::MAX) as usize)
                })
            {
                let facts = json!({"format": image.format, "image": snapshot.selection.image, "level": snapshot.selection.level, "levels": image.levels.len(), "title": image.title, "size": image.levels.get(snapshot.selection.level.unwrap_or(u32::MAX) as usize).and_then(|l| l.size.as_ref()), "maximum": image.size, "source_kind": image.source_kind});
                self.context(json!({"selection": facts}));
                self.record(DiagnosticLevel::Info, "selection", facts);
            }
        }
    }

    pub fn report(&self) -> DiagnosticReport {
        let mut report = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .report
            .clone();
        let size = |r: &DiagnosticReport| serde_json::to_vec(r).map_or(0, |v| v.len());
        while size(&report) > MAX_BYTES && !report.records.is_empty() {
            report.records.remove(0);
            report.omitted_records += 1;
        }
        while size(&report) > MAX_BYTES && report.failures.len() > 1 {
            report.failures.pop();
            report.omitted_records += 1;
        }
        while size(&report) > MAX_BYTES && !report.context.is_empty() {
            report.context.pop_last();
            report.truncated_fields += 1;
        }
        report
    }
}
