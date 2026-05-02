import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const piAiEntryUrl = import.meta.resolve("@mariozechner/pi-ai");
const responsesSharedUrl = new URL("./providers/openai-responses-shared.js", piAiEntryUrl).href;
const responsesShared = await import(responsesSharedUrl);
const { convertResponsesMessages, convertResponsesTools, processResponsesStream } = responsesShared as {
  convertResponsesMessages: (...args: any[]) => any;
  convertResponsesTools: (...args: any[]) => any;
  processResponsesStream: (...args: any[]) => Promise<void>;
};

const SOURCE_PROVIDERS = (process.env.OPENAI_WS_SOURCE_PROVIDERS || "openai-ws")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const PROVIDER_SUFFIX = process.env.OPENAI_WS_PROVIDER_SUFFIX || "-ws";
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

const allowedToolCallProviders = new Set<string>();
const providerApiKeys = new Map<string, string>();

type AnyRecord = Record<string, any>;
type CachedContinuation = {
  lastRequestBody: AnyRecord;
  lastResponseId: string;
  lastResponseItems: any[];
};
type CachedConnection = {
  socket: WebSocket;
  busy: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedContinuation;
};

type AcquiredSocket = {
  socket: WebSocket;
  entry?: CachedConnection;
  reused: boolean;
  release: (options?: { keep?: boolean }) => void;
};

const websocketSessionCache = new Map<string, CachedConnection>();

export default function (pi: ExtensionAPI) {
  const customModels = readCustomModels();
  for (const sourceProvider of SOURCE_PROVIDERS) {
    const source = customModels.providers?.[sourceProvider];
    if (!source) continue;
    if (source.api !== "openai-responses") continue;
    if (!Array.isArray(source.models) || source.models.length === 0) continue;

    const providerName = sourceProvider.endsWith("-ws") ? sourceProvider : `${sourceProvider}${PROVIDER_SUFFIX}`;
    allowedToolCallProviders.add(providerName);
    providerApiKeys.set(providerName, resolveApiKey(source.apiKey));

    pi.registerProvider(providerName, {
      name: `${sourceProvider} WebSocket`,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey || "dummy",
      api: "openai-responses-websocket",
      headers: source.headers,
      models: source.models.map((model: AnyRecord) => ({
        ...model,
        api: "openai-responses-websocket",
        name: model.name || model.id,
      })),
      streamSimple: streamOpenAIResponsesWebSocket,
    });
  }
}

function readCustomModels(): AnyRecord {
  const path = process.env.PI_MODELS_JSON || join(homedir(), ".pi", "agent", "models.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string" || apiKey.length === 0) return "dummy";
  return process.env[apiKey] || apiKey;
}

export function streamOpenAIResponsesWebSocket(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      let body = buildResponsesBody(model, context, options);
      const nextBody = await options?.onPayload?.(body, model);
      if (nextBody !== undefined) body = nextBody as AnyRecord;

      const url = resolveResponsesWebSocketUrl(model.baseUrl);
      const headers = buildWebSocketHeaders(model, options);
      await processWebSocketStream(url, body, headers, output, stream, model, options);

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }
      stream.push({ type: "done", reason: output.stopReason as any, message: output });
      stream.end(output);
    } catch (error) {
      for (const block of output.content as AnyRecord[]) {
        delete block.index;
        delete block.partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
    }
  })();

  return stream;
}

/** Strip server-scoped reasoning IDs from input items.
 * With store:false/ZDR, prior reasoning IDs may be unresolvable on follow-up
 * requests. Keep summaries/encrypted_content, but let the server create fresh IDs. */
function stripReasoningItemIds(input: AnyRecord[]): AnyRecord[] {
  return input.map((item) => {
    if (item.type === "reasoning" && item.id) {
      const { id: _id, ...rest } = item;
      return rest;
    }
    return item;
  });
}

