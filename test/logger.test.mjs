import test from "node:test";
import assert from "node:assert/strict";

import { createPluginLogger } from "../dist/core/logger.js";

function makeBaseLogger() {
  const state = { debug: [], info: [], warn: [], error: [] };
  const base = {
    debug: (msg) => state.debug.push(msg),
    info: (msg) => state.info.push(msg),
    warn: (msg) => state.warn.push(msg),
    error: (msg) => state.error.push(msg),
  };
  return { base, state };
}

test("logger.event formats stable key-value output with scoped prefix", () => {
  const { base, state } = makeBaseLogger();
  const logger = createPluginLogger(base, {
    prefix: "memory-lightrag-local",
    debugEnabled: true,
  }).child("capture");

  logger.event("capture_ok", { b: "hello world", a: 1 }, "info");

  assert.equal(
    state.info[0],
    'memory-lightrag-local:capture: event=capture_ok a=1 b="hello world"',
  );
});

test("debug-level logs are suppressed when debug is disabled", () => {
  const { base, state } = makeBaseLogger();
  const logger = createPluginLogger(base, {
    prefix: "memory-lightrag-local",
    debugEnabled: false,
  });

  logger.debug("debug line");
  logger.event("debug_evt", { foo: "bar" });
  logger.event("info_evt", { foo: "bar" }, "info");

  assert.equal(state.debug.length, 0);
  assert.equal(state.info.length, 1);
  assert.equal(state.info[0], "memory-lightrag-local: event=info_evt foo=bar");
});

test("logger falls back to debug/warn when base logger lacks info/error", () => {
  const state = { debug: [], warn: [] };
  const logger = createPluginLogger(
    {
      debug: (msg) => state.debug.push(msg),
      warn: (msg) => state.warn.push(msg),
    },
    { prefix: "memory-lightrag-local", debugEnabled: true },
  );

  logger.info("hello");
  logger.error("boom");

  assert.equal(state.debug[0], "memory-lightrag-local: hello");
  assert.equal(state.warn[0], "memory-lightrag-local: boom");
});
