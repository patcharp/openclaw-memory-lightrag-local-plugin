import test from "node:test";
import assert from "node:assert/strict";

import { extractUntrustedMetadata, sanitizeCapturedText } from "../dist/core/sanitize.js";

test("sanitizeCapturedText strips untrusted metadata blocks", () => {
  const raw = [
    "Conversation info (untrusted metadata):",
    "```json",
    '{ "message_id": "5459", "sender_id": "7191434936", "sender": "Toei" }',
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    '{ "language_code": "th" }',
    "```",
    "",
    "สวัสดี",
  ].join("\n");

  const text = sanitizeCapturedText(raw, "all");
  assert.equal(text, "สวัสดี");
});

test("extractUntrustedMetadata reads sender and ids", () => {
  const raw = [
    "Conversation info (untrusted metadata):",
    "```json",
    '{ "message_id": "5461", "sender_id": "7191434936", "sender": "Toei", "timestamp": "Tue 2026-04-14 00:32 GMT+7" }',
    "```",
  ].join("\n");

  const meta = extractUntrustedMetadata(raw);
  assert.equal(meta.sender, "Toei");
  assert.equal(meta.senderId, "7191434936");
  assert.equal(meta.messageId, "5461");
  assert.equal(meta.timestamp, "Tue 2026-04-14 00:32 GMT+7");
});

test("sanitizeCapturedText removes OpenClaw compaction system line", () => {
  const raw = [
    "System: [2026-04-14 01:30:42 GMT+7] Compacted (123k -> 2.5k) • Context 2.5k/205k (1%)",
    "",
    "ทดสอบ",
  ].join("\n");

  const text = sanitizeCapturedText(raw, "all");
  assert.equal(text, "ทดสอบ");
});
