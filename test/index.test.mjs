import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCachedWebSocketRequestBody,
  buildResponsesBody,
  buildWebSocketHeaders,
  mapResponseEvents,
  resolveResponsesWebSocketUrl,
} from "../src/index.ts";

test("resolveResponsesWebSocketUrl converts http/https base URLs", () => {
  assert.equal(resolveResponsesWebSocketUrl("http://127.0.0.1:2455/v1"), "ws://127.0.0.1:2455/v1/responses");
  assert.equal(resolveResponsesWebSocketUrl("https://proxy.example.com/v1/"), "wss://proxy.example.com/v1/responses");
});

test("resolveResponsesWebSocketUrl preserves explicit websocket URLs", () => {
  assert.equal(resolveResponsesWebSocketUrl("ws://localhost:2455/v1"), "ws://localhost:2455/v1/responses");
  assert.equal(
    resolveResponsesWebSocketUrl("wss://proxy.example.com/v1/responses"),
    "wss://proxy.example.com/v1/responses",
  );
});

test("resolveResponsesWebSocketUrl rejects unsupported protocols", () => {
  assert.throws(
    () => resolveResponsesWebSocketUrl("ftp://proxy.example.com/v1"),
    /Unsupported WebSocket baseUrl protocol/,
  );
});

test("buildResponsesBody follows Responses WebSocket stateless reasoning requirements", () => {
  const model = {
    id: "gpt-5.4-mini",
    provider: "openai-ws",
    api: "openai-responses-websocket",
    reasoning: true,
    input: ["text"],
  };
  const context = {
    messages: [
      { role: "user", content: "say hello" },
      {
        role: "assistant",
        model: "gpt-5.4-mini",
        provider: "openai-ws",
        api: "openai-responses-websocket",
        content: [
          {
            type: "thinking",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_123",
              summary: [{ type: "summary_text", text: "Need answer briefly." }],
              encrypted_content: "encrypted-reasoning",
            }),
          },
          { type: "text", text: "hello", textSignature: JSON.stringify({ v: 1, id: "msg_123" }) },
        ],
      },
      { role: "user", content: "say another word" },
    ],
  };

  assert.deepEqual(buildResponsesBody(model, context, { reasoning: "low" }), {
    model: "gpt-5.4-mini",
    store: false,
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    input: [
      { role: "user", content: [{ type: "input_text", text: "say hello" }] },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need answer briefly." }],
        encrypted_content: "encrypted-reasoning",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
        status: "completed",
        id: "msg_123",
        phase: undefined,
      },
      { role: "user", content: [{ type: "input_text", text: "say another word" }] },
    ],
  });
});

test("buildWebSocketHeaders uses provider api key and allows per-request overrides", () => {
  const fromModel = buildWebSocketHeaders({ headers: { "X-Source": "provider" }, apiKey: "provider-key" });
  assert.equal(fromModel.get("Authorization"), "Bearer provider-key");
  assert.equal(fromModel.get("OpenAI-Beta"), "responses_websockets=2026-02-06");
  assert.equal(fromModel.get("X-Source"), "provider");

  const fromOptions = buildWebSocketHeaders({ apiKey: "provider-key" }, { apiKey: "request-key" });
  assert.equal(fromOptions.get("Authorization"), "Bearer request-key");

  process.env.OPENAI_WS_TEST_KEY = "resolved-key";
  try {
    const fromEnv = buildWebSocketHeaders({ apiKey: "OPENAI_WS_TEST_KEY" });
    assert.equal(fromEnv.get("Authorization"), "Bearer resolved-key");
  } finally {
    delete process.env.OPENAI_WS_TEST_KEY;
  }
});

test("buildCachedWebSocketRequestBody emits delta when current input extends cached transcript", () => {
  const entry = {
    socket: {},
    busy: false,
    continuation: {
      lastResponseId: "resp_123",
      lastRequestBody: {
        model: "gpt-5.4-mini",
        store: false,
        input: [{ type: "message", role: "user", content: "one" }],
      },
      lastResponseItems: [{ type: "message", role: "assistant", content: "two" }],
    },
  };
  const body = {
    model: "gpt-5.4-mini",
    store: false,
    input: [
      { type: "message", role: "user", content: "one" },
      { type: "message", role: "assistant", content: "two" },
      { type: "message", role: "user", content: "three" },
    ],
  };

  assert.deepEqual(buildCachedWebSocketRequestBody(entry, body), {
    model: "gpt-5.4-mini",
    store: false,
    previous_response_id: "resp_123",
    input: [{ type: "message", role: "user", content: "three" }],
  });
});

test("buildCachedWebSocketRequestBody ignores stale reasoning ids while computing cached deltas", () => {
  const reasoningSummary = [{ type: "summary_text", text: "Need answer briefly." }];
  const entry = {
    socket: {},
    busy: false,
    continuation: {
      lastResponseId: "resp_123",
      lastRequestBody: {
        model: "gpt-5.4-mini",
        store: false,
        reasoning: { effort: "medium", summary: "auto" },
        input: [{ type: "message", role: "user", content: "say hello" }],
      },
      lastResponseItems: [
        { type: "reasoning", id: "rs_123", summary: reasoningSummary },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
    },
  };
  const body = {
    model: "gpt-5.4-mini",
    store: false,
    reasoning: { effort: "medium", summary: "auto" },
    input: [
      { type: "message", role: "user", content: "say hello" },
      { type: "reasoning", summary: reasoningSummary },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "message", role: "user", content: "say another word" },
    ],
  };

  assert.deepEqual(buildCachedWebSocketRequestBody(entry, body), {
    model: "gpt-5.4-mini",
    store: false,
    reasoning: { effort: "medium", summary: "auto" },
    previous_response_id: "resp_123",
    input: [{ type: "message", role: "user", content: "say another word" }],
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
        store: false,
        max_output_tokens: 64,
        input: [{ type: "message", role: "user", content: "one" }],
      },
      lastResponseItems: [],
    },
  };
  const body = {
    model: "gpt-5.4-mini",
    store: false,
    max_output_tokens: 128,
    input: [
      { type: "message", role: "user", content: "one" },
      { type: "message", role: "user", content: "two" },
    ],
  };

  assert.equal(buildCachedWebSocketRequestBody(entry, body), body);
  assert.equal(entry.continuation, undefined);
});

test("mapResponseEvents flattens nested websocket error events", async () => {
  async function* events() {
    yield {
      type: "error",
      status: 404,
      error: { code: "stream_incomplete", message: "Item with id 'rs_123' not found." },
    };
  }

  const mapped = [];
  for await (const event of mapResponseEvents(events())) mapped.push(event);

  assert.deepEqual(mapped, [
    {
      type: "error",
      status: 404,
      error: { code: "stream_incomplete", message: "Item with id 'rs_123' not found." },
      code: "stream_incomplete",
      message: "Item with id 'rs_123' not found.",
    },
  ]);
});
