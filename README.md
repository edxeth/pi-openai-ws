# pi-openai-ws

WebSocket transport provider shim for Pi models served through OpenAI Responses-compatible proxies.

The extension is proxy-agnostic across proxies that implement the OpenAI Responses WebSocket protocol. It is not tied to `codex-lb`; `codex-lb` is only a known compatible target.

## Compatibility contract

A source provider must be configured as `api: "openai-responses"`. The WebSocket proxy behind it must support:

- endpoint: `/responses` under the configured base URL
- request frame: `{ "type": "response.create", ...responsesCreateBody }`
- server events shaped like OpenAI Responses streaming events
- continuation via `previous_response_id` plus incremental `input`
- `store:false` requests
- reasoning continuity via `include: ["reasoning.encrypted_content"]`

The extension deliberately does not send WebSocket-irrelevant body fields such as `stream` or `background`.

For stateless / ZDR-friendly reasoning, the extension preserves `encrypted_content` and strips stale server-scoped reasoning `id` values before replaying reasoning items. This avoids `Item with id 'rs_...' not found` failures when prior response items were not persisted.

The extension also sends:

```text
OpenAI-Beta: responses_websockets=2026-02-06
```

Some proxies still gate Responses WebSocket support behind that header.

## Provider config

The extension reads `~/.pi/agent/models.json` on Pi startup or `/reload`. By default it scans only the `openai-ws` source provider:

```json
"openai-ws": {
  "api": "openai-responses",
  "baseUrl": "http://127.0.0.1:2455/v1",
  "apiKey": "dummy",
  "models": [
    { "id": "gpt-5.4-mini", "name": "GPT-5.4-Mini" }
  ]
}
```

Because `openai-ws` already ends in `-ws`, the registered provider keeps the same name. Use models like:

```text
openai-ws/gpt-5.4-mini
openai-ws/gpt-5.4
openai-ws/gpt-5.5
```

Override scanned source providers with:

```bash
export OPENAI_WS_SOURCE_PROVIDERS="openai-ws,my-proxy"
```

If a source provider name does not end in `-ws`, the extension appends `-ws` by default. Override that suffix with:

```bash
export OPENAI_WS_PROVIDER_SUFFIX="-websocket"
```

## Base URL conversion

Change `baseUrl` in `~/.pi/agent/models.json`, then run `/reload` or restart Pi.

```json
"baseUrl": "http://127.0.0.1:2455/v1"
```

becomes:

```text
ws://127.0.0.1:2455/v1/responses
```

```json
"baseUrl": "https://proxy.example.com/v1"
```

becomes:

```text
wss://proxy.example.com/v1/responses
```

Explicit `ws://` and `wss://` base URLs are also accepted. `/responses` is appended unless the URL already ends with it.

## Cached WebSocket behavior

`websocket-cached` keeps a session WebSocket open in interactive Pi sessions and stores the last successful `response.id` plus normalized response items.

On the next turn, if the non-input request body is unchanged and the current transcript still extends the cached prefix, the extension sends only:

```json
{
  "previous_response_id": "resp_...",
  "input": ["only new input items"]
}
```

This prevents full-transcript reupload on every turn, reducing token pressure and proxy bandwidth. If the prefix no longer matches, the body changes, the socket fails, or the run is non-interactive, the extension falls back to a full request instead of risking corrupted continuation.

Cache isolation is keyed by Pi `sessionId`; interleaved sessions use separate WebSockets and separate `previous_response_id` chains.

## Tests and fixtures

Run local no-token tests:

```bash
cd ~/.pi/agent/extensions/pi-openai-ws
bun test
```

The unit tests cover URL conversion, WebSocket headers, request body construction, cached delta construction, reasoning ID normalization, and nested error normalization.

Additional protocol fixtures live under `test/fixtures/`:

```bash
bun test/fixtures/mock-openai-responses-ws.mjs
bun test/fixtures/cached-continuation-check.mjs
bun test/fixtures/cache-benchmark.mjs
```

Use `mock-openai-responses-ws.mjs` in one terminal and `cached-continuation-check.mjs` in another for a manual two-turn check. `cache-benchmark.mjs` starts its own mock server and asserts:

- many-turn cached deltas
- stable cached request size
- one WebSocket per session
- no cache bleed between interleaved sessions
- no stale reasoning IDs
- no `stream` / `background` fields
- `store:false` and `reasoning.encrypted_content` are retained

Reference snapshots from OpenAI docs and SDK sources live under `docs/references/`.

## Known caveats

- The proxy must implement OpenAI Responses WebSocket semantics. Generic OpenAI-like HTTP/SSE proxies are not enough.
- There is no silent SSE fallback. If WebSocket is down or incompatible, the request fails; use a separate SSE provider for fallback.
- The extension imports Pi's internal OpenAI Responses stream parser via package resolution. It may need adjustment after Pi internal API changes.
