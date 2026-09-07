import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_MAX_LOG_LINES, createJobActivity } from "../src/job-activity.ts";

function tracker(now = { at: 1000 }) {
  const frames = [];
  const intervals = [];
  let updates = 0;
  const activity = createJobActivity({
    onUpdate: () => { updates += 1; },
    requestFrame: (cb) => { frames.push(cb); },
    setIntervalFn: (cb) => { intervals.push(cb); return intervals.length; },
    clearIntervalFn: () => {},
    nowFn: () => now.at,
  });
  return { activity, frames, intervals, now, get updates() { return updates; } };
}

test("reset initializes the job view state", () => {
  const { activity } = tracker();
  activity.reset("https://a.test/", 30000);
  assert.equal(activity.state.url, "https://a.test/");
  assert.equal(activity.state.timeoutMs, 30000);
  assert.equal(activity.state.pendingRequests, 0);
  assert.deepEqual(activity.state.log, []);
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

test("steps and logs batch paints and cap lines", () => {
  const t = tracker();
  t.activity.reset("https://a.test/", 30000);
  const before = t.updates;
  t.activity.setStep("Saving…", "detail");
  assert.equal(t.activity.state.stepLabel, "Saving…");
  assert.equal(t.updates, before + 1);
  for (let i = 0; i < ACTIVITY_MAX_LOG_LINES + 10; i++) t.activity.pushLog(`line ${i}`);
  assert.equal(t.activity.state.log?.length, ACTIVITY_MAX_LOG_LINES);
  t.activity.scheduleUpdate();
  t.activity.scheduleUpdate();
  assert.equal(t.frames.length, 1);
  t.frames[0]?.();
  assert.equal(t.updates, before + 2);
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
