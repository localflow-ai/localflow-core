import type { ApiConfig, CrmObjectType } from './types'
import type { Proxy, LLMRequest, LLMResponse, LLMModelInfo, LLMProtocol } from './Proxy'

export interface LocalProxyRateLimit {
  /** Maximum requests per calendar day, tracked per browser via localStorage. */
  maxPerDay: number
  /** localStorage key prefix. Defaults to `'_lf_rl'`. */
  storageKey?: string
}

export interface LocalProxyConfig {
  /** API configurations available to LocalAssistant (same shape as the server-side config). */
  apis?: ApiConfig[]
  /**
   * Gemini API base URL. Defaults to the public Google endpoint.
   * Override for custom deployments or testing.
   */
  geminiBaseUrl?: string
  /**
   * Baked-in Gemini API key used when no key has been set on the assistant.
   * Useful for demos — pass a limited key here so users can try the app
   * without supplying their own.
   */
  geminiApiKey?: string
  /**
   * Per-browser daily request cap. Throws `LocalProxyRateLimitError` when
   * exceeded. Useful for demos to prevent a single user from exhausting a
   * shared key for everyone.
   */
  rateLimit?: LocalProxyRateLimit
}

/** Thrown by `callLLM` when the per-browser daily limit is reached. */
export class LocalProxyRateLimitError extends Error {
  readonly maxPerDay: number
  constructor(maxPerDay: number) {
    super(`[LocalProxy] Daily rate limit of ${maxPerDay} requests reached.`)
    this.name = 'LocalProxyRateLimitError'
    this.maxPerDay = maxPerDay
  }
}

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com'
const DEFAULT_OPENAI_BASE = 'https://api.openai.com'
const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com'

/**
 * Browser-side standalone proxy — no LocalFlow server required.
 *
 * Usage:
 *   const proxy = new LocalProxy()
 *   const assistant = new LocalAssistant({ proxy, llm: { protocol: 'gemini', model: 'gemini-3-flash-preview' } })
 *   await assistant.setLlmApiKey('AIza...')
 *
 * No connect() call needed — LocalProxy has no server to authenticate against.
 *
 * Key differences from ProxyClient:
 * - encryptMessage / decryptMessage are no-ops (the plain key is used directly)
 * - callLLM calls the LLM API directly from the browser (key visible in DevTools)
 * - proxyApiCall is a direct browser fetch (subject to CORS on the target server)
 * - extractPdf is not available
 * - CRM methods return empty results
 *
 * ⚠️  NOT FOR PRODUCTION — switch to ProxyClient + a real LocalFlow proxy before deploying.
 */
export class LocalProxy implements Proxy {
  token: string | null = null
  private _apis: ApiConfig[]
  private _geminiBase: string
  private _geminiApiKey: string | undefined
  private _rateLimit: LocalProxyRateLimit | undefined

  constructor(config: LocalProxyConfig = {}) {
    this._apis = config.apis ?? []
    this._geminiBase = config.geminiBaseUrl ?? DEFAULT_GEMINI_BASE
    this._geminiApiKey = config.geminiApiKey
    this._rateLimit = config.rateLimit
    console.warn('[LocalProxy] Running in standalone/local mode. Not for production use.')
  }

  private _rlKey(suffix: string): string {
    return `${this._rateLimit?.storageKey ?? '_lf_rl'}_${suffix}`
  }

  private _checkRateLimit(): void {
    if (!this._rateLimit) return
    const today = new Date().toDateString()
    if (localStorage.getItem(this._rlKey('date')) !== today) return
    const count = parseInt(localStorage.getItem(this._rlKey('count')) ?? '0', 10)
    if (count >= this._rateLimit.maxPerDay) throw new LocalProxyRateLimitError(this._rateLimit.maxPerDay)
  }

  private _incrementRateLimit(): void {
    if (!this._rateLimit) return
    const today = new Date().toDateString()
    if (localStorage.getItem(this._rlKey('date')) !== today) {
      localStorage.setItem(this._rlKey('date'), today)
      localStorage.setItem(this._rlKey('count'), '1')
    } else {
      const count = parseInt(localStorage.getItem(this._rlKey('count')) ?? '0', 10)
      localStorage.setItem(this._rlKey('count'), String(count + 1))
    }
  }

  isConnected(): boolean { return true }

  async connect(_type?: string, _config?: Record<string, unknown>): Promise<void> {}

  async getSessionInfo(): Promise<unknown> {
    return { type: 'local', orgId: 'local' }
  }

  isEncrypted(_str: string): boolean { return false }

  async encryptMessage(message: string): Promise<string> { return message }

  async decryptMessage(message: string): Promise<string> { return message }

