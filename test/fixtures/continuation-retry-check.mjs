import assert from "node:assert/strict";

import { streamOpenAIResponsesWebSocket } from "../../src/index.ts";

Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const requests = [];
let connectionSeq = 0;
let turn = 0;

function send(ws, event) {
  ws.send(JSON.stringify(event));
}

function complete(ws, responseId, text) {
  send(ws, { type: "response.created", response: { id: responseId, status: "in_progress" }, sequence_number: 0 });
  send(ws, {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: `msg_${responseId}`, type: "message", role: "assistant", content: [], status: "in_progress" },
    sequence_number: 1,
  });
  send(ws, {
    type: "response.content_part.added",
    item_id: `msg_${responseId}`,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
    sequence_number: 2,
  });
  send(ws, {
    type: "response.output_text.done",
    item_id: `msg_${responseId}`,
    output_index: 0,
    content_index: 0,
    text,
    sequence_number: 3,
  });
  send(ws, {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: `msg_${responseId}`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
      status: "completed",
    },
    sequence_number: 4,
  });
  send(ws, {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    },
    sequence_number: 5,
  });
}

const server = Bun.serve({
  port: 0,
  fetch(req, server) {
    if (new URL(req.url).pathname !== "/v1/responses") return new Response("not found", { status: 404 });
    const connectionId = ++connectionSeq;
    server.upgrade(req, { data: { connectionId } });
    return undefined;
  },
  websocket: {
    message(ws, message) {
      const request = JSON.parse(String(message));
      requests.push({ connectionId: ws.data.connectionId, request });
      if (request.previous_response_id) {
        send(ws, {
          type: "error",
          error: {
            code: "upstream_unavailable",
            message: "Previous response owner account is unavailable; retry later.",
          },
        });
        return;
      }
      turn += 1;
      complete(ws, `resp_${turn}`, `ok-${turn}`);
    },
  },
});

const model = {
  id: "gpt-5.5",
  provider: "openai-ws",
  api: "openai-responses-websocket",
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
  apiKey: "test-key",
  headers: {},
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const messages = [];

async function runTurn(text) {
  messages.push({ role: "user", content: text, timestamp: Date.now() });
  const stream = streamOpenAIResponsesWebSocket(
    model,
    { messages },
    { transport: "websocket-cached", sessionId: "retry-session" },
  );
  for await (const _event of stream) {
    // drain
  }
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage || "unexpected failure");
  messages.push(result);
  return result;
}

try {
  await runTurn("first");
  await runTurn("second");

  assert.equal(requests.length, 3, "second turn should retry once after cached continuation rejection");
  assert.equal(
    Object.hasOwn(requests[1].request, "previous_response_id"),
    true,
    "second turn should first try cached continuation",
  );
  assert.equal(
    Object.hasOwn(requests[2].request, "previous_response_id"),
    false,
    "retry should fall back to full request body",
  );
  assert.ok(
    requests[2].request.input.length > requests[1].request.input.length,
    "retry should send the full transcript",
  );
  console.log(JSON.stringify({ ok: true, requests: requests.length }, null, 2));
} finally {
  server.stop(true);
}
