import test from "node:test";
import assert from "node:assert/strict";
import { importTypeScript } from "./ts-source-loader.mjs";

const { createLogger, LOG_MAX_CHARS } = await importTypeScript(new URL("../../src/logging.ts", import.meta.url));

test("logger prefixes its context and filters by level", () => {
  const entries = [];
  const logger = createLogger("job", { level: "info", sink: (entry) => entries.push(entry) });
  logger.debug("hidden", "");
  logger.info("shown", "detail");
  assert.deepEqual(entries.map((entry) => entry.line), ["[dezoomify:job] info shown detail"]);
  logger.setLevel("debug");
  logger.debug("now-shown");
  assert.equal(entries.length, 2);
  assert.equal(entries[1].context, "job");
});

test("logger bounds detail and a throwing sink cannot stop logging", () => {
  const entries = [];
  const logger = createLogger("worker", { level: "debug" });
  logger.setSink(() => { throw new Error("sink failed"); });
  logger.info("test", "x".repeat(5000));
  logger.setSink((entry) => entries.push(entry));
  logger.info("test", "x".repeat(5000));
  assert.ok(entries[0].line.length <= "[dezoomify:worker] info test ".length + LOG_MAX_CHARS + 1);
});
