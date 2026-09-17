//! Scripted deterministic host for job workflow tests.
//!
//! The host feeds scripted [`JobCommand`] inputs to a [`Job`] and collects a
//! transcript of `state:` / `effect:` / `event:` strings in deterministic
//! order. It performs no I/O, clock reads, or randomness during execution.

#![allow(dead_code)]

use dezoomify_job::{
    Config, Job, JobCommand, JobEffect, JobError, JobEvent, JobInput, JobMessageBody, Outcome,
};

/// Recognizable Deep Zoom input URL: the registry's deepzoom candidate
/// accepts it and asks for the `.dzi` document at `req:0`.
pub const DZI_INPUT_URL: &str = "https://example.test/image.dzi";

/// A real Deep Zoom metadata document: 512x512, 256px tiles, no overlap.
/// The core parses it into a deepzoom catalog with ten grid levels ordered
/// ascending by size; the largest (last in the list) carries
/// four tiles with deterministic `image_files` URIs.
pub const DZI: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
"#;

/// Deterministic host wrapping one [`Job`] plus an ordered transcript.
#[derive(Debug)]
pub struct ScriptedHost {
    job: Job,
    transcript: Vec<String>,
    /// Raw effect objects in arrival order (for id extraction in tests).
    pub effects: Vec<serde_json::Value>,
    /// Raw event objects in arrival order (for id extraction in tests).
    pub events: Vec<serde_json::Value>,
    last_state: String,
}

impl ScriptedHost {
    /// Create a host with a validated job, recording the initial state.
    ///
    /// # Errors
    ///
    /// Returns [`JobError`] when the URL or config is invalid.
    pub fn new(_job_id: &str, input_url: &str, config: Config) -> Result<Self, JobError> {
        let job = Job::new(input_url, config)?;
        Self::from_job(job)
    }

    pub fn new_with_inputs(inputs: Vec<JobInput>, config: Config) -> Result<Self, JobError> {
        let job = Job::new_with_inputs(inputs, config)?;
        Self::from_job(job)
    }

    fn from_job(job: Job) -> Result<Self, JobError> {
        let last_state = job.state().name().to_string();
        let mut host = Self {
            job,
            transcript: Vec::new(),
            effects: Vec::new(),
            events: Vec::new(),
            last_state: String::new(),
        };
        host.transcript.push(format!("state:{last_state}"));
        host.last_state = last_state;
        Ok(host)
    }

    /// Start the job and record resulting effects/events/state.
    ///
    /// # Errors
    ///
    /// Propagates [`JobError`] from [`Job::start`].
    pub fn start(&mut self) -> Result<Outcome, JobError> {
        let outcome = self.job.start()?;
        self.record();
        Ok(outcome)
    }

    /// Apply one scripted response and record resulting effects/events/state.
    ///
    /// # Errors
    ///
    /// Propagates [`JobError`] rejections; rejected and ignored inputs leave
    /// the transcript unchanged.
    pub fn apply(&mut self, response: JobCommand) -> Result<Outcome, JobError> {
        let outcome = self.job.on_command(response);
        match &outcome {
            Ok(_) => {
                self.record();
            }
            Err(_) => {
                // Rejections must not add work: drains stay empty and state is
                // unchanged, so recording is a no-op. Drain defensively to
                // prove no queued work leaked.
                debug_assert!(
                    self.job.drain_messages().is_empty(),
                    "rejection queued messages"
                );
            }
        }
        outcome
    }

    /// Ordered transcript of `state:` / `effect:` / `event:` entries.
    #[must_use]
    pub fn transcript(&self) -> &[String] {
        &self.transcript
    }

    /// Current job state name.
    #[must_use]
    pub fn state(&self) -> String {
        self.job.state().name().to_string()
    }

    /// Borrow the inner job for terminal and queue assertions.
    #[must_use]
    pub fn job(&self) -> &Job {
        &self.job
    }

    /// Deferred follow-up URI for a wire image id, if still deferred.
    #[must_use]
    pub fn deferred_uri_for_test(&self, image: u32) -> Option<String> {
        self.job.deferred_uri(image)
    }

