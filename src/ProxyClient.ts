import type { CrmObjectType } from './types'

/**
 * LocalFlow proxy client — session management, key encryption, and CRM data access.
 */
export class ProxyClient {
  baseUrl: string
  token: string | null

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl
    this.token = token
  }

  isConnected(): boolean { return !!this.token }

  /** Authenticate with the proxy and store the session token. */
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

  /** Check the current session. Throws if not authenticated or session expired. */
  async getSessionInfo(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/session`, { headers: this._headers() })
    return this._handle(res)
  }

  /** Returns true if the string is in the proxy-encrypted IV:Tag:Ciphertext format. */
  isEncrypted(str: string): boolean {
    const parts = str.split(':')
    if (parts.length !== 3) return false
    const [iv, tag] = parts
    const isHex = (h: string) => /^[0-9a-fA-F]+$/.test(h)
    return iv.length === 24 && tag.length === 32 && isHex(iv) && isHex(tag)
  }

  /** Encrypt a plaintext string via the proxy's /common/encrypt endpoint. */
  async encryptMessage(message: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/common/encrypt`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ message }),
    })
    const data = await this._handle(res) as { encrypted?: string; message?: string }
    return data.encrypted ?? data.message ?? ''
  }

  /** Decrypt a proxy-encrypted string via the proxy's /common/decrypt endpoint. */
  async decryptMessage(message: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/common/decrypt`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ message }),
    })
    const data = await this._handle(res) as { decrypted?: string; message?: string }
    return data.decrypted ?? data.message ?? ''
  }

  // ---------------------------------------------------------------------------
  // Document processing
  // ---------------------------------------------------------------------------

  /** Extract text from a PDF via the proxy's /common/extract-pdf endpoint. */
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

  // ---------------------------------------------------------------------------
  // CRM
  // ---------------------------------------------------------------------------

  /** List all CRM object types (without fields — use getObjectMetadata for fields). */
  async listObjectTypes(): Promise<CrmObjectType[]> {
    const res = await fetch(`${this.baseUrl}/metadata`, { headers: this._headers() })
    return this._handle(res) as Promise<CrmObjectType[]>
  }

  /** Fetch full metadata for one object type, including its fields. */
  async getObjectMetadata(objectType: string): Promise<CrmObjectType> {
    const res = await fetch(`${this.baseUrl}/metadata/${encodeURIComponent(objectType)}`, { headers: this._headers() })
    return this._handle(res) as Promise<CrmObjectType>
  }

  /** Fetch rows for a CRM object type. */
  async getData(objectType: string, fields: string[]): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ fields: fields.join(',') })
    const res = await fetch(`${this.baseUrl}/data/${encodeURIComponent(objectType)}?${params}`, {
      headers: this._headers(),
    })
    const result = await this._handle(res) as Record<string, unknown>
    return (result.records ?? result) as Record<string, unknown>[]
  }

  // Protected so subclasses can make authenticated requests without duplicating auth logic

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
