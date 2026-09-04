//! Bounded tile scheduler: pending/in-flight/done sets, peak counters,
//! explicit retry eligibility (attempt counts + retry_ready input, no clock).

use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub struct SchedulerConfig {
    pub max_concurrent: usize,
    pub max_tiles: usize,
    pub max_retries: u32,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            max_concurrent: 6,
            max_tiles: 1 << 20,
            max_retries: 3,
        }
    }
}

pub struct Scheduler {
    config: SchedulerConfig,
    pending: BTreeSet<String>,
    in_flight: BTreeSet<String>,
    done: BTreeSet<String>,
    attempts: BTreeMap<String, u32>,
    peak_in_flight: usize,
}

impl Scheduler {
    #[must_use]
    pub fn new(config: SchedulerConfig) -> Self {
        Self {
            config,
            pending: BTreeSet::new(),
            in_flight: BTreeSet::new(),
            done: BTreeSet::new(),
            attempts: BTreeMap::new(),
            peak_in_flight: 0,
        }
    }

    pub fn push(&mut self, tile: String) -> Result<(), String> {
        if self.pending.len() + self.in_flight.len() + self.done.len() >= self.config.max_tiles {
            return Err("tile limit exceeded".to_string());
        }
        self.pending.insert(tile);
        Ok(())
    }

    pub fn next_batch(&mut self) -> Vec<String> {
        let mut batch = Vec::new();
        while self.in_flight.len() < self.config.max_concurrent {
            let Some(tile) = self.pending.iter().next().cloned() else {
                break;
            };
            self.pending.remove(&tile);
            self.in_flight.insert(tile.clone());
            batch.push(tile);
        }
        self.peak_in_flight = self.peak_in_flight.max(self.in_flight.len());
        batch
    }

    pub fn complete(&mut self, tile: &str) {
        self.in_flight.remove(tile);
        self.done.insert(tile.to_string());
    }

    pub fn fail(&mut self, tile: &str) -> Result<bool, String> {
        self.in_flight.remove(tile);
        let attempts = self.attempts.entry(tile.to_string()).or_insert(0);
        *attempts = attempts.checked_add(1).ok_or("attempt overflow")?;
        if *attempts <= self.config.max_retries {
            self.pending.insert(tile.to_string());
            Ok(true)
        } else {
            Ok(false)
        }
    }

    #[must_use]
    pub fn peak_in_flight(&self) -> usize {
        self.peak_in_flight
    }

    #[must_use]
    pub fn done_count(&self) -> usize {
        self.done.len()
    }
}