  async callLLM(request: LLMRequest): Promise<LLMResponse> {
    const protocol: LLMProtocol = request.protocol ?? 'gemini'
    switch (protocol) {
      case 'gemini':    return this._callGemini(request)
      case 'openai':    return this._callOpenAI(request)
      case 'anthropic': return this._callAnthropic(request)
      default:          throw new Error(`[LocalProxy] Unknown protocol: ${protocol}`)
    }
  }

  private async _callGemini(request: LLMRequest): Promise<LLMResponse> {
    const usingDemoKey = !request.apiKey?.trim()
    if (usingDemoKey) this._checkRateLimit()
    const apiKey = usingDemoKey ? this._geminiApiKey : request.apiKey
    if (!apiKey) throw new Error('[LocalProxy] No Gemini API key. Call assistant.setLlmApiKey() or pass geminiApiKey in the LocalProxy constructor.')

    const model = request.model ?? 'gemini-3-flash-preview'
    const url = `${this._geminiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`
    const body: Record<string, unknown> = {
      system_instruction: { parts: [{ text: request.system }] },
      contents: request.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generation_config: {
        temperature: request.options?.temperature ?? 0.5,
        ...(request.options?.thinking ? { thinking_config: { thinking_level: 'high', include_thoughts: true } } : {}),
        ...(request.options?.json    ? { response_mime_type: 'application/json' } : {}),
      },
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (usingDemoKey) this._incrementRateLimit()
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`Gemini [${res.status}]: ${err.error?.message ?? res.statusText}`)
    }

    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    return {
      text:    parts.filter(p => !p.thought && p.text).map(p => p.text).join(''),
      thoughts: parts.filter(p =>  p.thought && p.text).map(p => p.text).join('') || undefined,
    }
  }

  private async _callOpenAI(request: LLMRequest): Promise<LLMResponse> {
    const apiKey = request.apiKey?.trim()
    if (!apiKey) throw new Error('[LocalProxy] No API key for OpenAI protocol. Call assistant.setLlmApiKey() first.')

    const base = request.baseUrl ?? DEFAULT_OPENAI_BASE
    const body: Record<string, unknown> = {
      model: request.model ?? 'gpt-4o',
      messages: [
        { role: 'system', content: request.system },
        ...request.messages,
      ],
      temperature: request.options?.temperature ?? 0.5,
    }
    if (request.options?.json)    body.response_format = { type: 'json_object' }
    if (request.options?.thinking) body.thinking = { type: 'enabled' }

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`OpenAI [${res.status}]: ${err.error?.message ?? res.statusText}`)
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
    const msg = data.choices?.[0]?.message
    return {
      text:    msg?.content ?? '',
      thoughts: msg?.reasoning_content || undefined,
    }
  }

  private async _callAnthropic(request: LLMRequest): Promise<LLMResponse> {
    const apiKey = request.apiKey?.trim()
    if (!apiKey) throw new Error('[LocalProxy] No API key for Anthropic protocol. Call assistant.setLlmApiKey() first.')

    const base = request.baseUrl ?? DEFAULT_ANTHROPIC_BASE
    const thinking = request.options?.thinking ?? false
    const body: Record<string, unknown> = {
      model: request.model ?? 'claude-opus-4-5',
      system: request.system,
      messages: request.messages,
      // Anthropic requires max_tokens; must exceed budget_tokens when thinking is on
      max_tokens: thinking ? 16000 : 8192,
      // Anthropic requires temperature=1 when thinking is enabled
      temperature: thinking ? 1 : (request.options?.temperature ?? 0.5),
    }
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: 10000 }

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(`Anthropic [${res.status}]: ${err.error?.message ?? res.statusText}`)
    }

    const data = await res.json() as { content?: Array<{ type: string; text?: string; thinking?: string }> }
    const blocks = data.content ?? []
    return {
      text:    blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join(''),
      thoughts: blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? '').join('') || undefined,
    }
  }

  async getAvailableLLMs(): Promise<LLMModelInfo[]> { return [] }

  async getApiConfigs(): Promise<ApiConfig[]> { return this._apis }

  async proxyApiCall(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<Response> {
    return fetch(url, { method, headers, body: body ?? undefined })
  }

  async extractPdf(_buffer: ArrayBuffer, _searchString?: string): Promise<{ text: string; pageCount: number }> {
    throw new Error('[LocalProxy] PDF extraction is not available in standalone mode. Connect a real proxy via ProxyClient — it extracts PDFs server-side (pdfplumber) for layout-accurate results.')
  }

  async listObjectTypes(): Promise<CrmObjectType[]> { return [] }

  async getObjectMetadata(_objectType: string): Promise<CrmObjectType> {
    throw new Error('[LocalProxy] CRM metadata is not available in standalone mode.')
  }

  async getData(_objectType: string, _fields: string[]): Promise<Record<string, unknown>[]> { return [] }
}
