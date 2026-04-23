// Browser-side Ollama / OpenAI-compatible client.
//
// Mirrors promptlibretto/providers/ollama.py so the studio can call the
// user's local LLM directly from the browser (studio server only resolves
// prompts, never touches the model).
//
// A `connection` is { baseUrl, chatPath, payloadShape, timeoutMs }.
//   payloadShape: "ollama" | "openai" | "auto" (auto picks openai if the
//   chatPath contains "/v1/", else ollama).
//
// A `request` matches the server's resolved ProviderRequest:
//   { model, messages: [{role, content}], temperature, max_tokens,
//     top_p?, top_k?, repeat_penalty?, timeout_ms? }

export const DEFAULT_CONNECTION = Object.freeze({
  baseUrl: "http://localhost:11434",
  chatPath: "/api/chat",
  payloadShape: "auto",
  timeoutMs: 120000,
});

function resolveShape(connection) {
  if (connection.payloadShape && connection.payloadShape !== "auto") {
    return connection.payloadShape;
  }
  return connection.chatPath.includes("/v1/") ? "openai" : "ollama";
}

function chatUrl(connection) {
  const base = connection.baseUrl.replace(/\/+$/, "");
  const path = connection.chatPath.startsWith("/")
    ? connection.chatPath
    : "/" + connection.chatPath;
  return base + path;
}

function tagsUrl(connection) {
  const base = connection.baseUrl.replace(/\/+$/, "");
  const shape = resolveShape(connection);
  return base + (shape === "openai" ? "/v1/models" : "/api/tags");
}

export function buildPayload(request, stream, shape) {
  const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
  if (shape === "openai") {
    const payload = {
      model: request.model,
      messages,
      stream,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
    };
    if (stream) payload.stream_options = { include_usage: true };
    if (request.top_p != null) payload.top_p = request.top_p;
    return payload;
  }
  const options = {
    temperature: request.temperature,
    num_predict: request.max_tokens,
  };
  if (request.top_p != null) options.top_p = request.top_p;
  if (request.top_k != null) options.top_k = request.top_k;
  if (request.repeat_penalty != null) options.repeat_penalty = request.repeat_penalty;
  return { model: request.model, messages, stream, options };
}

export function extractText(data) {
  if (!data || typeof data !== "object") return "";
  const msg = data.message;
  if (msg && typeof msg === "object" && msg.content) return msg.content;

  const choices = data.choices;
  if (Array.isArray(choices) && choices.length) {
    const first = choices[0] || {};
    if (first.message && typeof first.message === "object" && first.message.content) {
      return first.message.content;
    }
    if (typeof first.text === "string" && first.text) return first.text;
    if (first.delta && typeof first.delta === "object" && first.delta.content) {
      return first.delta.content;
    }
  }
  if (typeof data.response === "string" && data.response) return data.response;
  if (typeof data.content === "string") return data.content;
  return "";
}

