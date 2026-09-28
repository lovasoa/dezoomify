import assert from "node:assert/strict";
import test from "node:test";
import { createJobActivity } from "../src/job-activity.ts";

function tracker(now = { at: 1000 }) {
  const frames = [];
  const intervals = [];
  let updates = 0;
  const activity = createJobActivity({
    onUpdate: () => {
      updates += 1;
    },
    requestFrame: (cb) => {
      frames.push(cb);
    },
    setIntervalFn: (cb) => {
      intervals.push(cb);
      return intervals.length;
    },
    clearIntervalFn: () => {},
    nowFn: () => now.at,
  });
  return {
    activity,
    frames,
    intervals,
    now,
    get updates() {
      return updates;
    },
  };
}

test("reset initializes the job view state", () => {
  const { activity } = tracker();
  activity.reset("https://a.test/", 30000);
  assert.equal(activity.state.url, "https://a.test/");
  assert.equal(activity.state.timeoutMs, 30000);
  assert.equal(activity.state.pendingRequests, 0);
});

test("request clocks drive pending and longest-wait gauges", () => {
  const t = tracker();
  t.activity.reset("https://a.test/", 30000);
  const id = t.activity.noteRequestStart("direct");
  assert.equal(t.activity.state.pendingRequests, 1);
  t.now.at += 1200;
  t.activity.refreshLongestPending();
  assert.ok((t.activity.state.longestPendingMs ?? 0) >= 1200);
  t.activity.noteRequestEnd(id, true);
  assert.equal(t.activity.state.pendingRequests, 0);
  assert.equal(t.activity.state.completedRequests, 1);
  t.activity.noteRequestEnd(t.activity.noteRequestStart("proxy"), false);
  assert.equal(t.activity.state.failedRequests, 1);
});

test("progress updates batch paints", () => {
  const t = tracker();
  t.activity.reset("https://a.test/", 30000);
  const before = t.updates;
  t.activity.touchProgress();
  assert.ok((t.activity.state.lastProgressAt ?? 0) > 0);
  assert.equal(t.updates, before);
  t.activity.scheduleUpdate();
  t.activity.scheduleUpdate();
  assert.equal(t.frames.length, 1);
  t.frames[0]?.();
  assert.equal(t.updates, before + 1);
});

test("heartbeat repaints only on real change", () => {
  const t = tracker();
  t.activity.reset("https://a.test/", 30000);
  t.activity.startHeartbeat();
  assert.equal(t.intervals.length, 1);
  const tick = t.intervals[0];
  t.now.at += 100;
  tick();
  t.frames.pop()?.();
  const painted = t.updates;
  // Same second, no change: the tick schedules nothing.
  tick();
  assert.equal(t.frames.length, 0);
  assert.equal(t.updates, painted);
  // A new request changes the delta key and repaints.
  t.activity.noteRequestStart("direct");
  t.now.at += 1100;
  tick();
  assert.equal(t.frames.length, 1);
  t.activity.stopHeartbeat();
});

test("pause excludes paused time from elapsed and pending clocks", () => {
  const t = tracker();
  t.activity.reset("https://a.test/", 30000);
  t.activity.startHeartbeat();
  const id = t.activity.noteRequestStart("tile");
  t.now.at += 500;
  t.activity.pause();
  assert.equal(t.activity.state.paused, true);
  assert.equal(t.activity.state.pausedAt, 1500);
  t.now.at += 5000;
  t.activity.resume();
  assert.equal(t.activity.state.paused, false);
  assert.equal(t.activity.state.pausedDurationMs, 5000);
  t.now.at += 250;
  t.activity.refreshLongestPending();
  assert.equal(t.activity.state.longestPendingMs, 750);
  t.activity.noteRequestEnd(id, true);
});
