import type { ApiConfig, CrmObjectType } from './types'
import type { Proxy, LLMRequest, LLMResponse, LLMModelInfo, PublicConfig } from './Proxy'

/**
 * LocalFlow proxy client — delegates all requests to a running LocalFlow proxy server.
 */
export class ProxyClient implements Proxy {
  baseUrl: string
  token: string | null

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl
    this.token = token
  }

  isConnected(): boolean { return !!this.token }

  async connect(type = 'odoo', config: Record<string, unknown> = {}): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, config }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? res.statusText)
    this.token = data.token
  }

  async getSessionInfo(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/session`, { headers: this._headers() })
    return this._handle(res)
  }

  isEncrypted(str: string): boolean {
    const parts = str.split(':')
    if (parts.length !== 3) return false
    const [iv, tag] = parts
    const isHex = (h: string) => /^[0-9a-fA-F]+$/.test(h)
    return iv.length === 24 && tag.length === 32 && isHex(iv) && isHex(tag)
  }

  async encryptMessage(message: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/common/encrypt`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ message }),
    })
    const data = await this._handle(res) as { encrypted?: string; message?: string }
    return data.encrypted ?? data.message ?? ''
  }

  async decryptMessage(message: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/common/decrypt`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ message }),
    })
    const data = await this._handle(res) as { decrypted?: string; message?: string }
    return data.decrypted ?? data.message ?? ''
  }

  async callLLM(request: LLMRequest): Promise<LLMResponse> {
    const res = await fetch(`${this.baseUrl}/common/genai`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(`LLM [${res.status}]: ${err.error ?? res.statusText}`)
    }
    return res.json() as Promise<LLMResponse>
  }

  async getAvailableLLMs(): Promise<LLMModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/common/llm-configs`, { headers: this._headers() })
      if (!res.ok) return []
      return res.json()
    } catch { return [] }
  }

  /**
   * Fetch the proxy's public policy (unauthenticated).
   * `safeMode: true` means the proxy never forwards attachments to the LLM —
   * the client must not offer a "send to AI" option for files.
   */
  async getPublicConfig(): Promise<PublicConfig> {
    try {
      const res = await fetch(`${this.baseUrl}/public/config`)
      if (!res.ok) return { safeMode: false }
      const data = await res.json() as Partial<PublicConfig>
      return { safeMode: data.safeMode === true, publicSessions: data.publicSessions }
    } catch { return { safeMode: false } }
  }

  async getApiConfigs(): Promise<ApiConfig[]> {
    try {
      const res = await fetch(`${this.baseUrl}/common/api-config`, { headers: this._headers() })
      if (!res.ok) return []
      return res.json()
    } catch { return [] }
  }

  async proxyApiCall(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<Response> {
    const proxyUrl = new URL(`${this.baseUrl}/common/api-proxy`)
    proxyUrl.searchParams.set('url', url)
    return fetch(proxyUrl.toString(), {
      method,
      headers: { ...headers, 'X-Proxy-Token': `Bearer ${this.token ?? ''}` },
      body: body ?? undefined,
    })
  }

  async extractPdf(buffer: ArrayBuffer, searchString?: string): Promise<{ text: string; pageCount: number }> {
    if (!this.token) throw new Error('Not authenticated')
    const url = new URL(`${this.baseUrl}/common/extract-pdf`)
    if (searchString) url.searchParams.set('searchString', searchString)
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        Authorization: `Bearer ${this.token}`,
      },
      body: buffer,
    })
    const data = await this._handle(res) as {
      text?: string; content?: string
      pageCount?: number; page_count?: number; returnedPages?: number
      metadata?: { totalPdfPages?: number }
    }
    return {
      text: data.text ?? data.content ?? '',
      pageCount: data.pageCount ?? data.page_count ?? data.returnedPages ?? data.metadata?.totalPdfPages ?? 0,
    }
  }

  async listObjectTypes(): Promise<CrmObjectType[]> {
    const res = await fetch(`${this.baseUrl}/metadata`, { headers: this._headers() })
    return this._handle(res) as Promise<CrmObjectType[]>
  }

  async getObjectMetadata(objectType: string): Promise<CrmObjectType> {
    const res = await fetch(`${this.baseUrl}/metadata/${encodeURIComponent(objectType)}`, { headers: this._headers() })
    return this._handle(res) as Promise<CrmObjectType>
  }

  async getData(objectType: string, fields: string[]): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ fields: fields.join(',') })
    const res = await fetch(`${this.baseUrl}/data/${encodeURIComponent(objectType)}?${params}`, {
      headers: this._headers(),
    })
    const result = await this._handle(res) as Record<string, unknown>
    return (result.records ?? result) as Record<string, unknown>[]
  }

  protected _headers(): Record<string, string> {
    if (!this.token) throw new Error('Not authenticated')
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }
  }

  protected async _handle(res: Response): Promise<unknown> {
    if (!res.ok) {
      let message = res.statusText
      try {
        const err = await res.json()
        message = err.error?.message ?? err.error ?? message
      } catch { /* ignore */ }
      throw new Error(`[${res.status}] ${message}`)
    }
    return res.json()
  }
}