function safeSum(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

export function extractUsage(data) {
  if (!data || typeof data !== "object") return {};
  const u = data.usage;
  if (u && typeof u === "object") {
    return {
      prompt_tokens: u.prompt_tokens ?? null,
      completion_tokens: u.completion_tokens ?? null,
      total_tokens: u.total_tokens ?? safeSum(u.prompt_tokens, u.completion_tokens),
    };
  }
  if (data.prompt_eval_count != null || data.eval_count != null) {
    return {
      prompt_tokens: data.prompt_eval_count ?? null,
      completion_tokens: data.eval_count ?? null,
      total_tokens: safeSum(data.prompt_eval_count, data.eval_count),
    };
  }
  if (data.tokens_evaluated != null || data.tokens_predicted != null) {
    return {
      prompt_tokens: data.tokens_evaluated ?? null,
      completion_tokens: data.tokens_predicted ?? null,
      total_tokens: safeSum(data.tokens_evaluated, data.tokens_predicted),
    };
  }
  const t = data.timings;
  if (t && typeof t === "object" && (t.prompt_n != null || t.predicted_n != null)) {
    return {
      prompt_tokens: t.prompt_n ?? null,
      completion_tokens: t.predicted_n ?? null,
      total_tokens: safeSum(t.prompt_n, t.predicted_n),
    };
  }
  return {};
}

function nsToMs(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 1_000_000 : null;
}

function extractTiming(data, elapsedMs) {
  const t = (data && typeof data.timings === "object" && data.timings) || {};
  return {
    total_ms: nsToMs(data?.total_duration) ?? elapsedMs,
    load_ms: nsToMs(data?.load_duration),
    prompt_eval_ms: nsToMs(data?.prompt_eval_duration) ?? (t.prompt_ms ?? null),
    eval_ms: nsToMs(data?.eval_duration) ?? (t.predicted_ms ?? null),
  };
}

function hasUsage(data) {
  if (!data || typeof data !== "object") return false;
  if (data.usage || data.prompt_eval_count != null || data.eval_count != null) return true;
  if (data.tokens_evaluated != null || data.tokens_predicted != null) return true;
  const t = data.timings;
  return !!(t && typeof t === "object" && (t.prompt_n != null || t.predicted_n != null));
}

async function fetchJson(url, payload, timeoutMs) {
  const abort = new AbortController();
  const timer = timeoutMs ? setTimeout(() => abort.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${resp.status} ${resp.statusText}${text ? ": " + text.slice(0, 300) : ""}`);
    }
    return await resp.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function generate(connection, request) {
  const shape = resolveShape(connection);
  const payload = buildPayload(request, false, shape);
  const url = chatUrl(connection);
  const timeoutMs = request.timeout_ms ?? connection.timeoutMs ?? 120000;
  const started = performance.now();
  const data = await fetchJson(url, payload, timeoutMs);
  const elapsedMs = performance.now() - started;
  return {
    text: extractText(data),
    usage: extractUsage(data),
    timing: extractTiming(data, elapsedMs),
    raw: data,
  };
}

// Line-iterator over a ReadableStream of UTF-8 bytes.
async function* iterLines(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        yield line;
      }
    }
    buf += decoder.decode();
    if (buf) yield buf.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

export async function streamGenerate(connection, request, onDelta) {
  const shape = resolveShape(connection);
  const payload = buildPayload(request, true, shape);
  const url = chatUrl(connection);
  const timeoutMs = request.timeout_ms ?? connection.timeoutMs ?? 120000;
  const abort = new AbortController();
  const timer = timeoutMs ? setTimeout(() => abort.abort(), timeoutMs) : null;

  const buffer = [];
  let finalData = null;
  const started = performance.now();

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${resp.status} ${resp.statusText}${text ? ": " + text.slice(0, 300) : ""}`);
    }

    outer: for await (let line of iterLines(resp.body)) {
      if (!line) continue;
      if (line.startsWith("data:")) {
        line = line.slice(5).trim();
        if (line === "[DONE]") break;
      }
      if (!line) continue;
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      const piece = extractText(data);
      if (piece) {
        buffer.push(piece);
        if (onDelta) onDelta(piece);
      }
      if (hasUsage(data)) finalData = data;
      if (data.done) {
        finalData = data;
        break outer;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  const elapsedMs = performance.now() - started;
  const data = finalData || {};
  return {
    text: buffer.join(""),
    usage: extractUsage(data),
    timing: extractTiming(data, elapsedMs),
    raw: data,
  };
}

export async function listModels(connection) {
  const url = tagsUrl(connection);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: abort.signal });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    // Ollama: {models: [{name, modified_at, size, ...}]}
    if (Array.isArray(data.models)) return data.models.map((m) => m.name).filter(Boolean);
    // OpenAI-compat: {data: [{id, object: "model"}]}
    if (Array.isArray(data.data)) return data.data.map((m) => m.id).filter(Boolean);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function testConnection(connection) {
  try {
    const models = await listModels(connection);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
