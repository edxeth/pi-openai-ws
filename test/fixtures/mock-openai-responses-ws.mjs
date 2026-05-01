import { appendFileSync, rmSync, writeFileSync } from "node:fs";

const port = Number(process.env.MOCK_PORT || 2466);
const logPath = process.env.MOCK_LOG || "/tmp/pi-openai-ws-mock-requests.jsonl";
rmSync(logPath, { force: true });

let turn = 0;
function send(ws, event) {
  ws.send(JSON.stringify(event));
}

const server = Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/responses") return new Response("not found", { status: 404 });
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("upgrade required", { status: 426 });
    const auth = req.headers.get("authorization") || "";
    const beta = req.headers.get("openai-beta") || "";
    server.upgrade(req, { data: { auth, beta } });
    return undefined;
  },
  websocket: {
    open(ws) {
      appendFileSync(logPath, `${JSON.stringify({ type: "open", auth: ws.data.auth, beta: ws.data.beta })}\n`);
    },
    message(ws, message) {
      const request = JSON.parse(String(message));
      appendFileSync(logPath, `${JSON.stringify({ type: "request", request })}\n`);
      turn += 1;
      const responseId = `resp_mock_${turn}`;
      const reasoningId = `rs_mock_${turn}`;
      const messageId = `msg_mock_${turn}`;
      const text = "websocket-extension-ok";

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
          summary: [{ type: "summary_text", text: "Follow the exact wording." }],
          encrypted_content: "encrypted-mock-content",
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

writeFileSync("/tmp/pi-openai-ws-mock-port", String(server.port));
console.log(`mock responses websocket listening on ${server.port}`);
