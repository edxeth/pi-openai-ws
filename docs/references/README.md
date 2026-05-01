# OpenAI Responses WebSocket references

These files are local reference snapshots for future Pi sessions. They are not runtime code.

## Saved sources

- `openai-cookbook-reasoning-items.md` — OpenAI cookbook page explaining why prior reasoning items matter for multi-turn Responses API use, and why encrypted content exists for stateless use.
- `openai-python-response-reasoning-item-param.txt` — OpenAI Python SDK type generated from the OpenAPI spec for reasoning input items. Key fields: `type: "reasoning"`, `summary`, optional `encrypted_content`, and server-scoped `id`.
- `openai-node-responses-ws.txt` / `openai-node-responses-ws-base.txt` — OpenAI Node SDK WebSocket client implementation snapshot showing the first-party WebSocket abstraction sends client events as JSON and receives Responses server events.

## Protocol invariants this extension relies on

- WebSocket requests are client events shaped as `{ "type": "response.create", ...responsesCreateBody }`.
- The configured HTTP(S) `/v1` base URL becomes a WS(S) `/v1/responses` URL.
- WebSocket transport does not need the SSE `stream:true` body flag.
- Cached continuation should send `previous_response_id` plus only the new `input` delta.
- For stateless/ZDR reasoning continuity, request `include: ["reasoning.encrypted_content"]` and replay reasoning items without stale server-scoped `id` values.
- Keep `store:false`; do not rely on server persistence for privacy-sensitive proxy setups.

## Local proof fixtures

- `../../test/fixtures/mock-openai-responses-ws.mjs` — minimal Responses WebSocket mock that emits reasoning, encrypted content, text, usage, and completion events.
- `../../test/fixtures/cached-continuation-check.mjs` — two-turn cached continuation check. It asserts reasoning metadata is captured and confirms the second request uses `previous_response_id` with only the new input delta.
- `../../test/fixtures/cache-benchmark.mjs` — deterministic many-turn benchmark. It interleaves two sessions and asserts no cache bleed, one WebSocket per session, stable cached request size, no stale reasoning IDs, no `stream`/`background`, and substantial request-size savings versus a full transcript body.
