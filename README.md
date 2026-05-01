# pi-openai-ws

Registers a WebSocket-backed Pi provider for OpenAI Responses-compatible proxies.

## Provider config

The extension reads `~/.pi/agent/models.json` on Pi startup/reload. The default source provider is `openai-ws`:

```json
"openai-ws": {
  "api": "openai-responses",
  "baseUrl": "http://127.0.0.1:2455/v1",
  "apiKey": "dummy",
  "models": [
    { "id": "gpt-5.4-mini", "name": "GPT-5.4-Mini WS" }
  ]
}
```

Because the source provider already ends in `-ws`, the extension registers the same provider name. Use models like:

```text
openai-ws/gpt-5.4-mini
openai-ws/gpt-5.4
openai-ws/gpt-5.5
```

## Custom base URL

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

Explicit `ws://` and `wss://` base URLs are also accepted.

The proxy must support OpenAI Responses WebSocket frames:

- endpoint: `/responses` under the configured base URL
- request frame: `{"type":"response.create", ...}`
- header: `OpenAI-Beta: responses_websockets=2026-02-06`
- continuation: `previous_response_id` plus incremental `input`

Known compatible target: `codex-lb` with upstream stream transport set to WebSocket.

## Source providers

By default the extension scans only:

```text
openai-ws
```

Override with:

```bash
export OPENAI_WS_SOURCE_PROVIDERS="openai-ws,my-proxy"
```

If a source provider name already ends in `-ws`, the extension registers that same provider name. Otherwise it appends `-ws` by default.

Override the suffix with:

```bash
export OPENAI_WS_PROVIDER_SUFFIX="-websocket"
```

## Tests

Run local no-token tests:

```bash
cd ~/.pi/agent/extensions/pi-openai-ws
npm test
```

The tests cover URL conversion and cached delta request construction.

## Notes

- This extension imports Pi's internal OpenAI Responses stream parser via package resolution, not an absolute filesystem path. It may still need adjustment after Pi internal API changes.
- `websocket-cached` keeps a session WebSocket open in interactive Pi sessions. In non-interactive `pi -p` runs the extension closes the socket so the process exits cleanly.
- There is no silent SSE fallback. If WebSocket is down, the request fails; use a separate SSE provider for fallback.
