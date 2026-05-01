import assert from "node:assert/strict";

import { buildResponsesBody, streamOpenAIResponsesWebSocket } from "../../src/index.ts";

Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const TURNS_PER_SESSION = Number(process.env.BENCH_TURNS || 12);
const sessions = ["session-a", "session-b"];
const requests = [];
const opens = [];
let connectionSeq = 0;
const turnsBySession = new Map();

function send(ws, event) {
  ws.send(JSON.stringify(event));
}

function lastUserText(input) {
  const last = [...input].reverse().find((item) => item.role === "user");
  const content = last?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text || "").join("");
  return "";
}

const server = Bun.serve({
  port: 0,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/responses") return new Response("not found", { status: 404 });
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("upgrade required", { status: 426 });
    const connectionId = ++connectionSeq;
    server.upgrade(req, {
      data: {
        connectionId,
        auth: req.headers.get("authorization") || "",
        beta: req.headers.get("openai-beta") || "",
        sessionId: req.headers.get("session_id") || "",
      },
    });
    return undefined;
  },
  websocket: {
    open(ws) {
      opens.push({ ...ws.data });
    },
    message(ws, message) {
      const request = JSON.parse(String(message));
      const sessionId = ws.data.sessionId;
      const turn = (turnsBySession.get(sessionId) || 0) + 1;
      turnsBySession.set(sessionId, turn);
      const latestText = lastUserText(request.input || []);
      requests.push({
        sessionId,
        connectionId: ws.data.connectionId,
        turn,
        byteLength: Buffer.byteLength(JSON.stringify(request)),
        latestText,
        request,
      });

      const safeSession = sessionId.replace(/[^a-z0-9]+/gi, "_");
      const responseId = `resp_${safeSession}_${turn}`;
      const reasoningId = `rs_${safeSession}_${turn}`;
      const messageId = `msg_${safeSession}_${turn}`;
      const text = `bench-ok-${safeSession}-${turn}`;

      send(ws, { type: "response.created", response: { id: responseId, status: "in_progress" }, sequence_number: 0 });
      send(ws, {
        type: "response.in_progress",
        response: { id: responseId, status: "in_progress" },
        sequence_number: 1,
      });
      send(ws, {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: reasoningId, type: "reasoning", summary: [], status: "in_progress" },
        sequence_number: 2,
      });
      send(ws, {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: reasoningId,
          type: "reasoning",
          summary: [{ type: "summary_text", text: `Reasoning for ${sessionId} turn ${turn}.` }],
          encrypted_content: `encrypted-${sessionId}-${turn}`,
          status: "completed",
        },
        sequence_number: 3,
      });
      send(ws, {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: messageId, type: "message", role: "assistant", content: [], status: "in_progress" },
        sequence_number: 4,
      });
      send(ws, {
        type: "response.content_part.added",
        item_id: messageId,
        output_index: 1,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
        sequence_number: 5,
      });
      send(ws, {
        type: "response.output_text.delta",
        item_id: messageId,
        output_index: 1,
        content_index: 0,
        delta: text,
        sequence_number: 6,
      });
      send(ws, {
        type: "response.output_text.done",
        item_id: messageId,
        output_index: 1,
        content_index: 0,
        text,
        sequence_number: 7,
      });
      send(ws, {
        type: "response.content_part.done",
        item_id: messageId,
        output_index: 1,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
        sequence_number: 8,
      });
      send(ws, {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
          status: "completed",
        },
        sequence_number: 9,
      });
      send(ws, {
        type: "response.completed",
        response: {
          id: responseId,
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
        },
        sequence_number: 10,
      });
    },
  },
});

