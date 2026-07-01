// Minimal `Proxy` implementations for the benchmark harness.
//
// Only `callLLM` does real work; every other method of core's `Proxy` interface
// is stubbed to throw or return empty, because the bench never authenticates,
// encrypts, proxies API calls, or touches CRM/PDF features. Keeping these here
// (under bench/, never imported by src/) means the harness can drive a
// LocalAssistant without pulling in a real ProxyClient/LocalProxy.

import type { Proxy, LLMRequest, LLMResponse } from '../src/Proxy'

/** Throws — used to stub Proxy methods the bench must never call. */
function unsupported(method: string): never {
  throw new Error(`bench proxy: ${method}() is not supported`)
}

/** Shared no-op/stub surface so MockProxy and OllamaProxy only differ in callLLM. */
function stubProxy(callLLM: (request: LLMRequest) => Promise<LLMResponse>): Proxy {
  return {
    token: null,
    isConnected: () => false,
    connect: async () => {},
    getSessionInfo: async () => ({}),
    isEncrypted: () => false,
    encryptMessage: async (x: string) => x,
    decryptMessage: async (x: string) => x,
    callLLM,
    getAvailableLLMs: async () => [],
    getApiConfigs: async () => [],
    proxyApiCall: async () => unsupported('proxyApiCall'),
    extractPdf: async () => unsupported('extractPdf'),
    listObjectTypes: async () => [],
    getObjectMetadata: async () => unsupported('getObjectMetadata'),
    getData: async () => [],
  }
}

/**
 * Returns canned formulas from a synchronous responder — no network, no Ollama.
 * Lets the harness be tested end-to-end with known-good (and known-bad) output.
 */
export function MockProxy(responder: (req: LLMRequest) => string): Proxy {
  return stubProxy(async (req) => ({ text: responder(req) }))
}

/**
 * Talks to any OpenAI-compatible `/v1/chat/completions` endpoint. Covers BOTH a
 * local Ollama server (no `apiKey`) AND a hosted provider/router (with an
 * `apiKey`) — e.g. a MiMo/OpenRouter-style gateway that exposes Gemini Flash /
 * Gemini Pro / etc. by model id. The system prompt becomes the leading `system`
 * message; LocalAssistant's `options` are honoured: `temperature` (default 0.2)
 * and — for large/JSON mode, which hosted models use — `json` maps to
 * `response_format: json_object`. Uses the global `fetch` (Node >= 20). The
 * `apiKey` is sent as a bearer token and never logged or stored.
 *
 * `baseUrl` follows the OpenAI-SDK convention: the base up to and including the
 * version segment — e.g. `https://api.openai.com/v1`,
 * `https://generativelanguage.googleapis.com/v1beta/openai`, or
 * `http://localhost:11434/v1`. `/chat/completions` is appended (a URL already
 * ending in `/chat/completions` is used as-is).
 */
export function OpenAICompatProxy(opts: {
  baseUrl: string
  model: string
  apiKey?: string
  /** OpenAI-compat `reasoning_effort` (low|medium|high). Omit = provider default. */
  reasoningEffort?: string
}): Proxy {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  return stubProxy(async (request) => {
    const messages = [
      { role: 'system', content: request.system },
      ...request.messages.map((m) => ({
        role: m.role,
        // Mirror the real proxy: a turn's machine-generated `context` is
        // prepended to its content before the model sees it.
        content: m.context ? `${m.context}\n\n${m.content}` : m.content,
      })),
    ]
    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream: false,
      temperature: request.options?.temperature ?? 0.2,
    }
    // Large-mode (hosted) requests ask for JSON output; small/local mode does not.
    if (request.options?.json) body.response_format = { type: 'json_object' }
    // Control thinking depth where supported (Gemini/OpenAI/Anthropic honour it).
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`LLM HTTP ${res.status} ${res.statusText}${errBody ? `: ${errBody.slice(0, 300)}` : ''}`)
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return { text: json.choices?.[0]?.message?.content ?? '' }
  })
}

/**
 * Ollama's NATIVE /api/chat endpoint. Needed because Ollama's OpenAI-compat /v1
 * endpoint gives NO way to control thinking (reasoning_effort / think /
 * chat_template_kwargs are all ignored) — only the native API's `think` flag
 * works, and `think: false` on a thinking model (qwen3 etc.) is far faster.
 * `baseUrl` may carry a trailing `/v1` (stripped here). No API key (local).
 */
export function OllamaNativeProxy(opts: { baseUrl: string; model: string; think?: boolean }): Proxy {
  const root = opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const url = `${root}/api/chat`
  return stubProxy(async (request) => {
    const messages = [
      { role: 'system', content: request.system },
      ...request.messages.map((m) => ({
        role: m.role,
        content: m.context ? `${m.context}\n\n${m.content}` : m.content,
      })),
    ]
    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream: false,
      options: { temperature: request.options?.temperature ?? 0.2 },
    }
    if (opts.think !== undefined) body.think = opts.think
    if (request.options?.json) body.format = 'json' // Ollama's native JSON-mode
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Ollama HTTP ${res.status} ${res.statusText}${errBody ? `: ${errBody.slice(0, 300)}` : ''}`)
    }
    const json = (await res.json()) as { message?: { content?: string } }
    return { text: json.message?.content ?? '' }
  })
}
