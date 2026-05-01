import { streamOpenAIResponsesWebSocket } from "../../src/index.ts";

Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

const port = Number(process.env.MOCK_PORT || 2466);
const model = {
  id: "gpt-5.5",
  name: "Mock GPT-5.5",
  provider: "openai-ws",
  api: "openai-responses-websocket",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: "mock-key",
  headers: {},
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

async function runTurn(context) {
  const stream = streamOpenAIResponsesWebSocket(model, context, {
    transport: "websocket-cached",
    sessionId: "mock-session-1",
    reasoning: "high",
  });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();
  if (result.stopReason !== "stop") {
    throw new Error(`turn failed: ${result.stopReason} ${result.errorMessage || ""}`);
  }
  return { result, events };
}

const turn1 = await runTurn({
  messages: [{ role: "user", content: "Say exactly: websocket-extension-ok", timestamp: Date.now() }],
});
if (!turn1.result.responseId) throw new Error("turn1 missing responseId");
const reasoning = turn1.result.content.find((block) => block.type === "thinking");
if (!reasoning?.thinkingSignature) throw new Error("turn1 missing reasoning thinkingSignature");
const parsedReasoning = JSON.parse(reasoning.thinkingSignature);
if (!parsedReasoning.id) throw new Error("turn1 reasoning signature did not capture server id");
if (!parsedReasoning.encrypted_content) throw new Error("turn1 reasoning signature did not capture encrypted_content");

const turn2 = await runTurn({
  messages: [
    { role: "user", content: "Say exactly: websocket-extension-ok", timestamp: Date.now() },
    turn1.result,
    { role: "user", content: "Now say exactly: websocket-extension-ok", timestamp: Date.now() },
  ],
});

console.log(
  JSON.stringify(
    {
      turn1Events: turn1.events,
      turn2Events: turn2.events,
      turn1ResponseId: turn1.result.responseId,
      turn2ResponseId: turn2.result.responseId,
      reasoningIdCaptured: parsedReasoning.id,
      ok: true,
    },
    null,
    2,
  ),
);
process.exit(0);
