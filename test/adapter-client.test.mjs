import test from "node:test";
import assert from "node:assert/strict";

import { AdapterClient } from "../dist/core/adapter-client.js";
import { createPluginLogger } from "../dist/core/logger.js";

const ORIGINAL_FETCH = globalThis.fetch;

function makeClient(fetchImpl, queryMode = "mix") {
  globalThis.fetch = fetchImpl;

  const baseLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const logger = createPluginLogger(baseLogger, {
    prefix: "memory-lightrag-local",
    debugEnabled: true,
  }).child("lightrag");

  return new AdapterClient("http://127.0.0.1:9621", "test-key", queryMode, logger);
}

function okJson(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

test("query always uses naive mode and sends stable body", async (t) => {
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  let capturedBody;
  const client = makeClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:9621/query/data");
    assert.equal(init.method, "POST");
    capturedBody = JSON.parse(String(init.body));
    return okJson({
      status: "success",
      message: "ok",
      data: {
        entities: [],
        relationships: [],
        chunks: [{ content: "chunk text", file_path: "doc.md", chunk_id: "c1", reference_id: "r1" }],
        references: [],
      },
      metadata: { query_mode: "naive" },
    });
  }, "mix");

  const result = await client.query("what is this", 3, { conversationId: "telegram:1" });

  assert.equal(capturedBody.mode, "naive");
  assert.equal(capturedBody.top_k, 3);
  assert.equal(Object.hasOwn(capturedBody, "chunk_top_k"), false);
  assert.equal(Object.hasOwn(capturedBody, "include_references"), false);
  assert.equal(Object.hasOwn(capturedBody, "enable_rerank"), false);
  assert.equal(result.contextItems.length, 1);
  assert.equal(result.contextItems[0].text, "chunk text");
});

test("query propagates 500 errors from /query/data without retry", async (t) => {
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  let call = 0;
  const client = makeClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:9621/query/data");
    assert.equal(init.method, "POST");
    call += 1;
    const body = JSON.parse(String(init.body));
    assert.deepEqual(Object.keys(body).sort(), ["mode", "query", "top_k"]);
    return {
      ok: false,
      status: 500,
      text: async () =>
        '{"detail":"4 validation errors for QueryDataResponse\\nstatus\\n Field required [type=missing, input_value={}, input_type=dict]"}',
      json: async () => ({}),
    };
  });

  await assert.rejects(
    () => client.query("retry me", 4, { conversationId: "telegram:retry" }),
    /request failed: 500/,
  );
  assert.equal(call, 1);
});

test("ingest sends unique file_sources for each item", async (t) => {
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  let capturedBody;
  const client = makeClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:9621/documents/texts");
    assert.equal(init.method, "POST");
    capturedBody = JSON.parse(String(init.body));
    return okJson({ status: "success", message: "ok", track_id: "trk-1" });
  });

  const result = await client.ingest({
    conversationId: "telegram:user-1",
    channel: "telegram",
    date: "2026-04-13",
    items: [
      { role: "user", content: "hello", messageId: "msg#1", ts: "2026-04-13T09:00:00.000Z" },
      { role: "assistant", content: "hi", ts: "2026-04-13T09:00:01.000Z" },
    ],
  });

  assert.equal(result.status, "success");
  assert.equal(capturedBody.texts.length, 2);
  assert.equal(capturedBody.file_sources.length, 2);
  assert.notEqual(capturedBody.file_sources[0], capturedBody.file_sources[1]);
  assert.match(capturedBody.file_sources[0], /\/item:m_msg_1-[a-f0-9]{12}$/);
  assert.match(capturedBody.file_sources[1], /\/item:h-[a-f0-9]{12}$/);
});

test("ingest throws when LightRAG returns failure status", async (t) => {
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  const client = makeClient(async (url, init) => {
    assert.equal(url, "http://127.0.0.1:9621/documents/text");
    assert.equal(init.method, "POST");
    return okJson({ status: "failure", message: "db write failed" });
  });

  await assert.rejects(
    () =>
      client.ingest({
        conversationId: "telegram:user-2",
        channel: "telegram",
        date: "2026-04-13",
        items: [{ role: "user", content: "one message" }],
      }),
    /ingest failed: db write failed/,
  );
});