    /// Count terminal events in the transcript (must be 0 or 1).
    #[must_use]
    pub fn terminal_count(&self) -> usize {
        self.transcript
            .iter()
            .filter(|line| {
                line.starts_with("event:completed:")
                    || line.starts_with("event:partial-completed:")
                    || line.starts_with("event:failed:")
                    || line.starts_with("event:cancelled:")
            })
            .count()
    }

    /// Canonical JSON array of the transcript (pretty, LF ending).
    #[must_use]
    pub fn canonical_json(&self) -> String {
        serde_json::to_string_pretty(&self.transcript).unwrap_or_else(|_| "[]".to_string()) + "\n"
    }

    /// Positions of the first catalog image and its levels.
    pub fn catalog(&self) -> Option<(u32, Vec<u32>)> {
        let event = self
            .events
            .iter()
            .rev()
            .find(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("catalog"))?;
        let image = event.get("images")?.get(0)?;
        let levels: Vec<u32> = image
            .get("levels")?
            .as_array()?
            .iter()
            .enumerate()
            .filter_map(|(position, _)| u32::try_from(position).ok())
            .collect();
        Some((0, levels))
    }

    /// Every `acquire-tile` effect as `(tile id, uri, probe flag)` in seq order.
    pub fn tile_effects(&self) -> Vec<(u32, String, bool)> {
        self.effects
            .iter()
            .filter(|v| v.get("kind").and_then(serde_json::Value::as_str) == Some("acquire-tile"))
            .map(|v| {
                (
                    v.get("tile")
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|value| u32::try_from(value).ok())
                        .unwrap_or(0),
                    v.get("uri")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    v.get("probe")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                )
            })
            .collect()
    }

    fn record(&mut self) {
        for message in self.job.drain_messages() {
            match message.body {
                JobMessageBody::Effect(effect) => {
                    let value = effect_json(message.sequence, effect);
                    self.transcript.push(format_effect(&value).1);
                    self.effects.push(value);
                }
                JobMessageBody::Event(event) => {
                    let value = event_json(message.sequence, event);
                    self.transcript.push(format_event(&value).1);
                    self.events.push(value);
                }
            }
        }
        let current = self.job.state().name().to_string();
        if current != self.last_state {
            self.transcript.push(format!("state:{current}"));
            self.last_state = current;
        }
    }
}

fn effect_json(seq: u32, effect: JobEffect) -> serde_json::Value {
    match effect {
        JobEffect::AcquireResource {
            request,
            uri,
            header_names,
        } => serde_json::json!({
            "kind": "acquire-resource", "seq": seq, "request": request,
            "uri": uri, "header_names": header_names, "purpose": "metadata",
        }),
        JobEffect::AcquireTile {
            tile,
            uri,
            headers,
            processing,
            destination,
            expected_size,
            canvas,
            probe,
            probe_output,
        } => {
            let processing = match processing {
                dezoomify_core::core::model::ProcessingRecipe::None => "none",
                dezoomify_core::core::model::ProcessingRecipe::GoogleArtsDecrypt => {
                    "google-arts-decrypt"
                }
            };
            let mut value = serde_json::json!({
                "kind": "acquire-tile", "seq": seq, "tile": tile, "uri": uri,
                "headers": headers, "processing": processing,
                "destination": {"x": destination.x, "y": destination.y},
                "expected_size": expected_size.map(|v| serde_json::json!({"x": v.x, "y": v.y})),
                "canvas": canvas.map(|v| serde_json::json!({"x": v.x, "y": v.y})),
            });
            if probe {
                value["probe"] = serde_json::Value::Bool(true);
            }
            if probe_output {
                value["probe_output"] = serde_json::Value::Bool(true);
            }
            value
        }
        JobEffect::FinalizeOutput {
            partial,
            format,
            canvas,
        } => {
            serde_json::json!({"kind":"finalize-output","seq":seq,"partial":partial,"format":format,"canvas":canvas.map(|v| serde_json::json!({"x":v.x,"y":v.y}))})
        }
        JobEffect::CancelWork => serde_json::json!({"kind":"cancel-work","seq":seq}),
        JobEffect::RequestDecision { generation } => serde_json::json!({
            "kind":"request-decision","seq":seq,"generation":generation,
        }),
    }
}