const model = {
  id: "gpt-5.5",
  name: "Benchmark GPT-5.5",
  provider: "openai-ws",
  api: "openai-responses-websocket",
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
  apiKey: "bench-key",
  headers: {},
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

const transcripts = new Map(sessions.map((sessionId) => [sessionId, []]));

async function runTurn(sessionId, turn) {
  const messages = transcripts.get(sessionId);
  const userText = `${sessionId} user turn ${turn}`;
  messages.push({ role: "user", content: userText, timestamp: Date.now() });
  const stream = streamOpenAIResponsesWebSocket(
    model,
    { messages },
    {
      transport: "websocket-cached",
      sessionId,
      reasoning: "high",
    },
  );
  for await (const _event of stream) {
    // drain stream
  }
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", `${sessionId} turn ${turn} failed: ${result.errorMessage || ""}`);
  assert.ok(result.responseId, `${sessionId} turn ${turn} missing responseId`);
  const reasoning = result.content.find((block) => block.type === "thinking");
  assert.ok(reasoning?.thinkingSignature, `${sessionId} turn ${turn} missing reasoning signature`);
  const parsedReasoning = JSON.parse(reasoning.thinkingSignature);
  assert.ok(parsedReasoning.id?.startsWith("rs_"), `${sessionId} turn ${turn} did not capture server reasoning id`);
  assert.ok(parsedReasoning.encrypted_content, `${sessionId} turn ${turn} missing encrypted reasoning content`);
  messages.push(result);
}

try {
  for (let turn = 1; turn <= TURNS_PER_SESSION; turn += 1) {
    for (const sessionId of sessions) {
      await runTurn(sessionId, turn);
    }
  }

  assert.equal(opens.length, sessions.length, "expected exactly one WebSocket connection per session");
  for (const sessionId of sessions) {
    const sessionOpens = opens.filter((open) => open.sessionId === sessionId);
    assert.equal(sessionOpens.length, 1, `${sessionId} opened more than one socket`);
    assert.equal(sessionOpens[0].auth, "Bearer bench-key", `${sessionId} used wrong Authorization header`);
    assert.equal(sessionOpens[0].beta, "responses_websockets=2026-02-06", `${sessionId} used wrong beta header`);
  }

  const previousResponseBySession = new Map();
  const firstRequestBytes = new Map();
  const cachedBytesBySession = new Map(sessions.map((sessionId) => [sessionId, []]));

  for (const entry of requests) {
    const { sessionId, turn, request, byteLength, latestText } = entry;
    assert.equal(request.type, "response.create", `${sessionId} turn ${turn} wrong event type`);
    assert.equal(request.model, "gpt-5.5", `${sessionId} turn ${turn} wrong model`);
    assert.equal(request.store, false, `${sessionId} turn ${turn} did not preserve store:false`);
    assert.deepEqual(
      request.include,
      ["reasoning.encrypted_content"],
      `${sessionId} turn ${turn} missing encrypted reasoning include`,
    );
    assert.deepEqual(
      request.reasoning,
      { effort: "high", summary: "auto" },
      `${sessionId} turn ${turn} wrong reasoning payload`,
    );
    assert.equal(Object.hasOwn(request, "stream"), false, `${sessionId} turn ${turn} leaked stream:true`);
    assert.equal(Object.hasOwn(request, "background"), false, `${sessionId} turn ${turn} leaked background`);
    assert.equal(
      JSON.stringify(request).includes('"id":"rs_'),
      false,
      `${sessionId} turn ${turn} replayed stale reasoning id`,
    );

    if (turn === 1) {
      assert.equal(
        Object.hasOwn(request, "previous_response_id"),
        false,
        `${sessionId} first turn unexpectedly used previous_response_id`,
      );
      assert.equal(request.input.length, 1, `${sessionId} first turn should contain only first user input`);
      firstRequestBytes.set(sessionId, byteLength);
    } else {
      const expectedPrevious = previousResponseBySession.get(sessionId);
      assert.equal(
        request.previous_response_id,
        expectedPrevious,
        `${sessionId} turn ${turn} used wrong previous_response_id; possible cache bleed`,
      );
      assert.equal(request.input.length, 1, `${sessionId} turn ${turn} sent transcript instead of delta`);
      assert.equal(latestText, `${sessionId} user turn ${turn}`, `${sessionId} turn ${turn} sent wrong input delta`);
      cachedBytesBySession.get(sessionId).push(byteLength);
    }

    previousResponseBySession.set(sessionId, `resp_${sessionId.replace(/[^a-z0-9]+/gi, "_")}_${turn}`);
  }

  const fullTranscriptBytesBySession = new Map();
  for (const sessionId of sessions) {
    const bytes = cachedBytesBySession.get(sessionId);
    assert.equal(bytes.length, TURNS_PER_SESSION - 1, `${sessionId} cached turn count mismatch`);
    const min = Math.min(...bytes);
    const max = Math.max(...bytes);
    assert.ok(max - min < 8, `${sessionId} cached request sizes drifted: min=${min} max=${max}`);
    assert.ok(
      max < firstRequestBytes.get(sessionId) + 120,
      `${sessionId} cached requests unexpectedly larger than first request`,
    );

    const fullBody = {
      type: "response.create",
      ...buildResponsesBody(model, { messages: transcripts.get(sessionId) }, { reasoning: "high" }),
    };
    const fullBytes = Buffer.byteLength(JSON.stringify(fullBody));
    fullTranscriptBytesBySession.set(sessionId, fullBytes);
    assert.ok(
      fullBytes > max * 4,
      `${sessionId} full transcript did not substantially exceed cached delta: full=${fullBytes} cachedMax=${max}`,
    );
  }

  const summary = Object.fromEntries(
    sessions.map((sessionId) => {
      const bytes = cachedBytesBySession.get(sessionId);
      return [
        sessionId,
        {
          firstRequestBytes: firstRequestBytes.get(sessionId),
          cachedRequestBytesMin: Math.min(...bytes),
          cachedRequestBytesMax: Math.max(...bytes),
          fullTranscriptRequestBytesAtEnd: fullTranscriptBytesBySession.get(sessionId),
          avoidedGrowthFactor: Number((fullTranscriptBytesBySession.get(sessionId) / Math.max(...bytes)).toFixed(2)),
          turns: TURNS_PER_SESSION,
          websocketConnections: opens.filter((open) => open.sessionId === sessionId).length,
        },
      ];
    }),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        totalRequests: requests.length,
        totalWebSocketConnections: opens.length,
        sessions: summary,
      },
      null,
      2,
    ),
  );
} finally {
  server.stop(true);
}