export function buildResponsesBody(model: Model<any>, context: Context, options?: SimpleStreamOptions): AnyRecord {
  const input = stripReasoningItemIds(convertResponsesMessages(model, context, allowedToolCallProviders));
  const body: AnyRecord = {
    model: model.id,
    input,
    store: false,
  };

  if (options?.maxTokens) body.max_output_tokens = options.maxTokens;
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (context.tools && context.tools.length > 0) {
    body.tools = convertResponsesTools(context.tools, { strict: false });
  }
  if (model.reasoning) {
    body.reasoning = {
      effort: clampReasoningEffort(model.id, options?.reasoning || "medium"),
      summary: "auto",
    };
    body.include = ["reasoning.encrypted_content"];
  }
  return body;
}

function clampReasoningEffort(modelId: string, effort: string) {
  const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  if (
    (id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4") || id.startsWith("gpt-5.5")) &&
    effort === "minimal"
  ) {
    return "low";
  }
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}

export function resolveResponsesWebSocketUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const httpUrl = normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
  const url = new URL(httpUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported WebSocket baseUrl protocol: ${url.protocol}`);
  }
  return url.toString();
}

export function buildWebSocketHeaders(model: Model<any>, options?: SimpleStreamOptions): Headers {
  const headers = new Headers(model.headers || {});
  const apiKey = resolveApiKey(options?.apiKey || providerApiKeys.get(model.provider) || (model as AnyRecord).apiKey);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("User-Agent", "pi-openai-ws-extension");
  const requestId = options?.sessionId || crypto.randomUUID();
  headers.set("x-client-request-id", requestId);
  headers.set("session_id", requestId);
  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers)) headers.set(key, value);
  }
  return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

async function processWebSocketStream(
  url: string,
  body: AnyRecord,
  headers: Headers,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<any>,
  options?: SimpleStreamOptions,
) {
  const shouldCacheConnection = options?.transport === "websocket-cached" && process.stdout.isTTY;
  const firstAttempt = await sendWebSocketAttempt(
    url,
    body,
    headers,
    output,
    stream,
    model,
    shouldCacheConnection,
    true,
    options,
  );
  if (!firstAttempt.error) return;

  if (
    !options?.signal?.aborted &&
    shouldRetryCachedContinuationError(firstAttempt.error, {
      usedPreviousResponseId: firstAttempt.usedPreviousResponseId,
    })
  ) {
    resetAssistantOutputForRetry(output);
    const retryAttempt = await sendWebSocketAttempt(
      url,
      body,
      headers,
      output,
      stream,
      model,
      shouldCacheConnection,
      false,
      options,
    );
    if (!retryAttempt.error) return;
    throw retryAttempt.error;
  }

  throw firstAttempt.error;
}

async function sendWebSocketAttempt(
  url: string,
  body: AnyRecord,
  headers: Headers,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<any>,
  shouldCacheConnection: boolean,
  useCachedContinuation: boolean,
  options?: SimpleStreamOptions,
): Promise<{ error?: Error; usedPreviousResponseId: boolean }> {
  const { socket, entry, release } = await acquireWebSocket(url, headers, options?.sessionId, options?.signal);
  let keepConnection = shouldCacheConnection;
  const requestBody =
    shouldCacheConnection && useCachedContinuation && entry ? buildCachedWebSocketRequestBody(entry, body) : body;
  const usedPreviousResponseId = "previous_response_id" in requestBody;

  try {
    socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    stream.push({ type: "start", partial: output });
    await processResponsesStream(mapResponseEvents(parseWebSocket(socket, options?.signal)), output, stream, model);

    if (options?.signal?.aborted) {
      keepConnection = false;
    } else if (output.stopReason === "error") {
      throw new Error(output.errorMessage || "Provider returned an error stop reason");
    } else if (shouldCacheConnection && entry && output.responseId) {
      const responseItems = stripReasoningItemIds(
        convertResponsesMessages(model, { messages: [output] }, allowedToolCallProviders, {
          includeSystemPrompt: false,
        }).filter((item: AnyRecord) => item.type !== "function_call_output"),
      );
      entry.continuation = {
        lastRequestBody: body,
        lastResponseId: output.responseId,
        lastResponseItems: responseItems,
      };
    }
    return { usedPreviousResponseId };
  } catch (error) {
    if (entry) entry.continuation = undefined;
    keepConnection = false;
    return { error: error instanceof Error ? error : new Error(String(error)), usedPreviousResponseId };
  } finally {
    release({ keep: keepConnection });
  }
}

function resetAssistantOutputForRetry(output: AssistantMessage) {
  output.content = [];
  output.stopReason = "stop";
  delete output.errorMessage;
  delete output.responseId;
}

export async function* mapResponseEvents(events: AsyncIterable<AnyRecord>) {
  for await (const event of events) {
    // Normalize nested error format ({type:"error",error:{...}})
    // to flat format ({type:"error",code:"...",message:"..."})
    // as expected by processResponsesStream
    if (event.type === "error" && event.error && typeof event.error === "object") {
      const normalized = { ...event };
      if (event.code === undefined && event.error.code !== undefined) {
        normalized.code = event.error.code;
      }
      if (event.message === undefined && event.error.message !== undefined) {
        normalized.message = event.error.message;
      }
      yield normalized;
      return;
    }
    if (event.type === "response.done" || event.type === "response.incomplete") {
      yield { ...event, type: "response.completed" };
      return;
    }
    if (event.type === "response.completed") {
      yield event;
      return;
    }
    yield event;
  }
}

export function buildCachedWebSocketRequestBody(entry: CachedConnection, body: AnyRecord): AnyRecord {
  const continuation = entry.continuation;
  if (!continuation?.lastResponseId) return body;

  const delta = getCachedWebSocketInputDelta(body, continuation);
  if (!delta) {
    entry.continuation = undefined;
    return body;
  }

  return {
    ...body,
    previous_response_id: continuation.lastResponseId,
    input: delta,
  };
}

function getCachedWebSocketInputDelta(body: AnyRecord, continuation: CachedContinuation) {
  if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) return undefined;
  const currentInput = stripReasoningItemIds(body.input || []);
  const baseline = stripReasoningItemIds([
    ...(continuation.lastRequestBody.input || []),
    ...continuation.lastResponseItems,
  ]);
  if (currentInput.length < baseline.length) return undefined;
  const prefix = currentInput.slice(0, baseline.length);
  if (JSON.stringify(prefix) !== JSON.stringify(baseline)) return undefined;
  return currentInput.slice(baseline.length);
}

function requestBodiesMatchExceptInput(a: AnyRecord, b: AnyRecord): boolean {
  return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function requestBodyWithoutInput(body: AnyRecord): AnyRecord {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

export function shouldRetryCachedContinuationError(
  error: unknown,
  options: { usedPreviousResponseId: boolean },
): boolean {
  if (!options.usedPreviousResponseId) return false;
  const text = errorToSearchText(error);
  if (text.includes("request was aborted")) return false;
  if (text.includes("previous_response_id")) return true;
  if (text.includes("previous response")) return true;
  if (text.includes("response owner")) return true;
  if (text.includes("resp_") && text.includes("not found")) return true;
  if (text.includes("response") && text.includes("not found")) return true;
  if (text.includes("websocket closed before response.completed")) return true;
  return false;
}

function errorToSearchText(error: unknown): string {
  if (error instanceof Error) {
    const details = [error.name, error.message];
    const maybeRecord = error as AnyRecord;
    if (typeof maybeRecord.code === "string") details.push(maybeRecord.code);
    if (typeof maybeRecord.type === "string") details.push(maybeRecord.type);
    return details.join(" ").toLowerCase();
  }
  if (error && typeof error === "object") return JSON.stringify(error).toLowerCase();
  return String(error).toLowerCase();
}

async function acquireWebSocket(
  url: string,
  headers: Headers,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<AcquiredSocket> {
  if (!sessionId) {
    const socket = await connectWebSocket(url, headers, signal);
    return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
  }

  const cached = websocketSessionCache.get(sessionId);
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        reused: true,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            websocketSessionCache.delete(sessionId);
            return;
          }
          cached.busy = false;
          scheduleSessionWebSocketExpiry(sessionId, cached);
        },
      };
    }
    if (!cached.busy && !isWebSocketReusable(cached.socket)) {
      closeWebSocketSilently(cached.socket);
      websocketSessionCache.delete(sessionId);
    }
  }

  const socket = await connectWebSocket(url, headers, signal);
  const entry: CachedConnection = { socket, busy: true };
  websocketSessionCache.set(sessionId, entry);
  return {
    socket,
    entry,
    reused: false,
    release: ({ keep } = {}) => {
      if (!keep || !isWebSocketReusable(entry.socket)) {
        closeWebSocketSilently(entry.socket);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (websocketSessionCache.get(sessionId) === entry) websocketSessionCache.delete(sessionId);
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(sessionId, entry);
    },
  };
}

async function connectWebSocket(url: string, headers: Headers, signal?: AbortSignal): Promise<WebSocket> {
  const WebSocketCtor = globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") throw new Error("WebSocket transport is not available in this runtime");

  const wsHeaders = headersToRecord(headers);
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: WebSocket;
    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders } as any);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: Event) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(extractWebSocketError(event));
    };
    const onClose = (event: CloseEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(extractWebSocketCloseError(event));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      closeWebSocketSilently(socket, 1000, "aborted");
      reject(new Error("Request was aborted"));
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}

async function* parseWebSocket(socket: WebSocket, signal?: AbortSignal): AsyncIterable<AnyRecord> {
  const queue: AnyRecord[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let failed: Error | null = null;
  let sawCompletion = false;
  const wake = () => {
    const resolve = pending;
    if (!resolve) return;
    pending = null;
    resolve();
  };

  const onMessage = (event: MessageEvent) => {
    void (async () => {
      const text = await decodeWebSocketData(event.data);
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
          sawCompletion = true;
          done = true;
        }
        queue.push(parsed);
        wake();
      } catch {
        // Ignore non-JSON frames.
      }
    })();
  };
  const onError = (event: Event) => {
    failed = extractWebSocketError(event);
    done = true;
    wake();
  };
  const onClose = (event: CloseEvent) => {
    if (!sawCompletion && !failed) failed = extractWebSocketCloseError(event);
    done = true;
    wake();
  };
  const onAbort = () => {
    failed = new Error("Request was aborted");
    done = true;
    wake();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Request was aborted");
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }
    if (failed) throw failed;
    if (!sawCompletion) throw new Error("WebSocket stream closed before response.completed");
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function decodeWebSocketData(data: any): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data))
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const arrayBuffer = await data.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedConnection) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
    websocketSessionCache.delete(sessionId);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
  (entry.idleTimer as any).unref?.();
}

function isWebSocketReusable(socket: WebSocket): boolean {
  const readyState = (socket as any).readyState;
  return typeof readyState !== "number" || readyState === 1;
}

function closeWebSocketSilently(socket: WebSocket, code = 1000, reason = "done") {
  try {
    socket.close(code, reason);
  } catch {
    // noop
  }
}

function extractWebSocketError(event: any): Error {
  if (event && typeof event === "object" && typeof event.message === "string" && event.message) {
    return new Error(event.message);
  }
  return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: any): Error {
  const code = typeof event?.code === "number" ? ` ${event.code}` : "";
  const reason = typeof event?.reason === "string" && event.reason ? ` ${event.reason}` : "";
  return new Error(`WebSocket closed${code}${reason}`.trim());
}
