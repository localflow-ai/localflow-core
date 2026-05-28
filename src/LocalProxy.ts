import type { ApiConfig, CrmObjectType } from './types'
import type { Proxy, GenaiPayload } from './Proxy'

export interface LocalProxyConfig {
  /** API configurations available to LocalAssistant (same shape as the server-side config). */
  apis?: ApiConfig[]
  /**
   * Gemini API base URL. Defaults to the public Google endpoint.
   * Override for custom deployments or testing.
   */
  geminiBaseUrl?: string
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

  constructor(config: LocalProxyConfig = {}) {
    this._apis = config.apis ?? []
    this._geminiBase = config.geminiBaseUrl ?? DEFAULT_GEMINI_BASE
    console.warn('[LocalProxy] Running in standalone/local mode. Not for production use.')
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
    const { encryptedApiKey: apiKey, model, system_instruction, contents, generation_config } = payload
    const url = `${this._geminiBase}/v1beta/models/${model}:generateContent?key=${apiKey}`
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction, contents, generation_config }),
    })
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