fn event_json(seq: u32, event: JobEvent) -> serde_json::Value {
    match event {
        JobEvent::State { state } => {
            serde_json::json!({"kind":"job-state","seq":seq,"state":state.name()})
        }
        JobEvent::Catalog { catalog } => {
            serde_json::json!({"kind":"catalog","seq":seq,"images":catalog.images})
        }
        JobEvent::Levels { image, levels } => {
            serde_json::json!({"kind":"levels","seq":seq,"image":image,"levels":levels})
        }
        JobEvent::Progress { acquired, total } => {
            serde_json::json!({"kind":"progress","seq":seq,"acquired":acquired,"total":total})
        }
        JobEvent::Warning { tile, attempt } => {
            serde_json::json!({"kind":"warning","seq":seq,"tile":tile,"attempt":attempt})
        }
        JobEvent::MissingWork { failed } => {
            serde_json::json!({"kind":"missing-work","seq":seq,"failed":failed})
        }
        JobEvent::RecoveryRequested { generation } => serde_json::json!({
            "kind":"recovery-requested","seq":seq,"generation":generation,
        }),
        JobEvent::Completed => serde_json::json!({"kind":"completed","seq":seq}),
        JobEvent::PartialCompleted => {
            serde_json::json!({"kind":"partial-completed","seq":seq})
        }
        JobEvent::Failed { code, message } => {
            serde_json::json!({"kind":"failed","seq":seq,"code":code,"message":message})
        }
        JobEvent::Cancelled => serde_json::json!({"kind":"cancelled","seq":seq}),
        JobEvent::Paused => serde_json::json!({"kind":"paused","seq":seq}),
        JobEvent::Resumed => serde_json::json!({"kind":"resumed","seq":seq}),
    }
}

fn seq_of(value: &serde_json::Value) -> u64 {
    value
        .get("seq")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(u64::MAX)
}

fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
}

fn format_effect(value: &serde_json::Value) -> (u64, String) {
    let seq = seq_of(value);
    let kind = str_field(value, "kind").unwrap_or_else(|| "-".to_string());
    let corr = match kind.as_str() {
        "acquire-resource" => str_field(value, "request"),
        "acquire-tile" => str_field(value, "tile"),
        "request-decision" => str_field(value, "generation"),
        _ => None,
    }
    .unwrap_or_else(|| "-".to_string());
    (seq, format!("effect:{kind}:{corr}:seq:{seq}"))
}

fn format_event(value: &serde_json::Value) -> (u64, String) {
    let seq = seq_of(value);
    let kind = str_field(value, "kind").unwrap_or_else(|| "-".to_string());
    let detail = match kind.as_str() {
        "job-state" => str_field(value, "state"),
        "catalog" => value
            .get("images")
            .and_then(|images| images.as_array())
            .and_then(|images| images.first())
            .and_then(|first| first.get("id"))
            .and_then(|id| id.as_str())
            .map(ToString::to_string),
        "levels" => value
            .get("levels")
            .and_then(|levels| levels.as_array())
            .and_then(|levels| levels.first())
            .and_then(|id| id.as_str())
            .map(ToString::to_string),
        "progress" => {
            let acquired = value
                .get("acquired")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let total = value
                .get("total")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            Some(format!("{acquired}/{total}"))
        }
        "warning" => match (str_field(value, "tile"), value.get("attempt")) {
            (Some(tile), Some(attempt)) => Some(format!("{tile}#{attempt}")),
            (Some(tile), None) => Some(tile),
            _ => None,
        },
        "recovery-requested" => str_field(value, "reason"),
        "missing-work" => value.get("failed").and_then(|failed| {
            failed.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
        }),
        "completed" | "partial-completed" => str_field(value, "output"),
        "failed" => str_field(value, "code"),
        _ => None,
    }
    .unwrap_or_else(|| "-".to_string());
    (seq, format!("event:{kind}:{detail}:seq:{seq}"))
}
