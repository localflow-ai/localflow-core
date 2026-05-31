import type { ApiConfig, CrmObjectType } from './types'
import type { Proxy, GenaiPayload } from './Proxy'

export interface LocalProxyRateLimit {
  /** Maximum Gemini requests per calendar day, tracked per browser via localStorage. */
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

/** Thrown by `callGenai` when the per-browser daily limit is reached. */
export class LocalProxyRateLimitError extends Error {
  readonly maxPerDay: number
  constructor(maxPerDay: number) {
    super(`[LocalProxy] Daily rate limit of ${maxPerDay} requests reached.`)
    this.name = 'LocalProxyRateLimitError'
    this.maxPerDay = maxPerDay
  }
}

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com'

/**
 * Browser-side standalone proxy — no LocalFlow server required.
 *
 * Usage:
 *   const proxy = new LocalProxy()
 *   const assistant = new LocalAssistant({ proxy, llm: { type: 'gemini' } })
 *   await assistant.setLlmApiKey('AIza...')
 *
 * No connect() call needed — LocalProxy has no server to authenticate against.
 *
 * Key differences from ProxyClient:
 * - encryptMessage / decryptMessage are no-ops (the plain key is used directly)
 * - callGenai calls the Gemini API directly from the browser (key visible in DevTools)
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

  async connect(_type?: string, _config?: Record<string, unknown>): Promise<void> {
    // No-op — LocalProxy has no server to authenticate against.
  }

  async getSessionInfo(): Promise<unknown> {
    return { type: 'local', orgId: 'local' }
  }

  isEncrypted(_str: string): boolean {
    return false
  }

  async encryptMessage(message: string): Promise<string> {
    // No-op: the plain key is used directly. It will be visible in DevTools network tab.
    return message
  }

  async decryptMessage(message: string): Promise<string> {
    return message
  }

  async callGenai(payload: GenaiPayload): Promise<Response> {
    const { encryptedApiKey, model, system_instruction, contents, generation_config } = payload
    const usingDemoKey = !encryptedApiKey?.trim()
    if (usingDemoKey) this._checkRateLimit()
    const apiKey = usingDemoKey ? this._geminiApiKey : encryptedApiKey
    if (!apiKey) throw new Error('[LocalProxy] No Gemini API key configured. Call assistant.setLlmApiKey() or pass geminiApiKey in the LocalProxy constructor.')
    const url = `${this._geminiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction, contents, generation_config }),
    })
    if (usingDemoKey) this._incrementRateLimit()
    return response
  }

  async getApiConfigs(): Promise<ApiConfig[]> {
    return this._apis
  }

  async proxyApiCall(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<Response> {
    return fetch(url, { method, headers, body: body ?? undefined })
  }

  async extractPdf(_buffer: ArrayBuffer, _searchString?: string): Promise<{ text: string; pageCount: number }> {
    throw new Error('[LocalProxy] PDF extraction is not available in standalone mode.')
  }

  async listObjectTypes(): Promise<CrmObjectType[]> { return [] }

  async getObjectMetadata(_objectType: string): Promise<CrmObjectType> {
    throw new Error('[LocalProxy] CRM metadata is not available in standalone mode.')
  }

  async getData(_objectType: string, _fields: string[]): Promise<Record<string, unknown>[]> { return [] }
}
