import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, LOG_MAX_CHARS } from "../src/logging.ts";

test("logger prefixes its context and filters by level", () => {
  const entries = [];
  const logger = createLogger("job", { level: "info", sink: (entry) => entries.push(entry) });
  logger.debug("hidden", "");
  logger.info("shown", "detail");
  assert.deepEqual(
    entries.map((entry) => entry.line),
    ["[job] shown detail"],
  );
  logger.setLevel("debug");
  logger.debug("now-shown");
  assert.equal(entries.length, 2);
  assert.equal(entries[1].context, "job");
});

test("the default context and an absent code are omitted", () => {
  const entries = [];
  const logger = createLogger("background", {
    level: "info",
    sink: (entry) => entries.push(entry),
  });
  logger.info("job-created", "detail");
  logger.info(undefined, "no code");
  assert.deepEqual(
    entries.map((entry) => entry.line),
    ["job-created detail", "no code"],
  );
});

test("a host can omit its own context bracket", () => {
  const entries = [];
  const logger = createLogger("app", {
    level: "info",
    defaultContext: "app",
    sink: (entry) => entries.push(entry),
  });
  logger.info("started", "detail");
  assert.deepEqual(
    entries.map((entry) => entry.line),
    ["started detail"],
  );
});

test("addSink observes alongside the configured sink", () => {
  const primary = [];
  const observer = [];
  const logger = createLogger("job", { level: "info", sink: (entry) => primary.push(entry) });
  logger.addSink((entry) => observer.push(entry));
  logger.info("code", "detail");
  assert.equal(primary.length, 1);
  assert.equal(observer.length, 1);
});

test("logger bounds detail and a throwing sink cannot stop logging", () => {
  const entries = [];
  const logger = createLogger("worker", { level: "debug" });
  logger.setSink(() => {
    throw new Error("sink failed");
  });
  logger.info("test", "x".repeat(5000));
  logger.setSink((entry) => entries.push(entry));
  logger.info("test", "x".repeat(5000));
  assert.ok(entries[0].line.length <= "[worker] test ".length + LOG_MAX_CHARS + 1);
});
