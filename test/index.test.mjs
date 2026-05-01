import assert from "node:assert/strict";
import test from "node:test";

import { buildCachedWebSocketRequestBody, resolveResponsesWebSocketUrl } from "../src/index.ts";

test("resolveResponsesWebSocketUrl converts http/https base URLs", () => {
  assert.equal(resolveResponsesWebSocketUrl("http://127.0.0.1:2455/v1"), "ws://127.0.0.1:2455/v1/responses");
  assert.equal(resolveResponsesWebSocketUrl("https://proxy.example.com/v1/"), "wss://proxy.example.com/v1/responses");
});

test("resolveResponsesWebSocketUrl preserves explicit websocket URLs", () => {
  assert.equal(resolveResponsesWebSocketUrl("ws://localhost:2455/v1"), "ws://localhost:2455/v1/responses");
  assert.equal(resolveResponsesWebSocketUrl("wss://proxy.example.com/v1/responses"), "wss://proxy.example.com/v1/responses");
});

test("resolveResponsesWebSocketUrl rejects unsupported protocols", () => {
  assert.throws(() => resolveResponsesWebSocketUrl("ftp://proxy.example.com/v1"), /Unsupported WebSocket baseUrl protocol/);
});

test("buildCachedWebSocketRequestBody emits delta when current input extends cached transcript", () => {
  const entry = {
    socket: {},
    busy: false,
    continuation: {
      lastResponseId: "resp_123",
      lastRequestBody: {
        model: "gpt-5.4-mini",
        stream: true,
        input: [{ type: "message", role: "user", content: "one" }],
      },
      lastResponseItems: [{ type: "message", role: "assistant", content: "two" }],
    },
  };
  const body = {
    model: "gpt-5.4-mini",
    stream: true,
    input: [
      { type: "message", role: "user", content: "one" },
      { type: "message", role: "assistant", content: "two" },
      { type: "message", role: "user", content: "three" },
    ],
  };

  assert.deepEqual(buildCachedWebSocketRequestBody(entry, body), {
    model: "gpt-5.4-mini",
    stream: true,
    previous_response_id: "resp_123",
    input: [{ type: "message", role: "user", content: "three" }],
  });
});

test("buildCachedWebSocketRequestBody falls back to full body when non-input payload changes", () => {
  const entry = {
    socket: {},
    busy: false,
    continuation: {
      lastResponseId: "resp_123",
      lastRequestBody: {
        model: "gpt-5.4-mini",
        stream: true,
        max_output_tokens: 64,
        input: [{ type: "message", role: "user", content: "one" }],
      },
      lastResponseItems: [],
    },
  };
  const body = {
    model: "gpt-5.4-mini",
    stream: true,
    max_output_tokens: 128,
    input: [
      { type: "message", role: "user", content: "one" },
      { type: "message", role: "user", content: "two" },
    ],
  };

  assert.equal(buildCachedWebSocketRequestBody(entry, body), body);
  assert.equal(entry.continuation, undefined);
});
